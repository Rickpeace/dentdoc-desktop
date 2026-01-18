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
│   ├── vad-controller.js             # VAD Controller (Live-VAD Steuerung)
│   │
│   ├── vad/
│   │   └── vad-worker-thread.js      # VAD Worker mit Sherpa-ONNX Silero
│   │
│   ├── pipeline/
│   │   ├── index.js                  # VAD Pipeline (nur VAD + Render)
│   │   ├── offlineVad.js             # Offline-VAD für hochgeladene Dateien
│   │   └── speechRenderer.js         # VAD Segments → speech_only.wav
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
│   ├── 3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx
│   │                                 # Speaker Recognition ML-Modell
│   └── silero_vad.onnx               # VAD Modell (wird automatisch heruntergeladen)
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

### Dashboard Window Management

Das Dashboard wird beim App-Start **hidden** erstellt und bleibt im Hintergrund aktiv:

```javascript
// App-Start: Dashboard hidden erstellen
dashboardWindow = new BrowserWindow({
  show: false,  // Hidden!
  webPreferences: {
    backgroundThrottling: false  // Wichtig für Audio-Monitoring
  }
});
```

**Warum hidden statt on-demand?**
- Dashboard muss für F9-Audio-Monitoring verfügbar sein
- `backgroundThrottling: false` erlaubt JavaScript im Hintergrund
- Erspart ~1-2 Sekunden beim ersten Öffnen

**Window-Lifecycle:**
- Schließen (X-Button): Window wird nur **hidden**, nicht destroyed
- Tray-Click: Window wird **shown** (nicht neu erstellt)
- App-Quit: Window wird destroyed

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
  KÜRZUNGEN (nur bei v1.2 Hybrid-Modus)
────────────────────────────────────────────────────────────────────
── Stichworte (90% kürzer) ──
[...]

── Chef Ultra (70% kürzer) ──
[...]

── Chef (50% kürzer) ──
[...]

── PVS (40% kürzer) ──
[...]

── ZFA (30% kürzer) ──
[...]

── Normalisiert (sprachlich optimiert) ──
[...]

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

### Upload-Architektur (Railway Stream-Proxy)

Der Audio-Upload läuft über einen Railway Stream-Proxy, damit der AssemblyAI API-Key nicht im Desktop-Client exposed wird:

```
Desktop-App
    │
    └─► Railway Upload-Proxy (/upload)    ←── API-Key hier!
            │
            └─► AssemblyAI /v2/upload (STREAM)
                    │
                    └─► upload_url zurück

Desktop-App
    │
    └─► Vercel (/api/transcriptions/start)
            │
            └─► { upload_url, fileName }
```

**Wichtige Architektur-Prinzipien:**
- Railway ist ein **reiner Stream-Proxy** (kein Speichern, kein Buffer)
- Audio wird **direkt durchgestreamt** (kein RAM-Verbrauch)
- AssemblyAI API-Key bleibt auf Railway (DSGVO-sauber)
- Desktop sendet nur `UPLOAD_PROXY_TOKEN` zur Authentifizierung

**Railway Service (`railway-upload-proxy/`):**
| Datei | Zweck |
|-------|-------|
| `server.js` | Fastify Stream-Proxy |
| `package.json` | Node.js 18+, Fastify |

**Environment Variables (Railway):**
| Variable | Beschreibung |
|----------|--------------|
| `ASSEMBLYAI_API_KEY` | AssemblyAI API Key |
| `DENTDOC_AUTH_TOKEN` | Token für Desktop-Authentifizierung |

**Environment Variables (Desktop `.env`):**
| Variable | Beschreibung |
|----------|--------------|
| `UPLOAD_PROXY_URL` | Railway Service URL |
| `UPLOAD_PROXY_TOKEN` | Gleicher Token wie `DENTDOC_AUTH_TOKEN` |

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

## Audio-Aufnahme (src/audioRecorderFFmpeg.js)

Audio-Aufnahme direkt als WAV PCM via FFmpeg mit DirectShow/WASAPI.

### Warum FFmpeg statt WebRTC?

| Aspekt | WebRTC | FFmpeg |
|--------|--------|--------|
| Format | WebM (Opus - verlustbehaftet) | WAV PCM (verlustfrei) |
| Sherpa-Konvertierung | Nötig | Nicht nötig |
| Diarization-Qualität | Gut | Besser (kein Codec-Verlust) |
| Audio-Filter | Keine | Hochpass + Limiter integriert |
| USB/Wireless | ✅ Ja | ✅ Ja (DirectShow) |

