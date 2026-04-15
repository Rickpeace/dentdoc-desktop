# DentDoc Desktop - Architektur & Dokumentation

> **Letzte Aktualisierung:** April 2026
> **Version:** 1.9.0

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
| [support-chat.md](support-chat.md) | tawk.to Live Chat Integration |

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
- **Backend:** https://dentdoc.de/
- **Transkription:** AssemblyAI (via Backend)
- **Dokumentation:** OpenAI GPT-5 (via Backend, Agent V2.1)

---

## Dateistruktur

```
dentdoc-desktop/
├── main.js                      # Electron Hauptprozess (~6300 Zeilen)
├── package.json                 # App-Konfiguration
├── .env / .env.local            # API URLs
│
├── src/
│   ├── notifications.js         # Native + Custom Notifications [MODUL]
│   ├── session.js               # Heartbeat, User-Refresh [MODUL]
│   ├── tray.js                  # System Tray Management [MODUL]
│   ├── recordingSlot.js         # Recording Slot Lizenzverwaltung [MODUL]
│   │
│   ├── apiClient.js             # Backend-Kommunikation
│   ├── audioRecorderFFmpeg.js   # Mikrofon-Aufnahme mit FFmpeg
│   ├── audio-converter.js       # WAV-Konvertierung
│   ├── vad-controller.js        # VAD Steuerung
│   ├── utterance-profile-modal.js # Stimmprofil-Zuordnung UI
│   │
│   ├── speaker-recognition/
│   │   ├── index.js             # Sherpa-ONNX Integration
│   │   └── voice-profiles.js    # Stimmprofil-Verwaltung (Backend DB + Cache)
│   │
│   ├── vad/
│   │   ├── vad-worker-thread.js # VAD Worker (Silero)
│   │   ├── vad-config.js        # VAD Konfiguration
│   │   └── vad-worklet.js       # Audio Worklet
│   │
│   ├── pipeline/
│   │   ├── index.js             # VAD Pipeline
│   │   ├── offlineVad.js        # Offline-VAD Orchestrierung (Worker + Fallback)
│   │   ├── offlineVadWorker.js  # VAD Worker Thread (Streaming, kein UI-Freeze)
│   │   └── speechRenderer.js    # VAD → Speech-Only Audio (Batch FFmpeg)
│   │
│   ├── scripts/
│   │   ├── dashboard.js         # Dashboard UI Logik
│   │   ├── setup-wizard.js      # Einrichtungsassistent
│   │   ├── audio-utils.js       # SHARED: Mic-Test, Monitoring, Matching
│   │   ├── transcript-modal.js  # Transkript-Ansicht/Bearbeitung
│   │   ├── tooth-chart.js       # Zahnschema
│   │   └── tooth-shapes.js      # Zahn-Grafiken
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
│  │  └─ IPC Handlers: ~80+ ipcMain.handle/on                 │   │
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
│  │ Upgrade Bar  │  │              │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘   │
│         │                 │                                      │
│         └────────┬────────┘                                      │
│          ┌───────┴────────┐                                      │
│          │ audio-utils.js │  ← Shared: Mic matching, testing     │
│          └────────────────┘                                      │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                  │
│  dentdoc.de                                                     │
│  ├─ /api/transcriptions     - Transkription starten/abrufen     │
│  ├─ /api/transcriptions/[id]/generate-doc-agent-v2.1  - Doku    │
│  ├─ /api/auth/*             - Login, Register, Session          │
│  ├─ /api/voice-profiles/*   - Stimmprofile (CRUD)               │
│  ├─ /api/recording/*        - Recording Slots (Lizenz)          │
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

VAD entfernt Stille aus der Audio-Datei (Upload-Größe, Transkriptions-Qualität, Kosten):
- **Live VAD:** Läuft während Mikrofon-Aufnahme (vad-controller.js + vad-worker-thread.js)
- **Offline VAD:** Nur für manuellen Datei-Upload (pipeline/offlineVad.js)

Details: [audio-recording.md](audio-recording.md)

### 4. Module (refactored)

Aus main.js wurden folgende Module extrahiert:

| Modul | Datei | Funktion |
|-------|-------|----------|
| Notifications | `src/notifications.js` | Native + Custom Popups |
| Session | `src/session.js` | Heartbeat, User-Refresh |
| Tray | `src/tray.js` | System Tray, Kontextmenü |
| RecordingSlot | `src/recordingSlot.js` | Lizenz-Enforcement (Claim/Heartbeat/Release) |

Details: [main-process.md](main-process.md)

---

## Wichtige Flows

### Aufnahme → Dokumentation

```
1. User drückt F9 (oder Tray-Menü)
2. startRecording() prüft Subscription
3. audioRecorderFFmpeg startet FFmpeg-Prozess (direkt 16kHz mono)
4. Live VAD sammelt Speech-Marker parallel (vad-controller.js)
5. Status-Overlay zeigt "Aufnahme läuft"
6. User drückt F9 erneut
7. stopRecording() beendet FFmpeg + Live VAD
8. processAudioFile() startet:
   a. Live VAD Marker → speechRenderer → speech_only.wav (~5s)
   b. Upload zu Backend
   c. Backend: AssemblyAI Transkription
   d. Lokal: Sprechererkennung (optional)
   e. Backend: Agent V2.1 Dokumentation
