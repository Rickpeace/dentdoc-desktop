# Data Storage - Datenspeicherung

> Dokumentation für electron-store, Dateipfade und Export

## Übersicht

Die App verwendet mehrere Speichermechanismen:

| Typ | Technologie | Zweck |
|-----|-------------|-------|
| Einstellungen | electron-store | Persistente JSON-Datei |
| Transkripte | JSON-Dateien | Export in User-Ordner |
| Audio | WebM/WAV-Dateien | Temporär oder persistent |
| Stimmprofile | JSON-Dateien | User-definierter Pfad |

---

## electron-store

### Speicherort

```
Windows: C:\Users\{username}\AppData\Roaming\dentdoc-desktop\config.json
```

### Alle Keys

#### Authentication
```javascript
store.get('authToken')        // JWT Token (string)
store.get('user')             // User-Objekt
store.get('deviceId')         // Eindeutige Geräte-ID (UUID)
```

#### Recording Settings
```javascript
store.get('shortcut', 'F9')           // Aufnahme-Shortcut
store.get('selectedMicrophone')       // Mikrofon Device-ID
store.get('recordingMode', 'standard') // 'standard' | 'iphone' | 'vad'
```

#### Export Settings
```javascript
store.get('autoExport', false)        // Auto-Export aktiviert?
store.get('transcriptSavePath')       // Transkript-Export-Pfad
store.get('keepAudio', false)         // Audio behalten?
store.get('audioSavePath')            // Audio-Speicherpfad
```

#### Voice Profiles
```javascript
store.get('profilesPath')             // Stimmprofile-Pfad
```

#### UI Settings
```javascript
store.get('theme', 'dark')            // 'dark' | 'light'
store.get('overlayPosition')          // { x, y } Overlay-Position
store.get('autoCloseOverlay', false)  // Overlay auto-schließen?
```

#### Onboarding
```javascript
store.get('hasSeenTrayHint', false)   // Tray-Hinweis gezeigt?
store.get('tourCompleted_general')    // Tour abgeschlossen?
store.get('setupWizardCompleted')     // Setup-Wizard fertig?
```

#### Statistics
```javascript
store.get('recordingCount', 0)        // Anzahl Aufnahmen
store.get('totalRecordingMinutes', 0) // Gesamte Aufnahmezeit
```

---

## User-Objekt

```javascript
const user = store.get('user');
// {
//   id: 123,
//   email: "user@example.com",
//   name: "Dr. Müller",
//   planTier: "pro",           // "pro" | "free_trial"
//   subscriptionStatus: "active", // "active" | "canceled" | null
//   minutesRemaining: 500,     // Nur bei free_trial
//   maxDevices: 1,
//   stripeCustomerId: "cus_xxx"
// }
```

---

## Dateipfade

### Standard-Pfade

```javascript
const path = require('path');
const os = require('os');
const { app } = require('electron');

// Temporär
const tempDir = os.tmpdir();
// → C:\Users\{user}\AppData\Local\Temp

// Documents
const documentsDir = app.getPath('documents');
// → C:\Users\{user}\Documents

// App Data
const appDataDir = app.getPath('userData');
// → C:\Users\{user}\AppData\Roaming\dentdoc-desktop
```

### DentDoc-Ordner

```javascript
// Standard-Basisordner
const dentdocBase = path.join(documentsDir, 'DentDoc');

// Transkripte (wenn autoExport=true)
const transcriptPath = store.get('transcriptSavePath') ||
  path.join(dentdocBase, 'Transkripte');

// Audio (wenn keepAudio=true)
const audioPath = store.get('audioSavePath') ||
  path.join(dentdocBase, 'Audio');

// Stimmprofile
const profilesPath = store.get('profilesPath') ||
  path.join(dentdocBase, 'Stimmprofile');

// Fehlgeschlagene Aufnahmen (Backup)
const failedPath = path.join(dentdocBase, 'Fehlgeschlagen');
```

### Ordnerstruktur

```
C:\Users\{user}\Documents\DentDoc\
├── Transkripte\
│   ├── 2026-01-15_14-30-25_transkript.json
│   ├── 2026-01-15_15-45-10_transkript.json
│   └── ...
│
├── Audio\
│   ├── 2026-01-15_14-30-25.webm
│   ├── 2026-01-15_15-45-10.webm
│   └── ...
│
├── Stimmprofile\
│   ├── dr-mueller.json
│   ├── zfa-schmidt.json
│   └── ...
│
└── Fehlgeschlagen\
    └── 2026-01-14_09-15-30.webm  (Backup bei Fehler)
```

---

## Transkript-Format

### Dateiname

```javascript
const timestamp = new Date().toISOString()
  .replace(/[:.]/g, '-')
  .slice(0, 19);
// → "2026-01-15_14-30-25"

const filename = `${timestamp}_transkript.json`;
```

### JSON-Struktur

```javascript
{
  // Metadaten
  "id": 12345,
  "createdAt": "2026-01-15T14:30:25.000Z",
  "duration": 45.5,  // Sekunden

  // Transkript
  "transcriptText": "Roher Transkript-Text...",
  "reconstructedTranscript": "Bereinigter Text...",
  "transcriptWithSpeakers": "Zahnarzt: ...\nPatient: ...",

  // Utterances (Sprecher-Segmente)
  "utterances": [
    {
      "speaker": "A",
      "start": 0,
      "end": 5000,
      "text": "Guten Tag, was führt Sie zu uns?"
    },
    {
      "speaker": "B",
      "start": 5500,
      "end": 12000,
      "text": "Ich habe seit einer Woche Zahnschmerzen."
    }
  ],

  // Sprecher-Mapping
  "speakerMapping": {
    "A": { "role": "Zahnarzt", "name": "Dr. Müller" },
    "B": { "role": "Patient", "name": null }
  },

  // Dokumentation
  "documentation": "Patientin berichtet über...",
  "kzvDocumentation": "Anamnese:\n...",

  // Befunde
  "detection": { "has01": true, "hasPA": false },
  "status01": { "teeth": [...] },
  "statusPA": null,

  // Audio-Pfad (wenn keepAudio=true)
  "audioPath": "C:\\Users\\...\\Audio\\2026-01-15_14-30-25.webm"
}
```