**Entscheidung:** FFmpeg liefert verlustfreies PCM direkt - optimal für Sherpa Speaker Recognition.

### Audio-Pipeline

```
Konferenzmikro
    → FFmpeg (DirectShow/WASAPI)
    → Audio-Filter (Hochpass 90Hz + Limiter 0.97)
    → WAV PCM 16kHz Mono 16-bit
    → AssemblyAI (STT) + Sherpa (Speaker Recognition)
```

### Audio-Spezifikationen

| Parameter | Wert | Grund |
|-----------|------|-------|
| Format | WAV PCM | Verlustfrei für beste Erkennung |
| Sample Rate | 16 kHz | Optimal für Sprache |
| Kanäle | 1 (Mono) | Konferenzmikro ist Mono |
| Bit Depth | 16-bit | Standard für Sprache |
| Hochpass | 90 Hz | Entfernt Rumpeln (Stuhl, Trittschall) |
| Limiter | 0.97 (-0.26 dBFS) | Verhindert Clipping |

### Audio-Filter (Best Practice für Zahnarztpraxis)

#### Hochpass-Filter (90 Hz)
- **Entfernt:** Trittschall, Stuhlbewegungen, tiefes Brummen
- **Bewahrt:** Alle Stimmfrequenzen (Grundfrequenz Stimme ~85-255 Hz)
- **Slope:** 12 dB/Oktave (Standard)

#### Limiter (0.97)
- **Verhindert:** Clipping bei lauten Geräuschen (Sauger, Lachen, Instrumente)
- **Threshold:** -0.26 dBFS (greift selten ein, bewahrt Dynamik)
- **Attack:** Sehr kurz (Peaks abfangen)

### WICHTIG: Was NICHT gemacht wird

| Vermeiden | Grund |
|-----------|-------|
| ❌ Echo Cancellation | Zerstört Phase → Sherpa kann Sprecher nicht unterscheiden |
| ❌ Noise Suppression | Beschädigt Stimm-Spektren → schlechtere Diarization |
| ❌ Auto Gain Control | Verändert Pegel künstlich → Voiceprints leiden |
| ❌ Aggressive Noise Reduction | Zerstört Stimmmerkmale komplett |

### FFmpeg-Befehl

```bash
ffmpeg -f dshow -i audio="Mikrofon Name" \
  -ar 16000 \
  -ac 1 \
  -af "highpass=f=90,alimiter=limit=0.97" \
  -acodec pcm_s16le \
  -y output.wav
```

### Graceful Shutdown (wichtig!)

Beim Stoppen der Aufnahme:

```javascript
// 1. Sanft beenden (FFmpeg finalisiert WAV Header)
ffmpegProcess.stdin.write('q');

// 2. Falls keine Reaktion nach 3 Sek: SIGTERM
ffmpegProcess.kill('SIGTERM');

// 3. Nur als letzter Ausweg nach weiteren 2 Sek: SIGKILL
ffmpegProcess.kill('SIGKILL');
```

**Warum wichtig:**
- WAV-Header muss korrekt geschrieben werden
- Mikrofon muss freigegeben werden
- Keine Zombie-Prozesse

### State Machine (Race Condition Prevention)

Der Recorder verwendet eine State Machine um mehrere gleichzeitige FFmpeg-Prozesse zu verhindern:

```
┌─────────┐   startRecording()   ┌───────────┐   FFmpeg ready   ┌───────────┐
│  idle   │ ──────────────────▶ │  starting │ ──────────────▶ │ recording │
└─────────┘                      └───────────┘                  └───────────┘
     ▲                                                               │
     │                                                               │
     │              stopRecording()                                  │
     │         ┌───────────┐                                         │
     └──────── │  stopping │ ◀───────────────────────────────────────┘
               └───────────┘
```

**States:**
- `idle`: Bereit für neue Aufnahme
- `starting`: FFmpeg wird gestartet (5 Sek. Timeout)
- `recording`: Aufnahme aktiv
- `stopping`: Graceful shutdown läuft

**State Guards:**
- `startRecording()` nur möglich wenn `idle`
- `stopRecording()` nur möglich wenn `recording`
- `forceStop()` für Notfälle (intern)

### Funktionen (audioRecorderFFmpeg.js)

