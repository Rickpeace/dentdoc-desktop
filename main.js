require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const audioRecorder = require('./src/audioRecorder');
const apiClient = require('./src/apiClient');

// Early debug logging
const DEBUG_LOG = path.join(os.tmpdir(), 'dentdoc-main-debug.log');
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, logMessage);
  } catch (e) {
    console.error('Failed to write debug log:', e);
  }
}

debugLog('=== DentDoc Starting ===');
debugLog(`App path: ${app.getAppPath()}`);
debugLog(`Is packaged: ${app.isPackaged}`);
debugLog(`Temp dir: ${os.tmpdir()}`);
debugLog(`Debug log path: ${DEBUG_LOG}`);

let speakerRecognition;
try {
  debugLog('Loading speaker-recognition module...');
  speakerRecognition = require('./src/speaker-recognition');
  debugLog('Speaker-recognition module loaded successfully');
} catch (error) {
  debugLog(`ERROR loading speaker-recognition module: ${error.message}`);
  debugLog(`Stack: ${error.stack}`);
  throw error;
}

const store = new Store();
let tray = null;
let loginWindow = null;
let settingsWindow = null;
let voiceProfilesWindow = null;
let statusOverlay = null;
let isRecording = false;
let isProcessing = false;
let isEnrolling = false;
let currentRecordingPath = null;
let currentEnrollmentPath = null;
let currentEnrollmentName = null;
let currentEnrollmentRole = null;
let currentShortcut = null;
let autoHideTimeout = null;
let lastDocumentation = null;
let lastTranscript = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Auto-launch on Windows startup
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe')
});

function openDashboard() {
  const baseUrl = apiClient.getBaseUrl().replace(/\/$/, '');
  shell.openExternal(baseUrl + '/dashboard');
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 550,
    height: 520,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: false,
    title: 'DentDoc Einstellungen'
  });

  settingsWindow.loadFile('src/settings.html');
  settingsWindow.setMenu(null);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openVoiceProfiles() {
  if (voiceProfilesWindow && !voiceProfilesWindow.isDestroyed()) {
    voiceProfilesWindow.focus();
    return;
  }

  voiceProfilesWindow = new BrowserWindow({
    width: 650,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: false,
    title: 'DentDoc Stimmprofile'
  });

  voiceProfilesWindow.loadFile('src/voice-profiles.html');
  voiceProfilesWindow.setMenu(null);

  voiceProfilesWindow.on('closed', () => {
    voiceProfilesWindow = null;
  });
}

