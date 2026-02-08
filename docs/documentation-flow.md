# Documentation Flow - Agent V2.1 Pipeline

> Dokumentation für den Prozess von Audio zu Behandlungsdokumentation

## Übersicht

Die App verwendet **Agent V2.1** - eine mehrstufige KI-Pipeline zur Dokumentationsgenerierung.

```
Audio → Transkription → Agent V2.1 Pipeline → Dokumentation
```

---

## Gesamtablauf

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Audio Upload                                                │
│    uploadAudio() → Railway Proxy → AssemblyAI                  │
└───────────────────────┬────────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. Transkription (AssemblyAI)                                  │
│    - Speech-to-Text                                            │
│    - Speaker Diarization (Sprecher A, B, C...)                 │
└───────────────────────┬────────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. Sprechererkennung (lokal, optional)                         │
│    - Sherpa-ONNX Embedding                                     │
│    - Vergleich mit Stimmprofilen                               │
│    - Mapping: A → "Zahnarzt (Dr. Müller)"                      │
└───────────────────────┬────────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. Agent V2.1 Pipeline (Backend)                               │
│    ┌──────────────────────────────────────────────────────┐   │
│    │ Agent 1: Rekonstruktion                               │   │
│    │ Bereinigt Roh-Transkript zu sachlichem Text          │   │
│    └────────────────────┬─────────────────────────────────┘   │
│                         ▼                                      │
│    ┌──────────────────────────────────────────────────────┐   │
│    │ Agent X: Detektor                                     │   │
│    │ Erkennt: 01-Befund? PA-Status? KZV-Doku nötig?       │   │
│    └────────────────────┬─────────────────────────────────┘   │
│                         ▼                                      │
│    ┌──────────────────────────────────────────────────────┐   │
│    │ 01-Extractor (wenn erkannt)                          │   │
│    │ Extrahiert strukturierten Zahnstatus                 │   │
│    └────────────────────┬─────────────────────────────────┘   │
│                         ▼                                      │
│    ┌──────────────────────────────────────────────────────┐   │
│    │ PA-Extractor (wenn erkannt)                          │   │
│    │ Extrahiert strukturierten PA-Status                  │   │
│    └────────────────────┬─────────────────────────────────┘   │
│                         ▼                                      │
│    ┌──────────────────────────────────────────────────────┐   │
│    │ Agent 2: Dokumentation                                │   │
│    │ Erstellt finale Behandlungsdokumentation             │   │
│    └──────────────────────────────────────────────────────┘   │
└───────────────────────┬────────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. Ergebnis-Anzeige                                            │
│    - Dokumentation in Zwischenablage                           │
│    - Status-Overlay mit Vorschau                               │
│    - Optional: Zahnschema-Visualisierung                       │
└────────────────────────────────────────────────────────────────┘
```

---

## Agent V2.1 Pipeline im Detail

### Agent 1: Rekonstruktion

**Aufgabe:** Bereinigt das rohe AssemblyAI-Transkript

**Input:**
```
Zahnarzt: Äh ja also der, der Zahn da hinten, der tut weh oder?
Patient: Ja genau, seit so, ähm, seit einer Woche ungefähr.
```

**Output:**
```
Zahnarzt: Der Zahn hinten tut weh?
Patient: Ja, seit einer Woche ungefähr.
```

**Regeln:**
- Entfernt Füllwörter (äh, ähm, also, ja)
- Korrigiert offensichtliche Grammatikfehler
- Behält medizinische Fachbegriffe unverändert
- Keine inhaltlichen Änderungen

---

### Agent X: Detektor

**Aufgabe:** Erkennt spezielle Dokumentationstypen

**Output:**
```javascript
{
  has01: true,      // 01-Befund (Zahnstatus) erkannt
  hasPA: false,     // PA-Status nicht erkannt
  needsKZV: true    // KZV-Dokumentation nötig
}
```

**Erkennungskriterien 01-Befund:**
- Systematische Zahnnennung (z.B. "16, 17, 26...")
- Befunde wie "Karies", "Füllung", "Extraktion"
- Zahnschema-Durchgang

**Erkennungskriterien PA-Status:**
- Sondierungstiefen genannt
- Parodontale Befunde
- BOP (Bleeding on Probing)

---

### 01-Extractor

**Aufgabe:** Extrahiert strukturierten Zahnstatus

**Input:** Rekonstruierter Text mit 01-Befund

**Output:**
```javascript
{
  teeth: [
    { number: 16, finding: "Karies", treatment: "Füllung geplant" },
    { number: 26, finding: "fehlt", treatment: null },
    { number: 36, finding: "Amalgam-Füllung", treatment: "Austausch empfohlen" }
  ]
}
```

---

### PA-Extractor

**Aufgabe:** Extrahiert strukturierten Parodontalstatus

**Output:**
```javascript
{
  generalStatus: "generalisierte moderate Parodontitis",
  teeth: [
    { number: 16, pocketDepth: 5, bop: true },
    { number: 26, pocketDepth: 4, bop: false }
  ]
}
```

---

### Agent 2: Dokumentation

**Aufgabe:** Erstellt finale Behandlungsdokumentation

**Prompt-Auszug:**
```
Du bist ein Assistent für zahnärztliche Behandlungsdokumentation.

