# DentDoc Desktop

Windows Electron app for automatic dental documentation. Records doctor-patient conversations, transcribes via AssemblyAI, and generates structured documentation using AI (Agent V2.1).

## Stack

- **Electron 28** (Windows only)
- **Main process**: `main.js` (~6300 lines) + extracted modules in `src/`
- **Renderer**: Vanilla HTML/JS (no framework)
- **Audio**: FFmpeg for recording, Sherpa-ONNX for local speaker recognition
- **Backend**: https://dentdoc.de (auth, transcription, documentation)

## Commands

```bash
npm start          # Run app locally
npm run build:win  # Build Windows installer
```

## Architecture

```
main.js                          # Main process entry point, IPC handlers (~80+)
src/
  apiClient.js                   # Backend communication
  audioRecorderFFmpeg.js         # FFmpeg audio recording & device management
  audio-converter.js             # WAV conversion for AssemblyAI upload
  vad-controller.js              # VAD session orchestration (live recording)
  notifications.js               # Native + custom notifications
  session.js                     # Heartbeat, user refresh
  tray.js                        # System tray management
  utterance-profile-modal.js     # Voice profile assignment UI
  speaker-recognition/           # Sherpa-ONNX speaker identification
  vad/                           # Voice activity detection (Silero model)
  pipeline/                      # Audio processing pipeline (offline VAD)
  scripts/
    dashboard.js                 # Dashboard UI logic
    setup-wizard.js              # First-run onboarding wizard
    audio-utils.js               # Shared: mic matching, testing, monitoring
    transcript-modal.js          # Transcript view/edit modal
    tooth-chart.js               # Dental tooth chart (FDI schema)
    tooth-shapes.js              # Tooth shape definitions
  styles/                        # CSS (design-system, dashboard, setup-wizard, tooth-chart)
  *.html                         # Renderer pages (dashboard, login, overlay, notification, recorder, feedback)
models/                          # ONNX models (speaker, VAD)
```

## Key Concepts

- **IPC**: Main ↔ Renderer communication via `ipcMain.handle`/`ipcRenderer.invoke` (80+ handlers)
- **electron-store**: Persistent settings (auth, preferences)
- **Recording flow**: F9 hotkey → FFmpeg → VAD (remove silence) → upload → transcription → speaker recognition → documentation → clipboard
- **Pause/Resume**: Recording can be paused/resumed with accumulated duration tracking
- **iPhone mode**: DentDoc Mic iOS app as Bluetooth audio input (alternative to local mic)
- **Voice profiles**: Sherpa-ONNX speaker enrollment & identification (cosine similarity matching)
- **Multi-format clipboard**: HTML/RTF clipboard output for Z1 Dental PVS compatibility

## Documentation

Detailed docs are in `docs/` - read these when working on specific areas:

| File | When to read |
|------|--------------|
| [main-process.md](docs/main-process.md) | Modifying main.js, IPC, state |
| [renderer-process.md](docs/renderer-process.md) | UI changes, dashboard, overlay |
| [api-integration.md](docs/api-integration.md) | Backend calls, auth, endpoints |
| [audio-recording.md](docs/audio-recording.md) | Recording, VAD, speaker recognition |
| [documentation-flow.md](docs/documentation-flow.md) | Agent V2.1, doc generation |
| [data-storage.md](docs/data-storage.md) | electron-store, file paths, export |
| [support-chat.md](docs/support-chat.md) | tawk.to integration, Live Chat |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Overall architecture, file structure, flows |

## Notes

- When modifying architecture, adding modules, or changing APIs, update the relevant doc in `docs/`
- No test suite currently
- German UI and documentation (users are German dentists)
- Backend repo is separate (`saas-starter` / dentdoc-app on Vercel)