function registerShortcut(shortcut) {
  // Unregister old shortcut
  globalShortcut.unregisterAll();

  // Register new shortcut
  const registered = globalShortcut.register(shortcut, () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  if (registered) {
    currentShortcut = shortcut;
    store.set('shortcut', shortcut);
    updateTrayMenu();
    return true;
  } else {
    console.error(`Shortcut ${shortcut} registration failed`);
    // Try to re-register old shortcut
    const oldShortcut = store.get('shortcut') || 'F9';
    if (oldShortcut !== shortcut) {
      globalShortcut.register(oldShortcut, () => {
        if (isRecording) {
          stopRecording();
        } else {
          startRecording();
        }
      });
    }
    return false;
  }
}

/**
 * Save transcript and summary to a text file
 * @param {string} folderPath - Folder to save the file
 * @param {string} summary - Documentation/summary text
 * @param {string} transcript - Full transcript text
 */
function saveTranscriptToFile(folderPath, summary, transcript) {
  // Create filename with date and time
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  const filename = `${year}-${month}-${day}_${hours}-${minutes}_Transkript.txt`;
  const filePath = path.join(folderPath, filename);

  // Ensure folder exists
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  // Create file content
  const content = `╔════════════════════════════════════════════════════════════════════╗
║                          DENTDOC TRANSKRIPT                        ║
╚════════════════════════════════════════════════════════════════════╝

Datum:    ${now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Uhrzeit:  ${now.toLocaleTimeString('de-DE')}

────────────────────────────────────────────────────────────────────
  ZUSAMMENFASSUNG
────────────────────────────────────────────────────────────────────

${summary}


────────────────────────────────────────────────────────────────────
  VOLLSTÄNDIGES TRANSKRIPT
────────────────────────────────────────────────────────────────────

${transcript}


════════════════════════════════════════════════════════════════════
  Ende des Transkripts
════════════════════════════════════════════════════════════════════
`;

  // Write file
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Transcript saved to:', filePath);
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 400,
    height: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: false,
    title: 'DentDoc Login',
    frame: false,
    backgroundColor: '#1e1e1e'
  });

  loginWindow.loadFile('src/login.html');
  loginWindow.setMenu(null);

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);

  updateTrayMenu();

  tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

  tray.on('click', async () => {
    if (isRecording) {
      stopRecording();
    } else {
      // Show confirmation dialog before starting recording
      const token = store.get('authToken');
      if (!token) {
        createLoginWindow();
        return;
      }

      const shortcut = store.get('shortcut') || 'F9';
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Aufnahme starten', 'Abbrechen'],
        defaultId: 0,
        title: 'DentDoc',
        message: 'Möchten Sie die Aufnahme starten?',
        detail: `Drücken Sie ${shortcut} oder klicken Sie erneut auf das Tray-Icon um die Aufnahme zu stoppen.`
      });

      if (response === 0) {
        startRecording();
      }
    }
  });
}

