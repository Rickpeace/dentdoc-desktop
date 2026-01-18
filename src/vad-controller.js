/**
 * VAD Controller - Main Process
 *
 * NEW ARCHITECTURE (per plan):
 * - FFmpeg records EVERYTHING continuously to full.wav
 * - VAD runs in parallel and collects speech markers (timestamps)
 * - After recording stops, speech markers are used to cut speech_only.wav
 *
 * Flow:
 *   DURING RECORDING:
 *     FFmpeg → full.wav (complete recording)
 *     VAD (parallel) → speech markers [{start: 5000, end: 15000}, ...]
 *
 *   AFTER STOP:
 *     speech markers + full.wav → speech_only.wav (via FFmpeg concat)
 */

const { ipcMain, BrowserWindow } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');
const audioRecorder = require('./audioRecorderFFmpeg');

// VAD Worker Thread
let vadWorker = null;
let vadWorkerInitialized = false;

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Minimum speech duration to keep (discard shorter markers)
  minSpeechMs: 300,
  // Merge markers closer than this (ms)
  mergeGapMs: 500,
  // Padding before speech start (ms) - increased to avoid cutting first syllable
  paddingBeforeMs: 800,
  // Padding after speech end (ms)
  paddingAfterMs: 500
};

// ============================================================================
// STATE
// ============================================================================

let state = {
  sessionActive: false,
  // Full recording path
  fullRecordingPath: null,
  recordingStartTime: null,
  // Speech markers collected during recording
  speechMarkers: [],  // [{startMs, endMs}, ...]
  currentSpeechStart: null,  // When current speech started (null if not speaking)
  // Microphone
  microphoneId: null,
  tempDir: null
};

// Event callbacks
let callbacks = {
  onSpeechMarker: null,
  onSessionEnd: null,
  onError: null
};

// Audio level throttling (send ~10 updates per second)
let lastAudioLevelSend = 0;
const AUDIO_LEVEL_INTERVAL_MS = 100;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function log(message, ...args) {
  console.log(`[VAD Controller] ${message}`, ...args);
}

function logError(message, ...args) {
  console.error(`[VAD Controller] ERROR: ${message}`, ...args);
}

function getTempDir() {
  if (!state.tempDir) {
    state.tempDir = path.join(app.getPath('temp'), 'dentdoc', 'vad-recording');
    if (!fs.existsSync(state.tempDir)) {
      fs.mkdirSync(state.tempDir, { recursive: true });
    }
  }
  return state.tempDir;
}

function getFullRecordingPath() {
  const timestamp = Date.now();
  return path.join(getTempDir(), `full_recording_${timestamp}.wav`);
}

/**
 * Get FFmpeg path
 */
function getFFmpegPath() {
  // Try bundled FFmpeg first
  const bundledPath = path.join(__dirname, '..', 'bin', 'ffmpeg.exe');
  const bundledPathPacked = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    : bundledPath;

  if (fs.existsSync(bundledPathPacked)) {
    return bundledPathPacked;
  }
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // Fallback to ffmpeg-static
  return require('ffmpeg-static');
}

/**
 * Merge overlapping or close markers
 */
