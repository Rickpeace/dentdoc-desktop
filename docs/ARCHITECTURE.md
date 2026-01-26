# DentDoc Desktop - Architektur & Dokumentation

> **Letzte Aktualisierung:** Januar 2026
> **Version:** 1.6.x

## Übersicht

**DentDoc Desktop** ist eine Windows Electron-Anwendung für automatische Zahnarzt-Dokumentation:

1. **Aufnahme** - Audio von Arzt-Patient-Gesprächen (Mikrofon oder iPhone)
2. **Transkription** - AssemblyAI via Backend mit Sprecherdiarisierung
3. **Sprechererkennung** - Lokale Identifikation mit Sherpa-ONNX
4. **Dokumentation** - KI-generierte Behandlungsdokumentation (Agent V2.1)
5. **Export** - Zwischenablage für PVS-Systeme

---

## Dokumentations-Index

| Dokument | Beschreibung |
|----------|--------------|
| [main-process.md](main-process.md) | Electron Main Process, Module, State Management |
| [renderer-process.md](renderer-process.md) | Dashboard, Login, Overlay, Setup-Wizard |
| [api-integration.md](api-integration.md) | Backend-Kommunikation, Endpoints, Auth |
| [audio-recording.md](audio-recording.md) | Aufnahme, VAD, Speaker Recognition |
| [documentation-flow.md](documentation-flow.md) | Agent V2.1, Transkription → Dokumentation |
| [data-storage.md](data-storage.md) | electron-store, Dateipfade, Export |

---

## Technologie-Stack

### Core
- **Electron 28.0.0** - Desktop Framework
- **Node.js** - Backend Runtime

### Dependencies

| Package | Zweck |
|---------|-------|
| `electron-store` | Persistente Einstellungen (JSON) |
| `axios` | HTTP Client für API |
| `sherpa-onnx-node` | Lokale Sprechererkennung |
| `fluent-ffmpeg` + `ffmpeg-static` | Audio-Konvertierung |
| `electron-updater` | Auto-Updates via GitHub |
| `dotenv` | Umgebungsvariablen |

### Externe Services
- **Backend:** https://dentdoc-app.vercel.app/
- **Transkription:** AssemblyAI (via Backend)
- **Dokumentation:** OpenAI GPT-5 (via Backend, Agent V2.1)

---

## Dateistruktur

```
dentdoc-desktop/
├── main.js                      # Electron Hauptprozess (~4800 Zeilen)
├── package.json                 # App-Konfiguration
├── .env / .env.local            # API URLs
│
├── src/
│   ├── notifications.js         # Native + Custom Notifications [MODUL]
│   ├── session.js               # Heartbeat, User-Refresh [MODUL]
│   ├── tray.js                  # System Tray Management [MODUL]
│   │
│   ├── apiClient.js             # Backend-Kommunikation
│   ├── audioRecorderFFmpeg.js   # Mikrofon-Aufnahme mit FFmpeg
│   ├── audio-converter.js       # WAV-Konvertierung
│   ├── vad-controller.js        # VAD Steuerung
│   │
│   ├── speaker-recognition/
│   │   ├── index.js             # Sherpa-ONNX Integration
│   │   └── voice-profiles.js    # Stimmprofil-Verwaltung
│   │
│   ├── vad/
│   │   ├── vad-worker-thread.js # VAD Worker (Silero)
│   │   ├── vad-config.js        # VAD Konfiguration
│   │   └── vad-worklet.js       # Audio Worklet
│   │
│   ├── pipeline/
│   │   ├── index.js             # VAD Pipeline
│   │   ├── offlineVad.js        # Offline-VAD für Uploads
│   │   └── speechRenderer.js    # VAD → Speech-Only Audio
│   │
│   ├── scripts/
│   │   ├── dashboard.js         # Dashboard UI Logik
│   │   ├── setup-wizard.js      # Einrichtungsassistent
│   │   ├── tooth-chart.js       # Zahnschema
│   │   ├── tooth-shapes.js      # Zahn-Grafiken
│   │   └── audio-utils.js       # Audio Hilfsfunktionen
│   │
│   ├── dashboard.html           # Hauptfenster
│   ├── login.html               # Login-Dialog
│   ├── status-overlay.html      # Floating Overlay
│   ├── notification-popup.html  # Custom Notifications
│   ├── recorder.html            # Hidden Recorder
│   └── feedback.html            # Feedback-Formular
│
├── models/
│   ├── 3dspeaker_speech_eres2net_*.onnx  # Speaker Model
│   └── silero_vad.onnx                    # VAD Model
│
├── assets/
│   ├── icon.png
│   ├── tray-icon.png
│   └── tray-icon-recording.png
│
└── docs/                        # Diese Dokumentation
```

---

