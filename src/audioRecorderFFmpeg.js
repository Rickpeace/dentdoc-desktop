/**
 * FFmpeg-based Audio Recorder
 *
 * Uses Windows DirectShow via FFmpeg for robust audio recording.
 * This bypasses Chromium's WebRTC which can have issues with USB hubs.
 *
 * Advantages:
 * - Same device handling as Windows itself
 * - No USB hub compatibility issues
 * - Direct WAV output (no conversion needed)
 * - Windows device names instead of browser device IDs
 *
 * IMPORTANT: Uses a state machine to ensure only ONE recording at a time.
 * States: idle -> starting -> recording -> stopping -> idle
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

// Get ffmpeg path - prefer full build with WASAPI support, fallback to ffmpeg-static
let ffmpegPath;

// First, try to use bundled full FFmpeg with WASAPI support
const bundledFFmpegPath = path.join(__dirname, '..', 'bin', 'ffmpeg.exe');
const bundledFFmpegPathPacked = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
  : bundledFFmpegPath;

if (fs.existsSync(bundledFFmpegPathPacked)) {
  ffmpegPath = bundledFFmpegPathPacked;
  console.log('Using bundled FFmpeg with WASAPI support:', ffmpegPath);
} else if (fs.existsSync(bundledFFmpegPath)) {
  ffmpegPath = bundledFFmpegPath;
  console.log('Using bundled FFmpeg with WASAPI support:', ffmpegPath);
} else {
  // Fallback to ffmpeg-static (no WASAPI support)
  try {
    const ffmpegStaticPath = require('ffmpeg-static');

    if (app.isPackaged && ffmpegStaticPath.includes('app.asar')) {
      ffmpegPath = ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
    } else {
      ffmpegPath = ffmpegStaticPath;
    }
    console.log('Using ffmpeg-static (no WASAPI support):', ffmpegPath);
    console.warn('WARNING: ffmpeg-static does not support WASAPI. Wireless headsets may not work.');
  } catch (error) {
    console.error('Error loading ffmpeg-static:', error);
    throw error;
  }
}

// ============================================================================
// STATE MACHINE - ensures only ONE recording at a time
// ============================================================================
// States: 'idle' | 'starting' | 'recording' | 'stopping'
let recordingState = 'idle';
let ffmpegProcess = null;
let currentFilePath = null;

// Store the current audio backend for the session
let currentAudioBackend = 'dshow';  // Default to DirectShow

/**
 * Get current recording state (for debugging/UI)
 * @returns {string} Current state
 */
function getState() {
  return recordingState;
}

/**
 * List all Windows audio input devices using both WASAPI and DirectShow
 * WASAPI is preferred as it supports wireless headsets and modern USB devices
 * @returns {Promise<Array<{id: string, name: string, backend: string}>>} Array of devices
 */
async function listAudioDevices() {
  // Try WASAPI first (supports wireless headsets, modern USB devices)
  const wasapiDevices = await listDevicesWithBackend('wasapi');

  // If WASAPI found devices, use those
  if (wasapiDevices.length > 0) {
    console.log('Using WASAPI devices');
    return wasapiDevices;
  }

  // Fallback to DirectShow
  console.log('WASAPI found no devices, falling back to DirectShow');
  return listDevicesWithBackend('dshow');
}

/**
 * List devices using a specific backend (wasapi or dshow)
 */
