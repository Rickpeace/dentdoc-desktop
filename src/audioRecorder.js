const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let recorderWindow = null;
let currentFilePath = null;

function createRecorderWindow() {
  if (recorderWindow) return recorderWindow;

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

function startRecording() {
  return new Promise((resolve, reject) => {
    try {
      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'dentdoc');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      currentFilePath = path.join(tempDir, `recording-${timestamp}.webm`);

      const win = createRecorderWindow();

      // Wait for window to be ready, then start recording
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('start-recording');
      });

      // If already loaded
      if (!win.webContents.isLoading()) {
        win.webContents.send('start-recording');
      }

      console.log('Recording started:', currentFilePath);
      resolve(currentFilePath);
    } catch (error) {
      reject(error);
    }
  });
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recorderWindow) {
      reject(new Error('No active recording'));
      return;
    }

    // Listen for the audio data
    ipcMain.once('recording-data', (event, buffer) => {
      try {
        fs.writeFileSync(currentFilePath, Buffer.from(buffer));
        console.log('Recording saved:', currentFilePath);
        resolve(currentFilePath);
      } catch (error) {
        reject(error);
      }
    });

    ipcMain.once('recording-error', (event, error) => {
      reject(new Error(error));
    });

    recorderWindow.webContents.send('stop-recording');
  });
}

module.exports = {
  startRecording,
  stopRecording
};
