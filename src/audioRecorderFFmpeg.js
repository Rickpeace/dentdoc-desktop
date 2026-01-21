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
// Initialized lazily to avoid app.isPackaged being undefined during module load
let ffmpegPath = null;

function getFFmpegPath() {
  if (ffmpegPath) return ffmpegPath;

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
      // ffmpeg-static doesn't support WASAPI, will use DirectShow instead
    } catch (error) {
      console.error('Error loading ffmpeg-static:', error);
      throw error;
    }
  }

  return ffmpegPath;
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
 * Detect microphone type based on device name
 * Used to choose optimal recording strategy (WASAPI vs DirectShow)
 * @param {string} microphoneName - Device name from settings
 * @returns {'usb' | 'laptop' | 'unknown'}
 */
function detectMicType(microphoneName) {
  const name = (microphoneName || '').toLowerCase();

  // USB/External microphones - work well with DirectShow + explicit name
  const usbKeywords = [
    'usb', 'logitech', 'blue', 'rode', 'shure', 'focusrite',
    'scarlett', 'samson', 'pro x', 'wireless', 'yeti', 'at2020'
  ];

  // Laptop/Internal microphones - need WASAPI + default device
  const laptopKeywords = [
    'microphone array', 'internal', 'realtek', 'amd audio',
    'intel', 'built-in', 'integrated', 'hd audio'
  ];

  if (usbKeywords.some(k => name.includes(k))) return 'usb';
  if (laptopKeywords.some(k => name.includes(k))) return 'laptop';
  return 'unknown';
}

/**
 * Downsample WAV file to 16kHz for VAD/transcription
 * Recording is done at 48kHz for stability, then downsampled
 * @param {string} inputPath - Path to 48kHz WAV file
 * @returns {Promise<string>} - Path to 16kHz WAV file (same path, replaced)
 */
async function downsampleTo16k(inputPath) {
  const outputPath = inputPath.replace('.wav', '_16k.wav');

  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      outputPath
    ];

    const proc = spawn(getFFmpegPath(), args);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(inputPath);
          fs.renameSync(outputPath, inputPath);
          console.log('[Recorder] Downsampled to 16kHz:', inputPath);
          resolve(inputPath);
        } catch (err) {
          reject(new Error(`Downsampling rename failed: ${err.message}`));
        }
      } else {
        reject(new Error(`Downsampling failed (code ${code}): ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Downsampling error: ${err.message}`));
    });
  });
}

/**
 * Try to start recording with a specific backend/device combination
 * Used for fallback system - tries one method and returns result
 * @param {string} backend - 'wasapi' or 'dshow'
 * @param {string} device - Device name or 'default'
 * @param {string} outputPath - Path for WAV output
 * @returns {Promise<{success: boolean, process?: ChildProcess, error?: string}>}
 */
function tryRecordWithBackend(backend, device, outputPath) {
  return new Promise((resolve) => {
    const args = backend === 'wasapi' ? [
      '-f', 'wasapi',
      '-thread_queue_size', '1024',
      '-i', device,
      '-ac', '1',
      '-ar', '48000',
      '-af', 'highpass=f=90,alimiter=limit=0.97',
      '-acodec', 'pcm_s16le',
      '-y',
      outputPath
    ] : [
      '-f', 'dshow',
      '-i', `audio=${device}`,
      '-ac', '1',
      '-ar', '48000',
      '-af', 'highpass=f=90,alimiter=limit=0.97',
      '-acodec', 'pcm_s16le',
      '-y',
      outputPath
    ];

    console.log(`[Recorder] Trying ${backend} with device: ${device}`);
    const proc = spawn(getFFmpegPath(), args);
    let resolved = false;
    let errorOutput = '';

    const resolveOnce = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(result);
    };

    proc.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      // FFmpeg outputs progress to stderr - look for actual recording progress
      // Resolve IMMEDIATELY when we see recording has started
      if (!resolved && (output.includes('size=') || output.includes('time='))) {
        resolveOnce({ success: true, process: proc });
      }
    });

    // Timeout: If FFmpeg doesn't start within 3 seconds, fail
    const timeout = setTimeout(() => {
      if (!resolved) {
        try { proc.kill(); } catch (e) { /* ignore */ }
        console.log(`[Recorder] ${backend} failed to start:`, errorOutput.slice(-300));
        resolveOnce({ success: false, error: errorOutput.slice(-500) });
      }
    }, 3000);

    proc.on('error', (err) => {
      resolveOnce({ success: false, error: err.message });
    });

    // If process exits before we resolve, it failed
    proc.on('close', (code) => {
      if (!resolved) {
        resolveOnce({ success: false, error: `Process exited with code ${code}` });
      }
    });
  });
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
    return wasapiDevices;
  }

  // Fallback to DirectShow
  return listDevicesWithBackend('dshow');
}