function listDevicesWithBackend(backend) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-list_devices', 'true',
      '-f', backend,
      '-i', 'dummy'
    ]);

    let output = '';

    ffmpeg.stderr.on('data', (data) => {
      output += data.toString();
    });

    ffmpeg.on('close', () => {
      console.log('FFmpeg device list raw output:');
      console.log(output);

      const audioDevices = [];
      const lines = output.split(/\r?\n/);  // Handle both \n and \r\n

      // FFmpeg Windows output format:
      // [dshow @ 0000...] "Device Name" (video)
      // [dshow @ 0000...] "Device Name" (audio)
      // OR
      // [dshow @ 0000...] DirectShow video devices:
      // [dshow @ 0000...]  "Camera Name"
      // [dshow @ 0000...] DirectShow audio devices:
      // [dshow @ 0000...]  "Microphone Name"

      let inAudioSection = false;
      let inVideoSection = false;

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        // Check for section headers
        if (lowerLine.includes('video devices') || lowerLine.includes('video device')) {
          inVideoSection = true;
          inAudioSection = false;
          continue;
        }
        if (lowerLine.includes('audio devices') || lowerLine.includes('audio device')) {
          inAudioSection = true;
          inVideoSection = false;
          continue;
        }

        // Extract device name - look for quoted strings
        const match = line.match(/"([^"]+)"/);
        if (match) {
          const deviceName = match[1];

          // Skip "Alternative name" entries and @device entries
          if (line.includes('Alternative name') || deviceName.startsWith('@device')) {
            continue;
          }

          // Method 1: Line ends with (audio) or (video)
          if (lowerLine.includes('(audio)')) {
            audioDevices.push({ id: deviceName, name: deviceName, backend });
            console.log(`Found audio device (${backend}, by tag):`, deviceName);
            continue;
          }
          if (lowerLine.includes('(video)')) {
            continue;  // Skip video devices
          }

          // Method 2: We're in the audio section
          if (inAudioSection && !inVideoSection) {
            audioDevices.push({ id: deviceName, name: deviceName, backend });
            console.log(`Found audio device (${backend}, by section):`, deviceName);
          }
        }
      }

      // Remove duplicates
      const uniqueDevices = audioDevices.filter((device, index, self) =>
        index === self.findIndex(d => d.name === device.name)
      );

      console.log(`Final ${backend} audio devices list:`, uniqueDevices);
      resolve(uniqueDevices);
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg device listing error:', err);
      reject(err);
    });
  });
}

/**
 * Clean up old recording files (only when state is idle!)
 * @param {string} tempDir - Directory to clean
 */
function cleanupOldRecordings(tempDir) {
  // SAFETY: Only cleanup when not recording
  if (recordingState !== 'idle') {
    console.warn('cleanupOldRecordings skipped - recording in progress, state:', recordingState);
    return;
  }

  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith('recording-') && (file.endsWith('.webm') || file.endsWith('.wav'))) {
        const filePath = path.join(tempDir, file);
        try {
          fs.unlinkSync(filePath);
          console.log('Cleaned up old recording:', filePath);
        } catch (e) {
          console.warn('Could not delete file (may be in use):', filePath, e.message);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up old recordings:', error);
  }
}

/**
 * Start audio recording using FFmpeg with WASAPI (preferred) or DirectShow fallback
 *
 * IMPORTANT: This function will REJECT if a recording is already in progress.
 * The caller must call stopRecording() first and wait for it to complete.
 *
 * @param {boolean} deleteAudio - Whether to delete old recordings first
 * @param {string} deviceName - Windows audio device name (optional)
 * @returns {Promise<string>} Path to the output WAV file
 */
