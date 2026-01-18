/**
 * VAD Worker Thread (Node.js Worker)
 *
 * Runs in Main Process context using Node.js worker_threads.
 * Uses Sherpa-ONNX Silero VAD for voice activity detection.
 *
 * IMPORTANT:
 * - This is a Node.js WorkerThread, NOT a Web Worker
 * - Can safely use require() for all Node modules
 * - Communicates with parent via parentPort.postMessage()
 *
 * Flow:
 *   Main Process -> (postMessage) -> This Worker -> (postMessage) -> Main Process
 */

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Sherpa-ONNX - loaded dynamically
let sherpa = null;
let vad = null;

// VAD Configuration
const CONFIG = {
  sampleRate: 16000,
  // REDUZIERT: 100ms statt 300ms für schnelleren Recording-Start
  // FFmpeg braucht ~500ms zum Initialisieren, daher früher starten
  speechStartMs: 100,
  speechStopMs: 1500,
  // PRE-ROLL: Erhöht auf 800ms um den FFmpeg-Startup zu kompensieren
  preRollMs: 800,
  postRollMs: 1000,
  frameMs: 20,
  // Silero VAD parameters - niedrigerer Threshold für schnellere Erkennung
  sileroThreshold: 0.4,
  minSpeechDuration: 0.1,  // Reduziert von 0.25
  maxSpeechDuration: 300,
  // Silero model URL (official sherpa-onnx release)
  modelUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
};

// State tracking
let state = {
  isInitialized: false,
  isSpeech: false,
  speechFrameCount: 0,
  silenceFrameCount: 0,
  lastStateChangeTime: 0
};

// Ring buffer for pre-roll (keeps last 800ms of audio to compensate for FFmpeg startup)
const preRollSamples = Math.floor(CONFIG.sampleRate * CONFIG.preRollMs / 1000);
let ringBuffer = new Float32Array(preRollSamples);
let ringBufferIndex = 0;

/**
 * Log with prefix
 */
function log(message, ...args) {
  console.log(`[VAD WorkerThread] ${message}`, ...args);
}

/**
 * Get the model directory path
 */
function getModelDir() {
  // Worker runs from src/vad/, models are in /models/
  const possiblePaths = [
    path.join(__dirname, '..', '..', 'models'),
    path.join(process.cwd(), 'models'),
    // For packaged app
    path.join(__dirname, '..', '..', '..', 'app.asar.unpacked', 'models')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Create default path if none exist
  const defaultPath = path.join(__dirname, '..', '..', 'models');
  fs.mkdirSync(defaultPath, { recursive: true });
  return defaultPath;
}

/**
 * Download Silero VAD model if not present
 */
async function downloadModel(modelPath) {
  return new Promise((resolve, reject) => {
    log('Downloading Silero VAD model...');
    parentPort.postMessage({ type: 'status', message: 'Downloading VAD model...' });

    const file = fs.createWriteStream(modelPath);

    const downloadWithRedirect = (url) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          downloadWithRedirect(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          fs.unlink(modelPath, () => {});
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          log('Model downloaded successfully');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(modelPath, () => {});
        reject(err);
      });
    };

    downloadWithRedirect(CONFIG.modelUrl);
  });
}

/**
 * Initialize Sherpa-ONNX VAD
 */
async function initializeVAD() {
  if (state.isInitialized) {
    return;
  }

  try {
    // Load sherpa-onnx-node
    sherpa = require('sherpa-onnx-node');
    log('Sherpa-ONNX loaded');

    // Check for Silero VAD model
    const modelDir = getModelDir();
    const modelPath = path.join(modelDir, 'silero_vad.onnx');

    if (!fs.existsSync(modelPath)) {
      log('Silero VAD model not found, downloading...');
      await downloadModel(modelPath);
    }

    // Create VAD config
    const vadConfig = {
      sileroVad: {
        model: modelPath,
        threshold: CONFIG.sileroThreshold,
        minSpeechDuration: CONFIG.minSpeechDuration,
        maxSpeechDuration: CONFIG.maxSpeechDuration,
        minSilenceDuration: 0.5
      },
      sampleRate: CONFIG.sampleRate,
      bufferSizeInSeconds: 60,
      debug: false
    };

    log('Creating VAD with config:', JSON.stringify(vadConfig, null, 2));

    // Create VAD instance
    // WICHTIG: Node.js API braucht ZWEI Argumente: (config, sampleRate)
    vad = new sherpa.Vad(vadConfig, CONFIG.sampleRate);
    log('VAD created:', vad !== null);

    // NUCLEAR FIX: Wrap acceptWaveform to ALWAYS create a safe local buffer
    // This prevents "External buffers are not allowed" error no matter what
    const originalAcceptWaveform = vad.acceptWaveform.bind(vad);
    let wrapperCallCount = 0;
    vad.acceptWaveform = (input) => {
      wrapperCallCount++;
      // Use pure JavaScript ArrayBuffer - NOT Node.js Buffer
      // Node.js Buffer might still create external buffers in Worker context
      const arrayBuffer = new ArrayBuffer(input.length * 4);
      const safeSamples = new Float32Array(arrayBuffer);
      // Manual copy - no tricks, just raw assignment
      for (let idx = 0; idx < input.length; idx++) {
        safeSamples[idx] = input[idx];
      }
      if (wrapperCallCount <= 3 || wrapperCallCount % 50 === 0) {
        log(`acceptWaveform wrapper called #${wrapperCallCount}, input.length=${input.length}`);
      }
      return originalAcceptWaveform(safeSamples);
    };
    log('acceptWaveform wrapped with ArrayBuffer-based safe copy');

    state.isInitialized = true;
    log('VAD initialized successfully');
    parentPort.postMessage({ type: 'initialized' });

  } catch (error) {
    log('Failed to initialize VAD:', error.message);
    parentPort.postMessage({ type: 'error', message: error.message });
  }
}

