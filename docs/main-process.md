# Main Process - Electron Hauptprozess

> Dokumentation für `main.js` und extrahierte Module

## Übersicht

Der Main Process ist das "Gehirn" der App mit ~6400 Zeilen Code in `main.js` plus drei extrahierte Module.

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

### 4. recordingSlot.js

**Pfad:** `src/recordingSlot.js`

**Funktionen:**
```javascript
init(baseUrl)                                    // API Base URL setzen
claimSlot(token, deviceId)                       // Slot reservieren → {recordingId}
startHeartbeat(token, recordingId, warningCb)    // Keep-Alive alle 60s
releaseSlot(token, recordingId)                  // Slot freigeben (idempotent)
stopHeartbeat()                                  // Heartbeat stoppen + State cleanup
```

**Lizenz-Enforcement:**
- 1 aktive Aufnahme = 1 Lizenz (`user.maxDevices`)
- Heartbeat alle 60s, Server-Timeout nach 2 Min ohne Heartbeat
- Skip-if-pending: verhindert parallele Heartbeat-Requests
- Failure-Counter: nach 2 aufeinanderfolgenden Fehlern → Callback mit Reason (`'expired'` | `'error'`)
- 404 vom Heartbeat = Slot verfallen (z.B. nach Netzwerkausfall)

**Crash-Recovery:** Beim Claim werden eigene stale Slots vom selben Gerät automatisch released (Backend).

---

### releaseCurrentRecordingSlot() (main.js, Zeile ~282)

Deduplizierte Helper-Funktion für alle Release-Pfade (Stop, Error, Cancel, Logout, Quit):

```javascript
function releaseCurrentRecordingSlot() {
  if (!currentRecordingSlotId) return;
  // Token aus Claim-Zeitpunkt oder Store (Fallback)
  const token = currentRecordingSlotToken || store.get('authToken');
  // Release mit 1x Retry nach 2s
  recordingSlot.releaseSlot(token, slotId).catch(() => {
    setTimeout(() => recordingSlot.releaseSlot(token, slotId).catch(() => {}), 2000);
  });
  recordingSlot.stopHeartbeat();
  currentRecordingSlotId = null;
  currentRecordingSlotToken = null;
}
```

---

## State-Variablen (main.js)

### Recording State
```javascript
let isRecording = false;           // Aufnahme aktiv?
let isProcessing = false;          // Verarbeitung läuft?
let isEnrolling = false;           // Stimmprofil-Enrollment?
let currentRecordingPath = null;   // Pfad zur aktuellen Aufnahme
```