function startRecording(deleteAudio = false, deviceName = null) {
  return new Promise(async (resolve, reject) => {
    // ========================================================================
    // STATE GUARD - Only start if idle
    // ========================================================================
    if (recordingState !== 'idle') {
      console.warn('startRecording BLOCKED - state is:', recordingState);
      reject(new Error(`Aufnahme nicht möglich - Status: ${recordingState}. Bitte warten Sie bis die aktuelle Aufnahme beendet ist.`));
      return;
    }

    try {
      // Transition to 'starting' state
      recordingState = 'starting';
      console.log('[Recorder] idle -> starting');

      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'dentdoc');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Clean up previous recordings if requested (safe because state is 'starting')
      if (deleteAudio) {
        // Temporarily set to idle for cleanup, then back to starting
        const prevState = recordingState;
        recordingState = 'idle';
        cleanupOldRecordings(tempDir);
        recordingState = prevState;
      }

      // Generate unique filename - directly as WAV!
      const timestamp = Date.now();
      currentFilePath = path.join(tempDir, `recording-${timestamp}.wav`);

      // Get device and backend info
      const devices = await listAudioDevices();
      if (devices.length === 0) {
        recordingState = 'idle';
        throw new Error('Kein Mikrofon gefunden. Bitte schließen Sie ein Mikrofon an.');
      }

      let audioDevice;
      let backend;

      // Try to find matching device if deviceName was provided
      const matchedDevice = deviceName
        ? devices.find(d => d.name === deviceName || d.id === deviceName)
        : null;

      if (matchedDevice) {
        audioDevice = matchedDevice.name;
        backend = matchedDevice.backend;
        console.log('Using matched audio device:', audioDevice, 'backend:', backend);
      } else {
        // Use first available device (default)
        audioDevice = devices[0].name;
        backend = devices[0].backend;
        console.log('Using default audio device:', audioDevice, 'backend:', backend);
      }

      currentAudioBackend = backend;

      // Build FFmpeg arguments as array (avoids cmd.exe quote escaping issues)
      // Audio filters: highpass removes rumble (chair, footsteps), alimiter prevents clipping
      const ffmpegArgs = [
        '-f', backend,
        '-i', `audio=${audioDevice}`,
        '-ar', '16000',
        '-ac', '1',
        '-af', 'highpass=f=90,alimiter=limit=0.97',
        '-acodec', 'pcm_s16le',
        '-y',
        currentFilePath
      ];

      console.log('Starting FFmpeg recording:', ffmpegPath, ffmpegArgs.join(' '));
      console.log('Audio backend:', backend);

      // Spawn FFmpeg directly (not via cmd.exe to avoid quote issues)
      ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

      let started = false;
      let startTimeout = null;

      // ======================================================================
      // EVENT: FFmpeg successfully spawned
      // ======================================================================
      ffmpegProcess.once('spawn', () => {
        console.log('FFmpeg process spawned');
      });

      // ======================================================================
      // EVENT: FFmpeg stderr output (progress info)
      // ======================================================================
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('FFmpeg output:', output.trim());

        // FFmpeg outputs progress info to stderr
        if (output.includes('size=') || output.includes('time=')) {
          if (!started) {
            started = true;
            if (startTimeout) clearTimeout(startTimeout);

            // Transition to 'recording' state
            recordingState = 'recording';
            console.log('[Recorder] starting -> recording');
            console.log('[Recorder] Recording started:', currentFilePath);

            // Audio level monitoring is handled by Dashboard via getUserMedia + WebAudio API
            // Dashboard sends levels to main process via IPC, which forwards to status overlay

            resolve(currentFilePath);
          }
        }

        // Log errors explicitly
        if (output.includes('Error') || output.includes('error') || output.includes('Could not')) {
          console.error('FFmpeg error:', output);
        }
      });

      // ======================================================================
      // EVENT: FFmpeg process error
      // ======================================================================
      ffmpegProcess.on('error', (err) => {
        console.error('FFmpeg process error:', err);
        if (startTimeout) clearTimeout(startTimeout);
        ffmpegProcess = null;
        recordingState = 'idle';
        console.log('[Recorder] -> idle (error)');

        if (!started) {
          reject(new Error(`Aufnahme konnte nicht gestartet werden: ${err.message}`));
        }
      });

      // ======================================================================
      // EVENT: FFmpeg process closed
      // ======================================================================
      ffmpegProcess.once('close', (code) => {
        console.log('FFmpeg process closed with code:', code);
        if (startTimeout) clearTimeout(startTimeout);
        ffmpegProcess = null;

        // Only transition to idle if we're not already idle
        // (stopRecording handles its own state transition)
        if (recordingState !== 'idle') {
          recordingState = 'idle';
          console.log('[Recorder] -> idle (process closed)');
        }
      });

      // ======================================================================
      // TIMEOUT: Fallback if FFmpeg doesn't report progress
      // ======================================================================
      startTimeout = setTimeout(() => {
        // Also abort if stopRecording() was called during startup
        if (recordingState === 'stopping' || recordingState === 'idle') {
          console.log('[Recorder] startTimeout aborted - state changed to:', recordingState);
          return;
        }
        if (!started && ffmpegProcess && recordingState === 'starting') {
          console.warn('[Recorder] FFmpeg produced no progress output, using timeout fallback');
          started = true;
          recordingState = 'recording';
          console.log('[Recorder] starting -> recording (timeout)');
          // Audio level monitoring handled by Dashboard
          resolve(currentFilePath);
        }
      }, 2000);

    } catch (error) {
      console.error('Start recording error:', error);
      recordingState = 'idle';
      console.log('[Recorder] -> idle (catch)');
      reject(error);
    }
  });
}

/**
 * Stop the current recording
 *
 * IMPORTANT: This is the ONLY place where FFmpeg should be stopped.
 * Uses graceful shutdown: 'q' -> SIGTERM -> SIGKILL
 *
 * @returns {Promise<string>} Path to the recorded WAV file
 */
