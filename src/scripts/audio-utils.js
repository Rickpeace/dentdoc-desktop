/**
 * Shared Audio Utilities
 * Consolidates duplicated audio code from dashboard.js and setup-wizard.js
 */

const { ipcRenderer } = require('electron');

// =============================================================================
// AUDIO MONITORING STATE (per instance)
// =============================================================================

class AudioMonitor {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.animationFrameId = null;
    this.isMonitoring = false;
  }

  /**
   * Start audio monitoring with level visualization
   * @param {string|null} deviceId - WebRTC device ID (for getUserMedia)
   * @param {function} onLevel - Callback with level (0-100)
   * @param {object} options - Optional settings
   */
  async start(deviceId, onLevel, options = {}) {
    const {
      fftSize = 256,
      echoCancellation = false,
      noiseSuppression = false,
      autoGainControl = false
    } = options;

    try {
      // Build constraints
      const constraints = deviceId ? {
        audio: {
          deviceId: { ideal: deviceId },
          echoCancellation,
          noiseSuppression,
          autoGainControl
        }
      } : {
        audio: {
          echoCancellation,
          noiseSuppression,
          autoGainControl
        }
      };

      // Get user media
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create audio context and analyser
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = fftSize;

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      source.connect(this.analyser);

      this.isMonitoring = true;

      // Start level monitoring loop
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      const updateLevel = () => {
        if (!this.isMonitoring || !this.analyser) return;

        this.analyser.getByteFrequencyData(dataArray);

        // Calculate average level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const level = Math.min(100, (avg / 128) * 100);

        if (onLevel) onLevel(level);

        this.animationFrameId = requestAnimationFrame(updateLevel);
      };

      updateLevel();
      return true;
    } catch (error) {
      console.error('AudioMonitor start error:', error);
      this.stop();
      throw error;
    }
  }

  /**
   * Stop audio monitoring and cleanup resources
   */
  stop() {
    this.isMonitoring = false;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
      this.analyser = null;
    }
  }
}

// =============================================================================
// MICROPHONE ENUMERATION
// =============================================================================

/**
 * Load microphones into a select element
 * @param {HTMLSelectElement} selectElement - The select dropdown
 * @param {string|null} selectedId - Currently selected device ID
 * @returns {object} - { deviceId, deviceName } of selected mic
 */
async function loadMicrophones(selectElement, selectedId = null) {
  if (!selectElement) return { deviceId: null, deviceName: null };

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    selectElement.innerHTML = '';

    if (mics.length === 0) {
      selectElement.innerHTML = '<option value="">Kein Mikrofon gefunden</option>';
      return { deviceId: null, deviceName: null };
    }

    let selectedDeviceId = null;
    let selectedDeviceName = null;

    mics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      const micLabel = mic.label || `Mikrofon ${index + 1}`;
      option.textContent = micLabel;
      option.dataset.micName = micLabel;  // Store name for FFmpeg

      if (mic.deviceId === selectedId) {
        option.selected = true;
        selectedDeviceId = mic.deviceId;
        selectedDeviceName = micLabel;
      }

      selectElement.appendChild(option);
    });

    // Set first mic as default if none selected
    if (!selectedDeviceId && mics.length > 0) {
      selectElement.options[0].selected = true;
      selectedDeviceId = mics[0].deviceId;
      selectedDeviceName = mics[0].label || 'Mikrofon 1';
    }

    return { deviceId: selectedDeviceId, deviceName: selectedDeviceName };
  } catch (error) {
    console.error('Error loading microphones:', error);
    selectElement.innerHTML = '<option value="">Fehler beim Laden</option>';
    return { deviceId: null, deviceName: null };
  }
}

/**
 * Get the selected microphone name from a select element
 * @param {HTMLSelectElement} selectElement - The select dropdown
 * @returns {object} - { deviceId, deviceName }
 */
function getSelectedMicrophone(selectElement) {
  if (!selectElement) return { deviceId: null, deviceName: null };

  const selectedOption = selectElement.options[selectElement.selectedIndex];
  return {
    deviceId: selectElement.value,
    deviceName: selectedOption ? selectedOption.dataset.micName : null
  };
}

// =============================================================================
// MIC TEST RECORDING
// =============================================================================

class MicTester {
  constructor() {
    this.isTesting = false;
    this.testTimeout = null;
    this.audioMonitor = new AudioMonitor();
  }

  /**
   * Start mic test recording
   * @param {string|null} deviceId - WebRTC device ID (for audio monitoring)
   * @param {string|null} deviceName - Device name (for FFmpeg recording)
   * @param {function} onLevel - Callback for audio level (0-100)
   * @param {function} onComplete - Callback when test completes
   * @param {number} duration - Test duration in ms (default 5000)
   */
  async start(deviceId, deviceName, onLevel, onComplete, duration = 5000) {
    if (this.isTesting) return { success: false, error: 'Test already running' };

    try {
      this.isTesting = true;

      // Start audio monitoring for visual feedback
      await this.audioMonitor.start(deviceId, onLevel);

      // Start FFmpeg recording via IPC (pass device NAME, not ID)
      const startResult = await ipcRenderer.invoke('start-mic-test', deviceName);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      // Auto-stop after duration
      this.testTimeout = setTimeout(async () => {
        if (this.isTesting) {
          const result = await this.stop();
          if (onComplete) onComplete(result);
        }
      }, duration);

      return { success: true };
    } catch (error) {
      console.error('Mic test start error:', error);
      this.stop();
      throw error;
    }
  }

  /**
   * Stop mic test and get audio data
   * @returns {object} - { success, audioData, mimeType, error }
   */
  async stop() {
    const wasRecording = this.isTesting;
    this.isTesting = false;

    // Clear timeout
    if (this.testTimeout) {
      clearTimeout(this.testTimeout);
      this.testTimeout = null;
    }

    // Stop audio monitoring
    this.audioMonitor.stop();

    if (!wasRecording) {
      return { success: false, error: 'Not recording' };
    }

    try {
      // Stop FFmpeg recording
      const stopResult = await ipcRenderer.invoke('stop-mic-test');
      if (!stopResult.success) {
        return { success: false, error: stopResult.error };
      }

      // Get the recorded audio
      const audioResult = await ipcRenderer.invoke('get-mic-test-audio');
      if (!audioResult.success) {
        return { success: false, error: audioResult.error };
      }

      return {
        success: true,
        audioData: audioResult.data,
        mimeType: audioResult.mimeType
      };
    } catch (error) {
      console.error('Mic test stop error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if test is running
   */
  get isRunning() {
    return this.isTesting;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  AudioMonitor,
  MicTester,
  loadMicrophones,
  getSelectedMicrophone
};
