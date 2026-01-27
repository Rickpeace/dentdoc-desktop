# Audio Recording - Aufnahme-System

> Dokumentation für Audio-Aufnahme, VAD und Sprechererkennung

## Übersicht

Die App unterstützt drei Aufnahme-Modi:

| Modus | Datei | Beschreibung |
|-------|-------|--------------|
| Standard | `audioRecorderFFmpeg.js` | Lokales Mikrofon via FFmpeg |
| iPhone | main.js + iOS App | DentDoc Mic App als Bluetooth-Mikrofon |
| VAD | `vad-controller.js` + `vad/` | Voice Activity Detection für Auto-Stop |

---

## Aufnahme- und Verarbeitungs-Status (State Management)

### Zwei getrennte Zustände

Die App unterscheidet strikt zwischen **Aufnahme** und **Verarbeitung**:

| Flag | Bedeutung | Wann aktiv |
|------|-----------|------------|
| `isRecording` | FFmpeg nimmt auf | F9 Start → F9 Stop |
| `isProcessing` | Verarbeitung läuft | F9 Stop → Erfolg/Fehler |

**Wichtig:** Diese Zustände schließen sich gegenseitig aus. Während `isProcessing=true` ist, kann keine neue Aufnahme gestartet werden.

### State Machine

```
IDLE (isRecording=false, isProcessing=false)
  │
  F9 → startRecording()
  ↓
RECORDING (isRecording=true, isProcessing=false)
  │    UI: "🎤 Aufnahme läuft"
  │    Tray: Recording-Icon
  │
  F9 → stopRecording()
  ↓
  FFmpeg stoppt
  ↓
PROCESSING (isRecording=false, isProcessing=true)
  │    UI: Zeigt aktuellen Schritt
  │    F9 wird ignoriert!
  │
  ├─ Downsampling...
  ├─ Audio wird gespeichert...
  ├─ Stille wird entfernt (VAD)...
  ├─ Audio wird hochgeladen...
  ├─ Transkription läuft...
  ├─ Sprecher werden erkannt...
  └─ Dokumentation wird erstellt...
  │
  ↓
SUCCESS/ERROR → isProcessing=false
  ↓
IDLE (bereit für neue Aufnahme)
```

### Implementierung (main.js)

```javascript
// Globale Flags
let isRecording = false;   // Line ~116
let isProcessing = false;  // Line ~117

// Guard in stopRecording() - verhindert doppelte F9-Presse
async function stopRecording() {
  if (isProcessing) {
    console.log('[Recording] Already processing, ignoring stop request');
    return;
  }
  // ...
}

// In stopRecordingWithVAD() - sofortiger Status-Wechsel nach FFmpeg-Stop
async function stopRecordingWithVAD() {
  // FFmpeg stoppen
  await audioRecorder.stopRecording();

  // SOFORT Status wechseln (vor Downsampling!)
  isRecording = false;
  isVadSession = false;
  isProcessing = true;

  // UI aktualisieren
  updateStatusOverlay('Verarbeitung läuft', 'Downsampling...', 'processing');

  // Jetzt erst Downsampling (kann lange dauern bei großen Dateien)
  await audioRecorder.downsampleTo16k(currentRecordingPath);

  // Verarbeitung...
  await processFileWithVAD(currentRecordingPath, token, { source: 'mic' });
}
```

### Sicherheits-Timeout

Falls die Verarbeitung unerwartet hängt (FFmpeg-Crash, Netzwerk-Timeout, etc.), wird `isProcessing` nach 5 Minuten automatisch zurückgesetzt:

```javascript
// In stopRecordingWithVAD()
const processingTimeout = setTimeout(() => {
  if (isProcessing) {
    console.error('[SAFETY] Processing timeout after 5 minutes - auto-resetting state');
    isProcessing = false;
    trayModule.updateTrayMenu();
    autoUploadDebugLogs('processing-timeout');
  }
}, 5 * 60 * 1000);  // 5 Minuten

// Timeout wird bei Erfolg/Fehler gelöscht
clearProcessingTimeout();
```

### Fehlerbehandlung

| Szenario | Was passiert | isProcessing Reset? |
|----------|--------------|---------------------|
| Fehler vor processFileWithVAD | Catch-Block in stopRecordingWithVAD | ✓ Ja |
| Fehler in processFileWithVAD | Finally-Block in processFileWithVAD | ✓ Ja |
| App-Crash/Hang | Sicherheits-Timeout (5 Min) | ✓ Ja |

### Warum diese Architektur?

