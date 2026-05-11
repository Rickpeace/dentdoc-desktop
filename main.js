// Load environment variables (.env.local overrides .env for local development)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), override: true });
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { app, BrowserWindow, Menu, globalShortcut, ipcMain, clipboard, dialog, shell } = require('electron');

// Set app user model ID for Windows notifications (must be before app ready)
if (process.platform === 'win32') {
  app.setAppUserModelId('DentDoc');
}
const { spawn, exec } = require('child_process');
const fs = require('fs');
const os = require('os');

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  const timestamp = new Date().toISOString();
  const logPath = path.join(os.tmpdir(), 'dentdoc-crash.log');
  const msg = `[${timestamp}] UNCAUGHT EXCEPTION: ${error.message}\nStack: ${error.stack}\n\n`;
  try {
    fs.appendFileSync(logPath, msg);
  } catch (e) { /* ignore */ }
  console.error('Uncaught Exception:', error);
  if (typeof autoUploadDebugLogs === 'function') autoUploadDebugLogs('uncaught-exception');
});

process.on('unhandledRejection', (reason, promise) => {
  const timestamp = new Date().toISOString();
  const logPath = path.join(os.tmpdir(), 'dentdoc-crash.log');
  const msg = `[${timestamp}] UNHANDLED REJECTION: ${reason}\n\n`;
  try {
    fs.appendFileSync(logPath, msg);
  } catch (e) { /* ignore */ }
  console.error('Unhandled Rejection:', reason);
  if (typeof autoUploadDebugLogs === 'function') autoUploadDebugLogs('unhandled-rejection');
});

const Store = require('electron-store');
const audioRecorder = require('./src/audioRecorderFFmpeg');
const apiClient = require('./src/apiClient');
const audioEncryption = require('./src/audio-encryption');
const vadController = require('./src/vad-controller');
const { showNotification, showCustomNotification, initNotificationIPC } = require('./src/notifications');
const session = require('./src/session');
const trayModule = require('./src/tray');
const recordingSlot = require('./src/recordingSlot');

// Early debug logging
const DEBUG_LOG = path.join(os.tmpdir(), 'dentdoc-main-debug.log');
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, logMessage);
  } catch (e) {
    // Can't use console.error here - would cause infinite loop
  }
}

/**
 * Helper: Normalize device name for comparison
 * Removes: USB IDs, number prefixes, parentheses, "Mikrofon"
 */
function normalizeMicName(name) {
  return name
    .replace(/\([0-9a-f]{4}:[0-9a-f]{4}\)/gi, '')  // Remove USB IDs
    .replace(/\d+-\s*/g, '')                        // Remove number prefixes like "2- "
    .replace(/[()]/g, '')                           // Remove parentheses
    .replace(/mikrofon/gi, '')                      // Remove "Mikrofon"
    .replace(/\s+/g, ' ')                           // Normalize whitespace
    .toLowerCase()
    .trim();
}

/**
 * Check if the saved microphone is available in the device list
 * Uses multiple matching strategies: exact, vendor ID, and normalized name
 *
 * @param {string} microphoneName - The saved microphone name from settings
 * @param {Array} availableDevices - List of devices from audioRecorder.listAudioDevices()
 * @returns {boolean} - True if microphone is found
 */
function isMicrophoneAvailable(microphoneName, availableDevices) {
  if (!microphoneName) return true; // No specific mic configured, will use default

  const savedVendorId = microphoneName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
  const savedNormalized = normalizeMicName(microphoneName);

  return availableDevices.some(d => {
    // 1. Exact match
    if (d.name === microphoneName) return true;
    // 2. Vendor ID match (if both have vendor IDs)
    if (savedVendorId) {
      const currentVendorId = d.name.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
      if (currentVendorId && currentVendorId === savedVendorId) return true;
    }
    // 3. Normalized name match (fallback for FFmpeg names without vendor ID)
    const currentNormalized = normalizeMicName(d.name);
    if (savedNormalized && currentNormalized && savedNormalized === currentNormalized) return true;
    return false;
  });
}

// Override console methods to also write to debug log
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args) => {
  originalConsoleLog.apply(console, args);
  debugLog('[LOG] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

console.warn = (...args) => {
  originalConsoleWarn.apply(console, args);
  debugLog('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

// Store last error for support context
let lastErrorMessage = null;
let lastErrorTime = null;

console.error = (...args) => {
  originalConsoleError.apply(console, args);
  const errorMsg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  debugLog('[ERROR] ' + errorMsg);
  // Store for support (truncate to 200 chars)
  lastErrorMessage = errorMsg.substring(0, 200);
  lastErrorTime = new Date().toISOString();
};

// Rotate log if too large (> 5MB) - keep last session's logs
try {
  if (fs.existsSync(DEBUG_LOG)) {
    const stats = fs.statSync(DEBUG_LOG);
    if (stats.size > 5 * 1024 * 1024) {
      // Rename old log, start fresh
      const backupPath = DEBUG_LOG.replace('.log', '-previous.log');
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(DEBUG_LOG, backupPath);
    }
  }
} catch (e) {
  // Ignore rotation errors
}

debugLog('=== DentDoc Starting ===');
debugLog(`App path: ${app && app.getAppPath ? app.getAppPath() : 'N/A (app not ready)'}`);
debugLog(`Is packaged: ${app && typeof app.isPackaged !== 'undefined' ? app.isPackaged : 'N/A (app not ready)'}`);
debugLog(`Temp dir: ${os.tmpdir()}`);
debugLog(`Debug log path: ${DEBUG_LOG}`);

// DSGVO: Wipe ALL audio temp files (no age threshold). Run on startup and shutdown.
// Combined with in-RAM encryption key (lost on restart), any leftover .enc files
// from crashes are already undecryptable; this also removes plain temps from
// active processing windows that didn't get cleaned up.
function wipeAllTempAudio() {
  const tempDirs = [
    path.join(os.tmpdir(), 'dentdoc'),
    path.join(os.tmpdir(), 'dentdoc', 'vad-recording'),
    path.join(os.tmpdir(), 'dentdoc', 'pipeline'),
    path.join(os.tmpdir(), 'dentdoc', 'pipeline', 'extract'),
    path.join(os.tmpdir(), 'dentdoc', 'tests')
  ];

  let totalDeleted = 0;
  let totalErrors = 0;

  for (const tempDir of tempDirs) {
    if (!fs.existsSync(tempDir)) continue;
    try {
      for (const file of fs.readdirSync(tempDir)) {
        const filePath = path.join(tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) continue;
          fs.unlinkSync(filePath);
          totalDeleted++;
        } catch (fileError) {
          totalErrors++;
          debugLog(`[Wipe] Could not delete ${filePath}: ${fileError.message}`);
        }
      }
    } catch (dirError) {
      debugLog(`[Wipe] Error reading ${tempDir}: ${dirError.message}`);
    }
  }

  // Also wipe dentdoc-* files in temp root (preview, etc.)
  try {
    const tempRoot = os.tmpdir();
    for (const file of fs.readdirSync(tempRoot)) {
      if (!file.startsWith('dentdoc-preview-') && !file.startsWith('dentdoc-')) continue;
      const filePath = path.join(tempRoot, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) continue;
        fs.unlinkSync(filePath);
        totalDeleted++;
      } catch (fileError) {
        totalErrors++;
      }
    }
  } catch (rootError) {
    debugLog(`[Wipe] Error reading temp root: ${rootError.message}`);
  }

  if (totalDeleted > 0 || totalErrors > 0) {
    console.log(`[Wipe] ${totalDeleted} audio temp files deleted, ${totalErrors} errors`);
    debugLog(`[Wipe] complete: ${totalDeleted} deleted, ${totalErrors} errors`);
  }
}

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

let tray = null;  // Will be set after trayModule.createTray()
let loginWindow = null;
let dashboardWindow = null;
let dashboardWindowResizeApplied = false;
let statusOverlay = null;
let statusOverlayReady = false;
let pendingStatusUpdate = null;
let isRecording = false;
let isProcessing = false;
let processingTimeoutId = null;
let isEnrolling = false;
let recordingStartCancelled = false;  // Flag to abort startRecording() if user cancels during startup
let currentRecordingPath = null;
let currentRecordingSlotId = null; // Backend recording slot ID for license enforcement
let currentRecordingSlotToken = null; // Token used when claiming slot (survives logout for cleanup)
let recordingSlotPending = false; // True while startRecording() is in progress (before isRecording=true)

/**
 * Release the current recording slot (with retry). Call from any stop/error/logout path.
 */
function releaseCurrentRecordingSlot() {
  if (!currentRecordingSlotId) return;
  const slotId = currentRecordingSlotId;
  const token = currentRecordingSlotToken || store.get('authToken');
  if (token) {
    recordingSlot.releaseSlot(token, slotId).catch(e => {
      console.warn('[RecordingSlot] Release failed, retrying:', e.message);
      setTimeout(() => {
        recordingSlot.releaseSlot(token, slotId).catch(() => {});
      }, 2000);
    });
  }
  recordingSlot.stopHeartbeat();
  currentRecordingSlotId = null;
  currentRecordingSlotToken = null;
}
let currentEnrollmentPath = null;
let currentEnrollmentName = null;
let currentEnrollmentRole = null;
let currentShortcut = null;
let autoHideTimeout = null;
let lastDocumentation = null;
let lastTranscript = null;
let lastReconstructedTranscript = null;
let lastTranscriptWithSpeakers = null;
let lastRecognizedSpeakers = [];
let lastDetection = null;
let lastStatus01 = null;
let lastStatusPA = null;
let lastZDocumentation = null;
// Stop guard to prevent concurrent stop calls (e.g. double F9 press during long concatenation)
let stopInProgress = false;

// Start guard to prevent concurrent start calls (e.g. F9 pressed during slow mic startup)
let startInProgress = false;

// Pause state for recording
let isPaused = false;
let pausedTime = 0;        // Accumulated pause time in ms
let pauseStartTime = null; // When current pause started
let pauseToggleInProgress = false; // Lock to prevent concurrent toggles

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

/**
 * Copy text to clipboard with HTML and RTF formatting preserved.
 * This ensures line breaks are preserved when pasting into rich text fields
 * (like Z1 Dental PVS comment windows) that strip plain text formatting.
 */
function copyToClipboardWithFormatting(text) {
  // === Plain Text with CRLF (Windows/Z1 standard) ===
  // Normalize for Z1 "Erweiterte Dokumentation" plain text fields
  const textCrlf = text
    .replace(/\r?\n/g, '\r\n')           // LF → CRLF (wichtig für Z1)
    .replace(/[ \t]+\r\n/g, '\r\n')      // Trailing spaces entfernen
    .replace(/(\r\n){3,}/g, '\r\n\r\n'); // Max 1 Leerzeile

  // === HTML Format (Word-compatible structure) ===
  const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escaped = escapeHtml(text);
  const paragraphs = escaped.split(/\r?\n\r?\n/);
  const htmlParagraphs = paragraphs.map(p => p.replace(/\r?\n/g, '<br>\r\n'));
  const htmlBody = '<p>' + htmlParagraphs.join('</p>\r\n<p>') + '</p>';
  // Full HTML document structure like Word produces
  const html = `<!DOCTYPE html>\r\n<html>\r\n<head>\r\n<meta charset="utf-8">\r\n</head>\r\n<body>\r\n${htmlBody}\r\n</body>\r\n</html>`;

  // === RTF Format (Word-compatible with font table and codepage) ===
  // Unicode codepoints that map to Windows-1252 bytes 0x80-0x9F
  // (these differ from Unicode — older RTF parsers like Charly need \'XX not \uNNNN)
  const unicodeToCp1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, // € ‚ ƒ „
    0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, // … † ‡ ˆ
    0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, // ‰ Š ‹ Œ
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, // Ž ' ' "
    0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, // " • – —
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, // ˜ ™ š ›
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,               // œ ž Ÿ
  };
  // RTF uses \par for line breaks, needs escaping for \ { } and non-ASCII chars
  const escapeRtf = (str) => str
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/[^\x00-\x7F]/g, (char) => {
      const code = char.charCodeAt(0);
      // Direct ANSI range (Latin-1 supplement, includes ä ö ü ß)
      if (code <= 255) {
        return "\\'" + code.toString(16).padStart(2, '0');
      }
      // Windows-1252 special chars (€ „ " " – — etc.)
      const cp1252 = unicodeToCp1252[code];
      if (cp1252 !== undefined) {
        return "\\'" + cp1252.toString(16).padStart(2, '0');
      }
      // Unicode fallback for everything else
      return '\\u' + code + '?';
    });

  const rtfEscaped = escapeRtf(text);
  // Convert line breaks: \n\n = double \par (paragraph), \n = single \par (line break)
  const rtfContent = rtfEscaped
    .replace(/\r?\n\r?\n/g, '\\par\\par ')
    .replace(/\r?\n/g, '\\par ');
  // Full RTF structure with font table and German codepage (like Word produces)
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}\\f0\\fs20 ${rtfContent}}`;

  // Write all formats - apps pick their preferred format
  clipboard.write({
    text: textCrlf,
    html: html,
    rtf: rtf
  });
}

/**
 * Automatically upload debug logs to backend (fire-and-forget)
 * Called on app startup and when errors occur
 * @param {string} context - Context info (e.g., 'startup', 'processAudioFile', 'processUploadedAudioFile')
 */
function autoUploadDebugLogs(context = 'unknown') {
  // Don't await - fire and forget
  (async () => {
    try {
      const token = store.get('authToken');
      if (!token) {
        debugLog(`[AutoUpload] Skipped - not logged in (context: ${context})`);
        return;
      }

      // Read the debug log file
      let logs = '';
      if (fs.existsSync(DEBUG_LOG)) {
        logs = fs.readFileSync(DEBUG_LOG, 'utf8');
        // Limit to last 500KB
        const maxSize = 500 * 1024;
        if (logs.length > maxSize) {
          logs = logs.slice(-maxSize);
        }
      }

      if (!logs || logs.trim().length === 0) {
        debugLog(`[AutoUpload] Skipped - log is empty (context: ${context})`);
        return;
      }

      // Add context marker to help identify what triggered the upload
      const contextMarker = `\n[AUTO-UPLOAD] Context: ${context} at ${new Date().toISOString()}\n`;
      logs = logs + contextMarker;

      const appVersion = app.getVersion();
      await apiClient.uploadDebugLogs(token, store, logs, appVersion, context);
      debugLog(`[AutoUpload] Success - uploaded logs (context: ${context})`);
    } catch (error) {
      // Silent fail - don't let upload errors affect the app
      debugLog(`[AutoUpload] Failed: ${error.message} (context: ${context})`);
    }
  })();
}

function openWebDashboard(path = '') {
  const baseUrl = apiClient.getBaseUrl().replace(/\/$/, '');
  shell.openExternal(baseUrl + '/dashboard' + path);
}

// Workaround for Windows Chromium bug: frameless windows can render content
// offset from window bounds on first show. Force a resize to recalculate.
function fixFramelessWindowOffset(win) {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getSize();
  win.setSize(width + 1, height);
  setTimeout(() => win.setSize(width, height), 0);
}

function openLocalDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    if (!dashboardWindowResizeApplied) {
      fixFramelessWindowOffset(dashboardWindow);
      dashboardWindowResizeApplied = true;
    }
    return;
  }

  createDashboardWindow();
  // Show the dashboard after creation
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.once('ready-to-show', () => {
      dashboardWindow.show();
      dashboardWindow.focus();
      if (!dashboardWindowResizeApplied) {
        fixFramelessWindowOffset(dashboardWindow);
        dashboardWindowResizeApplied = true;
      }
    });
  }
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
      backgroundThrottling: false,  // Keep renderer running when hidden (for F9 audio monitoring)
      webviewTag: true  // Required for tawk.to support chat webview
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
    dashboardWindowResizeApplied = false;
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
      await session.refreshUserData();
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
    setTimeout(() => { shortcutLocked = false; }, 1000);  // 1 second cooldown

    console.log('[Shortcut] F9 pressed, isRecording:', isRecording, 'isProcessing:', isProcessing);

    if (isRecording) {
      await stopRecording();
    } else if (isProcessing) {
      // Block F9 during processing - show warning but don't change status overlay
      console.log('[Shortcut] Blocked - still processing');
      showNotification('Bitte warten', 'Die vorherige Aufnahme wird noch verarbeitet...');
    } else if (startInProgress) {
      console.log('[Shortcut] Blocked - recording start already in progress');
    } else {
      // Show immediate feedback before startRecording() does async work
      startInProgress = true;
      updateStatusOverlay('Aufnahme wird gestartet...', 'Bitte warten...', 'starting');
      try {
        await startRecording();
      } finally {
        startInProgress = false;
      }
    }
  });

  if (registered) {
    currentShortcut = shortcut;
    store.set('shortcut', shortcut);
    trayModule.updateTrayMenu();
    return true;
  } else {
    console.error(`Shortcut ${shortcut} registration failed`);
    // Try to re-register old shortcut
    const oldShortcut = store.get('shortcut') || 'F9';
    if (oldShortcut !== shortcut) {
      globalShortcut.register(oldShortcut, async () => {
        if (shortcutLocked) return;
        shortcutLocked = true;
        setTimeout(() => { shortcutLocked = false; }, 1000);

        if (isRecording) {
          await stopRecording();
        } else if (isProcessing) {
          console.log('[Shortcut] Blocked - still processing');
          showNotification('Bitte warten', 'Die vorherige Aufnahme wird noch verarbeitet...');
        } else if (startInProgress) {
          console.log('[Shortcut] Blocked - recording start already in progress');
        } else {
          startInProgress = true;
          updateStatusOverlay('Aufnahme wird gestartet...', 'Bitte warten...', 'starting');
          try {
            await startRecording();
          } finally {
            startInProgress = false;
          }
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
 * Quick check if transcriptPath folder is accessible for writing.
 * Shows warning dialog if folder is unavailable.
 * @returns {Promise<boolean>} true if folder is OK or user wants to continue, false to abort
 */
async function checkTranscriptFolderBeforeRecording() {
  const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
  const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;

  try {
    // Quick check: try to access the folder
    if (!fs.existsSync(transcriptPath)) {
      // Try to create it
      fs.mkdirSync(transcriptPath, { recursive: true });
    }

    // Try to write a test file
    const testFile = path.join(transcriptPath, '.dentdoc-test');
    fs.writeFileSync(testFile, 'test', 'utf8');
    fs.unlinkSync(testFile);

    return true; // Folder is OK
  } catch (error) {
    console.warn('[FolderCheck] Transcript folder not accessible:', transcriptPath, error.message);
    debugLog(`[FolderCheck] Folder error: ${transcriptPath} - ${error.code}: ${error.message}`);

    // Show warning dialog
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Aufnahme starten', 'Abbrechen'],
      defaultId: 1,
      cancelId: 1,
      title: 'Speicherordner nicht erreichbar',
      message: 'Der Transkript-Ordner ist nicht verfügbar.',
      detail: `Der Ordner "${transcriptPath}" ist nicht erreichbar oder nicht beschreibbar.\n\n` +
              'Mögliche Ursachen:\n' +
              '• Netzwerkverbindung unterbrochen\n' +
              '• Keine Schreibberechtigung\n' +
              '• Ordner wurde gelöscht\n\n' +
              'Die Aufnahme kann trotzdem gestartet werden, aber Transkripte werden NICHT gespeichert.\n' +
              'Die Dokumentation wird wie gewohnt in die Zwischenablage kopiert.'
    });

    const userContinued = result.response === 0;
    if (userContinued) {
      // Log that user continued despite folder issue - helps track folder problems
      debugLog(`[FolderCheck] User continued recording despite folder issue: ${transcriptPath}`);
      autoUploadDebugLogs('folder-access-warning');
    }

    // 0 = "Aufnahme starten", 1 = "Abbrechen"
    return userContinued;
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
 * @param {string} options.tempAudioPath - Path to temporary audio file (only used to derive job ID)
 * @param {boolean} options.saveTranscript - Whether to save transcript
 *
 * DSGVO: audio is NEVER saved permanently. Only transcript text + JSON metadata are persisted.
 */
function saveRecordingFiles(baseFolderPath, summary, transcript, speakerMapping = null, options = {}) {
  const { tempAudioPath = null, saveTranscript = true, utterances = null, words = null, topicSegments = null, passages = null, reconstructedTranscript = null, transcriptWithSpeakers = null, recognizedSpeakers = [], status01 = null, statusPA = null, zDocumentation = null } = options;

  // Nothing to save
  if (!saveTranscript) {
    return;
  }

  // Extract unique job ID from temp audio filename
  // Examples: "recording-1705312345678.webm" -> "1705312345678"
  //           "speech_only_1705312345678.wav" -> "1705312345678"
  let jobId = Date.now().toString(); // Fallback if no temp audio path
  if (tempAudioPath) {
    const tempFilename = path.basename(tempAudioPath, path.extname(tempAudioPath));
    // Remove common prefixes from pipeline temp files
    jobId = tempFilename
      .replace('recording-', '')
      .replace('speech_only_', '')
      .replace('converted_', '')
      .replace('leveled_', '');
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

  // Build Z-Doku section if available (Agent V2.1 - Agent 4)
  let zDokuSection = '';
  if (zDocumentation) {
    zDokuSection = `

