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
// States: 'idle' | 'starting' | 'recording' | 'stopping' | 'paused'
let recordingState = 'idle';
let ffmpegProcess = null;
let currentFilePath = null;

// Segment tracking for pause/resume functionality
let recordingSegments = [];  // Array of segment file paths
let segmentCounter = 0;      // Counter for unique segment names
let currentDeviceName = null; // Store device name for resuming

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
 * Warm up microphone before recording
 * Some USB/Bluetooth devices (like Jabra Speak) start in muted state
 * and need to be "woken up" by briefly opening the audio stream
 * @param {string} deviceName - Device name to warm up
 * @param {number} durationMs - Duration to keep mic open (default 400ms)
 * @returns {Promise<void>}
 */
async function warmupMicrophone(deviceName, durationMs = 400) {
  return new Promise((resolve) => {
    const ffmpegPathLocal = getFFmpegPath();

    // Use WASAPI for warmup (most compatible)
    const args = [
      '-f', 'wasapi',
      '-i', 'default',
      '-t', (durationMs / 1000).toString(),
      '-f', 'null',
      '-'
    ];

    console.log(`[Recorder] Warming up microphone for ${durationMs}ms...`);

    const warmupProcess = spawn(ffmpegPathLocal, args);

    warmupProcess.on('close', () => {
      console.log('[Recorder] Microphone warmup complete');
      resolve();
    });

    warmupProcess.on('error', (err) => {
      console.warn('[Recorder] Microphone warmup error (non-fatal):', err.message);
      resolve(); // Continue anyway
    });

    // Safety timeout in case FFmpeg hangs
    setTimeout(() => {
      try {
        warmupProcess.kill('SIGTERM');
      } catch (e) {}
      resolve();
    }, durationMs + 500);
  });
}

/**
 * Read and log WAV header info from a file (for support diagnostics)
 * @param {string} wavPath - Path to WAV file
 */
function logWavHeader(wavPath) {
  try {
    const fd = fs.openSync(wavPath, 'r');
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);

    const riff = header.toString('ascii', 0, 4);
    const wave = header.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      console.log('[Recorder] WAV header: not a valid WAV file');
      return;
    }

    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const fileSize = fs.statSync(wavPath).size;
    const dataBytes = fileSize - 44; // approximate

    console.log(`[Recorder] WAV header: sampleRate=${sampleRate}, channels=${channels}, bitsPerSample=${bitsPerSample}, dataBytes=${dataBytes}, fileSize=${(fileSize / 1024 / 1024).toFixed(2)}MB`);

    if (sampleRate !== 16000) {
      console.warn(`[Recorder] WARNING: Expected 16kHz but got ${sampleRate}Hz - downsample fallback may be needed`);
    }
  } catch (err) {
    console.warn('[Recorder] Could not read WAV header:', err.message);
  }
}

