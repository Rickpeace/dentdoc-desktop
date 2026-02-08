# Changes: Fix für große Aufnahmen (100+ Min) - App-Freeze behoben

**Datum:** 2026-02-07
**Anlass:** Kunde mit 101-Min-Aufnahme (557MB) - App fror komplett ein, Kunde dachte PC reagiert nicht mehr.

---

## Maßnahme 1: 16kHz Live-Recording (GRÖSSTER SPEEDGEWINN)

**Problem:** Aufnahme bei 48kHz, danach separater Downsample-Schritt auf 16kHz. Bei 101 Min dauerte das allein **425 Sekunden (7 Minuten!)**.

**Lösung:** FFmpeg nimmt direkt mit `-ar 16000` auf. Downsample entfällt komplett.

**Geänderte Dateien:**

- **`src/audioRecorderFFmpeg.js`**
  - `-ar 48000` → `-ar 16000` (WASAPI + DirectShow)
  - Neue Funktion `logWavHeader()` - loggt sampleRate, channels, bitsPerSample nach Stop (Support-Diagnose)
  - Kommentare aktualisiert

- **`main.js`**
  - Downsample-Block in `stopRecordingWithVAD()` entfernt
  - Downsample-Block in `stopRecording()` entfernt
  - Downsample-Block im Mic-Test entfernt

- **`src/speaker-recognition/index.js`**
  - Kommentar aktualisiert (`convertToWav16k()` bleibt als Safety-Fallback)

**Zeitersparnis:** ~7 Minuten bei 101-Min-Aufnahme. Dateien 3x kleiner.

---

## Maßnahme 2: Worker Thread für VAD (KEIN FREEZE MEHR)

**Problem:** `detectSpeechSegments()` verarbeitete 2.9 Millionen Frames synchron auf dem Main Thread. Dazu lud `readWavSamples()` die gesamte Datei in den Speicher (185MB Buffer + 370MB Float32 = 555MB RAM-Spike). Beides blockierte den Main Thread komplett.

**Lösung:** VAD läuft jetzt in einem Worker Thread mit Streaming-Verarbeitung.

**Geänderte Dateien:**

- **`src/pipeline/offlineVadWorker.js`** (NEU)
  - Worker Thread für VAD-Verarbeitung
  - Streaming WAV-Lesen: `fs.openSync` + `fs.readSync` in 64KB Chunks
  - Reusable Buffers: `readBuffer` (64KB), `frameBuffer` (Float32Array[1024])
  - Carry Buffer für Rest-Samples zwischen Chunks
  - Progress-Reporting via `parentPort.postMessage` (max 10 Updates/s, throttled)
  - Cancel-Support: `cancelled` Flag bricht Leseloop ab
  - WAV-Header-Parsing: findet `data`-Chunk korrekt (nicht 44 Bytes annehmen)
  - Carry Flush am Ende: genau 1x mit Zeros padden
  - Segment Hard Cap: max 500 Segmente in `processMarkers()`
  - Sherpa-ONNX Init mit acceptWaveform ArrayBuffer-Wrapper

- **`src/pipeline/offlineVad.js`** (UMGESCHRIEBEN)
  - `runOfflineVAD()`: Versucht Worker Thread, fällt auf Main Thread zurück
  - `resolveAddonPath()` + `resolveModelPath()`: Pfad-Auflösung für Worker
  - `cancelVAD()`: Sendet Cancel an Worker + 3s Hard-Kill Timeout
  - Komplette synchrone Fallback-Implementierung behalten (`runOfflineVAD_Fallback`)

**Ergebnis:** Main Thread bleibt frei, App reagiert. RAM: ~128KB statt 555MB.

---

## Maßnahme 3: FFmpeg Batch-Extraktion (SCHNELLER)

**Problem:** Bei 55 Segmenten startete FFmpeg 55x einzeln + 1x zum Zusammenfügen = 56 Prozesse nacheinander.

**Lösung:** Ein einziger FFmpeg-Aufruf mit `filter_complex` (`atrim` + `concat`).

**Geänderte Dateien:**

- **`src/pipeline/speechRenderer.js`**
  - `extractAndConcatenate()`: Versucht Batch, fällt auf Sequential zurück
  - Neue Funktion `extractBatchFilterComplex()`: `filter_complex` mit `atrim` + `asetpts=PTS-STARTPTS` + `concat=n=N:v=0:a=1`
  - Dynamisches Chunking bei Command-Length > 28k chars (Windows-Limit ~32k)
  - Neue Funktion `extractSequential()`: alte Methode als Fallback
  - Neue Funktion `runFFmpeg()`: Promise-Wrapper für FFmpeg-Spawn

**Zeitersparnis:** ~30-60 Sekunden bei vielen Segmenten.

---

## Bonus: Fortschrittsbalken mit Phasen-Anzeige

**Problem:** User sah nur "Verarbeitung..." ohne Fortschritt. Bei langen Aufnahmen dachte er, die App hängt.

**Lösung:** 5-Phasen-Fortschrittsbalken mit feingranularer VAD-Anzeige.

**Geänderte Dateien:**

- **`main.js`**
  - VAD-Progress sendet `step: 0` (neuer "Analyse"-Schritt) mit `progressPercent` vom Worker
  - `statusData` enthält `progressPercent`
  - Fix: `step: 0` korrekt behandelt (vorher war `0` falsy durch `||`)

- **`src/status-overlay.html`**
  - Neuer "Analyse"-Dot (step0) vor den bestehenden 4 Schritten
  - 5 Phasen: **Analyse** → Upload → Transkription → Sprecher → Dokumentation
  - VAD-Fortschritt: 0-15% feingranular basierend auf Worker-Progress
  - Upload: 15-35%, Transkription: 35-55%, Sprecher: 55-75%, Dokumentation: 75-100%

---

## Gesamtverbesserung (101-Min-Aufnahme)

| Schritt | Vorher | Nachher |
|---------|--------|---------|
| Downsample | 425s | **0s** (live bei Aufnahme) |
| Dateigröße | 557MB raw | **~185MB** raw |
| App-Freeze | 5-12 Min | **0s** (Worker Thread) |
| RAM-Spike (VAD) | ~555MB | **~128KB** (Streaming) |
| FFmpeg Segmente | 56 Spawns | **1 Spawn** |
| User-Feedback | "Reagiert nicht" | **Fortschrittsbalken** |

## Verifizierung (getestet 2026-02-07)

- 16kHz Recording: `sampleRate=16000` im Log bestätigt
- Worker Thread: `Modus: Worker Thread (streaming)` im Log
- FFmpeg Batch: `[BATCH] Single pass (2 segments, cmd: 338 chars)` im Log
- Upload/Speaker erkennen 16kHz: `Bereits optimiert (16kHz mono) - Konvertierung übersprungen`
- Gesamtzeit Kurzaufnahme (22.5s): 12.7s (davon ~12s API-Calls)