function updateTrayMenu() {
  const token = store.get('authToken');
  const user = store.get('user');

  if (!token) {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Anmelden', click: () => createLoginWindow() },
      { type: 'separator' },
      { label: 'Beenden', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
    return;
  }

  const minutesText = user?.minutesRemaining ? `${user.minutesRemaining} Minuten übrig` : 'Keine Minuten';
  const shortcut = store.get('shortcut') || 'F9';

  // Determine menu label based on state
  let recordingLabel;
  let recordingEnabled = true;
  if (isProcessing) {
    recordingLabel = '⏳ Verarbeitung läuft...';
    recordingEnabled = false;
  } else if (isRecording) {
    recordingLabel = `⏺ Aufnahme stoppen (${shortcut})`;
  } else {
    recordingLabel = `▶ Aufnahme starten (${shortcut})`;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: minutesText,
      enabled: false
    },
    { type: 'separator' },
    {
      label: recordingLabel,
      enabled: recordingEnabled,
      click: () => {
        if (isRecording) {
          stopRecording();
        } else {
          startRecording();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Dashboard öffnen',
      click: () => {
        openDashboard();
      }
    },
    {
      label: 'Stimmprofile verwalten',
      click: () => {
        openVoiceProfiles();
      }
    },
    {
      label: 'Einstellungen',
      click: () => {
        openSettings();
      }
    },
    { type: 'separator' },
    {
      label: 'Abmelden',
      click: () => {
        store.delete('authToken');
        store.delete('user');
        updateTrayMenu();
        showNotification('Abgemeldet', 'Sie wurden erfolgreich abgemeldet');
      }
    },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
    { type: 'separator' },
    { label: `v${app.getVersion()}`, enabled: false }
  ]);

  tray.setContextMenu(contextMenu);
}

async function startRecording() {
  const token = store.get('authToken');
  if (!token) {
    showNotification('Fehler', 'Bitte melden Sie sich zuerst an');
    createLoginWindow();
    return;
  }

  // Prevent starting new recording while processing
  if (isProcessing) {
    showNotification('Bitte warten', 'Die vorherige Aufnahme wird noch verarbeitet...');
    return;
  }

  try {
    isRecording = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft...');

    currentRecordingPath = await audioRecorder.startRecording();

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('Aufnahme läuft...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');
  } catch (error) {
    console.error('Recording error:', error);
    updateStatusOverlay('Fehler', 'Aufnahme konnte nicht gestartet werden', 'error');
    isRecording = false;
    updateTrayMenu();
  }
}

async function stopRecording() {
  try {
    tray.setToolTip('DentDoc - Verarbeite Aufnahme...');

    await audioRecorder.stopRecording();
    isRecording = false;
    isProcessing = true; // Start processing state
    updateTrayMenu();

    // Reset tray icon but show processing state
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);

    updateStatusOverlay('Audio wird hochgeladen...', 'Bitte warten...', 'processing', { step: 1 });

    // Upload and transcribe
    const token = store.get('authToken');
    let transcriptionId;

    try {
      transcriptionId = await apiClient.uploadAudio(currentRecordingPath, token);
    } catch (uploadError) {
      // If upload fails, show error and exit
      throw uploadError;
    }

    updateStatusOverlay('Transkription läuft...', 'Audio wird analysiert...', 'processing', { step: 2 });

    // Poll for transcription completion
    let transcription = null;
    let attempts = 0;
    const maxAttempts = 60; // 60 attempts * 3 seconds = 3 minutes max

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        transcription = await apiClient.getTranscription(transcriptionId, token);

        if (transcription.status === 'completed') {
          console.log('Transcription completed');
          break;
        } else if (transcription.status === 'failed' || transcription.status === 'error') {
          throw new Error('Transkription fehlgeschlagen');
        }
      } catch (error) {
        // If it's a network error, continue polling
        if (error.message.includes('Transkription fehlgeschlagen')) {
          // Transcription actually failed, stop polling
          throw error;
        }
        console.log('Waiting for transcription...', error.message);
      }

      attempts++;
    }

    if (!transcription || transcription.status !== 'completed') {
      throw new Error('Transkription dauert zu lange. Bitte versuchen Sie es später erneut.');
    }

    // Check if we have utterances (speech detected)
    const utterancesData = typeof transcription.utterances === 'string'
      ? JSON.parse(transcription.utterances)
      : transcription.utterances;

    if (!utterancesData || utterancesData.length === 0) {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    // Identify speakers if we have utterances
    if (transcription.utterances) {
      debugLog('=== Starting speaker identification ===');
      debugLog(`Has utterances: true`);
      debugLog(`Current recording path: ${currentRecordingPath}`);

      updateStatusOverlay('Sprecher werden erkannt...', 'Stimmen werden analysiert...', 'processing', { step: 3 });

      try {
        // Handle both string and object utterances
        const utterances = typeof transcription.utterances === 'string'
          ? JSON.parse(transcription.utterances)
          : transcription.utterances;

        debugLog(`Utterances count: ${utterances.length}`);
        debugLog(`Calling speakerRecognition.identifySpeakersFromUtterances...`);

        // Use local audio file for speaker identification
        const speakerMapping = await speakerRecognition.identifySpeakersFromUtterances(
          currentRecordingPath,
          utterances
        );

        console.log('Speaker mapping:', speakerMapping);
        debugLog(`Speaker mapping result: ${JSON.stringify(speakerMapping)}`);

        // Update backend with speaker mapping
        await apiClient.updateSpeakerMapping(transcriptionId, speakerMapping, token);
        console.log('Speaker mapping updated in backend');
        debugLog('Speaker mapping updated in backend successfully');
      } catch (error) {
        console.error('Speaker identification failed:', error);
        debugLog(`ERROR in speaker identification: ${error.message}`);
        debugLog(`Stack: ${error.stack}`);
        // Continue anyway - speaker identification is optional
      }
    } else {
      debugLog('No utterances available for speaker identification');
    }

    updateStatusOverlay('Dokumentation wird erstellt...', 'KI generiert Zusammenfassung...', 'processing', { step: 4 });

    // Get documentation (returns { documentation, transcript })
    const result = await apiClient.getDocumentation(transcriptionId, token);
    const documentation = result.documentation;
    const transcript = result.transcript;

    // Store for later copying
    lastDocumentation = documentation;
    lastTranscript = transcript;

    // Copy to clipboard
    clipboard.writeText(documentation);

    // Auto-save transcript if enabled and path is configured
    const autoExport = store.get('autoExport', false);
    const transcriptPath = store.get('transcriptPath');
    if (autoExport && transcriptPath && transcript) {
      try {
        saveTranscriptToFile(transcriptPath, documentation, transcript);
      } catch (error) {
        console.error('Failed to save transcript file:', error);
        // Don't block the workflow if file save fails
      }
    }

    isProcessing = false; // Processing complete
    updateTrayMenu();

    // Check if auto-close is enabled
    const autoClose = store.get('autoCloseOverlay', false);

    updateStatusOverlay(
      'Fertig!',
      'Dokumentation in Zwischenablage kopiert (Strg+V)',
      'success',
      { documentation, transcript, autoClose }
    );

    // Update user minutes
    const user = await apiClient.getUser(token);
    store.set('user', user);
    updateTrayMenu();
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

  } catch (error) {
    console.error('Stop recording error:', error);

    // Reset tray icon on error
    const errorIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(errorIconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    // Show user-friendly error notification
    let errorTitle = 'Fehler';
    let errorMessage = error.message;

    // Categorize errors for better UX
    if (error.message.includes('Keine Sprache erkannt')) {
      errorTitle = 'Keine Sprache erkannt';
      errorMessage = 'Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.';
    } else if (error.message.includes('zu kurz') || error.message.includes('leer')) {
      errorTitle = 'Aufnahme zu kurz';
      errorMessage = 'Bitte sprechen Sie mindestens 2-3 Sekunden.';
    } else if (error.message.includes('Minuten') || error.message.includes('Guthaben')) {
      errorTitle = 'Kein Guthaben';
      errorMessage = 'Bitte laden Sie Ihr Minuten-Guthaben im Dashboard auf.';
    } else if (error.message.includes('Server') || error.message.includes('Internet')) {
      errorTitle = 'Verbindungsfehler';
      errorMessage = 'Bitte prüfen Sie Ihre Internetverbindung.';
    }

    updateStatusOverlay(errorTitle, errorMessage, 'error');
    isRecording = false;
    isProcessing = false; // Reset processing state on error
    updateTrayMenu();
  }
}

