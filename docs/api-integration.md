# API Integration - Backend-Kommunikation

> Dokumentation für `src/apiClient.js` und Backend-Endpoints

## Übersicht

Die Desktop-App kommuniziert mit dem Backend über REST API:

```
Desktop App  →  Upload-Proxy (Railway)  →  AssemblyAI
             →  Backend (Vercel)        →  Database/OpenAI
```

### URLs

```javascript
// Production
API_BASE_URL = 'https://dentdoc.de/'
UPLOAD_PROXY_URL = 'https://dentdoc-upload-proxy.up.railway.app'

// Development (via .env.local)
API_BASE_URL = 'http://localhost:3000/'
```

---

## apiClient.js Funktionen

### Authentication

#### `login(email, password, store)`

```javascript
const response = await apiClient.login(email, password, store);
// response: { token, user }
```

**Request:**
```http
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "...",
  "deviceId": "uuid",
  "deviceName": "DESKTOP-ABC",
  "deviceInfo": { "os": "win32 10.0.22000", "hostname": "...", "arch": "x64" }
}
```

**Fehler:**
- `max_devices_reached` - Zu viele Geräte eingeloggt

---

#### `logout(token, store)`

```javascript
await apiClient.logout(token, store);
```

**Request:**
```http
POST /api/auth/logout
Authorization: Bearer <token>
{ "deviceId": "uuid" }
```

---

#### `heartbeat(token, store)`

```javascript
const isValid = await apiClient.heartbeat(token, store);
// true = Session gültig, false = Session abgelaufen
```

**Request:**
```http
POST /api/device/heartbeat
Authorization: Bearer <token>
{ "deviceId": "uuid" }
```

**Automatisch aufgerufen:** Alle 5 Minuten durch `session.js`

---

#### `getUser(token)`

```javascript
const user = await apiClient.getUser(token);
```

**Response:**
```javascript
{
  id: 123,
  email: "user@example.com",
  name: "Dr. Müller",
  planTier: "pro",  // oder "free_trial"
  subscriptionStatus: "active",  // oder "canceled", null
  minutesRemaining: 500,  // nur bei free_trial relevant
  maxDevices: 1,
  stripeCustomerId: "cus_xxx"
}
```

---

### Audio Upload

#### `uploadAudio(audioFilePath, token, onProgress)`

**Drei-Stufen-Prozess:**
1. Audio optimieren (FFmpeg Filterung)
2. Upload zu Railway Proxy → AssemblyAI
3. Backend informieren zum Start der Transkription

```javascript
const transcriptionId = await apiClient.uploadAudio(
  '/path/to/audio.webm',
  token,
  (progress) => {
    // progress: { phase, percent, message }
    // phase: 'prepare' | 'upload' | 'submit' | 'submitted'
    console.log(`${progress.phase}: ${progress.percent}%`);
  }
);
```

**Upload-Flow im Detail:**

```
┌──────────────────────────────────────────────────────┐
│ 1. Audio-Optimierung (lokal)                         │
│    convertForAssemblyAI(audioPath)                   │
│    → Highpass 200Hz, Lowpass 3000Hz                  │
│    → Mono, 16kHz, 16-bit WAV                         │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ 2. Upload zu Railway Proxy                           │
│    POST https://dentdoc-upload-proxy.up.railway.app  │
│    Authorization: Bearer UPLOAD_PROXY_TOKEN          │
│    Content-Type: application/octet-stream            │
│    → Railway leitet zu AssemblyAI weiter             │
│    ← Erhält upload_url zurück                        │
└───────────────────────┬──────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────┐
│ 3. Transkription starten                             │
│    POST /api/transcriptions/start                    │
│    { upload_url, fileName }                          │
│    ← Erhält transcriptionId zurück                   │
└──────────────────────────────────────────────────────┘
```

**Warum Railway Proxy?**
- AssemblyAI API-Key bleibt serverseitig
- Vercel hat 4.5MB Upload-Limit
- Railway erlaubt größere Uploads

---

### Transcription Status

#### `getTranscriptionStatus(transcriptionId, token)`

```javascript
const status = await apiClient.getTranscriptionStatus(transcriptionId, token);
// status: 'processing' | 'completed' | 'error'
```

**Request:**
```http
GET /api/transcriptions/{id}/status
Authorization: Bearer <token>
```

---

#### `waitForTranscription(transcriptionId, token, onProgress, timeout)`