---

## Stimmprofile

### Dateiformat

```javascript
// dr-mueller.json
{
  "id": "uuid-1234-5678",
  "name": "Dr. Müller",
  "role": "Zahnarzt",
  "createdAt": "2026-01-10T10:00:00.000Z",
  "embedding": [0.123, -0.456, 0.789, ...]  // 256-dim Float-Array
}
```

### voice-profiles.js API

```javascript
const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

// Pfad setzen (einmal bei App-Start)
voiceProfiles.setStorePath('/path/to/profiles');

// Alle Profile laden
const profiles = voiceProfiles.loadAllProfiles();
// → [{ id, name, role, embedding }, ...]

// Profil speichern
await voiceProfiles.saveProfile({
  name: 'Dr. Müller',
  role: 'Zahnarzt',
  embedding: [...]
});

// Profil löschen
voiceProfiles.deleteProfile('uuid-1234-5678');
```

---

## Auto-Export

### Aktivierung

```javascript
// Im Setup-Wizard oder Einstellungen
store.set('autoExport', true);
store.set('transcriptSavePath', 'C:\\Users\\...\\Transkripte');
```

### Export-Logik (main.js)

```javascript
async function saveTranscriptToFile(data) {
  const autoExport = store.get('autoExport', false);
  if (!autoExport) return;

  const savePath = store.get('transcriptSavePath');
  if (!savePath) return;

  // Ordner erstellen falls nötig
  if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
  }

  // Datei schreiben
  const filename = `${getTimestamp()}_transkript.json`;
  const filepath = path.join(savePath, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  console.log(`Transkript gespeichert: ${filepath}`);
}
```

---

## Audio-Speicherung

### Temporär (Standard)

```javascript
// Aufnahme wird in temp gespeichert
const tempPath = path.join(os.tmpdir(), `dentdoc-recording-${Date.now()}.webm`);

// Nach erfolgreicher Verarbeitung: Löschen
fs.unlinkSync(tempPath);
```

### Persistent (keepAudio=true)

```javascript
const keepAudio = store.get('keepAudio', false);
if (keepAudio) {
  const audioSavePath = store.get('audioSavePath');
  const filename = `${getTimestamp()}.webm`;
  const destPath = path.join(audioSavePath, filename);

  // Kopieren statt verschieben (temp bleibt für Verarbeitung)
  fs.copyFileSync(tempPath, destPath);
}
```

### Backup bei Fehler

```javascript
// Bei Verarbeitungsfehler: Audio sichern
const failedPath = path.join(dentdocBase, 'Fehlgeschlagen');
if (!fs.existsSync(failedPath)) {
  fs.mkdirSync(failedPath, { recursive: true });
}

const backupPath = path.join(failedPath, `${getTimestamp()}.webm`);
fs.copyFileSync(tempPath, backupPath);
savedAudioPathInBackup = backupPath;

// Bei späterem Erfolg: Backup löschen
if (savedAudioPathInBackup && fs.existsSync(savedAudioPathInBackup)) {
  fs.unlinkSync(savedAudioPathInBackup);
  savedAudioPathInBackup = null;
}
```

---

## Archiv-Funktion (Dashboard)

### Transkripte laden

```javascript
// IPC Handler in main.js
ipcMain.handle('get-all-transcripts', async () => {
  const savePath = store.get('transcriptSavePath');
  if (!savePath || !fs.existsSync(savePath)) {
    return [];
  }

  const files = fs.readdirSync(savePath)
    .filter(f => f.endsWith('_transkript.json'))
    .sort()
    .reverse();  // Neueste zuerst

  return files.map(filename => {
    const filepath = path.join(savePath, filename);
    const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return {
      filename,
      filepath,
      createdAt: content.createdAt,
      preview: content.documentation?.substring(0, 100) + '...'
    };
  });
});
```

### Transkript-Detail laden

```javascript
ipcMain.handle('get-transcript-detail', async (event, filepath) => {
  if (!fs.existsSync(filepath)) {
    throw new Error('Transkript nicht gefunden');
  }

  const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return content;
});
```

### Audio laden

```javascript
ipcMain.handle('get-transcript-audio', async (event, audioPath) => {
  if (!audioPath || !fs.existsSync(audioPath)) {
    return null;
  }

  const buffer = fs.readFileSync(audioPath);
  return buffer.toString('base64');
});
```

---

## Pfad-Auswahl Dialog

```javascript
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Ordner auswählen'
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});
```

---

## Migration / Cleanup

### Alte Daten entfernen

```javascript
// Bei Major-Update: Alte Keys entfernen
store.delete('oldSettingKey');
store.delete('deprecatedFeature');
```

### Pfad-Validierung

```javascript
function validatePath(storedPath, defaultPath) {
  if (storedPath && fs.existsSync(storedPath)) {
    return storedPath;
  }

  // Fallback zu Default
  if (!fs.existsSync(defaultPath)) {
    fs.mkdirSync(defaultPath, { recursive: true });
  }
  return defaultPath;
}
```

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [main-process.md](main-process.md) - Store-Verwendung
- [renderer-process.md](renderer-process.md) - Settings-UI