**Problem vorher:** Bei langen Aufnahmen (50+ Minuten) dauerte das Downsampling ~140 Sekunden. Wenn der User während dieser Zeit F9 drückte:
- `isRecording` war noch `true`
- Ein zweiter `stopRecordingWithVAD()` wurde ausgelöst
- EBUSY-Fehler (Datei gesperrt) und FFmpeg-Crashes

**Lösung:** `isRecording=false` und `isProcessing=true` werden SOFORT nach FFmpeg-Stop gesetzt, nicht erst nach dem Downsampling.

---

## Standard-Aufnahme (audioRecorderFFmpeg.js)

### Funktionsweise

FFmpeg wird als Child-Process gestartet und nimmt direkt vom Mikrofon auf:

```javascript
const audioRecorder = require('./src/audioRecorderFFmpeg');

// Aufnahme starten
await audioRecorder.startRecording({
  deviceId: 'microphone-id',  // Optional
  savePath: '/path/to/save',  // Wenn keepAudio=true
  deleteAfter: false          // Audio behalten
});

// Aufnahme stoppen
const audioPath = await audioRecorder.stopRecording();
// audioPath: z.B. 'C:/temp/dentdoc-recording-1234.webm'
```

### FFmpeg-Befehl (Windows)

```bash
ffmpeg -f dshow -i audio="Mikrofon (Realtek)" \
  -acodec libopus -b:a 64k \
  -y output.webm
```

### Konfiguration

```javascript
// In audioRecorderFFmpeg.js
const FFMPEG_ARGS = [
  '-f', 'dshow',                    // Windows DirectShow
  '-i', `audio="${deviceName}"`,    // Mikrofon-Name
  '-acodec', 'libopus',             // Opus Codec
  '-b:a', '64k',                    // Bitrate
  '-y',                             // Überschreiben
  outputPath
];
```

### Audio-Level Monitoring

```javascript
// FFmpeg stderr enthält Volume-Daten
ffmpeg.stderr.on('data', (data) => {
  const match = data.toString().match(/mean_volume:\s*([-\d.]+)/);
  if (match) {
    const level = parseFloat(match[1]);
    // Normalisieren auf 0-1
    const normalized = Math.min(1, Math.max(0, (level + 50) / 50));
    onAudioLevel(normalized);
  }
});
```

### FFmpeg Crash Monitoring

FFmpeg-Crashes werden erkannt und geloggt:

```javascript
// In audioRecorderFFmpeg.js - startRecording()
let stderrOutput = '';
ffmpegProcess.stderr.on('data', (data) => {
  stderrOutput += data.toString();
  if (stderrOutput.length > 2048) {
    stderrOutput = stderrOutput.slice(-2048);  // Nur letzte 2KB
  }
});

ffmpegProcess.once('close', (code, signal) => {
  const wasRecording = recordingState === 'recording';

  if (wasRecording) {
    // FFmpeg unerwartet beendet!
    console.error('[Recorder] FFmpeg CRASHED during recording!');
    console.error('[Recorder] Exit code:', code, '| Signal:', signal);
    console.error('[Recorder] Last stderr:', stderrOutput.slice(-500));

    // Prüfe ob Datei existiert
    if (fs.existsSync(currentFilePath)) {
      const stats = fs.statSync(currentFilePath);
      console.error('[Recorder] File exists, size:', stats.size, 'bytes');
    }
  }

  recordingState = 'idle';
});
```

**Hilft bei Diagnose von:**
- Mikrofon-Verbindungsabbrüchen
- Windows-Audio-Treiber-Problemen
- Speicherplatz-Fehlern

---

## iPhone-Aufnahme

### Voraussetzungen

- DentDoc Mic iOS App installiert
- Bluetooth-Verbindung zum iPhone

### Flow

```
1. User wählt "iPhone als Mikrofon" im Dashboard
2. Desktop startet iPhone-Session (isIphoneSession = true)
3. iOS App verbindet sich via Bluetooth
4. Audio wird vom iPhone zum Desktop gestreamt
5. Desktop speichert als WebM-Datei
```

### Implementierung (main.js)

```javascript
let isIphoneSession = false;

async function startRecordingWithIphone() {
  isIphoneSession = true;
  // ... Bluetooth-Verbindung aufbauen
  // ... Audio-Stream empfangen
}

async function stopRecordingWithIphone() {
  // ... Stream stoppen
  // ... Audio-Datei finalisieren
  isIphoneSession = false;
}
```

---

## VAD (Voice Activity Detection)

### Zweck

