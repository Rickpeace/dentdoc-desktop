# Main Process - Electron Hauptprozess

> Dokumentation für `main.js` und extrahierte Module

## Übersicht

Der Main Process ist das "Gehirn" der App mit ~4800 Zeilen Code in `main.js` plus drei extrahierte Module.

## Module

### 1. notifications.js

**Pfad:** `src/notifications.js`

**Funktionen:**
```javascript
showNotification(title, body, onClick)      // Native OS Notification
showCustomNotification(title, body, type, onClick)  // Custom Popup Window
initNotificationIPC()                        // IPC Handler registrieren
```

**Types für Custom Notifications:**
- `warning` - Gelb/Orange
- `success` - Grün
- `error` - Rot
- `info` - Blau

**Verwendung:**
```javascript
const { showNotification, showCustomNotification } = require('./src/notifications');

// Native
showNotification('Titel', 'Nachricht');

// Custom mit Klick-Aktion
showCustomNotification('Abo abgelaufen', 'Klicken zum Erneuern', 'error', () => {
  openWebDashboard('/subscription');
});
```

---

### 2. session.js

**Pfad:** `src/session.js`

**Initialisierung:**
```javascript
const session = require('./src/session');

session.init({
  store,                    // electron-store Instanz
  updateTrayMenu,           // Callback für Tray-Update
  showNotification,         // Callback für Benachrichtigungen
  createLoginWindow         // Callback für Login-Dialog
});
```

**Funktionen:**
```javascript
session.startHeartbeat()    // Startet 5-Minuten Heartbeat zum Backend
session.stopHeartbeat()     // Stoppt Heartbeat (bei Logout)
session.refreshUserData()   // Holt aktuelle User-Daten vom Backend
```

**Heartbeat-Logik:**
- Alle 5 Minuten: `POST /api/devices/heartbeat`
- Bei ungültigem Token: Auto-Logout + Notification
- Bei Subscription-Änderung: Notification + Tray-Update

---

### 3. tray.js

**Pfad:** `src/tray.js`

**Initialisierung:**
```javascript
const trayModule = require('./src/tray');

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
  logout: async () => { /* ... */ },
  getState: () => ({ isRecording, isProcessing, lastDocumentation })
});

trayModule.createTray();
tray = trayModule.getTray();  // Für Icon-Updates in main.js
```

**Funktionen:**
```javascript
trayModule.createTray()       // Erstellt System Tray Icon
trayModule.buildTrayMenu()    // Baut Kontextmenü (intern)
trayModule.updateTrayMenu()   // Legacy Kompatibilität (no-op)
trayModule.getTray()          // Returns Tray-Instanz
```

**Tray-Menü Einträge:**
- Status (Trial-Minuten / Pro-Status)
- Aufnahme starten/stoppen
- Audio-Datei transkribieren
- Letzte Dokumentation anzeigen
- App öffnen
- Abmelden
- Beenden
- Versionsnummer

---

## State-Variablen (main.js)

### Recording State
```javascript
let isRecording = false;           // Aufnahme aktiv?
let isProcessing = false;          // Verarbeitung läuft?
let isEnrolling = false;           // Stimmprofil-Enrollment?
let currentRecordingPath = null;   // Pfad zur aktuellen Aufnahme
```

### Session State
```javascript
let isIphoneSession = false;       // iPhone-Aufnahme aktiv?
let isVadSession = false;          // VAD-Aufnahme aktiv?
```

### Window References
```javascript
let tray = null;                   // System Tray (von trayModule)
let loginWindow = null;            // Login-Dialog
let dashboardWindow = null;        // Hauptfenster
let statusOverlay = null;          // Floating Status-Overlay
let statusOverlayReady = false;    // Overlay bereit für Updates?
```

