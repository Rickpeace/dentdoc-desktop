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
  F9 → checkTranscriptFolderBeforeRecording()
  │    Falls Ordner nicht erreichbar:
  │    → Warnung-Dialog (Fortfahren/Abbrechen)
  │    → Bei "Fortfahren": Aufnahme startet, aber Transkript wird NICHT gespeichert
  │
  └─→ startRecording()
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
  │    UI: Zeigt aktuellen Schritt + Fortschrittsbalken
  │    F9 wird ignoriert!
  │
  ├─ Audio wird gespeichert...
  ├─ Analyse: Stille wird erkannt (VAD Worker Thread)...
  ├─ Sprach-Segmente werden extrahiert (FFmpeg)...
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
  // FFmpeg stoppen (Aufnahme ist bereits 16kHz - kein Downsample nötig)
  await audioRecorder.stopRecording();

  // SOFORT Status wechseln
  isRecording = false;
  isVadSession = false;
  isProcessing = true;

  // UI aktualisieren (Fortschrittsbalken mit "Analyse"-Phase)
  updateStatusOverlay('Verarbeitung...', 'Audio wird analysiert...', 'processing', { step: 0 });

  // Verarbeitung: VAD (Worker Thread) → Speech Render → Upload → Transkription → Doku
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

**Problem vorher:** Bei langen Aufnahmen konnte doppeltes F9-Drücken zu EBUSY-Fehlern führen.

**Lösung:** `isRecording=false` und `isProcessing=true` werden SOFORT nach FFmpeg-Stop gesetzt. Seit Version 1.6.17 entfällt der Downsample-Schritt komplett (Aufnahme direkt in 16kHz).

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

Aufnahme erfolgt direkt in 16kHz mono WAV (kein Downsample-Schritt nötig):

```bash
# WASAPI (bevorzugt)
ffmpeg -f wasapi -i default \
  -ac 1 -ar 16000 -acodec pcm_s16le \
  -y output.wav

# DirectShow (Fallback)
ffmpeg -f dshow -i audio="Mikrofon (Realtek)" \
  -ac 1 -ar 16000 -acodec pcm_s16le \
  -y output.wav
```

### Konfiguration

```javascript
// In audioRecorderFFmpeg.js
// Aufnahme direkt in 16kHz mono WAV (seit v1.6.17)
const FFMPEG_ARGS = [
  '-f', 'wasapi',                   // Windows WASAPI (oder dshow als Fallback)
  '-i', 'default',                  // Mikrofon
  '-ac', '1',                       // Mono
  '-ar', '16000',                   // 16kHz direkt (kein Downsample nötig)
  '-acodec', 'pcm_s16le',           // 16-bit PCM WAV
  '-y',                             // Überschreiben
  outputPath
];
```

### WAV-Header Logging

Nach jeder Aufnahme wird der WAV-Header geloggt (Support-Diagnose):
```
[Recorder] WAV header: sampleRate=16000, channels=1, bitsPerSample=16, dataBytes=720002, fileSize=0.69MB
```
Falls die Sample Rate nicht 16kHz ist, erscheint eine Warnung.

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

VAD entfernt Stille aus der Audio-Datei. Dies:
- Reduziert die Upload-Größe
- Verbessert die Transkriptions-Qualität
- Spart AssemblyAI Kosten (Abrechnung nach Audio-Länge)

### Zwei VAD-Modi

| Modus | Wann | Wie | Dauer |
|-------|------|-----|-------|
| **Live VAD** | Mikrofon-Aufnahme (F9) | Sammelt Marker während der Aufnahme parallel zu FFmpeg | ~5s nach Stop |
| **Offline VAD** | Manueller Datei-Upload | Analysiert komplette WAV-Datei nachträglich | ~3 Min bei 30 Min Audio |

**Live VAD** ist der Standard für alle Mikrofon-Aufnahmen. Offline VAD dient nur als Fallback (wenn Live VAD keine Marker liefert) und für manuell hochgeladene Dateien.

### Architektur