────────────────────────────────────────────────────────────────────
  Z-DOKUMENTATION (CHEF-ZUSAMMENFASSUNG)
────────────────────────────────────────────────────────────────────

${zDocumentation}
`;
  }

  // Build normalized transcript section if available (Agent V2)
  let normalizedSection = '';
  if (reconstructedTranscript) {
    normalizedSection = `

────────────────────────────────────────────────────────────────────
  NORMALISIERTES TRANSKRIPT
────────────────────────────────────────────────────────────────────

${reconstructedTranscript}
`;
  }

  // Use transcriptWithSpeakers if available, otherwise fall back to raw transcript
  const finalTranscriptText = transcriptWithSpeakers || transcript;

  // Build recognized speakers line
  const recognizedSpeakersLine = recognizedSpeakers && recognizedSpeakers.length > 0
    ? `Erkannte Personen: ${recognizedSpeakers.join(', ')}\n`
    : '';

  // Create file content for transcript
  const content = `╔════════════════════════════════════════════════════════════════════╗
║                          DENTDOC TRANSKRIPT                        ║
╚════════════════════════════════════════════════════════════════════╝

Datum:    ${now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Uhrzeit:  ${now.toLocaleTimeString('de-DE')}
${recognizedSpeakersLine}
────────────────────────────────────────────────────────────────────
  ZUSAMMENFASSUNG
────────────────────────────────────────────────────────────────────

${summary}
${zDokuSection}${normalizedSection}

────────────────────────────────────────────────────────────────────
  TRANSKRIPT MIT SPRECHERN
────────────────────────────────────────────────────────────────────

${finalTranscriptText}


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

      // Set folder type to "Documents" to prevent Windows from treating it as "Music" folder
      // (Windows auto-detects .wav files and sets folder type to Music, which has bad sorting)
      const desktopIniPath = path.join(folderPath, 'desktop.ini');
      const desktopIniContent = '[.ShellClassInfo]\r\nFolderType=Documents\r\n';
      fs.writeFileSync(desktopIniPath, desktopIniContent, 'utf8');
      // Set desktop.ini as hidden and system file (required for Windows to read it)
      try {
        require('child_process').execSync(`attrib +s +h "${desktopIniPath}"`, { windowsHide: true });
        // Also set the folder as system folder so desktop.ini is respected
        require('child_process').execSync(`attrib +r "${folderPath}"`, { windowsHide: true });
      } catch (e) {
        // Ignore errors on non-Windows or if attrib fails
      }
    }

    // Save transcript if enabled
    if (saveTranscript) {
      const transcriptPath = path.join(folderPath, `${baseFilename}.txt`);
      // Normalize for Windows/Z1 compatibility
      const contentCrlf = content
        .replace(/\r?\n/g, '\r\n')           // LF → CRLF
        .replace(/[ \t]+\r\n/g, '\r\n')      // Trailing spaces entfernen
        .replace(/(\r\n){3,}/g, '\r\n\r\n'); // Max 1 Leerzeile
      fs.writeFileSync(transcriptPath, contentCrlf, 'utf8');

      // Save JSON metadata for dashboard transcript browser
      if (utterances && utterances.length > 0) {
        const jsonMetadata = {
          jobId: jobId,
          createdAt: now.toISOString(),
          duration: utterances.length > 0 ? utterances[utterances.length - 1].end : 0,
          speakers: [...new Set(Object.values(speakerMapping || {}).filter(s => s))],
          utterances: utterances.map(u => ({
            speaker: speakerMapping && speakerMapping[u.speaker] ? speakerMapping[u.speaker] : u.speaker,
            start: u.start,
            end: u.end,
            text: u.text
          })),
          words: words || null, // Word-level timestamps for precise audio navigation
          summary: summary,
          zDocumentation: zDocumentation || null, // Z-Dokumentation / Chef-Zusammenfassung
          topicSegments: topicSegments || null, // KI-extracted topic segments for audio navigation
          passages: passages || null, // Semantic audio passages (15-40 sec thematic clips)
          status01: status01 || null, // Strukturierter 01-Befund (Zahnstatus)
          statusPA: statusPA || null // Strukturierter PA-Status (Parodontalstatus)
        };
        const jsonPath = path.join(folderPath, `${baseFilename}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(jsonMetadata, null, 2), 'utf8');
      }
    }

    // DSGVO: audio is intentionally never persisted to disk.
  });

  // Nice formatted log for saved files
  const savedItems = [];
  if (saveTranscript) savedItems.push('Transkript');
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

}

function createLoginWindow() {
  // Reuse existing login window if already open
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }

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
    backgroundColor: store.get('theme', 'dark') === 'light' ? '#ffffff' : '#0a0a0b',
    show: false // Don't show until ready
  });

  loginWindow.loadFile('src/login.html');
  loginWindow.setMenu(null);

  // Show window when ready and focus it prominently
  loginWindow.once('ready-to-show', () => {
    loginWindow.show();
    loginWindow.focus();
  });

  // Auto-resize to fit content after load
  loginWindow.webContents.on('did-finish-load', () => {
    loginWindow.webContents.executeJavaScript('document.body.scrollHeight').then(height => {
      const [width] = loginWindow.getSize();
      loginWindow.setSize(width, Math.min(height, 800)); // Cap at 800px max
    });
  });

  // If user closes login window without logging in, quit the app entirely
  // (don't let them hide to tray without authentication)
  loginWindow.on('close', (e) => {
    const token = store.get('authToken');
    if (!token) {
      app.quit();
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
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
  trayModule.updateTrayMenu();

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
        const errMsg = transcriptionResult.error || 'Transkription fehlgeschlagen';
        // AssemblyAI returns English error for no speech with language_detection enabled
        if (errMsg.includes('no spoken audio') || errMsg.includes('language_detection')) {
          throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
        }
        throw new Error(errMsg);
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

    // Handle words (word-level timestamps from AssemblyAI)
    const words = transcriptionResult.words
      ? (typeof transcriptionResult.words === 'string'
        ? JSON.parse(transcriptionResult.words)
        : transcriptionResult.words)
      : null;

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
      autoUploadDebugLogs('speakerRecognition-error');
      // Continue anyway - speaker identification is optional
    }

    // Generate documentation - Agent V2.1 only
    updateStatusOverlay('Dokumentation...', 'KI-Agent erstellt Dokumentation...', 'processing', { step: 4 });
    const result = await apiClient.getDocumentationAgentV2_1(transcriptionId, token, app.getVersion());

    const documentation = result.documentation;
    const finalTranscript = result.transcript || transcript;
    const reconstructedTranscript = result.reconstructedTranscript || null;
    const transcriptWithSpeakers = result.transcriptWithSpeakers || null;
    const recognizedSpeakers = result.recognizedSpeakers || [];
    const detection = result.detection || null;
    const status01 = result.status01 || null;
    const statusPA = result.statusPA || null;
    const zDocumentation = result.zDocumentation || null;

    // Store for "show last result"
    lastDocumentation = documentation;
    lastTranscript = finalTranscript;
    lastReconstructedTranscript = reconstructedTranscript;
    lastTranscriptWithSpeakers = transcriptWithSpeakers;
    lastRecognizedSpeakers = recognizedSpeakers;
    lastDetection = detection;
    lastStatus01 = status01;
    lastStatusPA = statusPA;
    lastZDocumentation = zDocumentation;
    store.set('lastDocumentationTime', new Date().toISOString());

    // Copy to clipboard (with HTML formatting for rich text apps like Z1)
    copyToClipboardWithFormatting(documentation);

    // Show success immediately - user can already paste the documentation
    const autoClose = store.get('autoCloseOverlay', false);
    updateStatusOverlay(
      'Fertig!',
      'Dokumentation in Zwischenablage kopiert (Strg+V)',
      'success',
      { documentation, zDocumentation, transcript: finalTranscript, autoClose, reconstructedTranscript, transcriptWithSpeakers, recognizedSpeakers, detection, status01, statusPA }
    );

    // Reset processing state immediately so user knows it's done
    isProcessing = false;
    trayModule.updateTrayMenu();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    // === BACKGROUND TASKS (run async, don't block) ===
    // These run in the background and save results when complete
    // User already has their documentation in clipboard at this point

    const autoExport = store.get('autoExport', true);
    console.log('Save settings - autoExport:', autoExport);
    console.log('currentRecordingPath:', currentRecordingPath);

    // Run background tasks without blocking
    (async () => {
      let topicSegments = null;
      let passages = null;

      // Extract topic segments using AI (for clickable audio navigation in dashboard)
      if (words && words.length > 0) {
        try {
          debugLog('[Background] Extracting topic segments from transcript...');
          const topicResult = await apiClient.extractTopicSegments(token, transcript, words);
          topicSegments = topicResult.topics || null;
          debugLog(`[Background] Topic segments extracted: ${topicSegments ? topicSegments.length : 0}`);
        } catch (topicError) {
          console.error('[Background] Topic extraction failed (non-critical):', topicError);
          debugLog('[Background] Topic extraction failed: ' + topicError.message);
        }
      }

      // Segment transcript into semantic passages (for topic badges)
      if (words && words.length > 0) {
        try {
          debugLog('[Background] Segmenting transcript into semantic passages...');
          const passageResult = await apiClient.segmentPassages(token, transcript, words);
          passages = passageResult.passages || [];
          debugLog(`[Background] Passages created: ${passages.length}`);
        } catch (passageError) {
          console.error('[Background] Passage segmentation failed (non-critical):', passageError);
          debugLog('[Background] Passage segmentation failed: ' + passageError.message);
        }
      }

      // Save files with all data (including background results)
      const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
      const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;
      if (autoExport && finalTranscript) {
        try {
          saveRecordingFiles(transcriptPath, documentation, finalTranscript, currentSpeakerMapping, {
            tempAudioPath: currentRecordingPath,
            saveTranscript: autoExport,
            utterances: utterances,
            words: words,
            topicSegments: topicSegments,
            passages: passages,
            reconstructedTranscript: reconstructedTranscript,
            transcriptWithSpeakers: transcriptWithSpeakers,
            recognizedSpeakers: recognizedSpeakers,
            status01: status01,
            statusPA: statusPA,
            zDocumentation: zDocumentation
          });
          debugLog('[Background] Files saved successfully');
        } catch (error) {
          console.error('[Background] Failed to save recording files:', error);
        }
      }

      debugLog('[Background] All background tasks completed');
    })();

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

    // Update user minutes
    try {
      const user = await apiClient.getUser(token);
      if (user) {
        store.set('user', user);
        trayModule.updateTrayMenu();
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

    isProcessing = false;
    trayModule.updateTrayMenu();

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

    // Auto-upload logs for real errors (not subscription/user issues)
    const isRealError = !error.message.startsWith('TRIAL_EXPIRED:') &&
                        !error.message.startsWith('SUBSCRIPTION_INACTIVE:') &&
                        !error.message.includes('Keine Sprache erkannt') &&
                        !error.message.includes('zu kurz') &&
                        !error.message.includes('leer') &&
                        !error.message.includes('Minuten') &&
                        !error.message.includes('Guthaben');
    if (isRealError) {
      autoUploadDebugLogs('processAudioFile-error');
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
  const { source = 'mic', skipVAD = false, liveSegments = null } = options;
  const processStartTime = Date.now();

  // Get file size for logging
  let fileSizeMB = '?';
  try {
    const fileSize = fs.statSync(audioFilePath).size;
    fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
  } catch (e) {}

  console.log('');
  console.log('========================================');
  console.log('       VERARBEITUNG GESTARTET');
  console.log('========================================');
  console.log(`  Datei: ${path.basename(audioFilePath)} (${fileSizeMB} MB)`);
  console.log(`  Quelle: ${source}`);
  console.log(`  Live-VAD: ${skipVAD ? (liveSegments && liveSegments.length > 0 ? `${liveSegments.length} Segmente` : 'keine Segmente') : 'deaktiviert (Offline-VAD)'}`);
  console.log('');

  updateStatusOverlay('Verarbeitung...', 'Audio wird analysiert...', 'processing', { step: 0 });

  try {
    let wavPath;

    if (skipVAD && liveSegments && liveSegments.length > 0) {
      // Live VAD collected markers during recording → just render speech-only from markers
      console.log(`///// SCHRITT 1: LIVE-VAD RENDER (${liveSegments.length} Segmente) /////`);
      const renderStart = Date.now();
      const pipeline = require('./src/pipeline');
      const speechOnlyPath = path.join(os.tmpdir(), 'dentdoc', 'pipeline', `speech_only_${Date.now()}.wav`);

      // Ensure output directory exists
      const outputDir = path.dirname(speechOnlyPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const result = await pipeline.speechRenderer.renderSpeechOnly(liveSegments, speechOnlyPath);
      wavPath = result.wavPath;

      const speechDuration = pipeline.speechRenderer.getTotalDuration(liveSegments);
      console.log(`[TIMING] Speech render from live markers: ${((Date.now() - renderStart) / 1000).toFixed(2)}s (${(speechDuration / 1000).toFixed(0)}s speech)`);
      updateStatusOverlay('Verarbeitung...', `${(speechDuration / 1000).toFixed(0)}s Sprache`, 'processing', { step: 0 });
    } else if (skipVAD) {
      // Live VAD returned 0 segments → upload full recording as-is (no silence removal)
      console.log('///// SCHRITT 1: KEIN VAD (vollständige Aufnahme) /////');
      console.warn('[VAD] Live VAD: 0 Segmente, lade vollständige Aufnahme hoch');
      wavPath = audioFilePath;
      updateStatusOverlay('Verarbeitung...', 'Audio bereit', 'processing', { step: 0 });
    } else {
      // Offline VAD (for manual file upload)
      console.log('///// SCHRITT 1: OFFLINE-VAD /////');
      console.log('  Stille wird erkannt und entfernt...');
      const vadStart = Date.now();
      const pipeline = require('./src/pipeline');

      const { wavPath: vadWavPath } = await pipeline.processFileWithVAD(audioFilePath, {
        source,
        onProgress: (progress) => {
          const step = (progress.stage === 'vad' || progress.stage === 'render') ? 0 : 1;
          updateStatusOverlay('Verarbeitung...', progress.message, 'processing', { step, progressPercent: progress.percent });
        }
      });
      wavPath = vadWavPath;
      console.log(`[TIMING] Offline VAD completed in ${((Date.now() - vadStart) / 1000).toFixed(2)}s`);
    }

    // Now send the speech-only file to AssemblyAI
    console.log('///// SCHRITT 2: UPLOAD /////');
    console.log('  Audio wird an AssemblyAI gesendet...');
    const uploadStart = Date.now();
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
    console.log(`[TIMING] Upload completed in ${((Date.now() - uploadStart) / 1000).toFixed(2)}s`);

    // Poll for real transcription status from AssemblyAI
    const transcriptionStart = Date.now();
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
        const errMsg = transcriptionResult.error || 'Transkription fehlgeschlagen';
        // AssemblyAI returns English error for no speech with language_detection enabled
        if (errMsg.includes('no spoken audio') || errMsg.includes('language_detection')) {
          throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
        }
        throw new Error(errMsg);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error('Zeitüberschreitung bei der Transkription');
    }

    console.log('///// SCHRITT 3: TRANSKRIPTION /////');
    console.log(`[TIMING] Transcription completed in ${((Date.now() - transcriptionStart) / 1000).toFixed(2)}s`);
    console.log('  AssemblyAI Transkription abgeschlossen');

    const transcript = transcriptionResult.transcriptText;
    const utterances = typeof transcriptionResult.utterances === 'string'
      ? JSON.parse(transcriptionResult.utterances)
      : transcriptionResult.utterances;

    // Handle words (word-level timestamps from AssemblyAI)
    const words = transcriptionResult.words
      ? (typeof transcriptionResult.words === 'string'
        ? JSON.parse(transcriptionResult.words)
        : transcriptionResult.words)
      : null;

    if (!utterances || utterances.length === 0) {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    console.log(`  Utterances: ${utterances.length}`);
    console.log(`  Words: ${words ? words.length : 0}`);
    console.log('');

    // Speaker recognition
    console.log('///// SCHRITT 4: SPEAKER /////');
    console.log('  Sprecher werden identifiziert...');
    const speakerStart = Date.now();
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
      console.log(`[TIMING] Speaker recognition completed in ${((Date.now() - speakerStart) / 1000).toFixed(2)}s`);
    } catch (speakerError) {
      console.log(`[TIMING] Speaker recognition failed after ${((Date.now() - speakerStart) / 1000).toFixed(2)}s`);
      console.log('  [!] Fehler bei Sprechererkennung');
      autoUploadDebugLogs('speakerRecognition-error');
    }

    // Generate documentation - Agent V2.1 only
    console.log('///// SCHRITT 5: DOKUMENTATION /////');
    console.log('  KI erstellt Dokumentation...');
    const docStart = Date.now();
    updateStatusOverlay('Verarbeitung...', 'KI-Agent erstellt Dokumentation...', 'processing', { step: 4 });

    const docResponse = await apiClient.getDocumentationAgentV2_1(transcriptionId, token, app.getVersion());
    console.log(`[TIMING] Documentation completed in ${((Date.now() - docStart) / 1000).toFixed(2)}s`);

    const documentation = docResponse.documentation;
    const finalTranscript = docResponse.transcript || transcript;  // Use formatted transcript with speaker labels
    const reconstructedTranscript = docResponse.reconstructedTranscript || null;
    const transcriptWithSpeakers = docResponse.transcriptWithSpeakers || null;
    const recognizedSpeakers = docResponse.recognizedSpeakers || [];
    const detection = docResponse.detection || null;
    const status01 = docResponse.status01 || null;
    const statusPA = docResponse.statusPA || null;
    const zDocumentation = docResponse.zDocumentation || null;

    // Store for potential retry/copy
    lastDocumentation = documentation;
    lastTranscript = finalTranscript;
    lastReconstructedTranscript = reconstructedTranscript;
    lastTranscriptWithSpeakers = transcriptWithSpeakers;
    lastRecognizedSpeakers = recognizedSpeakers;
    lastDetection = detection;
    lastStatus01 = status01;
    lastStatusPA = statusPA;
    lastZDocumentation = zDocumentation;
    store.set('lastDocumentationTime', new Date().toISOString());

    // Copy to clipboard (with HTML formatting for rich text apps like Z1)
    copyToClipboardWithFormatting(documentation);

    // Show success IMMEDIATELY - user can already paste the documentation
    console.log('  Dokumentation erstellt!');
    console.log('');
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
      { documentation, zDocumentation, transcript: finalTranscript, autoClose, reconstructedTranscript, transcriptWithSpeakers, recognizedSpeakers, detection, status01, statusPA }
    );

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

    // Total processing time
    console.log('');
    console.log(`[TIMING] ========== TOTAL PROCESSING: ${((Date.now() - processStartTime) / 1000).toFixed(2)}s ==========`);
    console.log('');

    // Notify dashboard to refresh stats
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-completed');
    }

    // Reset tray
    const normalIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(normalIconPath);
    tray.setToolTip('DentDoc - Bereit');

    // === BACKGROUND TASKS (run async, don't block success) ===
    const autoExport = store.get('autoExport', true);

    (async () => {
      let topicSegments = null;
      let passages = null;

      // Extract topic segments using AI (for clickable audio navigation in dashboard)
      if (words && words.length > 0) {
        try {
          console.log('  [Background] Extrahiere Themen-Segmente...');
          const topicResult = await apiClient.extractTopicSegments(token, transcript, words);
          topicSegments = topicResult.topics || null;
          console.log(`  [Background] Themen-Segmente: ${topicSegments ? topicSegments.length : 0}`);
        } catch (topicError) {
          console.log('  [Background] Themen-Extraktion fehlgeschlagen (nicht kritisch):', topicError.message);
        }
      }

      // Segment transcript into semantic passages (for topic badges)
      if (words && words.length > 0) {
        try {
          console.log('  [Background] Segmentiere Transkript in Passagen...');
          const passageResult = await apiClient.segmentPassages(token, transcript, words);
          passages = passageResult.passages || [];
          console.log(`  [Background] Passagen erstellt: ${passages.length}`);
        } catch (passageError) {
          console.log('  [Background] Passagen-Segmentierung fehlgeschlagen (nicht kritisch):', passageError.message);
        }
      }

      // Save files with all data
      const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
      const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;

      if (autoExport && finalTranscript) {
        console.log('  [Background] Speichere Dateien...');
        try {
          saveRecordingFiles(transcriptPath, documentation, finalTranscript, currentSpeakerMapping, {
            tempAudioPath: wavPath,
            saveTranscript: autoExport,
            utterances: utterances,
            words: words,
            topicSegments: topicSegments,
            passages: passages,
            reconstructedTranscript: reconstructedTranscript,
            transcriptWithSpeakers: transcriptWithSpeakers,
            recognizedSpeakers: recognizedSpeakers,
            status01: status01,
            statusPA: statusPA,
            zDocumentation: zDocumentation
          });
          console.log('  [Background] Dateien gespeichert!');
        } catch (error) {
          console.log('  [Background] Fehler beim Speichern:', error.message);
        }
      }

      console.log('  [Background] Alle Hintergrund-Tasks abgeschlossen');
    })();

  } catch (error) {
    console.log('');
    console.log('!!!!! FEHLER !!!!!');
    console.log(`  ${error.message}`);
    console.log(`[TIMING] FAILED after ${((Date.now() - processStartTime) / 1000).toFixed(2)}s`);
    console.log('!!!!!!!!!!!!!!!!!!');

    // Auto-upload logs for processing errors (not subscription issues)
    const isRealError = !error.message.startsWith('TRIAL_EXPIRED:') &&
                        !error.message.startsWith('SUBSCRIPTION_INACTIVE:') &&
                        !error.message.includes('Minuten') &&
                        !error.message.includes('Guthaben');
    if (isRealError) {
      autoUploadDebugLogs('processFileWithVAD-error');
    }

    updateStatusOverlay('Fehler', error.message, 'error');

    const normalIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(normalIconPath);
    tray.setToolTip('DentDoc - Bereit');

  } finally {
    isProcessing = false;
    trayModule.updateTrayMenu();
  }
}