Regeln:
- Verwende ausschließlich Informationen aus dem Gespräch
- Keine Vermutungen oder Ergänzungen
- Chronologische Reihenfolge
- Kurze, sachliche Sätze
- Zahnmedizinische Fachsprache

Format:
- 4 Absätze: Anamnese, Befund, Aufklärung/Beratung, Entscheidung/Therapie
- Keine Überschriften, nur Fließtext
- Pro Absatz max. 4 Sätze
```

**Output-Beispiel:**
```
Patientin berichtet über Schmerzen regio 26 seit einer Woche, verstärkt bei Kälte. Anamnestisch keine Allergien, keine Dauermedikation.

Klinisch zeigt sich Füllung 26 distal insuffizient, Sondierungsschmerz positiv. Röntgenologisch Sekundärkaries unter der Füllung erkennbar.

Aufklärung über Diagnose Caries profunda 26 erfolgt. Therapieoptionen besprochen: Füllungserneuerung, ggf. indirekte Überkappung bei Pulpanähe.

Patientin entscheidet sich für Füllungserneuerung. Termin zur Behandlung vereinbart. Über Risiken (postoperative Sensibilität, ggf. Wurzelkanalbehandlung) aufgeklärt.
```

---

## Backend Endpoint

### `/api/transcriptions/[id]/generate-doc-agent-v2.1`

**Request:**
```http
POST /api/transcriptions/123/generate-doc-agent-v2.1
Authorization: Bearer <token>
Content-Type: application/json
{}
```

**Response:**
```javascript
{
  // Haupt-Dokumentation
  documentation: "Patientin berichtet über...",

  // KZV-Format (wenn needsKZV)
  kzvDocumentation: "Anamnese:\n...\nBefund:\n...",

  // Z-Dokumentation (Kurzfassung/Executive Summary)
  zDocumentation: "Kurzfassung...",

  // Transkripte
  transcript: "Roher Text...",
  reconstructedTranscript: "Bereinigter Text...",
  transcriptWithSpeakers: "Zahnarzt: ...\nPatient: ...",

  // Sprecher
  recognizedSpeakers: ["Dr. Müller", "Patient"],

  // Befund-Detektion
  detection: {
    has01: true,
    hasPA: false,
    needsKZV: true
  },

  // Strukturierte Befunde
  status01: {
    teeth: [...]
  },
  statusPA: null,

  // Debug-Info
  stages: {
    agent1Duration: 1234,
    detectorDuration: 567,
    agent2Duration: 2345
  }
}
```

---

## Lokale Verarbeitung in main.js

### processAudioFile()

```javascript
async function processAudioFile(audioPath) {
  // 1. Upload
  updateStatusOverlay('Verarbeitung', 'Audio wird hochgeladen...', 'processing');
  const transcriptionId = await apiClient.uploadAudio(audioPath, token, onProgress);

  // 2. Warten auf Transkription
  updateStatusOverlay('Verarbeitung', 'Transkription läuft...', 'processing');
  await apiClient.waitForTranscription(transcriptionId, token);

  // 3. Sprechererkennung (lokal)
  if (hasVoiceProfiles) {
    updateStatusOverlay('Verarbeitung', 'Sprecher werden erkannt...', 'processing');
    const speakerResult = await speakerRecognition.identifySpeakers(audioPath, utterances);
    await apiClient.updateSpeakerMapping(transcriptionId, speakerResult.speakerMapping, token);
  }

  // 4. Dokumentation generieren (Agent V2.1)
  updateStatusOverlay('Verarbeitung', 'Dokumentation wird erstellt...', 'processing');
  const result = await apiClient.getDocumentationAgentV2_1(transcriptionId, token);

  // 5. Ergebnis speichern
  lastDocumentation = result.documentation;
  lastTranscript = result.transcript;
  lastDetection = result.detection;
  lastStatus01 = result.status01;
  lastStatusPA = result.statusPA;
  lastKzvDocumentation = result.kzvDocumentation;
  lastZDocumentation = result.zDocumentation;

  // 6. In Zwischenablage
  clipboard.writeText(result.documentation);

  // 7. Overlay aktualisieren
  updateStatusOverlay('Fertig', 'Dokumentation in Zwischenablage kopiert', 'success', {
    documentation: result.documentation,
    hasToothChart: !!result.status01
  });
}
```

---

## Zahnschema-Integration

Wenn ein 01-Befund erkannt wurde (`status01` vorhanden):

### Anzeige im Overlay

```javascript
// In status-overlay.html
if (data.hasToothChart && data.status01) {
  showToothChartButton();
}