/**
 * Add samples to ring buffer (for pre-roll)
 */
function addToRingBuffer(samples) {
  for (let i = 0; i < samples.length; i++) {
    ringBuffer[ringBufferIndex] = samples[i];
    ringBufferIndex = (ringBufferIndex + 1) % preRollSamples;
  }
}

// Debug counter for logging
let processedBatchCount = 0;

/**
 * Process audio batch
 */
function processAudioBatch(samples, timestamp) {
  if (!state.isInitialized || !vad) {
    log('WARNING: processAudioBatch called but not initialized. isInit:', state.isInitialized, 'vad:', !!vad);
    return;
  }

  processedBatchCount++;

  // Der Wrapper um vad.acceptWaveform() erstellt die sichere Kopie
  // Wir übergeben samples direkt - der Wrapper kümmert sich um alles

  // Add to ring buffer (for pre-roll) - uses element copy internally
  addToRingBuffer(samples);

  // Feed samples to VAD - wrapper creates safe ArrayBuffer copy
  vad.acceptWaveform(samples);

  // Check if VAD detected speech
  const isSpeech = vad.isDetected();

  // Log every 10th batch (~1 second)
  if (processedBatchCount % 10 === 1) {
    // RMS ist stabiler als Max für Sprache-Erkennung
    // Keine Spread-Operatoren verwenden (GC-problematisch im Worker)
    let sumSq = 0;
    const sampleCount = Math.min(100, samples.length);
    for (let i = 0; i < sampleCount; i++) {
      const v = samples[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / sampleCount);
    log(`Batch #${processedBatchCount}: samples=${samples.length}, rms=${rms.toFixed(4)}, isDetected=${isSpeech}`);
  }

  // Update counters
  const frameMs = (samples.length / CONFIG.sampleRate) * 1000;

  if (isSpeech) {
    state.speechFrameCount++;
    state.silenceFrameCount = 0;
  } else {
    state.silenceFrameCount++;
    // Don't reset speechFrameCount immediately - allow for brief pauses
  }

  // State machine logic
  const speechMs = state.speechFrameCount * frameMs;
  const silenceMs = state.silenceFrameCount * frameMs;
  const now = Date.now();

  // Speech start: speech detected for >= 300ms
  if (!state.isSpeech && speechMs >= CONFIG.speechStartMs) {
    state.isSpeech = true;
    state.lastStateChangeTime = now;
    state.silenceFrameCount = 0;

    log('Speech started');

    // Send event to main process
    parentPort.postMessage({
      type: 'speech-start',
      timestamp: now,
      preRollMs: CONFIG.preRollMs
    });
  }

  // Speech end: silence detected for >= 1500ms
  if (state.isSpeech && silenceMs >= CONFIG.speechStopMs) {
    state.isSpeech = false;
    state.speechFrameCount = 0;
    state.lastStateChangeTime = now;

    log('Speech ended');

    // Send event to main process
    parentPort.postMessage({
      type: 'speech-end',
      timestamp: now,
      postRollMs: CONFIG.postRollMs
    });
  }

  // WICHTIG: NICHT vad.front() / vad.pop() aufrufen!
  // Diese Methoden greifen auf Sherpas internen Segment-Buffer zu,
  // der "external buffers" enthält -> "External buffers are not allowed" crash
  // Wir nutzen nur vad.isDetected() (Modus 2), nicht Sherpas Segment-Queue (Modus 1)
}

/**
 * Reset VAD state
 */
function reset() {
  state.isSpeech = false;
  state.speechFrameCount = 0;
  state.silenceFrameCount = 0;
  state.lastStateChangeTime = 0;

  // Clear ring buffer
  ringBuffer.fill(0);
  ringBufferIndex = 0;

  // Reset Sherpa VAD if available
  // vad.clear() should be safe - it just resets internal state
  if (vad) {
    try {
      vad.clear();
    } catch (err) {
      log('Warning: vad.clear() failed:', err.message);
    }
  }

  log('State reset');
}

/**
 * Handle messages from main process
 */
parentPort.on('message', async (data) => {
  const { type, samples, timestamp } = data;

  switch (type) {
    case 'init':
      await initializeVAD();
      break;

    case 'audio-batch':
      // Einfache Kopie - der Wrapper um acceptWaveform macht die sichere Kopie
      // Wir übergeben die Samples direkt, der Wrapper kümmert sich um den Rest
      processAudioBatch(samples, timestamp);
      break;

    case 'reset':
      reset();
      break;

    case 'stop':
      // Final speech end if we were speaking
      if (state.isSpeech) {
        parentPort.postMessage({
          type: 'speech-end',
          timestamp: Date.now(),
          postRollMs: CONFIG.postRollMs,
          reason: 'manual-stop'
        });
      }
      reset();
      break;

    case 'get-state':
      parentPort.postMessage({
        type: 'state',
        isSpeech: state.isSpeech,
        isInitialized: state.isInitialized
      });
      break;

    default:
      log('Unknown message type:', type);
  }
});

// Auto-initialize on load
initializeVAD().catch(err => {
  log('Auto-init failed:', err.message);
});