async function startRecording() {
  // Reset cancel flag at start
  recordingStartCancelled = false;

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
      trayModule.updateTrayMenu();
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

  // Claim recording slot in background (non-blocking!)
  // Recording starts immediately — if rejected, it gets cancelled after ~200ms
  const deviceId = store.get('deviceId');
  recordingSlotPending = true; // Mark that we intend to record (isRecording is set later by VAD/iPhone/Standard)
  if (deviceId && token) {
    recordingSlot.claimSlot(token, deviceId).then(result => {
      // Check if recording was cancelled before claim resolved
      // Use both flags: isRecording (set by VAD/iPhone/Standard) OR recordingSlotPending (set above, cleared on cancel)
      if (!isRecording && !recordingSlotPending) {
        recordingSlot.releaseSlot(token, result.recordingId).catch(e =>
          console.warn('[RecordingSlot] Release after early-stop:', e.message));
        return;
      }
      currentRecordingSlotId = result.recordingId;
      currentRecordingSlotToken = token;
      recordingSlot.startHeartbeat(token, currentRecordingSlotId);
      console.log('[RecordingSlot] Slot claimed:', currentRecordingSlotId);
    }).catch(err => {
      if (err.message && err.message.includes('MAX_RECORDINGS')) {
        console.log('[RecordingSlot] Max recordings reached, cancelling recording');
        cancelCurrentRecording().then(() => {
          hideStatusOverlay();
          updateStatusOverlay('Alle Lizenzen belegt',
            'Es läuft bereits eine Aufnahme auf einem anderen Gerät. Bitte stoppen Sie diese zuerst.', 'error');
        });
        return;
      }
      // Network error: proceed with recording (graceful degradation)
      console.warn('[RecordingSlot] Claim failed, proceeding anyway:', err.message);
      currentRecordingSlotId = null;
    });
  }

  // Check if transcript folder is accessible (only if we're saving something)
  const shouldSaveTranscript = store.get('autoExport', true);

  if (shouldSaveTranscript) {
    const folderOk = await checkTranscriptFolderBeforeRecording();
    if (!folderOk) {
      console.log('[Recording] User cancelled due to folder access issue');
      hideStatusOverlay(); // Hide the "Aufnahme wird gestartet" overlay
      return;
    }
  }

  // Check if user cancelled during startup
  if (recordingStartCancelled) {
    console.log('[Recording] Cancelled during startup');
    return;
  }

  // Check if iPhone microphone is enabled
  const microphoneSource = store.get('microphoneSource', 'desktop');
  if (microphoneSource === 'iphone') {
    console.log('[Recording] iPhone mode - starting iPhone recording');
    startRecordingWithIphone().catch(err => {
      console.error('[Recording] iPhone start failed:', err);
      autoUploadDebugLogs('startRecordingWithIphone-error');
      updateStatusOverlay('Smartphone Fehler', err.message, 'error');
    });
    return;
  }

  // Check if VAD mode is enabled
  const vadEnabled = store.get('vadEnabled', true);
  if (vadEnabled) {
    console.log('[Recording] VAD mode enabled - starting VAD session');
    startRecordingWithVAD().catch(err => {
      console.error('[Recording] VAD start failed:', err);
      autoUploadDebugLogs('startRecordingWithVAD-error');
      updateStatusOverlay('VAD Fehler', err.message, 'error');
    });
    return;
  }

  // DSGVO: temp audio is always cleaned up (encrypted, never persisted permanently)
  const deleteAudio = true;
  const microphoneName = store.get('microphoneName') || null;

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

    // Start recording first - only update UI state if successful
    currentRecordingPath = await audioRecorder.startRecording(deleteAudio, microphoneName);

    // Recording started successfully - now update UI
    isRecording = true;
    isPaused = false;
    pausedTime = 0;
    pauseStartTime = null;
    trayModule.updateTrayMenu();

    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft...');

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('Aufnahme läuft...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    // Notify dashboard to start audio monitoring (for real level display in status overlay)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-started', { microphoneId: store.get('microphoneId') });
    }
  } catch (error) {
    console.error('Recording error:', error);

    // Force stop to ensure mic is released if FFmpeg partially started
    try {
      await audioRecorder.forceStop();
    } catch (e) {
      // Ignore - just ensuring cleanup
    }

    autoUploadDebugLogs('startRecording-error');
    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht gestartet werden', 'error');
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
    throw new Error('Kein Smartphone gekoppelt. Bitte erst in Einstellungen koppeln.');
  }

  try {
    isRecording = true;
    isIphoneSession = true;
    isPaused = false;
    pausedTime = 0;
    pauseStartTime = null;
    trayModule.updateTrayMenu();

    // Change tray icon to recording state
    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - Smartphone-Aufnahme wird vorbereitet...');

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
      // No timeout - user can cancel with F9 or X button
      // The QR code is shown so they have time to scan it
      const timeout = null;

      iphoneRelayWs.on('open', () => {
        console.log('[iPhone] Connected to relay, waiting for iPhone...');
        tray.setToolTip('DentDoc - Warte auf Smartphone...');

        // Show status overlay with QR code for /mic page
        updateStatusOverlay(
          'Warte auf Smartphone...',
          'Bitte öffnen Sie die Mikrofon-Seite auf Ihrem Smartphone',
          'waiting-iphone',
          { micUrl: 'https://dentdoc.de/mic' }
        );

        // Start heartbeat to keep connection alive
        if (iphoneHeartbeatInterval) {
          clearInterval(iphoneHeartbeatInterval);
        }
        iphoneHeartbeatInterval = setInterval(() => {
          if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
            iphoneRelayWs.send(JSON.stringify({ type: 'PING' }));
          }
        }, 5000); // Every 5 seconds (iOS Safari needs frequent keepalive)
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
                // Copy to aligned buffer - WebSocket chunks may have odd offset/length
                const alignedLength = data.length & ~1; // ensure even byte count
                if (alignedLength >= 2) {
                  const aligned = Buffer.from(data.buffer, data.byteOffset, alignedLength);
                  const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, alignedLength / 2);
                  let sum = 0;
                  for (let i = 0; i < int16.length; i++) {
                    sum += int16[i] * int16[i];
                  }
                  const rawRms = Math.sqrt(sum / int16.length) / 32768; // Normalize to 0-1
                  // Boost RMS for better visual feedback (iPhone is further from mouth, typically 0.01-0.05)
                  const rms = Math.min(1, rawRms * 40);

                  // Send to status overlay window (not mainWindow!)
                  if (statusOverlay && !statusOverlay.isDestroyed()) {
                    statusOverlay.webContents.send('iphone-audio-level', rms);
                  }
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

          // Auto-reconnect to relay - so we can receive IPHONE_CONNECTED when phone reconnects
          console.log('[iPhone] Reconnecting to relay...');
          setTimeout(() => {
            if (!isIphoneSession || !isRecording) return; // Recording ended, don't reconnect

            reconnectToRelay(iphoneDeviceId, token, relayUrl, timeout, resolve);
          }, 1000);
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
      try {
        if (iphoneRelayWs.readyState === 1) {
          iphoneRelayWs.send(JSON.stringify({ type: 'STOP' }));
        }
      } catch (e) {
        debugLog(`[iPhone] WebSocket send STOP failed during error cleanup: ${e.message}`);
      }
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isRecording = false;
    isIphoneSession = false;
    trayModule.updateTrayMenu();

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
    tray.setToolTip('DentDoc - Smartphone verbunden, starte Aufnahme...');

    // If recording already in progress, send RESUME instead of START
    // This happens when phone tab reconnects mid-recording (e.g., new tab took over)
    if (isIphoneSession && isRecording) {
      console.log('[iPhone] Phone reconnected during recording, sending RESUME');
      iphoneRelayWs.send(JSON.stringify({ type: 'RESUME' }));
      updateStatusOverlay(
        'Smartphone verbindet...',
        'Warte auf Mikrofon-Bereitschaft',
        'waiting-iphone',
        { micUrl: 'https://dentdoc.de/mic' }
      );
    } else {
      console.log('[iPhone] iPhone connected, sending START');
      iphoneRelayWs.send(JSON.stringify({ type: 'START' }));
    }
  }

  if (msg.type === 'IPHONE_READY') {
    console.log('[iPhone] Recording started on iPhone');
    tray.setToolTip('DentDoc - 🔴 Smartphone-Aufnahme läuft...');

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('Smartphone-Aufnahme...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    resolve();
  }

  // Page visibility events from Safari - detect when mic page goes to background
  // When hidden, mic is STOPPED (not just paused) - show QR for user to return
  if (msg.type === 'PAGE_HIDDEN') {
    console.warn('[iPhone] Safari page went to background - mic STOPPED');
    if (isIphoneSession && isRecording) {
      updateStatusOverlay(
        'Smartphone im Hintergrund',
        'Bitte Browser öffnen oder QR-Code scannen',
        'waiting-iphone',
        { micUrl: 'https://dentdoc.de/mic' }
      );
    }
  }

  // PAGE_VISIBLE means same tab came back to foreground
  // Mic was released when page was hidden, user needs to tap "Aktivieren" again
  if (msg.type === 'PAGE_VISIBLE') {
    console.log('[iPhone] Safari page is visible again - needs reactivation');
    if (isIphoneSession && isRecording) {
      // Show activation message - mic was released, user must tap button
      updateStatusOverlay(
        '⚠️ Smartphone reaktivieren',
        'Tippen Sie auf dem Handy auf "Aktivieren"',
        'warning'
      );
      // Send RESUME - phone will respond with IPHONE_NEEDS_ACTIVATION or start streaming
      if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
        iphoneRelayWs.send(JSON.stringify({ type: 'RESUME' }));
      }
    }
  }

  if (msg.type === 'IPHONE_DISCONNECTED') {
    console.warn('[iPhone] iPhone disconnected during recording!');
    // Show warning but DON'T stop recording - doctor keeps control
    // Recording continues (with silence), doctor can still stop with F9

    // Show warning overlay
    updateStatusOverlay(
      '⚠️ Smartphone getrennt',
      'Aufnahme läuft weiter. F9 zum Stoppen.',
      'warning'
    );

    // Notify dashboard
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('iphone-connection-status', { connected: false });
    }
  }

  // Handle IPHONE_NEEDS_ACTIVATION - phone mic was released (backgrounded), needs user tap
  if (msg.type === 'IPHONE_NEEDS_ACTIVATION') {
    console.warn('[iPhone] Phone needs reactivation - mic was released');

    // Show warning overlay
    updateStatusOverlay(
      '⚠️ Smartphone reaktivieren',
      'Tippen Sie auf dem Handy auf "Aktivieren"',
      'warning'
    );

    // Notify dashboard
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('iphone-connection-status', { connected: false, needsActivation: true });
    }
  }

  // Handle PONG from relay (heartbeat response) - just log
  if (msg.type === 'PONG') {
    // Heartbeat response - connection is alive
  }
}

