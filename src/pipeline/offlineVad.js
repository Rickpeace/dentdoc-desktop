/**
 * Offline VAD for uploaded files
 *
 * Uses a Worker Thread for VAD processing to prevent main process freeze.
 * Falls back to synchronous main-thread processing if Worker fails.
 *
 * Uses Sherpa-ONNX Silero VAD (same as live VAD).
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { app } = require('electron');

// Configuration for OFFLINE VAD
const CONFIG = {
  sampleRate: 16000,
  speechStartMs: 64,
  speechStopMs: 800,
  preRollMs: 1200,
  postRollMs: 500,
  frameMs: 64,
  sileroThreshold: 0.25,
  minSpeechDuration: 0.1,
  maxSpeechDuration: 300,
  minSegmentMs: 300,
  mergeGapMs: 400
};

let sherpa = null;

// Track active worker for cancel support
let activeWorker = null;

/**
 * Resolve the Sherpa-ONNX native addon path
 * @returns {string|null} Addon path for packaged app, null for development
 */
function resolveAddonPath() {
  if (!app.isPackaged) return null;

  const addonPath = path.join(
    process.resourcesPath, 'app.asar.unpacked', 'node_modules',
    'sherpa-onnx-win-x64', 'sherpa-onnx.node'
  );

  if (fs.existsSync(addonPath)) {
    return addonPath;
  }

  console.warn('[VAD] Addon not found at:', addonPath);
  return null;
}

/**
 * Resolve the VAD model path
 * @returns {string} Path to silero_vad.onnx
 */
function resolveModelPath() {
  const possiblePaths = [];

  if (app.isPackaged) {
    possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'models'));
  }

  possiblePaths.push(
    path.join(__dirname, '..', '..', 'models'),
    path.join(process.cwd(), 'models'),
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'models')
  );

  for (const p of possiblePaths) {
    const modelPath = path.join(p, 'silero_vad.onnx');
    if (fs.existsSync(modelPath)) {
      return modelPath;
    }
  }

  // Return default path even if it doesn't exist (will error in worker)
  return path.join(__dirname, '..', '..', 'models', 'silero_vad.onnx');
}

/**
 * Run offline VAD using Worker Thread (non-blocking)
 */
async function runOfflineVAD_Worker(wavPath, onProgress) {
  const addonPath = resolveAddonPath();
  const modelPath = resolveModelPath();

  console.log('[VAD] Using Worker Thread for processing');
  console.log('[VAD] addonPath:', addonPath || '(development mode)');
  console.log('[VAD] modelPath:', modelPath);

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'offlineVadWorker.js');
    const worker = new Worker(workerPath, {
      workerData: { addonPath, modelPath }
    });

    activeWorker = worker;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      activeWorker = null;
    };

    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'progress':
          onProgress({ stage: 'vad', percent: msg.percent, message: msg.message });
          break;

        case 'result': {
          settle();
          const { segments, stats } = msg;

          // Log VAD results (same format as before)
          const fileSizeBytes = fs.statSync(wavPath).size;
          const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
          const originalDuration = (stats.durationMs / 1000).toFixed(1);
          const speechDuration = (stats.speechDurationMs / 1000).toFixed(1);
          const estimatedSpeechSizeMB = (fileSizeBytes * (stats.speechDurationMs / stats.durationMs) / (1024 * 1024)).toFixed(2);

          console.log('');
          console.log('///// VAD ANALYSE /////');
          console.log(`  Original:  ${originalDuration}s (${fileSizeMB} MB)`);
          console.log(`  Sprache:   ${speechDuration}s (~${estimatedSpeechSizeMB} MB)`);
          console.log(`  Entfernt:  ${stats.silencePercent}% Stille`);
          console.log(`  Segmente:  ${stats.segmentCount}`);
          console.log(`  Padding:   ${CONFIG.preRollMs}ms vor | ${CONFIG.postRollMs}ms nach`);
          console.log(`  Modus:     Worker Thread (streaming)`);
          console.log('///////////////////////');
          console.log('');

          onProgress({ stage: 'vad', percent: 20, message: `${stats.segmentCount} Sprachsegmente gefunden` });

          // Terminate worker after result
          worker.terminate();
          resolve(segments);
          break;
        }

        case 'error':
          settle();
          worker.terminate();
          reject(new Error(msg.message));
          break;
      }
    });

    worker.on('error', (err) => {
      settle();
      reject(err);
    });

    worker.on('exit', (code) => {
      if (!settled) {
        settle();
        reject(new Error(`Worker exited unexpectedly with code ${code}`));
      }
    });

    // Start processing
    worker.postMessage({ type: 'process', wavPath });
  });
}

/**
 * Cancel active VAD processing
 */