9. Dokumentation in Zwischenablage
10. Status-Overlay zeigt Ergebnis
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
| `overlayPosition` | object | {x, y} Position des Overlays |

### Umgebungsvariablen

```env
# .env (Produktion)
VITE_API_URL=https://dentdoc.de

# .env.local (Entwicklung)
VITE_API_URL=http://localhost:3000
```

---

## Changelog

### Version 1.9.0 (April 2026)
- **Settings Auto-Save:** Einstellungen speichern sofort bei Änderung, kein Speichern/Abbrechen-Dialog mehr
- **KI-Modus entfernt:** Dokumentations-Modus Auswahl aus Einstellungen & Einrichtungsassistent entfernt (nur Agent V2.1)
- **Recording Slot Lizenz-Enforcement:** Neues `src/recordingSlot.js` Modul — Claim/Heartbeat/Release für gleichzeitige Aufnahmen
- **Setup-Wizard:** 8 Schritte (0-7), KI-Dokumentation Step entfernt
- **Wizard Close-Button Fix:** `-webkit-app-region: no-drag` behebt Klick-Problem
- **Release-Helper:** `releaseCurrentRecordingSlot()` dedupliziert Release-Logik (mit Retry)
- **Heartbeat-Härtung:** Skip-if-pending, Failure-Counter mit User-Warnung, 404-Erkennung

### Version 1.8.4 (April 2026)
- **Auth-Token Schutz:** Token wird bei Netzwerkfehlern während Startup nicht gelöscht

### Version 1.8.3 (April 2026)
- **Auto-Update Dialog:** Zeigt nach manueller Prüfung korrekt an, auch nach vorheriger Ablehnung

### Version 1.8.2 (April 2026)
- **Docs Update:** Architektur-Dokumentation aktualisiert, Backend Agent-Verbesserungen

### Version 1.8.1 (April 2026)
- **Audio-Meter Fix:** Audio-Meter in Statusleiste funktioniert während VAD-Aufnahme

### Version 1.7.0 (Februar 2026)
- **Auto-Update Fix:** `before-quit` Handler setzt `app.isQuitting` bei Windows Shutdown, damit `autoInstallOnAppQuit` greifen kann. Startup-Fallback (`pendingUpdateVersion`) für force-killed Szenarien
- **F9 Race Condition Fix:** `startInProgress` Guard verhindert doppelte `startRecording()` Aufrufe bei schnellem Doppel-Drücken (in Shortcut, Fallback-Shortcut und `toggle-recording` IPC)
- **Mikrofon-Eingangslautstärke:** Slider in Settings und Setup-Wizard zum Anzeigen/Steuern der Windows-Mic-Lautstärke (PowerShell COM Interop, geräte-spezifisch per Name-Matching)
- **Cross-Audio Stop:** Transkript-Audio und Profil-Modal-Audio pausieren sich gegenseitig
- **Utterance-Playback Fix:** Klick auf Utterance im Transkript spielt nur den jeweiligen Abschnitt (stoppt bei `segmentEndMs`)
- **Dashboard UI:** Einheitliche 800px max-width für alle Card-Views, Onboarding-Card session-basiert
- **Tawk.to Chat Fix:** `overflow:hidden` auf Webview-Body behebt Scroll-Problem

### Version 1.6.17 (Februar 2026)
- **16kHz Live-Recording:** FFmpeg nimmt direkt mit 16kHz auf, Downsample-Schritt entfällt (~7 Min gespart bei 100+ Min Aufnahmen)
- **Worker Thread VAD:** Offline-VAD läuft in separatem Thread mit Streaming (~128KB RAM statt 555MB), kein UI-Freeze mehr
- **FFmpeg Batch-Extraktion:** `filter_complex` statt N einzelne FFmpeg-Spawns für Segment-Extraktion
- **Fortschrittsbalken:** 5-Phasen-Anzeige im Status-Overlay (Analyse → Upload → Transkription → Sprecher → Dokumentation)

### Version 1.6.16 (Februar 2026)
- Vorherige Version

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
- [support-chat.md](support-chat.md) - tawk.to Live Chat