```javascript
const result = await apiClient.waitForTranscription(
  transcriptionId,
  token,
  (status) => console.log(`Status: ${status}`),
  180000  // 3 Minuten Timeout
);
```

**Polling-Verhalten:**
- Fragt alle 2 Sekunden Status ab
- Bricht nach Timeout ab
- Gibt Transkript zurück wenn fertig

---

### Documentation Generation

#### `getDocumentationAgentV2_1(transcriptionId, token)`

**Der Haupt-Endpoint für Dokumentationsgenerierung (Agent V2.1)**

```javascript
const result = await apiClient.getDocumentationAgentV2_1(transcriptionId, token);
```

**Response:**
```javascript
{
  documentation: "Patientin berichtet über...",
  kzvDocumentation: "Anamnese: ...",  // Optional
  transcript: "Roher Transkript-Text",
  reconstructedTranscript: "Bereinigter Text",
  transcriptWithSpeakers: "Zahnarzt: ...\nPatient: ...",
  recognizedSpeakers: ["Dr. Müller", "Unbekannt"],
  stages: { ... },  // Debug-Info
  detection: { has01: true, hasPA: false },
  status01: { teeth: [...] },  // Zahnschema wenn erkannt
  statusPA: { ... }  // PA-Status wenn erkannt
}
```

**Pipeline auf dem Backend:**
1. Agent 1 (Rekonstruktion) - Bereinigt Transkript
2. Agent X (Detektor) - Erkennt 01/PA-Befund
3. 01-Extractor (optional) - Extrahiert Zahnstatus
4. PA-Extractor (optional) - Extrahiert PA-Status
5. Agent 2 (Dokumentation) - Erstellt finale Doku

**Timeout:** 5 Minuten (wegen Multi-Agent-Pipeline)

---

### Speaker Mapping

#### `updateSpeakerMapping(transcriptionId, speakerMapping, token)`

```javascript
await apiClient.updateSpeakerMapping(transcriptionId, {
  "A": { role: "Zahnarzt", name: "Dr. Müller" },
  "B": { role: "Patient", name: null }
}, token);
```

**Request:**
```http
POST /api/transcriptions/{id}/speaker-mapping
{ "speakerMapping": { ... } }
```

---

### Debug Logs

#### `uploadDebugLogs(token, store, logs, appVersion, context)`

Lädt Debug-Logs zur Remote-Fehlerbehebung hoch.

```javascript
await apiClient.uploadDebugLogs(token, store, logs, appVersion, 'manual');
```

**Request:**
```http
POST /api/debug-logs
Authorization: Bearer <token>
{
  "deviceId": "uuid",
  "hostname": "DESKTOP-ABC",
  "appVersion": "1.6.13",
  "logs": "...",
  "uploadReason": "startup" | "error" | "manual" | "unknown"
}
```

**Upload-Reason Mapping:**

Der `context` Parameter wird zu `uploadReason` konvertiert:

| Context | uploadReason |
|---------|--------------|
| `'startup'` | `'startup'` |
| `'manual'` | `'manual'` |
| Enthält `'error'`, `'timeout'`, `'warning'` | `'error'` |
| Alles andere | `'unknown'` |

**Auto-Upload (main.js):**

```javascript
// Fire-and-forget Upload bei Errors
autoUploadDebugLogs('toggle-pause-error');
autoUploadDebugLogs('recording-timeout');
autoUploadDebugLogs('startup');
```

**Auto-Upload Triggers:**
- `startup` - Bei App-Start (eingeloggt)
- `toggle-pause-error` - Pause/Resume fehlgeschlagen
- `recording-timeout` - Aufnahme Timeout
- `manual` - User klickt "Debug-Logs senden"

---

## Backend Endpoints (Vercel)

### Auth

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/auth/login` | POST | Login mit Device-Tracking |
| `/api/auth/logout` | POST | Logout (Device freigeben) |
| `/api/auth/register` | POST | Registrierung |
| `/api/auth/forgot-password` | POST | Passwort-Reset |

### User

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/user` | GET | User-Daten abrufen |
| `/api/user/settings` | GET/PUT | User-Einstellungen |

### Devices

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/device/heartbeat` | POST | Session Keep-Alive |
| `/api/devices` | GET | Liste aller Geräte |
| `/api/devices/{id}` | DELETE | Gerät entfernen |

### Transcriptions

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/transcriptions/start` | POST | Transkription starten |
| `/api/transcriptions/{id}/status` | GET | Status abrufen |
| `/api/transcriptions/{id}` | GET | Transkript abrufen |
| `/api/transcriptions/{id}/generate-doc-agent-v2.1` | POST | Dokumentation (Agent V2.1) |
| `/api/transcriptions/{id}/speaker-mapping` | POST | Speaker-Mapping updaten |