/**
 * Reconnect to relay server during an active recording
 * Called when desktop WebSocket dies but recording is still active
 */
function reconnectToRelay(deviceId, token, relayUrl, timeout, resolve) {
  if (!isIphoneSession || !isRecording) {
    console.log('[iPhone] Recording ended, skipping reconnect');
    return;
  }

  const wsUrl = `${relayUrl}/stream?device=${deviceId}&role=desktop&token=${token}`;
  console.log('[iPhone] Reconnecting to relay:', wsUrl);

  try {
    iphoneRelayWs = new WebSocket(wsUrl);

    iphoneRelayWs.on('open', () => {
      console.log('[iPhone] Reconnected to relay, waiting for iPhone...');

      // Show QR code for reconnection
      updateStatusOverlay(
        'Smartphone getrennt',
        'QR-Code scannen oder Browser öffnen',
        'waiting-iphone',
        { micUrl: 'https://dentdoc.de/mic' }
      );

      // Restart heartbeat
      if (iphoneHeartbeatInterval) {
        clearInterval(iphoneHeartbeatInterval);
      }
      iphoneHeartbeatInterval = setInterval(() => {
        if (iphoneRelayWs && iphoneRelayWs.readyState === WebSocket.OPEN) {
          iphoneRelayWs.send(JSON.stringify({ type: 'PING' }));
        }
      }, 5000);
    });

    iphoneRelayWs.on('message', (data) => {
      if (Buffer.isBuffer(data) && data.length > 0) {
        if (data[0] === 0x7b) { // '{'
          try {
            const msg = JSON.parse(data.toString());
            handleIphoneControlMessage(msg, timeout, resolve);
            return;
          } catch (e) {}
        }

        // Binary audio data
        if (isIphoneSession && iphoneFfmpegProcess && iphoneFfmpegProcess.stdin && !iphoneFfmpegProcess.stdin.destroyed) {
          try {
            iphoneFfmpegProcess.stdin.write(data);

            // Audio level for UI
            const now = Date.now();
            if (!global.lastAudioLevelUpdate || now - global.lastAudioLevelUpdate > 100) {
              global.lastAudioLevelUpdate = now;
              const alignedLength = data.length & ~1;
              if (alignedLength >= 2) {
                const aligned = Buffer.from(data.buffer, data.byteOffset, alignedLength);
                const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, alignedLength / 2);
                let sum = 0;
                for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
                const rawRms = Math.sqrt(sum / int16.length) / 32768;
                const rms = Math.min(1, rawRms * 40);
                if (statusOverlay && !statusOverlay.isDestroyed()) {
                  statusOverlay.webContents.send('iphone-audio-level', rms);
                }
              }
            }
          } catch (e) {
            // Ignore write errors during shutdown
            console.warn('[iPhone] Reconnect write error:', e.message);
          }
        }
      } else if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          handleIphoneControlMessage(msg, timeout, resolve);
        } catch (e) {
          console.warn('[iPhone] Reconnect invalid message:', data?.substring?.(0, 100));
        }
      }
    });

    iphoneRelayWs.on('error', (err) => {
      console.error('[iPhone] Reconnect error:', err.message);
    });

    iphoneRelayWs.on('close', (code, reason) => {
      console.log('[iPhone] Reconnected WebSocket closed:', code, reason?.toString());
      if (isIphoneSession && isRecording) {
        console.log('[iPhone] Still recording, will reconnect again...');
        setTimeout(() => {
          reconnectToRelay(deviceId, token, relayUrl, timeout, resolve);
        }, 2000);
      }
    });

  } catch (error) {
    console.error('[iPhone] Reconnect failed:', error);
    setTimeout(() => {
      reconnectToRelay(deviceId, token, relayUrl, timeout, resolve);
    }, 2000);
  }
}

async function stopRecordingWithIphone() {
  console.log('[iPhone] ========== Stop Recording (iPhone Mode) ==========');

  // IMPORTANT: Set isIphoneSession to false FIRST to stop accepting new audio data
  isIphoneSession = false;

  try {
    tray.setToolTip('DentDoc - Stoppe Smartphone-Aufnahme...');

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
    recordingSlotPending = false;
    trayModule.updateTrayMenu();

    // Release recording slot (license enforcement)
    releaseCurrentRecordingSlot();

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
      try {
        if (iphoneRelayWs.readyState === 1) {
          iphoneRelayWs.send(JSON.stringify({ type: 'STOP' }));
        }
      } catch (e) {
        debugLog(`[iPhone] WebSocket send STOP failed during stop cleanup: ${e.message}`);
      }
      iphoneRelayWs.close();
      iphoneRelayWs = null;
    }

    isIphoneSession = false;
    isRecording = false;
    recordingSlotPending = false;
    trayModule.updateTrayMenu();

    // Release recording slot on error
    releaseCurrentRecordingSlot();

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
    const microphoneName = store.get('microphoneName') || null;
    const deleteAudio = store.get('deleteAudio', true);
    console.log('[VAD] microphoneName:', microphoneName);

    // Check if selected microphone is available BEFORE starting
    if (microphoneName) {
      const availableDevices = await audioRecorder.listAudioDevices();
      const selectedMicAvailable = isMicrophoneAvailable(microphoneName, availableDevices);

      console.log('[VAD] Mic check - selected:', microphoneName);
      console.log('[VAD] Mic check - available:', availableDevices.map(d => d.name));
      console.log('[VAD] Mic check - found:', selectedMicAvailable);

      if (!selectedMicAvailable) {
        updateStatusOverlay('Mikrofon nicht verbunden', microphoneName, 'error');
        return;
      }
    }

    // Check if user cancelled during startup (e.g., during mic check)
    if (recordingStartCancelled) {
      console.log('[VAD] Cancelled during startup');
      return;
    }

    // Start recording first - only update UI state if successful
    currentRecordingPath = await audioRecorder.startRecording(deleteAudio, microphoneName);
    console.log('[VAD] Recording started:', currentRecordingPath);

    // Start live VAD marker collection (runs during recording, collects speech timestamps)
    vadController.startMarkerCollection({
      fullRecordingPath: currentRecordingPath
    });

    // Recording started successfully - now update UI
    isRecording = true;
    isVadSession = true;
    isPaused = false;
    pausedTime = 0;
    pauseStartTime = null;
    trayModule.updateTrayMenu();

    const recordingIconPath = path.join(__dirname, 'assets', 'tray-icon-recording.png');
    tray.setImage(recordingIconPath);
    tray.setToolTip('DentDoc - 🔴 Aufnahme läuft (VAD)...');

    const shortcut = store.get('shortcut') || 'F9';
    updateStatusOverlay('🎤 Aufnahme läuft', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');

    // Notify dashboard to start VAD audio capture (vadMode triggers startVADIntegration)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-started', {
        microphoneId: store.get('microphoneId'),
        vadMode: true
      });
    }

    console.log('[VAD] ========== Recording Started (Live VAD) ==========');

  } catch (error) {
    console.error('[VAD] Start error:', error.message || error);

    // Force stop to ensure mic is released if FFmpeg partially started
    try {
      await audioRecorder.forceStop();
    } catch (e) {
      // Ignore - just ensuring cleanup
    }

    // Clean up live VAD marker collection
    vadController.stopMarkerCollection(null);

    // Reset states on start failure
    isRecording = false;
    isVadSession = false;
    trayModule.updateTrayMenu();
    autoUploadDebugLogs('startRecordingWithVAD-error');
    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht gestartet werden', 'error');
  }
}

async function stopRecordingWithVAD() {
  // VAD-Modus: Aufnahme stoppen, dann Offline-VAD analysieren (wie File Upload)
  const stopStartTime = Date.now();
  console.log('[TIMING] ========== stopRecordingWithVAD START ==========');

  try {
    tray.setToolTip('DentDoc - Stoppe Aufnahme...');

    // Immediate visual feedback so user knows F9 was registered
    updateStatusOverlay('Aufnahme wird gestoppt', 'Segmente zusammenfügen...', 'processing');

    // Notify dashboard to stop audio monitoring
    console.log('[VAD] Sending recording-stopped to dashboard');
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recording-stopped');
    }

    // Check FFmpeg state before trying to stop
    const recorderState = audioRecorder.getState();
    console.log('[VAD] Recorder state before stop:', recorderState);

    if (recorderState === 'recording' || recorderState === 'paused') {
      // Stop FFmpeg recording (handles both recording and paused states)
      // When paused, this will concatenate segments
      const ffmpegStopStart = Date.now();
      const finalPath = await audioRecorder.stopRecording();
      console.log(`[TIMING] FFmpeg stop completed in ${((Date.now() - ffmpegStopStart) / 1000).toFixed(2)}s - path: ${finalPath}`);
      // Update path in case segments were concatenated
      if (finalPath && finalPath !== currentRecordingPath) {
        console.log('[VAD] Using concatenated file:', finalPath);
        currentRecordingPath = finalPath;
      }
    } else if (currentRecordingPath && fs.existsSync(currentRecordingPath)) {
      console.warn('[VAD] Recorder not in recording/paused state - using existing file');
      console.log('[VAD] Found existing recording file:', currentRecordingPath);
    } else {
      throw new Error(`Keine aktive Aufnahme (Recorder-Status: ${recorderState})`);
    }

    // IMMEDIATELY transition to processing state (before downsampling)
    // This prevents double F9 press issues during long downsampling
    isRecording = false;
    recordingSlotPending = false;
    isVadSession = false;
    isProcessing = true;
    isPaused = false;  // Reset pause state
    pausedTime = 0;
    pauseStartTime = null;
    pauseToggleInProgress = false;  // Reset lock
    trayModule.updateTrayMenu();

    // Release recording slot (license enforcement)
    releaseCurrentRecordingSlot();

    // Safety timeout: auto-reset isProcessing after 10 minutes in case of unexpected hang
    // (Long recordings 50+ min can take 6+ minutes to process: VAD + Upload + Transcription + Documentation)
    processingTimeoutId = setTimeout(() => {
      if (isProcessing) {
        console.error('[SAFETY] Processing timeout after 10 minutes - auto-resetting state');
        isProcessing = false;
        trayModule.updateTrayMenu();
        tray.setToolTip('DentDoc - Bereit');
        autoUploadDebugLogs('processing-timeout');
      }
    }, 10 * 60 * 1000);

    // Reset tray icon and show processing status
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Verarbeitung läuft...');
    // Recording is now 16kHz directly - no downsample needed

    updateStatusOverlay('Verarbeitung läuft', 'Wird verarbeitet...', 'processing');

    // Get live VAD markers (collected during recording via sample-based timeline)
    const liveSegments = vadController.stopMarkerCollection(currentRecordingPath);
    console.log(`[TIMING] Live VAD: ${liveSegments.length} segments`);

    // Process: render speech-only from live markers, then upload + transcribe
    // source='mic' for RMS-based Auto-Level strategy
    console.log('[Recording] >>> Processing with source: mic');
    const token = store.get('authToken');
    await processFileWithVAD(currentRecordingPath, token, {
      source: 'mic',
      skipVAD: true,
      liveSegments: liveSegments
    });

    // Clear safety timeout on successful completion
    if (processingTimeoutId) {
      clearTimeout(processingTimeoutId);
      processingTimeoutId = null;
    }

  } catch (error) {
    // Clear safety timeout on error
    if (processingTimeoutId) {
      clearTimeout(processingTimeoutId);
      processingTimeoutId = null;
    }

    console.error('[VAD] Stop error:', error.message || error);
    debugLog(`[VAD] Stop error details: ${error.message}, stack: ${error.stack}`);
    autoUploadDebugLogs('stopRecordingWithVAD-error');

    // Reset ALL state on error
    isRecording = false;
    recordingSlotPending = false;
    isVadSession = false;
    isProcessing = false;
    trayModule.updateTrayMenu();

    // Release recording slot on error
    releaseCurrentRecordingSlot();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht verarbeitet werden', 'error');
  }
}