// Button-Click öffnet Zahnschema-Fenster
ipcRenderer.send('open-tooth-chart', {
  status01: data.status01,
  documentation: data.documentation
});
```

### Zahnschema-Fenster (main.js)

```javascript
ipcMain.on('open-tooth-chart', (event, data) => {
  const toothChartWindow = new BrowserWindow({
    width: 800,
    height: 600,
    // ...
  });

  toothChartWindow.loadFile('src/tooth-chart.html');
  toothChartWindow.webContents.on('did-finish-load', () => {
    toothChartWindow.webContents.send('load-status', data.status01);
  });
});
```

---

## Fehlerbehandlung

### Keine Sprache erkannt

```javascript
if (error.message.includes('Keine Sprache erkannt')) {
  updateStatusOverlay(
    'Fehler',
    'Keine Sprache erkannt. Bitte deutlich ins Mikrofon sprechen.',
    'error'
  );
}
```

### Timeout (>5 Minuten)

```javascript
if (error.message.includes('timeout')) {
  updateStatusOverlay(
    'Fehler',
    'Die Verarbeitung hat zu lange gedauert. Bitte erneut versuchen.',
    'error'
  );
}
```

### Trial/Subscription abgelaufen

```javascript
if (error.message.startsWith('TRIAL_EXPIRED:')) {
  showCustomNotification(
    'Testphase beendet',
    'Bitte Abo abschließen um fortzufahren',
    'error',
    () => openWebDashboard('/subscription')
  );
}
```

---

## Performance

### Typische Zeiten

| Schritt | Dauer |
|---------|-------|
| Upload (30s Audio) | 5-10s |
| AssemblyAI Transkription | 10-20s |
| Sprechererkennung (lokal) | 2-5s |
| Agent V2.1 Pipeline | 15-30s |
| **Gesamt** | **~45-60s** |

### Timeout-Konfiguration

```javascript
// In apiClient.js
timeout: 300000  // 5 Minuten für Agent V2.1
```

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [api-integration.md](api-integration.md) - Backend-Endpoints
- [audio-recording.md](audio-recording.md) - Vor der Verarbeitung