| Funktion | Beschreibung |
|----------|--------------|
| `listAudioDevices()` | Listet Windows Audio-Geräte (WASAPI → DirectShow Fallback) |
| `startRecording(deleteAudio, deviceName)` | Startet FFmpeg mit Filtern (nur wenn `idle`) |
| `stopRecording()` | Graceful shutdown mit Timeout-Kaskade (nur wenn `recording`) |
| `getState()` | Gibt aktuellen State zurück (`idle`/`starting`/`recording`/`stopping`) |
| `forceStop()` | Notfall-Stop, bypassed State Guards (intern) |

### Fallback: WebRTC Recorder

Falls FFmpeg fehlschlägt, existiert `src/audioRecorder.js` als Fallback.
Dort sind Browser-Constraints deaktiviert:

```javascript
audio: {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}
```

**Aktueller Import in main.js:**
```javascript
const audioRecorder = require('./src/audioRecorderFFmpeg');  // FFmpeg (aktiv)
// Fallback: require('./src/audioRecorder');                 // WebRTC
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

### Audio-Level Weiterleitung (F9-Aufnahme)

Bei F9-Aufnahmen wird das Audio-Level vom **Dashboard** ermittelt (nicht vom Recorder-Window), da FFmpeg keine nativen Level-Daten liefert.

**Architektur:**
```
Dashboard (hidden)
    → getUserMedia (WebAudio API)
    → getByteTimeDomainData (raw waveform)
    → Peak Detection (NO smoothing)
    → IPC 'audio-level-update'
           ↓
       Main Process
           ↓
    Status-Overlay
    → Icon-Animation (scale 1.0-1.3)
```

**Warum Dashboard statt Recorder-Window?**
- FFmpeg liefert keine Audio-Level-Daten
- Dashboard hat `backgroundThrottling: false` → läuft auch wenn hidden
- WebAudio API im Dashboard holt Levels vom gleichen Mikrofon parallel

**Code (main.js):**
```javascript
ipcMain.on('audio-level-update', (event, level) => {
  // An Status-Overlay (für F9-Aufnahme Icon-Animation)
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.webContents.send('audio-level', level);
  }
});
```

**Code (dashboard.js):**
```javascript
// Bei recording-started: getUserMedia + WebAudio Analyser starten
// setInterval alle 16ms (~60 FPS):
f9Analyser.getByteTimeDomainData(dataArray);
let maxDeviation = 0;
for (let i = 0; i < bufferLength; i++) {
  const deviation = Math.abs(dataArray[i] - 128);
  if (deviation > maxDeviation) maxDeviation = deviation;
}
const normalized = Math.min(1, (maxDeviation / 128) * 5);  // 5x boost
ipcRenderer.send('audio-level-update', normalized);
```

**Wichtig:**
- `getByteTimeDomainData` statt `getByteFrequencyData` → keine FFT-Smoothing
- `smoothingTimeConstant = 0` → kein internes Smoothing
- Direkte Peak-Erkennung → Icon folgt Audio sofort (kein Decay-Delay)

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

FFmpeg-Wrapper für Format-Konvertierung mit zwei unterschiedlichen Profilen.

### Zwei Audio-Profile: Warum?

Die App verwendet **zwei verschiedene Audio-Filter-Profile** für unterschiedliche Zwecke:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ORIGINAL AUFNAHME                                     │
│                   (16kHz, Mono, PCM, highpass=90Hz)                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                │                                       │
                ▼                                       ▼
┌───────────────────────────────┐       ┌───────────────────────────────┐
│   SHERPA SPEAKER RECOGNITION  │       │      ASSEMBLYAI UPLOAD        │
│   (lokale Sprechererkennung)  │       │      (Transkription)          │
├───────────────────────────────┤       ├───────────────────────────────┤
│ Filter: highpass=90Hz         │       │ Filter: highpass=200Hz        │
│         alimiter=0.97         │       │         lowpass=3000Hz        │
├───────────────────────────────┤       ├───────────────────────────────┤
│ Optimiert für:                │       │ Optimiert für:                │
│ • Voiceprint-Erstellung       │       │ • Spracherkennung (STT)       │
│ • Sprecher-Unterscheidung     │       │ • Hintergrundgeräusch-Filterung│
│ • Alle Stimmfrequenzen erhalten│      │ • AssemblyAI Empfehlungen     │
└───────────────────────────────┘       └───────────────────────────────┘
```

**Warum unterschiedliche Filter?**