/**
 * Downsample WAV file to 16kHz for VAD/transcription
 * NOTE: Recording now uses 16kHz directly (-ar 16000), so this is only needed as fallback
 * @param {string} inputPath - Path to WAV file
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
      '-ar', '16000',
      '-af', 'highpass=f=90,alimiter=limit=0.97',
      '-acodec', 'pcm_s16le',
      '-y',
      outputPath
    ] : [
      '-f', 'dshow',
      '-i', `audio=${device}`,
      '-ac', '1',
      '-ar', '16000',
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
 * Records at 16kHz mono PCM (pcm_s16le) - ready for VAD/transcription without downsampling
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

      // Reset segment tracking for new recording session
      recordingSegments = [];
      segmentCounter = 0;

      // Store device name for pause/resume functionality
      currentDeviceName = deviceName;

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

      // Set transitional state to detect if forceStop is called during async startup
      recordingState = 'starting';

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
      // MICROPHONE WARMUP - Wake up USB/Bluetooth devices that start muted
      // ========================================================================
      // Some devices (like Jabra Speak) start in muted state and need to be
      // "woken up" by briefly opening the audio stream before actual recording
      await warmupMicrophone(deviceName, 400);

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

        // Check if any microphones are available at all
        const availableDevices = await listAudioDevices();

        let specificError;
        if (availableDevices.length === 0) {
          // No microphones found on system
          specificError = 'Kein Mikrofon gefunden';
        } else if (deviceName) {
          // A specific mic was selected but couldn't be used
          specificError = 'Mikrofon nicht verbunden';
        } else {
          // Generic fallback
          specificError = 'Mikrofon nicht verfügbar';
        }

        throw new Error(specificError);
      }

      // Recording started successfully
      // But first check if we were cancelled during async startup (forceStop was called)
      // forceStop sets state to 'stopping' or 'idle', so if we're not still in 'starting', abort
      if (recordingState !== 'starting' || !currentFilePath) {
        console.log('[Recorder] Startup completed but was cancelled (state:', recordingState, ') - not setting recording state');
        if (result.process) {
          try { result.process.kill('SIGTERM'); } catch (e) {}
        }
        // IMPORTANT: Use resolve() not return! We're inside Promise executor.
        // "return null" doesn't resolve the promise - it just returns from the async function.
        resolve(null);  // Signal that recording didn't actually start
        return;
      }

      ffmpegProcess = result.process;
      recordingState = 'recording';
      console.log('[Recorder] Recording started:', currentFilePath);

      // Capture stderr for crash diagnostics
      let stderrOutput = '';
      if (ffmpegProcess.stderr) {
        ffmpegProcess.stderr.on('data', (data) => {
          stderrOutput += data.toString();
          // Keep only last 2KB to avoid memory issues
          if (stderrOutput.length > 2048) {
            stderrOutput = stderrOutput.slice(-2048);
          }
        });
      }

      // Setup close handler for cleanup AND crash detection
      ffmpegProcess.once('close', (code, signal) => {
        const wasRecording = recordingState === 'recording';
        ffmpegProcess = null;

        if (wasRecording) {
          // FFmpeg exited while we thought we were still recording!
          console.error('[Recorder] ⚠️ FFmpeg CRASHED during recording!');
          console.error('[Recorder] Exit code:', code, '| Signal:', signal);
          console.error('[Recorder] File path:', currentFilePath);
          console.error('[Recorder] Last stderr:', stderrOutput.slice(-500));

          // Check if file was created and has content
          try {
            if (fs.existsSync(currentFilePath)) {
              const stats = fs.statSync(currentFilePath);
              console.error('[Recorder] File exists, size:', stats.size, 'bytes');
            } else {
              console.error('[Recorder] File does NOT exist!');
            }
          } catch (e) {
            console.error('[Recorder] Could not check file:', e.message);
          }
        }

        // Only reset to idle if we crashed during active recording
        // Don't reset if we're in 'stopping' or 'paused' - those states are managed elsewhere
        if (recordingState === 'recording') {
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
  return new Promise(async (resolve, reject) => {
    // ========================================================================
    // STATE GUARD - Only stop if recording OR paused
    // ========================================================================
    if (recordingState !== 'recording' && recordingState !== 'paused') {
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

    const wasPaused = recordingState === 'paused';

    // Transition to 'stopping' state
    recordingState = 'stopping';
    console.log('[Recorder] Stopping recording... (was paused:', wasPaused, ')');

    const filePath = currentFilePath;
    const process = ffmpegProcess;

    // ========================================================================
    // CASE 1: Was paused - no FFmpeg to stop, just concatenate segments
    // ========================================================================
    if (wasPaused || !process) {
      recordingState = 'idle';

      // If we have segments, concatenate them
      if (recordingSegments.length > 0) {
        try {
          const tempDir = path.join(app.getPath('temp'), 'dentdoc');
          const finalPath = path.join(tempDir, `recording-${Date.now()}-final.wav`);
          const result = await concatenateSegments(recordingSegments, finalPath);
          recordingSegments = [];
          resolve(result);
        } catch (err) {
          reject(err);
        }
        return;
      }

      // No segments and was paused - nothing to return
      reject(new Error('Keine Aufnahme vorhanden'));
      return;
    }

    // ========================================================================
    // CASE 2: Was recording - stop FFmpeg, then concatenate
    // ========================================================================
    let timeoutId = null;
    let secondTimeoutId = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (secondTimeoutId) clearTimeout(secondTimeoutId);
    };

    const finalizeRecording = async (lastSegmentPath) => {
      if (resolved) return;
      resolved = true;
      cleanup();

      // Add the last segment to the list
      if (lastSegmentPath && fs.existsSync(lastSegmentPath) && fs.statSync(lastSegmentPath).size > 0) {
        recordingSegments.push(lastSegmentPath);
      }

      // If we have multiple segments, concatenate them
      if (recordingSegments.length > 1) {
        try {
          const tempDir = path.join(app.getPath('temp'), 'dentdoc');
          const finalPath = path.join(tempDir, `recording-${Date.now()}-final.wav`);
          const result = await concatenateSegments(recordingSegments, finalPath);
          recordingSegments = [];
          recordingState = 'idle';
          resolve(result);
        } catch (err) {
          recordingState = 'idle';
          reject(err);
        }
      } else if (recordingSegments.length === 1) {
        // Only one segment - use it directly
        recordingState = 'idle';
        resolve(recordingSegments[0]);
        recordingSegments = [];
      } else if (lastSegmentPath) {
        // No segments but have a file
        recordingState = 'idle';
        resolve(lastSegmentPath);
      } else {
        recordingState = 'idle';
        reject(new Error('Aufnahme-Datei nicht gefunden'));
      }
    };

    const rejectOnce = (error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      recordingState = 'idle';
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

            // Force finalize with file if it exists
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
              finalizeRecording(filePath);
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

      // Verify the file exists and has content
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`[Recorder] Last segment saved: ${sizeMB} MB`);
        logWavHeader(filePath);

        if (stats.size > 0) {
          finalizeRecording(filePath);
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
  console.log('[Recorder] FORCE STOP called - cancelling recording');

  // If already idle, nothing to do
  if (recordingState === 'idle') {
    console.log('[Recorder] Force stop called but already idle');
    return;
  }

  // Set state BEFORE killing so close handler knows it's intentional (not a crash)
  // This also signals to any in-progress startRecording that it should abort
  recordingState = 'stopping';

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

  // Clean up segment files (recording was cancelled, not stopped normally)
  const filesToDelete = [...recordingSegments];

  // Also add currentFilePath if it's not already in segments (active recording when cancelled)
  if (currentFilePath && !filesToDelete.includes(currentFilePath)) {
    filesToDelete.push(currentFilePath);
  }

  if (filesToDelete.length > 0) {
    console.log('[Recorder] Cleaning up', filesToDelete.length, 'segment files...');
    for (const segmentPath of filesToDelete) {
      try {
        if (fs.existsSync(segmentPath)) {
          fs.unlinkSync(segmentPath);
          console.log('[Recorder] Deleted segment:', segmentPath);
        }
      } catch (e) {
        console.warn('[Recorder] Failed to delete segment:', segmentPath, e.message);
      }
    }
  }

  recordingSegments = [];
  segmentCounter = 0;
  currentFilePath = null;

  recordingState = 'idle';
  console.log('[Recorder] Force stop complete - state reset to idle');
}

/**
 * Check if currently recording
 * @returns {boolean}
 */
