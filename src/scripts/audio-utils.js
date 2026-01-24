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
 * @param {string|null} selectedName - Currently selected device name (fallback if ID not found)
 * @returns {object} - { deviceId, deviceName, wasFoundById, wasFoundByName } of selected mic
 */
async function loadMicrophones(selectElement, selectedId = null, selectedName = null) {
  if (!selectElement) return { deviceId: null, deviceName: null, wasFoundById: false, wasFoundByName: false };

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    selectElement.innerHTML = '';

    if (mics.length === 0) {
      selectElement.innerHTML = '<option value="">Kein Mikrofon gefunden</option>';
      return { deviceId: null, deviceName: null, wasFoundById: false, wasFoundByName: false };
    }

    // Filter out duplicate devices (Default, Communications entries)
    // Windows creates virtual entries that point to the same physical device
    // We detect these by checking if the device name appears in another entry's label
    const uniqueMics = mics.filter(mic => {
      // Always filter out generic "default" and "communications" deviceIds
      if (mic.deviceId === 'default' || mic.deviceId === 'communications') {
        return false;
      }

      // Check if this label contains a prefix pattern like "Something - ActualName"
      // and if "ActualName" exists as a standalone device
      const dashIndex = mic.label.indexOf(' - ');
      if (dashIndex > 0) {
        const suffix = mic.label.substring(dashIndex + 3); // Part after " - "
        // If there's another mic with exactly this suffix as its full label, skip this one
        const hasStandalone = mics.some(other =>
          other.deviceId !== mic.deviceId && other.label === suffix
        );
        if (hasStandalone) return false;
      }

      return true;
    });

    // If filtering removed all mics, fall back to original list
    const finalMics = uniqueMics.length > 0 ? uniqueMics : mics;

    let selectedDeviceId = null;
    let selectedDeviceName = null;
    let wasFoundById = false;
    let wasFoundByName = false;

    // First pass: try to find by ID
    finalMics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      const micLabel = mic.label || `Mikrofon ${index + 1}`;
      option.textContent = micLabel;
      option.dataset.micName = micLabel;  // Store name for FFmpeg

      if (mic.deviceId === selectedId) {
        option.selected = true;
        selectedDeviceId = mic.deviceId;
        selectedDeviceName = micLabel;
        wasFoundById = true;
      }

      selectElement.appendChild(option);
    });

    // Second pass: if not found by ID, try to find by name (with fuzzy matching)
    if (!selectedDeviceId && selectedName) {
      // Extract the core device identifier (e.g., vendor:product ID like "046d:0aba")
      const savedVendorId = selectedName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1];

      for (let i = 0; i < selectElement.options.length; i++) {
        const option = selectElement.options[i];
        const micName = option.dataset.micName || '';

        // Try exact match first
        if (micName === selectedName) {
          option.selected = true;
          selectedDeviceId = option.value;
          selectedDeviceName = micName;
          wasFoundByName = true;
          console.log('Microphone found by exact name:', selectedName);
          break;
        }

        // Try vendor:product ID match (handles Windows renumbering like "2- Logitech")
        if (savedVendorId) {
          const currentVendorId = micName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1];
          if (currentVendorId && currentVendorId.toLowerCase() === savedVendorId.toLowerCase()) {
            option.selected = true;
            selectedDeviceId = option.value;
            selectedDeviceName = micName;
            wasFoundByName = true;
            console.log('Microphone found by vendor ID:', savedVendorId);
            break;
          }
        }
      }
    }

    // If configured mic not found, add placeholder option
    if (!selectedDeviceId && (selectedId || selectedName) && finalMics.length > 0) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '-- Bitte Mikrofon auswählen --';
      placeholder.selected = true;
      placeholder.disabled = true;
      selectElement.insertBefore(placeholder, selectElement.firstChild);
    }

    // Only fall back to first mic if we had no preference at all
    if (!selectedDeviceId && !selectedId && !selectedName && finalMics.length > 0) {
      selectElement.options[0].selected = true;
      selectedDeviceId = finalMics[0].deviceId;
      selectedDeviceName = finalMics[0].label || 'Mikrofon 1';
    }

    return { deviceId: selectedDeviceId, deviceName: selectedDeviceName, wasFoundById, wasFoundByName };
  } catch (error) {
    console.error('Error loading microphones:', error);
    selectElement.innerHTML = '<option value="">Fehler beim Laden</option>';
    return { deviceId: null, deviceName: null, wasFoundById: false, wasFoundByName: false };
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
