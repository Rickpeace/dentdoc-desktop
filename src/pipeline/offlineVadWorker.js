/**
 * Offline VAD Worker Thread
 *
 * Runs VAD processing in a separate thread to prevent main process freeze.
 * Uses streaming file reading to keep memory usage constant (~128KB)
 * regardless of recording length.
 *
 * Communication:
 *   Main -> Worker: { type: 'process', wavPath }
 *   Main -> Worker: { type: 'cancel' }
 *   Worker -> Main: { type: 'progress', percent, message }
 *   Worker -> Main: { type: 'result', segments, stats }
 *   Worker -> Main: { type: 'error', message }
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Configuration for OFFLINE VAD (same as offlineVad.js)
const CONFIG = {
  sampleRate: 16000,
  speechStartMs: 64,
  speechStopMs: 800,
  preRollMs: 1200,
  postRollMs: 500,
  frameMs: 64,         // 64ms frames = 1024 samples at 16kHz
  sileroThreshold: 0.25,
  minSpeechDuration: 0.1,
  maxSpeechDuration: 300,
  minSegmentMs: 300,
  mergeGapMs: 400,
  maxSegments: 500      // Hard cap to prevent filter_complex explosion
};

const FRAME_SIZE = Math.floor(CONFIG.sampleRate * CONFIG.frameMs / 1000); // 1024 samples
const READ_CHUNK_BYTES = 65536; // 64KB per read = 32768 Int16 samples
const PROGRESS_THROTTLE_MS = 100; // Max 10 updates/s

let cancelled = false;
let vad = null;

function log(message, ...args) {
  console.log(`[VAD Worker] ${message}`, ...args);
}

// ============================================================================
// Sherpa-ONNX VAD Initialization
// ============================================================================

function initializeVAD() {
  const { addonPath, modelPath } = workerData;

  log('Initializing VAD...');
  log('addonPath:', addonPath);
  log('modelPath:', modelPath);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`VAD model not found: ${modelPath}`);
  }

  let sherpa;

  if (addonPath) {
    // Packaged app: load native addon directly
    if (!fs.existsSync(addonPath)) {
      throw new Error(`Native addon not found: ${addonPath}`);
    }

    const addon = require(addonPath);

    // Create Vad class wrapper (same as offlineVad.js)
    class Vad {
      constructor(config, bufferSizeInSeconds) {
        this.handle = addon.createVoiceActivityDetector(config, bufferSizeInSeconds);
        this.config = config;
      }
      acceptWaveform(samples) {
        addon.voiceActivityDetectorAcceptWaveform(this.handle, samples);
      }
      isEmpty() {
        return addon.voiceActivityDetectorIsEmpty(this.handle);
      }
      isDetected() {
        return addon.voiceActivityDetectorIsDetected(this.handle);
      }
      pop() {
        addon.voiceActivityDetectorPop(this.handle);
      }
      clear() {
        addon.voiceActivityDetectorClear(this.handle);
      }
      front(enableExternalBuffer = true) {
        return addon.voiceActivityDetectorFront(this.handle, enableExternalBuffer);
      }
      reset() {
        addon.voiceActivityDetectorReset(this.handle);
      }
      flush() {
        addon.voiceActivityDetectorFlush(this.handle);
      }
    }

    sherpa = { Vad };
    log('Sherpa-ONNX loaded from addon path');
  } else {
    // Development: load from node_modules
    sherpa = require('sherpa-onnx-node');
    log('Sherpa-ONNX loaded from node_modules');
  }

  const vadConfig = {
    sileroVad: {
      model: modelPath,
      threshold: CONFIG.sileroThreshold,
      minSpeechDuration: CONFIG.minSpeechDuration,
      maxSpeechDuration: CONFIG.maxSpeechDuration,
      minSilenceDuration: 0.3
    },
    sampleRate: CONFIG.sampleRate,
    bufferSizeInSeconds: 60,
    debug: false
  };

  vad = new sherpa.Vad(vadConfig, 60);
  log('VAD instance created');

  // Wrap acceptWaveform to prevent "External buffers are not allowed" error
  // (same pattern as vad-worker-thread.js)
  const originalAcceptWaveform = vad.acceptWaveform.bind(vad);
  vad.acceptWaveform = (input) => {
    const arrayBuffer = new ArrayBuffer(input.length * 4);
    const safeSamples = new Float32Array(arrayBuffer);
    for (let idx = 0; idx < input.length; idx++) {
      safeSamples[idx] = input[idx];
    }
    return originalAcceptWaveform(safeSamples);
  };
  log('acceptWaveform wrapped with safe ArrayBuffer copy');
}

// ============================================================================
// WAV Header Parsing
// ============================================================================

function parseWavHeader(fd) {
  const header = Buffer.alloc(128); // Read enough for extended headers
  fs.readSync(fd, header, 0, 128, 0);

  const riff = header.toString('ascii', 0, 4);
  const wave = header.toString('ascii', 8, 12);

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file format');
  }

  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);

  // Find 'data' chunk (may not be at offset 44 if there are extra chunks)
  let dataOffset = -1;
  let dataBytes = 0;

  for (let i = 12; i < 120; i++) {
    if (header.toString('ascii', i, i + 4) === 'data') {
      dataBytes = header.readUInt32LE(i + 4);
      dataOffset = i + 8;
      break;
    }
  }

  if (dataOffset === -1) {
    // Didn't find in first 128 bytes, read more
    const extHeader = Buffer.alloc(4096);
    fs.readSync(fd, extHeader, 0, 4096, 0);
    for (let i = 12; i < 4088; i++) {
      if (extHeader.toString('ascii', i, i + 4) === 'data') {
        dataBytes = extHeader.readUInt32LE(i + 4);
        dataOffset = i + 8;
        break;
      }
    }
  }

  if (dataOffset === -1) {
    throw new Error('Could not find data chunk in WAV file');
  }

  // If dataBytes is 0 or suspiciously wrong, calculate from file size
  const fileSize = fs.fstatSync(fd).size;
  if (dataBytes === 0 || dataBytes > fileSize) {
    dataBytes = fileSize - dataOffset;
  }

  log(`WAV header: sampleRate=${sampleRate}, channels=${channels}, bitsPerSample=${bitsPerSample}, dataBytes=${dataBytes}, fileSize=${(fileSize / 1024 / 1024).toFixed(2)}MB`);

  return { sampleRate, channels, bitsPerSample, dataOffset, dataBytes };
}

// ============================================================================
// Streaming VAD Processing
// ============================================================================

function processWavStreaming(wavPath) {
  const fd = fs.openSync(wavPath, 'r');

  try {
    const wavInfo = parseWavHeader(fd);
    const { sampleRate, channels, bitsPerSample, dataOffset, dataBytes } = wavInfo;

    if (bitsPerSample !== 16) {
      throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}-bit`);
    }
    if (channels !== 1) {
      throw new Error(`Expected mono audio, got ${channels} channels`);
    }

    const totalSamples = Math.floor(dataBytes / 2); // 16-bit = 2 bytes per sample
    const durationMs = (totalSamples / sampleRate) * 1000;

    log(`Processing: ${(durationMs / 1000).toFixed(1)}s audio, ${totalSamples} samples`);

    // ---- Reusable buffers (no GC spam) ----
    const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
    const frameBuffer = new Float32Array(FRAME_SIZE); // 1024 samples
    let carryCount = 0; // How many samples carried from previous chunk
    // carryBuffer stored at start of frameBuffer

    // ---- State machine for speech detection ----
    const markers = [];
    let isSpeech = false;
    let speechFrameCount = 0;
    let silenceFrameCount = 0;
    let currentSpeechStart = null;
    let totalFramesProcessed = 0;

    // ---- Progress tracking ----
    let processedBytes = 0;
    let lastProgressTime = 0;

    // ---- Read and process in chunks ----
    let filePosition = dataOffset;
    const fileEnd = dataOffset + dataBytes;

    while (filePosition < fileEnd && !cancelled) {
      // Read a chunk
      const bytesToRead = Math.min(READ_CHUNK_BYTES, fileEnd - filePosition);
      const bytesRead = fs.readSync(fd, readBuffer, 0, bytesToRead, filePosition);
      if (bytesRead === 0) break;
      filePosition += bytesRead;
      processedBytes += bytesRead;

      // Convert chunk: Int16 -> Float32
      const samplesInChunk = Math.floor(bytesRead / 2);
      // We need to combine carry samples + new samples into frames

      let chunkOffset = 0; // Current position in this chunk's samples

      while (chunkOffset < samplesInChunk && !cancelled) {
        // Fill frameBuffer starting from carryCount
        const samplesNeeded = FRAME_SIZE - carryCount;
        const samplesAvailable = samplesInChunk - chunkOffset;
        const samplesToCopy = Math.min(samplesNeeded, samplesAvailable);

        // Convert Int16 to Float32 directly into frameBuffer
        for (let i = 0; i < samplesToCopy; i++) {
          const byteIdx = (chunkOffset + i) * 2;
          const int16 = readBuffer.readInt16LE(byteIdx);
          frameBuffer[carryCount + i] = int16 / 32768.0;
        }

        carryCount += samplesToCopy;
        chunkOffset += samplesToCopy;

        // Frame complete?
        if (carryCount >= FRAME_SIZE) {
          // Feed frame to VAD
          vad.acceptWaveform(frameBuffer);
          const detected = vad.isDetected();

          // Update state machine (same logic as offlineVad.js)
          if (detected) {
            speechFrameCount++;
            silenceFrameCount = 0;
          } else {
            silenceFrameCount++;
            if (!isSpeech) speechFrameCount = 0;
          }

          const currentTimeMs = (totalFramesProcessed * FRAME_SIZE / CONFIG.sampleRate) * 1000;
          const speechMs = speechFrameCount * CONFIG.frameMs;
          const silenceMs = silenceFrameCount * CONFIG.frameMs;

          // Speech start
          if (!isSpeech && speechMs >= CONFIG.speechStartMs) {
            isSpeech = true;
            silenceFrameCount = 0;
            currentSpeechStart = Math.max(0, currentTimeMs - CONFIG.preRollMs);
          }

          // Speech end
          if (isSpeech && silenceMs >= CONFIG.speechStopMs) {
            isSpeech = false;
            speechFrameCount = 0;
            const speechEnd = currentTimeMs + CONFIG.postRollMs;

            if (currentSpeechStart !== null) {
              markers.push({
                startMs: currentSpeechStart,
                endMs: speechEnd
              });
            }
            currentSpeechStart = null;
          }

          totalFramesProcessed++;
          carryCount = 0;
        }
      }

      // Progress update (throttled to max 10/s)
      const now = Date.now();
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        const percent = Math.floor((processedBytes / dataBytes) * 80) + 10; // 10-90%
        parentPort.postMessage({
          type: 'progress',
          percent: Math.min(percent, 90),
          message: `Sprache wird erkannt... ${Math.floor(processedBytes / dataBytes * 100)}%`
        });
        lastProgressTime = now;
      }
    }

    // ---- Flush carry buffer (pad with zeros, feed exactly once) ----
    if (carryCount > 0 && !cancelled) {
      // Zero-fill remaining samples
      for (let i = carryCount; i < FRAME_SIZE; i++) {
        frameBuffer[i] = 0;
      }
      vad.acceptWaveform(frameBuffer);
      const detected = vad.isDetected();

      // Handle last frame detection
      if (detected) {
        speechFrameCount++;
        silenceFrameCount = 0;
      } else {
        silenceFrameCount++;
      }

      totalFramesProcessed++;
    }

    // Close any open speech segment
    if (isSpeech && currentSpeechStart !== null && !cancelled) {
      markers.push({
        startMs: currentSpeechStart,
        endMs: durationMs
      });
    }

    if (cancelled) {
      log('Processing cancelled');
      return { markers: [], durationMs, wavInfo };
    }

    log(`Detection complete: ${markers.length} raw markers, ${totalFramesProcessed} frames`);
    return { markers, durationMs, wavInfo };

  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================================
// Marker Processing (same as offlineVad.js)
// ============================================================================

function processMarkers(markers, durationMs) {
  // Filter short segments
  let filtered = markers.filter(m => (m.endMs - m.startMs) >= CONFIG.minSegmentMs);

  if (filtered.length <= 1) return filtered;

  // Merge close segments
  const sorted = [...filtered].sort((a, b) => a.startMs - b.startMs);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.startMs <= last.endMs + CONFIG.mergeGapMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push(current);
    }
  }

  // Clamp to duration
  let result = merged.map(m => ({
    startMs: Math.max(0, m.startMs),
    endMs: Math.min(durationMs, m.endMs)
  }));

  // Hard cap: if too many segments, keep the longest ones
  if (result.length > CONFIG.maxSegments) {
    log(`WARNING: segments capped: original=${result.length} → used=${CONFIG.maxSegments}`);
    result = result
      .map(m => ({ ...m, duration: m.endMs - m.startMs }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, CONFIG.maxSegments)
      .sort((a, b) => a.startMs - b.startMs);
  }

  return result;
}

// ============================================================================
// Message Handler
// ============================================================================

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'process': {
      const wavPath = msg.wavPath;
      log('Starting processing:', wavPath);

      try {
        // Initialize VAD
        parentPort.postMessage({ type: 'progress', percent: 5, message: 'VAD wird initialisiert...' });
        initializeVAD();

        // Process file with streaming
        parentPort.postMessage({ type: 'progress', percent: 10, message: 'Audio wird analysiert...' });
        const { markers, durationMs, wavInfo } = processWavStreaming(wavPath);

        if (cancelled) {
          parentPort.postMessage({ type: 'error', message: 'Verarbeitung abgebrochen' });
          return;
        }

        // Process markers
        parentPort.postMessage({ type: 'progress', percent: 92, message: 'Segmente werden verarbeitet...' });
        const processedMarkers = processMarkers(markers, durationMs);

        // Calculate stats
        const totalSpeechMs = processedMarkers.reduce((sum, m) => sum + (m.endMs - m.startMs), 0);
        const silencePercent = ((1 - totalSpeechMs / durationMs) * 100).toFixed(1);

        // Convert to segment format
        const segments = processedMarkers.map((marker, index) => ({
          index,
          path: wavPath,
          startMs: marker.startMs,
          endMs: marker.endMs,
          duration: marker.endMs - marker.startMs,
          startTime: marker.startMs,
          endTime: marker.endMs
        }));

        const stats = {
          durationMs,
          speechDurationMs: totalSpeechMs,
          silencePercent,
          segmentCount: segments.length,
          wavInfo
        };

        parentPort.postMessage({ type: 'progress', percent: 95, message: `${segments.length} Sprachsegmente gefunden` });
        parentPort.postMessage({ type: 'result', segments, stats });

        // Cleanup VAD
        try { vad.clear(); } catch (e) {}
        vad = null;

      } catch (error) {
        log('Processing error:', error.message);
        parentPort.postMessage({ type: 'error', message: error.message });
      }
      break;
    }

    case 'cancel':
      log('Cancel requested');
      cancelled = true;
      break;
  }
});
