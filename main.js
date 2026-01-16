// Load environment variables (.env.local overrides .env for local development)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, Notification, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const audioRecorder = require('./src/audioRecorderFFmpeg');
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
let dashboardWindow = null;
let statusOverlay = null;
let statusOverlayReady = false;
let pendingStatusUpdate = null;
let isRecording = false;
let isProcessing = false;
let isEnrolling = false;
let currentRecordingPath = null;
let savedAudioPathInBackup = null; // Path to audio saved in "Fehlgeschlagen" folder (deleted after successful save)
let currentEnrollmentPath = null;
let currentEnrollmentName = null;
let currentEnrollmentRole = null;
let currentShortcut = null;
let autoHideTimeout = null;
let lastDocumentation = null;
let lastTranscript = null;
let lastShortenings = null;
let heartbeatInterval = null;

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

function openWebDashboard(path = '') {
  const baseUrl = apiClient.getBaseUrl().replace(/\/$/, '');
  shell.openExternal(baseUrl + '/dashboard' + path);
}

function openLocalDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  createDashboardWindow();
}

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false  // Keep renderer running when hidden (for F9 audio monitoring)
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: true,
    title: 'DentDoc',
    frame: false,
    hasShadow: false,
    backgroundColor: store.get('theme', 'dark') === 'light' ? '#ffffff' : '#0a0a0b',
    show: false
  });

  dashboardWindow.loadFile('src/dashboard.html');

  // Create a hidden menu with keyboard accelerators
  const dashboardMenu = Menu.buildFromTemplate([
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Ansicht',
      submenu: [
        {
          label: 'Einrichtungsassistent',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            if (dashboardWindow && !dashboardWindow.isDestroyed()) {
              dashboardWindow.webContents.send('open-setup-wizard');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Entwicklertools',
          accelerator: 'F12',
          click: () => {
            if (dashboardWindow && !dashboardWindow.isDestroyed()) {
              dashboardWindow.webContents.openDevTools();
            }
          }
        },
        {
          label: 'Entwicklertools (Alt)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (dashboardWindow && !dashboardWindow.isDestroyed()) {
              dashboardWindow.webContents.openDevTools();
            }
          }
        },
        { role: 'reload', accelerator: 'CmdOrCtrl+R' }
      ]
    }
  ]);
  dashboardWindow.setMenu(dashboardMenu);
  dashboardWindow.setMenuBarVisibility(false);

  // NOTE: We no longer auto-show on ready-to-show.
  // Dashboard is created hidden at app startup to enable audio monitoring for F9 recording.
  // User explicitly opens it via tray menu or other actions.

  // Make dashboard window available globally for audio level updates
  global.dashboardWindow = dashboardWindow;

  // Minimize to tray instead of closing
  dashboardWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      dashboardWindow.hide();
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    global.dashboardWindow = null;
  });

  // Refresh subscription status when window gains focus (for multi-PC sync)
  let lastDashboardRefreshTime = 0;
  const DASHBOARD_REFRESH_COOLDOWN = 10000; // Only refresh every 10 seconds max

  dashboardWindow.on('focus', async () => {
    const token = store.get('authToken');
    const now = Date.now();

    if (token && (now - lastDashboardRefreshTime) > DASHBOARD_REFRESH_COOLDOWN) {
      lastDashboardRefreshTime = now;
      await refreshUserData();
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('refresh-subscription-status');
      }
    }
  });

  return dashboardWindow;
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
 * Saves audio file immediately after recording stops (before transcription).
 * This ensures audio is preserved even if transcription fails.
 * @param {string} tempAudioPath - Path to temporary audio file
 * @returns {string|null} Path where audio was saved, or null if not saved
 */
function saveAudioImmediately(tempAudioPath) {
  // Always save backup to "Fehlgeschlagen" folder, regardless of settings
  // This ensures audio is preserved if transcription fails
  console.log('saveAudioImmediately called - tempAudioPath:', tempAudioPath);

  if (!tempAudioPath) {
    console.log('Audio save skipped - tempAudioPath is null/undefined');
    return null;
  }

  if (!fs.existsSync(tempAudioPath)) {
    console.log('Audio save skipped - file does not exist:', tempAudioPath);
    return null;
  }

  const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
  const baseFolderPath = store.get('transcriptPath') || defaultTranscriptPath;
  console.log('Audio will be saved to base folder:', baseFolderPath);

  // Extract unique job ID from temp audio filename (e.g., "recording-1705312345678.webm" -> "1705312345678")
  const tempFilename = path.basename(tempAudioPath, path.extname(tempAudioPath));
  const jobId = tempFilename.replace('recording-', '');

  // Create filename with date and time + job ID for uniqueness
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  // Save to "Fehlgeschlagen" folder (backup in case transcription fails)
  const tempFolder = path.join(baseFolderPath, 'Fehlgeschlagen');
  if (!fs.existsSync(tempFolder)) {
    fs.mkdirSync(tempFolder, { recursive: true });
    console.log('Created folder:', tempFolder);
  }

  // Get file extension from source
  const ext = path.extname(tempAudioPath) || '.webm';
  const baseFilename = `${year}-${month}-${day}_${hours}-${minutes}_${jobId}`;
  const audioPath = path.join(tempFolder, `${baseFilename}${ext}`);

  try {
    fs.copyFileSync(tempAudioPath, audioPath);
    console.log('Audio saved immediately to:', audioPath);
    savedAudioPathInBackup = audioPath; // Store for later deletion
    return audioPath;
  } catch (error) {
    console.error('Failed to save audio immediately:', error);
    return null;
  }
}

/**
 * Saves transcript and/or audio to the user's configured folder.
 * Files are organized by doctor name (from speaker recognition) in subfolders.
 * Both files share the same base filename for easy association.
 * @param {string} baseFolderPath - Base folder to save the files
 * @param {string} summary - Documentation/summary text
 * @param {string} transcript - Full transcript text
 * @param {Object} speakerMapping - Speaker mapping object
 * @param {Object} options - Save options
 * @param {string} options.tempAudioPath - Path to temporary audio file
 * @param {boolean} options.saveTranscript - Whether to save transcript
 * @param {boolean} options.saveAudio - Whether to save audio
 * @param {Object} options.shortenings - Shortenings from v1.2 hybrid mode
 */