function stopRecording() {
  return new Promise((resolve, reject) => {
    // ========================================================================
    // STATE GUARD - Only stop if recording
    // ========================================================================
    if (recordingState !== 'recording') {
      console.warn('stopRecording IGNORED - state is:', recordingState);

      // Special case: If there's a file from a previous recording, return it
      if (currentFilePath && fs.existsSync(currentFilePath)) {
        console.log('Returning existing file:', currentFilePath);
        resolve(currentFilePath);
        return;
      }

      reject(new Error(`Keine aktive Aufnahme (Status: ${recordingState})`));
      return;
    }

    // Transition to 'stopping' state
    recordingState = 'stopping';
    console.log('[Recorder] recording -> stopping');

    const filePath = currentFilePath;
    const process = ffmpegProcess;
    let timeoutId = null;
    let secondTimeoutId = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (secondTimeoutId) clearTimeout(secondTimeoutId);
    };

    const resolveOnce = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Note: state transition to 'idle' happens in 'close' event
      resolve(result);
    };

    const rejectOnce = (error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      recordingState = 'idle';
      console.log('[Recorder] stopping -> idle (reject)');
      reject(error);
    };

    // ========================================================================
    // STEP 1: Send 'q' to FFmpeg (graceful stop)
    // ========================================================================
    try {
      console.log('Sending quit signal to FFmpeg...');
      process.stdin.write('q');
    } catch (e) {
      console.warn('Could not send quit signal to FFmpeg:', e.message);
    }

    // ========================================================================
    // STEP 2: After 3 seconds, send SIGTERM
    // ========================================================================
    timeoutId = setTimeout(() => {
      if (process && !resolved) {
        console.log('FFmpeg not responding to quit, sending SIGTERM');
        try {
          process.kill('SIGTERM');
        } catch (e) {
          console.warn('Could not send SIGTERM:', e.message);
        }

        // ==================================================================
        // STEP 3: After 2 more seconds, send SIGKILL
        // ==================================================================
        secondTimeoutId = setTimeout(() => {
          if (process && !resolved) {
            console.log('FFmpeg still running, force killing');
            try {
              process.kill('SIGKILL');
            } catch (e) {
              console.warn('Could not send SIGKILL:', e.message);
            }

            // Force resolve with file if it exists
            recordingState = 'idle';
            console.log('[Recorder] stopping -> idle (force kill)');

            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
              resolveOnce(filePath);
            } else {
              rejectOnce(new Error('Aufnahme fehlgeschlagen'));
            }
          }
        }, 2000);
      }
    }, 3000);

    // ========================================================================
    // EVENT: FFmpeg process closed
    // ========================================================================
    process.once('close', () => {
      console.log('FFmpeg process closed during stop');
      ffmpegProcess = null;
      recordingState = 'idle';
      console.log('[Recorder] stopping -> idle (close)');

      // Verify the file exists and has content
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        console.log('[Recorder] Recording saved:', filePath, 'Size:', stats.size, 'bytes');

        if (stats.size > 0) {
          resolveOnce(filePath);
        } else {
          rejectOnce(new Error('Aufnahme ist leer - bitte Mikrofon überprüfen'));
        }
      } else {
        rejectOnce(new Error('Aufnahme-Datei nicht gefunden'));
      }
    });
  });
}

/**
 * Force stop any running recording (emergency use only!)
 *
 * WARNING: This bypasses the normal state machine and should ONLY be used
 * when stopRecording() fails or hangs. Normal code should NEVER call this.
 *
 * Use cases:
 * - stopRecording() threw an error
 * - stopRecording() is stuck (timeout)
 * - App is shutting down and needs to cleanup
 *
 * @returns {Promise<void>}
 * @internal
 */
async function forceStop() {
  console.warn('[Recorder] FORCE STOP called - emergency cleanup');

  if (ffmpegProcess) {
    try {
      ffmpegProcess.stdin.write('q');
    } catch (e) {}

    try {
      ffmpegProcess.kill('SIGTERM');
    } catch (e) {}

    // Wait for process to close
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (ffmpegProcess) {
          try {
            ffmpegProcess.kill('SIGKILL');
          } catch (e) {}
        }
        resolve();
      }, 1000);

      if (ffmpegProcess) {
        ffmpegProcess.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    ffmpegProcess = null;
  }

  recordingState = 'idle';
  console.log('[Recorder] FORCE STOP complete, state: idle');
}

/**
 * Check if currently recording
 * @returns {boolean}
 */
function isRecording() {
  return recordingState === 'recording';
}

module.exports = {
  listAudioDevices,
  startRecording,
  stopRecording,
  forceStop,
  isRecording,
  getState
};
