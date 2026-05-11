# Data Storage - Datenspeicherung

> Dokumentation für electron-store, Dateipfade und Export

## Übersicht

Die App verwendet mehrere Speichermechanismen:

| Typ | Technologie | Zweck |
|-----|-------------|-------|
| Einstellungen | electron-store | Persistente JSON-Datei |
| Transkripte | JSON-Dateien | Export in User-Ordner |
| Audio | WebM/WAV-Dateien | Temporär oder persistent |
| Stimmprofile | Backend DB (PostgreSQL) | API + In-Memory Cache |

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
store.get('microphoneName')           // Mikrofon-Name (für Volume-Control & Matching)
store.get('recordingMode', 'standard') // 'standard' | 'iphone' | 'vad'
```

#### Export Settings
```javascript
store.get('autoExport', true)         // Auto-Export der Text-Dokumentation
store.get('transcriptPath')           // Transkript-Export-Pfad (nur Text + JSON, nie Audio)
```

> **DSGVO**: Setting `keepAudio` und `audioSavePath` wurden in v1.10.0 entfernt. Audio wird nie permanent gespeichert.

#### UI Settings
```javascript
store.get('theme', 'dark')            // 'dark' | 'light'
store.get('overlayPosition')          // { x, y } Overlay-Position
store.get('autoCloseOverlay', false)  // Overlay auto-schließen?
```

#### Auto-Update
```javascript
store.get('pendingUpdateVersion')     // Ausstehende Update-Version (z.B. "1.8.0")
// Wird bei update-downloaded gesetzt, bei erfolgreichem Start gelöscht
// Ermöglicht Startup-Fallback wenn autoInstallOnAppQuit nicht greifen konnte
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

// Transkripte (wenn autoExport=true) — NUR Text + JSON, niemals Audio
const transcriptPath = store.get('transcriptPath') ||
  path.join(dentdocBase, 'Transkripte');
```

> **DSGVO (v1.10.0+)**: Es gibt keinen `Audio\`-Ordner und keinen `Fehlgeschlagen\`-Ordner mehr. Audiodateien werden niemals persistent gespeichert — auch nicht als Backup bei Fehlern.

### Ordnerstruktur

```
C:\Users\{user}\Documents\DentDoc\
└── Transkripte\
    └── {Doctor-Name}\
        ├── 2026-01-15_14-30-25_jobid.txt    (Behandlungs-Doku, formatiert)
        ├── 2026-01-15_14-30-25_jobid.json   (Utterances + Sprecher-Mapping)
        └── ...
```

### Temporäre Audio-Puffer

```
C:\Users\{user}\AppData\Local\Temp\dentdoc\
├── a3f9c1e2.dat              (Hauptaufnahme, opaker Name)
├── bba7d46f-s2.dat           (Pause/Resume-Segment 2)
├── 1df8e2db-p.dat            (VAD-verarbeitete Speech-Only)
├── _session_cache.dat        (Speaker-Optimization-Cache, falls aktiv)
└── pipeline\
    ├── 8a3c91e0-c.dat        (Konvertiert für AssemblyAI)
    └── d4b2f7a8-aai.dat      (AssemblyAI-optimiert)
```

Diese Dateien existieren nur während der aktiven Verarbeitung (Sekunden bis wenige Minuten), werden nach jeder Pipeline-Stufe secure-deleted (Überschreiben mit Random + Unlink), und beim App-Start sowie App-Beenden ausnahmslos komplett gewipt.

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
  "statusPA": null

  // Hinweis (v1.10.0+): Es gibt kein audioPath-Feld mehr.
  // Audio wird niemals persistiert, also gibt es auch nichts zu verlinken.
}
```

---

## Stimmprofile (Backend DB)

### Speicherort

Stimmprofile werden in der PostgreSQL-Datenbank (Supabase) gespeichert und beim App-Start in einen In-Memory Cache geladen. Lese-Operationen greifen auf den Cache zu (sync), Schreib-Operationen gehen über die REST API (async).

### Datenbankschema

```sql
voice_profiles (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  name            VARCHAR(100) NOT NULL,
  role            VARCHAR(20) NOT NULL,        -- 'Arzt' | 'ZFA' | 'Sonstige'
  confirmed_embeddings TEXT DEFAULT '[]',       -- JSON-Array von Embedding-Objekten
  pending_embeddings   TEXT DEFAULT '[]',       -- JSON-Array von Pending-Embeddings
  centroid        TEXT,                         -- JSON-Array (512-dim Durchschnitts-Vektor)
  centroid_updated_at TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
)
```

### voice-profiles.js API

```javascript
const voiceProfiles = require('./src/speaker-recognition/voice-profiles');

// Initialisierung (bei Login/App-Start)
await voiceProfiles.init(apiClient, () => store.get('authToken'));

// Alle Profile (sync, aus Cache)
const profiles = voiceProfiles.getAllProfiles();
// → [{ id, name, role, confirmed_embeddings, pending_embeddings, centroid, ... }, ...]

// Profil erstellen (async, via API)
await voiceProfiles.saveProfile('Dr. Müller', embedding, 'Arzt');

// Embedding zu Profil hinzufügen (async)
await voiceProfiles.addConfirmedEmbedding(profileId, embedding, { sourceType: 'utterance' });

// Profil umbenennen (async)
await voiceProfiles.updateProfile(profileId, { name: 'Neuer Name' });

// Profil löschen (async, via API)
await voiceProfiles.deleteProfile(profileId);
```

**Wichtig:** Profile-IDs sind DB Serial Integers (nicht UUIDs). IPC vom Renderer sendet Strings — `voice-profiles.js` konvertiert intern mit `parseInt()`.

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

### Nur transient (v1.10.0+)

```javascript
const audioEncryption = require('./src/audio-encryption');

// Aufnahme wird mit opaken Random-Hex-Namen in app-privatem Temp angelegt
const tempPath = audioEncryption.audioTempPath(
  path.join(os.tmpdir(), 'dentdoc')
);  // z.B. C:\Users\xxx\AppData\Local\Temp\dentdoc\a3f9c1e2.dat

// Am Ende jeder Pipeline-Stufe (Erfolg ODER Fehler): secure-delete
//   (überschreibt einmal mit Random-Bytes, dann unlink)
await audioEncryption.secureDelete(tempPath);
```

### Kein Persistent-Modus

`keepAudio`/`audioSavePath` wurden entfernt. Es gibt keinen Code-Pfad, der eine Audio-Datei nach `Documents\` kopiert.

### Kein Backup bei Fehler

Der frühere `Fehlgeschlagen\`-Ordner und die Funktion `saveAudioImmediately()` wurden vollständig entfernt. Audiodaten werden auch bei Verarbeitungsfehlern nicht aufgehoben.

### Wipe-Mechanismen (Sicherheitsnetz)

- **App-Start**: `wipeAllTempAudio()` löscht alle Dateien in `%TEMP%\dentdoc\` und Subdirs, kein Age-Threshold
- **App-Beenden** (`will-quit`): nochmal `wipeAllTempAudio()`
- **Crash mid-recording**: Datei bleibt liegen → nächster App-Start wipt sie

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

> **Entfernt in v1.10.0**: Der IPC-Handler `get-transcript-audio` und alle Audio-Playback-UIs wurden entfernt. Audio existiert nicht mehr nach Pipeline-Ende, daher gibt's nichts zu laden.

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