function cancelVAD() {
  if (activeWorker) {
    console.log('[VAD] Cancelling active worker...');
    activeWorker.postMessage({ type: 'cancel' });
    // Hard kill after 3s if worker doesn't respond
    const workerRef = activeWorker;
    setTimeout(() => {
      try { workerRef.terminate(); } catch (e) {}
    }, 3000);
    activeWorker = null;
  }
}

// ============================================================================
// FALLBACK: Main-thread processing (used if Worker fails)
// ============================================================================

function getModelDir() {
  const possiblePaths = [];

  if (app.isPackaged) {
    possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'models'));
  }

  possiblePaths.push(
    path.join(__dirname, '..', '..', 'models'),
    path.join(process.cwd(), 'models'),
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'models')
  );

  console.log('[VAD] Searching for models in:', possiblePaths);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log('[VAD] Found models at:', p);
      return p;
    }
  }

  const defaultPath = path.join(__dirname, '..', '..', 'models');
  console.log('[VAD] No models found, using default:', defaultPath);
  fs.mkdirSync(defaultPath, { recursive: true });
  return defaultPath;
}

function readWavSamples(wavPath) {
  const buffer = fs.readFileSync(wavPath);

  let dataOffset = 44;

  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file format');
  }

  for (let i = 12; i < buffer.length - 8; i++) {
    if (buffer.toString('ascii', i, i + 4) === 'data') {
      dataOffset = i + 8;
      break;
    }
  }

  const numSamples = Math.floor((buffer.length - dataOffset) / 2);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const int16 = buffer.readInt16LE(dataOffset + i * 2);
    samples[i] = int16 / 32768.0;
  }

  return samples;
}

function initializeVAD() {
  if (sherpa) return sherpa;

  try {
    if (app.isPackaged) {
      const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
      const addonPath = path.join(unpackedPath, 'sherpa-onnx-win-x64', 'sherpa-onnx.node');

      if (!fs.existsSync(addonPath)) {
        throw new Error(`Native addon not found at: ${addonPath}`);
      }

      const addon = require(addonPath);

      class Vad {
        constructor(config, bufferSizeInSeconds) {
          this.handle = addon.createVoiceActivityDetector(config, bufferSizeInSeconds);
          this.config = config;
        }
        acceptWaveform(samples) { addon.voiceActivityDetectorAcceptWaveform(this.handle, samples); }
        isEmpty() { return addon.voiceActivityDetectorIsEmpty(this.handle); }
        isDetected() { return addon.voiceActivityDetectorIsDetected(this.handle); }
        pop() { addon.voiceActivityDetectorPop(this.handle); }
        clear() { addon.voiceActivityDetectorClear(this.handle); }
        front(enableExternalBuffer = true) { return addon.voiceActivityDetectorFront(this.handle, enableExternalBuffer); }
        reset() { addon.voiceActivityDetectorReset(this.handle); }
        flush() { addon.voiceActivityDetectorFlush(this.handle); }
      }

      sherpa = { Vad };
    } else {
      sherpa = require('sherpa-onnx-node');
    }

    return sherpa;
  } catch (err) {
    throw new Error(`VAD initialization failed: ${err.message}`);
  }
}

function createVAD() {
  console.log('[VAD] Creating VAD instance...');
  const sherpaLib = initializeVAD();
  const modelDir = getModelDir();
  const modelPath = path.join(modelDir, 'silero_vad.onnx');

  console.log('[VAD] Model dir:', modelDir);
  console.log('[VAD] Model path:', modelPath);
  console.log('[VAD] Model exists:', fs.existsSync(modelPath));

  if (!fs.existsSync(modelPath)) {
    throw new Error('Silero VAD model not found.');
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

  const vad = new sherpaLib.Vad(vadConfig, 60);
  console.log('[VAD] VAD instance created successfully');
  return vad;
}

function detectSpeechSegments(samples, vad) {
  const frameSize = Math.floor(CONFIG.sampleRate * CONFIG.frameMs / 1000);
  const markers = [];

  let isSpeech = false;
  let speechFrameCount = 0;
  let silenceFrameCount = 0;
  let currentSpeechStart = null;

  const totalFrames = Math.ceil(samples.length / frameSize);
  const safeSamples = new Float32Array(frameSize);

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const start = frameIdx * frameSize;
    const end = Math.min(start + frameSize, samples.length);
    const frameSamples = samples.subarray(start, end);

    if (frameSamples.length < frameSize) {
      safeSamples.fill(0);
    }

    safeSamples.set(frameSamples);

    vad.acceptWaveform(safeSamples);
    const detected = vad.isDetected();

    if (detected) {
      speechFrameCount++;
      silenceFrameCount = 0;
    } else {
      silenceFrameCount++;
      if (!isSpeech) speechFrameCount = 0;
    }

    const currentTimeMs = (frameIdx * frameSize / CONFIG.sampleRate) * 1000;
    const speechMs = speechFrameCount * CONFIG.frameMs;
    const silenceMs = silenceFrameCount * CONFIG.frameMs;

    if (!isSpeech && speechMs >= CONFIG.speechStartMs) {
      isSpeech = true;
      silenceFrameCount = 0;
      currentSpeechStart = Math.max(0, currentTimeMs - CONFIG.preRollMs);
    }

    if (isSpeech && silenceMs >= CONFIG.speechStopMs) {
      isSpeech = false;
      speechFrameCount = 0;

      const speechEnd = currentTimeMs + CONFIG.postRollMs;

      if (currentSpeechStart !== null) {
        markers.push({ startMs: currentSpeechStart, endMs: speechEnd });
      }

      currentSpeechStart = null;
    }
  }

  if (isSpeech && currentSpeechStart !== null) {
    const endMs = (samples.length / CONFIG.sampleRate) * 1000;
    markers.push({ startMs: currentSpeechStart, endMs: endMs });
  }

  return markers;
}