function isRecording() {
  return recordingState === 'recording';
}

/**
 * Check if currently paused
 * @returns {boolean}
 */
function isPaused() {
  return recordingState === 'paused';
}

/**
 * Pause the current recording
 * Stops FFmpeg and saves the current segment. Call resumeRecording() to continue.
 * @returns {Promise<void>}
 */
async function pauseRecording() {
  if (recordingState !== 'recording') {
    console.warn('[Recorder] pauseRecording IGNORED - state is:', recordingState);
    return;
  }

  console.log('[Recorder] Pausing recording...');

  // Save reference to current segment before stopping
  const segmentPath = currentFilePath;

  // Stop FFmpeg gracefully (similar to stopRecording but without concatenation)
  const process = ffmpegProcess;

  if (process) {
    // Set state to stopping temporarily
    recordingState = 'stopping';

    // Send quit command to FFmpeg
    try {
      process.stdin.write('q');
    } catch (e) {
      // stdin might be closed, try kill directly
    }

    // Wait for process to close with timeout
    await new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        ffmpegProcess = null;
        resolve();
      };

      process.once('close', done);

      // Timeout: force kill if not closed after 1 second
      setTimeout(() => {
        if (!resolved) {
          console.log('[Recorder] FFmpeg not responding to quit, force killing...');
          try { process.kill('SIGKILL'); } catch (e) {}
          // Give it a moment to actually die
          setTimeout(done, 200);
        }
      }, 1000);
    });

    console.log('[Recorder] FFmpeg process terminated');

    // Small delay for Windows to release the audio device
    await new Promise(r => setTimeout(r, 150));
  }

  // Check if we were cancelled during async operations (forceStop called)
  if (recordingState === 'idle') {
    console.log('[Recorder] pauseRecording aborted - recording was cancelled');
    return;
  }

  // Add segment to list if file exists and has content
  if (segmentPath && fs.existsSync(segmentPath)) {
    const stats = fs.statSync(segmentPath);
    if (stats.size > 0) {
      recordingSegments.push(segmentPath);
      console.log('[Recorder] Segment saved:', segmentPath, '| Total segments:', recordingSegments.length);
    }
  }

  recordingState = 'paused';
  console.log('[Recorder] Recording paused');
}