function mergeMarkers(markers) {
  if (markers.length <= 1) return markers;

  // Sort by start time
  const sorted = [...markers].sort((a, b) => a.startMs - b.startMs);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    // If current starts within mergeGapMs of last end, merge them
    if (current.startMs <= last.endMs + CONFIG.mergeGapMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Apply padding to markers (clamped to recording duration)
 */
function applyPadding(markers, recordingDurationMs) {
  return markers.map(m => ({
    startMs: Math.max(0, m.startMs - CONFIG.paddingBeforeMs),
    endMs: Math.min(recordingDurationMs, m.endMs + CONFIG.paddingAfterMs)
  }));
}

/**
 * Filter out markers that are too short
 */
function filterShortMarkers(markers) {
  return markers.filter(m => (m.endMs - m.startMs) >= CONFIG.minSpeechMs);
}

// ============================================================================
// VAD EVENT HANDLERS
// ============================================================================

/**
 * Handle speech start from VAD Worker
 */
function handleSpeechStart(timestamp) {
  if (!state.sessionActive || state.currentSpeechStart !== null) {
    return;
  }

  // Calculate relative time from recording start
  const relativeMs = timestamp - state.recordingStartTime;
  state.currentSpeechStart = Math.max(0, relativeMs);

  log(`Speech started at ${state.currentSpeechStart}ms`);

  // Notify renderer
  notifyRenderer('vad-speech-detected', { isSpeech: true, timestamp });
}

/**
 * Handle speech end from VAD Worker
 */
function handleSpeechEnd(timestamp) {
  if (!state.sessionActive || state.currentSpeechStart === null) {
    return;
  }

  // Calculate relative time from recording start
  const relativeMs = timestamp - state.recordingStartTime;
  const endMs = Math.max(state.currentSpeechStart, relativeMs);

  // Create marker
  const marker = {
    startMs: state.currentSpeechStart,
    endMs: endMs
  };

  state.speechMarkers.push(marker);
  state.currentSpeechStart = null;

  log(`Speech ended at ${endMs}ms, marker: ${marker.startMs}-${marker.endMs}ms`);

  // Notify renderer
  notifyRenderer('vad-speech-detected', { isSpeech: false, timestamp });

  if (callbacks.onSpeechMarker) {
    callbacks.onSpeechMarker(marker);
  }
}

// ============================================================================
// WORKER THREAD MANAGEMENT
// ============================================================================

async function initializeWorker() {
  if (vadWorker) {
    log('Worker already exists');
    return vadWorkerInitialized;
  }

  return new Promise((resolve, reject) => {
    try {
      const workerPath = path.join(__dirname, 'vad', 'vad-worker-thread.js');
      log('Starting VAD Worker Thread:', workerPath);

      vadWorker = new Worker(workerPath);

      const timeout = setTimeout(() => {
        logError('Worker initialization timeout after 30s');
        reject(new Error('VAD Worker initialization timeout'));
      }, 30000);

      vadWorker.on('message', (data) => {
        switch (data.type) {
          case 'initialized':
            clearTimeout(timeout);
            vadWorkerInitialized = true;
            log('VAD Worker initialized successfully');
            resolve(true);
            break;

          case 'speech-start':
            handleSpeechStart(data.timestamp || Date.now());
            break;

          case 'speech-end':
            handleSpeechEnd(data.timestamp || Date.now());
            break;

          case 'status':
            log('Worker status:', data.message);
            break;

          case 'error':
            logError('Worker error:', data.message);
            if (!vadWorkerInitialized) {
              clearTimeout(timeout);
              reject(new Error(data.message));
            }
            break;

          default:
            log('Unknown worker message:', data.type);
        }
      });

      vadWorker.on('error', (error) => {
        logError('Worker thread error:', error.message);
        clearTimeout(timeout);
        vadWorkerInitialized = false;
        reject(error);
      });

      vadWorker.on('exit', (code) => {
        log('Worker thread exited with code:', code);
        vadWorker = null;
        vadWorkerInitialized = false;
      });

      // Send init message
      vadWorker.postMessage({ type: 'init' });

    } catch (error) {
      logError('Failed to create worker:', error.message);
      reject(error);
    }
  });
}

function terminateWorker() {
  if (vadWorker) {
    vadWorker.postMessage({ type: 'stop' });
    vadWorker.terminate();
    vadWorker = null;
    vadWorkerInitialized = false;
    log('Worker terminated');
  }
}

function processAudioBatch(samples, timestamp) {
  if (!vadWorker || !vadWorkerInitialized) {
    return;
  }

  // Element-by-element copy to avoid external buffer issues
  const len = samples.length;
  const samplesCopy = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    samplesCopy[i] = samples[i];
  }

  vadWorker.postMessage({
    type: 'audio-batch',
    samples: samplesCopy,
    timestamp: timestamp
  });
}

function notifyRenderer(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

/**
 * Calculate RMS (Root Mean Square) from Float32 audio samples
 * Returns value 0-1 representing audio level
 */
function calculateRMS(samples) {
  if (!samples || samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }

  return Math.sqrt(sum / samples.length);
}

/**
 * Send audio level to status overlay (throttled)
 */
function sendAudioLevel(samples) {
  const now = Date.now();
  if (now - lastAudioLevelSend < AUDIO_LEVEL_INTERVAL_MS) {
    return; // Throttle - don't send too often
  }
  lastAudioLevelSend = now;

  const rms = calculateRMS(samples);
  // Notify all windows (status overlay listens for 'audio-level')
  notifyRenderer('audio-level', rms);
}

// ============================================================================
// PUBLIC API
// ============================================================================

function initialize() {
  log('Initializing VAD Controller');

  // Set up IPC handler for audio batches from Renderer
  let batchCount = 0;
  ipcMain.on('vad-audio-batch', (event, data) => {
    batchCount++;

    const shouldLog = batchCount <= 5 || batchCount % 10 === 1;
    if (shouldLog) {
      log(`Audio batch #${batchCount} received, sessionActive=${state.sessionActive}, workerInit=${vadWorkerInitialized}`);
    }

    if (state.sessionActive && vadWorkerInitialized) {
      processAudioBatch(data.samples, data.timestamp);

      // Send audio level to status overlay for cool glow animation
      sendAudioLevel(data.samples);
    }
  });

  // IPC handlers
  ipcMain.handle('vad-initialize', async () => {
    try {
      await initializeWorker();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('vad-is-initialized', () => {
    return vadWorkerInitialized;
  });

  ipcMain.on('vad-audio-stop', () => {
    log('Audio stop received from renderer');
    if (vadWorker && vadWorkerInitialized) {
      vadWorker.postMessage({ type: 'stop' });
    }
  });

  log('VAD Controller initialized');
}

/**
 * Start a VAD recording session
 * Records full audio while VAD collects speech markers
 */
async function startSession(options = {}) {
  if (state.sessionActive) {
    log('Session already active');
    return false;
  }

  log('Starting VAD session (full recording + speech markers)');

  // Reset state
  state.sessionActive = true;
  state.speechMarkers = [];
  state.currentSpeechStart = null;
  state.microphoneId = options.microphoneId || null;
  state.fullRecordingPath = getFullRecordingPath();
  state.recordingStartTime = Date.now();

  // Set callbacks
  callbacks.onSpeechMarker = options.onSpeechMarker || null;
  callbacks.onSessionEnd = options.onSessionEnd || null;
  callbacks.onError = options.onError || null;

  try {
    // Log temp folder
    console.log('');
    console.log('///// TEMP DATEIEN (Live-VAD) /////');
    console.log(`  Ordner: ${getTempDir()}`);

    // Start continuous FFmpeg recording
    await audioRecorder.startRecording(false, state.microphoneId, state.fullRecordingPath);
    console.log(`  [TEMP] Erstellt: ${path.basename(state.fullRecordingPath)}`);
    return true;
  } catch (error) {
    logError('Failed to start recording:', error);
    state.sessionActive = false;
    if (callbacks.onError) {
      callbacks.onError(error);
    }
    return false;
  }
}

/**
 * Stop the VAD recording session
 * Stops FFmpeg, then cuts speech_only.wav from markers
 * @returns {Promise<Array>} Segments with speech-only audio
 */
async function stopSession() {
  if (!state.sessionActive) {
    log('No session active');
    return [];
  }

  log('Stopping VAD session');
  state.sessionActive = false;

  // If currently speaking, close the marker
  if (state.currentSpeechStart !== null) {
    const endMs = Date.now() - state.recordingStartTime;
    state.speechMarkers.push({
      startMs: state.currentSpeechStart,
      endMs: endMs
    });
    state.currentSpeechStart = null;
  }

  // Stop FFmpeg recording
  let fullRecordingPath;
  let recordingDurationMs;
  try {
    fullRecordingPath = await audioRecorder.stopRecording();
    recordingDurationMs = Date.now() - state.recordingStartTime;
    log(`Recording stopped: ${fullRecordingPath}, duration: ${recordingDurationMs}ms`);
  } catch (error) {
    logError('Failed to stop recording:', error);
    if (callbacks.onError) {
      callbacks.onError(error);
    }
    return [];
  }

  // Process markers
  let markers = filterShortMarkers(state.speechMarkers);
  markers = mergeMarkers(markers);
  markers = applyPadding(markers, recordingDurationMs);

  // Calculate speech vs silence stats
  const totalSpeechMs = markers.reduce((sum, m) => sum + (m.endMs - m.startMs), 0);
  const silencePercent = ((1 - totalSpeechMs / recordingDurationMs) * 100).toFixed(1);

  // Get file size for logging
  let fileSizeMB = '?';
  let estimatedSpeechSizeMB = '?';
  if (fs.existsSync(fullRecordingPath)) {
    const fileSizeBytes = fs.statSync(fullRecordingPath).size;
    fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
    const speechRatio = totalSpeechMs / recordingDurationMs;
    estimatedSpeechSizeMB = (fileSizeBytes * speechRatio / (1024 * 1024)).toFixed(2);
  }

  // Nice formatted log
  const originalDuration = (recordingDurationMs / 1000).toFixed(1);
  const speechDuration = (totalSpeechMs / 1000).toFixed(1);
  console.log('');
  console.log('///// LIVE-VAD ANALYSE /////');
  console.log(`  Original:  ${originalDuration}s (${fileSizeMB} MB)`);
  console.log(`  Sprache:   ${speechDuration}s (~${estimatedSpeechSizeMB} MB)`);
  console.log(`  Entfernt:  ${silencePercent}% Stille`);
  console.log('////////////////////////////');
  console.log('');

  if (markers.length === 0) {
    log('No speech detected in recording');
    // Clean up full recording
    if (fs.existsSync(fullRecordingPath)) {
      fs.unlinkSync(fullRecordingPath);
      console.log(`  [TEMP] Geloescht: ${path.basename(fullRecordingPath)} (keine Sprache)`);
    }
    return [];
  }

  // Convert markers to segments format expected by pipeline
  const segments = markers.map((marker, index) => ({
    index: index,
    path: fullRecordingPath,  // All segments reference the full recording
    startMs: marker.startMs,
    endMs: marker.endMs,
    duration: marker.endMs - marker.startMs,
    startTime: state.recordingStartTime + marker.startMs,
    endTime: state.recordingStartTime + marker.endMs
  }));

  // Store full recording path for cleanup later
  segments.fullRecordingPath = fullRecordingPath;

  log(`VAD session ended, ${segments.length} speech segments identified`);

  if (callbacks.onSessionEnd) {
    callbacks.onSessionEnd(segments);
  }

  return segments;
}

/**
 * Render speech-only WAV from full recording + markers
 * This is called by the pipeline's speechRenderer
 */
async function renderSpeechOnly(segments, outputPath) {
  if (!segments || segments.length === 0) {
    throw new Error('No segments to render');
  }

  const fullRecordingPath = segments[0].path;

  if (segments.length === 1) {
    // Single segment - extract directly
    const seg = segments[0];
    return extractSegment(fullRecordingPath, seg.startMs, seg.endMs - seg.startMs, outputPath);
  }

  // Multiple segments - extract each and concatenate
  const ffmpegPath = getFFmpegPath();
  const tempDir = getTempDir();
  const tempFiles = [];

  console.log(`  [TEMP] Extrahiere ${segments.length} Segmente...`);

  // Extract each segment to temp file
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const tempFile = path.join(tempDir, `temp_seg_${i}.wav`);
    await extractSegment(fullRecordingPath, seg.startMs, seg.endMs - seg.startMs, tempFile);
    tempFiles.push(tempFile);
  }

  // Create concat list
  const listPath = path.join(tempDir, 'concat_list.txt');
  const listContent = tempFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listPath, listContent);
  console.log(`  [TEMP] Erstellt: concat_list.txt`);

  // Concatenate
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    ffmpeg.on('close', (code) => {
      // Clean up temp files
      fs.unlinkSync(listPath);
      console.log(`  [TEMP] Geloescht: concat_list.txt`);

      let cleanedCount = 0;
      tempFiles.forEach(f => {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          cleanedCount++;
        }
      });
      console.log(`  [TEMP] Geloescht: ${cleanedCount} Segment-Dateien`);

      if (code === 0) {
        // Log final speech-only file size
        if (fs.existsSync(outputPath)) {
          const speechOnlySize = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
          console.log(`  [TEMP] Erstellt: speech_only.wav (${speechOnlySize} MB)`);
        }
        console.log('///////////////////////////////////');
        console.log('');
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg concat failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Extract a segment from audio file
 */
function extractSegment(inputPath, startMs, durationMs, outputPath) {
  const ffmpegPath = getFFmpegPath();

  return new Promise((resolve, reject) => {
    const args = [
      '-ss', (startMs / 1000).toFixed(3),
      '-i', inputPath,
      '-t', (durationMs / 1000).toFixed(3),
      '-c', 'copy',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg extract failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Get current state
 */
function getState() {
  return {
    sessionActive: state.sessionActive,
    markerCount: state.speechMarkers.length,
    isSpeaking: state.currentSpeechStart !== null
  };
}

/**
 * Get speech markers
 */
function getMarkers() {
  return [...state.speechMarkers];
}

/**
 * Check if session is active
 */
function isEnabled() {
  return state.sessionActive;
}

/**
 * Legacy: concatenateSegments for backwards compatibility
 * Now just calls renderSpeechOnly
 */
async function concatenateSegments(outputPath) {
  const segments = state.speechMarkers.map((marker, index) => ({
    index,
    path: state.fullRecordingPath,
    startMs: marker.startMs,
    endMs: marker.endMs,
    duration: marker.endMs - marker.startMs
  }));

  return renderSpeechOnly(segments, outputPath);
}

module.exports = {
  initialize,
  initializeWorker,
  terminateWorker,
  startSession,
  stopSession,
  getState,
  getMarkers,
  isEnabled,
  isWorkerInitialized: () => vadWorkerInitialized,
  renderSpeechOnly,
  concatenateSegments,
  CONFIG
};