function processMarkers(markers, durationMs) {
  let filtered = markers.filter(m => (m.endMs - m.startMs) >= CONFIG.minSegmentMs);

  if (filtered.length <= 1) return filtered;

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

  return merged.map(m => ({
    startMs: Math.max(0, m.startMs),
    endMs: Math.min(durationMs, m.endMs)
  }));
}

async function runOfflineVAD_Fallback(wavPath, onProgress) {
  console.warn('[VAD] Using FALLBACK (main thread) - UI may freeze for large files');

  onProgress({ stage: 'vad', percent: 5, message: 'Loading audio...' });
  const samples = readWavSamples(wavPath);
  const durationMs = (samples.length / CONFIG.sampleRate) * 1000;

  onProgress({ stage: 'vad', percent: 10, message: 'Initializing VAD...' });
  const vad = createVAD();

  onProgress({ stage: 'vad', percent: 15, message: 'Detecting speech...' });
  const rawMarkers = detectSpeechSegments(samples, vad);
  const processedMarkers = processMarkers(rawMarkers, durationMs);

  const totalSpeechMs = processedMarkers.reduce((sum, m) => sum + (m.endMs - m.startMs), 0);
  const silencePercent = ((1 - totalSpeechMs / durationMs) * 100).toFixed(1);

  const fileSizeBytes = fs.statSync(wavPath).size;
  const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
  const speechRatio = totalSpeechMs / durationMs;
  const estimatedSpeechSizeMB = (fileSizeBytes * speechRatio / (1024 * 1024)).toFixed(2);

  const originalDuration = (durationMs / 1000).toFixed(1);
  const speechDuration = (totalSpeechMs / 1000).toFixed(1);
  console.log('');
  console.log('///// VAD ANALYSE /////');
  console.log(`  Original:  ${originalDuration}s (${fileSizeMB} MB)`);
  console.log(`  Sprache:   ${speechDuration}s (~${estimatedSpeechSizeMB} MB)`);
  console.log(`  Entfernt:  ${silencePercent}% Stille`);
  console.log(`  Segmente:  ${processedMarkers.length}`);
  console.log(`  Padding:   ${CONFIG.preRollMs}ms vor | ${CONFIG.postRollMs}ms nach`);
  console.log(`  Modus:     Main Thread (FALLBACK)`);
  console.log('///////////////////////');
  console.log('');

  onProgress({ stage: 'vad', percent: 20, message: `${processedMarkers.length} speech segments found` });

  const segments = processedMarkers.map((marker, index) => ({
    index: index,
    path: wavPath,
    startMs: marker.startMs,
    endMs: marker.endMs,
    duration: marker.endMs - marker.startMs,
    startTime: marker.startMs,
    endTime: marker.endMs
  }));

  try { vad.clear(); } catch (e) {}

  return segments;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Run offline VAD on a WAV file
 *
 * Tries Worker Thread first (non-blocking), falls back to main thread.
 *
 * @param {string} wavPath - Path to 16kHz mono WAV file
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} Array of segments with startMs, endMs
 */
async function runOfflineVAD(wavPath, onProgress = () => {}) {
  try {
    return await runOfflineVAD_Worker(wavPath, onProgress);
  } catch (workerError) {
    console.warn('[VAD] Worker Thread failed:', workerError.message);
    console.warn('[VAD] Falling back to main thread processing');
    return await runOfflineVAD_Fallback(wavPath, onProgress);
  }
}

module.exports = {
  runOfflineVAD,
  cancelVAD,
  CONFIG
};