/**
 * Resume a paused recording
 * Starts a new FFmpeg process for the next segment
 * @returns {Promise<string>} Path to the new segment file
 */
async function resumeRecording() {
  if (recordingState !== 'paused') {
    console.warn('[Recorder] resumeRecording IGNORED - state is:', recordingState);
    throw new Error('Keine pausierte Aufnahme');
  }

  console.log('[Recorder] Resuming recording...');

  // Generate new segment filename
  segmentCounter++;
  const tempDir = path.join(app.getPath('temp'), 'dentdoc');
  const timestamp = Date.now();
  currentFilePath = path.join(tempDir, `recording-${timestamp}-seg${segmentCounter}.wav`);

  // Start new FFmpeg process using the stored device name
  recordingState = 'starting';

  try {
    // Small delay for device to become available (no warmup needed - mic was just active)
    await new Promise(r => setTimeout(r, 100));

    // Check if we were cancelled during the delay
    if (recordingState === 'idle') {
      console.log('[Recorder] resumeRecording aborted - recording was cancelled');
      throw new Error('Aufnahme wurde abgebrochen');
    }

    // Try to start recording with the same device
    let result;

    // Clean device name (same logic as startRecording)
    let cleanDeviceName = currentDeviceName ? currentDeviceName.replace(/^Default - /i, '') : null;
    if (cleanDeviceName) {
      cleanDeviceName = cleanDeviceName.replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
    }

    if (!cleanDeviceName) {
      result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);
    } else {
      const micType = detectMicType(currentDeviceName);
      if (micType === 'laptop' || micType === 'unknown') {
        // Try WASAPI first, then DirectShow as fallback (same as startRecording)
        result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);
        if (!result.success && cleanDeviceName) {
          console.log('[Recorder] Resume fallback: DirectShow with explicit name');
          result = await tryRecordWithBackend('dshow', cleanDeviceName, currentFilePath);
        }
      } else {
        result = await tryRecordWithBackend('dshow', cleanDeviceName, currentFilePath);
        if (!result.success) {
          result = await tryRecordWithBackend('wasapi', 'default', currentFilePath);
        }
      }
    }

    if (!result || !result.success) {
      recordingState = 'paused';
      throw new Error('Mikrofon nicht verfügbar');
    }

    ffmpegProcess = result.process;
    recordingState = 'recording';

    // Setup error handling
    ffmpegProcess.once('close', (code, signal) => {
      if (recordingState === 'recording') {
        console.error('[Recorder] FFmpeg closed unexpectedly during resumed recording');
      }
      ffmpegProcess = null;
      if (recordingState !== 'idle' && recordingState !== 'paused' && recordingState !== 'stopping') {
        recordingState = 'idle';
      }
    });

    console.log('[Recorder] Recording resumed, new segment:', currentFilePath);
    return currentFilePath;

  } catch (error) {
    console.error('[Recorder] Resume failed:', error);
    recordingState = 'paused';
    throw error;
  }
}

