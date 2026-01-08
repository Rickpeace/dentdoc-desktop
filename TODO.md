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



lizensen für gleichzeitig installierte apps / über gleichzeitigen login ?
-----
knopf für aufnahme .... FLIC !? oder selber bauen ?
-----
16k datei ist sehr groß bei einer großen aufnahme... manuel getestet !
-----

microphone: https://www.amazon.de/Anker-Konferenzlautsprecher-integrierte-verbesserter-Gespr%C3%A4chszeit/dp/B0899S421T/ref=sr_1_1?adgrpid=77903328184&dib=eyJ2IjoiMSJ9.7-IkzsIU43ER2uVd-vdFiUZw5bsn5187DLYzlxCPhXjaYdd9GvPk4pFk9bZ2cN_Ef5ApbkTkVUz4rRJ2yy9lBvTO-D5toxmTTDqUQZu5DcyhVMb51iDe5nuAjCGI92UwG7rwLtZBEGRUhQ0a6pqYM-C_dDtpY_eg_ZAzJkmyKt69GsOEeA25NX1JmfJFyvLzZKUjKW_-ztzaItOay1UDbW1eOK3XUNoe7ltbS1SAf6U.gF7b4uPWJFIGDiTIr4HP0wkdSwL82apKWEECOPIejhE&dib_tag=se&hvadid=352728096168&hvdev=c&hvexpln=0&hvlocphy=9192964&hvnetw=g&hvocijid=3668850731596253718--&hvqmt=e&hvrand=3668850731596253718&hvtargid=kwd-940776181362&hydadcr=26672_1770882&keywords=anker%2Bpowerconf%2Bs3&mcid=35ac095e312e356a86875e33e268f56f&qid=1767732848&sr=8-1&th=1