VAD wird verwendet um **nach der Aufnahme** die Stille aus der Audio-Datei zu entfernen. Dies:
- Reduziert die Upload-Größe
- Verbessert die Transkriptions-Qualität
- Spart AssemblyAI Kosten (Abrechnung nach Audio-Länge)

**Wichtig:** VAD läuft NICHT während der Live-Aufnahme, sondern als Post-Processing-Schritt.

### Architektur

```
┌─────────────────────────────────────────────────────┐
│ pipeline/offlineVad.js                              │
│  - Analysiert fertige Audio-Datei                   │
│  - Erkennt Sprach-Segmente                          │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ pipeline/speechRenderer.js                          │
│  - Extrahiert nur die Sprach-Segmente               │
│  - Erzeugt speech_only.wav                          │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ silero_vad.onnx                                     │
│  - Neuronales Netzwerk für VAD                      │
│  - ~2MB Modell                                      │
└─────────────────────────────────────────────────────┘
```

### Offline VAD (pipeline/offlineVad.js)

```javascript
const { processAudioWithVAD } = require('./src/pipeline/offlineVad');

// Nach der Aufnahme: Stille entfernen
const result = await processAudioWithVAD(recordedAudioPath);
// result: {
//   speechOnlyPath: '/tmp/speech_only.wav',
//   segments: [{ start: 0, end: 5000 }, { start: 7000, end: 15000 }],
//   originalDuration: 20000,
//   speechDuration: 13000
// }
```

### VAD-Flow im Verarbeitungsprozess

```
1. User stoppt Aufnahme (F9)
2. Audio-Datei liegt vor (z.B. 2 Minuten)
3. offlineVad.js analysiert die Datei
4. Erkennt: 0-30s Sprache, 30-45s Stille, 45-120s Sprache
5. speechRenderer.js extrahiert nur Sprach-Teile
6. Ergebnis: 1:45 statt 2:00 (15s Stille entfernt)
7. Kürzere Datei wird hochgeladen
```

### vad-controller.js (Live Audio-Level)

Der VAD-Controller wird primär für **Live Audio-Level Anzeige** verwendet (nicht für Aufnahme-Steuerung):

```javascript
const vadController = require('./src/vad-controller');

// Initialisieren (einmal bei App-Start)
vadController.initialize();

// Für Audio-Level Monitoring im Dashboard
vadController.onAudioLevel((level) => {
  // 0.0 - 1.0
  updateAudioMeter(level);
});
```

### vad-config.js

```javascript
module.exports = {
  // Silero VAD Parameter
  sampleRate: 16000,
  frameSamples: 512,        // 32ms pro Frame
  silenceThreshold: 0.5,    // VAD Confidence
  speechPadMs: 300,         // Padding um Sprache (verhindert abgeschnittene Wörter)
};
```

---

## Audio-Konvertierung (audio-converter.js)

### AssemblyAI-optimierte Konvertierung

```javascript
const { convertForAssemblyAI } = require('./src/audio-converter');

// Konvertiert zu optimalem Format für Transkription
const optimizedPath = await convertForAssemblyAI('/path/to/audio.webm');
```

**FFmpeg-Filter:**
```bash
ffmpeg -i input.webm \
  -af "highpass=f=200,lowpass=f=3000" \  # Sprachfrequenz-Bereich
  -ac 1 -ar 16000 -sample_fmt s16 \       # Mono, 16kHz, 16-bit
  output.wav
```

**Warum diese Filter?**
- `highpass=200`: Entfernt tiefes Brummen
- `lowpass=3000`: Entfernt Hochfrequenz-Rauschen
- Menschliche Stimme liegt bei ~100-3000 Hz
- AssemblyAI arbeitet optimal mit 16kHz Mono

---

## Sprechererkennung (speaker-recognition/)

### Architektur

```
┌─────────────────────────────────────────────────────┐
│ speaker-recognition/index.js                        │
│  - Sherpa-ONNX Speaker Embedding                    │
│  - Vergleich mit gespeicherten Profilen             │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ speaker-recognition/voice-profiles.js               │
│  - Speichern/Laden von Stimmprofilen                │
│  - JSON-Dateien in Documents/DentDoc/Stimmprofile   │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ models/3dspeaker_*.onnx                             │
│  - Neuronales Netzwerk für Speaker Embedding        │
│  - Erzeugt 256-dim Vektor pro Sprecher              │
└─────────────────────────────────────────────────────┘
```

### speaker-recognition/index.js

