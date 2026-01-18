/**
 * Offline VAD for uploaded files
 *
 * Processes a complete audio file and extracts speech segments.
 * Uses Sherpa-ONNX Silero VAD (same as live VAD).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

// Configuration for OFFLINE VAD (stricter than live VAD to remove more silence)
const CONFIG = {
  sampleRate: 16000,
  // Speech detection timing
  speechStartMs: 80,       // 80ms speech to start (schneller als live)
  speechStopMs: 600,       // 600ms silence to end segment (strenger - war 1500)
  // Padding around speech - WICHTIG für erste Worte nach Pause!
  preRollMs: 600,          // 600ms before speech (erhöht von 200 - erste Worte wurden abgehackt)
  postRollMs: 400,         // 400ms after speech (erhöht von 200)
  frameMs: 20,
  // Silero VAD parameters - höherer Threshold für strengere Erkennung
  sileroThreshold: 0.5,    // War 0.4 - jetzt strenger
  minSpeechDuration: 0.15, // War 0.1
  maxSpeechDuration: 300,
  // Minimum speech segment duration (ms)
  minSegmentMs: 400,       // War 300 - kurze Segmente verwerfen
  // Merge gap (ms) - segments closer than this will be merged
  mergeGapMs: 300          // War 500 - weniger aggressive Zusammenführung
};

let sherpa = null;

// Minimal logging - only important results
const LOG_PREFIX = '[VAD]';

/**
 * Get FFmpeg path
 */
function getFFmpegPath() {
  const bundledPath = path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
  const bundledPathPacked = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    : bundledPath;

  if (fs.existsSync(bundledPathPacked)) {
    return bundledPathPacked;
  }
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  return require('ffmpeg-static');
}

/**
 * Get model directory path
 */
function getModelDir() {
  const possiblePaths = [
    path.join(__dirname, '..', '..', 'models'),
    path.join(process.cwd(), 'models'),
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'models')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  const defaultPath = path.join(__dirname, '..', '..', 'models');
  fs.mkdirSync(defaultPath, { recursive: true });
  return defaultPath;
}

/**
 * Read WAV file and return raw PCM samples
 * Assumes 16kHz mono 16-bit PCM
 */
function readWavSamples(wavPath) {
  const buffer = fs.readFileSync(wavPath);

  // Find data chunk
  let dataOffset = 44; // Standard WAV header

  // Verify WAV header
  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);

  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV file format');
  }

  // Find 'data' chunk (may not be at offset 44 if there are extra chunks)
  for (let i = 12; i < buffer.length - 8; i++) {
    if (buffer.toString('ascii', i, i + 4) === 'data') {
      dataOffset = i + 8; // Skip 'data' + size (4 bytes each)
      break;
    }
  }

  // Read 16-bit samples and convert to float32
  const numSamples = Math.floor((buffer.length - dataOffset) / 2);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const int16 = buffer.readInt16LE(dataOffset + i * 2);
    samples[i] = int16 / 32768.0;
  }

  return samples;
}

/**
 * Initialize Sherpa-ONNX VAD
 */
function initializeVAD() {
  if (sherpa) {
    return sherpa;
  }

  sherpa = require('sherpa-onnx-node');
  return sherpa;
}

/**
 * Create VAD instance
 */
function createVAD() {
  const sherpaLib = initializeVAD();

  const modelDir = getModelDir();
  const modelPath = path.join(modelDir, 'silero_vad.onnx');

  if (!fs.existsSync(modelPath)) {
    throw new Error('Silero VAD model not found. Please run the app once to download it.');
  }

  const vadConfig = {
    sileroVad: {
      model: modelPath,
      threshold: CONFIG.sileroThreshold,
      minSpeechDuration: CONFIG.minSpeechDuration,
      maxSpeechDuration: CONFIG.maxSpeechDuration,
      minSilenceDuration: 0.3  // Strenger: 300ms Stille = Ende (war 0.5)
    },
    sampleRate: CONFIG.sampleRate,
    bufferSizeInSeconds: 60,
    debug: false
  };

  const vad = new sherpaLib.Vad(vadConfig, CONFIG.sampleRate);
  return vad;
}

/**
 * Process audio samples and detect speech segments
 */