| Aspekt | Sherpa (Speaker Recognition) | AssemblyAI (Transkription) |
|--------|------------------------------|---------------------------|
| Highpass | 90 Hz (bewahrt tiefe Stimmen) | 200 Hz (aggressiver) |
| Lowpass | Keiner (alle Obertöne erhalten) | 3000 Hz (Rauschen entfernen) |
| Ziel | Sprecher unterscheiden | Text erkennen |
| Priorität | Voiceprint-Qualität | Transkriptionsgenauigkeit |

### Funktionen

| Funktion | Beschreibung |
|----------|--------------|
| `convertToWav16k(inputPath, outputPath)` | Konvertiert zu 16kHz WAV für Sherpa (highpass=90Hz, limiter) |
| `convertForAssemblyAI(inputPath, outputPath)` | Konvertiert für AssemblyAI Upload (highpass=200Hz, lowpass=3000Hz) |
| `convertAndReplace(webmPath)` | Konvertiert und gibt WAV-Pfad zurück |

### FFmpeg-Befehle

**Für Sherpa Speaker Recognition:**
```bash
ffmpeg -i input.wav \
  -ar 16000 \
  -ac 1 \
  -af "highpass=f=90,alimiter=limit=0.97" \
  -acodec pcm_s16le \
  -f wav output_16k.wav
```

**Für AssemblyAI Upload:**
```bash
ffmpeg -i input.wav \
  -ar 16000 \
  -ac 1 \
  -af "highpass=f=200,lowpass=f=3000" \
  -acodec pcm_s16le \
  -f wav output_assemblyai.wav
```

### Upload-Flow mit Temp-Datei

```
uploadAudio(audioFilePath)
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. convertForAssemblyAI()               │
│    → Erstellt: recording_assemblyai.wav │
│    → Im gleichen Ordner wie Original    │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 2. Upload zu AssemblyAI                 │
│    → Optimierte Datei wird hochgeladen  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 3. Cleanup (immer!)                     │
│    → Temp-Datei wird gelöscht           │
│    → Auch bei Fehler (catch-Block)      │
└─────────────────────────────────────────┘
```

**Cleanup-Garantie:**
- Success: Temp-Datei wird nach Upload gelöscht
- Error: Temp-Datei wird im catch-Block gelöscht
- Crash: Datei bleibt in %TEMP%/dentdoc/ (Windows räumt auf)

### Pfad-Auflösung

```javascript
// Produktion (verpackt)
app.asar.unpacked/node_modules/ffmpeg-static/

// Entwicklung
node_modules/ffmpeg-static/
```

---

## VAD Pipeline (Stille-Entfernung)

Voice Activity Detection (VAD) wird verwendet, um Stille aus Audio-Dateien zu entfernen bevor sie an AssemblyAI gesendet werden. Dies reduziert Upload-Größe und Transkriptionskosten.

### Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│  Recording Stop / File Upload                                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. VAD (Live oder Offline)                                     │
│     Sherpa-ONNX Silero VAD erkennt Speech-Segmente              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. SPEECH-ONLY WAV (speechRenderer.js)                         │
│     VAD Segments werden concateniert → speech_only.wav          │
│     Stille entfernt, nur Sprache bleibt                         │
│     speechMap erstellt (für Timeline-Mapping)                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. AssemblyAI Upload                                           │
│     speech_only.wav → Backend → AssemblyAI                      │
│     Normale Transkription wie bisher                            │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. OUTPUT                                                      │
│     AssemblyAI Transcript (mit Speaker Labels wenn aktiviert)   │
└─────────────────────────────────────────────────────────────────┘
```

### VAD Modi

| Modus | Verwendung | Beschreibung |
|-------|-----------|--------------|
| **F9-Aufnahme** | Live Recording | Aufnahme mit FFmpeg, danach Offline-VAD Analyse |
| **Datei-Upload** | Audio importieren | VAD analysiert hochgeladene Audio-Datei |

**Wichtig:** Beide Modi nutzen denselben Offline-VAD Flow. Die VAD-Analyse läuft IMMER nach der Aufnahme/Upload, nicht parallel.

#### F9-Aufnahme Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. F9 drücken → startRecordingWithVAD()                        │
│     FFmpeg startet Aufnahme (DirectShow)                        │
│     Status-Overlay: "🎤 Aufnahme läuft"                         │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. F9 erneut drücken → stopRecordingWithVAD()                  │
│     FFmpeg stoppt, full.wav gespeichert                         │
│     Status-Overlay: "🔍 Stille wird entfernt..."                │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. processFileWithVAD(full.wav)                                │
│     Offline-VAD analysiert komplette Aufnahme                   │
│     Speech-Segmente werden erkannt                              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. speechRenderer.renderSpeechOnly()                           │
│     Segmente → speech_only.wav                                  │
│     Log: "67.7% Stille entfernt"                                │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. AssemblyAI Upload                                           │
│     speech_only.wav → Backend → Transkription                   │
└─────────────────────────────────────────────────────────────────┘
```