function showNotification(title, body) {
  new Notification({
    title,
    body,
    icon: path.join(__dirname, 'assets', 'icon.png')
  }).show();
}

function createStatusOverlay() {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    return statusOverlay;
  }

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  statusOverlay = new BrowserWindow({
    width: 440,
    height: 360,
    x: width - 460,
    y: height - 380,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusOverlay.loadFile('src/status-overlay.html');
  statusOverlay.setVisibleOnAllWorkspaces(true);
  statusOverlay.setAlwaysOnTop(true, 'screen-saver'); // Höhere Priorität

  return statusOverlay;
}

function updateStatusOverlay(title, message, type, extra = {}) {
  // Clear any pending auto-hide
  if (autoHideTimeout) {
    clearTimeout(autoHideTimeout);
    autoHideTimeout = null;
  }

  const overlay = createStatusOverlay();
  overlay.webContents.send('update-status', {
    title,
    message,
    type,
    step: extra.step || null,
    documentation: extra.documentation || null,
    transcript: extra.transcript || null
  });
  overlay.show();
  overlay.setAlwaysOnTop(true, 'screen-saver'); // Stelle sicher, dass es im Vordergrund bleibt
  overlay.focus(); // Bringe es in den Fokus

  // Auto-hide after error (5 seconds) or success if auto-close enabled
  if (type === 'error') {
    autoHideTimeout = setTimeout(() => {
      hideStatusOverlay();
    }, 5000);
  } else if (type === 'success' && extra.autoClose) {
    autoHideTimeout = setTimeout(() => {
      hideStatusOverlay();
    }, 3000);
  }
}

function hideStatusOverlay() {
  if (autoHideTimeout) {
    clearTimeout(autoHideTimeout);
    autoHideTimeout = null;
  }
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.hide();
  }
}