### Last Result Cache
```javascript
let lastDocumentation = null;      // Letzte generierte Dokumentation
let lastTranscript = null;         // Letztes Transkript (plain)
let lastTranscriptWithSpeakers = null;  // Mit Sprecher-Labels
let lastReconstructedTranscript = null; // Rekonstruiert aus Utterances
let lastRecognizedSpeakers = [];   // Erkannte Sprecher
let lastDetection = null;          // Zahnschema-Detektion
let lastStatus01 = null;           // 01-Status
let lastStatusPA = null;           // PA-Status
let lastKzvDocumentation = null;   // KZV-Dokumentation
```

---

## Kern-Funktionen

### Window Management

#### `createDashboardWindow()` (Zeile ~135)
```javascript
// Erstellt verstecktes Dashboard (für Audio-Monitoring)
dashboardWindow = new BrowserWindow({
  show: false,
  webPreferences: {
    nodeIntegration: true,
    contextIsolation: false,
    backgroundThrottling: false  // Wichtig für F9
  }
});
```

#### `openLocalDashboard()` (Zeile ~118)
```javascript
// Zeigt Dashboard (erstellt falls nötig)
if (dashboardWindow && !dashboardWindow.isDestroyed()) {
  dashboardWindow.show();
  dashboardWindow.focus();
} else {
  createDashboardWindow();
}
```

#### `createLoginWindow()` (Zeile ~635)
```javascript
// Login-Dialog (schließt App wenn ohne Login geschlossen)
loginWindow.on('close', (e) => {
  if (!store.get('authToken')) {
    app.quit();
  }
});
```

#### `createStatusOverlay()` (Zeile ~2290)
```javascript
// Floating Overlay für Status-Anzeige
statusOverlay = new BrowserWindow({
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  focusable: false  // Verhindert Fokus-Stealing
});
```

---

### Recording Functions

#### `startRecording()` (Zeile ~1412)
```javascript
async function startRecording() {
  // 1. Auth + Subscription prüfen
  // 2. Aufnahme-Modus wählen (Standard/iPhone/VAD)
  // 3. audioRecorderFFmpeg.startRecording()
  // 4. Tray-Icon + Overlay aktualisieren
}
```

#### `stopRecording()` (Zeile ~2128)
```javascript
async function stopRecording() {
  // 1. Aufnahme stoppen
  // 2. processAudioFile() starten
}
```

#### `processAudioFile(audioPath)` (Zeile ~870)
```javascript
async function processAudioFile(audioPath) {
  // 1. Audio zu Backend uploaden
  // 2. Auf Transkription warten
  // 3. Sprechererkennung (lokal)
  // 4. Dokumentation generieren (Backend)
  // 5. In Zwischenablage kopieren
  // 6. Overlay mit Ergebnis aktualisieren
}
```

---

### Utility Functions

#### `updateStatusOverlay(title, message, type, extra)` (Zeile ~2452)
```javascript
// Types: 'recording', 'processing', 'success', 'error', 'starting'
updateStatusOverlay('Aufnahme läuft', '00:15', 'recording', {
  audioLevel: 0.5,
  canSummarize: true
});
```

#### `showLastResult()` (Zeile ~2528)
```javascript
// Zeigt letzte Dokumentation im Overlay
// Inkl. Transkript, Sprecher, Zahnschema
```

#### `registerShortcut(shortcut)` (Zeile ~254)
```javascript
// Registriert globalen Hotkey (default: F9)
globalShortcut.register(shortcut, async () => {
  if (isRecording) await stopRecording();
  else await startRecording();
});
```

---

## IPC Handler

### Übersicht der wichtigsten Handler

| Handler | Typ | Beschreibung |
|---------|-----|--------------|
| `login` | handle | Login mit Email/Password |
| `get-user` | handle | Aktuelle User-Daten |
| `get-subscription-status` | handle | Trial/Abo Status |
| `toggle-recording` | handle | Aufnahme starten/stoppen |
| `get-recording-state` | handle | isRecording, isProcessing |
| `get-last-documentation` | handle | Letzte Dokumentation |
| `get-theme` / `set-theme` | handle | Theme-Einstellung |
| `get-shortcut` | handle | Aktueller Shortcut |
| `close-status-overlay` | on | Overlay schließen |
| `overlay:resize` | on | Overlay-Größe anpassen |
| `cancel-recording` | on | Aufnahme abbrechen |

