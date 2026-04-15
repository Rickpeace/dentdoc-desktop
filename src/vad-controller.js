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
  // Merge markers closer than this (ms) - 1s to prevent splitting continuous speech
  mergeGapMs: 1000,
  // Padding before speech start (ms) - 1.5s to never cut first syllable
  paddingBeforeMs: 1500,
  // Padding after speech end (ms) - 0.8s for trailing sounds
  paddingAfterMs: 800
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
  tempDir: null,
  // Sample-based timeline (for marker-only mode)
  processedSamples: 0,
  sampleRate: 16000,
  isPaused: false,
  markerOnlyMode: false
};

// Event callbacks
let callbacks = {
  onSpeechMarker: null,
  onSessionEnd: null,
  onError: null
};

// Audio level throttling (send ~20 updates per second for smooth animation)
let lastAudioLevelSend = 0;
const AUDIO_LEVEL_INTERVAL_MS = 50;

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
  const padded = markers.map(m => ({
    startMs: Math.max(0, m.startMs - CONFIG.paddingBeforeMs),
    endMs: Math.min(recordingDurationMs, m.endMs + CONFIG.paddingAfterMs)
  }));

  // Prevent overlap between adjacent markers (causes doubled words)
  for (let i = 1; i < padded.length; i++) {
    if (padded[i].startMs < padded[i - 1].endMs) {
      const mid = (padded[i - 1].endMs + padded[i].startMs) / 2;
      padded[i - 1].endMs = mid;
      padded[i].startMs = mid;
    }
  }

  return padded;
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
function handleSpeechStart(data) {
  if (!state.sessionActive || state.currentSpeechStart !== null) {
    return;
  }

  // Sample-based timeline: exact alignment with WAV file
  const samplePosition = data.samplePosition || 0;
  const relativeMs = (samplePosition / state.sampleRate) * 1000;
  state.currentSpeechStart = Math.max(0, relativeMs);

  log(`Speech started at ${state.currentSpeechStart.toFixed(0)}ms (sample ${samplePosition})`);

  // Notify renderer
  notifyRenderer('vad-speech-detected', { isSpeech: true });
}

/**
 * Handle speech end from VAD Worker
 */