**Live VAD (während Mikrofon-Aufnahme):**
```
┌─────────────────────────────────────────────────────┐
│ vad-controller.js (Marker Collection)               │
│  - startMarkerCollection() bei F9 Start             │
│  - Empfängt Audio-Batches vom Renderer AudioWorklet │
│  - Trackt sample-basierte Timeline                  │
│  - Pause/Resume Support                             │
│  - stopMarkerCollection() bei F9 Stop               │
└───────────────────────┬─────────────────────────────┘
                        │ Worker Thread
┌───────────────────────▼─────────────────────────────┐
│ vad/vad-worker-thread.js                            │
│  - Sherpa-ONNX Silero VAD (Echtzeit)                │
│  - Sendet speech-start/speech-end Events            │
│  - samplePosition für exakte Timeline               │
└───────────────────────┬─────────────────────────────┘
                        │ Nach Stop
┌───────────────────────▼─────────────────────────────┐
│ pipeline/speechRenderer.js                          │
│  - Batch-Extraktion via FFmpeg filter_complex       │
│  - Erzeugt speech_only.wav aus Markern              │
└─────────────────────────────────────────────────────┘
```

**Offline VAD (für Datei-Upload / Fallback):**
```
┌─────────────────────────────────────────────────────┐
│ pipeline/offlineVad.js (Orchestrierung)             │
│  - Startet Worker Thread für VAD                    │
│  - Cancel-Support mit 3s Hard-Kill Timeout          │
└───────────────────────┬─────────────────────────────┘
                        │ Worker Thread
┌───────────────────────▼─────────────────────────────┐
│ pipeline/offlineVadWorker.js                        │
│  - Streaming WAV-Lesen (64KB Chunks, ~128KB RAM)    │
│  - Sherpa-ONNX VAD Frame-für-Frame                  │
└───────────────────────┬─────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────┐
│ pipeline/speechRenderer.js (selbe wie oben)         │
└─────────────────────────────────────────────────────┘
```

**Gemeinsam:** silero_vad.onnx (~2MB Modell)

### Offline VAD (pipeline/offlineVad.js) — nur Datei-Upload

```javascript
const { runOfflineVAD, cancelVAD } = require('./src/pipeline/offlineVad');

// Für manuellen Datei-Upload: Sprach-Segmente erkennen
const segments = await runOfflineVAD(recordedAudioPath, (progress) => {
  // progress: { stage: 'vad', percent: 45, message: 'Sprache wird erkannt... 45%' }
  updateUI(progress);
});
// segments: [{ index: 0, path: '...', startMs: 0, endMs: 5000, duration: 5000 }, ...]

// Abbrechen (z.B. bei Cancel-Button)
cancelVAD();
```

### Worker Thread Details

Der VAD Worker (`offlineVadWorker.js`) vermeidet den Main-Thread-Freeze durch:
- **Streaming:** `fs.openSync` + `fs.readSync` in 64KB Chunks statt `fs.readFileSync` (Gesamtdatei)
- **Reusable Buffers:** `readBuffer` (64KB), `frameBuffer` (Float32Array[1024]) - kein GC-Spam
- **Carry Buffer:** Rest-Samples zwischen Chunks werden korrekt übertragen
- **RAM:** Konstant ~128KB egal wie lang die Aufnahme (vorher: 555MB bei 101 Min)
- **Cancel:** Main sendet `{type:'cancel'}` → Worker bricht Loop ab + 3s Hard-Kill Sicherung

### Speech Renderer (pipeline/speechRenderer.js)

```javascript
// Batch-Extraktion mit FFmpeg filter_complex (1 Spawn statt N)
// Bei > 28k chars Command-Length: automatisches Chunking
// Bei Fehler: Fallback auf sequentielle Extraktion (alt)
const { wavPath, speechMap } = await speechRenderer.renderSpeechOnly(segments, outputPath);
```

### Live VAD-Flow (Mikrofon-Aufnahme)

```
1. User drückt F9
2. FFmpeg startet Aufnahme + vadController.startMarkerCollection()
3. Renderer startet AudioWorklet, sendet Audio-Batches via IPC
4. vad-controller.js → vad-worker-thread.js: Echtzeit-VAD
5. Worker sendet speech-start/speech-end mit samplePosition
6. Controller sammelt Marker (processedSamples-basierte Timeline)
7. User drückt F9 erneut
8. vadController.stopMarkerCollection() → verarbeitete Segmente
9. speechRenderer extrahiert Sprache via FFmpeg (~5s)
10. speech_only.wav wird hochgeladen
```

### Offline VAD-Flow (Datei-Upload / Fallback)