```javascript
const speakerRecognition = require('./src/speaker-recognition');

// Sprecher identifizieren
const result = await speakerRecognition.identifySpeakers(
  audioPath,
  utterances  // [{ speaker: 'A', start: 0, end: 5000, text: '...' }]
);

// result.speakerMapping:
// {
//   "A": { role: "Zahnarzt", name: "Dr. Müller", confidence: 0.87 },
//   "B": { role: "Patient", name: null, confidence: 0.65 }
// }
```

### voice-profiles.js

```javascript
const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

// Pfad setzen
voiceProfiles.setStorePath('/path/to/profiles');

// Profil speichern
await voiceProfiles.saveProfile({
  name: 'Dr. Müller',
  role: 'Zahnarzt',
  embedding: [0.1, 0.2, ...]  // 256-dim Vektor
});

// Alle Profile laden
const profiles = voiceProfiles.loadAllProfiles();

// Profil löschen
voiceProfiles.deleteProfile('profile-id');
```

### Embedding-Vergleich

```javascript
// Cosine Similarity zwischen zwei Embeddings
function cosineSimilarity(a, b) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Threshold für Erkennung: ~0.7
```

---

## Stimmprofil-Enrollment

### Flow

```
1. User klickt "Neues Profil" im Dashboard
2. User spricht 5-10 Sekunden
3. Audio wird aufgenommen
4. Embedding wird extrahiert
5. Profil wird gespeichert mit Name + Rolle
```

### Implementierung (main.js)

```javascript
let isEnrolling = false;
let currentEnrollmentPath = null;
let currentEnrollmentName = null;
let currentEnrollmentRole = null;

ipcMain.handle('start-enrollment', async (e, { name, role }) => {
  isEnrolling = true;
  currentEnrollmentName = name;
  currentEnrollmentRole = role;
  // Aufnahme starten...
});

ipcMain.handle('stop-enrollment', async () => {
  isEnrolling = false;
  // Embedding extrahieren
  const embedding = await speakerRecognition.getEmbedding(currentEnrollmentPath);
  // Profil speichern
  await voiceProfiles.saveProfile({
    name: currentEnrollmentName,
    role: currentEnrollmentRole,
    embedding
  });
});
```

---

## Audio-Pfade

### Temporäre Dateien

```javascript
const os = require('os');
const tempDir = os.tmpdir();

// Aufnahmen: C:\Users\xxx\AppData\Local\Temp\dentdoc-recording-{timestamp}.webm
// Optimiert: C:\Users\xxx\AppData\Local\Temp\dentdoc-optimized-{timestamp}.wav
```

### Persistente Dateien (wenn keepAudio=true)

```javascript
const audioSavePath = store.get('audioSavePath');
// Default: C:\Users\xxx\Documents\DentDoc\Audio
```

### Stimmprofile

```javascript
const profilesPath = store.get('profilesPath');
// Default: C:\Users\xxx\Documents\DentDoc\Stimmprofile
```

---

## Mikrofon-Matching

### Problem: USB-Port-Wechsel

Wenn ein USB-Mikrofon in einen anderen Port gesteckt wird, ändert sich der Geräte-Name:
- Vorher: `Mikrofon (2- Logitech PRO X Wireless Gaming Headset) (046d:0aba)`
- Nachher: `Mikrofon (4- Logitech PRO X Wireless Gaming Headset) (046d:0aba)`

Die Nummer "2-" bzw "4-" bezeichnet den USB-Port/Index.

### Lösung: Vendor:Product ID Matching

USB-Geräte haben eine eindeutige Vendor:Product ID (z.B. `046d:0aba`), die konstant bleibt.

**Matching-Strategie (3 Stufen):**

```javascript
// 1. Exakter Match (selten, nur wenn Port gleich bleibt)
if (currentLabel === savedName) return true;

// 2. Vendor:Product ID Match (priorisiert!)
const savedVendorId = savedName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
const currentVendorId = currentLabel.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
if (savedVendorId && currentVendorId && savedVendorId === currentVendorId) return true;

// 3. Normalisierter Name Match (Fallback für FFmpeg-Namen ohne Vendor ID)
const normalizeName = (name) => {
  return name
    .replace(/\([0-9a-f]{4}:[0-9a-f]{4}\)/gi, '')  // USB IDs entfernen
    .replace(/\d+-\s*/g, '')                        // Nummern-Prefixes entfernen
    .replace(/[()]/g, '')                           // Klammern entfernen
    .replace(/mikrofon/gi, '')                      // "Mikrofon" entfernen
    .replace(/\s+/g, ' ')                           // Whitespace normalisieren
    .toLowerCase()
    .trim();
};
```

### Wichtig: FFmpeg vs WebRTC