#### Datei-Upload Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Tray → "Audio-Datei transkribieren..."                      │
│     Datei-Dialog: WAV, MP3, M4A, etc.                           │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. processFileWithVAD(uploaded.wav)                            │
│     Falls nicht WAV: Konvertierung zu 16kHz WAV                 │
│     Offline-VAD analysiert Datei                                │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. speechRenderer.renderSpeechOnly()                           │
│     Segmente → speech_only.wav                                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. AssemblyAI Upload                                           │
│     speech_only.wav → Backend → Transkription                   │
└─────────────────────────────────────────────────────────────────┘
```

#### Warum kein paralleler Live-VAD?

Frühere Versionen nutzten einen VAD-Worker parallel zur Aufnahme. Das führte zu:
- Wörter wurden am Anfang/Ende abgeschnitten
- Komplexe Synchronisierung zwischen FFmpeg und VAD-Worker
- Timing-Probleme bei der Segment-Erkennung

Die aktuelle Lösung ist einfacher und zuverlässiger: Erst komplett aufnehmen, dann analysieren.

### Dateien

| Datei | Zweck |
|-------|-------|
| `src/vad-controller.js` | Steuert VAD Worker, sammelt Segmente |
| `src/vad/vad-worker-thread.js` | Node.js Worker mit Sherpa-ONNX Silero VAD |
| `src/pipeline/index.js` | Pipeline-API: `processFileWithVAD()`, `renderSpeechOnlyFromSegments()` |
| `src/pipeline/offlineVad.js` | Offline-VAD für hochgeladene Dateien |
| `src/pipeline/speechRenderer.js` | Rendert speech_only.wav aus VAD-Segmenten |

### VAD Konfiguration (vad-worker-thread.js)

```javascript
const CONFIG = {
  sampleRate: 16000,
  speechStartMs: 100,    // Sprache erkannt nach 100ms Speech
  speechStopMs: 1500,    // Stille erkannt nach 1.5s Pause
  preRollMs: 800,        // 800ms Audio VOR Speech-Start behalten
  postRollMs: 1000,      // 1s Audio NACH Speech-Ende behalten
  sileroThreshold: 0.4,  // VAD Confidence Threshold
  minSpeechDuration: 0.1 // Min. 100ms Speech
};
```

### speechMap (Timeline-Mapping)

Der `speechRenderer` erstellt eine `speechMap` die Zeitstempel vom speech-only Audio zurück zur Original-Aufnahme mappt:

```javascript
// Beispiel speechMap
[
  {
    speechStartMs: 0,        // Position in speech_only.wav
    speechEndMs: 5000,
    originalStartMs: 2500,   // Position in Original-Aufnahme
    originalEndMs: 7500,
    segmentIndex: 0
  },
  {
    speechStartMs: 5000,
    speechEndMs: 12000,
    originalStartMs: 15000,
    originalEndMs: 22000,
    segmentIndex: 1
  }
]
```

**Hinweis:** Die speechMap wird erstellt aber derzeit nicht aktiv verwendet. Sie könnte in Zukunft für präzise Timestamp-Anzeige genutzt werden.

### Funktionen (speechRenderer.js)

| Funktion | Beschreibung |
|----------|--------------|
| `renderSpeechOnly(segments, outputPath)` | Rendert VAD-Segmente zu speech_only.wav |
| `getTotalDuration(segments)` | Berechnet Gesamtdauer aller Segmente |
| `mapToOriginalTime(speechTimeMs, speechMap)` | Mappt speech-only Zeit zu Original-Zeit |
| `mapToSpeechTime(originalTimeMs, speechMap)` | Mappt Original-Zeit zu speech-only Zeit |

---

## Speaker Recognition

> **Detaillierte Dokumentation:** Siehe [SPEAKER-RECOGNITION.md](SPEAKER-RECOGNITION.md) für das vollständige Datenmodell, Staged Embeddings, Optimierungs-Flow und Sicherheitsregeln.

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

#### Fenstergröße & Window Lifecycle (v1.4.5+)

**Architektur-Prinzip:** Main Process ist alleiniger Besitzer der Fenstergröße. Der Renderer steuert NIE die Größe.

**Problem (vor v1.4.5):**
- Renderer kontrollierte Fenstergröße via IPC → Race Conditions
- Electron cached Window-Bounds intern
- `hide()` resettet den Cache nicht → "Zombie-Window" mit alter Größe
- Nach erstem Success (großes Fenster) blockierte das versteckte Fenster Klicks darunter

**Lösung:**
1. **Destroy statt Hide:** `statusOverlay.destroy()` statt `statusOverlay.hide()` - erstellt frisches Fenster ohne gecachte Bounds
2. **Deterministische Größen:** Main Process setzt Größe basierend auf State-Typ
3. **Keine Renderer-Resize-Logik:** Renderer sendet keine size-Events mehr

**Code (main.js):**
```javascript
// Deterministische Größen pro State
function getOverlaySizeForState(type, extra = {}) {
  switch (type) {
    case 'recording':
      return { width: 402, height: 96 };
    case 'processing':
      return { width: 402, height: 151 };
    case 'success':
      // Kleiner wenn keine shortenings (z.B. "Letzte Dokumentation anzeigen")
      const hasShorts = extra.shortenings && Object.keys(extra.shortenings).length > 0;
      return { width: 402, height: hasShorts ? 417 : 277 };
    case 'error':
      return { width: 402, height: 141 };
    default:
      return { width: 402, height: 121 };
  }
}