/**
 * Concatenate multiple audio segments into a single file
 * @param {string[]} segments - Array of segment file paths
 * @param {string} outputPath - Path for the final merged file
 * @returns {Promise<string>} Path to the merged file
 */
async function concatenateSegments(segments, outputPath) {
  if (segments.length === 0) {
    throw new Error('No segments to concatenate');
  }

  if (segments.length === 1) {
    // Only one segment - just rename it
    const stats = fs.statSync(segments[0]);
    console.log('[Concat] Single segment, renaming:', path.basename(segments[0]), '|', (stats.size / 1024 / 1024).toFixed(2), 'MB');
    fs.renameSync(segments[0], outputPath);
    return outputPath;
  }

  // Log details about each segment
  console.log('[Concat] ========== CONCATENATING', segments.length, 'SEGMENTS ==========');
  let totalSize = 0;
  for (let i = 0; i < segments.length; i++) {
    try {
      const stats = fs.statSync(segments[i]);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      totalSize += stats.size;
      console.log(`[Concat] Segment ${i + 1}: ${path.basename(segments[i])} | ${sizeMB} MB`);
    } catch (e) {
      console.error(`[Concat] Segment ${i + 1}: ${segments[i]} - FILE NOT FOUND!`);
    }
  }
  console.log(`[Concat] Total input size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

  // Create a concat list file for FFmpeg
  const tempDir = path.dirname(outputPath);
  const listFile = path.join(tempDir, `concat-${Date.now()}.txt`);

  // Write the file list (FFmpeg concat demuxer format)
  const listContent = segments.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFile, listContent);

  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y',
      outputPath
    ];

    const proc = spawn(getFFmpegPath(), args);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Clean up list file
      try { fs.unlinkSync(listFile); } catch (e) {}

      if (code === 0 && fs.existsSync(outputPath)) {
        // Clean up segment files
        for (const seg of segments) {
          try { fs.unlinkSync(seg); } catch (e) {}
        }

        const stats = fs.statSync(outputPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`[Concat] ✓ SUCCESS: ${path.basename(outputPath)} | ${sizeMB} MB`);
        console.log('[Concat] ===========================================');
        resolve(outputPath);
      } else {
        console.error('[Concat] ✗ FAILED! Exit code:', code);
        console.error('[Concat] FFmpeg stderr:', stderr.slice(-500));
        reject(new Error('Zusammenfügen der Aufnahme fehlgeschlagen'));
      }
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(listFile); } catch (e) {}
      reject(err);
    });
  });
}

/**
 * Get current segments count
 * @returns {number}
 */
function getSegmentsCount() {
  return recordingSegments.length;
}

/**
 * Reset segment tracking (called at start of new recording)
 */
function resetSegments() {
  recordingSegments = [];
  segmentCounter = 0;
}

module.exports = {
  listAudioDevices,
  startRecording,
  stopRecording,
  forceStop,
  isRecording,
  isPaused,
  pauseRecording,
  resumeRecording,
  getState,
  getFFmpegPath,
  downsampleTo16k,
  logWavHeader,
  detectMicType,
  concatenateSegments,
  getSegmentsCount,
  resetSegments
};
