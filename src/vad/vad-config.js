/**
 * VAD Configuration
 *
 * Parameters for Voice Activity Detection using Sherpa-ONNX Silero VAD.
 * These values are tuned for dental practice environments (speech + drill noise).
 */

const VAD_CONFIG = {
  // =========================================================================
  // TIMING PARAMETERS
  // =========================================================================

  /**
   * Speech must be detected for this duration before starting recording.
   * Prevents false triggers from short noise bursts.
   */
  speechStartMs: 300,

  /**
   * Silence must be detected for this duration before stopping recording.
   * Allows for natural pauses in speech (e.g., thinking, patient response).
   */
  speechStopMs: 1500,

  /**
   * Audio buffer kept before speech detection (ring buffer).
   * Ensures word beginnings are not lost when recording starts.
   */
  preRollMs: 400,

  /**
   * Audio kept after last speech detection.
   * Ensures word endings and trailing sounds are captured.
   * Set higher (1000ms) for numbers like "drei komma fünf" with long decay.
   */
  postRollMs: 1000,

  // =========================================================================
  // AUDIO PARAMETERS
  // =========================================================================

  /**
   * Sample rate - MUST match FFmpeg output and Sherpa-ONNX expectation.
   * 16kHz is optimal for speech recognition.
   */
  sampleRate: 16000,

  /**
   * Frame size for VAD processing.
   * Sherpa-ONNX Silero VAD expects 20ms frames.
   */
  frameMs: 20,

  /**
   * Number of frames to batch before sending to VAD worker.
   * Reduces IPC overhead. 5 frames = 100ms batches.
   */
  batchFrames: 5,

  /**
   * Samples per frame (calculated).
   * 16000 Hz * 0.020s = 320 samples per 20ms frame
   */
  get samplesPerFrame() {
    return Math.floor(this.sampleRate * this.frameMs / 1000);
  },

  /**
   * Samples per batch (calculated).
   * 320 * 5 = 1600 samples per batch (100ms)
   */
  get samplesPerBatch() {
    return this.samplesPerFrame * this.batchFrames;
  },

  /**
   * Pre-roll buffer size in samples (calculated).
   * 16000 Hz * 0.4s = 6400 samples
   */
  get preRollSamples() {
    return Math.floor(this.sampleRate * this.preRollMs / 1000);
  },

  // =========================================================================
  // SHERPA-ONNX VAD PARAMETERS
  // =========================================================================

  /**
   * Silero VAD threshold (0.0 - 1.0).
   * Higher = more aggressive (fewer false positives, may miss quiet speech).
   * Lower = more sensitive (catches quiet speech, more false positives).
   * 0.5 is a good balance for dental environments.
   */
  sileroThreshold: 0.5,

  /**
   * Minimum speech duration for Silero (in seconds).
   * Speeches shorter than this are ignored.
   */
  minSpeechDuration: 0.25,

  /**
   * Maximum speech duration for Silero (in seconds).
   * After this, speech is force-segmented.
   * Set high to allow long dictations.
   */
  maxSpeechDuration: 300,

  // =========================================================================
  // STATE MACHINE STATES
  // =========================================================================

  states: {
    IDLE: 'idle',
    BUFFERING: 'buffering',
    RECORDING: 'recording',
    SILENCE_TIMEOUT: 'silence_timeout',
    FINALIZING: 'finalizing'
  },

  // =========================================================================
  // IPC EVENT NAMES
  // =========================================================================

  events: {
    VAD_EVENT: 'vad-event',
    VAD_STATE_CHANGE: 'vad-state-change',
    VAD_SPEECH_START: 'speech-start',
    VAD_SPEECH_END: 'speech-end',
    VAD_SEGMENT_READY: 'segment-ready'
  }
};

// Calculate derived values for easy access
VAD_CONFIG.frameCount = {
  /**
   * Number of frames needed for speech start (300ms / 20ms = 15 frames)
   */
  speechStart: Math.ceil(VAD_CONFIG.speechStartMs / VAD_CONFIG.frameMs),

  /**
   * Number of frames needed for speech stop (1500ms / 20ms = 75 frames)
   */
  speechStop: Math.ceil(VAD_CONFIG.speechStopMs / VAD_CONFIG.frameMs),

  /**
   * Number of frames in pre-roll buffer (400ms / 20ms = 20 frames)
   */
  preRoll: Math.ceil(VAD_CONFIG.preRollMs / VAD_CONFIG.frameMs)
};

module.exports = VAD_CONFIG;
