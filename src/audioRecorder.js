/**
 * WebRTC-based Audio Recorder (Robust Version)
 *
 * Uses Chromium's WebRTC with WASAPI shared mode.
 * Includes fallback cascade for maximum compatibility:
 * 1. Saved device (exact)
 * 2. Saved device (preferred)
 * 3. Default device
 * 4. Any audio device
 */

const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let recorderWindow = null;
let currentFilePath = null;
let recordingStarted = false;

function createRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    return recorderWindow;
  }

  recorderWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));

  recorderWindow.on('closed', () => {
    recorderWindow = null;
  });

  return recorderWindow;
}

function cleanupOldRecordings(tempDir) {
  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      // Clean up both .webm recordings and converted _16k.wav files
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

/**
 * Start audio recording
 * @param {boolean} deleteAudio - Whether to delete old recordings first
 * @param {string} deviceId - Saved microphone device ID (optional)
 * @returns {Promise<string>} Path to the output file
 */
function startRecording(deleteAudio = false, deviceId = null) {
  return new Promise((resolve, reject) => {
    try {
      recordingStarted = false;

      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'dentdoc');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Clean up previous recordings only if deleteAudio setting is enabled
      if (deleteAudio) {
        cleanupOldRecordings(tempDir);
      }

      // Generate unique filename
      const timestamp = Date.now();
      currentFilePath = path.join(tempDir, `recording-${timestamp}.webm`);

      const win = createRecorderWindow();

      // Listen for recording started confirmation
      const startedHandler = () => {
        recordingStarted = true;
        console.log('Recording confirmed started:', currentFilePath);
      };
      ipcMain.once('recording-started', startedHandler);

      // Listen for immediate errors
      const errorHandler = (event, error) => {
        ipcMain.removeListener('recording-started', startedHandler);
        console.error('Recording failed to start:', error);
        reject(new Error(error));
      };
      ipcMain.once('recording-error', errorHandler);

      // Remove error handler after successful start (with timeout)
      setTimeout(() => {
        ipcMain.removeListener('recording-error', errorHandler);
      }, 5000);

      // Send start command with device ID
      const startCommand = () => {
        win.webContents.send('start-recording', { deviceId });
      };

      // Wait for window to be ready, then start recording
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', startCommand);
      } else {
        startCommand();
      }

      console.log('Recording initiated:', currentFilePath, 'Device:', deviceId || 'default');
      resolve(currentFilePath);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Stop the current recording
 * @returns {Promise<string>} Path to the recorded file
 */
function stopRecording() {
  return new Promise((resolve, reject) => {
    // Check if recording is actually active
    if (!recordingStarted) {
      // Recording already stopped - just return the last file path if available
      if (currentFilePath && fs.existsSync(currentFilePath)) {
        console.log('Recording already stopped, returning existing file:', currentFilePath);
        resolve(currentFilePath);
        return;
      }
      reject(new Error('Keine aktive Aufnahme'));
      return;
    }

    if (!recorderWindow || recorderWindow.isDestroyed()) {
      reject(new Error('Keine aktive Aufnahme'));
      return;
    }

    // Mark recording as stopped
    recordingStarted = false;

    // Set up timeout for safety
    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners('recording-data');
      ipcMain.removeAllListeners('recording-error');
      reject(new Error('Aufnahme-Timeout - bitte erneut versuchen'));
    }, 10000);

    // Listen for the audio data
    ipcMain.once('recording-data', (event, buffer) => {
      clearTimeout(timeout);
      try {
        fs.writeFileSync(currentFilePath, Buffer.from(buffer));
        console.log('Recording saved:', currentFilePath, 'Size:', buffer.length, 'bytes');
        resolve(currentFilePath);
      } catch (error) {
        reject(error);
      }
    });

    ipcMain.once('recording-error', (event, error) => {
      clearTimeout(timeout);
      reject(new Error(error));
    });

    recorderWindow.webContents.send('stop-recording');
  });
}

/**
 * Check if recording is active
 * @returns {boolean}
 */
function isRecording() {
  return recordingStarted && recorderWindow && !recorderWindow.isDestroyed();
}

module.exports = {
  startRecording,
  stopRecording,
  isRecording
};