### Settings Handler

```javascript
ipcMain.handle('get-theme', () => store.get('theme', 'dark'));
ipcMain.handle('set-theme', (e, theme) => store.set('theme', theme));

ipcMain.handle('get-shortcut', () => store.get('shortcut', 'F9'));
ipcMain.handle('set-shortcut', (e, shortcut) => {
  store.set('shortcut', shortcut);
  registerShortcut(shortcut);
});
```

### Folder Validation Handler

Validiert Ordner-Berechtigungen durch echte Schreibversuche (nicht nur `fs.access`). Wichtig für Netzwerkordner.

```javascript
ipcMain.handle('validate-folder-permissions', async (e, folderPath) => {
  // 1. Prüft ob Ordner existiert (erstellt falls nötig)
  // 2. Testet Leseberechtigung (readdirSync)
  // 3. Erstellt Test-Unterordner .dentdoc-permission-test
  // 4. Schreibt und liest Test-Datei
  // 5. Räumt Test-Ordner auf
  // Gibt zurück: { success, readable, writable, canCreateSubfolders, error, errorCode }
});

ipcMain.handle('select-folder-with-validation', async (e, options) => {
  // Kombiniert Ordner-Dialog + Validierung in einem Aufruf
  // Gibt zurück: { success, canceled, path, validation }
});
```

**Fehler-Codes (Deutsch):**

| Code | Meldung |
|------|---------|
| ENOENT | Pfad nicht gefunden - Netzwerk verbunden? |
| EACCES/EPERM | Zugriff verweigert - keine Berechtigung |
| ETIMEDOUT | Netzwerkordner nicht erreichbar |
| EROFS | Ordner ist schreibgeschützt |
| ENOSPC | Kein Speicherplatz verfügbar |

### Transcript Handler

```javascript
ipcMain.handle('get-all-transcripts', async () => {
  // Liest alle Transkripte aus transcriptSavePath
});

ipcMain.handle('get-transcript-detail', async (e, filePath) => {
  // Liest einzelnes Transkript
});
```

---

## App Lifecycle

### Startup (app.whenReady)

```javascript
app.whenReady().then(() => {
  // 0. Alte Temp-Dateien aufräumen (>2 Stunden alt)
  cleanupOldTempFiles();

  // 1. Tray-Modul initialisieren
  trayModule.init({ ... });
  trayModule.createTray();

  // 2. Notification IPC registrieren
  initNotificationIPC();

  // 3. Session-Modul initialisieren
  session.init({ ... });

  // 4. VAD Controller initialisieren
  vadController.initialize();

  // 5. Voice Profiles Pfad setzen
  voiceProfiles.setStorePath(profilesPath);

  // 6. Shortcut registrieren
  registerShortcut(store.get('shortcut', 'F9'));

  // 7. Auto-Updater (nur Production)
  autoUpdater.checkForUpdatesAndNotify();

  // 8. Token validieren + Dashboard erstellen
  if (token) {
    apiClient.heartbeat(token).then(valid => {
      if (valid) {
        session.startHeartbeat();
        createDashboardWindow();
      } else {
        createLoginWindow();
      }
    });
  } else {
    createLoginWindow();
  }
});
```

### Shutdown

```javascript
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupMicTestFile();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();  // Nicht beenden, im Tray bleiben
});
```

---

## Fehlerbehandlung

### Globale Error Handler

```javascript
process.on('uncaughtException', (error) => {
  fs.appendFileSync(path.join(os.tmpdir(), 'dentdoc-crash.log'),
    `[${new Date().toISOString()}] UNCAUGHT: ${error.message}\n`);
});

process.on('unhandledRejection', (reason) => {
  fs.appendFileSync(path.join(os.tmpdir(), 'dentdoc-crash.log'),
    `[${new Date().toISOString()}] REJECTION: ${reason}\n`);
});
```