/**
 * List devices using a specific backend (wasapi or dshow)
 */
function listDevicesWithBackend(backend) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), [
      '-list_devices', 'true',
      '-f', backend,
      '-i', 'dummy'
    ]);

    let output = '';

    ffmpeg.stderr.on('data', (data) => {
      output += data.toString();
    });

    ffmpeg.on('close', () => {
      // Parse FFmpeg device list output (don't log raw output - too verbose)
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
            continue;
          }
          if (lowerLine.includes('(video)')) {
            continue;  // Skip video devices
          }

          // Method 2: We're in the audio section
          if (inAudioSection && !inVideoSection) {
            audioDevices.push({ id: deviceName, name: deviceName, backend });
          }
        }
      }

      // Remove duplicates
      const uniqueDevices = audioDevices.filter((device, index, self) =>
        index === self.findIndex(d => d.name === device.name)
      );

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
          // Old recording cleaned up
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
 * Start audio recording using FFmpeg with automatic fallback
 *
 * Recording Strategy (based on mic type detection):
 * - Laptop/Unknown mics: WASAPI + "default" first (most stable for internal mics)
 * - USB mics: DirectShow + explicit name first (works well for external mics)
 * - Automatic fallback if primary method fails
 *
 * IMPORTANT: Records at 48kHz for stability, call downsampleTo16k() after recording
 *
 * @param {boolean} deleteAudio - Whether to delete old recordings first
 * @param {string} deviceName - Windows audio device name (optional)
 * @param {string} customOutputPath - Custom output path (optional, for VAD segments)
 * @returns {Promise<string>} Path to the output WAV file
 */