### Subscription

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/subscription` | GET | Abo-Status |
| `/api/subscription/portal` | GET | Stripe Portal URL |

### Voice Profiles

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/voice-profiles` | GET | Alle Stimmprofile abrufen |
| `/api/voice-profiles` | POST | Neues Stimmprofil erstellen |
| `/api/voice-profiles/{id}` | GET | Einzelnes Profil abrufen |
| `/api/voice-profiles/{id}` | PATCH | Profil aktualisieren |
| `/api/voice-profiles/{id}` | DELETE | Profil löschen |

### Debug

| Endpoint | Method | Beschreibung |
|----------|--------|--------------|
| `/api/debug-logs` | POST | Debug-Logs hochladen |

---

### Voice Profiles

#### `getVoiceProfiles(token)`

```javascript
const profiles = await apiClient.getVoiceProfiles(token);
// profiles: [{ id, name, role, confirmedEmbeddings, pendingEmbeddings, centroid, ... }]
```

**Request:**
```http
GET /api/voice-profiles
Authorization: Bearer <token>
```

---

#### `createVoiceProfile(token, data)`

```javascript
const profile = await apiClient.createVoiceProfile(token, {
  name: 'Dr. Müller',
  role: 'Arzt',
  confirmedEmbeddings: '[]',
  pendingEmbeddings: '[]'
});
```

**Request:**
```http
POST /api/voice-profiles
Authorization: Bearer <token>
{ "name": "Dr. Müller", "role": "Arzt", ... }
```

---

#### `updateVoiceProfile(token, id, data)`

```javascript
const profile = await apiClient.updateVoiceProfile(token, 5, {
  confirmedEmbeddings: '[...]',
  centroid: '[...]'
});
```

**Request:**
```http
PATCH /api/voice-profiles/{id}
Authorization: Bearer <token>
{ "confirmedEmbeddings": "[...]", "centroid": "[...]" }
```

---

#### `deleteVoiceProfile(token, id)`

```javascript
await apiClient.deleteVoiceProfile(token, 5);
```

**Request:**
```http
DELETE /api/voice-profiles/{id}
Authorization: Bearer <token>
```

---

## Fehlerbehandlung

### Standard-Fehler

```javascript
try {
  const result = await apiClient.someFunction();
} catch (error) {
  if (error.message.startsWith('TRIAL_EXPIRED:')) {
    // Trial abgelaufen - Upgrade-Dialog zeigen
  } else if (error.message.startsWith('SUBSCRIPTION_INACTIVE:')) {
    // Abo nicht aktiv - Zahlungsstatus prüfen
  } else if (error.message.startsWith('MAX_DEVICES:')) {
    // Zu viele Geräte - Geräteverwaltung öffnen
  }
}
```

### Netzwerk-Fehler

| Error Code | Bedeutung | User-Message |
|------------|-----------|--------------|
| `ECONNREFUSED` | Server offline | "Server nicht erreichbar" |
| `ECONNRESET` | Verbindung abgebrochen | "Verbindung abgebrochen" |
| `ECONNABORTED` | Timeout | "Zeitüberschreitung" |
| `ENOTFOUND` | DNS-Fehler | "Server nicht gefunden" |

---

## Hilfsfunktionen

### `getDeviceId(store)`

Generiert/speichert eindeutige Device-ID:

```javascript
function getDeviceId(store) {
  let deviceId = store.get('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    store.set('deviceId', deviceId);
  }
  return deviceId;
}
```

### `getDeviceInfo()`

Sammelt Geräte-Informationen:

```javascript
function getDeviceInfo() {
  return {
    os: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    arch: os.arch(),
  };
}
```

### `getBaseUrl()`

```javascript
function getBaseUrl() {
  return API_BASE_URL;
}
```

---

## Umgebungsvariablen

```env
# .env (Production)
API_URL=https://dentdoc.de/
UPLOAD_PROXY_URL=https://dentdoc-upload-proxy.up.railway.app
UPLOAD_PROXY_TOKEN=secret-token

# .env.local (Development)
API_URL=http://localhost:3000/
```

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [documentation-flow.md](documentation-flow.md) - Agent V2.1 Details
- [main-process.md](main-process.md) - Verwendung in main.js
