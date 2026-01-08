# DentDoc Desktop - Architektur & Funktionsübersicht

## Was ist DentDoc?

Eine Electron Desktop-App für Zahnarztpraxen, die:
1. **Audio aufnimmt** (Gespräche zwischen Arzt/ZFA und Patient)
2. **Transkribiert** (via AssemblyAI Backend)
3. **Sprecher erkennt** (lokal mit Sherpa-ONNX)
4. **Dokumentation generiert** (via Backend-KI)
5. **In Zwischenablage kopiert** (für PVS-Übernahme)

---

## Dateistruktur

```
dentdoc-desktop/
├── main.js                      # Haupt-Electron-Prozess
├── src/
│   ├── apiClient.js             # Backend-Kommunikation
│   ├── audioRecorder.js         # Mikrofon-Aufnahme
│   ├── audio-converter.js       # FFmpeg WAV-Konvertierung
│   ├── speaker-recognition/
│   │   ├── index.js             # Sherpa-ONNX Speaker Recognition
│   │   └── voice-profiles.js    # Stimmprofil-Verwaltung
│   ├── bausteine/
│   │   ├── index.js             # Bausteine-Manager
│   │   └── defaults.js          # Standard-Bausteine
│   ├── login.html               # Login-Fenster
│   ├── settings.html            # Einstellungen
│   ├── voice-profiles.html      # Stimmprofil-Verwaltung UI
│   ├── status-overlay.html      # Status-Overlay (Aufnahme/Verarbeitung)
│   ├── feedback.html            # Feedback-Formular
│   └── bausteine/bausteine.html # Bausteine-Editor
├── models/
│   └── 3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx
└── assets/
    ├── icon.png
    ├── tray-icon.png
    └── tray-icon-recording.png
```

---

## Hauptfunktionen (main.js)

### Audio-Verarbeitung

| Funktion | Zeilen | Beschreibung |
|----------|--------|--------------|
| `startRecording()` | ~707-728 | Startet Mikrofon-Aufnahme, zeigt Status-Overlay |
| `stopRecording()` | ~730-760 | Stoppt Aufnahme, ruft `processAudioFile()` auf |
| `processAudioFile(audioFilePath)` | ~540-705 | **Kern-Funktion**: Upload, Transkription, Speaker Recognition, Dokumentation |
| `selectAndTranscribeAudioFile()` | ~503-537 | Öffnet Datei-Dialog für manuellen Audio-Upload |

### Ablauf processAudioFile()

```
1. Upload Audio → apiClient.uploadAudio()
2. Poll Transkription → apiClient.getTranscription() (alle 2 Sek)
3. Speaker Recognition → speakerRecognition.identifySpeakersFromUtterances()
4. Update Backend → apiClient.updateSpeakerMapping()
5. Dokumentation → apiClient.getDocumentation() oder getDocumentationV2()
6. Clipboard kopieren
7. Datei speichern → saveTranscriptToFile()
```

### Fenster-Verwaltung

| Funktion | Zeilen | Beschreibung |
|----------|--------|--------------|
| `createLoginWindow()` | ~339-360 | Login-Fenster |
| `openSettings()` | ~76-100 | Einstellungen-Fenster |
| `openVoiceProfiles()` | ~102-128 | Stimmprofil-Verwaltung |
| `openBausteine()` | ~130-156 | Bausteine-Editor |
| `openFeedback()` | ~158-182 | Feedback-Fenster |
| `createStatusOverlay()` | ~997-1085 | Status-Overlay (Aufnahme/Verarbeitung) |

### Hilfsfunktionen

| Funktion | Zeilen | Beschreibung |
|----------|--------|--------------|
| `registerShortcut(shortcut)` | ~184-217 | Registriert globalen Hotkey (Standard: F9) |
| `updateTrayMenu()` | ~398-500 | Aktualisiert System-Tray-Menü |
| `saveTranscriptToFile()` | ~265-337 | Speichert Transkript als .txt pro Arzt |
| `extractRolesFromSpeakerMapping()` | ~224-247 | Extrahiert Ärzte/ZFAs aus Speaker-Mapping |
| `showNotification()` | ~762-768 | System-Benachrichtigung |

---

## Speaker Recognition (src/speaker-recognition/index.js)

### Hauptfunktionen