// KRITISCH: Destroy statt Hide
function hideStatusOverlay() {
  if (statusOverlay && !statusOverlay.isDestroyed()) {
    statusOverlay.destroy();  // Nicht hide()!
    statusOverlay = null;
    statusOverlayReady = false;
  }
}

// Größe wird VOR dem Anzeigen gesetzt
function updateStatusOverlay(title, message, type, extra = {}) {
  const overlay = createStatusOverlay();
  const { width, height } = getOverlaySizeForState(type, extra);
  overlay.setSize(width, height, false);
  // ... send data to renderer
}
```

**BrowserWindow Config:**
```javascript
{
  focusable: false,  // Verhindert Doppelklick-Problem bei benachbarten Feldern
  // ... andere Optionen
}
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

/* Interaktive Elemente darüber */
.header { z-index: 1; }
.actions { z-index: 10; -webkit-app-region: no-drag; }  /* Höher für Scroll-Interaktion */
.progress-container, .shortening-section { z-index: 1; }

/* Buttons explizit no-drag */
.close-btn, .action-btn, .shortening-btn {
  -webkit-app-region: no-drag;
}
```

So ist das Fenster überall verschiebbar, aber Buttons und Scrollbereiche bleiben interaktiv.

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

### Kompletter Aufnahme → Dokumentation Flow (mit VAD)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. USER DRÜCKT F9 (Hotkey)                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. startRecordingWithVAD()                                  │
│    • Token & Subscription validieren                        │
│    • audioRecorder.startRecording()                         │
│    • VAD Worker starten (parallel zur Aufnahme)             │
│    • WAV nach %TEMP%/dentdoc/recording-{ts}.wav            │
│    • Status-Overlay: "Aufnahme läuft..."                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
        [User spricht während Behandlung]
        [VAD markiert Speech-Segmente live]
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. USER DRÜCKT F9 ERNEUT                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. stopRecordingWithVAD()                                   │
│    • Aufnahme stoppen                                       │
│    • VAD Worker stoppen, Segmente sammeln                   │
│    • speechRenderer.renderSpeechOnly(segments)              │
│    • Erstellt speech_only.wav + speechMap                   │
│    Status: "Stille wird entfernt..."                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 5a. apiClient.uploadAudio(speechOnlyPath, token, onProgress)│
│    POST /api/transcriptions/upload                          │
│    • Desktop → Vercel: Progress 0-50%                       │
│    • Vercel → AssemblyAI: file.upload() + transcripts.submit│
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
│    • WAV → 16kHz WAV konvertieren (falls nötig)            │
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

### Datei-Upload Flow (mit Offline-VAD)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. User wählt "Audio-Datei transkribieren..."              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. selectAndTranscribeAudioFile()                           │
│    • Datei-Dialog öffnen                                    │
│    • Unterstützt: WebM, WAV, MP3, M4A, OGG, FLAC, AAC      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. processFileWithVAD(audioPath)                            │
│    • Falls nicht WAV: convertToWav16k()                     │
│    • Offline-VAD analysiert gesamte Datei                   │
│    • speechRenderer.renderSpeechOnly(segments)              │
│    • Erstellt speech_only.wav + speechMap                   │
│    Status: "Stille wird entfernt..."                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Weiter wie bei F9-Aufnahme ab Schritt 5a                 │
│    (Upload, Polling, Speaker Recognition, Dokumentation)   │
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

### Electron-spezifische Workarounds

#### Focus-Problem nach Browser-confirm()

**Problem:** Nach `confirm()` Dialog verliert das Electron-Fenster den Fokus. Input-Felder sind nicht mehr klickbar.

**Lösung:** IPC-basierte Dialoge verwenden statt Browser `confirm()`:

```javascript
// ❌ SCHLECHT - verursacht Focus-Probleme
if (!confirm('Wirklich löschen?')) return;