## Architektur-Diagramm

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ main.js                                                   │   │
│  │  ├─ State: isRecording, isProcessing, lastDocumentation  │   │
│  │  ├─ Windows: dashboard, login, statusOverlay             │   │
│  │  └─ IPC Handlers: ~50 ipcMain.handle/on                  │   │
│  └──────────────────────────────────────────────────────────┘   │
│           │              │              │              │         │
│  ┌────────┴───┐  ┌───────┴───┐  ┌──────┴────┐  ┌──────┴────┐   │
│  │ tray.js    │  │ session.js│  │notifications│ │apiClient  │   │
│  │ Tray-Menü  │  │ Heartbeat │  │ Popups     │  │ Backend   │   │
│  └────────────┘  └───────────┘  └───────────┘  └───────────┘   │
│           │                                          │          │
│  ┌────────┴──────────────────────────────────────────┴───────┐  │
│  │ Audio Pipeline                                             │  │
│  │  audioRecorderFFmpeg → VAD → speakerRecognition → API     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RENDERER PROCESS                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ dashboard.js │  │ setup-wizard │  │ status-overlay.html  │   │
│  │ Home, Archiv │  │ Einrichtung  │  │ Recording-Status     │   │
│  │ Settings     │  │ Mikrofon     │  │ Progress, Fehler     │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                  │
│  dentdoc-app.vercel.app                                         │
│  ├─ /api/transcriptions     - Transkription starten/abrufen     │
│  ├─ /api/transcriptions/[id]/generate-doc-agent-v2  - Doku      │
│  ├─ /api/auth/*             - Login, Register, Session          │
│  └─ /api/devices/*          - Geräteverwaltung                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Kern-Konzepte

### 1. Dokumentations-Modus: Agent V2.1

Die App verwendet ausschließlich **Agent V2.1** für Dokumentationsgenerierung:
- Mehrstufige KI-Pipeline
- Automatische Sprechererkennung
- Strukturierte Ausgabe (Anamnese, Befund, Therapie, etc.)

Details: [documentation-flow.md](documentation-flow.md)

### 2. Aufnahme-Modi

| Modus | Beschreibung |
|-------|--------------|
| **Standard** | Lokales Mikrofon mit FFmpeg |
| **iPhone** | DentDoc Mic iOS App als Bluetooth-Mikrofon |

### 3. VAD (Voice Activity Detection)

VAD wird **nach der Aufnahme** verwendet um Stille aus der Audio-Datei zu entfernen:
- Reduziert Upload-Größe
- Verbessert Transkriptions-Qualität
- Spart AssemblyAI Kosten

Details: [audio-recording.md](audio-recording.md)

### 4. Module (refactored)

Aus main.js wurden folgende Module extrahiert:

| Modul | Datei | Funktion |
|-------|-------|----------|
| Notifications | `src/notifications.js` | Native + Custom Popups |
| Session | `src/session.js` | Heartbeat, User-Refresh |
| Tray | `src/tray.js` | System Tray, Kontextmenü |

Details: [main-process.md](main-process.md)

---

## Wichtige Flows

### Aufnahme → Dokumentation

```
1. User drückt F9 (oder Tray-Menü)
2. startRecording() prüft Subscription
3. audioRecorderFFmpeg startet FFmpeg-Prozess
4. Status-Overlay zeigt "Aufnahme läuft"
5. User drückt F9 erneut
6. stopRecording() beendet FFmpeg
7. processAudioFile() startet:
   a. VAD: Stille aus Audio entfernen (lokal)
   b. Upload zu Backend
   c. Backend: AssemblyAI Transkription
   d. Lokal: Sprechererkennung (optional)
   e. Backend: Agent V2.1 Dokumentation
8. Dokumentation in Zwischenablage
9. Status-Overlay zeigt Ergebnis
```

### Sprechererkennung

```
1. Audio-Datei fertig
2. speakerRecognition.identifySpeakers(audioPath, utterances)
3. Für jeden Speaker:
   a. Extrahiere Embedding mit Sherpa-ONNX
   b. Vergleiche mit gespeicherten Profilen
   c. Confidence Score berechnen
4. Mapping: { "A": "Zahnarzt (Dr. Müller)", "B": "Patient" }
5. Zurück an processAudioFile()
```

---

## Konfiguration

### electron-store Keys

| Key | Typ | Beschreibung |
|-----|-----|--------------|
| `authToken` | string | JWT Token |
| `user` | object | User-Daten (planTier, minutesRemaining, etc.) |
| `shortcut` | string | Aufnahme-Shortcut (default: "F9") |
| `theme` | string | "dark" oder "light" |
| `autoExport` | boolean | Auto-Export Transkripte |
| `transcriptSavePath` | string | Export-Pfad |
| `keepAudio` | boolean | Audio behalten nach Verarbeitung |
| `audioSavePath` | string | Audio-Speicherpfad |
| `selectedMicrophone` | string | Mikrofon Device-ID |
| `profilesPath` | string | Stimmprofile-Pfad |
| `overlayPosition` | object | {x, y} Position des Overlays |

### Umgebungsvariablen

```env
# .env (Produktion)
VITE_API_URL=https://dentdoc-app.vercel.app

# .env.local (Entwicklung)
VITE_API_URL=http://localhost:3000
```

---

## Changelog

### Version 1.6.0 (Januar 2026)
- Vereinfachung auf Agent V2.1 (einziger Dokumentations-Modus)
- Entfernung von Bausteine/Textbausteine System
- Entfernung von Shortenings
- Modul-Extraktion: notifications.js, session.js, tray.js

---

## Weiterführende Dokumentation

- [main-process.md](main-process.md) - Details zum Hauptprozess
- [renderer-process.md](renderer-process.md) - UI-Komponenten
- [api-integration.md](api-integration.md) - Backend-Kommunikation
- [audio-recording.md](audio-recording.md) - Audio-Pipeline
- [documentation-flow.md](documentation-flow.md) - Dokumentations-Generierung
- [data-storage.md](data-storage.md) - Datenspeicherung