| Funktion | Zeilen | Beschreibung |
|----------|--------|--------------|
| `initialize()` | ~42-96 | Initialisiert Sherpa-ONNX mit Modell |
| `extractAudioSegment(path, startMs, durationMs)` | ~107-158 | Liest WAV-Segment (optimiert: nur benötigte Bytes) |
| `createEmbedding(path, startMs, durationMs)` | ~160-181 | Erstellt Voice-Embedding (512-dim Vektor) |
| `identifySpeaker(path, startMs, durationMs, threshold)` | ~222-268 | Identifiziert einzelnen Sprecher |
| `identifySpeakersFromUtterances(audioPath, utterances)` | ~276-372 | **Kern**: Identifiziert alle Sprecher |
| `enrollSpeaker(name, audioPath, role)` | ~381-402 | Registriert neues Stimmprofil |
| `cosineSimilarity(emb1, emb2)` | ~189-212 | Berechnet Ähnlichkeit (0-1) |

### Ablauf identifySpeakersFromUtterances()

```
1. Konvertiere Audio zu 16kHz WAV (falls nötig)
2. Gruppiere Utterances nach Speaker (A, B, C...)
3. Für jeden Speaker:
   a. Sammle Audio-Segmente (max 30 Sek)
   b. Erstelle Embedding
   c. Vergleiche mit allen Profilen
   d. Match wenn Similarity >= 0.7 (70%)
4. Rückgabe: { "A": "Arzt - Dr. Müller", "B": "ZFA - Maria" }
```

### Performance-Optimierung (aktuell implementiert)

`extractAudioSegment()` liest nur die benötigten Bytes:
- Öffnet Datei mit File Handle
- Liest nur Header (44 Bytes) + benötigtes Segment
- Vorher: Ganze Datei bei jedem Aufruf (2.5 GB I/O bei langen Aufnahmen)
- Nachher: Nur ~1 MB pro Segment

---

## Audio Converter (src/audio-converter.js)

| Funktion | Beschreibung |
|----------|--------------|
| `convertToWav16k(inputPath, outputPath)` | Konvertiert zu 16kHz, Mono, 16-bit WAV |
| `convertAndReplace(webmPath)` | Konvertiert und löscht Original (optional) |

**FFmpeg-Befehl:**
```
ffmpeg -i input.webm -ar 16000 -ac 1 -acodec pcm_s16le -f wav output_16k.wav
```

---

## Voice Profiles (src/speaker-recognition/voice-profiles.js)

| Funktion | Beschreibung |
|----------|--------------|
| `getAllProfiles()` | Lädt alle gespeicherten Profile |
| `saveProfile(name, embedding, role)` | Speichert neues Profil |
| `deleteProfile(id)` | Löscht Profil |
| `setStorePath(path)` | Setzt Speicherpfad (Standard: Documents/DentDoc/Stimmprofile) |

**Profil-Struktur:**
```json
{
  "id": "uuid",
  "name": "Dr. Müller",
  "role": "Arzt",
  "embedding": [0.123, -0.456, ...],  // 512 Werte
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

## API Client (src/apiClient.js)

| Funktion | Endpoint | Beschreibung |
|----------|----------|--------------|
| `login(email, password)` | POST /auth/login | Benutzer-Login |
| `getUser(token)` | GET /user | Benutzer-Info (Minuten-Guthaben) |
| `uploadAudio(filePath, token)` | POST /transcribe | Audio hochladen |
| `getTranscription(id, token)` | GET /transcription/:id | Transkription abrufen |
| `updateSpeakerMapping(id, mapping, token)` | PUT /transcription/:id/speakers | Speaker-Mapping updaten |
| `getDocumentation(id, token)` | GET /documentation/:id | Dokumentation generieren |
| `getDocumentationV2(id, token, bausteine)` | POST /documentation/v2/:id | Agent-Kette mit Bausteinen |
| `submitFeedback(token, category, message)` | POST /feedback | Feedback senden |

---

## Einstellungen (electron-store)

| Key | Default | Beschreibung |
|-----|---------|--------------|
| `authToken` | - | JWT Token |
| `user` | - | Benutzer-Objekt |
| `shortcut` | "F9" | Aufnahme-Hotkey |
| `microphoneId` | null | Ausgewähltes Mikrofon |
| `transcriptPath` | Documents/DentDoc/Transkripte | Speicherpfad |
| `profilesPath` | Documents/DentDoc/Stimmprofile | Stimmprofil-Pfad |
| `autoExport` | true | Auto-Speichern aktiviert |
| `autoCloseOverlay` | false | Overlay nach Erfolg schließen |
| `deleteAudio` | true | Temp-Audio löschen |
| `docMode` | "single" | "single" oder "agent-chain" |
| `overlayPosition` | {x, y} | Overlay-Position |

---

## IPC Handler (main.js)

Wichtige IPC-Kanäle für Renderer ↔ Main Kommunikation:

| Handler | Beschreibung |
|---------|--------------|
| `login` | Login durchführen |
| `get-settings` / `save-settings` | Einstellungen laden/speichern |
| `get-voice-profiles` | Alle Stimmprofile laden |
| `start-voice-enrollment` | Stimmprofil-Aufnahme starten |
| `stop-voice-enrollment` | Aufnahme stoppen, Profil speichern |
| `cancel-voice-enrollment` | Aufnahme abbrechen |
| `delete-voice-profile` | Profil löschen |
| `get-bausteine` / `save-bausteine` | Bausteine verwalten |
| `copy-to-clipboard` | In Zwischenablage kopieren |
| `select-folder` | Ordner-Auswahl-Dialog |
| `open-folder` | Ordner im Explorer öffnen |

---

## Typischer Ablauf: Aufnahme → Dokumentation

```
User drückt F9
    ↓