// ✅ GUT - Electron dialog.showMessageBox via IPC
const confirmed = await ipcRenderer.invoke('confirm-delete-profile');
if (!confirmed) return;
```

**IPC Handler (main.js):**
```javascript
ipcMain.handle('confirm-delete-profile', async () => {
  const result = await dialog.showMessageBox(dashboardWindow, {
    type: 'warning',
    buttons: ['Löschen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Stimmprofil löschen',
    message: 'Möchten Sie dieses Stimmprofil wirklich löschen?'
  });
  return result.response === 0;
});
```

**Betroffene Dialoge:**
- `confirm-delete-profile` - Stimmprofil löschen
- `confirm-delete-category` - Kategorie löschen
- `confirm-delete-baustein` - Baustein löschen
- `confirm-reset-baustein` - Baustein zurücksetzen
- `confirm-reset-all-bausteine` - Alle Bausteine zurücksetzen
- `confirm-delete-textbaustein` - Textbaustein löschen
- `confirm-reset-textbausteine` - Alle Textbausteine zurücksetzen
- `confirm-delete-thema` - Thema löschen
- `confirm-reset-themen` - Alle Themen zurücksetzen

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

### Version 1.4.8 (2025-01-18)

**Verbesserte Console-Logs für bessere Lesbarkeit:**
- Visuelle Trenner mit `/////` für jeden Verarbeitungsschritt
- VAD Analyse zeigt jetzt Dateigrößen statt Segment-Anzahl:
  ```
  ///// VAD ANALYSE /////
    Original:  301.2s (15.23 MB)
    Sprache:   275.1s (~13.89 MB)
    Entfernt:  8.6% Stille
  ///////////////////////
  ```
- Neue `[TEMP]` Marker für alle temporären Datei-Operationen:
  - `[TEMP] Erstellt:` - Wenn Temp-Datei erstellt wird (mit Größe in MB)
  - `[TEMP] Geloescht:` - Wenn Temp-Datei gelöscht wird
- Temp-Ordner Pfad wird am Anfang der Verarbeitung angezeigt
- Tracking aller Temp-Dateien: converted.wav, Segment-Extrakte, concat_list.txt, speech_only.wav, *_assemblyai.wav
- Unicode-Arrows (`→`) durch ASCII (`-->`) ersetzt für bessere Terminal-Kompatibilität

**Gelöschte Dateien:**
- `vad.md` - Wurde in ARCHITECTURE.md integriert

### Version 1.4.7 (2025-01-17)

**VAD Pipeline vereinfacht - OpenAI entfernt:**
- VAD (Voice Activity Detection) wird jetzt nur noch für Stille-Entfernung verwendet
- Vollständige Entfernung der OpenAI STT Pipeline
- Neuer Flow: VAD → speech_only.wav → AssemblyAI (statt OpenAI Chunking)

**Gelöschte Dateien:**
- `src/pipeline/openaiTranscribe.js` - OpenAI Transkription
- `src/pipeline/chunker.js` - Audio-Chunking für OpenAI Limits
- `src/pipeline/speakerRemap.js` - Speaker Drift Korrektur
- `src/pipeline/transcriptMerge.js` - Chunk-Merging
- `src/pipeline/config.js` - OpenAI-spezifische Config

**Entfernte Funktionen aus main.js:**
- `selectAndTestOpenAI()` - OpenAI Test-Menüpunkt
- `processFileWithOpenAIPipeline()` - OpenAI File-Upload
- `processWithOpenAIPipeline()` - OpenAI Recording-Verarbeitung

**Entfernte Funktionen aus apiClient.js:**
- `createTranscriptionFromText()` - OpenAI Transkription speichern
- `testOpenAITranscription()` - OpenAI API-Test

**Neue/Aktualisierte Funktionen:**
- `processFileWithVAD()` - Datei-Upload mit Offline-VAD → AssemblyAI
- `processAudioFileDirectly()` - Speech-only Audio direkt an AssemblyAI senden
- `stopRecordingWithVAD()` - Live-VAD Segmente → speech_only.wav → AssemblyAI

**speechMap:**
- Timeline-Mapping von speech-only Audio zu Original-Aufnahme wird erstellt
- Derzeit nicht aktiv verwendet, aber für zukünftige Features bereit

### Version 1.4.6 (2025-01-16)

**AssemblyAI Audio-Optimierung:**
- Neue Funktion `convertForAssemblyAI()` in audio-converter.js
- Audio wird vor Upload mit AssemblyAI-empfohlenen Filtern konvertiert:
  - `highpass=200Hz` (statt 90Hz) - aggressivere Tiefenfilterung
  - `lowpass=3000Hz` - entfernt hochfrequentes Rauschen
- Original-Aufnahme bleibt unverändert für Sherpa Speaker Recognition
- Temp-Datei (`*_assemblyai.wav`) wird nach Upload automatisch gelöscht
- Cleanup auch im Fehlerfall garantiert

**Zwei Audio-Profile:**
- Sherpa: highpass=90Hz, limiter (bewahrt alle Stimmfrequenzen für Voiceprints)
- AssemblyAI: highpass=200Hz, lowpass=3000Hz (optimiert für Transkription)

### Version 1.4.5 (2025-01-16)

**Status-Overlay Window Lifecycle Fix:**
- **KRITISCH:** `destroy()` statt `hide()` - verhindert "Zombie-Window" mit gecachten Bounds
- Main Process ist jetzt alleiniger Besitzer der Fenstergröße (keine Renderer-Resize-Logik mehr)
- Deterministische Fenstergrößen pro State-Typ (recording, processing, success, error)
- Success-Fenster passt Größe an ob shortenings vorhanden sind (417px vs 277px)
- "Letzte Dokumentation anzeigen" zeigt jetzt auch shortenings wenn vorhanden
- `focusable: false` verhindert Doppelklick-Problem bei benachbarten Textfeldern
- `.actions` Container hat jetzt `z-index: 10` und `-webkit-app-region: no-drag` für Scroll-Interaktion

**Audio-Aufnahme Constraints:**
- Alle Audio-Processing deaktiviert: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`
- Verbesserte Audio-Level-Berechnung mit RMS + Peak Detection und logarithmischer Skalierung

### Version 1.4.4 (2025-01-16)

**Transkript-Export mit Kürzungen:**
- Gespeicherte Transkript-Dateien enthalten jetzt alle Kürzungsvarianten (Stichworte, Chef Ultra, Chef, PVS, ZFA, Normalisiert) wenn v1.2 Hybrid-Modus verwendet wird
- Neuer "KÜRZUNGEN"-Abschnitt im Transkript-Dateiformat zwischen Zusammenfassung und Vollständigem Transkript

**Audio-Speicherung korrigiert:**
- Audio-Dateien werden jetzt mit korrekter `.wav` Erweiterung gespeichert (statt hartcodiert `.webm`)
- Verwendet automatisch die tatsächliche Dateiendung des Quell-Audios

### Version 1.4.3 (2025-01-15)

**Audio-Optimierung & UI-Verbesserungen:**
- Instant Audio-Meter ohne Verzögerung
- Focus-Fixes für Electron-Dialoge

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

### Version 1.4.5 (2025-01-18)

**Railway Upload-Proxy:**
- Neuer Stream-Proxy Service auf Railway für sichere AssemblyAI Uploads
- AssemblyAI API-Key bleibt auf Railway (nicht mehr im Desktop exposed)
- Echter Stream-Passthrough ohne Buffer/RAM-Verbrauch
- DSGVO-sauber: Audio wird nie zwischengespeichert
- Desktop authentifiziert sich mit `UPLOAD_PROXY_TOKEN`

**Architektur:**
```
Desktop → Railway (stream) → AssemblyAI
```

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

**Aktuelle Version:** 1.4.5
**Letztes Update dieser Dokumentation:** 2025-01-18