```
1. Audio-Datei liegt vor (bereits 16kHz mono)
2. offlineVad.js startet Worker Thread
3. Worker liest WAV streaming, füttert Silero VAD frame-für-frame
4. Erkennt Sprach-Segmente (z.B. 0-30s, 45-120s)
5. speechRenderer extrahiert Segmente via FFmpeg filter_complex
6. speech_only.wav wird hochgeladen
```

### vad-controller.js (Live VAD + Audio-Level)

Der VAD-Controller hat zwei Aufgaben:
1. **Marker Collection:** Sammelt Speech-Marker während der Aufnahme
2. **Audio-Level:** Sendet RMS-Level an Status-Overlay (5x Boost, 50ms Throttle)

**Marker-Only API:**
```javascript
const vadController = require('./src/vad-controller');

// Initialisieren (einmal bei App-Start)
vadController.initialize();

// Bei F9 Start:
vadController.startMarkerCollection({ fullRecordingPath });

// Bei Pause/Resume:
vadController.pauseMarkerCollection();
vadController.resumeMarkerCollection();

// Bei F9 Stop:
const segments = vadController.stopMarkerCollection(fullRecordingPath);
// segments: [{ index, path, startMs, endMs, duration }, ...]
```

**Sample-basierte Timeline:**
Marker-Positionen basieren auf `processedSamples / sampleRate * 1000`, nicht auf `Date.now()`. Dadurch:
- Exakte Ausrichtung mit WAV-Datei
- Pause/Resume funktioniert automatisch (Counter stoppt bei Pause)
- Kein Drift durch IPC-Latenz

### VAD-Konfiguration

**vad-worker-thread.js CONFIG:**

| Parameter | Wert | Beschreibung |
|-----------|------|--------------|
| `sileroThreshold` | 0.15 | Niedrig = empfindlich, verpasst keine leise Sprache |
| `speechStartMs` | 50 | Schneller Trigger (50ms reicht) |
| `speechStopMs` | 1500 | 1.5s Stille → Speech End |
| `preRollMs` | 800 | Ring-Buffer für FFmpeg-Startup |

**vad-controller.js CONFIG:**

| Parameter | Wert | Beschreibung |
|-----------|------|--------------|
| `paddingBeforeMs` | 1500 | 1.5s vor Sprache (erste Silbe nie abschneiden) |
| `paddingAfterMs` | 800 | 0.8s nach Sprache (Nachhall) |
| `mergeGapMs` | 1000 | Marker innerhalb 1s werden vereint |
| `minSpeechMs` | 300 | Marker < 300ms werden verworfen |

**applyPadding() Overlap-Schutz:**
Nach dem Padding werden benachbarte Marker geprüft. Bei Überlappung wird am Mittelpunkt getrennt. Verhindert doppelte Wörter nach Pause/Resume.

### VAD Performance-Optimierungen

#### Januar 2026: Grundlegende Fixes

- **Vad Constructor Fix:** `bufferSizeInSeconds` war fälschlich 16000 statt 60 → ~1.2 GB → ~4 MB RAM
- **Buffer-Wiederverwendung:** Ein `Float32Array` statt 165.000 Allokationen
- **Frame-Größe:** 20ms → 64ms Frames (3.2x weniger Frames)
- **Zero-Padding:** `Math.ceil` statt `Math.floor` für letzten Frame
- **Speech Counter Reset:** Verhindert falsche Speech-Starts

#### Februar 2026: Worker Thread + Streaming (KEIN UI-FREEZE MEHR)

**Problem:** Bei 101-Min-Aufnahme (557MB) fror die App 5-12 Minuten komplett ein. `readWavSamples()` lud die gesamte Datei in den Speicher (185MB Buffer + 370MB Float32 = 555MB RAM-Spike).

**Lösung:**

| Aspekt | Vorher | Nachher |
|--------|--------|---------|
| Thread | Main Thread (blockiert UI) | Worker Thread (UI bleibt frei) |
| WAV-Lesen | `fs.readFileSync` (alles in RAM) | `fs.readSync` in 64KB Chunks (Streaming) |
| RAM | 555MB bei 101 Min | ~128KB konstant |
| Downsample | 425s separater Schritt | 0s (Aufnahme direkt 16kHz) |
| FFmpeg Segmente | N einzelne Spawns | 1 Spawn via `filter_complex` |
| User-Feedback | Nichts (Freeze) | Fortschrittsbalken mit 5 Phasen |
| Cancel | Nicht möglich | Worker bricht ab, 3s Hard-Kill |

