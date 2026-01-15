# DentDoc Desktop - Vollständige Architektur & Technische Dokumentation

## Inhaltsverzeichnis

1. [Projektübersicht](#projektübersicht)
2. [Technologie-Stack](#technologie-stack)
3. [Dateistruktur](#dateistruktur)
4. [Hauptprozess (main.js)](#hauptprozess-mainjs)
5. [API Client](#api-client-srcapiclientjs)
6. [Audio-Aufnahme](#audio-aufnahme-srcaudiorecorderjs)
7. [Audio-Konvertierung](#audio-konvertierung-srcaudio-converterjs)
8. [Speaker Recognition](#speaker-recognition)
9. [Stimmprofile](#stimmprofile-srcspeaker-recognitionvoice-profilesjs)
10. [Bausteine-System](#bausteine-system)
11. [Benutzeroberflächen](#benutzeroberflächen)
12. [IPC-Kommunikation](#ipc-kommunikation)
13. [Datenfluss & Ablaufdiagramme](#datenfluss--ablaufdiagramme)
14. [Speicherung & Persistenz](#speicherung--persistenz)
15. [Auto-Update System](#auto-update-system)
16. [Subscription & Trial-Logik](#subscription--trial-logik)
17. [Fehlerbehandlung](#fehlerbehandlung)
18. [Sicherheit](#sicherheit)
19. [Build & Distribution](#build--distribution)
20. [Changelog](#changelog)

---

## Projektübersicht

### Was ist DentDoc?

**DentDoc Desktop** ist eine Windows Electron-Anwendung für die automatische Zahnarzt-Dokumentation. Die App:

1. **Nimmt Audio auf** - Gespräche zwischen Arzt/ZFA und Patient während der Behandlung
2. **Transkribiert** - Über Backend (AssemblyAI) in Text umwandeln
3. **Erkennt Sprecher** - Lokal mit Sherpa-ONNX neuronales Netzwerk
4. **Generiert Dokumentation** - KI-gestützte Zusammenfassung via Backend
5. **Kopiert in Zwischenablage** - Für direkte Übernahme in Praxisverwaltungssysteme (PVS)

### Statistiken

| Komponente | Lines of Code |
|------------|---------------|
| main.js (Hauptprozess) | 1.869 |
| apiClient.js | 396 |
| speaker-recognition/index.js | 439 |
| audioRecorder.js | 114 |
| audio-converter.js | 93 |
| voice-profiles.js | 188 |
| bausteine/index.js | 144 |
| **Gesamt JavaScript** | ~3.200 |

---

## Technologie-Stack

### Core Framework
- **Electron 28.0.0** - Cross-platform Desktop Framework
- **Node.js** - Backend Runtime

### Dependencies

| Package | Version | Zweck |
|---------|---------|-------|
| `electron` | 28.0.0 | Desktop-Framework |
| `electron-updater` | 6.7.3 | Auto-Update (GitHub Private Repo) |
| `electron-store` | 8.1.0 | Persistente JSON-Speicherung |
| `axios` | 1.6.2 | HTTP Client für API-Kommunikation |
| `sherpa-onnx-node` | 1.12.20 | Lokale Sprechererkennung (ONNX) |
| `fluent-ffmpeg` | 2.1.3 | Audio-Konvertierung |
| `ffmpeg-static` | 5.2.0 | Gebundelte FFmpeg Binary |
| `dotenv` | 16.3.1 | Umgebungsvariablen |

### Externe Services
- **Backend API** - Vercel (https://dentdoc-app.vercel.app/)
- **Transkription** - AssemblyAI (via Backend)
- **Auto-Update** - GitHub Releases (Private Repo)

---

## Dateistruktur

```
dentdoc-desktop/
├── main.js                           # Electron Hauptprozess (1.869 Zeilen)
├── package.json                      # App-Konfiguration & Build-Config
├── .env                              # Produktions-API-URL
├── .env.local                        # Lokale Entwicklungs-Overrides
│
├── src/
│   ├── apiClient.js                  # Backend-Kommunikation (396 Zeilen)
│   ├── audioRecorder.js              # Mikrofon-Aufnahme (114 Zeilen)
│   ├── audio-converter.js            # FFmpeg WAV-Konvertierung (93 Zeilen)
│   │
│   ├── speaker-recognition/
│   │   ├── index.js                  # Sherpa-ONNX Integration (439 Zeilen)
│   │   └── voice-profiles.js         # Stimmprofil-Verwaltung (188 Zeilen)
│   │
│   ├── bausteine/
│   │   ├── index.js                  # Bausteine-Manager (144 Zeilen)
│   │   └── defaults.js               # Standard-Bausteine (55 Zeilen)
│   │
│   ├── login.html                    # Login-Fenster UI
│   ├── settings.html                 # Einstellungen UI
│   ├── voice-profiles.html           # Stimmprofil-Verwaltung UI
│   ├── status-overlay.html           # Floating Status-Overlay UI
│   ├── recorder.html                 # Hidden Audio-Recorder Window
│   ├── feedback.html                 # Feedback-Formular UI
│   └── bausteine/bausteine.html      # Bausteine-Editor UI
│
├── models/
│   └── 3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx
│                                     # Speaker Recognition ML-Modell
│
└── assets/
    ├── icon.png                      # App-Icon
    ├── tray-icon.png                 # System-Tray Icon (normal)
    └── tray-icon-recording.png       # System-Tray Icon (Aufnahme aktiv)
```

---

## Hauptprozess (main.js)

Der Hauptprozess ist das "Gehirn" der Anwendung mit 1.869 Zeilen Code.

### Globale State-Variablen

```javascript
let isRecording = false;           // Aufnahme aktiv?
let isProcessing = false;          // Verarbeitung läuft?
let isEnrolling = false;           // Stimmprofil-Enrollment aktiv?
let currentRecordingPath = null;   // Pfad zur aktuellen WebM-Aufnahme
let lastDocumentation = null;      // Cache der letzten Dokumentation
let lastTranscript = null;         // Cache des letzten Transkripts
let heartbeatInterval = null;      // Session Keep-Alive Timer
let statusOverlay = null;          // Floating Status-Fenster
let loginWindow = null;            // Login-Dialog
let dashboardWindow = null;        // Hauptfenster mit allen Views (Home, Settings, Profiles, Bausteine)
let tray = null;                   // System-Tray Icon
```

### Kern-Funktionen

#### `startRecording()` (Zeilen 795-860)

Startet die Audio-Aufnahme mit folgenden Checks:
- Prüft Auth-Token vorhanden
- Prüft ob nicht bereits Verarbeitung läuft
- Holt aktuelle User-Daten vom Backend (Subscription-Status)
- Zeigt Warnung wenn Trial fast abgelaufen (<10 Min)
- Blockiert wenn Trial/Subscription abgelaufen
- Startet `audioRecorder.startRecording(deleteAudio)`
- Aktualisiert Tray-Icon auf Recording-Status
- Zeigt Status-Overlay mit Shortcut-Hinweis

#### `stopRecording()` (Zeilen 862-892)

Stoppt die Aufnahme:
- Ruft `audioRecorder.stopRecording()` auf
- Leitet an `processAudioFile(currentRecordingPath)` weiter
- Wurde refactored von ~205 auf ~30 Zeilen

#### `processAudioFile(audioFilePath)` (Zeilen 609-793)

**Die wichtigste Funktion der App** - verarbeitet Audio zu Dokumentation:

```
Schritt 1: Audio Upload (Async mit Progress)
├── apiClient.uploadAudio(filePath, token, onProgress)
├── onProgress erhält: { phase: 'upload', percent: 0-100 }
├── Backend: file.upload() + transcripts.submit() (non-blocking)
├── Erhält transcriptionId sofort zurück
└── Status: "Audio wird gesendet... X%" → "Audio wird vorbereitet..."

Schritt 2: Status-Polling (Echtzeit von AssemblyAI)
├── apiClient.getTranscriptionStatus(id) - max 120 Versuche á 1 Sekunde
├── Backend pollt AssemblyAI API für echten Status
├── Status-Wechsel: queued → processing → completed
├── Bei completed: Backend speichert Transcript, deducts Minuten, GDPR-Löschung
└── Status: "Warte auf Verarbeitung..." → "Sprache wird erkannt..." → "Sprache erkannt"

Schritt 3: Sprecher erkennen
├── speakerRecognition.identifySpeakersFromUtterances()
├── Konvertiert WebM → 16kHz WAV
├── Erstellt Embeddings pro Sprecher
├── Vergleicht mit Stimmprofilen
└── Status: "Sprecher werden erkannt..."

Schritt 4: Speaker-Mapping speichern
├── apiClient.updateSpeakerMapping(id, mapping)
└── Speichert {"A": "Arzt - Dr. X", "B": "ZFA - Y"} im Backend

Schritt 5: Dokumentation generieren
├── Modus "single": apiClient.getDocumentation(id)
├── Modus "agent-chain": apiClient.getDocumentationV2(id, bausteine)
└── Status: "Dokumentation wird erstellt..."

Schritt 6: Post-Processing
├── clipboard.writeText(documentation)
├── saveTranscriptToFile() - wenn autoExport aktiv
├── Aktualisiert Tray-Menu mit frischen User-Daten
└── Status: "Fertig! In Zwischenablage kopiert"
```

#### `saveTranscriptToFile(basePath, summary, transcript, speakerMapping)` (Zeilen 268-340)

Speichert Transkript als formatierte Text-Datei:

**Dateiformat:**
```
╔════════════════════════════════════════════════════════════════════╗
║                          DENTDOC TRANSKRIPT                        ║
╚════════════════════════════════════════════════════════════════════╝

Datum:    15.01.2024
Uhrzeit:  14:30

────────────────────────────────────────────────────────────────────
  ZUSAMMENFASSUNG
────────────────────────────────────────────────────────────────────
[Generierte Dokumentation]

────────────────────────────────────────────────────────────────────
  VOLLSTÄNDIGES TRANSKRIPT
────────────────────────────────────────────────────────────────────
[Vollständiges Transkript mit Sprecherzuordnung]
```

**Ordner-Organisation:**
- Extrahiert Ärzte aus Speaker-Mapping (Format: "Arzt - Dr. Müller")
- Erstellt Ordner pro Arzt: `Transkripte/Dr. Müller/`
- Bei unbekanntem Arzt: `Transkripte/Ohne Zuordnung/`
- Dateiname: `YYYY-MM-DD_HH-MM_[ArztName].txt`

#### `selectAndTranscribeAudioFile()` (Zeilen 570-607)

Ermöglicht manuellen Upload bestehender Audio-Dateien:
- Öffnet Datei-Dialog
- Unterstützte Formate: WebM, WAV, MP3, M4A, OGG, FLAC, AAC
- Ruft danach `processAudioFile()` auf

### Fenster-Verwaltung

| Funktion | Zeilen | Beschreibung |
|----------|--------|--------------|
| `createLoginWindow()` | 342-363 | Frameless Dark-Theme Login (400x500) |
| `openSettings()` | 79-103 | Einstellungen-Fenster (950x600) |
| `openVoiceProfiles()` | 105-131 | Stimmprofil-Manager (650x750 min) |
| `openBausteine()` | 133-159 | Bausteine-Editor |
| `openFeedback()` | 161-185 | Feedback-Formular |
| `createStatusOverlay()` | 960-1048 | Floating Overlay (440x360, always-on-top) |

### Tray-Management

#### `createTray()` (Zeilen 365-408)

- Erstellt System-Tray Icon
- Registriert Click/Rightclick Handler
- Implementiert 10-Sekunden Cooldown für API-Refresh

#### `buildTrayMenu()` (Zeilen 411-563)

Dynamisches Menü basierend auf Status:

```
[Status-Anzeige] ← Klickbar wenn Trial abgelaufen
├── "✓ DentDoc Pro (2 PC's)" - Aktives Abo
├── "Testphase: 45 Min übrig" - Trial aktiv
├── "⚠️ KEIN AKTIVES ABO" - Ehemaliger Subscriber (rot)
└── "⚠️ TESTPHASE BEENDET" - Trial abgelaufen (rot)

[Upgrade zu Pro] ← Nur wenn nötig
─────────────────
Aufnahme starten (F9) / Aufnahme stoppen
Audio-Datei transkribieren...
Letzte Dokumentation anzeigen
─────────────────
Dashboard öffnen
Stimmprofile verwalten
Bausteine bearbeiten
Einstellungen
Feedback geben
─────────────────
Abmelden (user@email.com)
Beenden
```

### Keyboard Shortcuts

#### `registerShortcut(shortcut)` (Zeilen 187-220)

- Verwendet `globalShortcut.register()` von Electron
- Togglet zwischen Start/Stop Recording
- Standard: F9
- Validiert bei Registrierung
- Fallback auf alten Shortcut wenn neuer fehlschlägt

### Session-Management

#### `startHeartbeat()` (Zeilen 1243-1274)

- Sendet alle 5 Minuten Heartbeat an Backend
- Hält Device-Session aktiv
- Erkennt Remote-Logout (Device-Limit überschritten)
- Zeigt Notification wenn ausgeloggt

#### `refreshUserData()` (Zeilen 1277-1304)

- Aufgerufen beim Öffnen des Tray-Menüs (max 1x pro 10 Sek)
- Prüft auf Subscription-Änderungen
- Zeigt Celebration-Notification wenn User subscribed hat

---

## API Client (src/apiClient.js)

Backend-Kommunikationsschicht mit 396 Zeilen.

### Funktionen

| Funktion | Endpoint | Beschreibung |
|----------|----------|--------------|
| `login(email, password, store)` | POST /api/auth/login | Device-basierter Login |
| `logout(token, store)` | POST /api/auth/logout | Device-Slot freigeben |
| `heartbeat(token, store)` | POST /api/device/heartbeat | Session Keep-Alive (5 Min) |
| `getUser(token)` | GET /api/user | Subscription/Trial Status |
| `uploadAudio(filePath, token, onProgress)` | POST /api/transcriptions/upload | Async Upload mit Progress-Callback |
| `getTranscriptionStatus(id, token)` | GET /api/transcriptions/:id/status | Polling für AssemblyAI-Status |
| `getTranscription(id, token)` | GET /api/transcriptions/:id | Transkription abrufen |
| `getDocumentation(id, token)` | POST /api/.../generate-doc | Single-Prompt Dokumentation |
| `getDocumentationV2(id, token, bausteine)` | POST /api/.../generate-doc-v2 | Agent-Chain mit Bausteinen |
| `updateSpeakerMapping(id, mapping, token)` | POST /api/.../update-speakers | Speaker-IDs speichern |
| `submitFeedback(token, category, message)` | POST /api/feedback | Feedback senden |

### Async Upload & Status-Polling

Der Upload-Prozess ist asynchron mit Echtzeit-Fortschritt:

```javascript
// 1. Upload mit Progress-Callback (0-50% der Gesamtanzeige)
const onProgress = (info) => {
  // info.phase: 'upload' | 'submitted'
  // info.percent: 0-100 für Upload-Phase
  // info.message: Status-Text
};
const transcriptionId = await uploadAudio(filePath, token, onProgress);

// 2. Polling für AssemblyAI-Status (50-100% der Gesamtanzeige)
let status = await getTranscriptionStatus(transcriptionId, token);
// status.status: 'queued' | 'processing' | 'completed' | 'error'
// status.transcriptText: Verfügbar bei 'completed'
// status.utterances: Verfügbar bei 'completed'
```

**Benutzerfreundliche Status-Meldungen:**
| API-Status | Angezeigte Meldung |
|------------|-------------------|
| Upload 0-50% | "Audio wird gesendet... X%" |
| Upload 50%+ | "Audio wird vorbereitet..." |
| submitted | "Audio übermittelt" |
| queued | "Warte auf Verarbeitung..." |
| processing | "Sprache wird erkannt..." |
| completed | "Sprache erkannt" |

### Device Tracking

```javascript
// Generiert eindeutige Device-ID beim ersten Login
const deviceId = crypto.randomUUID();

// Sendet Device-Info mit
{
  deviceId: "uuid",
  os: "win32",
  hostname: "WORKSTATION",
  arch: "x64"
}
```

### Fehlerbehandlung

- `trial_expired` → Trial abgelaufen
- `subscription_inactive` → Abo nicht aktiv
- Max-Device-Limit Fehler mit spezifischer Nachricht
- Dateigrößen-Validierung (min 5KB für Uploads)
- Netzwerk-Fehler Handling

---

## Audio-Aufnahme (src/audioRecorder.js + src/recorder.html)

Audio-Aufnahme via WebRTC mit robuster Fallback-Kaskade.

### Warum WebRTC statt FFmpeg?

| Aspekt | WebRTC | FFmpeg |
|--------|--------|--------|
| WASAPI Support | ✅ Ja (intern) | ❌ Nur mit Full-Build (~90MB) |
| USB-Hub Kompatibilität | ✅ Mit Fallbacks | ✅ Ja |
| Wireless Headsets | ✅ Ja | ❌ Nicht mit ffmpeg-static |
| Zusätzliche Binaries | Keine | ffmpeg.exe nötig |

**Entscheidung:** WebRTC nutzt intern WASAPI shared mode, was sowohl USB-Hubs als auch kabellose Headsets unterstützt.

### Architektur

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   main.js       │────▶│  audioRecorder.js │────▶│  recorder.html  │
│                 │     │                  │     │  (Hidden Window) │
│  store.get      │     │  startRecording  │     │                 │
│ ('microphoneId')│     │  (deviceId)      │     │  WebRTC API     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Audio-Spezifikationen

| Parameter | Wert |
|-----------|------|
| Format | WebM + Opus |
| Kanäle | 1 (Mono) |
| Sample Rate | 16kHz (ideal) |
| Echo Cancellation | Aktiviert |
| Noise Suppression | Aktiviert |

### Robuste Fallback-Kaskade (recorder.html)

Die `getAudioStream(savedDeviceId)` Funktion versucht 4 Methoden nacheinander:

```javascript
async function getAudioStream(savedDeviceId) {
  // 300ms Verzögerung für USB-Geräte (USB-Hubs brauchen Zeit)
  await new Promise(r => setTimeout(r, 300));

  // Prüfe ob gespeichertes Gerät noch existiert
  const savedDeviceExists = devices.some(d => d.deviceId === savedDeviceId);

  // Versuch 1: Gespeichertes Gerät (exact constraint)
  if (savedDeviceExists) {
    stream = await getUserMedia({ deviceId: { exact: savedDeviceId } });
  }

  // Versuch 2: Gespeichertes Gerät (ideal/preferred - weniger strikt)
  if (savedDeviceId) {
    stream = await getUserMedia({ deviceId: { ideal: savedDeviceId } });
  }

  // Versuch 3: Standard-Gerät mit Audio-Constraints
  stream = await getUserMedia({
    audio: { channelCount: 1, sampleRate: { ideal: 16000 }, ... }
  });

  // Versuch 4: Beliebiges Audio-Gerät (minimal)
  stream = await getUserMedia({ audio: true });
}
```

**Warum diese Reihenfolge:**
1. **Exact**: Nutzt exakt das vom User gewählte Gerät
2. **Ideal**: Falls Device-ID sich geändert hat (USB-Reconnect), versucht Chromium ähnliches Gerät
3. **Default mit Constraints**: System-Standardgerät mit optimalen Audio-Einstellungen
4. **Minimal**: Letzte Rettung - irgendein funktionierendes Mikrofon

### Funktionen (audioRecorder.js)

| Funktion | Beschreibung |
|----------|--------------|
| `startRecording(deleteAudio, deviceId)` | Startet Aufnahme, sendet deviceId an recorder.html |
| `stopRecording()` | Stoppt, empfängt Blob via IPC, speichert als WebM |
| `isRecording()` | Prüft ob Aufnahme aktiv |
| `cleanupOldRecordings(tempDir)` | Löscht alte Aufnahmen wenn aktiviert |

### IPC-Kommunikation (recorder.html)

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `start-recording` | Main → Renderer | Startet mit `{ deviceId }` |
| `stop-recording` | Main → Renderer | Stoppt MediaRecorder |
| `recording-started` | Renderer → Main | Bestätigung dass Aufnahme läuft |
| `recording-data` | Renderer → Main | Audio-Blob als Uint8Array |
| `recording-error` | Renderer → Main | Fehlermeldung |
| `audio-level-update` | Renderer → Main | Pegel für VU-Meter (0-1) |

### Einstellungs-Flow

```
SPEICHERN (Dashboard/Setup-Wizard):
  navigator.mediaDevices.enumerateDevices()
  → User wählt Mikrofon (deviceId = Browser-ID)
  → ipcRenderer.invoke('save-settings', { microphoneId })
  → main.js: store.set('microphoneId', ...)

AUFNAHME:
  F9 gedrückt
  → main.js: microphoneId = store.get('microphoneId')
  → audioRecorder.startRecording(deleteAudio, microphoneId)
  → recorder.html: getAudioStream(savedDeviceId)
  → 4-stufige Fallback-Kaskade
  → MediaRecorder → .webm Datei
```

### Alternative: FFmpeg-Recorder (nicht aktiv)

Die Datei `src/audioRecorderFFmpeg.js` existiert als Alternative, wird aber **nicht verwendet**.

Sie wäre nur relevant wenn:
- Ein vollständiger FFmpeg-Build mit WASAPI in `bin/ffmpeg.exe` liegt
- WebRTC aus irgendeinem Grund nicht funktioniert

**Aktueller Import in main.js:**
```javascript
const audioRecorder = require('./src/audioRecorder');  // WebRTC
// NICHT: require('./src/audioRecorderFFmpeg');        // FFmpeg
```

---

## Mikrofon-Test (Realistischer Test mit Wiedergabe)

Der Mikrofon-Test in Settings und Setup-Wizard verwendet die **echte Recorder-Logik** statt einer vereinfachten getUserMedia-Prüfung. So kann der User die tatsächliche Aufnahmequalität beurteilen.

### Architektur

```
┌─────────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Dashboard/Wizard   │────▶│    main.js      │────▶│  audioRecorder   │
│  (Frontend)         │     │  IPC Handlers   │     │  (recorder.html) │
└─────────────────────┘     └─────────────────┘     └──────────────────┘
         │                          │                        │
         │  start-mic-test          │  startRecording()      │
         │  ◄─────────────────────  │  ◄─────────────────    │
         │                          │                        │
         │  audio-level-update      │                        │
         │  ◄─────────────────────  │  ◄─────────────────    │
         │  (Echtzeit-Pegel)        │                        │
         │                          │                        │
         │  stop-mic-test           │  stopRecording()       │
         │  ◄─────────────────────  │  ◄─────────────────    │
         │                          │                        │
         │  get-mic-test-audio      │  fs.readFileSync()     │
         │  ◄─────────────────────  │                        │
         │  (Base64 für Playback)   │                        │
         │                          │                        │
         │  cleanup-mic-test        │  fs.unlinkSync()       │
         │  ◄─────────────────────  │                        │
```

### IPC-Handler (main.js)

| Handler | Beschreibung |
|---------|--------------|
| `start-mic-test` | Startet echte Aufnahme mit deviceId, räumt vorherige Test-Datei auf |
| `stop-mic-test` | Stoppt Aufnahme, gibt Dateipfad zurück (robust bei bereits gestoppter Aufnahme) |
| `get-mic-test-audio` | Liest Audio-Datei und gibt Base64 + MIME-Type für Browser-Playback zurück |
| `cleanup-mic-test` | Löscht Test-Audio-Datei |

### Audio-Level Weiterleitung

Das `audio-level-update` Event wird vom Recorder-Window an Main gesendet und von dort an **beide** Fenster weitergeleitet:

```javascript
// main.js
ipcMain.on('audio-level-update', (event, level) => {
  // An Status-Overlay (für normale Aufnahme)
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.webContents.send('audio-level', level);
  }
  // An Dashboard (für Mic-Test)
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('audio-level-update', level);
  }
});
```

### Ablauf im Frontend

```
1. User klickt "Mikrofon testen (5 Sek.)"
   │
   ▼
2. ipcRenderer.invoke('start-mic-test', deviceId)
   │  → Startet echte Aufnahme mit 4-stufiger Fallback-Kaskade
   │  → Alte Test-Datei wird gelöscht
   │
   ▼
3. Level-Meter wird aktualisiert (audio-level-update Events)
   │  → Zeigt Echtzeit-Pegel während Aufnahme
   │
   ▼
4. Nach 5 Sekunden: Auto-Stop
   │  → ipcRenderer.invoke('stop-mic-test')
   │  → WebM-Datei wird in %TEMP%/dentdoc/ gespeichert
   │
   ▼
5. Playback-Button erscheint ("Anhören")
   │
   ▼
6. User klickt "Anhören"
   │  → ipcRenderer.invoke('get-mic-test-audio')
   │  → Audio als Base64 empfangen
   │  → Wiedergabe über <audio> Element
   │
   ▼
7. Cleanup bei:
   │  → Neuem Test (automatisch)
   │  → View-Wechsel (Settings verlassen)
   │  → Wizard schließen
   │  → App beenden
```

### Cleanup-Strategie

Die Test-Audio-Datei wird automatisch aufgeräumt:

| Trigger | Aktion |
|---------|--------|
| Neuer Test gestartet | `cleanupMicTestFile()` vor Start |
| Settings View verlassen | `ipcRenderer.invoke('cleanup-mic-test')` |
| Setup-Wizard schließen | `ipcRenderer.invoke('cleanup-mic-test')` |
| App beenden | `cleanupMicTestFile()` in `will-quit` Event |

### Robustheit bei Race-Conditions

Da die Aufnahme asynchron ist, kann es zu Race-Conditions kommen (z.B. Aufnahme bereits gestoppt bevor `stop-mic-test` aufgerufen wird). Diese werden behandelt:

```javascript
// audioRecorder.js - stopRecording()
if (!recordingStarted) {
  // Aufnahme bereits gestoppt - vorhandene Datei zurückgeben
  if (currentFilePath && fs.existsSync(currentFilePath)) {
    resolve(currentFilePath);
    return;
  }
}

// main.js - stop-mic-test Handler
catch (error) {
  // Fallback: Wenn Datei existiert, trotzdem Erfolg melden
  if (micTestPath && fs.existsSync(micTestPath)) {
    return { success: true, path: micTestPath };
  }
}
```

### Unterschied zum alten Mic-Test

| Aspekt | Alt (vor v1.4.2) | Neu (ab v1.4.2) |
|--------|------------------|-----------------|
| Audio-Quelle | `getUserMedia({ audio: true })` | Echter Recorder mit Fallback-Kaskade |
| Audio-Constraints | Minimal | Vollständig (16kHz, Mono, Echo/Noise Cancellation) |
| Aufnahme | Keine | 5 Sek. WebM-Datei |
| Wiedergabe | Nicht möglich | "Anhören"-Button mit Audio-Playback |
| Qualitätsprüfung | Nur Pegel-Anzeige | Tatsächliche Aufnahmequalität hörbar |
| Device-Fallback | Keiner | 4-stufige Fallback-Kaskade |

---

## Audio-Konvertierung (src/audio-converter.js)

FFmpeg-Wrapper für Format-Konvertierung mit 93 Zeilen.

### Funktionen

| Funktion | Beschreibung |
|----------|--------------|
| `convertToWav16k(inputPath, outputPath)` | Konvertiert zu 16kHz WAV |
| `convertAndReplace(webmPath)` | Konvertiert und gibt WAV-Pfad zurück |

### FFmpeg-Befehl

```bash
ffmpeg -i input.webm -ar 16000 -ac 1 -acodec pcm_s16le -f wav output_16k.wav
```

### Pfad-Auflösung

```javascript
// Produktion (verpackt)
app.asar.unpacked/node_modules/ffmpeg-static/

// Entwicklung
node_modules/ffmpeg-static/
```

---

## Speaker Recognition

Lokale Sprechererkennung mit Sherpa-ONNX (439 Zeilen).

### ML-Modell

| Parameter | Wert |
|-----------|------|
| Modell | `3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx` |
| Framework | ONNX Runtime via `sherpa-onnx-node` |
| Embedding-Größe | 512 Dimensionen |
| Threshold | 0.7 (70% Ähnlichkeit) |

### Kern-Funktionen

#### `initialize()` (Zeilen 42-96)

```javascript
// Erstellt SpeakerEmbeddingExtractor
// Erkennt Modell-Pfad (Produktion/Entwicklung)
// Konfiguration: CPU-Provider, 2 Threads, Debug-Modus
```

#### `extractAudioSegment(audioPath, startMs, durationMs)` (Zeilen 107-158)

**Performance-optimiert:** Liest nur benötigte Bytes

```javascript
// Vorher: Komplette Datei laden (z.B. 57MB)
const buffer = fs.readFileSync(audioPath);

// Nachher: Nur Header + benötigtes Segment
const fd = fs.openSync(audioPath, 'r');
fs.readSync(fd, headerBuffer, 0, 44, 0);        // WAV Header
fs.readSync(fd, audioBuffer, 0, length, offset); // Nur Segment
```

- Reduziert I/O von 2.5GB auf ~1MB bei langen Aufnahmen
- Validiert Sample Rate (muss 16kHz sein)
- Gibt Float32Array zurück (normalisiert auf [-1, 1])

#### `createEmbedding(audioPath, startMs, durationMs)` (Zeilen 160-199)

- Extrahiert Audio-Segment
- Speist in Sherpa-ONNX Stream
- Gibt 512-dimensionalen Embedding-Vektor zurück

#### `identifySpeakersFromUtterances(audioPath, utterances)` (Zeilen 276-390)

**Hauptfunktion** - Identifiziert alle Sprecher in Aufnahme

**Input:**
```javascript
utterances = [
  { speaker: "A", start: 0, end: 3000, text: "Hallo..." },
  { speaker: "B", start: 3000, end: 5000, text: "Guten Tag..." }
]
```

**Ablauf:**
```
1. Konvertiere WebM/MP3 → 16kHz WAV (falls nötig)
2. Gruppiere Utterances nach Speaker-Label
   ├── Speaker A: [0-3s, 5-8s, 10-12s]
   ├── Speaker B: [3-5s, 8-10s]
   └── Speaker C: [12-15s]
3. Für jeden Speaker: Sammle Segmente (max 30 Sek total)
4. Erstelle Embedding pro Speaker
5. Vergleiche mit allen Profilen (cosine similarity)
6. Match wenn Similarity >= 0.7
```

**Output:**
```javascript
{
  "A": "Arzt - Dr. Müller",
  "B": "ZFA - Maria",
  "C": "Sprecher C"  // Nicht erkannt
}
```

#### `enrollSpeaker(name, audioPath, role)` (Zeilen 392-420)

- Registriert neues Stimmprofil
- Verwendet erste 30 Sekunden Audio
- Speichert Embedding + Metadaten

#### `cosineSimilarity(embedding1, embedding2)` (Zeilen 200-230)

```javascript
// Berechnet: dot_product / (norm1 * norm2)
// Rückgabe: 0.0 - 1.0 (1.0 = identischer Sprecher)
```

### Debug-Logging

- Schreibt Details nach `%TEMP%/dentdoc-debug.log`
- Loggt Similarity-Scores für Debugging

---

## Stimmprofile (src/speaker-recognition/voice-profiles.js)

Persistente Stimmprofil-Speicherung mit 188 Zeilen.

### Speicherort

- Standard: `AppData/Roaming/[app-name]/voice-profiles.json`
- Konfigurierbar: Netzwerk-Ordner via Einstellungen

### Funktionen

| Funktion | Beschreibung |
|----------|--------------|
| `getAllProfiles()` | Gibt Array mit geparsten Embeddings zurück |
| `saveProfile(name, embedding, role)` | Erstellt neues Profil mit UUID |
| `deleteProfile(id)` | Entfernt Profil |
| `updateProfile(id, updates)` | Aktualisiert bestehendes Profil |
| `setStorePath(customPath)` | Wechselt Speicherort |
| `getStorePath()` | Gibt aktuellen Pfad zurück |

### Profil-Struktur

```json
{
  "id": "1705320600000",
  "name": "Dr. Müller",
  "role": "Arzt",
  "embedding": "[0.123, -0.456, ...]",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

**Hinweis:** Embedding wird als JSON-String gespeichert und beim Laden geparst.

---

## Bausteine-System

Dokumentations-Bausteine für wiederkehrende Texte (144 + 55 Zeilen).

### Zweck

Verwaltet wiederverwendbare Dokumentationsvorlagen mit kategorie-spezifischen Standardtexten für die Agent-Chain Dokumentationsgenerierung.

### Standard-Bausteine (defaults.js)

| Kategorie | Name | Keywords |
|-----------|------|----------|
| `FUELLUNG` | Füllungstherapie | füllung, karies, komposit |
| `ZE_BERATUNG` | Zahnersatz-Beratung | zahnersatz, krone, implantat |
| `EXTRAKTION` | Extraktion | ziehen, entfernen, weisheitszahn |
| `PZR` | Professionelle Zahnreinigung | zahnreinigung, prophylaxe, politur |
| `WKB` | Wurzelbehandlung | wurzelbehandlung, wkb, endo |
| `PA` | Parodontitis | parodontitis, zahnfleisch, taschen |
| `KONTROLLE` | Kontrolluntersuchung | kontrolle, check, recall |
| `SCHMERZBEHANDLUNG` | Schmerzbehandlung | schmerzen, akut, notfall |

### Baustein-Struktur

```json
{
  "FUELLUNG": {
    "name": "Füllungstherapie",
    "standardText": "Patient wurde über Materialalternativen (Kunststoff, Keramik, Amalgam) aufgeklärt...",
    "keywords": ["füllung", "karies", "loch", "komposit"]
  }
}
```

### Funktionen (index.js)

| Funktion | Beschreibung |
|----------|--------------|
| `getAllBausteine()` | Gibt merged custom + defaults zurück |
| `saveBaustein(kategorie, baustein)` | Überschreibt einzelnen Default |
| `saveAllBausteine(bausteine)` | Ersetzt alle Bausteine |
| `resetBaustein(kategorie)` | Löscht Custom, nutzt Default |
| `resetAllBausteine()` | Setzt alle zurück |
| `isCustomBaustein(kategorie)` | Prüft ob überschrieben |
| `exportBausteine()` | JSON-Export für Backup |
| `importBausteine(json)` | Import mit Validierung |

---

## Benutzeroberflächen

### login.html

- Dark-Theme modernes Login-Formular
- Frameless Window mit Custom Titlebar (Minimieren/Schließen)
- Email + Passwort Felder
- Loading-State & Fehler-Anzeige
- Max-Devices Fehler mit spezifischer Nachricht

### settings.html

- Mikrofon-Auswahl (Device Dropdown)
- Hotkey-Recorder mit Global-Shortcut Deaktivierung
- Transkript-Speicherpfad (mit Ordner-Browser)
- Stimmprofile-Pfad (mit Ordner-Browser)
- Auto-Export Toggle
- Auto-Close Overlay Toggle
- Audio nach Verarbeitung löschen Toggle
- Dokumentations-Modus Auswahl (single vs agent-chain)
- Debug-Log Viewer
- Sound-Einstellungen Link

### status-overlay.html

Floating, always-on-top Fenster:

| Zustand | Anzeige |
|---------|---------|
| Recording | Animiertes Mikrofon-Icon + Waveform + Stop-Button |
| Processing | Spinner mit Schritt-Zähler (1/4, 2/4...) |
| Success | Doku + Transkript Preview mit Copy-Buttons |
| Error | Fehlermeldung mit Close-Button |

- Draggable, Position wird gespeichert
- Fehler auto-hide nach 5 Sek
- Erfolg auto-hide nach 3 Sek (wenn aktiviert)

#### Dynamische Fenstergröße & Click-Through

Das Status-Overlay passt seine Größe dynamisch an den Inhalt an (Recording-Status ist kleiner als Success-Status mit Buttons). Dies verhindert, dass unsichtbare Bereiche unterhalb des Fensters Mausklicks blockieren.

**Lösung für Click-Blocking Problem:**
```javascript
// In status-overlay.html - resizeWindowToFit()
// Wird mehrfach nach Status-Updates aufgerufen (10ms, 50ms, 150ms)
// um sicherzustellen, dass das Fenster exakt auf den Container passt
ipcRenderer.send('resize-status-overlay', width, height);
```

**Drag-Handle über gesamtes Fenster:**
Das Fenster ist überall verschiebbar durch einen Drag-Handle, der das gesamte Fenster abdeckt aber hinter den interaktiven Elementen liegt:

```css
/* Drag-Handle im Hintergrund (z-index: 0) */
.drag-handle {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  -webkit-app-region: drag;
  z-index: 0;
}

/* Interaktive Elemente darüber (z-index: 1) */
.header, .actions, .progress-container, .shortening-section {
  position: relative;
  z-index: 1;
}

/* Buttons explizit no-drag */
.close-btn, .action-btn, .shortening-btn {
  -webkit-app-region: no-drag;
}
```

So ist das Fenster überall verschiebbar, aber Buttons bleiben klickbar.

### voice-profiles.html

- Zwei-Spalten Layout: bestehende Profile | Enrollment-Form
- Liste mit Delete-Buttons
- Start/Stop Recording für Enrollment
- Name + Rolle Selector (Arzt/ZFA)
- Settings-Button für Speicherpfad

### bausteine.html

- Liste aller 8 Standard-Kategorien
- Visueller Indikator: grün = Default, blau = Custom
- Edit-Dialog pro Baustein (Name, Standardtext, Keywords)
- Reset einzeln / Reset alle Buttons
- Import/Export JSON

### recorder.html

- **Verstecktes** Renderer-Window für Audio-Capture
- Verwendet `navigator.mediaDevices.getUserMedia()`
- WebM + Opus mit Noise Suppression
- Sendet Audio-Chunks via IPC als Blob
- Analysiert Frequenz-Daten für Level-Meter

### feedback.html

- Kategorie Dropdown (Bug Report, Feature Request, Sonstiges)
- Message Textarea
- Submit-Button mit Loading-State
- Erfolg/Fehler Anzeige

---

## IPC-Kommunikation

Inter-Process Communication zwischen Main und Renderer.

### Authentifizierung

| Handler | Beschreibung |
|---------|--------------|
| `login` | Ruft `apiClient.login()`, speichert Token/User, startet Heartbeat |
| `logout` | Ruft `apiClient.logout()`, löscht Daten, stoppt Heartbeat |

### Einstellungen

| Handler | Beschreibung |
|---------|--------------|
| `get-settings` | Gibt aktuelle Settings zurück |
| `save-settings` | Validiert, speichert, registriert Shortcut |

### Stimmprofile

| Handler | Beschreibung |
|---------|--------------|
| `get-voice-profiles` | Gibt alle Profile zurück |
| `start-voice-enrollment` | Startet Aufnahme für neues Profil |
| `stop-voice-enrollment` | Speichert Profil aus Aufnahme |
| `cancel-voice-enrollment` | Verwirft Aufnahme |
| `delete-voice-profile` | Entfernt Profil |

### Bausteine

| Handler | Beschreibung |
|---------|--------------|
| `get-bausteine` | Gibt aktuelle + Defaults zurück |
| `save-bausteine` | Speichert Custom-Bausteine |
| `reset-baustein` | Setzt einzelnen zurück |
| `reset-all-bausteine` | Löscht alle Anpassungen |
| `import-bausteine` | Lädt aus JSON |
| `export-bausteine` | Exportiert zu JSON |

### Utilities

| Handler | Beschreibung |
|---------|--------------|
| `copy-to-clipboard` | Kopiert Text |
| `select-folder` | Öffnet Ordner-Picker |
| `open-folder` | Öffnet in Windows Explorer |
| `open-sound-settings` | Öffnet Windows Sound-Config |
| `open-debug-log` | Öffnet Debug-Log |
| `get-debug-log-path` | Gibt Debug-Log Pfad zurück |
| `submit-feedback` | Sendet Feedback ans Backend |

### Global Shortcut Kontrolle

| Handler | Beschreibung |
|---------|--------------|
| `disable-global-shortcut` | Deaktiviert während Settings-Aufnahme |
| `enable-global-shortcut` | Reaktiviert nach Settings |

---

## Datenfluss & Ablaufdiagramme

### Kompletter Aufnahme → Dokumentation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. USER DRÜCKT F9 (Hotkey)                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. startRecording()                                         │
│    • Token & Subscription validieren                        │
│    • audioRecorder.startRecording()                         │
│    • WebM nach %TEMP%/dentdoc/recording-{ts}.webm          │
│    • Status-Overlay: "Aufnahme läuft..."                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
        [User spricht während Behandlung]
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. USER DRÜCKT F9 ERNEUT                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. stopRecording() → processAudioFile(webmPath)            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 5a. apiClient.uploadAudio(filePath, token, onProgress)     │
│    POST /api/transcriptions/upload                          │
│    • Desktop → Vercel: Progress 0-50%                       │
│    • Vercel → AssemblyAI: file.upload() + transcripts.submit()
│    • Kehrt sofort mit transcriptionId zurück (non-blocking) │
│    Status: "Audio wird gesendet..." → "Audio wird vorbereitet..."
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 5b. apiClient.getTranscriptionStatus(id) [Polling]         │
│    GET /api/transcriptions/:id/status                       │
│    Max 120 Versuche, 1 Sek Intervall                       │
│    Backend pollt AssemblyAI für echten Status               │
│    • queued → "Warte auf Verarbeitung..."                   │
│    • processing → "Sprache wird erkannt..."                 │
│    • completed → "Sprache erkannt"                          │
│    Bei completed: DB-Update, Minuten-Abzug, GDPR-Löschung  │
│    → { status, transcriptText, utterances }                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. speakerRecognition.identifySpeakersFromUtterances()     │
│    • WebM → 16kHz WAV konvertieren                         │
│    • Segmente pro Speaker extrahieren (max 30s)            │
│    • 512-dim Embeddings erstellen                          │
│    • Mit Profilen vergleichen (Similarity >= 0.7)          │
│    → {"A": "Arzt - Dr. X", "B": "ZFA - Y"}                 │
│    Status: "Sprecher werden erkannt..."                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. apiClient.updateSpeakerMapping(id, mapping)             │
│    POST /api/transcriptions/:id/update-speakers            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Dokumentation generieren                                 │
│    • single: apiClient.getDocumentation(id)                │
│    • agent-chain: apiClient.getDocumentationV2(id, bausteine)
│    Status: "Dokumentation wird erstellt..."               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 9. Post-Processing                                          │
│    • clipboard.writeText(documentation)                     │
│    • saveTranscriptToFile()                                │
│    • Tray-Menu aktualisieren                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 10. Erfolgs-Overlay                                         │
│    "Fertig! Dokumentation in Zwischenablage kopiert"       │
│    → User drückt Ctrl+V im PVS                             │
└─────────────────────────────────────────────────────────────┘
```

### Speaker Recognition Detail-Ablauf

```
INPUT: audioPath (WebM), utterances ([{speaker: "A", start: 0, end: 3000}])
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ Falls nicht WAV: convertToWav16k()                       │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ Gruppiere Utterances nach Speaker                        │
│   ├── Speaker A: [0-3s, 5-8s, 10-12s]                   │
│   ├── Speaker B: [3-5s, 8-10s]                          │
│   └── Speaker C: [12-15s]                               │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ Für jeden Speaker:                                       │
│   • Sammle Segmente bis max 30 Sekunden                 │
│   • extractAudioSegment() für jedes Segment             │
│   • Concatenate Audio-Daten                             │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ createEmbedding() → 512-dim Vektor pro Speaker          │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ Lade alle Stimmprofile aus Storage                       │
└──────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ Für jedes Profil:                                        │
│   cosineSimilarity(embedding, profil.embedding)         │
│   Match wenn Similarity >= 0.7                          │
└──────────────────────────────────────────────────────────┘
   │
   ▼
OUTPUT: {"A": "Arzt - Dr. Müller", "B": "ZFA - Maria", "C": "Sprecher C"}
```

---

## Speicherung & Persistenz

### electron-store Speicherorte

**Windows AppData:**
```
%APPDATA%/com.dentdoc.desktop/
├── config.json              # Einstellungen
├── voice-profiles.json      # Stimmprofile (Standard)
└── bausteine.json           # Custom Bausteine
```

**Konfigurierbare Pfade:**
```
Documents/DentDoc/
├── Transkripte/             # Gespeicherte Transkripte
│   ├── Dr. Müller/
│   │   └── 2024-01-15_14-30_Dr_Müller.txt
│   └── Ohne Zuordnung/
└── Stimmprofile/            # Netzwerk-Stimmprofile (optional)
    └── voice-profiles.json
```

**Temporäre Dateien:**
```
%TEMP%/dentdoc/
├── recording-{timestamp}.webm      # Aktuelle WebM Aufnahme
├── recording-{timestamp}_16k.wav   # Konvertierte 16kHz WAV
└── dentdoc-debug.log              # Speaker Recognition Log
```

### Einstellungen (electron-store Keys)

| Key | Typ | Default | Beschreibung |
|-----|-----|---------|--------------|
| `authToken` | string | - | JWT Authentication Token |
| `user` | object | - | User-Daten (Email, Subscription, Minuten) |
| `shortcut` | string | "F9" | Globaler Recording Hotkey |
| `microphoneId` | string | null | Ausgewähltes Mikrofon Device ID |
| `transcriptPath` | string | Documents/DentDoc/Transkripte | Transkript-Speicherort |
| `profilesPath` | string | Documents/DentDoc/Stimmprofile | Stimmprofile-Speicherort |
| `autoExport` | boolean | true | Automatisch Transkripte speichern |
| `autoCloseOverlay` | boolean | false | Overlay nach Erfolg schließen |
| `deleteAudio` | boolean | true | Temp-Aufnahmen löschen |
| `docMode` | string | "single" | "single" oder "agent-chain" |
| `overlayPosition` | {x, y} | - | Overlay-Position (screen-spezifisch) |
| `deviceId` | string | UUID | Eindeutige Geräte-ID |

---

## Auto-Update System

### Konfiguration (electron-updater)

```javascript
{
  provider: 'github',
  owner: 'Rickpeace',
  repo: 'dentdoc-desktop',
  private: true,
  token: process.env.GITHUB_TOKEN
}
```

### Verhalten

1. Prüft auf Updates beim App-Start
2. Prüft erneut alle 4 Stunden
3. Download im Hintergrund
4. Notification wenn bereit
5. User kann sofort oder später installieren
6. Auto-Update beim nächsten Start

---

## Subscription & Trial-Logik

### User States vom Backend

```javascript
{
  planTier: "free_trial" | "pro" | null,
  subscriptionStatus: "active" | "canceled" | null,
  minutesRemaining: number,  // Für Trial
  stripeCustomerId: string,  // Falls je bezahlt
  maxDevices: number         // Pro Plan
}
```

### Status-Bestimmung

```javascript
const hasActiveSubscription = user?.subscriptionStatus === 'active';
const isCanceled = user?.subscriptionStatus === 'canceled';
const minutesRemaining = user?.minutesRemaining || 0;

// War zahlender Kunde (entweder cancelled oder trial mit Stripe ID)
const wasSubscriber = isCanceled ||
  (planTier === 'free_trial' && stripeCustomerId);

// Echter Trial (nie bezahlt)
const isRealTrial = planTier === 'free_trial' &&
  !wasSubscriber && minutesRemaining > 0;

// Trial beendet
const trialExpired = planTier === 'free_trial' &&
  !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

// Keine Aufnahme erlaubt wenn:
const noActiveSubscription = !hasActiveSubscription &&
  (trialExpired || wasSubscriber);
```

### Verhalten

| Status | Aufnahme | Tray-Anzeige |
|--------|----------|--------------|
| Pro Subscriber | ✅ Unbegrenzt | "✓ DentDoc Pro (2 PC's)" |
| Trial aktiv | ✅ X Min übrig | "Testphase: 45 Min übrig" |
| Trial niedrig (<10 Min) | ✅ Mit Warnung | Warning Notification |
| Trial abgelaufen | ❌ | "⚠️ TESTPHASE BEENDET" |
| Subscription cancelled | ❌ | "⚠️ KEIN AKTIVES ABO" |
| Max Devices | ❌ | Fehler-Dialog |

---

## Fehlerbehandlung

### Fehler-Kategorien in processAudioFile()

| Kategorie | Erkennung | Aktion |
|-----------|-----------|--------|
| Trial/Subscription | `TRIAL_EXPIRED:` / `SUBSCRIPTION_INACTIVE:` | Öffnet Subscription-Seite |
| Leere Aufnahme | `EMPTY_RECORDING` | "Aufnahme war zu kurz" |
| Keine Sprache | Leere Utterances | "Keine Sprache erkannt" |
| Netzwerk | Timeout/Connection refused | "Server nicht erreichbar" |
| Kein Guthaben | Balance-Check | "Kein Guthaben" + Dashboard |
| Verarbeitungs-Timeout | >180s Agent-Chain | "Verarbeitung dauert zu lange" |

### Fehler-Anzeige

- Overlay zeigt Titel + Detail-Nachricht
- Auto-Hide nach 5 Sekunden
- Manche öffnen Dashboard (Subscription)
- Alle werden in Debug-Dateien geloggt

---

## Sicherheit

### GitHub Token

- **Problem:** PAT im Production Build hardcodiert
- **Scope:** Limitiert auf Private Repo Releases
- **Risiko:** Token könnte aus App extrahiert werden
- **Empfehlung:** Environment Variable beim Build nutzen

### Device Tracking

- Eindeutige Device ID wird nach erstem Login persistiert
- Zweck: Device-Limits durchsetzen (z.B. 2 Geräte pro Pro Account)

### Audio-Daten

- **Lokal:** Speaker Recognition läuft komplett auf dem Gerät
- **API:** Audio wird über HTTPS zu Vercel übertragen
- **Embeddings:** Nur lokal gespeichert, nicht zum Server gesendet

### Credentials Storage

- Auth Token in electron-store (Datei-basiert, unverschlüsselt)
- Geschützt durch Windows Benutzer-Berechtigungen

---

## Build & Distribution

### Build-Prozess

```bash
npm run build:win
```

### Output

- NSIS Installer: `dist/DentDoc Setup X.X.X.exe`
- Installer-Optionen:
  - One-Click Install deaktiviert (erlaubt Custom-Pfad)
  - Desktop-Shortcut erstellen
  - Startmenü-Shortcuts erstellen

### Gebundelte Dateien

- `app.asar` - Komprimierter App-Code
- `app.asar.unpacked/` - FFmpeg, Sherpa Models
- Node Modules (axios, electron-store, etc.)

### Release-Workflow

1. Build Installer lokal
2. GitHub Release erstellen mit Installer
3. App prüft automatisch auf neue Releases
4. Auto-Download und Installation beim nächsten Start

---

## Changelog

### Version 1.4.2 (2025-01-15)

**Realistischer Mikrofon-Test mit Wiedergabe:**
- Mic-Test in Settings und Setup-Wizard verwendet jetzt echte Recorder-Logik
- 5-Sekunden Test-Aufnahme mit 4-stufiger Fallback-Kaskade
- Neuer "Anhören"-Button zur Wiedergabe der Test-Aufnahme
- Audio-Level-Weiterleitung an Dashboard für Echtzeit-Pegel-Anzeige
- Automatisches Cleanup der Test-Dateien bei View-Wechsel, Wizard-Schließen und App-Beenden
- Robuste Fehlerbehandlung bei Race-Conditions (bereits gestoppte Aufnahme)

**Technische Details:**
- Neue IPC-Handler: `start-mic-test`, `stop-mic-test`, `get-mic-test-audio`, `cleanup-mic-test`
- Audio-Playback über Base64-Encoding im Browser
- Test-Dateien in `%TEMP%/dentdoc/` mit automatischem Cleanup

### Version 1.4.1 (2025-01-15)

**Robuste Audio-Aufnahme mit WebRTC Fallback-Kaskade:**
- Neues `recorder.html` mit 4-stufiger Fallback-Strategie
- 300ms Verzögerung für USB-Hub Initialisierung
- Unterstützt sowohl USB-Hubs als auch kabellose Headsets
- Device-Existenz-Prüfung vor Aufnahmeversuch
- `audioRecorderFFmpeg.js` erstellt aber nicht aktiv (für zukünftige Nutzung)

**Hintergrund:**
- Problem: Mikrofon über USB-Hub funktionierte nicht zuverlässig
- Analyse: WebRTC nutzt intern WASAPI shared mode
- Lösung: Robuste Fallbacks statt FFmpeg (das WASAPI nur mit Full-Build unterstützt)

### Version 1.4.0 (2025-01-14)

**Direct AssemblyAI Upload:**
- Bypass Vercel 4.5MB Limit durch direkten Upload zu AssemblyAI
- UI-Verbesserungen

### Version 1.3.9 (2025-01-13)

**Network Folder Selection Fix:**
- Netzwerkordner-Auswahl für Transkript-Pfad korrigiert

### Version 1.3.2 (2025-01-09)

**Async Upload mit Echtzeit-Status-Feedback:**
- Upload-Prozess ist jetzt asynchron mit Progress-Callback
- Neuer `/api/transcriptions/:id/status` Endpoint für Polling
- Echte AssemblyAI-Status werden angezeigt (queued → processing → completed)
- Benutzerfreundliche deutsche Status-Meldungen statt technischer Terminologie
- Progress-Anzeige: 0-50% für Upload, 50-100% für Transkription

### Version 1.3.1 (2025-01-08)

**Auto-Update mit GitHub Token:**
- `electron-updater` für Private Repo konfiguriert
- Token-basierte Authentifizierung für Releases

### Version 1.3.0 (2025-01-08)

**Speaker Recognition Performance-Fix:**
- `extractAudioSegment()` optimiert auf File-Handle mit Seek
- Reduziert I/O von 2.5GB auf ~1MB bei langen Aufnahmen

**Code Refactoring:**
- `stopRecording()` vereinfacht (205 → 30 Zeilen)
- Unified `processAudioFile()` für Recording + manuellen Upload
- Bessere Fehler-Kategorisierung

**Bausteine-System:**
- 8 Standard-Kategorien für Zahnarzt-Dokumentation
- Import/Export Funktionalität
- Custom Overrides mit Reset-Option

**Feedback-System:**
- Neues Feedback-Formular
- Kategorien: Bug Report, Feature Request, Sonstiges

### Version 1.2.0

- Stimmprofile-Speicherung
- Arzt-basierte Transkript-Ordner
- UI-Verbesserungen

---

## Version

**Aktuelle Version:** 1.4.2
**Letztes Update dieser Dokumentation:** 2025-01-15