### Debug Logging (Lokal)

```javascript
const DEBUG_LOG = path.join(os.tmpdir(), 'dentdoc-main-debug.log');
function debugLog(message) {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`);
}
```

### Remote Error Logging (Backend)

Fehler werden an das Backend gesendet für zentrale Analyse.

**Implementierung (apiClient.js):**

```javascript
async logError(errorData) {
  // POST /api/devices/error-log
  // Payload: { error, stack, context, appVersion, timestamp }
  return fetch(`${API_URL}/api/devices/error-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-token': token },
    body: JSON.stringify(errorData)
  });
}
```

**Verwendung in main.js:**

```javascript
try {
  await processAudioFile(audioPath);
} catch (error) {
  await apiClient.logError({
    error: error.message,
    stack: error.stack,
    context: 'processAudioFile',
    appVersion: app.getVersion()
  });
}
```

**Admin-Dashboard zeigt Fehler:**
- Nach Datum gefiltert
- Zeigt User-Email, Fehlermeldung, Kontext
- Hilft bei Remote-Debugging

### Auto-Upload Debug Logs

Debug-Logs werden automatisch hochgeladen bei:
- App-Start (nach erfolgreicher Token-Validierung)
- Fehlern in Recording/Processing-Funktionen

```javascript
// main.js
async function autoUploadDebugLogs(context) {
  const token = store.get('authToken');
  if (!token) return;

  try {
    const debugLogPath = path.join(os.tmpdir(), 'dentdoc-main-debug.log');
    if (!fs.existsSync(debugLogPath)) return;

    const logContent = fs.readFileSync(debugLogPath, 'utf8');
    const last50KB = logContent.slice(-50000);  // Nur letzte 50KB

    await apiClient.uploadDebugLog(token, {
      context,
      timestamp: new Date().toISOString(),
      appVersion: app.getVersion(),
      logs: last50KB
    });
    console.log(`[AUTO-UPLOAD] Context: ${context} at ${new Date().toISOString()}`);
  } catch (err) {
    // Fire-and-forget, keine Fehlerbehandlung nötig
  }
}
```

**Verwendung:**
```javascript
// Bei App-Start
autoUploadDebugLogs('app-startup');

// Bei Fehlern
catch (error) {
  autoUploadDebugLogs('stopRecordingWithVAD-error');
}
```

---

## Mikrofon-Verfügbarkeits-Check

Vor Aufnahme-Start wird geprüft, ob das ausgewählte Mikrofon verfügbar ist.

**Implementierung in `startRecordingWithVAD()`:**

```javascript
// Check if selected microphone is available BEFORE starting
if (microphoneName) {
  const availableDevices = await audioRecorder.listAudioDevices();

  // Vendor:Product ID aus gespeichertem Namen extrahieren
  const savedVendorId = microphoneName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();

  const selectedMicAvailable = availableDevices.some(d => {
    // 1. Exakter Match
    if (d.name === microphoneName) return true;

    // 2. Vendor:Product ID Match
    if (savedVendorId) {
      const currentVendorId = d.name.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
      if (currentVendorId && currentVendorId === savedVendorId) return true;
    }

    // 3. Normalisierter Name Match (Fallback)
    const currentNormalized = normalizeName(d.name);
    if (savedNormalized === currentNormalized) return true;

    return false;
  });

  if (!selectedMicAvailable) {
    console.log('[VAD] Mic check - found: false');
    updateStatusOverlay('Mikrofon nicht verbunden', microphoneName, 'error');
    return;  // Aufnahme wird NICHT gestartet!
  }
}
```

**Siehe auch:** [audio-recording.md](audio-recording.md) - Mikrofon-Matching Details

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [audio-recording.md](audio-recording.md) - Aufnahme-Details
- [api-integration.md](api-integration.md) - Backend-Kommunikation