**Segment-Guardrails:**
- Minimum Segment-Länge: 300ms
- Merge Gap: 1000ms Live VAD / 400ms Offline VAD (nahe Segmente werden vereint)
- Hard Cap: max 500 Segmente (verhindert filter_complex Explosion)

#### Februar 2026: Live VAD (KEINE ANALYSE-WARTEZEIT MEHR)

**Problem:** Bei 30-Min-Aufnahme auf langsamem PC dauerte "Sprache wird erkannt" ~3 Minuten (28K+ ONNX Inference Calls nach dem Stoppen).

**Lösung:** VAD läuft jetzt **während der Aufnahme** parallel zu FFmpeg. Nach Stop nur noch FFmpeg-Extraktion (~5s).

| Aspekt | Vorher (Offline) | Nachher (Live) |
|--------|-----------------|----------------|
| VAD-Zeitpunkt | Nach der Aufnahme | Während der Aufnahme |
| Wartezeit nach Stop | ~3 Min (30 Min Audio) | ~5s |
| Audio-Level | Separater Stream (F9 Monitoring) | Via VAD Controller (5x Boost) |
| Pause/Resume | Nicht relevant | Sample-Timeline stoppt automatisch |

---

## Upload-Optimierungen (Januar 2026)

### Smart Conversion Skip

Die `uploadAudio()` Funktion prüft jetzt ob die Datei bereits optimiert ist:

```javascript
// apiClient.js - isAlreadyOptimized()
function isAlreadyOptimized(filePath) {
  // Liest nur WAV-Header (44 Bytes) - instant
  const buffer = Buffer.alloc(44);
  // ... header lesen ...
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  return channels === 1 && sampleRate === 16000;
}

// In uploadAudio():
if (isAlreadyOptimized(audioFilePath)) {
  console.log('[Upload] Bereits optimiert - Konvertierung übersprungen');
  // Direkt hochladen ohne FFmpeg
} else {
  // convertForAssemblyAI() aufrufen
}
```

**Ersparnis:** ~3-5 Sekunden (kein unnötiger FFmpeg-Aufruf)

### Chunk-Size erhöht

```javascript
// VORHER: 512KB Chunks (viel HTTP-Overhead)
const chunkSize = 512 * 1024;

// NACHHER: 5MB Chunks
const chunkSize = 5 * 1024 * 1024;
```

### Log-Ausgabe

Bei optimierten Dateien erscheint im Log:
```
[Upload] Bereits optimiert (16kHz mono) - Konvertierung übersprungen
[Upload] Datei: speech_only.wav (36.89 MB)
```

Bei nicht-optimierten Dateien:
```
[Upload] Konvertiere zu 16kHz mono...
[Upload] Konvertiert: speech_only_assemblyai.wav
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
│  - Backend DB (API) + In-Memory Cache               │
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

// Initialisierung (bei Login/App-Start)
await voiceProfiles.init(apiClient, () => store.get('authToken'));

// Alle Profile (sync, aus Cache)
const profiles = voiceProfiles.getAllProfiles();

// Profil erstellen (async, via API)
await voiceProfiles.saveProfile('Dr. Müller', embedding, 'Arzt');

// Embedding hinzufügen (async)
await voiceProfiles.addConfirmedEmbedding(profileId, embedding, { sourceType: 'utterance' });

// Profil löschen (async, via API)
await voiceProfiles.deleteProfile(profileId);
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

ipcMain.handle('start-voice-enrollment', async (e, { name, role }) => {
  isEnrolling = true;
  currentEnrollmentName = name;
  currentEnrollmentRole = role;
  // Aufnahme starten...
});

ipcMain.handle('stop-voice-enrollment', async () => {
  isEnrolling = false;
  // Embedding extrahieren
  const embedding = await speakerRecognition.getEmbedding(currentEnrollmentPath);
  // Profil speichern (async, via Backend API)
  await voiceProfiles.saveProfile(currentEnrollmentName, embedding, currentEnrollmentRole);
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

## Aufnahme-Abbruch und Cleanup

### Zwei Stop-Methoden

| Methode | Zweck | Wann verwenden |
|---------|-------|----------------|
| `stopRecording()` | Normaler Stop | F9 zum Beenden, Verarbeitung folgt |
| `forceStop()` | Sofortiger Abbruch | Cancel, Fehler, App-Quit |

```javascript
// forceStop() - Sofortiger Abbruch ohne Verarbeitung
async function forceStop() {
  recordingState = 'stopping';  // WICHTIG: VOR kill setzen!
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
  }
  // Kein Promise, kein Warten auf close-Event
}
```

**Wichtig:** `recordingState = 'stopping'` muss VOR dem Kill gesetzt werden, sonst erkennt der close-Handler es als Crash.

### Abbruch während Startup-Phase

User kann während "Aufnahme wird gestartet..." abbrechen:

```javascript
// Flag in main.js
let recordingStartCancelled = false;