startRecording()
    ↓
audioRecorder.startRecording() → WebM-Datei in %TEMP%/dentdoc/
    ↓
Status-Overlay: "Aufnahme läuft..."
    ↓
User drückt F9 erneut
    ↓
stopRecording()
    ↓
audioRecorder.stopRecording()
    ↓
processAudioFile(recordingPath)
    ├── Upload zu Backend
    ├── Warten auf Transkription (AssemblyAI)
    ├── Speaker Recognition (lokal):
    │   ├── convertToWav16k() → 16kHz WAV
    │   ├── Für jeden Speaker:
    │   │   ├── extractAudioSegment() (max 30 Sek)
    │   │   ├── createEmbedding() → 512-dim Vektor
    │   │   └── cosineSimilarity() mit allen Profilen
    │   └── Rückgabe: { A: "Arzt - Dr. X", B: "ZFA - Y" }
    ├── Dokumentation generieren (Backend)
    ├── clipboard.writeText(documentation)
    └── saveTranscriptToFile() → pro Arzt ein Ordner
    ↓
Status-Overlay: "Fertig! In Zwischenablage kopiert"
```

---

## Bekannte Dateipfade

- **Temp-Aufnahmen:** `%TEMP%/dentdoc/recording-*.webm`
- **16kHz WAV (temporär):** `%TEMP%/dentdoc/recording-*_16k.wav`
- **Transkripte:** `Documents/DentDoc/Transkripte/<ArztName>/`
- **Stimmprofile:** `Documents/DentDoc/Stimmprofile/profiles.json`
- **Debug-Log:** `%TEMP%/dentdoc-main-debug.log`
- **Speaker-Log:** `%TEMP%/dentdoc-debug.log`

---

## Changelog

### 2025-01-08

**Speaker Recognition Performance-Fix:**
- `extractAudioSegment()` in `src/speaker-recognition/index.js` optimiert
- Vorher: Las komplette WAV-Datei bei jedem Segment-Aufruf (z.B. 45x 57MB = 2.5GB I/O)
- Nachher: Liest nur Header (44 Bytes) + benötigtes Segment via File Handle
- Nutzt `fs.openSync/readSync` mit Position statt `fs.readFileSync`

**Code-Refactoring main.js:**
- `stopRecording()` von ~205 Zeilen auf ~30 Zeilen reduziert
- Ruft jetzt `processAudioFile(currentRecordingPath)` auf statt eigene Logik
- Beide Wege (Aufnahme + manueller Upload) nutzen denselben Code
- `processAudioFile()` erweitert um:
  - Utterances String/Object Parsing
  - "Keine Sprache erkannt" Check
  - Bessere Fehler-Kategorisierung (Guthaben, Verbindung, etc.)

---

## Version

Aktuelle Version: siehe `package.json`
Letztes Update dieser Dokumentation: 2025-01-08