// IPC handler for closing status overlay
ipcMain.on('close-status-overlay', () => {
  hideStatusOverlay();
});

// IPC handler for cancelling recording (X button during recording)
ipcMain.on('cancel-recording', async () => {
  if (isRecording) {
    try {
      // Stop the audio recorder without processing
      await audioRecorder.stopRecording();
    } catch (error) {
      console.log('Error stopping recorder:', error);
    }

    isRecording = false;
    isProcessing = false;
    currentRecordingPath = null;

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit');
    updateTrayMenu();

    console.log('Recording cancelled by user');
  }
});

// IPC handlers for status overlay
ipcMain.handle('get-auto-close-setting', () => {
  return store.get('autoCloseOverlay', false);
});

ipcMain.handle('set-auto-close-setting', (event, value) => {
  store.set('autoCloseOverlay', value);
  return true;
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text);
  return true;
});

// Window control handlers
ipcMain.on('minimize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.on('close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});

// IPC Handlers for login window
ipcMain.handle('login', async (event, email, password) => {
  try {
    const response = await apiClient.login(email, password);
    store.set('authToken', response.token);
    store.set('user', response.user);
    updateTrayMenu();

    if (loginWindow) {
      loginWindow.close();
    }

    showNotification('Angemeldet', `Willkommen ${response.user.email}!`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC Handlers for settings window
ipcMain.handle('get-settings', async () => {
  return {
    shortcut: store.get('shortcut') || 'F9',
    microphoneId: store.get('microphoneId') || null,
    transcriptPath: store.get('transcriptPath') || '',
    profilesPath: store.get('profilesPath') || '',
    autoClose: store.get('autoCloseOverlay', false),
    autoExport: store.get('autoExport', false)
  };
});

ipcMain.handle('save-settings', async (event, settings) => {
  // Save microphone
  if (settings.microphoneId) {
    store.set('microphoneId', settings.microphoneId);
  }

  // Save transcript path
  if (settings.transcriptPath !== undefined) {
    store.set('transcriptPath', settings.transcriptPath);
  }

  // Save profiles path
  if (settings.profilesPath !== undefined) {
    store.set('profilesPath', settings.profilesPath);
    // Reload voice profiles with new path
    const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
    voiceProfiles.setStorePath(settings.profilesPath);
  }

  // Save auto-close setting
  if (settings.autoClose !== undefined) {
    store.set('autoCloseOverlay', settings.autoClose);
  }

  // Save auto-export setting
  if (settings.autoExport !== undefined) {
    store.set('autoExport', settings.autoExport);
  }

  // Register new shortcut
  if (settings.shortcut) {
    const success = registerShortcut(settings.shortcut);
    if (!success) {
      throw new Error('Tastenkombination konnte nicht registriert werden. Möglicherweise wird sie bereits verwendet.');
    }
  }

  showNotification('Einstellungen gespeichert', `Tastenkombination: ${settings.shortcut}`);
  return { success: true };
});

// Debug log handlers
ipcMain.handle('open-debug-log', async () => {
  const logPath = DEBUG_LOG;

  // Ensure log file exists
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

  // Open log file in default text editor
  await shell.openPath(logPath);
  return { success: true };
});

ipcMain.handle('get-debug-log-path', async () => {
  return DEBUG_LOG;
});

ipcMain.handle('open-temp-folder', async () => {
  const tempDir = path.join(app.getPath('temp'), 'dentdoc');

  // Create folder if it doesn't exist
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  await shell.openPath(tempDir);
  return { success: true };
});

// Folder selection dialog
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

// IPC Handlers for voice profiles
const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

ipcMain.handle('get-voice-profiles', async () => {
  return voiceProfiles.getAllProfiles();
});

ipcMain.handle('delete-voice-profile', async (event, id) => {
  return voiceProfiles.deleteProfile(id);
});

ipcMain.handle('start-voice-enrollment', async (event, data) => {
  if (isEnrolling) {
    throw new Error('Eine Aufnahme läuft bereits');
  }

  try {
    isEnrolling = true;
    // Support both old format (string) and new format ({ name, role })
    if (typeof data === 'string') {
      currentEnrollmentName = data;
      currentEnrollmentRole = 'Arzt'; // Default role
    } else {
      currentEnrollmentName = data.name;
      currentEnrollmentRole = data.role || 'Arzt';
    }
    currentEnrollmentPath = await audioRecorder.startRecording();
    return { success: true };
  } catch (error) {
    isEnrolling = false;
    throw error;
  }
});

ipcMain.handle('stop-voice-enrollment', async () => {
  if (!isEnrolling) {
    throw new Error('Keine Aufnahme aktiv');
  }

  try {
    await audioRecorder.stopRecording();

    // Create voice profile from recording with role
    const profile = await speakerRecognition.enrollSpeaker(
      currentEnrollmentName,
      currentEnrollmentPath,
      currentEnrollmentRole
    );

    isEnrolling = false;
    currentEnrollmentName = null;
    currentEnrollmentPath = null;
    currentEnrollmentRole = null;

    return { success: true, profile };
  } catch (error) {
    isEnrolling = false;
    throw error;
  }
});

// Forward audio level updates from recorder to status overlay
ipcMain.on('audio-level-update', (event, level) => {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.webContents.send('audio-level', level);
  }
});

// ============================================
// Auto-Update Event Handlers
// ============================================

// Load autoUpdater after app is ready
const { autoUpdater } = require('electron-updater');

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);

  const notification = new Notification({
    title: 'Update verfügbar',
    body: `Version ${info.version} wird im Hintergrund heruntergeladen...`,
    icon: path.join(__dirname, 'assets/icon.png')
  });
  notification.show();
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);

  dialog.showMessageBox({
    type: 'info',
    title: 'Update bereit',
    message: `Version ${info.version} wurde heruntergeladen`,
    detail: 'Das Update wird beim nächsten Start von DentDoc automatisch installiert.',
    buttons: ['Jetzt neu starten', 'Später'],
    defaultId: 0,
    cancelId: 1
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

autoUpdater.on('error', (error) => {
  console.error('Auto-update error:', error);
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
});

autoUpdater.on('update-not-available', () => {
  console.log('No updates available');
});

app.whenReady().then(() => {
  createTray();

  // Initialize custom voice profiles path if set
  const profilesPath = store.get('profilesPath');
  if (profilesPath) {
    const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
    voiceProfiles.setStorePath(profilesPath);
  }

  // Register global shortcut (use saved or default F9)
  const savedShortcut = store.get('shortcut') || 'F9';
  registerShortcut(savedShortcut);

  // Check for updates (only in production)
  if (!app.isPackaged) {
    console.log('Development mode - skipping auto-update check');
  } else {
    autoUpdater.checkForUpdatesAndNotify();

    // Check for updates every 4 hours
    setInterval(() => {
      autoUpdater.checkForUpdates();
    }, 4 * 60 * 60 * 1000);
  }

  // Check if user is already logged in
  const token = store.get('authToken');
  if (!token) {
    createLoginWindow();
  } else {
    // Validate token and get user data
    apiClient.getUser(token).then(user => {
      store.set('user', user);
      updateTrayMenu();
    }).catch(() => {
      // Token invalid, show login
      store.delete('authToken');
      createLoginWindow();
    });
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit the app when all windows are closed (stay in tray)
  e.preventDefault();
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
});

// Handle second instance
app.on('second-instance', () => {
  showNotification('DentDoc läuft bereits', 'Die App ist bereits im System Tray aktiv');
});