// Am Anfang von startRecording()
recordingStartCancelled = false;

// Im cancel-recording Handler
if (!isRecording) {
  recordingStartCancelled = true;  // Startup abbrechen
  return;
}

// In startRecording() und startRecordingWithVAD()
if (recordingStartCancelled) {
  console.log('[Recording] Cancelled during startup');
  return;  // Abbruch vor FFmpeg-Start
}
```

### Cancel-Handler (main.js)

```javascript
ipcMain.on('cancel-recording', async () => {
  hideStatusOverlay();

  // Fall 1: Noch in Startup-Phase
  if (!isRecording) {
    recordingStartCancelled = true;
    return;
  }

  // Fall 2: Aufnahme läuft
  dashboardWindow?.webContents.send('recording-stopped');
  await audioRecorder.forceStop();

  // Temp-Datei löschen (nicht speichern bei Cancel)
  if (currentRecordingPath && fs.existsSync(currentRecordingPath)) {
    fs.unlinkSync(currentRecordingPath);
  }

  // State zurücksetzen
  isRecording = false;
  isVadSession = false;
  isProcessing = false;
});
```

### Cleanup bei App-Quit

```javascript
app.on('will-quit', async () => {
  globalShortcut.unregisterAll();

  // Aktive Aufnahme stoppen
  if (isRecording) {
    await audioRecorder.forceStop();
  }

  cleanupMicTestFile();
});
```

### Szenarien und Cleanup

| Szenario | Cleanup-Methode | Temp-Datei |
|----------|-----------------|------------|
| Normaler Stop (F9) | `stopRecording()` | Behalten → Verarbeitung |
| Cancel via X-Button | `forceStop()` | Löschen |
| Cancel während Startup | Flag abbricht | Keine erstellt |
| Fehler während Aufnahme | `forceStop()` | Löschen |
| App-Quit während Aufnahme | `forceStop()` | OS räumt auf |
| Voice Enrollment Cancel | `forceStop()` | Löschen |

---

## Mikrofon-Eingangslautstärke (Windows)

### Zweck

Anzeige und Steuerung der Windows-Mikrofon-Eingangslautstärke direkt in Settings und Setup-Wizard. Erspart das Öffnen der Windows Sound-Einstellungen.

### Implementierung

Verwendet PowerShell `Add-Type` mit C# COM Interop für Windows Core Audio API:

```
IMMDeviceEnumerator
  └→ IMMDeviceCollection (Aufzählung aller Capture-Geräte)
       └→ IMMDevice
            ├→ IPropertyStore → PKEY_Device_FriendlyName (Name-Matching)
            └→ IAudioEndpointVolume → GetMasterVolumeLevelScalar / SetMasterVolumeLevelScalar
```

### Geräte-Matching

Da FFmpeg/dshow und Windows Core Audio leicht unterschiedliche Namen verwenden können, wird bidirektionaler `IndexOf` (contains-Check) für robustes Matching verwendet:

```csharp
// Beispiel: FFmpeg sagt "Jabra Speak2 75", Core Audio sagt "Mikrofon (Jabra Speak2 75)"
if (deviceName.IndexOf(targetName) >= 0 || targetName.IndexOf(deviceName) >= 0)
  → Match!
```

### Einschränkung: Hardware DSP/AGC

Bei Geräten mit eingebautem DSP (z.B. Jabra Speak2 75) hat der Windows-Volume-Regler keinen hörbaren Effekt. Das Gerät steuert die Mic-Verstärkung selbst über Hardware-AGC. Der Slider zeigt und setzt den Windows-Wert korrekt, aber die tatsächliche Aufnahmelautstärke bleibt unverändert.

### UI-Verhalten

- **Kein Mikrofon ausgewählt:** Slider wird ausgeblendet
- **Mikrofon getrennt:** Slider wird bei `devicechange` automatisch ausgeblendet
- **Rückkehr von Windows Sound-Einstellungen:** Wert wird neu geladen

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
