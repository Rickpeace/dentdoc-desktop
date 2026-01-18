// Load environment variables (.env.local overrides .env for local development)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, Notification, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const audioRecorder = require('./src/audioRecorderFFmpeg');
const apiClient = require('./src/apiClient');
const vadController = require('./src/vad-controller');

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
debugLog(`App path: ${app && app.getAppPath ? app.getAppPath() : 'N/A (app not ready)'}`);
debugLog(`Is packaged: ${app && typeof app.isPackaged !== 'undefined' ? app.isPackaged : 'N/A (app not ready)'}`);
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
      nodeIntegrationInWorker: true,  // Required for VAD Worker (Sherpa-ONNX)
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


// Debounce flag to prevent rapid F9 presses
let shortcutLocked = false;

function registerShortcut(shortcut) {
  // Unregister old shortcut
  globalShortcut.unregisterAll();

  // Register new shortcut
  const registered = globalShortcut.register(shortcut, async () => {
    // Prevent rapid repeated presses
    if (shortcutLocked) {
      console.log('[Shortcut] Ignoring rapid press - locked');
      return;
    }
    shortcutLocked = true;
    setTimeout(() => { shortcutLocked = false; }, 2000);  // 2 second cooldown

    console.log('[Shortcut] F9 pressed, isRecording:', isRecording);

    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
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
      globalShortcut.register(oldShortcut, async () => {
        if (shortcutLocked) return;
        shortcutLocked = true;
        setTimeout(() => { shortcutLocked = false; }, 2000);

        if (isRecording) {
          await stopRecording();
        } else {
          await startRecording();
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
    }

    // Save audio if enabled and source exists
    if (saveAudio && tempAudioPath && fs.existsSync(tempAudioPath)) {
      const audioExt = path.extname(tempAudioPath) || '.wav';
      const audioPath = path.join(folderPath, `${baseFilename}${audioExt}`);
      fs.copyFileSync(tempAudioPath, audioPath);
    }
  });

  // Nice formatted log for saved files
  const savedItems = [];
  if (saveTranscript) savedItems.push('Transkript');
  if (saveAudio && tempAudioPath && fs.existsSync(tempAudioPath)) savedItems.push('Audio');
  if (savedItems.length > 0) {
    const folderName = path.basename(targetFolders[0]);
    console.log('');
    console.log('///// DATEIEN GESPEICHERT /////');
    console.log(`  Ordner:  ${folderName}/`);
    savedItems.forEach(item => {
      console.log(`  [x] ${item}`);
    });
    console.log('///////////////////////////////');
    console.log('');
  }

  // Delete backup audio from "Fehlgeschlagen" folder after successful transcription
  if (savedAudioPathInBackup && fs.existsSync(savedAudioPathInBackup)) {
    try {
      fs.unlinkSync(savedAudioPathInBackup);
      savedAudioPathInBackup = null;
    } catch (err) {
      // Ignore cleanup errors
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
// @param {string} audioFilePath - Path to audio file
// @param {Object} options - Options
// @param {string} options.source - Audio source: 'iphone' | 'mic' (default: 'mic')
async function processAudioFile(audioFilePath, options = {}) {
  const { source = 'mic' } = options;
  const token = store.get('authToken');

  isProcessing = true;
  updateTrayMenu();

  // Change tray icon to processing state (use regular icon)
  const processingIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray.setImage(processingIconPath);
  tray.setToolTip('DentDoc - Verarbeitung...');

  // Check if VAD is enabled for silence removal
  const vadEnabled = store.get('vadEnabled', true);

  if (vadEnabled) {
    // Use VAD pipeline to remove silence, then send to AssemblyAI
    // Pass source for correct Auto-Level strategy (iPhone = always loudnorm)
    console.log(`[processAudioFile] VAD enabled - source: ${source}`);
    await processFileWithVAD(audioFilePath, token, { source });
    return;
  }

  // Standard AssemblyAI flow (no VAD)
  console.log('[processAudioFile] Using standard AssemblyAI flow');

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

/**
 * Process an uploaded audio file with VAD for silence removal
 * Then sends the speech-only audio to AssemblyAI
 *
 * @param {string} audioFilePath - Path to audio file
 * @param {string} token - Auth token
 * @param {Object} options - Options
 * @param {string} options.source - Audio source: 'iphone' | 'mic' (default: 'mic')
 */
async function processFileWithVAD(audioFilePath, token, options = {}) {
  const { source = 'mic' } = options;

  console.log('');
  console.log('========================================');
  console.log('       VERARBEITUNG GESTARTET');
  console.log('========================================');
  console.log(`  Datei: ${path.basename(audioFilePath)}`);
  console.log(`  Quelle: ${source}`);
  console.log('');

  updateStatusOverlay('Verarbeitung...', 'VAD wird gestartet...', 'processing', { step: 1 });

  try {
    const pipeline = require('./src/pipeline');

    console.log('///// SCHRITT 1: VAD /////');
    console.log('  Stille wird erkannt und entfernt...');

    // Run VAD on the file to get speech-only audio
    // Pass source for correct Auto-Level strategy (iPhone = always loudnorm)
    const { wavPath } = await pipeline.processFileWithVAD(audioFilePath, {
      source,
      onProgress: (progress) => {
        updateStatusOverlay('Verarbeitung...', progress.message, 'processing', { step: 1 });
      }
    });

    // Now send the speech-only file to AssemblyAI
    console.log('///// SCHRITT 2: UPLOAD /////');
    console.log('  Audio wird an AssemblyAI gesendet...');
    updateStatusOverlay('Verarbeitung...', 'Audio wird gesendet...', 'processing', { step: 1, uploadProgress: 0 });

    // Upload audio with progress tracking
    const onProgress = (progressInfo) => {
      if (progressInfo.phase === 'upload') {
        updateStatusOverlay(
          'Verarbeitung...',
          `Audio wird hochgeladen... ${progressInfo.percent}%`,
          'processing',
          { step: 1, uploadProgress: progressInfo.percent }
        );
      } else if (progressInfo.phase === 'submit') {
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

    // Upload the speech-only file (not the original)
    const transcriptionId = await apiClient.uploadAudio(wavPath, token, onProgress);

    // Poll for real transcription status from AssemblyAI
    let transcriptionResult;
    let attempts = 0;
    const maxAttempts = 180; // 3 minutes max
    let lastStatus = '';

    while (attempts < maxAttempts) {
      transcriptionResult = await apiClient.getTranscriptionStatus(transcriptionId, token);

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

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Zeitüberschreitung bei der Transkription');
    }

    console.log('///// SCHRITT 3: TRANSKRIPTION /////');
    console.log('  AssemblyAI Transkription abgeschlossen');

    const transcript = transcriptionResult.transcriptText;
    const utterances = typeof transcriptionResult.utterances === 'string'
      ? JSON.parse(transcriptionResult.utterances)
      : transcriptionResult.utterances;

    if (!utterances || utterances.length === 0) {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    console.log(`  Utterances: ${utterances.length}`);
    console.log('');

    // Speaker recognition
    console.log('///// SCHRITT 4: SPEAKER /////');
    console.log('  Sprecher werden identifiziert...');
    let currentSpeakerMapping = null;
    updateStatusOverlay('Sprecher werden erkannt...', 'Stimmen werden analysiert...', 'processing', { step: 3 });

    try {
      if (speakerRecognition && utterances && utterances.length > 0) {
        currentSpeakerMapping = await speakerRecognition.identifySpeakersFromUtterances(
          wavPath,
          utterances
        );

        // Update backend with speaker mapping
        await apiClient.updateSpeakerMapping(transcriptionId, currentSpeakerMapping, token);
      }
    } catch (speakerError) {
      console.log('  [!] Fehler bei Sprechererkennung');
    }

    // Generate documentation
    console.log('///// SCHRITT 5: DOKUMENTATION /////');
    console.log('  KI erstellt Dokumentation...');
    updateStatusOverlay('Verarbeitung...', 'Dokumentation wird erstellt...', 'processing', { step: 4 });

    const docMode = store.get('docMode', 'single');
    let docResponse;

    if (docMode === 'agent-chain') {
      const bausteine = bausteineManager.getAllBausteine();
      docResponse = await apiClient.getDocumentationV2(transcriptionId, token, bausteine);
    } else if (docMode === 'hybrid-v1.2') {
      docResponse = await apiClient.getDocumentationV1_2(transcriptionId, token);
    } else if (docMode === 'single-v1.1') {
      docResponse = await apiClient.getDocumentationV1_1(transcriptionId, token);
    } else if (docMode === 'megaprompt') {
      docResponse = await apiClient.getDocumentationMegaprompt(transcriptionId, token);
    } else {
      docResponse = await apiClient.getDocumentation(transcriptionId, token);
    }

    const documentation = docResponse.documentation;
    const finalTranscript = docResponse.transcript || transcript;  // Use formatted transcript with speaker labels
    const shortenings = docResponse.shortenings || [];

    // Store for potential retry/copy
    lastDocumentation = documentation;
    lastTranscript = finalTranscript;
    lastShortenings = shortenings;
    store.set('lastDocumentationTime', new Date().toISOString());

    // Copy to clipboard
    clipboard.writeText(documentation);

    // Auto-save if enabled
    const autoExport = store.get('autoExport', true);
    const keepAudio = store.get('keepAudio', false);
    const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
    const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;

    console.log('  Dokumentation erstellt!');
    console.log('');

    if ((autoExport || keepAudio) && finalTranscript) {
      console.log('///// SCHRITT 6: SPEICHERN /////');
      try {
        saveRecordingFiles(transcriptPath, documentation, finalTranscript, currentSpeakerMapping, {
          tempAudioPath: wavPath,
          saveTranscript: autoExport,
          saveAudio: keepAudio,
          shortenings: shortenings
        });
      } catch (error) {
        console.log('  [!] Fehler beim Speichern:', error.message);
      }
    }

    // Show success
    console.log('========================================');
    console.log('       VERARBEITUNG ABGESCHLOSSEN');
    console.log('========================================');
    console.log('  Dokumentation in Zwischenablage!');
    console.log('');

    const autoClose = store.get('autoCloseOverlay', false);
    updateStatusOverlay(
      'Fertig!',
      'Dokumentation in Zwischenablage kopiert (Strg+V)',
      'success',
      { documentation, transcript: finalTranscript, shortenings, autoClose }
    );

    // Reset tray
    const normalIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(normalIconPath);
    tray.setToolTip('DentDoc - Bereit');

  } catch (error) {
    console.log('');
    console.log('!!!!! FEHLER !!!!!');
    console.log(`  ${error.message}`);
    console.log('!!!!!!!!!!!!!!!!!!');

    updateStatusOverlay('Fehler', error.message, 'error');
    showCustomNotification('Fehler', error.message, 'error');

    const normalIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(normalIconPath);
    tray.setToolTip('DentDoc - Bereit');

  } finally {
    isProcessing = false;
    updateTrayMenu();
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

  // Check if iPhone microphone is enabled
  const microphoneSource = store.get('microphoneSource', 'desktop');
  if (microphoneSource === 'iphone') {
    console.log('[Recording] iPhone mode - starting iPhone recording');
    startRecordingWithIphone().catch(err => {
      console.error('[Recording] iPhone start failed:', err);
      updateStatusOverlay('iPhone Fehler', err.message, 'error');
    });
    return;
  }

  // Check if VAD mode is enabled
  const vadEnabled = store.get('vadEnabled', true);
  if (vadEnabled) {
    console.log('[Recording] VAD mode enabled - starting VAD session');
    startRecordingWithVAD().catch(err => {
      console.error('[Recording] VAD start failed:', err);
      updateStatusOverlay('VAD Fehler', err.message, 'error');
    });
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

// ============================================================================
// iPhone Recording Mode
// ============================================================================
const WebSocket = require('ws');

let isIphoneSession = false;
let iphoneRelayWs = null;
let iphoneFfmpegProcess = null;
let iphoneRecordingPath = null;
let iphoneHeartbeatInterval = null;

async function startRecordingWithIphone() {
  console.log('[iPhone] ========== Start Recording (iPhone Mode) ==========');

  const iphoneDeviceId = store.get('iphoneDeviceId');
  const token = store.get('authToken');

  if (!iphoneDeviceId) {
    throw new Error('Kein iPhone gekoppelt. Bitte erst in Einstellungen koppeln.');
  }

  try {
    isRecording = true;
    isIphoneSession = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - iPhone-Aufnahme wird vorbereitet...');

    // Create output path for WAV
    const tempDir = path.join(app.getPath('temp'), 'dentdoc');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    iphoneRecordingPath = path.join(tempDir, `iphone_${Date.now()}.wav`);

    // Start FFmpeg - reads from stdin, writes WAV
    const ffmpegPath = audioRecorder.getFFmpegPath();
    iphoneFfmpegProcess = spawn(ffmpegPath, [
      '-f', 's16le',           // Input: signed 16-bit little-endian PCM
      '-ar', '16000',          // Sample rate: 16kHz
      '-ac', '1',              // Channels: mono
      '-i', 'pipe:0',          // Input: stdin
      '-acodec', 'pcm_s16le',  // Output codec
      '-y',                    // Overwrite
      iphoneRecordingPath
    ]);

    iphoneFfmpegProcess.stderr.on('data', (data) => {
      // FFmpeg logs to stderr
      console.log('[iPhone FFmpeg]', data.toString().trim());
    });

    iphoneFfmpegProcess.on('error', (err) => {
      console.error('[iPhone FFmpeg] Process error:', err);
    });

    // Connect to Relay
    const relayUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';
    console.log('[iPhone] Connecting to relay:', relayUrl);

    iphoneRelayWs = new WebSocket(`${relayUrl}/stream?device=${iphoneDeviceId}&role=desktop&token=${token}`);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('iPhone antwortet nicht. Bitte Safari-Seite auf iPhone öffnen.'));
      }, 15000);

      iphoneRelayWs.on('open', () => {
        console.log('[iPhone] Connected to relay, waiting for iPhone...');
        tray.setToolTip('DentDoc - Warte auf iPhone...');

        // Start heartbeat to keep connection alive
        if (iphoneHeartbeatInterval) {
          clearInterval(iphoneHeartbeatInterval);
        }
        iphoneHeartbeatInterval = setInterval(() => {
          if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
            iphoneRelayWs.send(JSON.stringify({ type: 'PING' }));
          }
        }, 10000); // Every 10 seconds
      });

      iphoneRelayWs.on('message', (data) => {
        // Check if JSON (control message) or binary (audio)
        if (Buffer.isBuffer(data) && data.length > 0) {
          // Try to parse as JSON first
          if (data[0] === 0x7b) { // '{'
            try {
              const msg = JSON.parse(data.toString());
              handleIphoneControlMessage(msg, timeout, resolve);
              return;
            } catch (e) {
              // Not JSON, must be audio data
            }
          }

          // Binary PCM audio data - write to FFmpeg (only if still recording)
          if (isIphoneSession && iphoneFfmpegProcess && iphoneFfmpegProcess.stdin && !iphoneFfmpegProcess.stdin.destroyed) {
            try {
              iphoneFfmpegProcess.stdin.write(data);

              // Calculate audio level from PCM data (Int16) and send to status overlay
              // Throttle to ~10 updates per second to avoid overwhelming the UI
              const now = Date.now();
              if (!global.lastAudioLevelUpdate || now - global.lastAudioLevelUpdate > 100) {
                global.lastAudioLevelUpdate = now;

                // Convert Buffer to Int16Array and calculate RMS
                const int16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
                let sum = 0;
                for (let i = 0; i < int16.length; i++) {
                  sum += int16[i] * int16[i];
                }
                const rms = Math.sqrt(sum / int16.length) / 32768; // Normalize to 0-1

                // Send to status overlay window (not mainWindow!)
                if (statusOverlay && !statusOverlay.isDestroyed()) {
                  statusOverlay.webContents.send('iphone-audio-level', rms);
                }
              }
            } catch (e) {
              // Ignore write errors during shutdown
              console.warn('[iPhone] Write error (likely during shutdown):', e.message);
            }
          }
        } else if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            handleIphoneControlMessage(msg, timeout, resolve);
          } catch (e) {
            console.warn('[iPhone] Invalid message:', data);
          }
        }
      });

      iphoneRelayWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Relay-Verbindung fehlgeschlagen: ${err.message}`));
      });

      iphoneRelayWs.on('close', (code, reason) => {
        console.log('[iPhone] WebSocket closed:', code, reason?.toString());
        if (isIphoneSession && isRecording) {
          console.warn('[iPhone] Connection lost during recording!');
          // Could show warning to user here
        }
      });
    });

    console.log('[iPhone] ========== Recording Started ==========');

  } catch (error) {
    console.error('[iPhone] Start error:', error);

    // Cleanup on error
    if (iphoneHeartbeatInterval) {
      clearInterval(iphoneHeartbeatInterval);
      iphoneHeartbeatInterval = null;
    }
    if (iphoneFfmpegProcess) {
      iphoneFfmpegProcess.kill();
      iphoneFfmpegProcess = null;
    }
    if (iphoneRelayWs) {
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isRecording = false;
    isIphoneSession = false;
    updateTrayMenu();

    // Reset tray
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    throw error;
  }
}

function handleIphoneControlMessage(msg, timeout, resolve) {
  console.log('[iPhone] Control message:', msg.type);

  if (msg.type === 'IPHONE_CONNECTED') {
    clearTimeout(timeout);
    console.log('[iPhone] iPhone connected, sending START');
    tray.setToolTip('DentDoc - iPhone verbunden, starte Aufnahme...');
    iphoneRelayWs.send(JSON.stringify({ type: 'START' }));
  }

  if (msg.type === 'IPHONE_READY') {
    console.log('[iPhone] Recording started on iPhone');
    tray.setToolTip('DentDoc - 🔴 iPhone-Aufnahme läuft...');

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('iPhone-Aufnahme...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    resolve();
  }

  if (msg.type === 'IPHONE_DISCONNECTED') {
    console.warn('[iPhone] iPhone disconnected during recording!');
    // Show warning but DON'T stop recording - doctor keeps control
    // Recording continues (with silence), doctor can still stop with F9

    // Show warning overlay
    updateStatusOverlay(
      '⚠️ iPhone getrennt',
      'Aufnahme läuft weiter. F9 zum Stoppen.',
      'warning'
    );

    // Notify dashboard
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('iphone-connection-status', { connected: false });
    }
  }

  // Handle PONG from relay (heartbeat response) - just log
  if (msg.type === 'PONG') {
    // Heartbeat response - connection is alive
  }
}

async function stopRecordingWithIphone() {
  console.log('[iPhone] ========== Stop Recording (iPhone Mode) ==========');

  // IMPORTANT: Set isIphoneSession to false FIRST to stop accepting new audio data
  isIphoneSession = false;

  try {
    tray.setToolTip('DentDoc - Stoppe iPhone-Aufnahme...');

    // Stop heartbeat
    if (iphoneHeartbeatInterval) {
      clearInterval(iphoneHeartbeatInterval);
      iphoneHeartbeatInterval = null;
    }

    // Send STOP to iPhone via Relay
    if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
      console.log('[iPhone] Sending STOP to iPhone');
      iphoneRelayWs.send(JSON.stringify({ type: 'STOP' }));
    }

    // Close WebSocket FIRST to stop receiving data
    if (iphoneRelayWs) {
      console.log('[iPhone] Closing WebSocket');
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    // Small delay to let any in-flight writes complete
    await new Promise(r => setTimeout(r, 100));

    // Close FFmpeg stdin -> FFmpeg writes WAV header and exits
    if (iphoneFfmpegProcess && iphoneFfmpegProcess.stdin && !iphoneFfmpegProcess.stdin.destroyed) {
      console.log('[iPhone] Closing FFmpeg stdin');
      iphoneFfmpegProcess.stdin.end();
    }

    // Wait for FFmpeg to finish
    if (iphoneFfmpegProcess) {
      await new Promise((resolve) => {
        iphoneFfmpegProcess.on('close', (code) => {
          console.log('[iPhone] FFmpeg exited with code:', code);
          resolve();
        });
        // Timeout fallback
        setTimeout(resolve, 5000);
      });
    }

    // Get recording path
    const recordingPath = iphoneRecordingPath;

    // Reset state
    iphoneFfmpegProcess = null;
    iphoneRecordingPath = null;
    isRecording = false;
    updateTrayMenu();

    // Reset tray
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    console.log('[iPhone] Recording stopped, file:', recordingPath);
    console.log('[iPhone] ========== Recording Stopped ==========');

    // Return path for processing
    return recordingPath;

  } catch (error) {
    console.error('[iPhone] Stop error:', error);

    // Force cleanup
    if (iphoneHeartbeatInterval) {
      clearInterval(iphoneHeartbeatInterval);
      iphoneHeartbeatInterval = null;
    }
    if (iphoneFfmpegProcess) {
      iphoneFfmpegProcess.kill('SIGKILL');
      iphoneFfmpegProcess = null;
    }
    if (iphoneRelayWs) {
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isIphoneSession = false;
    isRecording = false;
    updateTrayMenu();

    throw error;
  }
}

// ============================================================================
// VAD Recording Mode (Post-Processing - wie Upload)
// ============================================================================
let isVadSession = false;

async function startRecordingWithVAD() {
  // VAD-Modus: Normale Aufnahme, danach Offline-VAD Analyse (wie bei File Upload)
  console.log('[VAD] ========== Start Recording (Offline-VAD Mode) ==========');
  try {
    const microphoneId = store.get('microphoneId') || null;
    const deleteAudio = store.get('deleteAudio', true);
    console.log('[VAD] microphoneId:', microphoneId);

    isRecording = true;
    isVadSession = true;
    updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft (VAD)...');

    // Start normale FFmpeg Aufnahme (wie im Standard-Modus)
    currentRecordingPath = await audioRecorder.startRecording(deleteAudio, microphoneId);
    console.log('[VAD] Recording started:', currentRecordingPath);

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('🎤 Aufnahme läuft', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    // Notify dashboard to start audio monitoring (for level display)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-started', { microphoneId });
    }

    console.log('[VAD] ========== Recording Started ==========');

  } catch (error) {
    console.error('[VAD] Start error:', error);
    updateStatusOverlay('Fehler', 'Aufnahme konnte nicht gestartet werden', 'error');
    isRecording = false;
    isVadSession = false;
    updateTrayMenu();
  }
}

async function stopRecordingWithVAD() {
  // VAD-Modus: Aufnahme stoppen, dann Offline-VAD analysieren (wie File Upload)
  console.log('[VAD] ========== Stop Recording (Offline-VAD Mode) ==========');
  try {
    tray.setToolTip('DentDoc - Stoppe Aufnahme...');

    // Notify dashboard to stop audio monitoring
    console.log('[VAD] Sending recording-stopped to dashboard');
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-stopped');
    }

    // Stop FFmpeg recording
    await audioRecorder.stopRecording();
    console.log('[VAD] Recording stopped:', currentRecordingPath);

    isRecording = false;
    isVadSession = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);

    // Save audio immediately (before VAD processing)
    saveAudioImmediately(currentRecordingPath);

    // Process with Offline-VAD (same flow as file upload)
    // This will: 1) Run VAD 2) Remove silence 3) Send to AssemblyAI
    // source='mic' for RMS-based Auto-Level strategy
    console.log('[Recording] >>> Processing with source: mic (RMS-based: loudnorm < -50dB, mild_gain -50 to -28dB, none > -28dB)');
    const token = store.get('authToken');
    await processFileWithVAD(currentRecordingPath, token, { source: 'mic' });

  } catch (error) {
    console.error('[VAD] Stop error:', error);

    // Reset state on error
    isRecording = false;
    isVadSession = false;
    updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht verarbeitet werden', 'error');
  }
}

async function stopRecording() {
  // Check if we're in iPhone mode
  if (isIphoneSession) {
    console.log('[Recording] iPhone mode active - stopping iPhone session');
    console.log('[Recording] >>> Processing with source: iphone (will use loudnorm always)');
    try {
      const recordingPath = await stopRecordingWithIphone();
      // Save audio immediately
      saveAudioImmediately(recordingPath);
      // Process the recorded audio - source='iphone' for correct Auto-Level (always loudnorm)
      await processAudioFile(recordingPath, { source: 'iphone' });
    } catch (error) {
      console.error('[iPhone] Stop error:', error);
      updateStatusOverlay('iPhone Fehler', error.message, 'error');
    }
    return;
  }

  // Check if we're in VAD mode
  if (isVadSession) {
    console.log('[Recording] VAD mode active - stopping VAD session');
    await stopRecordingWithVAD();
    return;
  }

  // Notify dashboard to stop audio monitoring immediately
  console.log('[MAIN] Sending recording-stopped to dashboard (from stopRecording - normal mode)');
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
    microphoneSource: store.get('microphoneSource', 'desktop'),  // 'desktop' | 'iphone'
    iphoneDeviceId: store.get('iphoneDeviceId') || null,
    iphoneDeviceName: store.get('iphoneDeviceName') || null,
    transcriptPath: storedTranscriptPath !== undefined && storedTranscriptPath !== '' ? storedTranscriptPath : defaultTranscriptPath,
    profilesPath: storedProfilesPath !== undefined && storedProfilesPath !== '' ? storedProfilesPath : defaultProfilesPath,
    autoClose: store.get('autoCloseOverlay', false),
    autoExport: store.get('autoExport', true),
    keepAudio: store.get('keepAudio', false),
    docMode: store.get('docMode', 'single'),
    theme: store.get('theme', 'dark'),
    vadEnabled: store.get('vadEnabled', true)
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

  // Save VAD enabled setting
  if (settings.vadEnabled !== undefined) {
    store.set('vadEnabled', settings.vadEnabled);
    console.log('Saved vadEnabled:', settings.vadEnabled);
  }

  // Save microphone source (desktop/iphone)
  if (settings.microphoneSource !== undefined) {
    store.set('microphoneSource', settings.microphoneSource);
    console.log('Saved microphoneSource:', settings.microphoneSource);
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

// ===========================================
// iPhone Microphone Pairing IPC Handlers
// ===========================================

let pendingPairingId = null;

// Start iPhone pairing - request from backend
ipcMain.handle('iphone-pair-start', async () => {
  console.log('[iPhone] Starting pairing process...');

  const token = store.get('authToken');
  if (!token) {
    return { success: false, error: 'Nicht angemeldet' };
  }

  try {
    const apiClient = require('./src/apiClient');
    const result = await apiClient.iphonePairStart(token);

    if (result.pairingId) {
      pendingPairingId = result.pairingId;
      console.log('[iPhone] Pairing started, ID:', result.pairingId);

      return {
        success: true,
        pairingId: result.pairingId,
        pairingUrl: result.pairingUrl
      };
    } else {
      return { success: false, error: 'Keine Pairing-ID erhalten' };
    }
  } catch (error) {
    console.error('[iPhone] Pairing start error:', error);
    return { success: false, error: error.message };
  }
});

// Check pairing status
ipcMain.handle('iphone-pair-status', async (event, pairingId) => {
  const token = store.get('authToken');
  if (!token) {
    return { paired: false, error: 'Nicht angemeldet' };
  }

  try {
    const apiClient = require('./src/apiClient');
    const status = await apiClient.iphonePairStatus(pairingId, token);

    if (status.paired || status.status === 'paired') {
      // Store iPhone credentials (only set if value exists)
      if (status.iphoneDeviceId) {
        store.set('iphoneDeviceId', status.iphoneDeviceId);
      }
      if (status.deviceName) {
        store.set('iphoneDeviceName', status.deviceName);
      }
      store.set('microphoneSource', 'iphone');

      console.log('[iPhone] Pairing confirmed! Device:', status.deviceName);
      pendingPairingId = null;
    }

    return status;
  } catch (error) {
    console.error('[iPhone] Status check error:', error);
    return { paired: false, error: error.message };
  }
});

// Cancel pairing
ipcMain.handle('iphone-pair-cancel', async () => {
  console.log('[iPhone] Cancelling pairing...');
  pendingPairingId = null;
  return { success: true };
});

// Get iPhone pairing status from backend (single source of truth)
ipcMain.handle('iphone-get-status', async () => {
  const token = store.get('authToken');
  if (!token) {
    return { paired: false, error: 'Nicht angemeldet' };
  }

  try {
    const apiClient = require('./src/apiClient');
    const status = await apiClient.iphoneStatus(token);

    // Sync local store with backend truth
    if (status.paired) {
      if (status.iphoneDeviceId) {
        store.set('iphoneDeviceId', status.iphoneDeviceId);
      }
      if (status.deviceName) {
        store.set('iphoneDeviceName', status.deviceName);
      }
    } else {
      // Backend says not paired - clear local store
      store.delete('iphoneDeviceId');
      store.delete('iphoneDeviceName');
      // Don't change microphoneSource - user might want to keep it on 'iphone'
    }

    return status;
  } catch (error) {
    console.error('[iPhone] Status check error:', error);
    return { paired: false, error: error.message };
  }
});

// Unpair iPhone
ipcMain.handle('iphone-unpair', async () => {
  console.log('[iPhone] Unpairing device...');

  const token = store.get('authToken');
  const iphoneDeviceId = store.get('iphoneDeviceId');

  // Clear local store first
  store.delete('iphoneDeviceId');
  store.delete('iphoneDeviceName');
  store.delete('iphoneAuthToken');
  store.set('microphoneSource', 'desktop');

  // Notify backend (if possible)
  if (token && iphoneDeviceId) {
    try {
      const apiClient = require('./src/apiClient');
      await apiClient.iphoneUnpair(token);
    } catch (error) {
      console.warn('[iPhone] Backend unpair failed (ignored):', error.message);
    }
  }

  return { success: true };
});

// Test iPhone connection (check if iPhone is connected to relay)
ipcMain.handle('iphone-test-connection', async () => {
  console.log('[iPhone] Testing connection...');

  const iphoneDeviceId = store.get('iphoneDeviceId');
  const token = store.get('authToken');

  if (!iphoneDeviceId) {
    return { connected: false, error: 'Kein iPhone gekoppelt' };
  }

  if (!token) {
    return { connected: false, error: 'Nicht angemeldet' };
  }

  // Use HTTP endpoint to check iPhone status (simpler than WebSocket)
  const relayUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';
  // Convert wss:// to https:// for HTTP request
  const httpUrl = relayUrl.replace('wss://', 'https://').replace('ws://', 'http://');
  const statusUrl = `${httpUrl}/status/${iphoneDeviceId}`;

  console.log('[iPhone] Checking status via HTTP:', statusUrl);

  const startTime = Date.now();

  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });

    const latency = Date.now() - startTime;

    if (!response.ok) {
      if (response.status === 401) {
        return { connected: false, error: 'Authentifizierung fehlgeschlagen' };
      }
      return { connected: false, error: `Relay-Fehler: ${response.status}` };
    }

    const data = await response.json();
    console.log('[iPhone] Status response:', data);

    if (data.iphoneConnected) {
      return {
        connected: true,
        latency: latency,
        message: 'iPhone ist verbunden!'
      };
    } else {
      return {
        connected: false,
        error: 'Nicht mit Relay verbunden. Bitte Safari auf iPhone öffnen.'
      };
    }
  } catch (err) {
    console.error('[iPhone] Status check error:', err.message);

    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { connected: false, error: 'Relay antwortet nicht (Timeout)' };
    }

    return { connected: false, error: `Verbindung fehlgeschlagen: ${err.message}` };
  }
});

// Clean up old iPhone test files (keeps only the most recent one)
function cleanupIphoneTestFiles(keepPath = null) {
  try {
    const tempDir = path.join(app.getPath('temp'), 'dentdoc', 'tests');
    if (!fs.existsSync(tempDir)) return;

    const files = fs.readdirSync(tempDir)
      .filter(f => f.startsWith('iphone_test_') && f.endsWith('.wav'))
      .map(f => path.join(tempDir, f));

    for (const file of files) {
      if (file !== keepPath) {
        try {
          fs.unlinkSync(file);
          console.log('[iPhone Test] Deleted old test file:', path.basename(file));
        } catch (e) {
          // File might be in use, ignore
        }
      }
    }
  } catch (e) {
    console.warn('[iPhone Test] Cleanup error:', e.message);
  }
}

// iPhone Audio Test - records 3 seconds of audio and returns stats + file path
ipcMain.handle('iphone-audio-test', async (event) => {
  console.log('[iPhone] ========== Audio Test Start ==========');

  const iphoneDeviceId = store.get('iphoneDeviceId');
  const token = store.get('authToken');

  if (!iphoneDeviceId) {
    return { success: false, error: 'Kein iPhone gekoppelt' };
  }

  if (!token) {
    return { success: false, error: 'Nicht angemeldet' };
  }

  // Create temp file for test recording
  const tempDir = path.join(app.getPath('temp'), 'dentdoc', 'tests');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Clean up old test files before creating new one
  cleanupIphoneTestFiles();

  const testWavPath = path.join(tempDir, `iphone_test_${Date.now()}.wav`);

  // Start FFmpeg
  const ffmpegPath = audioRecorder.getFFmpegPath();
  const testFfmpeg = spawn(ffmpegPath, [
    '-f', 's16le',
    '-ar', '16000',
    '-ac', '1',
    '-i', 'pipe:0',
    '-acodec', 'pcm_s16le',
    '-y',
    testWavPath
  ]);

  // Connect to relay
  const relayUrl = process.env.AUDIO_RELAY_URL || 'wss://dentdoc-desktop-production-a7a1.up.railway.app';
  let testWs = null;
  let peakLevel = 0;
  let totalSamples = 0;
  let sumSquares = 0;
  let packetsReceived = 0;

  return new Promise((resolve) => {
    const TEST_DURATION_MS = 10000; // 10 seconds
    let testStarted = false;
    let testStopping = false; // Flag to prevent writes after cleanup starts
    let testTimeout = null;
    let connectionTimeout = null;

    const cleanup = () => {
      testStopping = true; // Set flag FIRST to stop any new writes

      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (testTimeout) clearTimeout(testTimeout);

      // Stop test on iPhone
      if (testWs && testWs.readyState === WebSocket.OPEN) {
        try {
          testWs.send(JSON.stringify({ type: 'TEST_STOP' }));
          testWs.close();
        } catch (e) {}
      }
      testWs = null;

      // Close FFmpeg stdin after a short delay to let remaining writes complete
      setTimeout(() => {
        if (testFfmpeg && testFfmpeg.stdin && !testFfmpeg.stdin.destroyed) {
          testFfmpeg.stdin.end();
        }
      }, 100);
    };

    // Connection timeout
    connectionTimeout = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: 'iPhone antwortet nicht. Bitte Safari öffnen.' });
    }, 10000);

    try {
      testWs = new WebSocket(`${relayUrl}/stream?device=${iphoneDeviceId}&role=desktop&token=${token}`);

      testWs.on('open', () => {
        console.log('[iPhone Test] Connected to relay');
      });

      testWs.on('message', (data) => {
        // JSON control message
        if (Buffer.isBuffer(data) && data.length > 0 && data[0] === 0x7b) {
          try {
            const msg = JSON.parse(data.toString());
            console.log('[iPhone Test] Control message:', msg.type);

            if (msg.type === 'IPHONE_CONNECTED') {
              clearTimeout(connectionTimeout);
              console.log('[iPhone Test] iPhone connected, sending TEST_START');
              testWs.send(JSON.stringify({ type: 'TEST_START' }));
            }

            if (msg.type === 'TEST_READY' || msg.type === 'IPHONE_READY') {
              if (!testStarted) {
                testStarted = true;
                console.log('[iPhone Test] Recording for 10 seconds...');

                // Send progress updates
                event.sender.send('iphone-test-progress', { stage: 'recording', percent: 0 });

                // End test after 3 seconds
                testTimeout = setTimeout(() => {
                  console.log('[iPhone Test] Test complete');
                  cleanup();

                  // Wait for FFmpeg to finish
                  testFfmpeg.on('close', () => {
                    // Calculate RMS
                    const rmsLevel = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
                    const rmsDb = rmsLevel > 0 ? 20 * Math.log10(rmsLevel) : -100;
                    const peakDb = peakLevel > 0 ? 20 * Math.log10(peakLevel) : -100;

                    console.log('[iPhone Test] Results:');
                    console.log(`  Packets: ${packetsReceived}`);
                    console.log(`  RMS: ${rmsDb.toFixed(1)} dB`);
                    console.log(`  Peak: ${peakDb.toFixed(1)} dB`);
                    console.log(`  File: ${testWavPath}`);

                    resolve({
                      success: true,
                      packetsReceived,
                      rmsDb: rmsDb.toFixed(1),
                      peakDb: peakDb.toFixed(1),
                      wavPath: testWavPath,
                      duration: TEST_DURATION_MS
                    });
                  });
                }, TEST_DURATION_MS);
              }
            }

            return;
          } catch (e) {
            // Not JSON, treat as audio
          }
        }

        // Binary PCM audio data
        if (Buffer.isBuffer(data) && data.length > 0 && testStarted && !testStopping) {
          packetsReceived++;

          // Write to FFmpeg (check testStopping again to avoid race condition)
          if (!testStopping && testFfmpeg.stdin && !testFfmpeg.stdin.destroyed) {
            testFfmpeg.stdin.write(data);
          }

          // Calculate levels for this packet (for live meter)
          const int16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
          let packetSumSquares = 0;
          for (let i = 0; i < int16.length; i++) {
            const sample = Math.abs(int16[i]) / 32768;
            sumSquares += sample * sample;
            packetSumSquares += sample * sample;
            totalSamples++;
            if (sample > peakLevel) peakLevel = sample;
          }

          // Send LIVE level to UI (based on current packet, not cumulative)
          const now = Date.now();
          if (!global.lastTestLevelUpdate || now - global.lastTestLevelUpdate > 50) {
            global.lastTestLevelUpdate = now;
            // Use current packet's RMS for live visualization
            const packetRms = Math.sqrt(packetSumSquares / int16.length);
            // Send to dashboard window directly (event.sender may not work reliably)
            if (dashboardWindow && !dashboardWindow.isDestroyed()) {
              dashboardWindow.webContents.send('iphone-test-level', packetRms);
            }
          }
        }
      });

      testWs.on('error', (err) => {
        console.error('[iPhone Test] WebSocket error:', err.message);
        cleanup();
        resolve({ success: false, error: 'Verbindung zum Relay fehlgeschlagen' });
      });

      testWs.on('close', () => {
        console.log('[iPhone Test] WebSocket closed');
      });

    } catch (err) {
      cleanup();
      resolve({ success: false, error: err.message });
    }
  });
});

// Play test audio file
ipcMain.handle('iphone-play-test-audio', async (event, wavPath) => {
  if (!wavPath || !fs.existsSync(wavPath)) {
    return { success: false, error: 'Datei nicht gefunden' };
  }

  try {
    // On Windows, use the default audio player
    const { shell } = require('electron');
    await shell.openPath(wavPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

// ============================================================================
// VAD (Voice Activity Detection) IPC Handlers
// ============================================================================

// VAD events from Renderer (handled by vadController.initialize())
// - 'vad-event' with { type: 'speech-start' | 'speech-end', timestamp, ... }

// Start VAD session
ipcMain.handle('vad-start-session', async (event, options = {}) => {
  try {
    const microphoneId = options.microphoneId || store.get('selectedMicrophone');

    const success = vadController.startSession({
      microphoneId,
      onSegmentReady: (segment) => {
        console.log('[VAD] Segment ready:', segment.index, segment.duration + 'ms');
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('vad-segment-ready', segment);
        }
      },
      onStateChange: (oldState, newState) => {
        console.log('[VAD] State:', oldState, '->', newState);
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('vad-state-change', { oldState, newState });
        }
        if (statusOverlay && !statusOverlay.isDestroyed()) {
          statusOverlay.webContents.send('vad-state-change', { oldState, newState });
        }
      },
      onError: (error) => {
        console.error('[VAD] Error:', error);
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('vad-error', { message: error.message });
        }
      }
    });

    return { success };
  } catch (error) {
    console.error('[VAD] Failed to start session:', error);
    return { success: false, error: error.message };
  }
});

// Stop VAD session and get segments
ipcMain.handle('vad-stop-session', async () => {
  try {
    const segments = await vadController.stopSession();
    return { success: true, segments };
  } catch (error) {
    console.error('[VAD] Failed to stop session:', error);
    return { success: false, error: error.message };
  }
});

// Get VAD state
ipcMain.handle('vad-get-state', () => {
  return vadController.getState();
});

// Get VAD segments
ipcMain.handle('vad-get-segments', () => {
  return vadController.getSegments();
});

// Concatenate VAD segments into single file
ipcMain.handle('vad-concatenate-segments', async (event, outputPath) => {
  try {
    const result = await vadController.concatenateSegments(outputPath);
    return { success: true, path: result };
  } catch (error) {
    console.error('[VAD] Failed to concatenate segments:', error);
    return { success: false, error: error.message };
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

  // Initialize VAD Controller
  vadController.initialize();
  console.log('[App] VAD Controller initialized');

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