function detectSpeechSegments(samples, vad) {
  const frameSize = Math.floor(CONFIG.sampleRate * CONFIG.frameMs / 1000); // 320 samples for 20ms
  const markers = [];

  let isSpeech = false;
  let speechFrameCount = 0;
  let silenceFrameCount = 0;
  let currentSpeechStart = null;

  const totalFrames = Math.floor(samples.length / frameSize);

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const start = frameIdx * frameSize;
    const end = start + frameSize;
    const frameSamples = samples.slice(start, end);

    // Create safe copy for Sherpa
    const arrayBuffer = new ArrayBuffer(frameSamples.length * 4);
    const safeSamples = new Float32Array(arrayBuffer);
    for (let i = 0; i < frameSamples.length; i++) {
      safeSamples[i] = frameSamples[i];
    }

    vad.acceptWaveform(safeSamples);
    const detected = vad.isDetected();

    // Update counters
    if (detected) {
      speechFrameCount++;
      silenceFrameCount = 0;
    } else {
      silenceFrameCount++;
    }

    const currentTimeMs = (frameIdx * frameSize / CONFIG.sampleRate) * 1000;
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
  }

  // Close any open speech segment
  if (isSpeech && currentSpeechStart !== null) {
    const endMs = (samples.length / CONFIG.sampleRate) * 1000;
    markers.push({
      startMs: currentSpeechStart,
      endMs: endMs
    });
  }

  return markers;
}

/**
 * Filter and merge markers
 */
function processMarkers(markers, durationMs) {
  // Filter short segments
  let filtered = markers.filter(m => (m.endMs - m.startMs) >= CONFIG.minSegmentMs);

  // Merge close segments
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

  // Clamp to duration
  return merged.map(m => ({
    startMs: Math.max(0, m.startMs),
    endMs: Math.min(durationMs, m.endMs)
  }));
}

/**
 * Run offline VAD on a WAV file
 *
 * @param {string} wavPath - Path to 16kHz mono WAV file
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} Array of segments with startMs, endMs
 */
async function runOfflineVAD(wavPath, onProgress = () => {}) {
  onProgress({ stage: 'vad', percent: 5, message: 'Loading audio...' });

  // Read samples
  const samples = readWavSamples(wavPath);
  const durationMs = (samples.length / CONFIG.sampleRate) * 1000;

  onProgress({ stage: 'vad', percent: 10, message: 'Initializing VAD...' });

  // Create VAD
  const vad = createVAD();

  onProgress({ stage: 'vad', percent: 15, message: 'Detecting speech...' });

  // Detect speech
  const rawMarkers = detectSpeechSegments(samples, vad);

  // Process markers
  const processedMarkers = processMarkers(rawMarkers, durationMs);

  // Calculate speech vs silence
  const totalSpeechMs = processedMarkers.reduce((sum, m) => sum + (m.endMs - m.startMs), 0);
  const silencePercent = ((1 - totalSpeechMs / durationMs) * 100).toFixed(1);

  // Get file size for logging
  const fileSizeBytes = fs.statSync(wavPath).size;
  const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Estimate speech-only file size (proportional to speech duration)
  const speechRatio = totalSpeechMs / durationMs;
  const estimatedSpeechSizeMB = (fileSizeBytes * speechRatio / (1024 * 1024)).toFixed(2);

  // Nice formatted log
  const originalDuration = (durationMs / 1000).toFixed(1);
  const speechDuration = (totalSpeechMs / 1000).toFixed(1);
  console.log('');
  console.log('///// VAD ANALYSE /////');
  console.log(`  Original:  ${originalDuration}s (${fileSizeMB} MB)`);
  console.log(`  Sprache:   ${speechDuration}s (~${estimatedSpeechSizeMB} MB)`);
  console.log(`  Entfernt:  ${silencePercent}% Stille`);
  console.log(`  Segmente:  ${processedMarkers.length}`);
  console.log(`  Padding:   ${CONFIG.preRollMs}ms vor | ${CONFIG.postRollMs}ms nach`);
  console.log('///////////////////////');
  console.log('');

  onProgress({ stage: 'vad', percent: 20, message: `${processedMarkers.length} speech segments found` });

  // Convert to segment format expected by pipeline
  const segments = processedMarkers.map((marker, index) => ({
    index: index,
    path: wavPath,
    startMs: marker.startMs,
    endMs: marker.endMs,
    duration: marker.endMs - marker.startMs,
    startTime: marker.startMs,
    endTime: marker.endMs
  }));

  // Clean up VAD
  try {
    vad.clear();
  } catch (e) {
    // Ignore cleanup errors
  }

  return segments;
}

module.exports = {
  runOfflineVAD,
  CONFIG
};
