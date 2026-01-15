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

let ffmpegProcess = null;
let currentFilePath = null;
let audioLevelInterval = null;

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
 * Clean up old recording files
 * @param {string} tempDir - Directory to clean
 */
function cleanupOldRecordings(tempDir) {
  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith('recording-') && (file.endsWith('.webm') || file.endsWith('.wav'))) {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
        console.log('Cleaned up old recording:', filePath);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old recordings:', error);
  }
}

// Store the current audio backend for the session
let currentAudioBackend = 'wasapi';  // Default to WASAPI (supports wireless headsets)

/**
 * Start audio recording using FFmpeg with WASAPI (preferred) or DirectShow fallback
 * @param {boolean} deleteAudio - Whether to delete old recordings first
 * @param {string} deviceName - Windows audio device name (optional)
 * @returns {Promise<string>} Path to the output WAV file
 */
function startRecording(deleteAudio = false, deviceName = null) {
  return new Promise(async (resolve, reject) => {
    try {
      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'dentdoc');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Clean up previous recordings if requested
      if (deleteAudio) {
        cleanupOldRecordings(tempDir);
      }

      // Generate unique filename - directly as WAV!
      const timestamp = Date.now();
      currentFilePath = path.join(tempDir, `recording-${timestamp}.wav`);

      // Get device and backend info
      let audioDevice;
      let backend = 'wasapi';  // Default to WASAPI (supports wireless headsets)

      if (deviceName) {
        audioDevice = deviceName;
        // Find the backend for this device
        const devices = await listAudioDevices();
        const device = devices.find(d => d.name === deviceName);
        if (device && device.backend) {
          backend = device.backend;
        }
      } else {
        // Use default audio device
        const devices = await listAudioDevices();
        if (devices.length === 0) {
          throw new Error('Kein Mikrofon gefunden. Bitte schließen Sie ein Mikrofon an.');
        }
        audioDevice = devices[0].name;
        backend = devices[0].backend || 'wasapi';
        console.log('Using default audio device:', audioDevice, 'backend:', backend);
      }

      currentAudioBackend = backend;

      // Build full command as string for Windows cmd.exe
      // Use WASAPI for wireless headsets, DirectShow as fallback
      // WASAPI: -f wasapi -i audio="Device Name"
      // DirectShow: -f dshow -i audio="Device Name"
      const fullCommand = `"${ffmpegPath}" -f ${backend} -i audio="${audioDevice}" -ar 16000 -ac 1 -acodec pcm_s16le -y "${currentFilePath}"`;

      console.log('Starting FFmpeg recording:', fullCommand);
      console.log('Audio backend:', backend);

      // Use spawn with cmd.exe /c to run the full command string
      // This properly handles Windows device names with special characters
      ffmpegProcess = spawn('cmd.exe', ['/c', fullCommand]);

      let started = false;

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();

        // FFmpeg outputs progress info to stderr
        if (output.includes('size=') || output.includes('time=')) {
          if (!started) {
            started = true;
            console.log('Recording started:', currentFilePath);
            resolve(currentFilePath);
          }

          // Parse audio level for VU meter (optional, basic implementation)
          // FFmpeg doesn't directly output levels, but we can estimate from activity
        }

        // Log errors
        if (output.includes('Error') || output.includes('error')) {
          console.error('FFmpeg error:', output);
        }
      });

      ffmpegProcess.on('error', (err) => {
        console.error('FFmpeg process error:', err);
        ffmpegProcess = null;
        if (!started) {
          reject(new Error(`Aufnahme konnte nicht gestartet werden: ${err.message}`));
        }
      });

      ffmpegProcess.on('close', (code) => {
        console.log('FFmpeg process closed with code:', code);
        ffmpegProcess = null;
        stopAudioLevelSimulation();
      });

      // Start simulated audio level updates (since FFmpeg doesn't provide real-time levels easily)
      startAudioLevelSimulation();

      // Timeout - if FFmpeg doesn't start within 5 seconds, something is wrong
      setTimeout(() => {
        if (!started && ffmpegProcess) {
          console.log('Recording assumed started (timeout fallback)');
          started = true;
          resolve(currentFilePath);
        }
      }, 2000);

    } catch (error) {
      console.error('Start recording error:', error);
      reject(error);
    }
  });
}

/**
 * Stop the current recording
 * @returns {Promise<string>} Path to the recorded WAV file
 */
function stopRecording() {
  return new Promise((resolve, reject) => {
    stopAudioLevelSimulation();

    if (!ffmpegProcess) {
      reject(new Error('Keine aktive Aufnahme'));
      return;
    }

    const filePath = currentFilePath;

    // Send 'q' to FFmpeg to stop recording gracefully
    ffmpegProcess.stdin.write('q');

    const timeout = setTimeout(() => {
      // Force kill if FFmpeg doesn't stop gracefully
      if (ffmpegProcess) {
        console.log('Force killing FFmpeg process');
        ffmpegProcess.kill('SIGKILL');
        ffmpegProcess = null;

        // Check if file exists and has content
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          resolve(filePath);
        } else {
          reject(new Error('Aufnahme fehlgeschlagen - keine Audiodaten'));
        }
      }
    }, 3000);

    ffmpegProcess.on('close', () => {
      clearTimeout(timeout);
      ffmpegProcess = null;

      // Verify the file exists and has content
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        console.log('Recording saved:', filePath, 'Size:', stats.size, 'bytes');

        if (stats.size > 0) {
          resolve(filePath);
        } else {
          reject(new Error('Aufnahme ist leer - bitte Mikrofon überprüfen'));
        }
      } else {
        reject(new Error('Aufnahme-Datei nicht gefunden'));
      }
    });
  });
}

/**
 * Start simulated audio level updates
 * Since FFmpeg doesn't easily provide real-time audio levels,
 * we simulate activity to keep the UI responsive
 */
function startAudioLevelSimulation() {
  // Send periodic audio level updates
  // In a future version, we could parse FFmpeg's output more sophisticatedly
  // or use a separate audio analysis process

  let phase = 0;
  audioLevelInterval = setInterval(() => {
    // Generate a somewhat natural-looking audio level pattern
    // This is just for visual feedback - not actual audio levels
    const baseLevel = 0.15 + Math.sin(phase) * 0.1;
    const noise = (Math.random() - 0.5) * 0.15;
    const level = Math.max(0, Math.min(1, baseLevel + noise));

    // Emit to any listeners
    if (global.statusOverlay) {
      global.statusOverlay.webContents.send('audio-level', level);
    }

    phase += 0.3;
  }, 100);
}

/**
 * Stop audio level simulation
 */
function stopAudioLevelSimulation() {
  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }
}

/**
 * Check if currently recording
 * @returns {boolean}
 */
function isRecording() {
  return ffmpegProcess !== null;
}

module.exports = {
  listAudioDevices,
  startRecording,
  stopRecording,
  isRecording
};