### Recording Slot State (Lizenz-Enforcement)
```javascript
let currentRecordingSlotId = null;      // Backend Recording Slot ID
let currentRecordingSlotToken = null;   // Token beim Claim (überlebt Logout)
let recordingSlotPending = false;       // True während Claim in-flight
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

#### `processFileWithVAD(audioPath, token, options)` (Zeile ~1581)
```javascript
async function processFileWithVAD(audioPath, token, options) {
  // options: { skipVAD, liveSegments, source }
  // skipVAD=true + liveSegments=[...] → Nutzt Live-Marker (kein Offline VAD)
  // skipVAD=false → Offline VAD (nur Datei-Upload)
  // liveSegments leer → Upload ohne Stille-Entfernung
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
// startInProgress Guard verhindert Race Condition bei schnellem Doppel-Drücken
let startInProgress = false;

globalShortcut.register(shortcut, async () => {
  if (isRecording) await stopRecording();
  else if (!startInProgress && !isProcessing) {
    startInProgress = true;
    try { await startRecording(); }
    finally { startInProgress = false; }
  }
});
```

**Warum `startInProgress`?** FFmpeg-Start kann 1.4s+ dauern (WASAPI fail → DirectShow Fallback). Ohne Guard könnte ein zweites F9 `startRecording()` erneut aufrufen, da `isRecording` erst nach FFmpeg-Setup gesetzt wird.

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

### Mikrofon-Lautstärke Handler

Ermöglicht Anzeige und Steuerung der Windows-Mikrofon-Eingangslautstärke direkt in der App.

```javascript
ipcMain.handle('get-mic-volume', async (event, micNameOverride) => {
  // PowerShell C# COM Interop: IAudioEndpointVolume via IMMDeviceEnumerator
  // Sucht Gerät anhand micNameOverride oder store.get('microphoneName')
  // Gibt zurück: { volume: 85, muted: false } oder { error: '...' }
});

ipcMain.handle('set-mic-volume', async (event, volume, micNameOverride) => {
  // Setzt Master-Volume (0-100%) für das benannte Mikrofon
  // Gibt zurück: { success: true } oder { error: '...' }
});
```

**Geräte-Matching:** Verwendet `PKEY_Device_FriendlyName` via `IPropertyStore` COM API. Bidirektionaler `IndexOf`-Vergleich für Robustheit (FFmpeg/dshow vs Core Audio Namen können leicht abweichen).

**Einschränkung:** Bei Geräten mit Hardware-DSP/AGC (z.B. Jabra Speak2 75) hat der Windows-Volume-Regler keinen Effekt — das Gerät steuert die Verstärkung selbst.

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

  // 4. Recording Slot Module initialisieren
  recordingSlot.init(apiClient.getBaseUrl());

  // 5. VAD Controller initialisieren
  vadController.initialize();

  // 6. Voice Profiles initialisieren (Backend DB)
  await voiceProfiles.init(apiClient, () => store.get('authToken'));

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
app.on('before-quit', () => {
  app.isQuitting = true;  // Erlaubt Close-Handler, Fenster zu schließen
  // Wichtig für Windows Shutdown: autoInstallOnAppQuit kann NSIS starten
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  cleanupMicTestFile();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();  // Nicht beenden, im Tray bleiben
});
```

---

### Auto-Update

```javascript
autoUpdater.autoInstallOnAppQuit = true;

let forceAutoInstall = false;  // Startup-Fallback für nicht-applizierte Updates
```

**Update-Downloaded Handler:**
```javascript
autoUpdater.on('update-downloaded', (info) => {
  store.set('pendingUpdateVersion', info.version);

  // Startup-Fallback: Auto-Install ohne Dialog
  if (forceAutoInstall) {
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

  // Dialog anzeigen (Jetzt / Später)
  // ...
});
```

**Startup-Fallback Logik:**
```javascript
// Beim App-Start: Prüfe ob ein Update ausstehend ist
const pendingUpdate = store.get('pendingUpdateVersion');
if (pendingUpdate && pendingUpdate !== app.getVersion()) {
  forceAutoInstall = true;
  setTimeout(() => { forceAutoInstall = false; }, 60000);  // 60s Safety
} else if (pendingUpdate) {
  store.delete('pendingUpdateVersion');  // Update erfolgreich
}
```

**Szenarien:**

| Szenario | Verhalten |
|----------|-----------|
| PC Neustart (sauber) | `before-quit` → `isQuitting=true` → `autoInstallOnAppQuit` installiert |
| PC Neustart (force-killed) | Startup-Fallback: `forceAutoInstall` → Auto-Install ohne Dialog |
| Kein Internet beim Start | `forceAutoInstall` nach 60s zurückgesetzt → normaler Dialog später |

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
- Fehlern in Recording/Processing-Funktionen (Pause/Resume, Timeout, etc.)

```javascript
// main.js
function autoUploadDebugLogs(context = 'unknown') {
  // Fire-and-forget (don't await)
  (async () => {
    const token = store.get('authToken');
    if (!token) return;

    let logs = fs.readFileSync(DEBUG_LOG, 'utf8');
    // Limit to last 500KB
    if (logs.length > 500 * 1024) {
      logs = logs.slice(-500 * 1024);
    }

    // Add context marker
    const contextMarker = `\n[AUTO-UPLOAD] Context: ${context} at ${new Date().toISOString()}\n`;
    logs = logs + contextMarker;

    // apiClient derives uploadReason from context:
    // 'startup' → 'startup', 'manual' → 'manual'
    // contains 'error/timeout/warning' → 'error', else → 'unknown'
    await apiClient.uploadDebugLogs(token, store, logs, appVersion, context);
  })();
}
```

**Upload-Reason Mapping (apiClient.js):**

| Context | uploadReason |
|---------|--------------|
| `'startup'` | `'startup'` |
| `'manual'` | `'manual'` |
| Enthält `'error'`, `'timeout'`, `'warning'` | `'error'` |
| Alles andere | `'unknown'` |

**Verwendung:**
```javascript
// Bei App-Start
autoUploadDebugLogs('startup');

// Bei Fehlern
} catch (error) {
  autoUploadDebugLogs('toggle-pause-error');
}

// Bei Timeouts
autoUploadDebugLogs('recording-timeout');
```

**Alle Auto-Upload Kontexte:**

| Kontext | Auslöser |
|---------|----------|
| `startup` | App-Start nach Token-Validierung |
| `folder-access-warning` | Keine Schreibrechte auf Export-Ordner |
| `speakerRecognition-error` | Fehler bei Sprechererkennung |
| `processAudioFile-error` | Fehler beim Audio-Processing |
| `processFileWithVAD-error` | Fehler beim VAD-Processing |
| `startRecordingWithIphone-error` | Fehler beim iPhone-Aufnahmestart |
| `startRecordingWithVAD-error` | Fehler beim VAD-Aufnahmestart |
| `startRecording-error` | Allgemeiner Aufnahme-Startfehler |
| `processing-timeout` | Timeout beim Processing |
| `stopRecordingWithVAD-error` | Fehler beim VAD-Aufnahmestopp |
| `stopRecordingWithIphone-error` | Fehler beim iPhone-Aufnahmestopp |
| `stopRecording-error` | Allgemeiner Aufnahmestopp-Fehler |
| `toggle-pause-error` | Fehler beim Pause/Resume |
| `voice-enrollment-start-error` | Fehler beim Start der Stimmregistrierung |
| `voice-enrollment-stop-error` | Fehler beim Stopp der Stimmregistrierung |
| `voice-enrollment-cancel-error` | Fehler beim Abbruch der Stimmregistrierung |
| `iphone-connection-error` | Fehler beim iPhone-Verbindungstest |

**Zusätzliche debugLog-Kontexte (nur lokale Protokollierung):**

| Kontext | Auslöser |
|---------|----------|
| `[iPhone] WebSocket send STOP failed...` | WebSocket-Fehler während Cleanup |
| `[iPhone] Reconnect write/invalid message` | Fehler bei Reconnect-Handling |
| `[iPhone] Pair/Get status failed` | iPhone-Pairing Status-Abfrage fehlgeschlagen |
| `[iPhone] Connection test failed` | iPhone-Verbindungstest fehlgeschlagen |
| `[Subscription] API fetch failed` | Abonnement-Daten konnten nicht geladen werden |

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
