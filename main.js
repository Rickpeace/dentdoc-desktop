// Load environment variables (.env.local overrides .env for local development)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, Notification, dialog, shell } = require('electron');
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
let bausteineWindow = null;
let statusOverlay = null;
let feedbackWindow = null;
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
    height: 600,
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
    height: 750,
    minWidth: 500,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: true,
    title: 'DentDoc Stimmprofile'
  });

  voiceProfilesWindow.loadFile('src/voice-profiles.html');
  voiceProfilesWindow.setMenu(null);

  voiceProfilesWindow.on('closed', () => {
    voiceProfilesWindow = null;
  });
}

function openBausteine() {
  if (bausteineWindow && !bausteineWindow.isDestroyed()) {
    bausteineWindow.focus();
    return;
  }

  bausteineWindow = new BrowserWindow({
    width: 700,
    height: 800,
    minWidth: 600,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: true,
    title: 'DentDoc Bausteine'
  });

  bausteineWindow.loadFile('src/bausteine/bausteine.html');
  bausteineWindow.setMenu(null);

  bausteineWindow.on('closed', () => {
    bausteineWindow = null;
  });
}

function openFeedback() {
  if (feedbackWindow && !feedbackWindow.isDestroyed()) {
    feedbackWindow.focus();
    return;
  }

  feedbackWindow = new BrowserWindow({
    width: 500,
    height: 450,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: false,
    title: 'DentDoc Feedback'
  });

  feedbackWindow.loadFile('src/feedback.html');
  feedbackWindow.setMenu(null);

  feedbackWindow.on('closed', () => {
    feedbackWindow = null;
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
 * Extract doctors and ZFAs from speaker mapping
 * @param {Object} speakerMapping - Speaker mapping object (e.g., { "A": "Arzt - Dr. Notle", "B": "ZFA - Maria" })
 * @returns {Object} { aerzte: string[], zfa: string[] }
 */
function extractRolesFromSpeakerMapping(speakerMapping) {
  const aerzte = [];
  const zfa = [];

  if (!speakerMapping) return { aerzte, zfa };

  for (const [, label] of Object.entries(speakerMapping)) {
    if (typeof label === 'string') {
      // Check if format is "Role - Name"
      const match = label.match(/^(Arzt|ZFA)\s*-\s*(.+)$/i);
      if (match) {
        const role = match[1].toLowerCase();
        const name = match[2].trim();
        if (role === 'arzt') {
          aerzte.push(name);
        } else if (role === 'zfa') {
          zfa.push(name);
        }
      }
    }
  }

  return { aerzte, zfa };
}

/**
 * Sanitize filename by removing invalid characters
 * @param {string} name - Name to sanitize
 * @returns {string} Sanitized name
 */
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim();
}

/**
 * Save transcript and summary to text files (one per doctor)
 * @param {string} baseFolderPath - Base folder to save the files
 * @param {string} summary - Documentation/summary text
 * @param {string} transcript - Full transcript text
 * @param {Object} speakerMapping - Speaker mapping object
 */
function saveTranscriptToFile(baseFolderPath, summary, transcript, speakerMapping = null) {
  // Create filename with date and time
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  // Extract roles from speaker mapping
  const { aerzte, zfa } = extractRolesFromSpeakerMapping(speakerMapping);

  // Build filename suffix with doctors and ZFAs
  const nameParts = [];
  aerzte.forEach(name => nameParts.push(sanitizeFilename(name)));
  zfa.forEach(name => nameParts.push(sanitizeFilename(name)));

  // Create filename: YYYY-MM-DD_HH-MM_[Names].txt
  let filenameSuffix = nameParts.length > 0 ? nameParts.join('_') : 'Unbekannt';
  const filename = `${year}-${month}-${day}_${hours}-${minutes}_${filenameSuffix}.txt`;

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

  // Determine target folders based on doctors
  const targetFolders = [];

  if (aerzte.length > 0) {
    // Create one folder per doctor
    aerzte.forEach(arzt => {
      targetFolders.push(path.join(baseFolderPath, sanitizeFilename(arzt)));
    });
  } else {
    // No doctors recognized - save to "Ohne Zuordnung" folder
    targetFolders.push(path.join(baseFolderPath, 'Ohne Zuordnung'));
  }

  // Save file to each target folder
  targetFolders.forEach(folderPath => {
    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    const filePath = path.join(folderPath, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Transcript saved to:', filePath);
  });
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
    {
      label: 'Audio-Datei transkribieren...',
      enabled: !isRecording && !isProcessing,
      click: () => {
        selectAndTranscribeAudioFile();
      }
    },
    {
      label: 'Letzte Dokumentation anzeigen',
      enabled: lastDocumentation !== null,
      click: () => {
        showLastResult();
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
      label: 'Bausteine verwalten',
      click: () => {
        openBausteine();
      }
    },
    {
      label: 'Einstellungen',
      click: () => {
        openSettings();
      }
    },
    {
      label: 'Feedback',
      click: () => {
        openFeedback();
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

// Select and transcribe an existing audio file
async function selectAndTranscribeAudioFile() {
  const token = store.get('authToken');
  if (!token) {
    showNotification('Fehler', 'Bitte melden Sie sich zuerst an');
    createLoginWindow();
    return;
  }

  if (isProcessing || isRecording) {
    showNotification('Bitte warten', 'Es läuft bereits eine Verarbeitung...');
    return;
  }

  // Open file dialog
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Audio-Datei auswählen',
    filters: [
      { name: 'Audio-Dateien', extensions: ['mp3', 'wav', 'webm', 'm4a', 'ogg', 'flac', 'aac'] },
      { name: 'Alle Dateien', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return;
  }

  const audioFilePath = result.filePaths[0];
  console.log('Selected audio file:', audioFilePath);
  debugLog(`Selected audio file: ${audioFilePath}`);

  // Process the selected audio file
  await processAudioFile(audioFilePath);
}

// Process an audio file (shared by recording and file selection)
async function processAudioFile(audioFilePath) {
  const token = store.get('authToken');

  isProcessing = true;
  updateTrayMenu();

  // Change tray icon to processing state (use regular icon)
  const processingIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray.setImage(processingIconPath);
  tray.setToolTip('DentDoc - Verarbeitung...');

  updateStatusOverlay('Audio wird hochgeladen...', 'Bitte warten...', 'processing', { step: 1 });

  try {
    // Upload audio
    const transcriptionId = await apiClient.uploadAudio(audioFilePath, token);
    updateStatusOverlay('Transkription läuft...', 'Audio wird analysiert...', 'processing', { step: 2 });

    // Poll for transcription result
    let transcriptionResult;
    let attempts = 0;
    const maxAttempts = 120;

    while (attempts < maxAttempts) {
      transcriptionResult = await apiClient.getTranscription(transcriptionId, token);

      if (transcriptionResult.status === 'completed') {
        break;
      } else if (transcriptionResult.status === 'error' || transcriptionResult.status === 'failed') {
        throw new Error(transcriptionResult.error || 'Transkription fehlgeschlagen');
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Zeitüberschreitung bei der Transkription');
    }

    const transcript = transcriptionResult.transcript;

    // Handle utterances (can be string or object from backend)
    const utterances = typeof transcriptionResult.utterances === 'string'
      ? JSON.parse(transcriptionResult.utterances)
      : transcriptionResult.utterances;

    // Check if speech was detected
    if (!utterances || utterances.length === 0) {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    // Speaker recognition
    let currentSpeakerMapping = null;
    updateStatusOverlay('Sprecher werden erkannt...', 'Stimmen werden analysiert...', 'processing', { step: 3 });

    try {
      if (speakerRecognition && utterances && utterances.length > 0) {
        debugLog(`Utterances count: ${utterances.length}`);
        debugLog('Calling speakerRecognition.identifySpeakersFromUtterances...');

        currentSpeakerMapping = await speakerRecognition.identifySpeakersFromUtterances(
          audioFilePath,
          utterances
        );

        debugLog('Speaker mapping result: ' + JSON.stringify(currentSpeakerMapping));

        // Update backend with speaker mapping
        await apiClient.updateSpeakerMapping(transcriptionId, currentSpeakerMapping, token);
        debugLog('Speaker mapping updated in backend successfully');
      }
    } catch (speakerError) {
      console.error('Speaker recognition failed:', speakerError);
      debugLog('Speaker recognition error: ' + speakerError.message);
      // Continue anyway - speaker identification is optional
    }

    // Generate documentation
    const docMode = store.get('docMode', 'single');
    let result;

    if (docMode === 'agent-chain') {
      // Agent-Kette: Use V2 endpoint with Bausteine
      updateStatusOverlay('Dokumentation wird erstellt...', 'Agent-Kette analysiert Kategorien...', 'processing', { step: 4 });
      const bausteine = bausteineManager.getAllBausteine();
      result = await apiClient.getDocumentationV2(transcriptionId, token, bausteine);
    } else {
      // Single Prompt: Use standard endpoint
      updateStatusOverlay('Dokumentation wird erstellt...', 'KI generiert Zusammenfassung...', 'processing', { step: 4 });
      result = await apiClient.getDocumentation(transcriptionId, token);
    }

    const documentation = result.documentation;
    const finalTranscript = result.transcript || transcript;

    // Store for "show last result"
    lastDocumentation = documentation;
    lastTranscript = finalTranscript;

    // Copy to clipboard
    clipboard.writeText(documentation);

    // Auto-save transcript if enabled
    const autoExport = store.get('autoExport', true);
    const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
    const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;
    if (autoExport && finalTranscript) {
      try {
        saveTranscriptToFile(transcriptPath, documentation, finalTranscript, currentSpeakerMapping);
      } catch (error) {
        console.error('Failed to save transcript file:', error);
      }
    }

    isProcessing = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    const autoClose = store.get('autoCloseOverlay', false);
    updateStatusOverlay(
      'Fertig!',
      'Dokumentation in Zwischenablage kopiert (Strg+V)',
      'success',
      { documentation, transcript: finalTranscript, autoClose }
    );

    // Update user minutes
    try {
      const user = await apiClient.getUser(token);
      if (user) {
        store.set('user', user);
        updateTrayMenu();
      }
    } catch (e) {
      console.error('Failed to update user info:', e);
    }

  } catch (error) {
    console.error('Audio file processing error:', error);
    debugLog('Audio file processing error: ' + error.message);

    isProcessing = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    // Categorize errors for better UX
    let errorTitle = 'Fehler';
    let errorMessage = error.message || 'Unbekannter Fehler';

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
  }
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

  // Get deleteAudio setting - cleanup is handled by audioRecorder
  const deleteAudio = store.get('deleteAudio', true);
  console.log('deleteAudio setting:', deleteAudio);
  debugLog(`deleteAudio setting: ${deleteAudio}`);

  try {
    isRecording = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft...');

    currentRecordingPath = await audioRecorder.startRecording(deleteAudio);

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
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);

    // Process the recorded audio file (same as manual file upload)
    await processAudioFile(currentRecordingPath);

  } catch (error) {
    console.error('Stop recording error:', error);

    // Reset state on error
    isRecording = false;
    isProcessing = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht gestoppt werden', 'error');
  }
}

function showNotification(title, body) {
  new Notification({
    title,
    body,
    icon: path.join(__dirname, 'assets', 'icon.png')
  }).show();
}

function getValidOverlayPosition() {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const workArea = primaryDisplay.workArea;

  const overlayWidth = 440;
  const overlayHeight = 360;

  // Default position: bottom-right corner
  const defaultX = width - overlayWidth - 20;
  const defaultY = height - overlayHeight - 20;

  // Load saved position
  const savedPosition = store.get('overlayPosition', null);

  if (!savedPosition) {
    return { x: defaultX, y: defaultY };
  }

  let { x, y } = savedPosition;

  // Validate position is within screen bounds
  // Get all displays to check if position is valid on any screen
  const displays = screen.getAllDisplays();
  let isOnAnyScreen = false;

  for (const display of displays) {
    const bounds = display.workArea;
    // Check if at least part of the window is visible on this screen
    if (x < bounds.x + bounds.width &&
        x + overlayWidth > bounds.x &&
        y < bounds.y + bounds.height &&
        y + overlayHeight > bounds.y) {
      isOnAnyScreen = true;

      // Clamp to this display's bounds
      x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - overlayWidth));
      y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - overlayHeight));
      break;
    }
  }

  // If not on any screen, reset to default on primary display
  if (!isOnAnyScreen) {
    x = Math.max(workArea.x, Math.min(defaultX, workArea.x + workArea.width - overlayWidth));
    y = Math.max(workArea.y, Math.min(defaultY, workArea.y + workArea.height - overlayHeight));
  }

  return { x, y };
}

function createStatusOverlay() {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    return statusOverlay;
  }

  const position = getValidOverlayPosition();

  statusOverlay = new BrowserWindow({
    width: 440,
    height: 360,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true, // Allow focus for dragging
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusOverlay.loadFile('src/status-overlay.html');
  statusOverlay.setVisibleOnAllWorkspaces(true);
  statusOverlay.setAlwaysOnTop(true, 'screen-saver'); // Höhere Priorität

  // Validate and save position when window is moved
  statusOverlay.on('moved', () => {
    if (statusOverlay && !statusOverlay.isDestroyed()) {
      const { screen } = require('electron');
      const [currentX, currentY] = statusOverlay.getPosition();
      const [windowWidth, windowHeight] = statusOverlay.getSize();

      // Find which display the window is on (use full bounds for detection)
      const displays = screen.getAllDisplays();
      let targetDisplay = screen.getPrimaryDisplay();

      for (const display of displays) {
        const db = display.bounds;
        const centerX = currentX + windowWidth / 2;
        const centerY = currentY + windowHeight / 2;

        if (centerX >= db.x && centerX < db.x + db.width &&
            centerY >= db.y && centerY < db.y + db.height) {
          targetDisplay = display;
          break;
        }
      }

      // Use full screen bounds, not workArea (which excludes taskbar)
      const bounds = targetDisplay.bounds;

      // Clamp position to screen bounds
      let newX = currentX;
      let newY = currentY;

      // Left edge
      if (newX < bounds.x) {
        newX = bounds.x;
      }
      // Right edge
      if (newX + windowWidth > bounds.x + bounds.width) {
        newX = bounds.x + bounds.width - windowWidth;
      }
      // Top edge
      if (newY < bounds.y) {
        newY = bounds.y;
      }
      // Bottom edge - window can go until taskbar (approx 85px from bottom)
      const bottomLimit = bounds.y + bounds.height - 85;
      if (newY > bottomLimit) {
        newY = bottomLimit;
      }

      // If position changed, move the window back
      if (newX !== currentX || newY !== currentY) {
        statusOverlay.setPosition(newX, newY);
      }

      // Save the valid position
      store.set('overlayPosition', { x: newX, y: newY });
    }
  });

  return statusOverlay;
}

// Validate and adjust overlay position to ensure it stays within screen bounds
function validateOverlayPosition() {
  if (!statusOverlay || statusOverlay.isDestroyed()) return;

  const { screen } = require('electron');
  const [currentX, currentY] = statusOverlay.getPosition();
  const [windowWidth, windowHeight] = statusOverlay.getSize();

  // Find which display the window is on
  const displays = screen.getAllDisplays();
  let targetDisplay = screen.getPrimaryDisplay();

  for (const display of displays) {
    const db = display.bounds;
    const centerX = currentX + windowWidth / 2;
    const centerY = currentY + windowHeight / 2;

    if (centerX >= db.x && centerX < db.x + db.width &&
        centerY >= db.y && centerY < db.y + db.height) {
      targetDisplay = display;
      break;
    }
  }

  // Use workArea to respect taskbar
  const workArea = targetDisplay.workArea;

  // Clamp position to work area bounds
  let newX = currentX;
  let newY = currentY;

  // Left edge
  if (newX < workArea.x) {
    newX = workArea.x;
  }
  // Right edge
  if (newX + windowWidth > workArea.x + workArea.width) {
    newX = workArea.x + workArea.width - windowWidth;
  }
  // Top edge
  if (newY < workArea.y) {
    newY = workArea.y;
  }
  // Bottom edge
  if (newY + windowHeight > workArea.y + workArea.height) {
    newY = workArea.y + workArea.height - windowHeight;
  }

  // If position changed, move the window
  if (newX !== currentX || newY !== currentY) {
    statusOverlay.setPosition(newX, newY);
    // Save the corrected position
    store.set('overlayPosition', { x: newX, y: newY });
  }
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

  // When showing success with actions, validate position to ensure window stays on screen
  if (type === 'success' && extra.documentation) {
    validateOverlayPosition();
  }

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

// Show last documentation result again
function showLastResult() {
  if (!lastDocumentation) {
    showNotification('Keine Dokumentation', 'Es gibt keine letzte Dokumentation zum Anzeigen');
    return;
  }

  updateStatusOverlay(
    'Fertig!',
    'Dokumentation bereit',
    'success',
    {
      documentation: lastDocumentation,
      transcript: lastTranscript
    }
  );
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

// Feedback handler
ipcMain.handle('submit-feedback', async (event, data) => {
  try {
    const token = store.get('authToken');
    if (!token) {
      return { success: false, error: 'Nicht angemeldet' };
    }

    const result = await apiClient.submitFeedback(token, data.category, data.message);
    return result;
  } catch (error) {
    console.error('Failed to submit feedback:', error);
    return { success: false, error: error.message };
  }
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
  // Default paths in Documents folder
  const documentsPath = app.getPath('documents');
  const defaultTranscriptPath = path.join(documentsPath, 'DentDoc', 'Transkripte');
  const defaultProfilesPath = path.join(documentsPath, 'DentDoc', 'Stimmprofile');

  return {
    shortcut: store.get('shortcut') || 'F9',
    microphoneId: store.get('microphoneId') || null,
    transcriptPath: store.get('transcriptPath') || defaultTranscriptPath,
    profilesPath: store.get('profilesPath') || defaultProfilesPath,
    autoClose: store.get('autoCloseOverlay', false),
    autoExport: store.get('autoExport', true),
    deleteAudio: store.get('deleteAudio', true),
    docMode: store.get('docMode', 'single')
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

  // Save delete audio setting
  if (settings.deleteAudio !== undefined) {
    store.set('deleteAudio', settings.deleteAudio);
  }

  // Save documentation mode
  if (settings.docMode !== undefined) {
    store.set('docMode', settings.docMode);
  }

  // Register new shortcut
  if (settings.shortcut) {
    const success = registerShortcut(settings.shortcut);
    if (!success) {
      throw new Error('Tastenkombination konnte nicht registriert werden. Möglicherweise wird sie bereits verwendet.');
    }
  }

  return { success: true, message: 'Einstellungen gespeichert' };
});

// Save profiles path separately (from voice profiles window)
ipcMain.handle('save-profiles-path', async (event, profilesPath) => {
  store.set('profilesPath', profilesPath);
  // Reload voice profiles with new path
  const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
  voiceProfiles.setStorePath(profilesPath);
  return { success: true };
});

// Open any folder in explorer
ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!folderPath) {
    return { success: false, error: 'Kein Pfad angegeben' };
  }

  // Ensure folder exists
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  // Open in explorer
  const { shell } = require('electron');
  shell.openPath(folderPath);
  return { success: true };
});

// Open profiles folder in explorer
ipcMain.handle('open-profiles-folder', async () => {
  const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
  const profilesPath = voiceProfiles.getStorePath();

  // Ensure folder exists
  if (!fs.existsSync(profilesPath)) {
    fs.mkdirSync(profilesPath, { recursive: true });
  }

  // Open in explorer
  const { shell } = require('electron');
  shell.openPath(profilesPath);
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

// IPC Handlers for Bausteine
const bausteineManager = require('./src/bausteine');

ipcMain.handle('get-bausteine', async () => {
  return {
    bausteine: bausteineManager.getAllBausteine(),
    defaults: bausteineManager.getDefaultBausteine()
  };
});

ipcMain.handle('save-bausteine', async (event, bausteine) => {
  bausteineManager.saveAllBausteine(bausteine);
  return { success: true };
});

ipcMain.handle('reset-baustein', async (event, kategorie) => {
  bausteineManager.resetBaustein(kategorie);
  return { success: true };
});

ipcMain.handle('reset-all-bausteine', async () => {
  bausteineManager.resetAllBausteine();
  return { success: true };
});

ipcMain.handle('import-bausteine', async (event, json) => {
  bausteineManager.importBausteine(json);
  return { success: true };
});

ipcMain.handle('export-bausteine', async () => {
  return bausteineManager.exportBausteine();
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

// Cancel voice enrollment (without saving)
ipcMain.handle('cancel-voice-enrollment', async () => {
  if (!isEnrolling) {
    return { success: true };
  }

  const pathToDelete = currentEnrollmentPath;

  try {
    await audioRecorder.stopRecording();
  } catch (error) {
    console.error('Error stopping recording during cancel:', error);
  }

  // Delete the temporary recording file
  if (pathToDelete && fs.existsSync(pathToDelete)) {
    try {
      fs.unlinkSync(pathToDelete);
      console.log('Deleted cancelled enrollment recording:', pathToDelete);
    } catch (error) {
      console.error('Error deleting cancelled recording:', error);
    }
  }

  isEnrolling = false;
  currentEnrollmentName = null;
  currentEnrollmentPath = null;
  currentEnrollmentRole = null;

  return { success: true };
});

// Forward audio level updates from recorder to status overlay
ipcMain.on('audio-level-update', (event, level) => {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.webContents.send('audio-level', level);
  }
});

// Open Windows sound settings
ipcMain.handle('open-sound-settings', async () => {
  const { exec } = require('child_process');
  exec('start ms-settings:sound');
  return { success: true };
});

// Disable global shortcut (for shortcut recording in settings)
ipcMain.handle('disable-global-shortcut', () => {
  globalShortcut.unregisterAll();
  return { success: true };
});

// Re-enable global shortcut
ipcMain.handle('enable-global-shortcut', () => {
  const savedShortcut = store.get('shortcut') || 'F9';
  registerShortcut(savedShortcut);
  return { success: true };
});

// Show unsaved changes dialog
ipcMain.handle('show-unsaved-changes-dialog', async () => {
  const result = await dialog.showMessageBox(settingsWindow, {
    type: 'question',
    buttons: ['Speichern', 'Verwerfen', 'Abbrechen'],
    defaultId: 0,
    cancelId: 2,
    title: 'Ungespeicherte Änderungen',
    message: 'Sie haben ungespeicherte Änderungen.',
    detail: 'Möchten Sie die Änderungen speichern bevor Sie das Fenster schließen?'
  });

  switch (result.response) {
    case 0: return 'save';
    case 1: return 'discard';
    default: return 'cancel';
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
    // Configure GitHub token for private repo access
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'Rickpeace',
      repo: 'dentdoc-desktop',
      private: true,
      token: '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'
    });

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
