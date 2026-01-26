# DentDoc Desktop

Windows Electron app for automatic dental documentation. Records doctor-patient conversations, transcribes via AssemblyAI, and generates structured documentation using AI (Agent V2.1).

## Stack

- **Electron 28** (Windows only)
- **Main process**: `main.js` (~4800 lines) + extracted modules in `src/`
- **Renderer**: Vanilla HTML/JS (no framework)
- **Audio**: FFmpeg for recording, Sherpa-ONNX for local speaker recognition
- **Backend**: https://dentdoc-app.vercel.app (auth, transcription, documentation)

## Commands

```bash
npm start          # Run app locally
npm run build:win  # Build Windows installer
```

## Architecture

```
main.js                 # Main process entry point, IPC handlers
src/
  apiClient.js          # Backend communication
  notifications.js      # Native + custom notifications
  session.js            # Heartbeat, user refresh
  tray.js               # System tray management
  scripts/dashboard.js  # Dashboard UI logic
  scripts/setup-wizard.js
  speaker-recognition/  # Sherpa-ONNX integration
  vad/                  # Voice activity detection
  pipeline/             # Audio processing pipeline
models/                 # ONNX models (speaker, VAD)
```

## Key Concepts

- **IPC**: Main ↔ Renderer communication via `ipcMain.handle`/`ipcRenderer.invoke`
- **electron-store**: Persistent settings (auth, preferences)
- **Recording flow**: F9 hotkey → FFmpeg → VAD (remove silence) → upload → transcription → documentation

## Documentation

Detailed docs are in `docs/` - read these when working on specific areas:

| File | When to read |
|------|--------------|
| [main-process.md](docs/main-process.md) | Modifying main.js, IPC, state |
| [renderer-process.md](docs/renderer-process.md) | UI changes, dashboard, overlay |
| [api-integration.md](docs/api-integration.md) | Backend calls, auth, endpoints |
| [audio-recording.md](docs/audio-recording.md) | Recording, VAD, speaker recognition |
| [documentation-flow.md](docs/documentation-flow.md) | Agent V2.1, doc generation |

## Notes

- When modifying architecture, adding modules, or changing APIs, update the relevant doc in `docs/`
- No test suite currently
- German UI and documentation (users are German dentists)
- Backend repo is separate (`saas-starter` / dentdoc-app on Vercel)