WebRTC und FFmpeg liefern unterschiedliche Geräte-Namen:
- **WebRTC:** `Mikrofon (2- Logitech PRO X Wireless Gaming Headset) (046d:0aba)` (MIT Vendor ID)
- **FFmpeg:** `Mikrofon (4- Logitech PRO X Wireless Gaming Headset)` (OHNE Vendor ID)

Daher wird der normalisierte Name-Match als Fallback benötigt.

### Verwendung in der Codebase

| Datei | Funktion | Wo |
|-------|----------|----|
| `audio-utils.js` | `findMatchingDevice()` | Settings/Einstellungen |
| `dashboard.js` | `isMicrophoneMatch()` | Device-Notifications |
| `main.js` | `startRecordingWithVAD()` | Mic-Check vor Aufnahme |

---

## Mikrofon-Verfügbarkeits-Check

Vor jeder Aufnahme wird geprüft, ob das ausgewählte Mikrofon verfügbar ist.

### Implementierung (main.js)

```javascript
// Check BEVOR Aufnahme startet
if (microphoneName) {
  const availableDevices = await audioRecorder.listAudioDevices();

  const selectedMicAvailable = availableDevices.some(d => {
    // 3-Stufen-Matching (siehe oben)
    if (d.name === microphoneName) return true;
    if (savedVendorId && currentVendorId === savedVendorId) return true;
    if (savedNormalized === currentNormalized) return true;
    return false;
  });

  if (!selectedMicAvailable) {
    updateStatusOverlay('Mikrofon nicht verbunden', microphoneName, 'error');
    return;  // Aufnahme wird NICHT gestartet
  }
}
```

### Verhalten

- **Mikrofon verbunden:** Aufnahme startet normal
- **Mikrofon nicht verbunden:** Status-Overlay zeigt Fehler, keine Aufnahme
- **Kein Mikrofon konfiguriert:** Verwendet System-Default (Fallback)

---

## FFmpeg Warmup (Jabra/USB-Geräte)

Einige USB/Bluetooth-Mikrofone (z.B. Jabra Speak2 75) starten im "Mute"-Zustand und brauchen einen Audio-Stream um aufzuwachen.

### Implementierung (audioRecorderFFmpeg.js)

```javascript
async function warmupMicrophone(deviceName, durationMs = 400) {
  return new Promise((resolve) => {
    const args = [
      '-f', 'wasapi',
      '-i', 'default',
      '-t', (durationMs / 1000).toString(),
      '-f', 'null',
      '-'
    ];

    const ffmpeg = spawn(ffmpegPath, args);
    ffmpeg.on('close', resolve);
    ffmpeg.on('error', () => resolve());
  });
}
```

**Warmup wird ausgeführt wenn:**
- Gerätename "Jabra" enthält (Case-insensitive)
- Dauer: 400ms (konfigurierbar)
- Verhindert fehlende erste Worte bei Aufnahme-Start

---

## Mikrofon-Benachrichtigungen (Device Change)

Das Dashboard überwacht Mikrofon-Änderungen und benachrichtigt den User.

### Implementierung (dashboard.js)

```javascript
// MediaDevices Event Listener
navigator.mediaDevices.addEventListener('devicechange', async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');

  // Prüfe ob das AUSGEWÄHLTE Mikrofon betroffen ist
  const savedMic = await window.api.getMicrophone();
  const isSelectedMicConnected = mics.some(m => isMicrophoneMatch(savedMic, m.label));

  if (!isSelectedMicConnected && wasConnected) {
    showToast('Mikrofon getrennt', savedMic, 'warning');
  } else if (isSelectedMicConnected && !wasConnected) {
    showToast('Mikrofon verbunden', savedMic, 'success');
  }
});
```

**Wichtig:** Nur Änderungen am AUSGEWÄHLTEN Mikrofon werden angezeigt, nicht alle Geräte.

---

## Fehlerbehandlung

### Mikrofon-Fehler

```javascript
if (error.message.includes('Could not find audio device')) {
  showNotification('Mikrofon nicht gefunden',
    'Bitte überprüfen Sie die Mikrofon-Einstellungen.');
}
```

### Aufnahme-Fehler

```javascript
if (error.message === 'EMPTY_RECORDING') {
  throw new Error('Die Aufnahme war zu kurz oder leer.');
}
```

### FFmpeg-Fehler

```javascript
if (!fs.existsSync(ffmpegPath)) {
  throw new Error('FFmpeg nicht gefunden. Bitte App neu installieren.');
}
```

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [documentation-flow.md](documentation-flow.md) - Nach der Aufnahme
- [main-process.md](main-process.md) - startRecording/stopRecording