async function stopRecording() {
  const stopStartTime = Date.now();
  console.log('[TIMING] ========== stopRecording START ==========');

  // Block if already stopping or processing (prevents double F9 press during long concatenation)
  if (stopInProgress || isProcessing) {
    console.log('[Recording] Stop already in progress or processing, ignoring stop request');
    return;
  }
  stopInProgress = true;

  try {

  // Check if we're in iPhone mode
  if (isIphoneSession) {
    console.log('[Recording] iPhone mode active - stopping iPhone session');
    console.log('[Recording] >>> Processing with source: iphone (will use loudnorm always)');
    try {
      const recordingPath = await stopRecordingWithIphone();
      // Process the recorded audio - source='iphone' for correct Auto-Level (always loudnorm)
      await processAudioFile(recordingPath, { source: 'iphone' });
    } catch (error) {
      console.error('[iPhone] Stop error:', error);
      autoUploadDebugLogs('stopRecordingWithIphone-error');
      updateStatusOverlay('Smartphone Fehler', error.message, 'error');
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

    const ffmpegStopStart = Date.now();
    await audioRecorder.stopRecording();
    console.log(`[TIMING] FFmpeg stop completed in ${((Date.now() - ffmpegStopStart) / 1000).toFixed(2)}s`);

    // Recording is now 16kHz directly - no downsample needed

    isRecording = false;
    recordingSlotPending = false;
    isPaused = false;
    pausedTime = 0;
    pauseStartTime = null;
    trayModule.updateTrayMenu();

    // Release recording slot (license enforcement)
    releaseCurrentRecordingSlot();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);

    // Process the recorded audio file (same as manual file upload)
    await processAudioFile(currentRecordingPath);

  } catch (error) {
    console.error('Stop recording error:', error);
    autoUploadDebugLogs('stopRecording-error');

    // Reset state on error
    isRecording = false;
    recordingSlotPending = false;
    isProcessing = false;
    isPaused = false;
    pausedTime = 0;
    pauseStartTime = null;
    pauseToggleInProgress = false;
    trayModule.updateTrayMenu();

    // Release recording slot on error
    releaseCurrentRecordingSlot();

    // Reset tray icon
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

    updateStatusOverlay('Fehler', error.message || 'Aufnahme konnte nicht gestoppt werden', 'error');
  }

  } finally {
    stopInProgress = false;
  }
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

// Deterministic overlay size based on state (main process controls size, not renderer)
function getOverlaySizeForState(type, extra = {}) {
  switch (type) {
    case 'recording':
    case 'starting':  // Same size as recording
    case 'paused':    // Same size as recording
      return { width: 402, height: 96 };

    case 'processing':
      return { width: 402, height: 170 };

    case 'waiting-iphone':
      // Larger to accommodate QR code
      return { width: 402, height: 295 };

    case 'success':
      // Calculate height based on which sections are visible
      const hasBefund = extra.status01 || extra.statusPA;

      // Base height: 300 (header + 2 main buttons)
      // + 85 for befund section
      let successHeight = 300;
      if (hasBefund) successHeight += 85;

      return { width: 402, height: successHeight };

    case 'error':
      return { width: 402, height: 200 };

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

  // Set initial size estimate, then auto-correct from actual content
  const { width, height } = getOverlaySizeForState(type, extra);
  overlay.setSize(width, height, false);

  // Auto-resize: query actual content size from renderer after DOM update
  const autoResizeOverlay = () => {
    if (!overlay || overlay.isDestroyed() || !overlay.webContents || overlay.webContents.isDestroyed()) return;
    overlay.webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('.container');
        if (!el) return JSON.stringify(null);
        return JSON.stringify({ w: Math.ceil(el.offsetWidth) + 4, h: Math.ceil(el.offsetHeight) + 4 });
      })()
    `).then(result => {
      const size = JSON.parse(result);
      if (!size || overlay.isDestroyed()) return;
      const [curX, curY] = overlay.getPosition();
      overlay.setBounds({ x: curX, y: curY, width: size.w, height: size.h });
    }).catch(() => {});
  };
  // Run after DOM has updated (100ms + 400ms for safety)
  setTimeout(autoResizeOverlay, 150);
  setTimeout(autoResizeOverlay, 500);

  const statusData = {
    title,
    message,
    type,
    step: extra.step != null ? extra.step : null,
    uploadProgress: extra.uploadProgress,
    progressPercent: extra.progressPercent || null,
    documentation: extra.documentation || null,
    zDocumentation: extra.zDocumentation || null,
    transcript: extra.transcript || null,
    micUrl: extra.micUrl || null,
    reconstructedTranscript: extra.reconstructedTranscript || null,
    transcriptWithSpeakers: extra.transcriptWithSpeakers || null,
    recognizedSpeakers: extra.recognizedSpeakers || [],
    // Agent V2.1: Befund-Daten
    detection: extra.detection || null,
    status01: extra.status01 || null,
    statusPA: extra.statusPA || null
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
    'Tipp: Zuletzt gewählte Option wird beim nächsten Mal automatisch kopiert',
    '',
    'success',
    {
      documentation: lastDocumentation,
      zDocumentation: lastZDocumentation,
      transcript: lastTranscript,
      reconstructedTranscript: lastReconstructedTranscript,
      transcriptWithSpeakers: lastTranscriptWithSpeakers,
      recognizedSpeakers: lastRecognizedSpeakers,
      detection: lastDetection,
      status01: lastStatus01,
      statusPA: lastStatusPA
    }
  );
}

// IPC handler for closing status overlay
ipcMain.on('close-status-overlay', () => {
  hideStatusOverlay();
});

// IPC handler for dynamic overlay resize (renderer measures content, main resizes window)
ipcMain.on('overlay:resize', (event, { width, height }) => {
  if (!statusOverlay || statusOverlay.isDestroyed()) return;

  // Get current position to maintain it during resize
  const [currentX, currentY] = statusOverlay.getPosition();

  statusOverlay.setBounds({
    x: currentX,
    y: currentY,
    width: Math.max(100, width),
    height: Math.max(50, height)
  });

  // Validate position after resize to ensure window stays on screen
  setTimeout(validateOverlayPosition, 50);
});

// IPC handler for click-through toggle (transparent areas become clickable-through)
ipcMain.on('overlay:set-ignore-mouse', (event, ignore) => {
  if (!statusOverlay || statusOverlay.isDestroyed()) return;

  // setIgnoreMouseEvents with forward: true allows click-through
  // but still receives mouse events for hit-testing
  statusOverlay.setIgnoreMouseEvents(ignore, { forward: true });
});

// IPC handler for playing Windows error sound
ipcMain.on('play-error-sound', () => {
  const { shell } = require('electron');
  // Play Windows system error sound
  shell.beep();
});

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

// IPC handler for opening tooth chart modal from status overlay
ipcMain.on('open-tooth-chart', (event, data) => {
  console.log('[Tooth Chart] Opening tooth chart with data:', !!data?.status01);

  // Open dashboard if not already open
  openLocalDashboard();

  // Wait for dashboard to be ready, then send the event
  const sendToothChartEvent = () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      console.log('[Tooth Chart] Sending open-tooth-chart to dashboard');
      dashboardWindow.webContents.send('open-tooth-chart', data);
      dashboardWindow.focus();
    } else {
      console.log('[Tooth Chart] Dashboard not ready, retrying...');
      setTimeout(sendToothChartEvent, 200);
    }
  };

  // Give dashboard time to load if it was just opened
  setTimeout(sendToothChartEvent, 500);
});

// Cancel an active recording, clean up all state and resources
// Used by both the IPC cancel-recording handler and the recording slot rejection
async function cancelCurrentRecording() {
  if (!isRecording) return;

  console.log('[Cancel] Cancelling active recording...');

  // Notify dashboard to stop audio monitoring
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('recording-stopped');
  }

  try {
    // Stop the audio recorder - use forceStop to ensure FFmpeg is fully killed
    await audioRecorder.forceStop();
  } catch (error) {
    console.log('Error stopping recorder:', error);
  }

  // Clean up iPhone connection if active
  if (isIphoneSession) {
    if (iphoneHeartbeatInterval) {
      clearInterval(iphoneHeartbeatInterval);
      iphoneHeartbeatInterval = null;
    }
    if (iphoneRelayWs) {
      try {
        // Send STOP to iPhone BEFORE closing connection
        if (iphoneRelayWs.readyState === 1) { // WebSocket.OPEN
          console.log('[iPhone] Sending STOP before cancel');
          iphoneRelayWs.send(JSON.stringify({ type: 'STOP' }));
        }
        iphoneRelayWs.close();
      } catch (e) {
        debugLog(`[iPhone] WebSocket cleanup error during cancel: ${e.message}`);
      }
      iphoneRelayWs = null;
    }
    if (iphoneFfmpegProcess) {
      try {
        iphoneFfmpegProcess.stdin.end();
        iphoneFfmpegProcess.kill();
      } catch (e) {
        debugLog(`[iPhone] FFmpeg cleanup error during cancel: ${e.message}`);
      }
      iphoneFfmpegProcess = null;
    }
    isIphoneSession = false;
    iphoneRecordingPath = null;
    console.log('[iPhone] Recording cancelled');
  }

  // Delete temp recording file (not needed when cancelled)
  if (currentRecordingPath && fs.existsSync(currentRecordingPath)) {
    try {
      fs.unlinkSync(currentRecordingPath);
      console.log('[Cancel] Deleted temp file:', currentRecordingPath);
    } catch (e) {
      console.warn('[Cancel] Could not delete temp file:', e.message);
    }
  }

  // Release recording slot if active
  releaseCurrentRecordingSlot();

  isRecording = false;
  recordingSlotPending = false;
  isVadSession = false;
  isProcessing = false;
  isPaused = false;
  pausedTime = 0;
  pauseStartTime = null;
  pauseToggleInProgress = false;
  currentRecordingPath = null;

  // Reset tray icon
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray.setImage(iconPath);
  tray.setToolTip('DentDoc - Bereit');
  trayModule.updateTrayMenu();

  console.log('[Cancel] Recording cancelled');
}

// IPC handler for cancelling recording (X button during recording or waiting-iphone)
ipcMain.on('cancel-recording', async () => {
  console.log('[Cancel] Cancel requested - isRecording:', isRecording, 'isProcessing:', isProcessing);

  // Always hide the overlay first
  hideStatusOverlay();

  // Cancel during processing (after recording stopped, VAD/upload/transcription running)
  if (!isRecording && isProcessing) {
    console.log('[Cancel] Cancelling active processing...');

    // Cancel VAD Worker (if still active)
    try {
      const pipeline = require('./src/pipeline');
      pipeline.cancelVAD();
    } catch (e) {
      console.warn('[Cancel] cancelVAD error:', e.message);
    }

    // Reset state
    isProcessing = false;
    if (processingTimeoutId) {
      clearTimeout(processingTimeoutId);
      processingTimeoutId = null;
    }
    trayModule.updateTrayMenu();

    // Reset tray
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    tray.setImage(iconPath);
    tray.setToolTip('DentDoc - Bereit');

    console.log('[Cancel] Processing cancelled by user');
    return;
  }

  // Set flag to abort startup if recording hasn't started yet
  if (!isRecording) {
    recordingStartCancelled = true;
    recordingSlotPending = false;
    console.log('[Cancel] Recording start cancelled (was in startup phase)');
    return;
  }

  await cancelCurrentRecording();
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

  return {
    todayRecordings: count,
    profileCount
  };
});

// Get all transcripts for dashboard transcript browser
ipcMain.handle('get-all-transcripts', async () => {
  try {
    const defaultTranscriptPath = path.join(app.getPath('documents'), 'DentDoc', 'Transkripte');
    const transcriptPath = store.get('transcriptPath') || defaultTranscriptPath;

    if (!fs.existsSync(transcriptPath)) {
      return { success: true, transcripts: [] };
    }

    const transcripts = [];

    // Recursively find all .json files in transcript folder
    const findJsonFiles = (dir) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          findJsonFiles(fullPath);
        } else if (item.name.endsWith('.json')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const metadata = JSON.parse(content);
            // Add file path for later retrieval
            metadata.filePath = fullPath;
            metadata.folderName = path.basename(path.dirname(fullPath));
            // Check if audio file exists (try multiple extensions)
            // Check both original and speech_only versions
            const basePath = fullPath.replace('.json', '');
            const audioExtensions = ['.wav', '.webm', '.mp3', '.m4a', '.ogg'];
            const hasOriginal = audioExtensions.some(ext => fs.existsSync(basePath + ext));
            const hasSpeechOnly = audioExtensions.some(ext => fs.existsSync(basePath + '_speech_only' + ext));
            metadata.hasAudio = hasOriginal || hasSpeechOnly;
            transcripts.push(metadata);
          } catch (err) {
            console.error(`Failed to parse JSON: ${fullPath}`, err.message);
          }
        }
      }
    };

    findJsonFiles(transcriptPath);

    // Sort by date, newest first
    transcripts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return { success: true, transcripts };
  } catch (error) {
    console.error('get-all-transcripts error:', error);
    autoUploadDebugLogs('get-transcripts-error');
    return { success: false, error: error.message, transcripts: [] };
  }
});

// Get single transcript detail with audio path
ipcMain.handle('get-transcript-detail', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Datei nicht gefunden' };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const metadata = JSON.parse(content);

    // Get audio file path - try multiple extensions
    const basePath = filePath.replace('.json', '');
    const audioExtensions = ['.wav', '.webm', '.mp3', '.m4a', '.ogg'];
    let audioPath = null;

    for (const ext of audioExtensions) {
      const testPath = basePath + ext;
      if (fs.existsSync(testPath)) {
        audioPath = testPath;
        break;
      }
    }
    metadata.audioPath = audioPath;

    // Also check for speech_only audio
    let speechOnlyPath = null;
    for (const ext of audioExtensions) {
      const testPath = basePath + '_speech_only' + ext;
      if (fs.existsSync(testPath)) {
        speechOnlyPath = testPath;
        break;
      }
    }
    metadata.speechOnlyPath = speechOnlyPath;

    console.log('[get-transcript-detail] Audio paths:', { audioPath, speechOnlyPath });

    return { success: true, transcript: metadata };
  } catch (error) {
    console.error('get-transcript-detail error:', error);
    autoUploadDebugLogs('get-transcript-detail-error');
    return { success: false, error: error.message };
  }
});

// Get audio file as base64 for playback in renderer
// DSGVO: get-transcript-audio IPC handler removed — audio is no longer persisted, so there's nothing to play back.

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

// Get support context for tawk.to (settings, stats, last error)
ipcMain.handle('get-support-context', () => {
  const todayRecordings = store.get('todayRecordings', { date: null, count: 0 });
  const today = new Date().toISOString().split('T')[0];

  return {
    // Settings
    shortcut: store.get('shortcut', 'F9'),
    theme: store.get('theme', 'dark'),
    vadEnabled: store.get('vadEnabled', true),
    microphoneName: store.get('microphoneName', 'Default'),
    microphoneSource: store.get('microphoneSource', 'desktop'),
    // Stats
    todayRecordings: todayRecordings.date === today ? todayRecordings.count : 0,
    lastDocumentation: store.get('lastDocumentationTime', null),
    // Last error (truncated, no sensitive data)
    lastError: lastErrorMessage,
    lastErrorTime: lastErrorTime
  };
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

  if (hasActiveSubscription && user?.cancelAtPeriodEnd) {
    const endDate = user?.currentPeriodEnd
      ? new Date(user.currentPeriodEnd).toLocaleDateString('de-DE')
      : '';
    label = `Abo endet am ${endDate}`;
    type = 'warning';
  } else if (hasActiveSubscription) {
    label = `DentDoc Pro (${user?.maxDevices || 1} Lizenz${(user?.maxDevices || 1) !== 1 ? 'en' : ''})`;
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

// Get active recording count for sidebar badge
ipcMain.handle('get-active-recordings', async () => {
  const token = store.get('authToken');
  if (!token) return { activeRecordings: 0, maxRecordings: 0 };

  try {
    const axios = require('axios');
    const API_BASE_URL = apiClient.getBaseUrl();
    const response = await axios.get(`${API_BASE_URL}api/recording/active`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 5000,
    });
    return response.data;
  } catch (error) {
    console.warn('[ActiveRecordings] Fetch failed:', error.message);
    return { activeRecordings: 0, maxRecordings: 0 };
  }
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
    debugLog(`[Subscription] API fetch failed: ${error.message}`);
    autoUploadDebugLogs('subscription-data-error');
    // Fall back to user data
    activeDevices = 1; // At least this device
  }

  // Determine plan name (include device count for active subscriptions)
  let planName = 'Kein aktives Abonnement';
  if (hasActiveSubscription) {
    const basePlanName = user?.planName || 'DentDoc Pro';
    const deviceCount = maxDevices || user?.maxDevices || 1;
    planName = `${basePlanName} (${deviceCount} Lizenz${deviceCount !== 1 ? 'en' : ''})`;
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

// Get website URL for user-facing links (www.dentdoc.de)
ipcMain.handle('get-website-url', () => {
  return apiClient.getWebsiteUrl();
});

// Open external URL
ipcMain.handle('open-external-url', (event, url) => {
  shell.openExternal(url);
  return true;
});

// Show notification from renderer
ipcMain.handle('show-notification', (event, title, body) => {
  showNotification(title, body);
});

// Get current shortcut for dashboard display
ipcMain.handle('get-shortcut', () => {
  return store.get('shortcut', 'F9');
});

// Recording control from dashboard
ipcMain.handle('toggle-recording', async () => {
  if (isRecording) {
    await stopRecording();
    return { recording: false, processing: isProcessing };
  } else if (isProcessing) {
    showNotification('Bitte warten', 'Die vorherige Aufnahme wird noch verarbeitet...');
    return { recording: false, processing: true, blocked: true };
  } else if (startInProgress) {
    return { recording: false, processing: false, blocked: true };
  } else {
    startInProgress = true;
    try {
      await startRecording();
    } finally {
      startInProgress = false;
    }
    return { recording: isRecording, processing: false };
  }
});

ipcMain.handle('get-recording-state', () => {
  return { isRecording, isProcessing };
});

// Pause/Resume recording - stops/restarts FFmpeg to avoid recording private conversations
ipcMain.handle('toggle-pause', async () => {
  if (!isRecording) return { success: false };

  // Prevent concurrent toggles (spam clicks)
  if (pauseToggleInProgress) {
    console.log('[Pause] Toggle already in progress, ignoring');
    return { success: false, reason: 'in_progress' };
  }
  pauseToggleInProgress = true;

  const shortcut = store.get('shortcut') || 'F9';

  try {
    if (isPaused) {
      // Resume - show "starting" state immediately for instant feedback
      updateStatusOverlay('Fortsetzen...', 'Einen Moment...', 'starting');

      try {
        await audioRecorder.resumeRecording();
        console.log('[Pause] Resumed - now recording segment', audioRecorder.getSegmentsCount() + 1);
      } catch (err) {
        console.error('[Pause] Failed to resume recording:', err.message);
        autoUploadDebugLogs('toggle-pause-error');
        updateStatusOverlay('Fehler beim Fortsetzen', err.message, 'error');
        return { success: false, error: err.message };
      }
      vadController.resumeMarkerCollection();
      pausedTime += (Date.now() - pauseStartTime);
      isPaused = false;
      pauseStartTime = null;
      updateStatusOverlay('Aufnahme läuft...', `Drücken Sie ${shortcut} zum Stoppen`, 'recording');
      console.log('[Pause] Total paused time:', pausedTime, 'ms');
    } else {
      // Pause - show "Pausing..." state first, then await FFmpeg stop
      updateStatusOverlay('Pausiere...', 'Einen Moment...', 'starting');

      // Wait for FFmpeg to actually stop
      try {
        await audioRecorder.pauseRecording();
        console.log('[Pause] Recording paused - total segments:', audioRecorder.getSegmentsCount());
      } catch (err) {
        console.error('[Pause] Failed to pause recording:', err.message);
        autoUploadDebugLogs('toggle-pause-error');
      }

      vadController.pauseMarkerCollection();

      // Now show paused state
      isPaused = true;
      pauseStartTime = Date.now();
      updateStatusOverlay('Pausiert', 'Klicken zum Fortsetzen', 'paused');
    }
    return { success: true, isPaused };
  } finally {
    pauseToggleInProgress = false;
  }
});

ipcMain.handle('get-pause-state', () => ({ isPaused, pausedTime }));

// Onboarding tour handlers (supports multiple tours: 'login', 'settings', etc.)
ipcMain.handle('check-first-run', (event, tourId = 'general') => {
  const tourKey = `tourCompleted_${tourId}`;
  const tourCompleted = store.get(tourKey, false);

  // Also check for incomplete setup (user closed without microphone)
  if (tourId === 'setup-wizard') {
    const setupIncomplete = store.get('setupIncomplete', false);
    if (setupIncomplete) {
      return true; // Show wizard again if setup was incomplete
    }
  }

  return !tourCompleted;
});

ipcMain.handle('mark-tour-completed', (event, tourId = 'general') => {
  const tourKey = `tourCompleted_${tourId}`;
  store.set(tourKey, true);

  // Clear incomplete flag when wizard is completed
  if (tourId === 'setup-wizard') {
    store.delete('setupIncomplete');
    store.delete('setupIncompleteReason');
  }

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

// Onboarding tutorial card handlers
// Shows the tutorial to teach users how DentDoc works (tray, F9, clipboard)
ipcMain.handle('check-onboarding-visible', () => {
  // Show unless user has permanently dismissed it with checkbox
  const dismissed = store.get('onboardingDismissed', false);
  return !dismissed;
});

ipcMain.handle('dismiss-onboarding-permanently', () => {
  store.set('onboardingDismissed', true);
  return true;
});

ipcMain.handle('reset-onboarding', () => {
  store.delete('onboardingDismissed');
  return true;
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
  copyToClipboardWithFormatting(text);
  return true;
});

// Last clicked documentation preference (for auto-copy on success)
ipcMain.handle('get-last-clicked-doc', () => {
  return store.get('lastClickedDoc', null);
});

ipcMain.handle('set-last-clicked-doc', (event, docType) => {
  store.set('lastClickedDoc', docType);
  return true;
});

// Log from renderer processes (for debugging)
ipcMain.on('log-from-renderer', (event, ...args) => {
  console.log(...args);
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
    autoUploadDebugLogs('submit-feedback-error');
    return { success: false, error: error.message };
  }
});

// Window control handlers
ipcMain.on('minimize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.on('maximize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
});

ipcMain.on('close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});

// Minimize dashboard to tray (hide instead of minimize)
ipcMain.on('minimize-to-tray', () => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.hide();

    // Show balloon notification the first time user minimizes to tray
    if (!store.get('hasSeenTrayHint') && tray) {
      store.set('hasSeenTrayHint', true);
      tray.displayBalloon({
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        title: 'DentDoc läuft im Hintergrund',
        content: 'Zum Öffnen auf das DentDoc-Symbol in der Taskleiste klicken (evtl. im ^-Menü versteckt).',
        noSound: true
      });
    }
  }
});

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
    trayModule.updateTrayMenu();

    // Initialize voice profiles from backend DB
    const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
    await voiceProfiles.init(apiClient, () => store.get('authToken'));

    // Start heartbeat
    session.startHeartbeat();

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

    if (user?.paymentFailedAt && hasActiveSubscription) {
      // Payment failed but subscription still active (Stripe is retrying)
      showCustomNotification(
        'Zahlung fehlgeschlagen',
        'Ihre letzte Zahlung konnte nicht verarbeitet werden. Bitte Zahlungsmethode prüfen.',
        'error',
        () => openWebDashboard('/subscription')
      );
    } else if (user?.cancelAtPeriodEnd && hasActiveSubscription) {
      // Subscription pending cancellation - still active until period end
      const endDate = user?.currentPeriodEnd
        ? new Date(user.currentPeriodEnd).toLocaleDateString('de-DE')
        : '';
      showCustomNotification(
        'Abo gekündigt',
        `Ihr Abonnement läuft noch bis ${endDate}. Klicken Sie hier zum Reaktivieren.`,
        'warning',
        () => openWebDashboard('/subscription')
      );
    } else if (wasSubscriber && !hasActiveSubscription) {
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
    } else if (isTrialUser && !wasSubscriber && minutesRemaining > 10) {
      // Demo/Trial user with plenty of minutes
      showCustomNotification(
        'Demo-Modus',
        `Willkommen! Sie haben noch ${minutesRemaining} Testminuten.`,
        'info'
      );
    } else if (hasActiveSubscription) {
      // Pro user
      showCustomNotification('Angemeldet', `Willkommen! DentDoc Pro (${user?.maxDevices || 1} Lizenz${(user?.maxDevices || 1) !== 1 ? 'en' : ''})`, 'success');
    } else {
      // Normal welcome
      showCustomNotification('Angemeldet', `Willkommen ${response.user.email}!`, 'success');
    }

    return { success: true };
  } catch (error) {
    console.error('[Login] IPC error:', error.message);
    autoUploadDebugLogs('login-error');
    return { success: false, error: error.message };
  }
});

// IPC Handler for logout
ipcMain.handle('logout', async () => {
  const token = store.get('authToken');
  // Release recording slot before token is deleted
  releaseCurrentRecordingSlot();
  // Stop heartbeat
  session.stopHeartbeat();
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
    autoUploadDebugLogs('get-audio-devices-error');
    return [];
  }
});

ipcMain.handle('get-settings', async () => {
  // Default paths in Documents folder
  const documentsPath = app.getPath('documents');
  const defaultTranscriptPath = path.join(documentsPath, 'DentDoc', 'Transkripte');

  // Get stored paths - use null coalescing to preserve empty strings if intentionally set
  const storedTranscriptPath = store.get('transcriptPath');

  console.log('get-settings - stored transcriptPath:', storedTranscriptPath);

  return {
    shortcut: store.get('shortcut') || 'F9',
    microphoneId: store.get('microphoneId') || null,      // Browser device ID (WebRTC)
    microphoneName: store.get('microphoneName') || null,  // Device name (for FFmpeg)
    microphoneSource: store.get('microphoneSource', 'desktop'),  // 'desktop' | 'iphone'
    iphoneDeviceId: store.get('iphoneDeviceId') || null,
    iphoneDeviceName: store.get('iphoneDeviceName') || null,
    transcriptPath: storedTranscriptPath !== undefined && storedTranscriptPath !== '' ? storedTranscriptPath : defaultTranscriptPath,
    autoClose: store.get('autoCloseOverlay', false),
    autoExport: store.get('autoExport', true),
    theme: store.get('theme', 'dark'),
    vadEnabled: store.get('vadEnabled', true)  // VAD enabled by default
  };
});

ipcMain.handle('save-settings', async (event, settings) => {
  console.log('save-settings called with:', JSON.stringify(settings, null, 2));

  // Save microphone (browser device ID for WebRTC)
  if (settings.microphoneId !== undefined) {
    store.set('microphoneId', settings.microphoneId);
    console.log('Saved microphoneId:', settings.microphoneId);
  }

  // Save microphone name (for FFmpeg - needs device name, not browser ID)
  if (settings.microphoneName !== undefined) {
    store.set('microphoneName', settings.microphoneName);
    console.log('Saved microphoneName:', settings.microphoneName);
  }

  // Save transcript path
  if (settings.transcriptPath !== undefined) {
    console.log('Saving transcriptPath:', settings.transcriptPath);
    store.set('transcriptPath', settings.transcriptPath);
  }

  // Save auto-close setting
  if (settings.autoClose !== undefined) {
    store.set('autoCloseOverlay', settings.autoClose);
  }

  // Save auto-export setting
  if (settings.autoExport !== undefined) {
    store.set('autoExport', settings.autoExport);
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
    autoUploadDebugLogs('iphone-pair-error');
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
    debugLog(`[iPhone] Pair status check failed: ${error.message}`);
    autoUploadDebugLogs('iphone-pair-error');
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
    debugLog(`[iPhone] Get status failed: ${error.message}`);
    autoUploadDebugLogs('iphone-status-error');
    return { paired: false, error: error.message };
  }
});

// Cancel iPhone pairing (used when user navigates away from pairing screen)
ipcMain.handle('iphone-cancel-pair', async () => {
  console.log('[iPhone] Cancelling pairing process...');
  // Nothing to do on backend - the pairing ID will just expire
  return { success: true };
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
    return { connected: false, error: 'Kein Smartphone gekoppelt' };
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
        message: 'Smartphone ist verbunden!'
      };
    } else {
      return {
        connected: false,
        error: 'Nicht mit Relay verbunden. Bitte Browser auf Smartphone öffnen.'
      };
    }
  } catch (err) {
    console.error('[iPhone] Status check error:', err.message);
    debugLog(`[iPhone] Connection test failed: ${err.message}`);
    autoUploadDebugLogs('iphone-connection-error');

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

    let deleted = 0;
    for (const file of files) {
      if (file !== keepPath) {
        try {
          fs.unlinkSync(file);
          deleted++;
        } catch (e) {
          // File might be in use, ignore
        }
      }
    }
    if (deleted > 0) {
      console.log(`[iPhone Test] Cleanup: ${deleted} alte Test-Dateien gelöscht`);
    }
  } catch (e) {
    console.warn('[iPhone Test] Cleanup error:', e.message);
  }
}

// Global reference to current audio test (for cancellation)
let currentAudioTest = null;

// Cancel any running audio test
ipcMain.handle('iphone-audio-test-cancel', async () => {
  if (currentAudioTest && currentAudioTest.cleanup) {
    console.log('[iPhone Test] Cancelling test...');
    currentAudioTest.cleanup();
    currentAudioTest = null;
  }
  return { success: true };
});

// iPhone Audio Test - records 10 seconds of audio and returns stats + file path
ipcMain.handle('iphone-audio-test', async (event) => {
  console.log('[iPhone] ========== Audio Test Start ==========');

  const iphoneDeviceId = store.get('iphoneDeviceId');
  const token = store.get('authToken');

  if (!iphoneDeviceId) {
    return { success: false, error: 'Kein Smartphone gekoppelt' };
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
    let resolved = false;

    const cleanup = () => {
      testStopping = true; // Set flag FIRST to stop any new writes
      currentAudioTest = null;

      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (testTimeout) clearTimeout(testTimeout);

      // Stop test on iPhone
      if (testWs && testWs.readyState === WebSocket.OPEN) {
        try {
          testWs.send(JSON.stringify({ type: 'TEST_STOP' }));
          testWs.close();
        } catch (e) {
          debugLog(`[iPhone Test] WebSocket cleanup error: ${e.message}`);
        }
      }
      testWs = null;

      // Close FFmpeg stdin after a short delay to let remaining writes complete
      setTimeout(() => {
        if (testFfmpeg && testFfmpeg.stdin && !testFfmpeg.stdin.destroyed) {
          testFfmpeg.stdin.end();
        }
      }, 100);
    };

    // Store reference for cancellation
    currentAudioTest = { cleanup };

    // Helper to start the recording timer
    const startRecordingTimer = () => {
      if (testStarted) return;
      testStarted = true;
      clearTimeout(connectionTimeout);
      console.log('[iPhone Test] Recording for 10 seconds...');

      // End test after 10 seconds
      testTimeout = setTimeout(() => {
        if (resolved) return;
        console.log('[iPhone Test] Test complete');
        cleanup();

        // Wait for FFmpeg to finish
        testFfmpeg.on('close', async () => {
          if (resolved) return;
          resolved = true;

          // Calculate RMS
          const rmsLevel = totalSamples > 0 ? Math.sqrt(sumSquares / totalSamples) : 0;
          const rmsDb = rmsLevel > 0 ? 20 * Math.log10(rmsLevel) : -100;
          const peakDb = peakLevel > 0 ? 20 * Math.log10(peakLevel) : -100;

          console.log('[iPhone Test] Results:');
          console.log(`  Packets: ${packetsReceived}`);
          console.log(`  RMS: ${rmsDb.toFixed(1)} dB`);
          console.log(`  Peak: ${peakDb.toFixed(1)} dB`);
          console.log(`  File: ${testWavPath}`);

          // Amplify the test file for better playback (add +12dB gain)
          const amplifiedPath = testWavPath.replace('.wav', '_loud.wav');
          try {
            await new Promise((resolveAmp) => {
              const ampFfmpeg = spawn(ffmpegPath, [
                '-i', testWavPath,
                '-af', 'volume=12dB',  // +12dB boost
                '-y',
                amplifiedPath
              ]);
              ampFfmpeg.on('close', (code) => {
                if (code === 0) {
                  console.log('[iPhone Test] Amplified file created:', amplifiedPath);
                  // Replace original with amplified version
                  fs.unlinkSync(testWavPath);
                  fs.renameSync(amplifiedPath, testWavPath);
                  resolveAmp();
                } else {
                  console.warn('[iPhone Test] Amplification failed, using original');
                  resolveAmp(); // Continue with original file
                }
              });
              ampFfmpeg.on('error', () => resolveAmp());
            });
          } catch (e) {
            console.warn('[iPhone Test] Amplification error:', e.message);
          }

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
    };

    // Connection timeout
    connectionTimeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ success: false, error: 'Smartphone antwortet nicht. Bitte Browser öffnen.' });
    }, 15000);

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
              console.log('[iPhone Test] iPhone connected, sending TEST_START');
              testWs.send(JSON.stringify({ type: 'TEST_START' }));
              // Start timer - don't wait for READY, start when first audio arrives
            }

            if (msg.type === 'TEST_READY' || msg.type === 'IPHONE_READY') {
              startRecordingTimer();
            }

            return;
          } catch (e) {
            // Not JSON, treat as audio
          }
        }

        // Binary PCM audio data - start timer on first audio packet!
        if (Buffer.isBuffer(data) && data.length > 0 && data[0] !== 0x7b && !testStopping) {
          // First audio packet starts the recording timer
          if (!testStarted) {
            startRecordingTimer();
          }

          packetsReceived++;

          // Write to FFmpeg (check testStopping again to avoid race condition)
          if (!testStopping && testFfmpeg.stdin && !testFfmpeg.stdin.destroyed) {
            testFfmpeg.stdin.write(data);
          }

          // Calculate levels for this packet (for live meter)
          // Use SAME formula as real iPhone recording (line 1588-1593)
          const int16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
          let packetSum = 0;
          for (let i = 0; i < int16.length; i++) {
            packetSum += int16[i] * int16[i];
            // Also track cumulative stats
            const sample = Math.abs(int16[i]) / 32768;
            sumSquares += sample * sample;
            totalSamples++;
            if (sample > peakLevel) peakLevel = sample;
          }
          // RMS normalized to 0-1 (same as iphone-audio-level)
          const packetRms = Math.sqrt(packetSum / int16.length) / 32768;

          // Send LIVE level to UI
          const now = Date.now();
          if (!global.lastTestLevelUpdate || now - global.lastTestLevelUpdate > 50) {
            global.lastTestLevelUpdate = now;
            const win = global.dashboardWindow || dashboardWindow;
            if (win && !win.isDestroyed()) {
              win.webContents.send('iphone-test-level', packetRms);
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

// Get audio file data as base64 for internal playback
ipcMain.handle('get-audio-file-data', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Datei nicht gefunden' };
  }

  try {
    const data = fs.readFileSync(filePath);
    return {
      success: true,
      data: data.toString('base64')
    };
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

// Upload debug logs to backend for remote troubleshooting
ipcMain.handle('upload-debug-logs', async () => {
  try {
    const token = store.get('authToken');
    if (!token) {
      return { success: false, error: 'Nicht angemeldet' };
    }

    // Read the debug log file
    let logs = '';
    if (fs.existsSync(DEBUG_LOG)) {
      logs = fs.readFileSync(DEBUG_LOG, 'utf8');
      // Limit to last 500KB to avoid huge uploads
      const maxSize = 500 * 1024;
      if (logs.length > maxSize) {
        logs = logs.slice(-maxSize);
      }
    }

    if (!logs || logs.trim().length === 0) {
      return { success: false, error: 'Debug-Log ist leer' };
    }

    // Get app version
    const appVersion = app.getVersion();

    // Upload to backend
    const result = await apiClient.uploadDebugLogs(token, store, logs, appVersion, 'manual');
    return { success: true, debugLogId: result.debugLogId };
  } catch (error) {
    console.error('Upload debug logs error:', error);
    return { success: false, error: error.message || 'Upload fehlgeschlagen' };
  }
});

ipcMain.handle('get-token', () => {
  return store.get('authToken');
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

// Helper function to get German error message for folder permission errors
function getFolderPermissionErrorMessage(error) {
  const code = error.code || '';
  switch (code) {
    case 'ENOENT':
      return 'Pfad nicht gefunden - Netzwerk verbunden?';
    case 'EACCES':
    case 'EPERM':
      return 'Zugriff verweigert - keine Berechtigung';
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'Netzwerkordner nicht erreichbar - Verbindung prüfen';
    case 'EROFS':
      return 'Ordner ist schreibgeschützt';
    case 'ENOSPC':
      return 'Kein Speicherplatz verfügbar';
    case 'EIO':
      return 'Lese-/Schreibfehler - Verbindung prüfen';
    case 'EBUSY':
      return 'Ordner wird von anderem Programm verwendet';
    case 'ENAMETOOLONG':
      return 'Pfad ist zu lang (max. 260 Zeichen)';
    case 'EINVAL':
      return 'Ungültiger Pfadname';
    default:
      return `Unbekannter Fehler: ${error.message || 'Unbekannt'}`;
  }
}

// Validate folder permissions by actually testing read/write/create operations
ipcMain.handle('validate-folder-permissions', async (event, folderPath) => {
  const testFolderName = '.dentdoc-permission-test';
  const testFileName = 'test.txt';
  const testContent = 'DentDoc permission test ' + Date.now();

  const result = {
    success: false,
    readable: false,
    writable: false,
    canCreateSubfolders: false,
    error: null,
    errorCode: null
  };

  try {
    // Check if path exists
    if (!fs.existsSync(folderPath)) {
      // Try to create the folder
      try {
        fs.mkdirSync(folderPath, { recursive: true });
        console.log('validate-folder-permissions: Created folder:', folderPath);
      } catch (mkdirError) {
        result.error = 'Ordner existiert nicht und kann nicht erstellt werden';
        result.errorCode = 'CANNOT_CREATE_FOLDER';
        console.log('validate-folder-permissions: Cannot create folder:', mkdirError.message);
        return result;
      }
    }

    // Check read permission by listing directory
    try {
      fs.readdirSync(folderPath);
      result.readable = true;
      console.log('validate-folder-permissions: Read permission OK');
    } catch (readError) {
      result.error = 'Keine Leseberechtigung für diesen Ordner';
      result.errorCode = 'NO_READ_PERMISSION';
      console.log('validate-folder-permissions: No read permission:', readError.message);
      return result;
    }

    // Check subfolder creation
    const testFolderPath = path.join(folderPath, testFolderName);
    try {
      // Clean up any leftover test folder from previous failed attempts
      if (fs.existsSync(testFolderPath)) {
        fs.rmSync(testFolderPath, { recursive: true, force: true });
      }
      fs.mkdirSync(testFolderPath);
      result.canCreateSubfolders = true;
      console.log('validate-folder-permissions: Subfolder creation OK');
    } catch (subfolderError) {
      result.error = 'Keine Berechtigung zum Erstellen von Unterordnern';
      result.errorCode = 'NO_SUBFOLDER_PERMISSION';
      console.log('validate-folder-permissions: No subfolder permission:', subfolderError.message);
      return result;
    }

    // Check write permission
    const testFilePath = path.join(testFolderPath, testFileName);
    try {
      fs.writeFileSync(testFilePath, testContent, 'utf8');

      // Verify by reading back
      const readBack = fs.readFileSync(testFilePath, 'utf8');
      if (readBack !== testContent) {
        throw new Error('File content mismatch');
      }

      result.writable = true;
      console.log('validate-folder-permissions: Write permission OK');
    } catch (writeError) {
      result.error = 'Keine Schreibberechtigung für diesen Ordner';
      result.errorCode = 'NO_WRITE_PERMISSION';
      console.log('validate-folder-permissions: No write permission:', writeError.message);
      // Still try to clean up
      try {
        fs.rmSync(testFolderPath, { recursive: true, force: true });
      } catch (e) { /* ignore */ }
      return result;
    }

    // Clean up test files
    try {
      fs.rmSync(testFolderPath, { recursive: true, force: true });
      console.log('validate-folder-permissions: Cleanup successful');
    } catch (cleanupError) {
      console.warn('validate-folder-permissions: Could not clean up test folder:', cleanupError.message);
      // Not a failure - permissions are validated
    }

    result.success = true;
    console.log('validate-folder-permissions: All checks passed for:', folderPath);
    return result;

  } catch (error) {
    // Handle any unexpected errors
    result.error = getFolderPermissionErrorMessage(error);
    result.errorCode = error.code || 'UNKNOWN_ERROR';
    console.log('validate-folder-permissions: Error:', error.code, error.message);
    return result;
  }
});

// Folder selection with validation - combines dialog and permission check
ipcMain.handle('select-folder-with-validation', async (event, options = {}) => {
  const dialogResult = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: options.title || 'Ordner auswählen'
  });

  console.log('select-folder-with-validation: Dialog result:', JSON.stringify(dialogResult));

  if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
    console.log('select-folder-with-validation: Dialog cancelled');
    return { success: false, canceled: true };
  }

  const selectedPath = dialogResult.filePaths[0];

  if (!selectedPath || selectedPath.trim() === '') {
    console.log('select-folder-with-validation: Empty path');
    return { success: false, canceled: true };
  }

  console.log('select-folder-with-validation: Validating permissions for:', selectedPath);

  // Validate permissions using the same logic
  const testFolderName = '.dentdoc-permission-test';
  const testFileName = 'test.txt';
  const testContent = 'DentDoc permission test ' + Date.now();

  const validation = {
    success: false,
    readable: false,
    writable: false,
    canCreateSubfolders: false,
    error: null,
    errorCode: null
  };

  try {
    // Check if path exists
    if (!fs.existsSync(selectedPath)) {
      try {
        fs.mkdirSync(selectedPath, { recursive: true });
      } catch (mkdirError) {
        validation.error = 'Ordner existiert nicht und kann nicht erstellt werden';
        validation.errorCode = 'CANNOT_CREATE_FOLDER';
        return { success: false, path: selectedPath, validation };
      }
    }

    // Check read permission
    try {
      fs.readdirSync(selectedPath);
      validation.readable = true;
    } catch (readError) {
      validation.error = 'Keine Leseberechtigung für diesen Ordner';
      validation.errorCode = 'NO_READ_PERMISSION';
      return { success: false, path: selectedPath, validation };
    }

    // Check subfolder creation
    const testFolderPath = path.join(selectedPath, testFolderName);
    try {
      if (fs.existsSync(testFolderPath)) {
        fs.rmSync(testFolderPath, { recursive: true, force: true });
      }
      fs.mkdirSync(testFolderPath);
      validation.canCreateSubfolders = true;
    } catch (subfolderError) {
      validation.error = 'Keine Berechtigung zum Erstellen von Unterordnern';
      validation.errorCode = 'NO_SUBFOLDER_PERMISSION';
      return { success: false, path: selectedPath, validation };
    }

    // Check write permission
    const testFilePath = path.join(testFolderPath, testFileName);
    try {
      fs.writeFileSync(testFilePath, testContent, 'utf8');
      const readBack = fs.readFileSync(testFilePath, 'utf8');
      if (readBack !== testContent) {
        throw new Error('File content mismatch');
      }
      validation.writable = true;
    } catch (writeError) {
      validation.error = 'Keine Schreibberechtigung für diesen Ordner';
      validation.errorCode = 'NO_WRITE_PERMISSION';
      try {
        fs.rmSync(testFolderPath, { recursive: true, force: true });
      } catch (e) { /* ignore */ }
      return { success: false, path: selectedPath, validation };
    }

    // Clean up
    try {
      fs.rmSync(testFolderPath, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn('select-folder-with-validation: Cleanup warning:', cleanupError.message);
    }

    validation.success = true;
    console.log('select-folder-with-validation: Validation passed for:', selectedPath);
    return { success: true, path: selectedPath, validation };

  } catch (error) {
    validation.error = getFolderPermissionErrorMessage(error);
    validation.errorCode = error.code || 'UNKNOWN_ERROR';
    console.log('select-folder-with-validation: Validation error:', error.code, error.message);
    return { success: false, path: selectedPath, validation };
  }
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

// IPC Handlers for voice profiles
const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

ipcMain.handle('get-voice-profiles', async () => {
  const profiles = voiceProfiles.getAllProfiles();
  console.log('[get-voice-profiles] Found profiles:', profiles.length);
  return profiles;
});

ipcMain.handle('delete-voice-profile', async (event, id) => {
  return await voiceProfiles.deleteProfile(id);
});

ipcMain.handle('rename-voice-profile', async (event, { id, newName }) => {
  return await voiceProfiles.updateProfile(id, { name: newName });
});

// ============================================================================
// Format Block (kundenspezifisches Dokumentationsformat)
// ============================================================================

ipcMain.handle('confirm-format-reset', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'question',
    buttons: ['Zurücksetzen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Dokumentationsformat zurücksetzen',
    message: 'Möchten Sie Ihr Dokumentationsformat wirklich auf den Standard zurücksetzen?',
    detail: 'Ihre aktuelle Version wird in der Historie gespeichert.'
  });
  return result.response === 0;
});

ipcMain.handle('get-format-block', async () => {
  try {
    const token = store.get('authToken');
    if (!token) return { error: 'Nicht angemeldet' };
    const result = await apiClient.getFormatBlock(token);
    console.log('[get-format-block] Success:', result?.block?.substring(0, 50));
    return result;
  } catch (error) {
    console.error('[get-format-block] Error:', error.message);
    return { error: error.message || 'Unbekannter Fehler' };
  }
});

ipcMain.handle('update-format-block', async (event, changeRequest) => {
  const token = store.get('authToken');
  if (!token) throw new Error('Nicht angemeldet');
  return await apiClient.updateFormatBlock(token, changeRequest);
});

ipcMain.handle('reset-format-block', async () => {
  const token = store.get('authToken');
  if (!token) throw new Error('Nicht angemeldet');
  return await apiClient.resetFormatBlock(token);
});

ipcMain.handle('get-format-history', async () => {
  const token = store.get('authToken');
  if (!token) throw new Error('Nicht angemeldet');
  return await apiClient.getFormatHistory(token);
});

ipcMain.handle('preview-format-block', async (event, block, isExpertMode) => {
  try {
    const token = store.get('authToken');
    if (!token) return { error: 'Nicht angemeldet' };
    return await apiClient.previewFormatBlock(token, block, isExpertMode || false);
  } catch (error) {
    console.error('[preview-format-block] Error:', error.message);
    return { error: error.message || 'Vorschau fehlgeschlagen' };
  }
});

ipcMain.handle('set-format-mode', async (event, mode) => {
  try {
    const token = store.get('authToken');
    if (!token) return { error: 'Nicht angemeldet' };
    return await apiClient.setFormatMode(token, mode);
  } catch (error) {
    console.error('[set-format-mode] Error:', error.message);
    return { error: error.message || 'Modus-Wechsel fehlgeschlagen' };
  }
});

ipcMain.handle('save-custom-prompt', async (event, prompt) => {
  try {
    const token = store.get('authToken');
    if (!token) return { error: 'Nicht angemeldet' };
    return await apiClient.saveCustomPrompt(token, prompt);
  } catch (error) {
    console.error('[save-custom-prompt] Error:', error.message);
    return { error: error.message || 'Speichern fehlgeschlagen' };
  }
});

ipcMain.handle('revert-format-block', async (event, version) => {
  try {
    const token = store.get('authToken');
    if (!token) return { error: 'Nicht angemeldet' };
    return await apiClient.revertFormatBlock(token, version);
  } catch (error) {
    console.error('[revert-format-block] Error:', error.message);
    return { error: error.message || 'Zurücksetzen fehlgeschlagen' };
  }
});

// Add utterance audio segment to voice profile (or create new profile)
// Manual flow: embeddings go directly to confirmed (not pending) for immediate use
ipcMain.handle('add-utterance-to-profile', async (event, {
  audioPath,
  startMs,
  endMs,
  profileId,
  newProfileName,
  newProfileRole,
  force  // Force-flag for confirmation when similarity is low
}) => {
  try {
    console.log('[add-utterance-to-profile] Starting...');
    console.log('[add-utterance-to-profile] Audio:', audioPath);
    console.log('[add-utterance-to-profile] Segment:', startMs, '-', endMs, 'ms');
    console.log('[add-utterance-to-profile] Force:', force);

    // 1. Check if audio file exists
    if (!audioPath || !fs.existsSync(audioPath)) {
      return { success: false, error: 'Audio-Datei nicht mehr verfügbar' };
    }

    // 2. Check duration (min 1 second)
    const durationMs = endMs - startMs;
    if (durationMs < 1000) {
      return { success: false, error: 'Utterance zu kurz (min. 1 Sekunde)' };
    }

    // 3. Convert to 16kHz WAV if needed
    let wavPath = audioPath;
    if (!audioPath.toLowerCase().endsWith('.wav') || !is16kMonoPcmWavSimple(audioPath)) {
      console.log('[add-utterance-to-profile] Converting to 16kHz WAV...');
      const audioConverter = require('./src/audio-converter');
      wavPath = await audioConverter.convertToWav16k(audioPath);
      console.log('[add-utterance-to-profile] Converted:', wavPath);
    }

    // 4. Create embedding from audio segment
    console.log('[add-utterance-to-profile] Creating embedding...');
    const embedding = await speakerRecognition.createEmbedding(wavPath, startMs, durationMs);

    if (!embedding || embedding.length === 0) {
      return { success: false, error: 'Embedding konnte nicht erstellt werden' };
    }

    console.log('[add-utterance-to-profile] Embedding created, length:', embedding.length);

    const SIMILARITY_THRESHOLD = 0.60;

    // 5. Add to profile or create new one
    if (profileId) {
      // === EXISTING PROFILE ===
      const profile = voiceProfiles.getProfile(profileId);
      if (!profile) {
        return { success: false, error: 'Profil nicht gefunden' };
      }

      // Similarity check only if profile has centroid and force is not set
      if (profile.centroid && !force) {
        const similarity = voiceProfiles.cosineSimilarity(embedding, profile.centroid);
        console.log('[add-utterance-to-profile] Similarity to centroid:', similarity.toFixed(3));

        if (similarity < SIMILARITY_THRESHOLD) {
          // Return warning, user must confirm
          console.log('[add-utterance-to-profile] Low similarity, needs confirmation');
          return {
            needsConfirmation: true,
            similarity: similarity,
            profileName: profile.name,
            message: `Nur ${Math.round(similarity * 100)}% Ähnlichkeit`
          };
        }
      }

      // Add directly to confirmed (not pending!) for immediate use
      await voiceProfiles.addConfirmedEmbedding(profileId, embedding, {
        sourceType: 'utterance',
        sourceDuration: durationMs,
      });

      console.log('[add-utterance-to-profile] Added to existing profile:', profile.name);
      return { success: true, message: `Zu "${profile.name}" hinzugefügt` };

    } else {
      // === NEW PROFILE ===
      if (!newProfileName || !newProfileName.trim()) {
        return { success: false, error: 'Name erforderlich' };
      }

      // Create with immediate embedding (directly in confirmed, not pending)
      const newProfile = await voiceProfiles.saveProfileDirect(
        newProfileName.trim(),
        embedding,
        newProfileRole || 'Arzt',
        { sourceType: 'utterance', sourceDuration: durationMs }
      );

      console.log('[add-utterance-to-profile] Created new profile:', newProfile.name);
      return { success: true, message: `Profil "${newProfile.name}" erstellt` };
    }

  } catch (error) {
    console.error('[add-utterance-to-profile] Error:', error);
    autoUploadDebugLogs('utterance-profile-error');
    return { success: false, error: error.message };
  }
});

// Simple check if file is 16kHz mono PCM WAV (for utterance-to-profile)
function is16kMonoPcmWavSimple(filePath) {
  try {
    if (!filePath?.toLowerCase().endsWith('.wav')) return false;

    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    fs.closeSync(fd);

    // Check RIFF/WAVE header
    if (header.toString('ascii', 0, 4) !== 'RIFF') return false;
    if (header.toString('ascii', 8, 12) !== 'WAVE') return false;

    // Find fmt chunk
    let pos = 12;
    while (pos < header.length - 8) {
      const chunkId = header.toString('ascii', pos, pos + 4);
      const chunkSize = header.readUInt32LE(pos + 4);

      if (chunkId === 'fmt ') {
        const audioFormat = header.readUInt16LE(pos + 8);
        const numChannels = header.readUInt16LE(pos + 10);
        const sampleRate = header.readUInt32LE(pos + 12);

        // PCM (1), mono (1), 16kHz
        return audioFormat === 1 && numChannels === 1 && sampleRate === 16000;
      }

      pos += 8 + chunkSize;
    }

    return false;
  } catch {
    return false;
  }
}

ipcMain.handle('start-voice-enrollment', async (event, data) => {
  // Wrap everything in try-catch to ensure we always return
  try {
    if (isEnrolling) {
      return { success: false, error: 'Eine Aufnahme läuft bereits' };
    }
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

    // Support both old format (string) and new format ({ name, role })
    let enrollmentName, enrollmentRole;
    if (typeof data === 'string') {
      enrollmentName = data;
      enrollmentRole = 'Arzt'; // Default role
    } else {
      enrollmentName = data.name;
      enrollmentRole = data.role || 'Arzt';
    }

    // Get selected microphone name (FFmpeg needs device name, not browser ID)
    const microphoneName = store.get('microphoneName') || null;

    // Check if microphone is connected before starting
    if (microphoneName) {
      const availableDevices = await audioRecorder.listAudioDevices();
      const selectedMicAvailable = isMicrophoneAvailable(microphoneName, availableDevices);

      console.log('[Voice Enrollment] Mic check - selected:', microphoneName);
      console.log('[Voice Enrollment] Mic check - available:', availableDevices.map(d => d.name));
      console.log('[Voice Enrollment] Mic check - found:', selectedMicAvailable);

      if (!selectedMicAvailable) {
        throw new Error(`Mikrofon nicht verbunden: ${microphoneName}`);
      }
    }

    isEnrolling = true;
    currentEnrollmentName = enrollmentName;
    currentEnrollmentRole = enrollmentRole;
    currentEnrollmentPath = await audioRecorder.startRecording(false, microphoneName);

    // Check if recording was cancelled or failed to start (returns null)
    if (!currentEnrollmentPath) {
      console.log('[Voice Enrollment] startRecording returned null - recording was cancelled');
      isEnrolling = false;
      return { success: false, cancelled: true };
    }

    // Check if cancelled during the async startRecording (race condition with cancel button)
    if (!isEnrolling) {
      // Cancel happened while we were starting - clean up and return cancelled
      if (fs.existsSync(currentEnrollmentPath)) {
        try { fs.unlinkSync(currentEnrollmentPath); } catch (e) {}
      }
      return { success: false, cancelled: true };
    }

    return { success: true };
  } catch (error) {
    console.error('[Voice Enrollment] Error:', error.message);
    isEnrolling = false;
    autoUploadDebugLogs('voice-enrollment-start-error');
    // Return error instead of throwing to ensure IPC always gets a response
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-voice-enrollment', async () => {
  if (!isEnrolling) {
    // Already cancelled or not started - return gracefully instead of throwing
    console.log('[Voice Enrollment] stop called but not enrolling - returning gracefully');
    return { success: false, reason: 'not-recording' };
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
    const enrollmentPathForCleanup = currentEnrollmentPath;
    const profile = await speakerRecognition.enrollSpeaker(
      currentEnrollmentName,
      currentEnrollmentPath,
      currentEnrollmentRole
    );

    isEnrolling = false;
    currentEnrollmentName = null;
    currentEnrollmentPath = null;
    currentEnrollmentRole = null;

    // DSGVO: clean up enrollment audio after profile is saved (embedding is already in backend).
    // Best-effort — also covered by the App-Start wipe.
    try {
      if (enrollmentPathForCleanup) {
        await audioEncryption.secureDelete(enrollmentPathForCleanup);
      }
    } catch (cleanupErr) {
      console.warn('[Enrollment] cleanup of enrollment WAV failed (non-fatal):', cleanupErr.message);
    }

    return { success: true, profile };
  } catch (error) {
    console.error('[Voice Enrollment] Stop error:', error.message);
    isEnrolling = false;
    autoUploadDebugLogs('voice-enrollment-stop-error');
    // Return error instead of throwing to ensure IPC always gets a response
    return { success: false, error: error.message };
  }
});

// Cancel voice enrollment (without saving)
ipcMain.handle('cancel-voice-enrollment', async () => {
  if (!isEnrolling) {
    return { success: true };
  }

  const pathToDelete = currentEnrollmentPath;

  // Force stop to ensure mic is released
  try {
    await audioRecorder.forceStop();
  } catch (error) {
    console.error('Error stopping recording during cancel:', error);
    autoUploadDebugLogs('voice-enrollment-cancel-error');
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
    autoUploadDebugLogs('vad-session-error');
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
    autoUploadDebugLogs('vad-session-error');
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
    autoUploadDebugLogs('vad-concatenate-error');
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
    autoUploadDebugLogs('mic-test-error');
    return { success: false, error: error.message };
  }
});

// Stop mic test recording and return the audio file path
ipcMain.handle('stop-mic-test', async () => {
  try {
    // Check if actually recording before trying to stop
    const state = audioRecorder.getState();
    if (state === 'idle') {
      // Nothing to stop - return success silently
      return { success: true, path: micTestPath };
    }
    const filePath = await audioRecorder.stopRecording();
    micTestPath = filePath;

    // Recording is now 16kHz directly - no downsample needed

    return { success: true, path: filePath };
  } catch (error) {
    // If recording was already stopped but file exists, return success
    if (micTestPath && fs.existsSync(micTestPath)) {
      return { success: true, path: micTestPath };
    }
    console.error('Mic test stop error:', error);
    autoUploadDebugLogs('mic-test-error');
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
    autoUploadDebugLogs('mic-test-error');
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
    autoUploadDebugLogs('speaker-optimization-error');
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
    autoUploadDebugLogs('speaker-optimization-error');
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
      const profile = await voiceProfiles.addPendingEmbedding(profileId, embeddingResult.embedding, {
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
      const profile = await voiceProfiles.saveProfileWithPending(name.trim(), embeddingResult.embedding, role, {
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
    autoUploadDebugLogs('speaker-optimization-error');
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
    autoUploadDebugLogs('speaker-optimization-error');
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
    if (!dashboardWindowResizeApplied) {
      fixFramelessWindowOffset(dashboardWindow);
      dashboardWindowResizeApplied = true;
    }

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

// PowerShell script to read/write Windows microphone input volume via COM API
const micVolumeScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppEndpoint);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out uint pcDevices);
    int Item(uint nDevice, out IntPtr ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out IntPtr pkey);
    int GetValue(ref PropertyKey key, out PropVariant pv);
    int SetValue(ref PropertyKey key, ref PropVariant propvar);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PropVariant {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr val1;
    public IntPtr val2;
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

public class MicVolumeHelper {
    static readonly PropertyKey PKEY_Device_FriendlyName = new PropertyKey {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
        pid = 14
    };

    static string GetDeviceFriendlyName(IMMDevice device) {
        IntPtr propsPtr;
        device.OpenPropertyStore(0, out propsPtr);
        var props = (IPropertyStore)Marshal.GetObjectForIUnknown(propsPtr);
        PropertyKey key = PKEY_Device_FriendlyName;
        PropVariant pv;
        props.GetValue(ref key, out pv);
        if (pv.vt == 31) return Marshal.PtrToStringUni(pv.val1);
        return "";
    }

    static IAudioEndpointVolume GetCaptureVolume(string deviceName) {
        var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(type);
        IMMDevice targetDevice = null;

        // Try to find specific device by name
        if (!string.IsNullOrEmpty(deviceName) && deviceName != "Default") {
            IntPtr collPtr;
            enumerator.EnumAudioEndpoints(1, 1, out collPtr);
            var collection = (IMMDeviceCollection)Marshal.GetObjectForIUnknown(collPtr);
            uint count;
            collection.GetCount(out count);
            for (uint i = 0; i < count; i++) {
                IntPtr devPtr;
                collection.Item(i, out devPtr);
                var dev = (IMMDevice)Marshal.GetObjectForIUnknown(devPtr);
                string name = GetDeviceFriendlyName(dev);
                if (name.IndexOf(deviceName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    deviceName.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) {
                    targetDevice = dev;
                    break;
                }
            }
        }

        // Fall back to default capture device
        if (targetDevice == null) {
            IntPtr devicePtr;
            enumerator.GetDefaultAudioEndpoint(1, 0, out devicePtr);
            targetDevice = (IMMDevice)Marshal.GetObjectForIUnknown(devicePtr);
        }

        Guid volumeIid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        object volumeObj;
        targetDevice.Activate(ref volumeIid, 1, IntPtr.Zero, out volumeObj);
        return (IAudioEndpointVolume)volumeObj;
    }

    public static string GetVolume(string deviceName) {
        var vol = GetCaptureVolume(deviceName);
        float level; vol.GetMasterVolumeLevelScalar(out level);
        bool muted; vol.GetMute(out muted);
        return (muted ? "muted" : Math.Round(level * 100).ToString());
    }

    public static void SetVolume(string deviceName, float percent) {
        var vol = GetCaptureVolume(deviceName);
        Guid empty = Guid.Empty;
        vol.SetMasterVolumeLevelScalar(percent / 100f, ref empty);
    }
}
'@
`;

// Get Windows microphone input volume (0-100 or "muted") for the selected mic
ipcMain.handle('get-mic-volume', async (event, micNameOverride) => {
  try {
    const { execFile } = require('child_process');
    const micName = (micNameOverride || store.get('microphoneName') || '').replace(/'/g, "''");
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', micVolumeScript + `[MicVolumeHelper]::GetVolume('${micName}')`], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          console.error('[MicVolume] Get error:', err.message);
          resolve({ error: err.message });
          return;
        }
        const value = stdout.trim();
        if (value === 'muted') {
          resolve({ volume: 0, muted: true });
        } else {
          resolve({ volume: parseInt(value) || 0, muted: false });
        }
      });
    });
  } catch (err) {
    console.error('[MicVolume] Get error:', err);
    return { error: err.message };
  }
});