function saveRecordingFiles(baseFolderPath, summary, transcript, speakerMapping = null, options = {}) {
  const { tempAudioPath = null, saveTranscript = true, saveAudio = false, shortenings = null } = options;

  // Nothing to save
  if (!saveTranscript && !saveAudio) {
    return;
  }

  // Extract unique job ID from temp audio filename (e.g., "recording-1705312345678.webm" -> "1705312345678")
  let jobId = Date.now().toString(); // Fallback if no temp audio path
  if (tempAudioPath) {
    const tempFilename = path.basename(tempAudioPath, path.extname(tempAudioPath));
    jobId = tempFilename.replace('recording-', '');
  }

  // Create filename with date and time + job ID for uniqueness
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

  // Create base filename: YYYY-MM-DD_HH-MM_JobID_[Names]
  let filenameSuffix = nameParts.length > 0 ? nameParts.join('_') : 'Unbekannt';
  const baseFilename = `${year}-${month}-${day}_${hours}-${minutes}_${jobId}_${filenameSuffix}`;

  // Build shortenings section if available
  let shorteningsSection = '';
  if (shortenings) {
    const shorteningParts = [];
    if (shortenings.keywords90) {
      shorteningParts.push(`── Stichworte (90% kürzer) ──\n\n${shortenings.keywords90}`);
    }
    if (shortenings.chef70) {
      shorteningParts.push(`── Chef Ultra (70% kürzer) ──\n\n${shortenings.chef70}`);
    }
    if (shortenings.chef50) {
      shorteningParts.push(`── Chef (50% kürzer) ──\n\n${shortenings.chef50}`);
    }
    if (shortenings.pvs40) {
      shorteningParts.push(`── PVS (40% kürzer) ──\n\n${shortenings.pvs40}`);
    }
    if (shortenings.zfa30) {
      shorteningParts.push(`── ZFA (30% kürzer) ──\n\n${shortenings.zfa30}`);
    }
    if (shortenings.normalized) {
      shorteningParts.push(`── Normalisiert (sprachlich optimiert) ──\n\n${shortenings.normalized}`);
    }
    if (shorteningParts.length > 0) {
      shorteningsSection = `

────────────────────────────────────────────────────────────────────
  KÜRZUNGEN
────────────────────────────────────────────────────────────────────

${shorteningParts.join('\n\n')}
`;
    }
  }

  // Create file content for transcript
  const content = `╔════════════════════════════════════════════════════════════════════╗
║                          DENTDOC TRANSKRIPT                        ║
╚════════════════════════════════════════════════════════════════════╝

Datum:    ${now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Uhrzeit:  ${now.toLocaleTimeString('de-DE')}

────────────────────────────────────────────────────────────────────
  ZUSAMMENFASSUNG
────────────────────────────────────────────────────────────────────

${summary}
${shorteningsSection}

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

  // Save files to each target folder
  targetFolders.forEach(folderPath => {
    // Ensure folder exists
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Save transcript if enabled
    if (saveTranscript) {
      const transcriptPath = path.join(folderPath, `${baseFilename}.txt`);
      fs.writeFileSync(transcriptPath, content, 'utf8');
      console.log('Transcript saved to:', transcriptPath);
    }

    // Save audio if enabled and source exists
    if (saveAudio) {
      console.log('saveAudio is true, tempAudioPath:', tempAudioPath);
      if (tempAudioPath) {
        console.log('tempAudioPath exists check:', fs.existsSync(tempAudioPath));
        if (fs.existsSync(tempAudioPath)) {
          // Use actual file extension from source (wav, webm, etc.)
          const audioExt = path.extname(tempAudioPath) || '.wav';
          const audioPath = path.join(folderPath, `${baseFilename}${audioExt}`);
          fs.copyFileSync(tempAudioPath, audioPath);
          console.log('Audio saved to:', audioPath);
        } else {
          console.log('Audio file does not exist at:', tempAudioPath);
        }
      } else {
        console.log('tempAudioPath is null or undefined');
      }
    } else {
      console.log('saveAudio is false, skipping audio save');
    }
  });

  // Delete backup audio from "Fehlgeschlagen" folder after successful transcription
  // This happens regardless of saveAudio setting - backup is always cleaned up on success
  if (savedAudioPathInBackup && fs.existsSync(savedAudioPathInBackup)) {
    try {
      fs.unlinkSync(savedAudioPathInBackup);
      console.log('Deleted backup audio from Fehlgeschlagen folder:', savedAudioPathInBackup);
      savedAudioPathInBackup = null;
    } catch (err) {
      console.error('Failed to delete backup audio:', err);
    }
  }
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 480,
    height: 650,
    minHeight: 550,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    resizable: true,
    title: 'DentDoc Login',
    frame: false,
    hasShadow: false,
    backgroundColor: store.get('theme', 'dark') === 'light' ? '#ffffff' : '#0a0a0b'
  });

  loginWindow.loadFile('src/login.html');
  loginWindow.setMenu(null);

  // Auto-resize to fit content after load
  loginWindow.webContents.on('did-finish-load', () => {
    loginWindow.webContents.executeJavaScript('document.body.scrollHeight').then(height => {
      const [width] = loginWindow.getSize();
      loginWindow.setSize(width, Math.min(height, 800)); // Cap at 800px max
    });
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);

  // Don't set a static context menu - we'll show it dynamically on right-click
  // This allows us to refresh user data before showing the menu
  tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

  // Cooldown to prevent too many API calls
  let lastRefreshTime = 0;
  const REFRESH_COOLDOWN = 10000; // Only refresh every 10 seconds max

  // Right-click: Refresh data, then show menu
  tray.on('right-click', async () => {
    const token = store.get('authToken');
    const now = Date.now();

    // Refresh user data if logged in and cooldown has passed
    if (token && (now - lastRefreshTime) > REFRESH_COOLDOWN) {
      lastRefreshTime = now;
      await refreshUserData();
    }

    // Build and show menu with current data
    const menu = buildTrayMenu();
    tray.popUpContextMenu(menu);
  });

  // Left-click: Open dashboard window (or login if not authenticated)
  tray.on('click', () => {
    const token = store.get('authToken');
    if (token) {
      openLocalDashboard();
    } else {
      createLoginWindow();
    }
  });
}

// Build and return the tray menu (called dynamically on right-click)
function buildTrayMenu() {
  const token = store.get('authToken');
  const user = store.get('user');

  if (!token) {
    return Menu.buildFromTemplate([
      { label: 'Anmelden', click: () => createLoginWindow() },
      { type: 'separator' },
      { label: 'Beenden', click: () => app.quit() }
    ]);
  }

  const shortcut = store.get('shortcut') || 'F9';

  // Check subscription/trial status (matching web app logic)
  const hasActiveSubscription = user?.subscriptionStatus === 'active';
  const isCanceled = user?.subscriptionStatus === 'canceled';
  const minutesRemaining = user?.minutesRemaining || 0;

  // Distinguish between true trial users and ex-subscribers
  // Ex-subscriber: has stripeCustomerId (was once a paying customer) or subscription is canceled
  const wasSubscriber = isCanceled || (user?.planTier === 'free_trial' && user?.stripeCustomerId);
  const isRealTrial = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining > 0;
  const trialExpired = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

  // No active subscription (either trial expired or was subscriber)
  const noActiveSubscription = !hasActiveSubscription && (trialExpired || wasSubscriber);

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
    // Disable if no active subscription
    if (noActiveSubscription) {
      recordingEnabled = false;
    }
  }

  // Build status label for trial/subscription (matching web app)
  let statusLabel;
  if (hasActiveSubscription) {
    statusLabel = `✓ DentDoc Pro (${user?.maxDevices || 1} Arbeitsplatz${(user?.maxDevices || 1) !== 1 ? 'e' : ''})`;
  } else if (isRealTrial) {
    statusLabel = `Testphase: ${minutesRemaining} Min übrig`;
  } else if (wasSubscriber) {
    // Was a subscriber but now canceled/expired - same as web app
    statusLabel = '⚠️ KEIN AKTIVES ABO';
  } else if (trialExpired) {
    // True trial user who never subscribed
    statusLabel = '⚠️ TESTPHASE BEENDET';
  } else {
    statusLabel = 'Kein aktives Abo';
  }

  return Menu.buildFromTemplate([
    // Status display - clickable if trial expired to open subscription page
    {
      label: statusLabel,
      enabled: trialExpired ? true : false,
      click: trialExpired ? () => openWebDashboard('/subscription') : undefined,
    },
    // If trial expired or no subscription, show upgrade link
    ...(trialExpired || (!hasActiveSubscription && !isRealTrial) ? [{
      label: '🛒 JETZT ABO KAUFEN →',
      click: () => {
        openWebDashboard('/subscription');
      }
    }] : []),
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
    {
      label: 'Audio-Datei transkribieren...',
      enabled: !isRecording && !isProcessing && !noActiveSubscription,
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
      label: 'App öffnen',
      click: () => {
        openLocalDashboard();
      }
    },
    { type: 'separator' },
    {
      label: 'Abmelden',
      click: async () => {
        const token = store.get('authToken');
        // Stop heartbeat
        stopHeartbeat();
        // Logout from server (free device slot)
        if (token) {
          await apiClient.logout(token, store);
        }
        store.delete('authToken');
        store.delete('user');

        // Close dashboard window
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.destroy();
        }

        showCustomNotification('Abgemeldet', 'Sie wurden erfolgreich abgemeldet', 'info');

        // Show login window after logout
        createLoginWindow();
      }
    },
    { type: 'separator' },
    { label: 'Beenden', click: () => {
      app.isQuitting = true;
      app.quit();
    }},
    { type: 'separator' },
    { label: `v${app.getVersion()}`, enabled: false }
  ]);
}

// Legacy function for compatibility - just calls buildTrayMenu
function updateTrayMenu() {
  // No longer sets a static menu - menu is built dynamically on right-click
  // This function is kept for compatibility with other code that calls it
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

  // Set currentRecordingPath so audio can be saved if keepAudio is enabled
  currentRecordingPath = audioFilePath;

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

  updateStatusOverlay('Verarbeitung...', 'Audio wird gesendet...', 'processing', { step: 1, uploadProgress: 0 });

  try {
    // Upload audio with progress tracking
    const onProgress = (progressInfo) => {
      if (progressInfo.phase === 'upload') {
        // Direct 0-100% display - no more confusing scaling
        updateStatusOverlay(
          'Verarbeitung...',
          `Audio wird hochgeladen... ${progressInfo.percent}%`,
          'processing',
          { step: 1, uploadProgress: progressInfo.percent }
        );
      } else if (progressInfo.phase === 'submit') {
        // Backend is starting transcription
        updateStatusOverlay(
          'Verarbeitung...',
          'Transkription wird gestartet...',
          'processing',
          { step: 1, uploadProgress: 100 }
        );
      } else if (progressInfo.phase === 'submitted') {
        updateStatusOverlay(
          'Verarbeitung...',
          'Audio übermittelt',
          'processing',
          { step: 1, uploadProgress: 100 }
        );
      }
    };
    const transcriptionId = await apiClient.uploadAudio(audioFilePath, token, onProgress);

    // Poll for real transcription status from AssemblyAI
    let transcriptionResult;
    let attempts = 0;
    const maxAttempts = 180; // 3 minutes max (180 * 1 second)
    let lastStatus = '';

    while (attempts < maxAttempts) {
      transcriptionResult = await apiClient.getTranscriptionStatus(transcriptionId, token);

      // Update UI with real status (user-friendly messages)
      if (transcriptionResult.status !== lastStatus) {
        lastStatus = transcriptionResult.status;

        if (transcriptionResult.status === 'queued') {
          updateStatusOverlay('Verarbeitung...', 'Warte auf Verarbeitung...', 'processing', { step: 2 });
        } else if (transcriptionResult.status === 'processing') {
          updateStatusOverlay('Verarbeitung...', 'Sprache wird erkannt...', 'processing', { step: 2 });
        }
      }

      if (transcriptionResult.status === 'completed') {
        updateStatusOverlay('Verarbeitung...', 'Sprache erkannt', 'processing', { step: 2 });
        break;
      } else if (transcriptionResult.status === 'error') {
        throw new Error(transcriptionResult.error || 'Transkription fehlgeschlagen');
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every 1 second
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Zeitüberschreitung bei der Transkription');
    }

    const transcript = transcriptionResult.transcriptText;

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

        // Store optimization data if there are unrecognized speakers
        const hasUnrecognized = Object.values(currentSpeakerMapping).some(
          label => label.startsWith('Sprecher ')
        );

        if (hasUnrecognized) {
          // Store data for potential speaker optimization
          // Note: optimizationSession is set by IPC handler, but we prepare the data here

          // Copy audio file to last-recording.wav for optimization
          // This ensures the audio is available until the next recording
          const tempDir = path.join(app.getPath('temp'), 'dentdoc');
          const lastRecordingPath = path.join(tempDir, 'last-recording.wav');

          try {
            // Ensure temp directory exists
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }

            // Copy current recording to last-recording.wav
            if (fs.existsSync(audioFilePath)) {
              fs.copyFileSync(audioFilePath, lastRecordingPath);
              debugLog(`[SpeakerOptimization] Audio copied to ${lastRecordingPath}`);
            }
          } catch (copyError) {
            console.error('Failed to copy audio for optimization:', copyError);
            debugLog(`[SpeakerOptimization] Failed to copy audio: ${copyError.message}`);
          }

          const optimizationData = {
            transcriptionId,
            audioFilePath: lastRecordingPath, // Use the persisted path
            utterances,
            speakerMapping: currentSpeakerMapping
          };
          // Store temporarily for the status overlay to access
          global.pendingOptimizationData = optimizationData;
          debugLog(`[SpeakerOptimization] ${Object.values(currentSpeakerMapping).filter(l => l.startsWith('Sprecher ')).length} unrecognized speakers - optimization available`);
        }
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
    } else if (docMode === 'hybrid-v1.2') {
      // Hybrid V1.2: 1 API call, 60% cost savings
      updateStatusOverlay('Dokumentation...', 'Hybrid-KI verarbeitet...', 'processing', { step: 4 });
      result = await apiClient.getDocumentationV1_2(transcriptionId, token);
    } else if (docMode === 'single-v1.1') {
      // Single Prompt V1.1: Use experimental endpoint
      updateStatusOverlay('Dokumentation wird erstellt...', 'KI generiert Zusammenfassung (V1.1)...', 'processing', { step: 4 });
      result = await apiClient.getDocumentationV1_1(transcriptionId, token);
    } else if (docMode === 'megaprompt') {
      // Megaprompt: 7-Step Pipeline mit paralleler Extraktion
      updateStatusOverlay('Dokumentation wird erstellt...', 'Megaprompt-Pipeline verarbeitet (7 Schritte)...', 'processing', { step: 4 });
      result = await apiClient.getDocumentationMegaprompt(transcriptionId, token);
    } else {
      // Single Prompt: Use standard endpoint
      updateStatusOverlay('Dokumentation wird erstellt...', 'KI generiert Zusammenfassung...', 'processing', { step: 4 });
      result = await apiClient.getDocumentation(transcriptionId, token);
    }

    const documentation = result.documentation;
    const finalTranscript = result.transcript || transcript;
    const shortenings = result.shortenings || null;

    // Store for "show last result"
    lastDocumentation = documentation;
    lastTranscript = finalTranscript;
    lastShortenings = shortenings;
    store.set('lastDocumentationTime', new Date().toISOString());

    // Copy to clipboard
    clipboard.writeText(documentation);

    // Auto-save transcript and/or audio if enabled
    const autoExport = store.get('autoExport', true);
    const keepAudio = store.get('keepAudio', false);
    console.log('Save settings - autoExport:', autoExport, 'keepAudio:', keepAudio);
    console.log('currentRecordingPath:', currentRecordingPath);
    const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
    const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;
    if ((autoExport || keepAudio) && finalTranscript) {
      try {
        saveRecordingFiles(transcriptPath, documentation, finalTranscript, currentSpeakerMapping, {
          tempAudioPath: currentRecordingPath,
          saveTranscript: autoExport,
          saveAudio: keepAudio,
          shortenings: shortenings
        });
      } catch (error) {
        console.error('Failed to save recording files:', error);
      }
    }

    isProcessing = false;
    updateTrayMenu();

    // Increment today's recording count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString().split('T')[0];
    const todayRecordings = store.get('todayRecordings', { date: null, count: 0 });
    if (todayRecordings.date === todayStr) {
      store.set('todayRecordings', { date: todayStr, count: todayRecordings.count + 1 });
    } else {
      store.set('todayRecordings', { date: todayStr, count: 1 });
    }

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    const autoClose = store.get('autoCloseOverlay', false);
    updateStatusOverlay(
      'Fertig!',
      'Dokumentation in Zwischenablage kopiert (Strg+V)',
      'success',
      { documentation, transcript: finalTranscript, shortenings, autoClose }
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

    // Notify dashboard to refresh stats
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-completed');
    }

  } catch (error) {
    console.error('Audio file processing error:', error);
    debugLog('Audio file processing error: ' + error.message);

    // Only delete temporary audio for "no speech detected" error
    // For other errors, keep the audio as backup in "Fehlgeschlagen" folder
    if (error.message && error.message.includes('Keine Sprache erkannt')) {
      if (savedAudioPathInBackup && fs.existsSync(savedAudioPathInBackup)) {
        try {
          fs.unlinkSync(savedAudioPathInBackup);
          console.log('Deleted backup audio from Fehlgeschlagen folder (no speech detected):', savedAudioPathInBackup);
          savedAudioPathInBackup = null;
        } catch (err) {
          console.error('Failed to delete temporary audio:', err);
        }
      }
    } else if (savedAudioPathInBackup) {
      console.log('Keeping backup audio in Fehlgeschlagen folder:', savedAudioPathInBackup);
      savedAudioPathInBackup = null; // Reset variable but keep file
    }

    isProcessing = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    // Categorize errors for better UX
    let errorTitle = 'Fehler';
    let errorMessage = error.message || 'Unbekannter Fehler';

    if (error.message.startsWith('TRIAL_EXPIRED:')) {
      errorTitle = 'Testphase beendet';
      errorMessage = error.message.substring('TRIAL_EXPIRED:'.length);
      // Open dashboard for subscription
      setTimeout(() => openWebDashboard(), 2000);
    } else if (error.message.startsWith('SUBSCRIPTION_INACTIVE:')) {
      errorTitle = 'Abonnement inaktiv';
      errorMessage = error.message.substring('SUBSCRIPTION_INACTIVE:'.length);
      // Open dashboard for subscription
      setTimeout(() => openWebDashboard(), 2000);
    } else if (error.message.includes('Keine Sprache erkannt')) {
      errorTitle = 'Keine Sprache erkannt';
      errorMessage = 'Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.<br><a href="#" class="settings-link" data-action="open-microphone-settings">Mikrofon-Einstellungen überprüfen →</a>';
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

  // Fetch fresh user data from server to check trial/subscription status
  let user = store.get('user');
  try {
    const freshUser = await apiClient.getUser(token);
    if (freshUser) {
      user = freshUser;
      store.set('user', freshUser);
      updateTrayMenu();
    }
  } catch (e) {
    console.log('Could not fetch fresh user data, using cached:', e.message);
  }

  // Check trial/subscription status before recording
  const isTrialUser = user?.planTier === 'free_trial';
  const hasActiveSubscription = user?.subscriptionStatus === 'active';
  const minutesRemaining = user?.minutesRemaining ?? 0;

  console.log('Recording check - planTier:', user?.planTier, 'subscriptionStatus:', user?.subscriptionStatus, 'minutesRemaining:', minutesRemaining);

  if (isTrialUser && minutesRemaining <= 0 && !hasActiveSubscription) {
    updateStatusOverlay('Testphase beendet', 'Bitte abonnieren Sie DentDoc Pro um fortzufahren.', 'error');
    return;
  }

  // Get keepAudio setting - cleanup is handled by audioRecorder
  // keepAudio: false (default) = delete recordings, true = keep them
  const keepAudio = store.get('keepAudio', false);
  const deleteAudio = !keepAudio;
  console.log('keepAudio setting:', keepAudio, '-> deleteAudio:', deleteAudio);
  debugLog(`keepAudio setting: ${keepAudio} -> deleteAudio: ${deleteAudio}`);

  try {
    // Check if recorder is busy (e.g., mic test running)
    const recorderState = audioRecorder.getState();
    if (recorderState !== 'idle') {
      console.log('Recorder busy with state:', recorderState, '- stopping first');
      try {
        await audioRecorder.stopRecording();
      } catch (e) {
        console.warn('Could not stop existing recording:', e.message);
        await audioRecorder.forceStop();
      }
    }

    isRecording = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft...');

    // Get selected microphone (browser device ID)
    const microphoneId = store.get('microphoneId') || null;
    currentRecordingPath = await audioRecorder.startRecording(deleteAudio, microphoneId);

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('Aufnahme läuft...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    // Notify dashboard to start audio monitoring (for real level display in status overlay)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-started', { microphoneId });
    }
  } catch (error) {
    console.error('Recording error:', error);
    updateStatusOverlay('Fehler', 'Aufnahme konnte nicht gestartet werden', 'error');
    isRecording = false;
    updateTrayMenu();
  }
}

async function stopRecording() {
  // Notify dashboard to stop audio monitoring immediately
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('recording-stopped');
  }

  try {
    tray.setToolTip('DentDoc - Verarbeite Aufnahme...');

    await audioRecorder.stopRecording();
    isRecording = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);

    // Save audio immediately (before transcription) so it's preserved if something fails
    saveAudioImmediately(currentRecordingPath);

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

function showNotification(title, body, onClick = null) {
  const notification = new Notification({
    title,
    body,
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  if (onClick) {
    notification.on('click', onClick);
  }

  notification.show();
}

// Custom notification popup window (styled like status overlay)
let notificationPopupWindow = null;
let notificationClickCallback = null;

function showCustomNotification(title, body, type = 'warning', onClick = null) {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  // Close existing popup if any
  if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
    notificationPopupWindow.close();
  }

  notificationClickCallback = onClick;

  notificationPopupWindow = new BrowserWindow({
    width: 380,
    height: 160,
    x: workArea.x + workArea.width - 400,
    y: workArea.y + workArea.height - 180,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  notificationPopupWindow.loadFile('src/notification-popup.html');

  notificationPopupWindow.webContents.on('did-finish-load', () => {
    // Check if window still exists (could be closed rapidly)
    if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
      notificationPopupWindow.webContents.send('show-notification', {
        title,
        body,
        type,
        hasClickAction: !!onClick
      });
    }
  });

  notificationPopupWindow.on('closed', () => {
    notificationPopupWindow = null;
    notificationClickCallback = null;
  });
}

// IPC handlers for notification popup
ipcMain.on('close-notification-popup', () => {
  if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
    notificationPopupWindow.close();
  }
});

ipcMain.on('notification-popup-clicked', () => {
  if (notificationClickCallback) {
    notificationClickCallback();
  }
  if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
    notificationPopupWindow.close();
  }
});

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

// Deterministic overlay size based on state (main process controls size, not renderer)
function getOverlaySizeForState(type, extra = {}) {
  switch (type) {
    case 'recording':
      return { width: 402, height: 96 };

    case 'processing':
      return { width: 402, height: 151 };

    case 'success':
      // Smaller height if no shortenings (e.g., "Letzte Dokumentation anzeigen")
      const hasShorts = extra.shortenings && Object.keys(extra.shortenings).length > 0;
      return { width: 402, height: hasShorts ? 417 : 277 };

    case 'error':
      return { width: 402, height: 141 };

    default:
      return { width: 402, height: 121 };
  }
}

function createStatusOverlay() {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    return statusOverlay;
  }

  // Reset ready state when creating new overlay
  statusOverlayReady = false;

  const position = getValidOverlayPosition();

  statusOverlay = new BrowserWindow({
    width: 10,   // Start small, will be resized dynamically
    height: 10,  // Start small, will be resized dynamically
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: false, // Don't steal focus from other apps (prevents double-click issue)
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusOverlay.loadFile('src/status-overlay.html');
  statusOverlay.setVisibleOnAllWorkspaces(true);
  statusOverlay.setAlwaysOnTop(true, 'screen-saver'); // Höhere Priorität

  // Make statusOverlay globally available for audio level updates
  global.statusOverlay = statusOverlay;

  // Mark overlay as ready once loaded and send any pending status
  statusOverlay.webContents.on('did-finish-load', () => {
    statusOverlayReady = true;
    if (pendingStatusUpdate) {
      statusOverlay.webContents.send('update-status', pendingStatusUpdate);
      pendingStatusUpdate = null;
    }
  });

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

  // Set correct size for this state (pass extra for success size calculation)
  const { width, height } = getOverlaySizeForState(type, extra);
  overlay.setSize(width, height, false);

  const statusData = {
    title,
    message,
    type,
    step: extra.step || null,
    uploadProgress: extra.uploadProgress,
    documentation: extra.documentation || null,
    transcript: extra.transcript || null,
    shortenings: extra.shortenings || null
  };

  // Store the data to send
  pendingStatusUpdate = statusData;

  // If overlay is ready, send immediately
  if (statusOverlayReady && overlay.webContents && !overlay.webContents.isDestroyed()) {
    overlay.webContents.send('update-status', statusData);
    pendingStatusUpdate = null;
  }
  // Otherwise the did-finish-load handler will send it

  overlay.show();
  overlay.setAlwaysOnTop(true, 'screen-saver');

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
  if (!statusOverlay || statusOverlay.isDestroyed()) return;

  // DESTROY instead of hide - prevents zombie window with cached bounds
  statusOverlay.destroy();
  statusOverlay = null;
  statusOverlayReady = false;
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
      transcript: lastTranscript,
      shortenings: lastShortenings
    }
  );
}

// IPC handler for closing status overlay
ipcMain.on('close-status-overlay', () => {
  hideStatusOverlay();
});

// IPC handler removed - main already sets size in updateStatusOverlay()
// The renderer notification is no longer needed

// IPC handler for opening microphone settings from error overlay
ipcMain.on('open-microphone-settings', () => {
  hideStatusOverlay();
  openLocalDashboard();
  setTimeout(() => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('switch-view', 'settings');
    }
  }, 500);
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

// Theme handlers
ipcMain.handle('get-theme', () => {
  return store.get('theme', 'dark');
});

ipcMain.handle('set-theme', (event, theme) => {
  store.set('theme', theme);
  return true;
});

// Dashboard statistics handlers
ipcMain.handle('get-dashboard-stats', () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Get today's recordings count from store
  const todayRecordings = store.get('todayRecordings', { date: null, count: 0 });
  const todayStr = todayStart.toISOString().split('T')[0];

  // Reset count if it's a new day
  const count = todayRecordings.date === todayStr ? todayRecordings.count : 0;

  // Get profile count
  const profiles = voiceProfiles.getAllProfiles();
  const profileCount = profiles.length;

  // Get bausteine count
  const bausteine = bausteineManager.getAllBausteine();
  const bausteineCount = bausteine.length;

  return {
    todayRecordings: count,
    profileCount,
    bausteineCount
  };
});

ipcMain.handle('increment-recording-count', () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStr = todayStart.toISOString().split('T')[0];

  const todayRecordings = store.get('todayRecordings', { date: null, count: 0 });

  // Reset count if it's a new day, otherwise increment
  if (todayRecordings.date === todayStr) {
    store.set('todayRecordings', { date: todayStr, count: todayRecordings.count + 1 });
  } else {
    store.set('todayRecordings', { date: todayStr, count: 1 });
  }

  return true;
});

// Get user info for dashboard
ipcMain.handle('get-user', () => {
  return store.get('user', null);
});

// Get subscription status for dashboard sidebar (same logic as tray menu)
ipcMain.handle('get-subscription-status', () => {
  const user = store.get('user');
  const token = store.get('authToken');

  if (!token || !user) {
    return { label: 'Nicht angemeldet', type: 'error' };
  }

  // Check subscription/trial status (matching web app and tray menu logic)
  const hasActiveSubscription = user?.subscriptionStatus === 'active';
  const isCanceled = user?.subscriptionStatus === 'canceled';
  const minutesRemaining = user?.minutesRemaining || 0;

  // Distinguish between true trial users and ex-subscribers
  const wasSubscriber = isCanceled || (user?.planTier === 'free_trial' && user?.stripeCustomerId);
  const isRealTrial = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining > 0;
  const trialExpired = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

  let label;
  let type; // 'success', 'warning', 'error', 'trial'

  if (hasActiveSubscription) {
    label = `DentDoc Pro (${user?.maxDevices || 1} Arbeitsplatz${(user?.maxDevices || 1) !== 1 ? 'e' : ''})`;
    type = 'success';
  } else if (isRealTrial) {
    label = `Testphase: ${minutesRemaining} Min`;
    type = 'trial';
  } else if (wasSubscriber) {
    label = 'KEIN AKTIVES ABO';
    type = 'error';
  } else if (trialExpired) {
    label = 'TESTPHASE BEENDET';
    type = 'error';
  } else {
    label = 'Kein aktives Abo';
    type = 'warning';
  }

  return { label, type };
});

// Get subscription details with device info for dashboard
ipcMain.handle('get-subscription-details', async () => {
  const user = store.get('user');
  const token = store.get('authToken');
  const currentDeviceId = store.get('deviceId');

  if (!token || !user) {
    return {
      status: { type: 'error', label: 'Nicht angemeldet' },
      planName: '-',
      expiresAt: null,
      activeDevices: 0,
      maxDevices: 0,
      currentDeviceId: null,
      devices: []
    };
  }

  // Determine subscription status (same logic as get-subscription-status)
  const hasActiveSubscription = user?.subscriptionStatus === 'active';
  const isCanceled = user?.subscriptionStatus === 'canceled';
  const minutesRemaining = user?.minutesRemaining || 0;
  const wasSubscriber = isCanceled || (user?.planTier === 'free_trial' && user?.stripeCustomerId);
  const isRealTrial = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining > 0;
  const trialExpired = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

  let statusType, statusLabel;
  if (hasActiveSubscription) {
    statusLabel = 'Aktiv';
    statusType = 'success';
  } else if (isRealTrial) {
    statusLabel = `Testphase: ${minutesRemaining} Min`;
    statusType = 'trial';
  } else if (wasSubscriber) {
    statusLabel = 'Kein aktives Abo';
    statusType = 'error';
  } else if (trialExpired) {
    statusLabel = 'Testphase beendet';
    statusType = 'error';
  } else {
    statusLabel = 'Kein aktives Abo';
    statusType = 'warning';
  }

  // Fetch device sessions and subscription info from backend API
  let devices = [];
  let activeDevices = 0;
  let maxDevices = user?.maxDevices || 1;
  let monthlyAmount = null;
  let currentPeriodEnd = user?.currentPeriodEnd || null;

  try {
    const axios = require('axios');
    const API_BASE_URL = apiClient.getBaseUrl();

    // Fetch device sessions
    const sessionsResponse = await axios.get(`${API_BASE_URL}api/device/sessions`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Cookie': `session=${token}`
      }
    });

    if (sessionsResponse.data) {
      activeDevices = sessionsResponse.data.activeCount || 0;
      maxDevices = sessionsResponse.data.maxDevices || user?.maxDevices || 1;
      devices = (sessionsResponse.data.sessions || []).map(session => ({
        id: session.deviceId,
        name: session.deviceName || 'Unbenanntes Gerät',
        lastSeenAt: session.lastHeartbeatAt
      }));
    }

  } catch (error) {
    console.error('Error fetching subscription data:', error.message);
    // Fall back to user data
    activeDevices = 1; // At least this device
  }

  // Determine plan name (include device count for active subscriptions)
  let planName = 'Kein aktives Abonnement';
  if (hasActiveSubscription) {
    const basePlanName = user?.planName || 'DentDoc Pro';
    const deviceCount = maxDevices || user?.maxDevices || 1;
    planName = `${basePlanName} (${deviceCount} Arbeitsplatz${deviceCount !== 1 ? 'e' : ''})`;
  } else if (isRealTrial) {
    planName = 'Testphase';
  }

  return {
    status: { type: statusType, label: statusLabel },
    planName,
    expiresAt: currentPeriodEnd,
    activeDevices,
    maxDevices,
    currentDeviceId,
    devices,
    monthlyAmount
  };
});

// Get last documentation for dashboard
ipcMain.handle('get-last-documentation', () => {
  if (!lastDocumentation) {
    return null;
  }
  return {
    documentation: lastDocumentation,
    transcript: lastTranscript,
    timestamp: store.get('lastDocumentationTime', null)
  };
});

// Show last result (opens status overlay)
ipcMain.handle('show-last-result', () => {
  showLastResult();
  return true;
});

// Get base URL for external links
ipcMain.handle('get-base-url', () => {
  return apiClient.getBaseUrl().replace(/\/$/, '');
});

// Open external URL
ipcMain.handle('open-external-url', (event, url) => {
  shell.openExternal(url);
  return true;
});

// Get current shortcut for dashboard display
ipcMain.handle('get-shortcut', () => {
  return store.get('shortcut', 'F9');
});

// Recording control from dashboard
ipcMain.handle('toggle-recording', async () => {
  if (isRecording) {
    await stopRecording();
    return { recording: false };
  } else {
    await startRecording();
    return { recording: true };
  }
});

ipcMain.handle('get-recording-state', () => {
  return { isRecording, isProcessing };
});

// Onboarding tour handlers (supports multiple tours: 'login', 'settings', etc.)
ipcMain.handle('check-first-run', (event, tourId = 'general') => {
  const tourKey = `tourCompleted_${tourId}`;
  const tourCompleted = store.get(tourKey, false);
  return !tourCompleted;
});

ipcMain.handle('mark-tour-completed', (event, tourId = 'general') => {
  const tourKey = `tourCompleted_${tourId}`;
  store.set(tourKey, true);
  return true;
});

ipcMain.handle('reset-tour', (event, tourId = 'general') => {
  const tourKey = `tourCompleted_${tourId}`;
  store.set(tourKey, false);
  return true;
});

ipcMain.handle('reset-all-tours', () => {
  store.delete('tourCompleted_login');
  store.delete('tourCompleted_settings');
  store.delete('tourCompleted_general');
  store.delete('tourCompleted_setup-wizard');
  store.delete('tourCompleted_dashboard');
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

// Minimize dashboard to tray (hide instead of minimize)
ipcMain.on('minimize-to-tray', () => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.hide();
  }
});

// Start heartbeat to keep device session active
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Send heartbeat every 5 minutes (just to keep session alive)
  heartbeatInterval = setInterval(async () => {
    const token = store.get('authToken');
    if (!token) {
      stopHeartbeat();
      return;
    }

    const isValid = await apiClient.heartbeat(token, store);
    if (!isValid) {
      // Session expired - device was logged out remotely
      console.log('Session expired - logging out locally');
      stopHeartbeat();
      store.delete('authToken');
      store.delete('user');
      updateTrayMenu();
      showNotification('Sitzung beendet', 'Sie wurden von einem anderen Gerät abgemeldet.');
      createLoginWindow();
    }
  }, 5 * 60 * 1000); // 5 minutes

  // Also send immediate heartbeat on start
  const token = store.get('authToken');
  if (token) {
    apiClient.heartbeat(token, store).catch(console.error);
  }
}

// Refresh user data and check for subscription changes
async function refreshUserData() {
  const token = store.get('authToken');
  if (!token) return;

  try {
    const oldUser = store.get('user');
    const newUser = await apiClient.getUser(token);
    if (newUser) {
      store.set('user', newUser);

      // Check if subscription status changed (e.g., user just subscribed)
      const wasTrialExpired = oldUser?.planTier === 'free_trial' && (oldUser?.minutesRemaining || 0) <= 0 && oldUser?.subscriptionStatus !== 'active';
      const isNowActive = newUser.subscriptionStatus === 'active';

      if (wasTrialExpired && isNowActive) {
        // User just subscribed! Show notification
        showNotification(
          '🎉 Willkommen bei DentDoc Pro!',
          `Ihr Abonnement ist jetzt aktiv. Sie können unbegrenzt dokumentieren.`
        );
      }

      updateTrayMenu();
    }
  } catch (e) {
    console.log('Could not refresh user data:', e.message);
  }
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// IPC Handlers for login window
ipcMain.handle('resize-login-window', (event, height) => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    const [width] = loginWindow.getSize();
    loginWindow.setSize(width, Math.min(height, 800));
  }
});

ipcMain.handle('login', async (event, email, password) => {
  try {
    const response = await apiClient.login(email, password, store);
    store.set('authToken', response.token);
    store.set('user', response.user);
    updateTrayMenu();

    // Start heartbeat
    startHeartbeat();

    if (loginWindow) {
      loginWindow.close();
    }

    // Open the dashboard after successful login
    openLocalDashboard();

    // Check trial/subscription status and show appropriate notification
    const user = response.user;
    const isTrialUser = user?.planTier === 'free_trial';
    const hasActiveSubscription = user?.subscriptionStatus === 'active';
    const isCanceled = user?.subscriptionStatus === 'canceled';
    const minutesRemaining = user?.minutesRemaining || 0;

    // Distinguish between true trial users and ex-subscribers
    const wasSubscriber = isCanceled || (isTrialUser && user?.stripeCustomerId);
    const trialExpired = isTrialUser && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

    if (wasSubscriber && !hasActiveSubscription) {
      // Ex-subscriber - show "no active subscription" notification (no auto-redirect)
      showCustomNotification(
        'Kein aktives Abo',
        'Ihr Abonnement ist nicht mehr aktiv. Klicken Sie hier um es zu reaktivieren.',
        'error',
        () => openWebDashboard('/subscription')
      );
    } else if (trialExpired) {
      // True trial expired - show notification (no auto-redirect)
      showCustomNotification(
        'Testphase beendet',
        'Ihre kostenlosen Testminuten sind aufgebraucht. Klicken Sie hier für ein Abo.',
        'error',
        () => openWebDashboard('/subscription')
      );
    } else if (isTrialUser && !wasSubscriber && minutesRemaining > 0 && minutesRemaining <= 10) {
      // Trial running low
      showCustomNotification(
        'Testphase endet bald',
        `Nur noch ${minutesRemaining} Minuten übrig. Jetzt Abo kaufen!`,
        'warning',
        () => openWebDashboard('/subscription')
      );
    } else if (hasActiveSubscription) {
      // Pro user
      showCustomNotification('Angemeldet', `Willkommen! DentDoc Pro (${user?.maxDevices || 1} Arbeitsplatz${(user?.maxDevices || 1) !== 1 ? 'e' : ''})`, 'success');
    } else {
      // Normal welcome
      showCustomNotification('Angemeldet', `Willkommen ${response.user.email}!`, 'success');
    }

    return { success: true };
  } catch (error) {
    // Check for max devices error
    if (error.message.startsWith('MAX_DEVICES:')) {
      const message = error.message.substring('MAX_DEVICES:'.length);
      return { success: false, error: message, code: 'MAX_DEVICES' };
    }
    return { success: false, error: error.message };
  }
});

// IPC Handler for logout
ipcMain.handle('logout', async () => {
  const token = store.get('authToken');
  // Stop heartbeat
  stopHeartbeat();
  // Logout from server (free device slot)
  if (token) {
    await apiClient.logout(token, store);
  }
  store.delete('authToken');
  store.delete('user');

  // Close dashboard window
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.destroy();
  }

  showCustomNotification('Abgemeldet', 'Sie wurden erfolgreich abgemeldet', 'info');

  // Show login window after logout
  createLoginWindow();
});

// IPC Handlers for settings
// Get Windows audio devices (FFmpeg DirectShow)
ipcMain.handle('get-audio-devices', async () => {
  try {
    const devices = await audioRecorder.listAudioDevices();
    return devices;
  } catch (error) {
    console.error('Error listing audio devices:', error);
    return [];
  }
});

ipcMain.handle('get-settings', async () => {
  // Default paths in Documents folder
  const documentsPath = app.getPath('documents');
  const defaultTranscriptPath = path.join(documentsPath, 'DentDoc', 'Transkripte');
  const defaultProfilesPath = path.join(documentsPath, 'DentDoc', 'Stimmprofile');

  // Get stored paths - use null coalescing to preserve empty strings if intentionally set
  const storedTranscriptPath = store.get('transcriptPath');
  const storedProfilesPath = store.get('profilesPath');

  console.log('get-settings - stored transcriptPath:', storedTranscriptPath);
  console.log('get-settings - stored profilesPath:', storedProfilesPath);

  return {
    shortcut: store.get('shortcut') || 'F9',
    microphoneId: store.get('microphoneId') || null,      // Browser device ID (WebRTC)
    transcriptPath: storedTranscriptPath !== undefined && storedTranscriptPath !== '' ? storedTranscriptPath : defaultTranscriptPath,
    profilesPath: storedProfilesPath !== undefined && storedProfilesPath !== '' ? storedProfilesPath : defaultProfilesPath,
    autoClose: store.get('autoCloseOverlay', false),
    autoExport: store.get('autoExport', true),
    keepAudio: store.get('keepAudio', false),
    docMode: store.get('docMode', 'single'),
    theme: store.get('theme', 'dark')
  };
});

ipcMain.handle('save-settings', async (event, settings) => {
  console.log('save-settings called with:', JSON.stringify(settings, null, 2));

  // Save microphone (browser device ID for WebRTC)
  if (settings.microphoneId !== undefined) {
    store.set('microphoneId', settings.microphoneId);
    console.log('Saved microphoneId:', settings.microphoneId);
  }

  // Save transcript path
  if (settings.transcriptPath !== undefined) {
    console.log('Saving transcriptPath:', settings.transcriptPath);
    store.set('transcriptPath', settings.transcriptPath);
  }

  // Save profiles path
  if (settings.profilesPath !== undefined) {
    store.set('profilesPath', settings.profilesPath);
    // Reload voice profiles with new path
    const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
    console.log('[save-settings] Setting profiles path to:', settings.profilesPath);
    voiceProfiles.setStorePath(settings.profilesPath);
    console.log('[save-settings] New store path:', voiceProfiles.getStorePath());
    console.log('[save-settings] Profiles at new path:', voiceProfiles.getAllProfiles().length);
  }

  // Save auto-close setting
  if (settings.autoClose !== undefined) {
    store.set('autoCloseOverlay', settings.autoClose);
  }

  // Save auto-export setting
  if (settings.autoExport !== undefined) {
    store.set('autoExport', settings.autoExport);
  }

  // Save keep audio setting
  if (settings.keepAudio !== undefined) {
    store.set('keepAudio', settings.keepAudio);
  }

  // Save documentation mode
  if (settings.docMode !== undefined) {
    store.set('docMode', settings.docMode);
  }

  // Save theme
  if (settings.theme !== undefined) {
    store.set('theme', settings.theme);
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

// =============================================================================
// PRAXIS-EINSTELLUNGEN API (V1.2 Textbausteine)
// =============================================================================

ipcMain.handle('get-token', () => {
  return store.get('authToken');
});

ipcMain.handle('api-get-praxis-einstellungen', async (event, token) => {
  console.log('[Praxis-Einstellungen] GET called, token:', token ? 'present' : 'missing');
  try {
    const result = await apiClient.getPraxisEinstellungen(token);
    console.log('[Praxis-Einstellungen] GET result:', JSON.stringify(result).substring(0, 200));
    return result;
  } catch (error) {
    console.error('[Praxis-Einstellungen] GET error:', error.message);
    return { error: error.message };
  }
});

ipcMain.handle('api-add-textbaustein', async (event, token, key, text) => {
  try {
    const result = await apiClient.addTextbaustein(token, key, text);
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('api-remove-textbaustein', async (event, token, key) => {
  try {
    const result = await apiClient.removeTextbaustein(token, key);
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('api-reset-praxis-einstellungen', async (event, token) => {
  try {
    const result = await apiClient.resetPraxisEinstellungen(token);
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('api-add-themen-anpassung', async (event, token, themenAnpassung) => {
  try {
    const result = await apiClient.addThemenAnpassung(token, themenAnpassung);
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('api-remove-themen-anpassung', async (event, token, thema) => {
  try {
    const result = await apiClient.removeThemenAnpassung(token, thema);
    return result;
  } catch (error) {
    return { error: error.message };
  }
});

// Generic update for Praxis-Einstellungen (new V2 format)
ipcMain.handle('api-update-praxis-einstellungen', async (event, token, updates) => {
  try {
    const result = await apiClient.updatePraxisEinstellungen(token, updates);
    return result;
  } catch (error) {
    return { error: error.message };
  }
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
    properties: ['openDirectory']
  });

  console.log('select-folder dialog result:', JSON.stringify(result));

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    console.log('select-folder: Dialog cancelled or no path selected');
    return null;
  }

  const selectedPath = result.filePaths[0];
  console.log('select-folder: Selected path:', selectedPath);

  // Validate that the path is not empty
  if (!selectedPath || selectedPath.trim() === '') {
    console.log('select-folder: Empty path returned');
    return null;
  }

  return selectedPath;
});

// File selection dialog
ipcMain.handle('select-file-dialog', async (event, options = {}) => {
  const result = await dialog.showOpenDialog({
    title: options.title || 'Datei wählen',
    filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile']
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

// IPC Handlers for Bausteine
const bausteineManager = require('./src/bausteine');

// Bausteine mit Kategorien laden (neues Format)
ipcMain.handle('get-bausteine-with-categories', async () => {
  return {
    data: bausteineManager.getAllBausteineWithCategories(),
    defaults: bausteineManager.getDefaultBausteineWithCategories(),
    path: bausteineManager.getBausteinePath()
  };
});

// Legacy: Flaches Format für Kompatibilität
ipcMain.handle('get-bausteine', async () => {
  return {
    bausteine: bausteineManager.getAllBausteine(),
    defaults: bausteineManager.getDefaultBausteine()
  };
});

// Bausteine speichern (neues Format mit Kategorien)
ipcMain.handle('save-bausteine-with-categories', async (event, data) => {
  bausteineManager.saveAllBausteineWithCategories(data);
  return { success: true };
});

// Legacy: Flaches Format speichern
ipcMain.handle('save-bausteine', async (event, bausteine) => {
  bausteineManager.saveAllBausteine(bausteine);
  return { success: true };
});

// Pfad-Management
ipcMain.handle('get-bausteine-path', async () => {
  return bausteineManager.getBausteinePath();
});

ipcMain.handle('set-bausteine-path', async (event, newPath) => {
  bausteineManager.setBausteinePath(newPath);
  return { success: true };
});

// Prüft ob im Zielordner bereits eine bausteine.json existiert
ipcMain.handle('check-bausteine-exists', async (event, targetPath) => {
  return fs.existsSync(targetPath);
});

// Kopiert die aktuelle bausteine.json in einen neuen Ordner
ipcMain.handle('copy-bausteine-to-path', async (event, targetPath) => {
  const currentPath = bausteineManager.getBausteinePath();
  const currentData = bausteineManager.getAllBausteineWithCategories();

  // Zielordner erstellen falls nötig
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Daten in neue Datei schreiben
  fs.writeFileSync(targetPath, JSON.stringify(currentData, null, 2), 'utf8');

  // Pfad umstellen
  bausteineManager.setBausteinePath(targetPath);

  return { success: true };
});

// Dialog für Bausteine-Pfad-Wechsel
ipcMain.handle('show-bausteine-path-dialog', async (event, targetPath) => {
  const targetExists = fs.existsSync(targetPath);
  const currentPath = bausteineManager.getBausteinePath();
  const hasCurrentFile = fs.existsSync(currentPath);

  // Prüfe ob aktuelle Datei Änderungen hat (nicht nur Defaults)
  let hasCustomData = false;
  if (hasCurrentFile) {
    try {
      const data = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
      hasCustomData = true; // Wenn Datei existiert, hat sie potenziell custom Daten
    } catch (e) {
      hasCustomData = false;
    }
  }

  let buttons = [];
  let message = '';
  let detail = '';

  if (targetExists && hasCurrentFile) {
    // Beide existieren
    buttons = ['Aktuelle Bausteine kopieren', 'Vorhandene Datei verwenden', 'Abbrechen'];
    message = 'Im Zielordner existiert bereits eine Bausteine-Datei.';
    detail = 'Möchten Sie Ihre aktuellen Bausteine dorthin kopieren (überschreibt vorhandene) oder die vorhandene Datei verwenden?';
  } else if (targetExists) {
    // Nur Ziel existiert
    buttons = ['Vorhandene Datei verwenden', 'Mit Standards überschreiben', 'Abbrechen'];
    message = 'Im Zielordner existiert bereits eine Bausteine-Datei.';
    detail = 'Möchten Sie diese verwenden oder mit Standard-Bausteinen überschreiben?';
  } else if (hasCurrentFile) {
    // Nur aktuelle existiert
    buttons = ['Aktuelle Bausteine kopieren', 'Mit Standards beginnen', 'Abbrechen'];
    message = 'Bausteine-Speicherort ändern';
    detail = 'Möchten Sie Ihre aktuellen Bausteine in den neuen Ordner kopieren oder mit Standard-Bausteinen neu beginnen?';
  } else {
    // Keine existiert - einfach wechseln
    return { action: 'use_defaults' };
  }

  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'question',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    title: 'Bausteine-Speicherort ändern',
    message,
    detail
  });

  // Mapping der Antworten
  if (result.response === buttons.length - 1) {
    return { action: 'cancel' };
  }

  if (targetExists && hasCurrentFile) {
    // Beide existieren
    if (result.response === 0) return { action: 'copy_current' };
    if (result.response === 1) return { action: 'use_existing' };
  } else if (targetExists) {
    // Nur Ziel existiert
    if (result.response === 0) return { action: 'use_existing' };
    if (result.response === 1) return { action: 'use_defaults' };
  } else if (hasCurrentFile) {
    // Nur aktuelle existiert
    if (result.response === 0) return { action: 'copy_current' };
    if (result.response === 1) return { action: 'use_defaults' };
  }

  return { action: 'cancel' };
});

// Kategorien-Management
ipcMain.handle('create-category', async (event, name) => {
  const category = bausteineManager.createCategory(name);
  return { success: true, category };
});

ipcMain.handle('rename-category', async (event, categoryId, newName) => {
  bausteineManager.renameCategory(categoryId, newName);
  return { success: true };
});

ipcMain.handle('delete-category', async (event, categoryId) => {
  bausteineManager.deleteCategory(categoryId);
  return { success: true };
});

// Baustein-Management
ipcMain.handle('create-baustein', async (event, categoryId, baustein) => {
  const newBaustein = bausteineManager.createBaustein(categoryId, baustein);
  return { success: true, baustein: newBaustein };
});

ipcMain.handle('update-baustein', async (event, bausteinId, updates) => {
  bausteineManager.updateBaustein(bausteinId, updates);
  return { success: true };
});

ipcMain.handle('delete-baustein', async (event, bausteinId) => {
  bausteineManager.deleteBaustein(bausteinId);
  return { success: true };
});

ipcMain.handle('move-baustein', async (event, bausteinId, targetCategoryId) => {
  bausteineManager.moveBausteinToCategory(bausteinId, targetCategoryId);
  return { success: true };
});

ipcMain.handle('reset-baustein', async (event, bausteinId) => {
  bausteineManager.resetBaustein(bausteinId);
  return { success: true };
});

ipcMain.handle('reset-all-bausteine', async () => {
  bausteineManager.resetAllBausteine();
  return { success: true };
});

ipcMain.handle('confirm-reset-baustein', async (event, bausteinName) => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'question',
    buttons: ['Zurücksetzen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Baustein zurücksetzen',
    message: `Baustein "${bausteinName}" auf Standard zurücksetzen?`
  });
  return result.response === 0;
});

ipcMain.handle('confirm-reset-all-bausteine', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Alle zurücksetzen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Alle Bausteine zurücksetzen',
    message: 'ALLE Bausteine auf Standard zurücksetzen?',
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-delete-category', async (event, categoryName) => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Kategorie löschen',
    message: `Kategorie "${categoryName}" wirklich löschen?`,
    detail: 'Die Bausteine werden in die Kategorie "Allgemein" verschoben.'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-delete-baustein', async (event, bausteinName) => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Baustein löschen',
    message: `Baustein "${bausteinName}" wirklich löschen?`,
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-delete-profile', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Stimmprofil löschen',
    message: 'Möchten Sie dieses Stimmprofil wirklich löschen?',
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-delete-textbaustein', async (event, key) => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Textbaustein löschen',
    message: `Textbaustein "${key}" wirklich löschen?`,
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-reset-textbausteine', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Alle zurücksetzen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Textbausteine zurücksetzen',
    message: 'Alle Textbausteine auf Standard zurücksetzen?',
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-delete-thema', async (event, themaName) => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Thema löschen',
    message: `Thema "${themaName}" wirklich löschen?`,
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
});

ipcMain.handle('confirm-reset-themen', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Alle zurücksetzen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Themen zurücksetzen',
    message: 'Alle Themen auf Standard zurücksetzen?',
    detail: 'Dies kann nicht rückgängig gemacht werden!'
  });
  return result.response === 0;
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
  console.log('[get-voice-profiles] Current store path:', voiceProfiles.getStorePath());
  const profiles = voiceProfiles.getAllProfiles();
  console.log('[get-voice-profiles] Found profiles:', profiles.length);
  return profiles;
});

ipcMain.handle('delete-voice-profile', async (event, id) => {
  return voiceProfiles.deleteProfile(id);
});

ipcMain.handle('start-voice-enrollment', async (event, data) => {
  if (isEnrolling) {
    throw new Error('Eine Aufnahme läuft bereits');
  }

  try {
    // Check if recorder is busy (e.g., mic test or other recording running)
    const recorderState = audioRecorder.getState();
    if (recorderState !== 'idle') {
      console.log('Enrollment: Recorder busy with state:', recorderState, '- stopping first');
      try {
        await audioRecorder.stopRecording();
      } catch (e) {
        console.warn('Could not stop existing recording:', e.message);
        await audioRecorder.forceStop();
      }
    }

    isEnrolling = true;
    // Support both old format (string) and new format ({ name, role })
    if (typeof data === 'string') {
      currentEnrollmentName = data;
      currentEnrollmentRole = 'Arzt'; // Default role
    } else {
      currentEnrollmentName = data.name;
      currentEnrollmentRole = data.role || 'Arzt';
    }
    // Get selected microphone (browser device ID)
    const microphoneId = store.get('microphoneId') || null;
    currentEnrollmentPath = await audioRecorder.startRecording(false, microphoneId);
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
    // Only stop if actually recording
    const recorderState = audioRecorder.getState();
    if (recorderState === 'recording') {
      await audioRecorder.stopRecording();
    } else {
      console.log('Enrollment stop: Recorder not in recording state:', recorderState);
    }

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

  // Only stop if actually recording
  const recorderState = audioRecorder.getState();
  if (recorderState === 'recording') {
    try {
      await audioRecorder.stopRecording();
    } catch (error) {
      console.error('Error stopping recording during cancel:', error);
    }
  } else {
    console.log('Enrollment cancel: Recorder not in recording state:', recorderState);
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

// Forward audio level updates from recorder to status overlay and dashboard
ipcMain.on('audio-level-update', (event, level) => {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.webContents.send('audio-level', level);
  }
  // Also forward to dashboard for mic test
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('audio-level-update', level);
  }
});

// Mic test recording state
let micTestPath = null;

// Helper to clean up mic test file
function cleanupMicTestFile() {
  if (micTestPath && fs.existsSync(micTestPath)) {
    try {
      fs.unlinkSync(micTestPath);
      console.log('Cleaned up mic test file:', micTestPath);
      micTestPath = null;
    } catch (e) {
      console.warn('Could not delete mic test recording:', e);
    }
  }
}

// Start mic test recording (uses real recorder logic)
ipcMain.handle('start-mic-test', async (event, deviceId) => {
  try {
    // Check if a recording is already in progress
    const currentState = audioRecorder.getState();
    if (currentState !== 'idle') {
      console.log('Mic test: Recording already in progress, stopping first. State:', currentState);
      try {
        await audioRecorder.stopRecording();
      } catch (e) {
        console.warn('Could not stop existing recording:', e.message);
        // Use forceStop as fallback
        await audioRecorder.forceStop();
      }
    }

    // Clean up any previous test recording
    cleanupMicTestFile();

    micTestPath = await audioRecorder.startRecording(false, deviceId);
    return { success: true, path: micTestPath };
  } catch (error) {
    console.error('Mic test start error:', error);
    return { success: false, error: error.message };
  }
});

// Stop mic test recording and return the audio file path
ipcMain.handle('stop-mic-test', async () => {
  try {
    const filePath = await audioRecorder.stopRecording();
    micTestPath = filePath;
    return { success: true, path: filePath };
  } catch (error) {
    // If recording was already stopped but file exists, return success
    if (micTestPath && fs.existsSync(micTestPath)) {
      console.log('Mic test: Recording already stopped, using existing file');
      return { success: true, path: micTestPath };
    }
    console.error('Mic test stop error:', error);
    return { success: false, error: error.message };
  }
});

// Get mic test audio file as base64 for playback
ipcMain.handle('get-mic-test-audio', async () => {
  try {
    if (!micTestPath || !fs.existsSync(micTestPath)) {
      return { success: false, error: 'Keine Test-Aufnahme vorhanden' };
    }
    const buffer = fs.readFileSync(micTestPath);
    const base64 = buffer.toString('base64');
    // FFmpeg records directly as WAV now
    return { success: true, data: base64, mimeType: 'audio/wav' };
  } catch (error) {
    console.error('Get mic test audio error:', error);
    return { success: false, error: error.message };
  }
});

// Clean up mic test recording
ipcMain.handle('cleanup-mic-test', async () => {
  cleanupMicTestFile();
  return { success: true };
});

// ============ Speaker Optimization IPC Handlers ============
// See SPEAKER-RECOGNITION.md for full documentation

// Store optimization session data
let optimizationSession = null;

/**
 * Start optimization flow - analyze unrecognized speakers
 * @param {Object} data - { transcriptionId, audioFilePath, utterances, speakerMapping }
 */
ipcMain.handle('start-speaker-optimization', async (event, data) => {
  try {
    const { transcriptionId, audioFilePath, utterances, speakerMapping } = data;

    // Find unrecognized speakers (those showing as "Sprecher A/B/C")
    const unrecognizedSpeakers = [];

    for (const [speakerId, label] of Object.entries(speakerMapping)) {
      if (label.startsWith('Sprecher ')) {
        // Get utterances for this speaker
        const speakerUtterances = utterances.filter(u => u.speaker === speakerId);
        const totalDuration = speakerUtterances.reduce(
          (sum, u) => sum + (u.end - u.start), 0
        );

        unrecognizedSpeakers.push({
          speakerId,
          label,
          utterances: speakerUtterances,
          totalDuration,
          // Backend would provide inferred role, for now null
          inferredRole: null
        });
      }
    }

    optimizationSession = {
      transcriptionId,
      audioFilePath,
      utterances,
      speakerMapping,
      unrecognizedSpeakers,
      createdAt: Date.now()
    };

    debugLog(`[SpeakerOptimization] Session started with ${unrecognizedSpeakers.length} unrecognized speakers`);

    return {
      success: true,
      unrecognizedSpeakers: unrecognizedSpeakers.map(s => ({
        speakerId: s.speakerId,
        label: s.label,
        totalDuration: s.totalDuration,
        inferredRole: s.inferredRole,
        utteranceCount: s.utterances.length
      }))
    };
  } catch (error) {
    console.error('Start speaker optimization error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Get preview audio for a specific unrecognized speaker
 * @param {string} speakerId - Speaker ID (A, B, C, etc.)
 */
ipcMain.handle('get-speaker-preview', async (event, speakerId) => {
  try {
    if (!optimizationSession) {
      throw new Error('Keine Optimierungs-Session aktiv');
    }

    const speaker = optimizationSession.unrecognizedSpeakers.find(
      s => s.speakerId === speakerId
    );

    if (!speaker) {
      throw new Error('Sprecher nicht gefunden');
    }

    // Create preview clip (max 15 seconds)
    const previewPath = path.join(os.tmpdir(), `dentdoc-preview-${speakerId}.wav`);
    await speakerRecognition.createPreviewClip(
      optimizationSession.audioFilePath,
      speaker.utterances,
      previewPath,
      15000
    );

    // Read as base64 for playback
    const buffer = fs.readFileSync(previewPath);
    const base64 = buffer.toString('base64');

    return {
      success: true,
      audio: base64,
      mimeType: 'audio/wav',
      duration: Math.min(speaker.totalDuration, 15000)
    };
  } catch (error) {
    console.error('Get speaker preview error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Enroll unrecognized speaker to existing or new profile
 * @param {Object} data - { speakerId, action, profileId?, name?, role }
 *   action: 'add-to-existing' | 'create-new'
 */
ipcMain.handle('enroll-optimized-speaker', async (event, data) => {
  try {
    const { speakerId, action, profileId, name, role } = data;

    if (!optimizationSession) {
      throw new Error('Keine Optimierungs-Session aktiv');
    }

    // CRITICAL: Never enroll patients
    if (role === 'Patient') {
      throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
    }

    const speaker = optimizationSession.unrecognizedSpeakers.find(
      s => s.speakerId === speakerId
    );

    if (!speaker) {
      throw new Error('Sprecher nicht gefunden');
    }

    // Create embedding from utterances
    const embeddingResult = await speakerRecognition.createEmbeddingFromUtterances(
      optimizationSession.audioFilePath,
      speaker.utterances,
      15000  // 15 seconds target
    );

    if (action === 'add-to-existing') {
      // Get profile to check role match
      const existingProfile = voiceProfiles.getProfile(profileId);
      if (!existingProfile) {
        throw new Error('Profil nicht gefunden');
      }

      // CRITICAL: Role immutability check
      if (existingProfile.role !== role) {
        throw new Error(`Rolle stimmt nicht überein: Profil ist ${existingProfile.role}, gewählt wurde ${role}`);
      }

      // Add to existing profile as pending embedding
      const profile = voiceProfiles.addPendingEmbedding(profileId, embeddingResult.embedding, {
        sourceDuration: embeddingResult.totalDuration,
        transcriptionId: optimizationSession.transcriptionId
      });

      debugLog(`[SpeakerOptimization] Added pending embedding to "${profile.name}"`);

      return {
        success: true,
        action: 'added-to-pending',
        profile: {
          id: profile.id,
          name: profile.name,
          pendingCount: profile.pending_embeddings ? profile.pending_embeddings.length : 0,
          promoted: !profile.pending_embeddings || profile.pending_embeddings.length === 0
        }
      };

    } else if (action === 'create-new') {
      if (!name || !name.trim()) {
        throw new Error('Bitte Namen eingeben');
      }

      // Create new profile with initial pending embedding (NOT confirmed!)
      const profile = voiceProfiles.saveProfileWithPending(name.trim(), embeddingResult.embedding, role, {
        sourceDuration: embeddingResult.totalDuration,
        transcriptionId: optimizationSession.transcriptionId
      });

      debugLog(`[SpeakerOptimization] Created new profile "${profile.name}" with pending embedding`);

      return {
        success: true,
        action: 'created-new',
        profile: {
          id: profile.id,
          name: profile.name,
          role: profile.role
        }
      };
    }

    throw new Error('Unbekannte Aktion');
  } catch (error) {
    console.error('Enroll optimized speaker error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Cancel optimization session
 */
ipcMain.handle('cancel-speaker-optimization', async () => {
  try {
    // Clean up preview files
    if (optimizationSession) {
      for (const speaker of optimizationSession.unrecognizedSpeakers) {
        const previewPath = path.join(os.tmpdir(), `dentdoc-preview-${speaker.speakerId}.wav`);
        if (fs.existsSync(previewPath)) {
          try { fs.unlinkSync(previewPath); } catch (e) { /* ignore */ }
        }
      }
    }

    optimizationSession = null;
    debugLog('[SpeakerOptimization] Session cancelled');
    return { success: true };
  } catch (error) {
    console.error('Cancel speaker optimization error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Get existing profiles for optimization UI (excluding patients)
 */
ipcMain.handle('get-profiles-for-optimization', async () => {
  try {
    const profiles = voiceProfiles.getAllProfiles();
    return {
      success: true,
      profiles: profiles
        .filter(p => p.role !== 'Patient')
        .map(p => ({
          id: p.id,
          name: p.name,
          role: p.role,
          embeddingCount: (p.confirmed_embeddings?.length || 1) + (p.pending_embeddings?.length || 0)
        }))
    };
  } catch (error) {
    console.error('Get profiles for optimization error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Check if optimization is available (unrecognized speakers exist)
 */
ipcMain.handle('check-optimization-available', async () => {
  if (!optimizationSession) {
    return { available: false };
  }
  return {
    available: optimizationSession.unrecognizedSpeakers.length > 0,
    unrecognizedCount: optimizationSession.unrecognizedSpeakers.length
  };
});

/**
 * Get pending optimization data (stored after transcription)
 */
ipcMain.handle('get-pending-optimization-data', async () => {
  if (!global.pendingOptimizationData) {
    return { available: false };
  }

  const data = global.pendingOptimizationData;
  const unrecognizedCount = Object.values(data.speakerMapping).filter(
    l => l.startsWith('Sprecher ')
  ).length;

  return {
    available: unrecognizedCount > 0,
    unrecognizedCount,
    data
  };
});

/**
 * Initialize optimization from pending data
 */
ipcMain.handle('init-optimization-from-pending', async () => {
  if (!global.pendingOptimizationData) {
    return { success: false, error: 'Keine Optimierungsdaten verfügbar' };
  }

  // Start the optimization session with the pending data
  const result = await (async () => {
    const data = global.pendingOptimizationData;
    const { transcriptionId, audioFilePath, utterances, speakerMapping } = data;

    const unrecognizedSpeakers = [];

    for (const [speakerId, label] of Object.entries(speakerMapping)) {
      if (label.startsWith('Sprecher ')) {
        const speakerUtterances = utterances.filter(u => u.speaker === speakerId);
        const totalDuration = speakerUtterances.reduce(
          (sum, u) => sum + (u.end - u.start), 0
        );

        unrecognizedSpeakers.push({
          speakerId,
          label,
          utterances: speakerUtterances,
          totalDuration,
          inferredRole: null
        });
      }
    }

    optimizationSession = {
      transcriptionId,
      audioFilePath,
      utterances,
      speakerMapping,
      unrecognizedSpeakers,
      createdAt: Date.now()
    };

    debugLog(`[SpeakerOptimization] Session initialized from pending data with ${unrecognizedSpeakers.length} unrecognized speakers`);

    return {
      success: true,
      unrecognizedSpeakers: unrecognizedSpeakers.map(s => ({
        speakerId: s.speakerId,
        label: s.label,
        totalDuration: s.totalDuration,
        inferredRole: s.inferredRole,
        utteranceCount: s.utterances.length
      }))
    };
  })();

  return result;
});

// Open speaker optimization modal in dashboard
ipcMain.on('open-speaker-optimization-modal', () => {
  // Show/focus dashboard and trigger optimization modal
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();

    // Prepare data for the modal
    if (optimizationSession) {
      const modalData = {
        unrecognizedSpeakers: optimizationSession.unrecognizedSpeakers.map(s => ({
          speakerId: s.speakerId,
          label: s.label,
          utteranceCount: s.utterances?.length || 0,
          totalDurationMs: s.totalDuration || 0
        })),
        speakerMapping: Object.entries(optimizationSession.speakerMapping || {}).map(
          ([speakerId, displayLabel]) => ({ speakerId, displayLabel })
        )
      };
      // Send message with data to open the optimization modal
      dashboardWindow.webContents.send('show-speaker-optimization-modal', modalData);
    } else {
      console.warn('[SpeakerOptimization] No optimization session available');
    }
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

// Open DevTools for debugging
ipcMain.handle('open-devtools', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.webContents.openDevTools();
  }
  return { success: true };
});

// Show unsaved changes dialog
ipcMain.handle('show-unsaved-changes-dialog', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
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

// Allow update checks in dev mode
autoUpdater.forceDevUpdateConfig = true;

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
      // Force quit all windows and install
      autoUpdater.quitAndInstall(false, true);
    }
  });
});

autoUpdater.on('error', (error) => {
  console.error('Auto-update error:', error);
  dialog.showErrorBox('Auto-Update Fehler', error.message || String(error));
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
});

// Track manual update check to show user feedback
let isManualUpdateCheck = false;

autoUpdater.on('update-not-available', () => {
  console.log('No updates available');
  if (isManualUpdateCheck) {
    isManualUpdateCheck = false;
    dialog.showMessageBox({
      type: 'info',
      title: 'Keine Updates verfügbar',
      message: 'Sie verwenden bereits die neueste Version von DentDoc.',
      buttons: ['OK']
    });
  }
});

// IPC handler for manual update check
ipcMain.handle('check-for-updates', async () => {
  try {
    // Configure GitHub feed URL if not already set
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'Rickpeace',
      repo: 'dentdoc-desktop'
    });

    isManualUpdateCheck = true;
    await autoUpdater.checkForUpdates();
    return { status: 'checking', message: 'Suche nach Updates...' };
  } catch (error) {
    isManualUpdateCheck = false;
    console.error('Manual update check error:', error);
    return { status: 'error', message: error.message };
  }
});

// IPC handler to get app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

app.whenReady().then(() => {
  createTray();

  // Initialize voice profiles path (use stored path or default)
  const storedProfilesPath = store.get('profilesPath');
  const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

  if (storedProfilesPath) {
    // Use custom path
    console.log('[App] Using stored profiles path:', storedProfilesPath);
    voiceProfiles.setStorePath(storedProfilesPath);
  } else {
    // Use default path in Documents folder
    const defaultProfilesPath = path.join(app.getPath('documents'), 'DentDoc', 'Stimmprofile');
    console.log('[App] Using default profiles path:', defaultProfilesPath);
    voiceProfiles.setStorePath(defaultProfilesPath);
  }

  // Register global shortcut (use saved or default F9)
  const savedShortcut = store.get('shortcut') || 'F9';
  registerShortcut(savedShortcut);

  // Check for updates (only in production)
  if (!app.isPackaged) {
    console.log('Development mode - skipping auto-update check');
  } else {
    // Configure GitHub for public repo
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'Rickpeace',
      repo: 'dentdoc-desktop'
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
    // Validate token and start heartbeat
    apiClient.heartbeat(token, store).then(isValid => {
      if (isValid) {
        // Token valid, start heartbeat and get user data
        startHeartbeat();
        return apiClient.getUser(token);
      } else {
        // Session expired
        throw new Error('Session expired');
      }
    }).then(user => {
      store.set('user', user);
      updateTrayMenu();

      // Create dashboard window hidden at startup (for F9 audio monitoring)
      // The renderer needs to be running to handle getUserMedia for real audio levels
      if (!dashboardWindow || dashboardWindow.isDestroyed()) {
        createDashboardWindow();
        // Don't show it - user opens it via tray menu
      }

      // Check trial/subscription status on app start and show notification if needed
      const isTrialUser = user?.planTier === 'free_trial';
      const hasActiveSubscription = user?.subscriptionStatus === 'active';
      const isCanceled = user?.subscriptionStatus === 'canceled';
      const minutesRemaining = user?.minutesRemaining || 0;

      // Distinguish between true trial users and ex-subscribers
      const wasSubscriber = isCanceled || (isTrialUser && user?.stripeCustomerId);
      const trialExpired = isTrialUser && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

      if (wasSubscriber && !hasActiveSubscription) {
        // Ex-subscriber - show "no active subscription" notification
        setTimeout(() => {
          showCustomNotification(
            'Kein aktives Abo',
            'Ihr Abonnement ist nicht mehr aktiv. Klicken Sie hier um es zu reaktivieren.',
            'error',
            () => openWebDashboard('/subscription')
          );
        }, 2000);
      } else if (trialExpired) {
        // True trial expired - show notification after a short delay
        setTimeout(() => {
          showCustomNotification(
            'Testphase beendet',
            'Ihre kostenlosen Testminuten sind aufgebraucht. Klicken Sie hier für ein Abo.',
            'error',
            () => openWebDashboard('/subscription')
          );
        }, 2000);
      } else if (isTrialUser && !wasSubscriber && minutesRemaining > 0 && minutesRemaining <= 10) {
        // Trial running low
        setTimeout(() => {
          showCustomNotification(
            'Testphase endet bald',
            `Nur noch ${minutesRemaining} Minuten übrig. Jetzt Abo kaufen!`,
            'warning',
            () => openWebDashboard('/subscription')
          );
        }, 2000);
      }
    }).catch(() => {
      // Token invalid or session expired, show login
      stopHeartbeat();
      store.delete('authToken');
      store.delete('user');
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
  // Clean up mic test file
  cleanupMicTestFile();
});

// Handle second instance
app.on('second-instance', () => {
  showNotification('DentDoc läuft bereits', 'Die App ist bereits im System Tray aktiv');
});
