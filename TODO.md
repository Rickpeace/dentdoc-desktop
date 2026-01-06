# DentDoc Desktop - TODO

## Feature Requests

### Pause/Resume Recording
- **Status**: Pending
- **Priority**: Medium
- **Description**: Add ability to pause and resume audio recording during a session
- **Details**:
  - Allow pausing the recording (stops capturing but keeps session open)
  - Allow resuming the recording (continues capturing in same session)
  - Combine audio segments when stopped
  - Update status overlay with pause/resume buttons
  - Useful for interruptions during patient consultations
- **Technical Requirements**:
  - Modify `src/audioRecorder.js` to support pause/resume
  - Update `main.js` to handle paused state
  - Add UI controls in status overlay
  - Ensure proper audio segment merging

## Completed Features

### Auto-Export Toggle ✓
- Added checkbox in settings to enable/disable automatic transcript export
- Default: Off
- Completed: 2026-01-06

### Login Screen UI Fixes ✓
- Removed orange glow from titlebar buttons
- Fixed titlebar to extend edge-to-edge
- Completed: 2026-01-06

### Speaker Recognition Fix ✓
- Fixed speaker recognition in standalone .exe builds
- Unpacked ffmpeg from ASAR archive
- Version: 1.0.3
- Completed: Previous session