// Set Windows microphone input volume (0-100) for the selected mic
ipcMain.handle('set-mic-volume', async (event, volume, micNameOverride) => {
  try {
    const { execFile } = require('child_process');
    const clamped = Math.max(0, Math.min(100, parseInt(volume) || 0));
    const micName = (micNameOverride || store.get('microphoneName') || '').replace(/'/g, "''");
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', micVolumeScript + `[MicVolumeHelper]::SetVolume('${micName}', ${clamped})`], { timeout: 5000 }, (err) => {
        if (err) {
          console.error('[MicVolume] Set error:', err.message);
          resolve({ error: err.message });
          return;
        }
        resolve({ success: true, volume: clamped });
      });
    });
  } catch (err) {
    console.error('[MicVolume] Set error:', err);
    return { error: err.message };
  }
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

// Disable code signature verification (we don't have a code signing certificate)
autoUpdater.verifyUpdateCodeSignature = false;

// Auto-install downloaded updates when the app quits (e.g. PC restart)
autoUpdater.autoInstallOnAppQuit = true;

// Flag for startup fallback: auto-install pending update without dialog
let forceAutoInstall = false;

// Track which version we already notified about (to avoid spam)
let notifiedUpdateVersion = null;

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  // Only show feedback if user manually checked for updates
  if (isManualUpdateCheck) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update gefunden',
      message: `Version ${info.version} wird heruntergeladen...`,
      buttons: ['OK']
    });
  }
  // Otherwise download silently - user will be notified when complete
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);

  // Save pending version so startup fallback can detect unapplied updates
  store.set('pendingUpdateVersion', info.version);

  // Startup fallback: auto-install without dialog if pending update wasn't applied
  if (forceAutoInstall) {
    console.log('[AutoUpdate] Pending update detected on startup, auto-installing v' + info.version);
    forceAutoInstall = false;
    setImmediate(() => {
      app.removeAllListeners('window-all-closed');
      BrowserWindow.getAllWindows().forEach(win => {
        win.removeAllListeners('close');
        win.close();
      });
      autoUpdater.quitAndInstall(false, true);
    });
    return;
  }

  // Skip dialog only for automatic checks if already notified
  if (!isManualUpdateCheck && notifiedUpdateVersion === info.version) {
    console.log('Already notified about this version, skipping dialog');
    return;
  }

  // Reset manual check flag
  isManualUpdateCheck = false;
  notifiedUpdateVersion = info.version;

  dialog.showMessageBox({
    type: 'info',
    title: 'Update bereit',
    message: `Version ${info.version} wurde heruntergeladen`,
    detail: 'Das Update wird beim nächsten Neustart automatisch installiert.',
    buttons: ['Jetzt neu starten', 'Später'],
    defaultId: 0,
    cancelId: 1
  }).then((result) => {
    if (result.response === 0) {
      // Force quit all windows and install
      setImmediate(() => {
        // Prevent app from just minimizing to tray
        app.removeAllListeners('window-all-closed');

        // Close all windows explicitly
        const allWindows = BrowserWindow.getAllWindows();
        allWindows.forEach(win => {
          win.removeAllListeners('close');
          win.close();
        });

        autoUpdater.quitAndInstall(false, true);
      });
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
    autoUploadDebugLogs('update-check-error');
    return { status: 'error', message: error.message };
  }
});