function handleSpeechEnd(data) {
  if (!state.sessionActive || state.currentSpeechStart === null) {
    return;
  }

  // Sample-based timeline: exact alignment with WAV file
  const samplePosition = data.samplePosition || 0;
  const relativeMs = (samplePosition / state.sampleRate) * 1000;
  const endMs = Math.max(state.currentSpeechStart, relativeMs);

  // Create marker
  const marker = {
    startMs: state.currentSpeechStart,
    endMs: endMs
  };

  state.speechMarkers.push(marker);
  state.currentSpeechStart = null;

  log(`Speech ended at ${endMs.toFixed(0)}ms, marker: ${marker.startMs.toFixed(0)}-${marker.endMs.toFixed(0)}ms`);

  // Notify renderer
  notifyRenderer('vad-speech-detected', { isSpeech: false });

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
            handleSpeechStart(data);
            break;

          case 'speech-end':
            handleSpeechEnd(data);
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
  if (state.isPaused) return;  // Skip during pause — sample counter stops, timeline auto-excludes pause

  // Track sample-based timeline
  state.processedSamples += samples.length;

  // Element-by-element copy to avoid external buffer issues
  const len = samples.length;
  const samplesCopy = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    samplesCopy[i] = samples[i];
  }

  vadWorker.postMessage({
    type: 'audio-batch',
    samples: samplesCopy,
    timestamp: timestamp,
    samplePosition: state.processedSamples
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
let peakRmsSinceLastSend = 0;
let autoGain = 15;  // Start conservative, auto-adjusts upward for quiet mics
function sendAudioLevel(samples) {
  // Track peak RMS across all batches (not just the one at send time)
  const rms = calculateRMS(samples);
  if (rms > peakRmsSinceLastSend) peakRmsSinceLastSend = rms;

  const now = Date.now();
  if (now - lastAudioLevelSend < AUDIO_LEVEL_INTERVAL_MS) {
    return; // Throttle - don't send too often
  }
  lastAudioLevelSend = now;

  // Auto-gain: if peak level is too low, increase gain gradually
  // Target: speech should produce boosted values around 0.3-0.8
  const peak = peakRmsSinceLastSend;
  if (peak > 0.0005 && peak * autoGain < 0.15) {
    autoGain = Math.min(200, autoGain * 1.5);
  } else if (peak * autoGain > 1.5 && autoGain > 5) {
    autoGain = Math.max(5, autoGain * 0.8);
  }

  const boosted = Math.min(1, peak * autoGain);
  peakRmsSinceLastSend = 0;
  notifyRenderer('audio-level', boosted);
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

    // Only log first batch and then every 500th (~50s)
    if (batchCount === 1 || batchCount % 500 === 0) {
      log(`Audio batch #${batchCount}, markers: ${state.speechMarkers.length}`);
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

// ============================================================================
// MARKER-ONLY MODE (for live VAD during F9 recording)
// Recording managed by main.js, we only collect speech markers
// ============================================================================

/**
 * Start collecting speech markers without starting a recording.
 * Recording is managed externally by main.js (audioRecorder).
 * Uses sample-based timeline for accurate marker positions.
 */
function startMarkerCollection(options = {}) {
  if (state.sessionActive) {
    log('Session already active');
    return false;
  }

  log('Starting marker collection (marker-only mode)');
  state.sessionActive = true;
  state.markerOnlyMode = true;
  state.speechMarkers = [];
  state.currentSpeechStart = null;
  state.processedSamples = 0;
  state.isPaused = false;
  state.fullRecordingPath = options.fullRecordingPath || null;

  return true;
}

/**
 * Stop collecting markers and return processed segments.
 * Does NOT stop any recording — that's managed by main.js.
 * @param {string} fullRecordingPath - Path to the full WAV recording
 * @returns {Array} Segments ready for speechRenderer.renderSpeechOnly()
 */
function stopMarkerCollection(fullRecordingPath) {
  if (!state.sessionActive) {
    log('No active session');
    return [];
  }

  state.sessionActive = false;

  // Close open speech marker using current sample position
  const recordingDurationMs = (state.processedSamples / state.sampleRate) * 1000;
  if (state.currentSpeechStart !== null) {
    state.speechMarkers.push({
      startMs: state.currentSpeechStart,
      endMs: recordingDurationMs
    });
    state.currentSpeechStart = null;
  }

  // Process markers (filter short, merge close, add padding)
  let markers = filterShortMarkers(state.speechMarkers);
  markers = mergeMarkers(markers);
  markers = applyPadding(markers, recordingDurationMs);

  // Log stats
  const totalSpeechMs = markers.reduce((sum, m) => sum + (m.endMs - m.startMs), 0);
  const silencePercent = recordingDurationMs > 0
    ? ((1 - totalSpeechMs / recordingDurationMs) * 100).toFixed(1) : '0';

  console.log('');
  console.log('///// LIVE-VAD ERGEBNIS /////');
  console.log(`  Aufnahme:  ${(recordingDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Sprache:   ${(totalSpeechMs / 1000).toFixed(1)}s`);
  console.log(`  Entfernt:  ${silencePercent}% Stille`);
  console.log(`  Marker:    ${state.speechMarkers.length} roh → ${markers.length} verarbeitet`);
  console.log('////////////////////////////');

  // Convert to segment format for speechRenderer
  const segments = markers.map((marker, index) => ({
    index,
    path: fullRecordingPath,
    startMs: marker.startMs,
    endMs: marker.endMs,
    duration: marker.endMs - marker.startMs
  }));

  state.markerOnlyMode = false;
  return segments;
}

/**
 * Pause marker collection (e.g., when recording is paused).
 * Audio batches will be ignored and sample counter stops.
 * Timeline auto-excludes pause gaps.
 */
function pauseMarkerCollection() {
  if (!state.sessionActive || state.isPaused) return;
  state.isPaused = true;
  log('Marker collection paused');
}

/**
 * Resume marker collection (e.g., when recording resumes).
 */
function resumeMarkerCollection() {
  if (!state.sessionActive || !state.isPaused) return;
  state.isPaused = false;
  log('Marker collection resumed');
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
  startMarkerCollection,
  stopMarkerCollection,
  pauseMarkerCollection,
  resumeMarkerCollection,
  CONFIG
};