function startRecording(deleteAudio = false, deviceName = null, customOutputPath = null) {
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

      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'dentdoc');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Clean up previous recordings if requested
      if (deleteAudio) {
        const prevState = recordingState;
        recordingState = 'idle';
        cleanupOldRecordings(tempDir);
        recordingState = prevState;
      }

      // Use custom output path if provided (for VAD segments), otherwise generate one
      if (customOutputPath) {
        currentFilePath = customOutputPath;
        const parentDir = path.dirname(customOutputPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
      } else {
        const timestamp = Date.now();
        currentFilePath = path.join(tempDir, `recording-${timestamp}.wav`);
      }

      // Detect mic type for optimal recording strategy
      const micType = detectMicType(deviceName);

      // IMPORTANT: microphoneName === null is NORMAL on laptops (no mic selected yet)
      // This is NOT an error - we use WASAPI default as fallback
      if (!deviceName) {
        console.log('[Recorder] microphoneName is null → using WASAPI default fallback');
      } else {
        console.log(`[Recorder] Mic type: ${micType}, name: "${deviceName}"`);
      }

      // Clean device name for FFmpeg compatibility:
      // 1. Remove WebRTC "Default - " prefix
      // 2. Remove USB Vendor/Product ID suffix like "(046d:0aba)"
      let cleanDeviceName = deviceName ? deviceName.replace(/^Default - /i, '') : null;
      if (cleanDeviceName) {
        // Remove USB ID pattern: space + (xxxx:xxxx) at end
        cleanDeviceName = cleanDeviceName.replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
      }

      let result;

      // ========================================================================
      // RECORDING STRATEGY WITH AUTOMATIC FALLBACK
      // ========================================================================

      // If no device name provided, go straight to WASAPI default (safest path)
      if (!cleanDeviceName) {
        console.log('[Recorder] Strategy: WASAPI default (no device specified)');
        result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);

        // Fallback: Try DirectShow device enumeration
        if (!result.success) {
          console.log('[Recorder] Fallback: DirectShow device enumeration');
          const devices = await listAudioDevices();
          if (devices.length > 0) {
            result = await tryRecordWithBackend('dshow', devices[0].name, currentFilePath);
          }
        }
      } else if (micType === 'laptop' || micType === 'unknown') {
        // Laptop/Unknown: Try WASAPI with "default" first (most reliable for internal mics)
        console.log('[Recorder] Strategy: WASAPI default (laptop/unknown mic)');
        result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);

        if (!result.success) {
          // Fallback 1: Try DirectShow with explicit name
          if (cleanDeviceName) {
            console.log('[Recorder] Fallback: DirectShow with explicit name');
            result = await tryRecordWithBackend('dshow', cleanDeviceName, currentFilePath);
          }

          // Fallback 2: Try to find any device via DirectShow
          if (!result.success) {
            console.log('[Recorder] Fallback: DirectShow device enumeration');
            const devices = await listAudioDevices();
            if (devices.length > 0) {
              result = await tryRecordWithBackend('dshow', devices[0].name, currentFilePath);
            }
          }
        }
      } else {
        // USB Mic: Try DirectShow with explicit name first (works well for external mics)
        if (cleanDeviceName) {
          console.log('[Recorder] Strategy: DirectShow with explicit name (USB mic)');
          result = await tryRecordWithBackend('dshow', cleanDeviceName, currentFilePath);
        }

        if (!result || !result.success) {
          // Fallback: Try WASAPI with "default"
          console.log('[Recorder] Fallback: WASAPI default');
          result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);
        }

        if (!result.success) {
          // Last resort: DirectShow device enumeration
          console.log('[Recorder] Fallback: DirectShow device enumeration');
          const devices = await listAudioDevices();
          if (devices.length > 0) {
            result = await tryRecordWithBackend('dshow', devices[0].name, currentFilePath);
          }
        }
      }

      // ========================================================================
      // CHECK RESULT
      // ========================================================================
      if (!result || !result.success) {
        recordingState = 'idle';
        const errorMsg = result?.error || 'Unknown error';
        console.error('[Recorder] All recording methods failed:', errorMsg);
        throw new Error('Aufnahme konnte nicht gestartet werden. Bitte Mikrofon in Windows-Einstellungen überprüfen.');
      }

      // Recording started successfully
      ffmpegProcess = result.process;
      recordingState = 'recording';
      console.log('[Recorder] Recording started:', currentFilePath);

      // Setup close handler for cleanup
      ffmpegProcess.once('close', () => {
        ffmpegProcess = null;
        if (recordingState !== 'idle') {
          recordingState = 'idle';
        }
      });

      resolve(currentFilePath);

    } catch (error) {
      console.error('Start recording error:', error);
      recordingState = 'idle';
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
    // Stopping recording...

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
      // Stop failed
      reject(error);
    };

    // ========================================================================
    // STEP 1: Send 'q' to FFmpeg (graceful stop)
    // ========================================================================
    try {
      process.stdin.write('q');
    } catch (e) {
      // Ignore - will fall back to SIGTERM
    }

    // ========================================================================
    // STEP 2: After 3 seconds, send SIGTERM
    // ========================================================================
    timeoutId = setTimeout(() => {
      if (process && !resolved) {
        try {
          process.kill('SIGTERM');
        } catch (e) {
          // Ignore
        }

        // ==================================================================
        // STEP 3: After 2 more seconds, send SIGKILL
        // ==================================================================
        secondTimeoutId = setTimeout(() => {
          if (process && !resolved) {
            try {
              process.kill('SIGKILL');
            } catch (e) {
              // Ignore
            }

            // Force resolve with file if it exists
            recordingState = 'idle';

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
      ffmpegProcess = null;
      recordingState = 'idle';

      // Verify the file exists and has content
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`[Recorder] Recording saved: ${sizeMB} MB`);

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
  // Force stop complete
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
  getState,
  getFFmpegPath,
  downsampleTo16k,  // Downsample 48kHz recording to 16kHz for VAD/transcription
  detectMicType     // Detect mic type (usb/laptop/unknown) for debugging
};