// IPC handler to get app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

app.whenReady().then(() => {
  // DSGVO: Generate per-session in-RAM encryption key for audio temp files.
  // Never persisted; lost on crash/restart → leftover .enc files become undecryptable.
  audioEncryption.initKey();

  // Wipe all audio temp files from prior sessions (no age threshold).
  wipeAllTempAudio();

  // TODO: Remove this line after testing tray balloon
  store.delete('hasSeenTrayHint');

  // Initialize tray module with dependencies
  trayModule.init({
    store,
    refreshUserData: () => session.refreshUserData(),
    openLocalDashboard,
    createLoginWindow,
    startRecording,
    stopRecording,
    showLastResult,
    selectAndTranscribeAudioFile,
    openWebDashboard,
    showCustomNotification,
    updateStatusOverlay,
    logout: async () => {
      const token = store.get('authToken');
      releaseCurrentRecordingSlot();
      session.stopHeartbeat();
      if (token) {
        await apiClient.logout(token, store);
      }
      store.delete('authToken');
      store.delete('user');
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.destroy();
      }
      showCustomNotification('Abgemeldet', 'Sie wurden erfolgreich abgemeldet', 'info');
      createLoginWindow();
    },
    getState: () => ({ isRecording, isProcessing, lastDocumentation })
  });
  trayModule.createTray();
  tray = trayModule.getTray();

  // Initialize notification IPC handlers
  initNotificationIPC();

  // Initialize session module with dependencies
  session.init({
    store,
    updateTrayMenu: trayModule.updateTrayMenu,
    showNotification,
    createLoginWindow
  });

  // Initialize recording slot module (license enforcement)
  recordingSlot.init(apiClient.getBaseUrl());

  // Initialize VAD Controller
  vadController.initialize();
  console.log('[App] VAD Controller initialized');

  // Voice profiles are now stored in the backend DB.
  // They get initialized via voiceProfiles.init(apiClient, getToken) after user login.

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

    // Startup fallback: check if a previously downloaded update wasn't applied
    // (e.g. Windows force-killed the process before NSIS installer could run)
    const pendingUpdate = store.get('pendingUpdateVersion');
    if (pendingUpdate && pendingUpdate !== app.getVersion()) {
      console.log('[AutoUpdate] Pending update v' + pendingUpdate + ' not applied, will auto-install');
      forceAutoInstall = true;
      // Safety: reset flag after 60s so a delayed download doesn't
      // surprise-restart the app while the user is working
      setTimeout(() => { forceAutoInstall = false; }, 60000);
    } else if (pendingUpdate) {
      // Version matches — update was successfully applied
      console.log('[AutoUpdate] Update v' + pendingUpdate + ' successfully applied');
      store.delete('pendingUpdateVersion');
    }

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
        session.startHeartbeat();
        return apiClient.getUser(token);
      } else {
        // Session expired
        throw new Error('Session expired');
      }
    }).then(async user => {
      store.set('user', user);
      trayModule.updateTrayMenu();

      // Initialize voice profiles from backend DB
      const voiceProfiles = require('./src/speaker-recognition/voice-profiles');
      await voiceProfiles.init(apiClient, () => store.get('authToken'));

      // Create dashboard window hidden at startup (for F9 audio monitoring)
      // The renderer needs to be running to handle getUserMedia for real audio levels
      if (!dashboardWindow || dashboardWindow.isDestroyed()) {
        createDashboardWindow();
        // Don't show it - user opens it via tray menu
      }

      // Auto-upload debug logs on startup for remote monitoring
      autoUploadDebugLogs('startup');

      // Check trial/subscription status on app start and show notification if needed
      const isTrialUser = user?.planTier === 'free_trial';
      const hasActiveSubscription = user?.subscriptionStatus === 'active';
      const isCanceled = user?.subscriptionStatus === 'canceled';
      const minutesRemaining = user?.minutesRemaining || 0;

      // Distinguish between true trial users and ex-subscribers
      const wasSubscriber = isCanceled || (isTrialUser && user?.stripeCustomerId);
      const trialExpired = isTrialUser && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

      if (user?.paymentFailedAt && hasActiveSubscription) {
        // Payment failed but subscription still active (Stripe is retrying)
        setTimeout(() => {
          showCustomNotification(
            'Zahlung fehlgeschlagen',
            'Ihre letzte Zahlung konnte nicht verarbeitet werden. Bitte Zahlungsmethode prüfen.',
            'error',
            () => openWebDashboard('/subscription')
          );
        }, 2000);
      } else if (user?.cancelAtPeriodEnd && hasActiveSubscription) {
        // Subscription pending cancellation - still active until period end
        const endDate = user?.currentPeriodEnd
          ? new Date(user.currentPeriodEnd).toLocaleDateString('de-DE')
          : '';
        setTimeout(() => {
          showCustomNotification(
            'Abo gekündigt',
            `Ihr Abonnement läuft noch bis ${endDate}. Klicken Sie hier zum Reaktivieren.`,
            'warning',
            () => openWebDashboard('/subscription')
          );
        }, 2000);
      } else if (wasSubscriber && !hasActiveSubscription) {
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
    }).catch((error) => {
      // Only logout on auth errors (401/session_expired), NOT on network errors
      const isAuthError = error.message === 'Session expired'
        || error.response?.status === 401
        || error.response?.data?.error === 'session_expired';

      if (isAuthError) {
        releaseCurrentRecordingSlot();
        session.stopHeartbeat();
        store.delete('authToken');
        store.delete('user');
        createLoginWindow();
      } else {
        // Network error - keep token, start heartbeat, use cached user data
        console.warn('[Startup] Network error during user fetch, using cached data:', error.message);
        session.startHeartbeat();
        const cachedUser = store.get('user');
        if (cachedUser) {
          createDashboardWindow();
        } else {
          // No cached user data - must show login
          createLoginWindow();
        }
      }
    });
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit the app when all windows are closed (stay in tray)
  e.preventDefault();
});

// Ensure app.isQuitting is set on all quit paths (Windows shutdown, app.quit(), etc.)
// This allows close handlers to permit window closing instead of hiding to tray
app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', async () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();

  // Stop any active recording and release microphone
  if (isRecording) {
    console.log('[Quit] Stopping active recording before quit');
    try {
      await audioRecorder.forceStop();
    } catch (err) {
      console.error('[Quit] Error stopping recording:', err);
    }
  }

  // Release recording slot if active (best-effort, server has 2-min timeout as fallback)
  releaseCurrentRecordingSlot();

  // Clean up mic test file
  cleanupMicTestFile();

  // DSGVO: wipe all audio temp files on shutdown
  wipeAllTempAudio();
});

// Handle second instance - open dashboard window when user clicks shortcut while app is running
app.on('second-instance', () => {
  // Check if user is logged in
  const token = store.get('authToken');
  if (token) {
    // User is logged in - show dashboard
    openLocalDashboard();
  } else {
    // User is not logged in - show login window
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.show();
      loginWindow.focus();
    } else {
      createLoginWindow();
    }
  }
});
