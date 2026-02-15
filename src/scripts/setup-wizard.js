/**
 * DentDoc Setup Wizard (Einrichtungsassistent)
 * Interactive step-by-step onboarding for new users
 */

// Use existing ipcRenderer from dashboard.js (it's already declared there)
// We just reference it directly since both scripts run in the same context

// Shared audio utilities - see src/scripts/audio-utils.js for:
// - AudioMonitor, MicTester, loadMicrophones, getSelectedMicrophone
// - isMicrophoneMatch, isMicrophoneAvailable (mic matching with vendor:product ID)
const wizardAudioUtils = require('./scripts/audio-utils');

class SetupWizard {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 9; // 0-8 (added DSGVO step)
    this.settings = {
      microphoneId: null, // Windows device name for FFmpeg
      microphoneSource: 'desktop', // 'desktop' or 'iphone'
      shortcut: 'F9',
      docMode: 'agent-v2.1',
      autoExport: true,
      transcriptPath: '',
      keepAudio: true // Enabled by default for full functionality
    };

    // Audio test state - uses shared MicTester from audio-utils
    this.micTester = null;  // Created on first use

    // Shortcut recording state
    this.isRecordingShortcut = false;

    // Mic wizard substep state machine
    this.micWizardState = 'initial_question'; // initial_question, has_mic, phone_question, phone_pairing, phone_test, no_mic
    this.phonePairingId = null;
    this.phonePairingPollInterval = null;
    this.isPhoneConnected = false;
    this.isPhoneTesting = false;
    this.phoneTestWavPath = null; // Path to recorded test audio file
    this.phoneCountdownInterval = null; // Timer interval for countdown
    this.phoneTestTimeLeft = 10; // Seconds remaining

    this.init();
  }

  async init() {
    // Always bind events so keyboard shortcuts work
    this.bindEvents();

    // Setup IPC listeners for real-time data
    this.setupPhoneLevelListener();

    // Check if wizard should be shown
    const shouldShow = await ipcRenderer.invoke('check-first-run', 'setup-wizard');

    if (shouldShow) {
      // Load default settings
      const settings = await ipcRenderer.invoke('get-settings');
      this.settings.shortcut = settings.shortcut || 'F9';
      this.settings.transcriptPath = settings.transcriptPath || '';
      this.settings.microphoneId = settings.microphoneId || null; // Windows device name
      this.settings.docMode = settings.docMode || 'agent-v2.1';
      this.settings.autoExport = settings.autoExport !== false;
      this.settings.keepAudio = settings.keepAudio !== false; // Default true

      // Update path input fields with actual paths
      this.updatePathDisplays();

      this.show();
      this.loadMicrophones();
    }
  }

  updatePathDisplays() {
    const transcriptPathEl = document.getElementById('wizardTranscriptPath');

    if (transcriptPathEl) {
      transcriptPathEl.value = this.settings.transcriptPath;
      transcriptPathEl.placeholder = this.settings.transcriptPath || 'Kein Pfad gesetzt';
    }
  }

  show() {
    const overlay = document.getElementById('setupWizardOverlay');
    if (overlay) {
      overlay.classList.add('active');
      this.updateProgress();
      this.showStep(0);
    }
  }

  hide() {
    const overlay = document.getElementById('setupWizardOverlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
    this.stopMicTest();
    // Clean up mic test audio file
    ipcRenderer.invoke('cleanup-mic-test');
    const playbackDiv = document.getElementById('wizardMicPlayback');
    if (playbackDiv) playbackDiv.style.display = 'none';
  }

  async closeWizard() {
    // Mark wizard as completed so it won't show again
    await ipcRenderer.invoke('mark-tour-completed', 'setup-wizard');
    this.hide();
  }

  async skipSetup() {
    // Mark wizard as completed and close immediately
    await ipcRenderer.invoke('mark-tour-completed', 'setup-wizard');
    this.hide();
  }

  bindEvents() {
    // Navigation buttons
    document.getElementById('wizardNextBtn')?.addEventListener('click', () => this.nextStep());
    document.getElementById('wizardBackBtn')?.addEventListener('click', () => this.prevStep());
    document.getElementById('wizardSkipBtn')?.addEventListener('click', () => this.skipStep());
    document.getElementById('wizardFinishBtn')?.addEventListener('click', () => this.finish());
    document.getElementById('wizardStartBtn')?.addEventListener('click', () => this.nextStep());

    // Close button
    document.getElementById('wizardCloseBtn')?.addEventListener('click', () => this.closeWizard());

    // Skip setup button (on welcome page)
    document.getElementById('wizardSkipSetupBtn')?.addEventListener('click', () => this.skipSetup());

    // Microphone
    document.getElementById('wizardMicSelect')?.addEventListener('change', async (e) => {
      const mic = wizardAudioUtils.getSelectedMicrophone(e.target);
      this.settings.microphoneId = mic.deviceId;
      this.settings.microphoneName = mic.deviceName;
      if (this.micTester && this.micTester.isRunning) {
        this.micTester.stop();
        this.resetMicTestUI();
      }
      // Hide profile mic error if user selects a different mic
      this.hideProfileMicError();
      // Save mic setting immediately so voice enrollment can use it
      await ipcRenderer.invoke('save-settings', {
        microphoneId: mic.deviceId,
        microphoneName: mic.deviceName
      });
      // Refresh volume slider for new mic
      this.loadWizardMicVolume();
    });
    document.getElementById('wizardMicTestBtn')?.addEventListener('click', () => this.toggleMicTest());
    document.getElementById('wizardPlayMicBtn')?.addEventListener('click', () => this.playMicTest());

    // Wizard mic volume slider
    let wizardMicVolumeTimeout = null;
    document.getElementById('wizardMicVolumeSlider')?.addEventListener('input', (e) => {
      document.getElementById('wizardMicVolumeValue').textContent = e.target.value + '%';
      e.target.style.setProperty('--fill', e.target.value + '%');
      if (wizardMicVolumeTimeout) clearTimeout(wizardMicVolumeTimeout);
      wizardMicVolumeTimeout = setTimeout(async () => {
        try {
          await ipcRenderer.invoke('set-mic-volume', parseInt(e.target.value), this.settings.microphoneName);
        } catch (err) {
          console.error('[Wizard MicVolume] Failed to set:', err);
        }
      }, 150);
    });

    // Shortcut
    document.getElementById('wizardChangeShortcutBtn')?.addEventListener('click', () => this.startShortcutRecording());
    document.addEventListener('keydown', (e) => this.handleShortcutKeydown(e));

    // AI Mode - always agent-v2.1, no selection needed

    // Toggles
    document.getElementById('wizardTranscriptToggle')?.addEventListener('click', () => {
      const toggle = document.getElementById('wizardTranscriptToggle');
      toggle.classList.toggle('active');
      this.settings.autoExport = toggle.classList.contains('active');
      document.getElementById('wizardTranscriptPathSection').style.display =
        this.settings.autoExport ? 'block' : 'none';
    });

    document.getElementById('wizardAudioToggle')?.addEventListener('click', () => {
      const toggle = document.getElementById('wizardAudioToggle');
      toggle.classList.toggle('active');
      this.settings.keepAudio = toggle.classList.contains('active');
    });

    // Path buttons
    document.getElementById('wizardBrowseTranscriptBtn')?.addEventListener('click', async () => {
      console.log('Wizard: Browse transcript folder clicked');
      const result = await ipcRenderer.invoke('select-folder-with-validation', {
        title: 'Transkript-Ordner auswählen'
      });
      console.log('Wizard: select-folder-with-validation result:', result);

      if (result.canceled) {
        return;
      }

      if (!result.success) {
        console.log('Wizard: Folder validation failed:', result.validation?.error);
        if (typeof showFolderValidationError === 'function') {
          showFolderValidationError('wizardTranscriptPath', result.validation?.error || 'Ordner nicht verwendbar');
        } else {
          alert(result.validation?.error || 'Ordner nicht verwendbar');
        }
        return;
      }

      // Success - clear any previous error
      if (typeof clearFolderValidationError === 'function') {
        clearFolderValidationError('wizardTranscriptPath');
      }
      this.settings.transcriptPath = result.path;
      document.getElementById('wizardTranscriptPath').value = result.path;
    });

    // Voice profile recording in wizard
    document.getElementById('wizardProfileRecordBtn')?.addEventListener('click', () => {
      this.startProfileRecording();
    });

    document.getElementById('wizardProfileCancelBtn')?.addEventListener('click', () => {
      this.cancelProfileRecording();
    });

    // Mic error link - go back to mic selection step
    document.getElementById('wizardProfileMicErrorLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.hideProfileMicError();
      this.showStep(1); // Step 1 is microphone setup
    });

    // Auto-refresh mic dropdown and hide error when microphone is reconnected
    // Uses wizardAudioUtils.isMicrophoneAvailable() for smart matching (handles USB renumbering)
    // See: src/scripts/audio-utils.js - isMicrophoneMatch(), isMicrophoneAvailable()
    this.deviceChangeDebounce = null;
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      clearTimeout(this.deviceChangeDebounce);
      this.deviceChangeDebounce = setTimeout(async () => {
        // Refresh mic dropdown if on mic setup step (step 1)
        if (this.currentStep === 1) {
          // Don't refresh during mic test
          if (this.micTester && this.micTester.isRunning) {
            console.log('[Wizard] Device change detected, but mic test running - skipping refresh');
            return;
          }
          console.log('[Wizard] Device change detected, refreshing microphone list...');
          await this.loadMicrophones();
        }

        // Check if mic error is visible and hide if mic reconnected
        const errorCard = document.getElementById('wizardProfileMicError');
        if (errorCard && errorCard.style.display !== 'none') {
          try {
            const settings = await ipcRenderer.invoke('get-settings');
            const selectedMicName = settings?.microphoneName;

            if (selectedMicName) {
              // Use shared utility function for mic availability check
              const micAvailable = await wizardAudioUtils.isMicrophoneAvailable(selectedMicName);

              if (micAvailable) {
                console.log('[Wizard] Selected microphone reconnected, hiding error card');
                this.hideProfileMicError();
              }
            }
          } catch (e) {
            console.warn('[Wizard] Could not check mic availability:', e.message);
          }
        }
      }, 500);
    });

    // === Mic Wizard Decision Tree Events ===
    this.bindMicWizardEvents();
  }

  // ==========================================
  // MIC WIZARD STATE MACHINE
  // ==========================================

  bindMicWizardEvents() {
    // Q1: Has USB Mic? - Yes
    document.getElementById('wizardMicHasYes')?.addEventListener('click', () => {
      this.setMicWizardState('has_mic');
      this.loadMicrophones();
    });

    // Q1: Has USB Mic? - No
    document.getElementById('wizardMicHasNo')?.addEventListener('click', () => {
      this.setMicWizardState('phone_question');
    });

    // Q2: Use Phone? - Yes
    document.getElementById('wizardPhoneYes')?.addEventListener('click', async () => {
      // Check if phone is already paired
      const status = await ipcRenderer.invoke('iphone-get-status');
      if (status.paired && status.deviceName) {
        this.pairedDeviceName = status.deviceName;
        this.setMicWizardState('phone_already_paired');
      } else {
        this.setMicWizardState('phone_pairing');
        this.startPhonePairing();
      }
    });

    // Already paired - use existing device
    document.getElementById('wizardPhoneUseExisting')?.addEventListener('click', () => {
      this.settings.microphoneSource = 'iphone';
      this.setMicWizardState('phone_test');
    });

    // Already paired - pair new device
    document.getElementById('wizardPhonePairNew')?.addEventListener('click', async () => {
      // Unpair old device first
      await ipcRenderer.invoke('iphone-unpair');
      this.setMicWizardState('phone_pairing');
      this.startPhonePairing();
    });

    // Q2: Use Phone? - No
    document.getElementById('wizardPhoneNo')?.addEventListener('click', () => {
      this.setMicWizardState('no_mic');
    });

    // Back buttons
    document.getElementById('wizardMicBackToQuestion')?.addEventListener('click', () => {
      this.stopMicTest();
      this.setMicWizardState('initial_question');
    });

    document.getElementById('wizardPhoneBackToQuestion')?.addEventListener('click', () => {
      this.setMicWizardState('initial_question');
    });

    document.getElementById('wizardPairingBackToPhoneQuestion')?.addEventListener('click', () => {
      this.cancelPhonePairing();
      this.setMicWizardState('phone_question');
    });

    // Phone test buttons
    document.getElementById('wizardPhoneTestBtn')?.addEventListener('click', () => {
      this.togglePhoneTest();
    });

    document.getElementById('wizardPhonePlayBtn')?.addEventListener('click', () => {
      this.playPhoneTest();
    });
  }

  setMicWizardState(newState) {
    this.micWizardState = newState;
    this.updateMicSubstepVisibility();
    this.updateMicNavigation();
  }

  updateMicSubstepVisibility() {
    // Hide all substeps
    document.querySelectorAll('.wizard-mic-substep').forEach(el => {
      el.style.display = 'none';
    });

    // Show the appropriate substep
    const substepMap = {
      'initial_question': 'wizardMicSubstepInitial',
      'has_mic': 'wizardMicSubstepHasMic',
      'phone_question': 'wizardMicSubstepPhoneQuestion',
      'phone_already_paired': 'wizardMicSubstepPhoneAlreadyPaired',
      'phone_pairing': 'wizardMicSubstepPhonePairing',
      'phone_test': 'wizardMicSubstepPhoneTest',
      'no_mic': 'wizardMicSubstepNoMic'
    };

    // Update device name if showing already paired screen
    if (this.micWizardState === 'phone_already_paired') {
      const nameEl = document.getElementById('wizardPairedDeviceName');
      if (nameEl) nameEl.textContent = this.pairedDeviceName || 'Smartphone';
    }

    const substepId = substepMap[this.micWizardState];
    if (substepId) {
      const substep = document.getElementById(substepId);
      if (substep) substep.style.display = 'block';
    }
  }

  updateMicNavigation() {
    const nextBtn = document.getElementById('wizardNextBtn');
    const backBtn = document.getElementById('wizardBackBtn');
    const skipBtn = document.getElementById('wizardSkipBtn');

    // Only handle step 1 - let updateNavigation() handle other steps
    if (this.currentStep !== 1) {
      // Reset disabled state and button text back to normal
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
        nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Weiter';
      }
      return;
    }

    // Step 1: Disable next button on question states (must make a choice)
    if (this.micWizardState === 'initial_question' ||
        this.micWizardState === 'phone_question' ||
        this.micWizardState === 'phone_already_paired') {
      // Disable navigation on these screens (user makes choice via substep buttons)
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.5';
        nextBtn.style.pointerEvents = 'none';
        nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Weiter';
      }
      if (skipBtn) skipBtn.style.display = 'none';
    } else if (this.micWizardState === 'phone_pairing') {
      // Phone pairing - show skip button so user can skip if pairing doesn't work
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.5';
        nextBtn.style.pointerEvents = 'none';
        nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Weiter';
      }
      if (skipBtn) skipBtn.style.display = 'block';
    } else if (this.micWizardState === 'no_mic') {
      // No mic - enable buttons, change text to "Trotzdem fortfahren"
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
        nextBtn.style.display = 'flex';
        nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Trotzdem fortfahren';
      }
      if (backBtn) backBtn.style.display = 'flex';
      if (skipBtn) skipBtn.style.display = 'none';
    } else {
      // Enable navigation for has_mic and phone_test states
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
        nextBtn.style.display = 'flex';
        nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg> Weiter';
      }
      if (backBtn) backBtn.style.display = 'flex';
      if (skipBtn) skipBtn.style.display = 'none';
    }
  }

  // ==========================================
  // PHONE PAIRING FLOW
  // ==========================================

  async startPhonePairing() {
    try {
      const result = await ipcRenderer.invoke('iphone-pair-start');

      if (!result.success) {
        throw new Error(result.error || 'Pairing konnte nicht gestartet werden');
      }

      this.phonePairingId = result.pairingId;

      // Generate QR code
      const qrContainer = document.getElementById('wizardPhoneQRContainer');
      if (qrContainer) {
        qrContainer.innerHTML = ''; // Clear loading state

        // Use QRCode library (should be available via require or global)
        const QRCode = window.QRCode || require('qrcode');
        const canvas = document.createElement('canvas');

        await QRCode.toCanvas(canvas, result.pairingUrl, {
          width: 200,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });

        qrContainer.appendChild(canvas);
      }

      // Show URL
      const urlEl = document.getElementById('wizardPhonePairingUrl');
      if (urlEl) urlEl.textContent = result.pairingUrl;

      // Update connection status
      this.updatePhoneConnectionStatus('waiting');

      // Start polling for connection
      this.startPhonePairingPoll(result.pairingId);

    } catch (error) {
      console.error('Phone pairing error:', error);
      this.updatePhoneConnectionStatus('error', error.message);
    }
  }

  startPhonePairingPoll(pairingId) {
    this.phonePairingPollInterval = setInterval(async () => {
      try {
        const status = await ipcRenderer.invoke('iphone-pair-status', pairingId);

        if (status.paired || status.status === 'paired') {
          clearInterval(this.phonePairingPollInterval);
          this.phonePairingPollInterval = null;

          this.isPhoneConnected = true;
          this.settings.microphoneSource = 'iphone';

          // Update device name
          const nameEl = document.getElementById('wizardPhoneDeviceName');
          if (nameEl) nameEl.textContent = status.deviceName || 'Smartphone';

          // Move to phone test state
          this.setMicWizardState('phone_test');

        } else if (status.status === 'expired') {
          clearInterval(this.phonePairingPollInterval);
          this.phonePairingPollInterval = null;
          this.updatePhoneConnectionStatus('expired');
        }
      } catch (error) {
        console.error('Pairing poll error:', error);
      }
    }, 2000);

    // Auto-timeout after 5 minutes
    setTimeout(() => {
      if (this.phonePairingPollInterval) {
        clearInterval(this.phonePairingPollInterval);
        this.phonePairingPollInterval = null;
        this.updatePhoneConnectionStatus('expired');
      }
    }, 5 * 60 * 1000);
  }

  cancelPhonePairing() {
    if (this.phonePairingPollInterval) {
      clearInterval(this.phonePairingPollInterval);
      this.phonePairingPollInterval = null;
    }
    this.phonePairingId = null;

    // Try to cancel on backend
    ipcRenderer.invoke('iphone-cancel-pair').catch(() => {});
  }

  updatePhoneConnectionStatus(status, errorMessage = '') {
    const statusEl = document.getElementById('wizardPhoneConnectionStatus');
    if (!statusEl) return;

    switch (status) {
      case 'waiting':
        statusEl.innerHTML = `
          <div class="wizard-status-spinner"></div>
          <span>Warte auf Verbindung...</span>
        `;
        statusEl.className = 'wizard-connection-status waiting';
        break;
      case 'connected':
        statusEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>Verbunden!</span>
        `;
        statusEl.className = 'wizard-connection-status connected';
        break;
      case 'expired':
        statusEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>QR-Code abgelaufen. <a href="#" id="wizardRegenerateQR">Neu generieren</a></span>
        `;
        statusEl.className = 'wizard-connection-status expired';
        // Bind regenerate handler
        document.getElementById('wizardRegenerateQR')?.addEventListener('click', (e) => {
          e.preventDefault();
          this.startPhonePairing();
        });
        break;
      case 'error':
        statusEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <span>Fehler: ${errorMessage}</span>
        `;
        statusEl.className = 'wizard-connection-status error';
        break;
    }
  }

  // ==========================================
  // PHONE AUDIO TEST
  // ==========================================

  togglePhoneTest() {
    if (this.isPhoneTesting) {
      this.stopPhoneTest();
    } else {
      this.startPhoneTest();
    }
  }

  async startPhoneTest() {
    const container = document.querySelector('.wizard-phone-test-container');
    const btn = document.getElementById('wizardPhoneTestBtn');
    const btnText = document.getElementById('wizardPhoneTestBtnText');
    const testRow = document.getElementById('wizardPhoneTestRow');
    const levelBar = document.getElementById('wizardPhoneLevelBar');
    const timerText = document.getElementById('wizardPhoneTimerText');
    const status = document.getElementById('wizardPhoneStatus');
    const playbackDiv = document.getElementById('wizardPhonePlayback');

    try {
      this.isPhoneTesting = true;
      this.phoneTestWavPath = null;
      this.phoneTestTimeLeft = 10;

      // Update UI for recording state
      if (container) container.classList.add('recording');
      if (btnText) btnText.textContent = 'Stoppen';
      if (testRow) testRow.style.display = 'flex';
      if (timerText) timerText.textContent = '10';
      if (status) status.textContent = 'Sprechen Sie jetzt ins Handy...';
      if (playbackDiv) playbackDiv.style.display = 'none';
      if (levelBar) levelBar.style.width = '0%';

      // Start countdown timer
      this.startPhoneCountdown();

      // This call blocks for 10 seconds while recording
      const result = await ipcRenderer.invoke('iphone-audio-test');

      // Recording finished (either completed or was cancelled)
      this.isPhoneTesting = false;
      if (this.phoneCountdownInterval) {
        clearInterval(this.phoneCountdownInterval);
        this.phoneCountdownInterval = null;
      }

      // Reset UI
      if (container) container.classList.remove('recording');
      if (btnText) btnText.textContent = 'Test starten';
      if (testRow) testRow.style.display = 'none';
      if (levelBar) levelBar.style.width = '0%';

      if (!result.success) {
        if (result.cancelled) {
          if (status) status.textContent = 'Test abgebrochen';
          return;
        }
        throw new Error(result.error || 'Test konnte nicht gestartet werden');
      }

      // Store the wav path for playback
      this.phoneTestWavPath = result.wavPath;
      console.log('[Phone Test] Recording saved to:', this.phoneTestWavPath);

      if (status) {
        status.textContent = 'Test abgeschlossen!';
        status.className = 'wizard-mic-status success';
      }
      if (playbackDiv) playbackDiv.style.display = 'flex';

    } catch (error) {
      console.error('Phone test error:', error);
      this.isPhoneTesting = false;
      if (this.phoneCountdownInterval) {
        clearInterval(this.phoneCountdownInterval);
        this.phoneCountdownInterval = null;
      }
      if (status) status.textContent = 'Fehler: ' + error.message;
      this.resetPhoneTestUI();
    }
  }

  async stopPhoneTest() {
    // Cancel the ongoing test
    await ipcRenderer.invoke('iphone-audio-test-cancel');
    this.isPhoneTesting = false;

    if (this.phoneCountdownInterval) {
      clearInterval(this.phoneCountdownInterval);
      this.phoneCountdownInterval = null;
    }

    this.resetPhoneTestUI();
    const status = document.getElementById('wizardPhoneStatus');
    if (status) status.textContent = 'Test abgebrochen';
  }

  resetPhoneTestUI() {
    this.isPhoneTesting = false;

    const container = document.querySelector('.wizard-phone-test-container');
    const btnText = document.getElementById('wizardPhoneTestBtnText');
    const testRow = document.getElementById('wizardPhoneTestRow');
    const levelBar = document.getElementById('wizardPhoneLevelBar');

    if (container) container.classList.remove('recording');
    if (btnText) btnText.textContent = 'Test starten';
    if (testRow) testRow.style.display = 'none';
    if (levelBar) levelBar.style.width = '0%';
  }

  startPhoneCountdown() {
    const timerText = document.getElementById('wizardPhoneTimerText');
    this.phoneTestTimeLeft = 10;

    this.phoneCountdownInterval = setInterval(() => {
      this.phoneTestTimeLeft--;
      if (timerText) timerText.textContent = this.phoneTestTimeLeft;

      if (this.phoneTestTimeLeft <= 0) {
        clearInterval(this.phoneCountdownInterval);
        this.phoneCountdownInterval = null;
      }
    }, 1000);
  }

  setupPhoneLevelListener() {
    // Listen for real audio levels from the iPhone test
    ipcRenderer.on('iphone-test-level', (event, level) => {
      if (!this.isPhoneTesting) return;

      const levelBar = document.getElementById('wizardPhoneLevelBar');
      if (levelBar) {
        // Same scaling as in dashboard.js for consistency
        const scaled = Math.sqrt(level * 5000) * 10;
        const percent = Math.min(100, Math.max(3, scaled));
        levelBar.style.width = `${percent}%`;
      }
    });
  }

  async playPhoneTest() {
    const btn = document.getElementById('wizardPhonePlayBtn');
    const btnText = document.getElementById('wizardPhonePlayBtnText');
    const audio = document.getElementById('wizardPhoneAudio');
    const status = document.getElementById('wizardPhoneStatus');

    // If already playing, stop
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      if (btnText) btnText.textContent = 'Aufnahme anhören';
      return;
    }

    if (!this.phoneTestWavPath) {
      if (status) status.textContent = 'Keine Testaufnahme vorhanden';
      return;
    }

    try {
      if (btnText) btnText.textContent = 'Stoppen';

      // Get audio data as base64 for internal playback
      const result = await ipcRenderer.invoke('get-audio-file-data', this.phoneTestWavPath);
      if (!result.success) {
        throw new Error(result.error || 'Datei konnte nicht geladen werden');
      }

      if (audio) {
        audio.src = `data:audio/wav;base64,${result.data}`;
        audio.onended = () => {
          if (btnText) btnText.textContent = 'Aufnahme anhören';
        };
        audio.onerror = () => {
          if (btnText) btnText.textContent = 'Aufnahme anhören';
          if (status) status.textContent = 'Wiedergabe-Fehler';
        };
        await audio.play();
      }
    } catch (error) {
      console.error('Phone playback error:', error);
      if (status) status.textContent = 'Wiedergabe-Fehler: ' + error.message;
      if (btnText) btnText.textContent = 'Aufnahme anhören';
    }
  }

  // ==========================================
  // INCOMPLETE WIZARD HANDLING
  // ==========================================

  async closeWizardIncomplete() {
    // Close wizard but do NOT mark as completed
    // This means it will show again on next app launch
    this.cancelPhonePairing();
    this.stopMicTest();

    // Save incomplete state
    await ipcRenderer.invoke('save-settings', {
      setupIncomplete: true,
      setupIncompleteReason: 'no_microphone'
    });

    this.hide();
  }

  // Voice profile recording state
  profileRecordingState = {
    isRecording: false,
    timer: null,
    seconds: 0,
    audioContext: null,
    mediaStream: null,
    analyser: null,
    animationFrame: null
  };

  // Store pending enrollment data for when Start is clicked in overlay
  profilePendingEnrollment = null;

  async loadExistingProfiles() {
    try {
      const profiles = await ipcRenderer.invoke('get-voice-profiles');
      const container = document.getElementById('wizardExistingProfiles');
      const list = document.getElementById('wizardProfilesList');

      if (profiles && profiles.length > 0) {
        container.style.display = 'block';
        list.innerHTML = profiles.map(p => `
          <span style="background: var(--bg-tertiary); padding: 4px 10px; border-radius: 12px; font-size: 0.8125rem; color: var(--text-secondary);">
            ${p.role === 'Arzt' ? '👨‍⚕️' : '👩‍💼'} ${p.name}
          </span>
        `).join('');
      } else {
        container.style.display = 'none';
      }
    } catch (error) {
      console.error('Error loading profiles:', error);
    }
  }

  // ============================================================================
  // Voice Profile Recording Overlay
  // ============================================================================

  /**
   * Show recording overlay in ready state (with Start button)
   */
  async showRecordingOverlay(name, role) {
    // Store enrollment data for when Start is clicked
    this.profilePendingEnrollment = { name, role };

    const overlay = document.getElementById('profilesRecordingOverlay');
    const statusBadge = document.getElementById('profilesOverlayStatusBadge');
    const statusIcon = document.getElementById('profilesOverlayStatusIcon');
    const statusText = document.getElementById('profilesOverlayStatusText');
    const progressSection = document.getElementById('profilesOverlayProgressSection');
    const startBtn = document.getElementById('profilesOverlayStartBtn');

    // Show overlay in ready state
    overlay.style.display = 'flex';

    // Set ready state
    statusBadge.className = 'profiles-overlay-status-badge ready';
    statusIcon.textContent = '🎙️';
    statusText.textContent = 'Bereit zur Aufnahme';

    // Hide progress, show start button
    progressSection.style.display = 'none';
    startBtn.style.display = 'inline-block';

    // Reset progress
    document.getElementById('profilesOverlayTime').textContent = '0s / 30s';
    document.getElementById('profilesOverlayProgressFill').style.width = '0%';

    // Start mic level monitoring
    await this.startOverlayMicMonitoring();
  }

  /**
   * Switch overlay to recording state and start actual recording
   */
  async startRecordingFromOverlay() {
    if (!this.profilePendingEnrollment) return;

    const { name, role } = this.profilePendingEnrollment;
    const statusBadge = document.getElementById('profilesOverlayStatusBadge');
    const statusIcon = document.getElementById('profilesOverlayStatusIcon');
    const statusText = document.getElementById('profilesOverlayStatusText');
    const progressSection = document.getElementById('profilesOverlayProgressSection');
    const startBtn = document.getElementById('profilesOverlayStartBtn');

    // Switch to recording state
    statusBadge.className = 'profiles-overlay-status-badge recording';
    statusIcon.innerHTML = '<span class="profiles-recording-dot"></span>';
    statusText.textContent = 'Aufnahme läuft';

    // Show progress, hide start button
    progressSection.style.display = 'block';
    startBtn.style.display = 'none';

    try {
      this.profileRecordingState.isRecording = true;
      this.profileRecordingState.seconds = 0;

      // Start backend recording
      const result = await ipcRenderer.invoke('start-voice-enrollment', { name, role });

      // Check if start was cancelled (race condition with cancel button)
      if (result.cancelled) {
        this.closeRecordingOverlay();
        this.profileRecordingState.isRecording = false;
        this.profilePendingEnrollment = null;
        return;
      }

      // Check if there was an error
      if (result.error) {
        throw new Error(result.error);
      }

      // Timer updates overlay progress
      this.profileRecordingState.timer = setInterval(() => {
        this.profileRecordingState.seconds++;
        this.updateOverlayProgress(this.profileRecordingState.seconds, 30);

        if (this.profileRecordingState.seconds >= 30) {
          this.stopProfileRecording();
        }
      }, 1000);

    } catch (error) {
      console.error('Error starting profile recording:', error);

      // Close overlay on error
      this.closeRecordingOverlay();

      // Check if it's a mic disconnected error
      if (error.message && error.message.includes('Mikrofon nicht verbunden')) {
        const deviceMatch = error.message.match(/: (.+)$/);
        const deviceName = deviceMatch ? deviceMatch[1] : null;
        this.showProfileMicError(deviceName);
        this.showProfileStatus('', '');
      } else {
        this.showProfileStatus('Fehler beim Starten: ' + error.message, 'error');
      }

      this.profileRecordingState.isRecording = false;
      this.profilePendingEnrollment = null;
    }
  }

  /**
   * Update progress display in overlay
   */
  updateOverlayProgress(seconds, total) {
    const timeEl = document.getElementById('profilesOverlayTime');
    const progressEl = document.getElementById('profilesOverlayProgressFill');
    if (timeEl) timeEl.textContent = `${seconds}s / ${total}s`;
    if (progressEl) progressEl.style.width = `${(seconds / total) * 100}%`;
  }

  /**
   * Close recording overlay
   */
  closeRecordingOverlay() {
    const overlay = document.getElementById('profilesRecordingOverlay');
    if (overlay) overlay.style.display = 'none';
    this.stopOverlayMicMonitoring();
    this.profilePendingEnrollment = null;
  }

  /**
   * Start mic level monitoring for overlay
   */
  async startOverlayMicMonitoring() {
    try {
      const micId = this.settings.microphoneId;
      const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };

      this.profileRecordingState.overlayMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.profileRecordingState.overlayAudioContext = new AudioContext();
      this.profileRecordingState.overlayAnalyser = this.profileRecordingState.overlayAudioContext.createAnalyser();
      this.profileRecordingState.overlayAnalyser.fftSize = 256;

      const source = this.profileRecordingState.overlayAudioContext.createMediaStreamSource(
        this.profileRecordingState.overlayMediaStream
      );
      source.connect(this.profileRecordingState.overlayAnalyser);

      const bufferLength = this.profileRecordingState.overlayAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateLevel = () => {
        this.profileRecordingState.overlayAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalized = Math.min(average / 128 * 100, 100);
        const micBar = document.getElementById('profilesOverlayMicBar');
        if (micBar) micBar.style.width = normalized + '%';
        this.profileRecordingState.overlayAnimFrame = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch (error) {
      console.error('[Wizard Overlay] Audio monitoring error:', error);
    }
  }

  /**
   * Stop mic level monitoring for overlay
   */
  stopOverlayMicMonitoring() {
    if (this.profileRecordingState.overlayAnimFrame) {
      cancelAnimationFrame(this.profileRecordingState.overlayAnimFrame);
      this.profileRecordingState.overlayAnimFrame = null;
    }
    if (this.profileRecordingState.overlayMediaStream) {
      this.profileRecordingState.overlayMediaStream.getTracks().forEach(track => track.stop());
      this.profileRecordingState.overlayMediaStream = null;
    }
    if (this.profileRecordingState.overlayAudioContext) {
      this.profileRecordingState.overlayAudioContext.close();
      this.profileRecordingState.overlayAudioContext = null;
    }
    const micBar = document.getElementById('profilesOverlayMicBar');
    if (micBar) micBar.style.width = '0%';
  }

  /**
   * Show mic error card with device name
   */
  showProfileMicError(deviceName) {
    const errorCard = document.getElementById('wizardProfileMicError');
    const deviceEl = document.getElementById('wizardProfileMicErrorDevice');

    if (errorCard && deviceEl) {
      deviceEl.textContent = deviceName || 'Unbekanntes Gerät';
      errorCard.style.display = 'block';
      document.getElementById('wizardProfileRecordBtn').style.display = 'none';
    }
  }

  /**
   * Hide mic error card
   */
  hideProfileMicError() {
    const errorCard = document.getElementById('wizardProfileMicError');
    if (errorCard) {
      errorCard.style.display = 'none';
    }
    document.getElementById('wizardProfileRecordBtn').style.display = 'flex';
  }

  async startProfileRecording() {
    const role = document.getElementById('wizardProfileRole').value;
    const name = document.getElementById('wizardProfileName').value.trim();

    if (!role) {
      this.showProfileStatus('Bitte wählen Sie eine Rolle aus.', 'error');
      return;
    }

    if (!name) {
      this.showProfileStatus('Bitte geben Sie einen Namen ein.', 'error');
      return;
    }

    // Hide any previous mic error
    this.hideProfileMicError();

    // Show overlay in ready state (recording starts when Start button is clicked)
    await this.showRecordingOverlay(name, role);
  }

  // Legacy method - kept for compatibility but no longer used
  async _startProfileRecordingLegacy() {
    const role = document.getElementById('wizardProfileRole').value;
    const name = document.getElementById('wizardProfileName').value.trim();

    try {
      // This was the old flow - now handled by startRecordingFromOverlay
      this.profileRecordingState.isRecording = true;
      this.profileRecordingState.seconds = 0;

      await ipcRenderer.invoke('start-voice-enrollment', { name, role });

      this.profileRecordingState.timer = setInterval(() => {
        this.profileRecordingState.seconds++;
        this.updateOverlayProgress(this.profileRecordingState.seconds, 30);

        if (this.profileRecordingState.seconds >= 30) {
          this.stopProfileRecording();
        }
      }, 1000);

    } catch (error) {
      console.error('Error starting profile recording:', error);

      this.closeRecordingOverlay();

      if (error.message && error.message.includes('Mikrofon nicht verbunden')) {
        const deviceMatch = error.message.match(/: (.+)$/);
        const deviceName = deviceMatch ? deviceMatch[1] : null;
        this.showProfileMicError(deviceName);
        this.showProfileStatus('', '');
      } else {
        this.showProfileStatus('Fehler beim Starten: ' + error.message, 'error');
      }

      this.resetProfileRecordingUI();
    }
  }

  async startProfileAudioMonitoring() {
    try {
      const micId = this.settings.microphoneId;
      const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };

      this.profileRecordingState.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.profileRecordingState.audioContext = new AudioContext();
      this.profileRecordingState.analyser = this.profileRecordingState.audioContext.createAnalyser();
      this.profileRecordingState.analyser.fftSize = 256;

      const source = this.profileRecordingState.audioContext.createMediaStreamSource(
        this.profileRecordingState.mediaStream
      );
      source.connect(this.profileRecordingState.analyser);

      const dataArray = new Uint8Array(this.profileRecordingState.analyser.frequencyBinCount);

      const updateLevel = () => {
        if (!this.profileRecordingState.isRecording) return;

        this.profileRecordingState.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const level = Math.min(100, (average / 128) * 100);
        document.getElementById('wizardProfileLevelBar').style.width = `${level}%`;

        this.profileRecordingState.animationFrame = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch (error) {
      console.error('Audio monitoring error:', error);
    }
  }

  stopProfileAudioMonitoring() {
    if (this.profileRecordingState.animationFrame) {
      cancelAnimationFrame(this.profileRecordingState.animationFrame);
      this.profileRecordingState.animationFrame = null;
    }
    if (this.profileRecordingState.mediaStream) {
      this.profileRecordingState.mediaStream.getTracks().forEach(track => track.stop());
      this.profileRecordingState.mediaStream = null;
    }
    if (this.profileRecordingState.audioContext) {
      this.profileRecordingState.audioContext.close();
      this.profileRecordingState.audioContext = null;
    }
    document.getElementById('wizardProfileLevelBar').style.width = '0%';
  }

  async stopProfileRecording() {
    if (this.profileRecordingState.timer) {
      clearInterval(this.profileRecordingState.timer);
      this.profileRecordingState.timer = null;
    }

    // Close the overlay
    this.closeRecordingOverlay();

    try {
      this.showProfileStatus('Stimmprofil wird verarbeitet...', 'processing');

      await ipcRenderer.invoke('stop-voice-enrollment');

      this.showProfileStatus('Stimmprofil erfolgreich erstellt!', 'success');

      // Reset form
      document.getElementById('wizardProfileRole').value = '';
      document.getElementById('wizardProfileName').value = '';

      // Reload profiles list
      await this.loadExistingProfiles();

    } catch (error) {
      console.error('Error stopping profile recording:', error);
      this.showProfileStatus('Fehler: ' + error.message, 'error');
    } finally {
      this.profileRecordingState.isRecording = false;
    }
  }

  async cancelProfileRecording() {
    if (this.profileRecordingState.timer) {
      clearInterval(this.profileRecordingState.timer);
      this.profileRecordingState.timer = null;
    }

    // Close the overlay
    this.closeRecordingOverlay();

    try {
      await ipcRenderer.invoke('cancel-voice-enrollment');
    } catch (error) {
      console.error('Cancel error:', error);
    }

    this.profileRecordingState.isRecording = false;
    this.showProfileStatus('', '');
  }

  resetProfileRecordingUI() {
    this.profileRecordingState.isRecording = false;
    document.getElementById('wizardProfileRecordBtn').style.display = 'flex';
    document.getElementById('wizardProfileCancelBtn').style.display = 'none';
    document.getElementById('wizardProfileProgress').style.display = 'none';
    document.getElementById('wizardProfileAudioLevel').style.display = 'none';
    document.getElementById('wizardProfileProgressBar').style.width = '0%';
    document.getElementById('wizardProfileRole').disabled = false;
    document.getElementById('wizardProfileName').disabled = false;
  }

  showProfileStatus(message, type) {
    const statusEl = document.getElementById('wizardProfileStatus');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.style.color = type === 'error' ? '#ef4444' :
                          type === 'success' ? '#22c55e' :
                          type === 'recording' ? '#ef4444' :
                          type === 'processing' ? 'var(--primary-500)' :
                          'var(--text-secondary)';
  }

  async loadMicrophones() {
    const select = document.getElementById('wizardMicSelect');
    if (!select) return;

    // Pass both ID and name - name is used as fallback if ID not found
    const result = await wizardAudioUtils.loadMicrophones(select, this.settings.microphoneId, this.settings.microphoneName);
    if (result.deviceId) {
      this.settings.microphoneId = result.deviceId;
      this.settings.microphoneName = result.deviceName;
    }
    this.loadWizardMicVolume();
  }

  async loadWizardMicVolume() {
    const container = document.getElementById('wizardMicVolumeContainer');
    const slider = document.getElementById('wizardMicVolumeSlider');
    const valueDisplay = document.getElementById('wizardMicVolumeValue');
    if (!container || !slider || !valueDisplay) return;

    // Don't show volume if no mic is selected/connected
    const micSelect = document.getElementById('wizardMicSelect');
    if (!micSelect || !micSelect.value) {
      container.style.display = 'none';
      return;
    }

    try {
      const result = await ipcRenderer.invoke('get-mic-volume', this.settings.microphoneName);
      if (result.error) {
        container.style.display = 'none';
        return;
      }
      if (result.muted) {
        valueDisplay.textContent = 'Stumm';
      } else {
        valueDisplay.textContent = result.volume + '%';
      }
      slider.value = result.volume;
      slider.style.setProperty('--fill', result.volume + '%');
      container.style.display = '';
    } catch (err) {
      console.error('[Wizard MicVolume] Failed to load:', err);
      container.style.display = 'none';
    }
  }

  toggleMicTest() {
    if (this.micTester && this.micTester.isRunning) {
      // Don't allow manual stop - wait for auto-stop
      return;
    } else {
      this.startMicTest();
    }
  }

  resetMicTestUI() {
    const btn = document.getElementById('wizardMicTestBtn');
    const levelBar = document.getElementById('wizardMicLevelBar');

    if (btn) {
      btn.textContent = 'Mikrofon testen (5 Sek.)';
      btn.classList.remove('wizard-btn-primary');
      btn.classList.add('wizard-btn-secondary');
      btn.disabled = false;
    }

    if (levelBar) {
      levelBar.style.width = '0%';
    }
  }

  async startMicTest() {
    const btn = document.getElementById('wizardMicTestBtn');
    const status = document.getElementById('wizardMicStatus');
    const playbackDiv = document.getElementById('wizardMicPlayback');

    // Create mic tester if not exists
    if (!this.micTester) {
      this.micTester = new wizardAudioUtils.MicTester();
    }

    btn.textContent = 'Aufnahme läuft...';
    btn.classList.remove('wizard-btn-secondary');
    btn.classList.add('wizard-btn-primary');
    btn.disabled = true;
    status.textContent = 'Aufnahme läuft... Sprechen Sie ins Mikrofon (5 Sek.)';
    status.className = 'wizard-mic-status';

    // Hide previous playback
    if (playbackDiv) playbackDiv.style.display = 'none';

    try {
      await this.micTester.start(
        this.settings.microphoneId,    // WebRTC device ID for audio monitoring
        this.settings.microphoneName,  // Device name for FFmpeg
        (level) => {
          // Update level bar
          const levelBar = document.getElementById('wizardMicLevelBar');
          if (levelBar) levelBar.style.width = level + '%';
        },
        (result) => {
          // On complete callback
          this.resetMicTestUI();
          if (result.success) {
            status.textContent = 'Test abgeschlossen - Klicken Sie "Anhören" um die Qualität zu prüfen';
            status.className = 'wizard-mic-status success';
            if (playbackDiv) playbackDiv.style.display = 'flex';
          } else {
            status.textContent = 'Fehler: ' + result.error;
            status.className = 'wizard-mic-status error';
          }
        },
        5000  // 5 second duration
      );
    } catch (error) {
      console.error('Mic test error:', error);
      status.textContent = 'Fehler: ' + error.message;
      status.className = 'wizard-mic-status error';
      this.resetMicTestUI();
    }
  }

  stopMicTest() {
    if (this.micTester) {
      this.micTester.stop();
    }
    this.resetMicTestUI();
  }

  async playMicTest() {
    const btn = document.getElementById('wizardPlayMicBtn');
    const audio = document.getElementById('wizardMicAudio');
    const status = document.getElementById('wizardMicStatus');

    // If already playing, stop
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><polygon points="5,3 19,12 5,21"/></svg>Anhören';
      return;
    }

    try {
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Stoppen';

      const result = await ipcRenderer.invoke('get-mic-test-audio');
      if (!result.success) {
        throw new Error(result.error);
      }

      audio.src = `data:${result.mimeType};base64,${result.data}`;
      audio.onended = () => {
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><polygon points="5,3 19,12 5,21"/></svg>Anhören';
      };
      await audio.play();
    } catch (error) {
      console.error('Playback error:', error);
      status.textContent = 'Wiedergabe-Fehler: ' + error.message;
      status.className = 'wizard-mic-status error';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><polygon points="5,3 19,12 5,21"/></svg>Anhören';
    }
  }

  async startShortcutRecording() {
    const display = document.getElementById('wizardShortcutDisplay');
    const key = document.getElementById('wizardShortcutKey');
    const btn = document.getElementById('wizardChangeShortcutBtn');

    if (this.isRecordingShortcut) {
      this.isRecordingShortcut = false;
      display.classList.remove('recording');
      btn.textContent = 'Ändern';
      await ipcRenderer.invoke('enable-global-shortcut');
      return;
    }

    await ipcRenderer.invoke('disable-global-shortcut');

    this.isRecordingShortcut = true;
    display.classList.add('recording');
    key.textContent = '...';
    btn.textContent = 'Abbrechen';
  }

  async handleShortcutKeydown(e) {
    if (!this.isRecordingShortcut) return;

    e.preventDefault();
    e.stopPropagation();

    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key.startsWith('Arrow')) key = key.replace('Arrow', '');

    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      return;
    }

    parts.push(key);
    this.settings.shortcut = parts.join('+');

    document.getElementById('wizardShortcutKey').textContent = this.settings.shortcut;
    document.getElementById('wizardShortcutDisplay').classList.remove('recording');
    document.getElementById('wizardChangeShortcutBtn').textContent = 'Ändern';
    this.isRecordingShortcut = false;

    await ipcRenderer.invoke('enable-global-shortcut');
  }

  showStep(index) {
    // Stop any running mic test when changing steps (industry standard behavior)
    this.stopMicTest();
    this.cancelPhonePairing();

    // Reset mic wizard state and UI when showing microphone step (step 1)
    if (index === 1) {
      // Reset to initial question state
      this.micWizardState = 'initial_question';
      this.isPhoneConnected = false;
      this.isPhoneTesting = false;

      // Reset all mic test UI elements
      const playbackDiv = document.getElementById('wizardMicPlayback');
      const statusDiv = document.getElementById('wizardMicStatus');
      const levelBar = document.getElementById('wizardMicLevelBar');
      const phonePlaybackDiv = document.getElementById('wizardPhonePlayback');
      const phoneStatusDiv = document.getElementById('wizardPhoneStatus');
      const phoneLevelBar = document.getElementById('wizardPhoneLevelBar');

      if (playbackDiv) playbackDiv.style.display = 'none';
      if (statusDiv) {
        statusDiv.textContent = 'Bereit für den Test';
        statusDiv.className = 'wizard-mic-status';
      }
      if (levelBar) levelBar.style.width = '0%';
      if (phonePlaybackDiv) phonePlaybackDiv.style.display = 'none';
      if (phoneStatusDiv) {
        phoneStatusDiv.textContent = 'Bereit für den Test';
        phoneStatusDiv.className = 'wizard-mic-status';
      }
      if (phoneLevelBar) phoneLevelBar.style.width = '0%';

      // Show initial substep, hide others
      this.updateMicSubstepVisibility();
    }

    // Hide all steps
    document.querySelectorAll('.wizard-step').forEach(step => {
      step.classList.remove('active');
    });

    // Show target step
    const step = document.querySelector(`.wizard-step[data-step="${index}"]`);
    if (step) {
      step.classList.add('active');
    }

    this.currentStep = index;
    this.updateProgress();
    this.updateNavigation();
    this.updateMicNavigation(); // Reset mic-specific navigation state
    this.updateSummary();

    // Scroll to top of wizard content
    const wizardContent = document.querySelector('.wizard-content');
    if (wizardContent) {
      wizardContent.scrollTop = 0;
    }

    // Load existing voice profiles when showing step 6
    if (index === 6) {
      this.loadExistingProfiles();
    }

    // Update shortcut display on final step
    if (index === 9) {
      const shortcutEl = document.getElementById('wizardFinalShortcut');
      if (shortcutEl) {
        shortcutEl.textContent = this.settings.shortcut || 'F9';
      }
    }
  }

  updateProgress() {
    const fill = document.getElementById('wizardProgressFill');
    const text = document.getElementById('wizardProgressText');

    if (fill) {
      const percent = ((this.currentStep + 1) / this.totalSteps) * 100;
      fill.style.width = percent + '%';
    }

    if (text) {
      text.textContent = `Schritt ${this.currentStep + 1} von ${this.totalSteps}`;
    }

    // Update dots
    document.querySelectorAll('.wizard-dot').forEach((dot, i) => {
      dot.classList.remove('active', 'completed');
      if (i < this.currentStep) {
        dot.classList.add('completed');
      } else if (i === this.currentStep) {
        dot.classList.add('active');
      }
    });
  }

  updateNavigation() {
    const backBtn = document.getElementById('wizardBackBtn');
    const nextBtn = document.getElementById('wizardNextBtn');
    const skipBtn = document.getElementById('wizardSkipBtn');
    const finishBtn = document.getElementById('wizardFinishBtn');
    const startBtn = document.getElementById('wizardStartBtn');

    // Welcome step (0)
    if (this.currentStep === 0) {
      backBtn.style.display = 'none';
      nextBtn.style.display = 'none';
      skipBtn.style.display = 'none';
      finishBtn.style.display = 'none';
      startBtn.style.display = 'flex';
      return;
    }

    // Final step - show back button so user can go back and change things
    if (this.currentStep === this.totalSteps - 1) {
      backBtn.style.display = 'flex';
      nextBtn.style.display = 'none';
      skipBtn.style.display = 'none';
      startBtn.style.display = 'none';
      finishBtn.style.display = 'flex';
      return;
    }

    // Regular steps
    startBtn.style.display = 'none';
    finishBtn.style.display = 'none';
    backBtn.style.display = 'flex';
    nextBtn.style.display = 'flex';

    // Skip button - show for optional steps (shortcut, AI mode, transcripts, audio, profiles)
    const optionalSteps = [2, 3, 4, 5, 6]; // Shortcut, AI Mode, Transcripts, Audio, Profiles
    skipBtn.style.display = optionalSteps.includes(this.currentStep) ? 'block' : 'none';

    // Apply mic wizard navigation rules for step 1
    if (this.currentStep === 1) {
      this.updateMicNavigation();
    }
  }

  updateSummary() {
    // Update summary on final step
    if (this.currentStep !== this.totalSteps - 1) return;

    const items = {
      'summaryMic': this.getMicrophoneName(),
      'summaryShortcut': this.settings.shortcut,
      'summaryMode': 'Agent V2.1',  // Only mode available
      'summaryTranscripts': this.settings.autoExport ? 'Aktiviert' : 'Deaktiviert',
      'summaryAudio': this.settings.keepAudio ? 'Aktiviert' : 'Deaktiviert'
    };

    Object.entries(items).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = value;
        // Add styling for enabled/disabled
        if (value === 'Aktiviert') {
          el.className = 'wizard-summary-value enabled';
        } else if (value === 'Deaktiviert') {
          el.className = 'wizard-summary-value disabled';
        } else {
          el.className = 'wizard-summary-value';
        }
      }
    });
  }

  getMicrophoneName() {
    const select = document.getElementById('wizardMicSelect');
    if (select && select.selectedOptions[0]) {
      return select.selectedOptions[0].textContent;
    }
    return 'Standard';
  }

  nextStep() {
    // If on step 1 with no_mic state, clear microphone settings
    if (this.currentStep === 1 && this.micWizardState === 'no_mic') {
      this.settings.microphoneSource = 'none';
      this.settings.microphoneId = null;
    }

    if (this.currentStep < this.totalSteps - 1) {
      this.showStep(this.currentStep + 1);
    }
  }

  prevStep() {
    // Special handling for Step 1 (Microphone) with substeps
    if (this.currentStep === 1) {
      // Navigate back within mic substeps first
      switch (this.micWizardState) {
        case 'has_mic':
          this.stopMicTest();
          this.setMicWizardState('initial_question');
          return;
        case 'phone_question':
          this.setMicWizardState('initial_question');
          return;
        case 'phone_already_paired':
          this.setMicWizardState('phone_question');
          return;
        case 'phone_pairing':
          this.cancelPhonePairing();
          this.setMicWizardState('phone_question');
          return;
        case 'phone_test':
          this.setMicWizardState('phone_already_paired');
          return;
        case 'no_mic':
          this.setMicWizardState('phone_question');
          return;
        case 'initial_question':
          // At the start of mic substeps, go to previous wizard step
          break;
      }
    }

    if (this.currentStep > 0) {
      this.showStep(this.currentStep - 1);
    }
  }

  skipStep() {
    this.nextStep();
  }

  async finish() {
    // Save all settings
    try {
      await ipcRenderer.invoke('save-settings', {
        microphoneId: this.settings.microphoneId,
        microphoneName: this.settings.microphoneName,  // For FFmpeg (needs device name)
        microphoneSource: this.settings.microphoneSource,  // 'desktop' | 'iphone' | 'none'
        shortcut: this.settings.shortcut,
        docMode: this.settings.docMode,
        autoExport: this.settings.autoExport,
        transcriptPath: this.settings.transcriptPath,
        keepAudio: this.settings.keepAudio
      });

      // Mark wizard as completed
      await ipcRenderer.invoke('mark-tour-completed', 'setup-wizard');

      // Hide wizard
      this.hide();

      // Refresh dashboard
      if (typeof loadHomeStats === 'function') {
        loadHomeStats();
      }
      if (typeof loadSettingsView === 'function') {
        loadSettingsView();
      }
    } catch (error) {
      console.error('Error saving wizard settings:', error);
      alert('Fehler beim Speichern der Einstellungen: ' + error.message);
    }
  }
}

// Function to restart the setup wizard - defined first so it can be used by event handlers
async function restartSetupWizard() {
  console.log('restartSetupWizard called');
  try {
    // Show wizard overlay immediately for visual feedback
    const overlay = document.getElementById('setupWizardOverlay');
    if (overlay) {
      overlay.classList.add('active');
    }

    // Reset the wizard completion flag
    await ipcRenderer.invoke('reset-tour', 'setup-wizard');

    // Reinitialize and show
    if (window.setupWizard) {
      // Reset state
      window.setupWizard.currentStep = 0;
      window.setupWizard.settings = {
        microphoneId: null,
        shortcut: 'F9',
        docMode: 'agent-v2.1',
        autoExport: true,
        transcriptPath: '',
        keepAudio: true
      };

      // Load current settings
      const settings = await ipcRenderer.invoke('get-settings');
      window.setupWizard.settings.shortcut = settings.shortcut || 'F9';
      window.setupWizard.settings.transcriptPath = settings.transcriptPath || '';
      window.setupWizard.settings.microphoneId = settings.microphoneId || null;
      window.setupWizard.settings.docMode = settings.docMode || 'agent-v2.1';
      window.setupWizard.settings.autoExport = settings.autoExport !== false;
      window.setupWizard.settings.keepAudio = settings.keepAudio !== false;

      // Update UI elements to match settings
      const shortcutKeyEl = document.getElementById('wizardShortcutKey');
      if (shortcutKeyEl) shortcutKeyEl.textContent = window.setupWizard.settings.shortcut;

      // Update path displays
      window.setupWizard.updatePathDisplays();

      // AI mode is always agent-v2.1, no selection UI needed

      // Reset toggles
      const transcriptToggle = document.getElementById('wizardTranscriptToggle');
      const audioToggle = document.getElementById('wizardAudioToggle');
      if (transcriptToggle) {
        transcriptToggle.classList.toggle('active', window.setupWizard.settings.autoExport);
      }
      if (audioToggle) {
        audioToggle.classList.toggle('active', window.setupWizard.settings.keepAudio);
      }

      const transcriptPathSection = document.getElementById('wizardTranscriptPathSection');
      if (transcriptPathSection) {
        transcriptPathSection.style.display = window.setupWizard.settings.autoExport ? 'block' : 'none';
      }

      // Show wizard at step 0
      window.setupWizard.show();
      window.setupWizard.loadMicrophones();
    } else {
      window.setupWizard = new SetupWizard();
    }
  } catch (error) {
    console.error('Error restarting setup wizard:', error);
    alert('Fehler beim Starten des Einrichtungsassistenten: ' + error.message);
  }
}

// Expose restart function globally
window.restartSetupWizard = restartSetupWizard;

// Listen for IPC message from main process (triggered by menu accelerator)
ipcRenderer.on('open-setup-wizard', () => {
  console.log('Received open-setup-wizard IPC message');
  restartSetupWizard();
});

// Initialize wizard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('Setup wizard script loaded');
  window.setupWizard = new SetupWizard();

  // Add click handler for restart wizard button in sidebar
  const restartBtn = document.getElementById('restartWizardBtn');
  if (restartBtn) {
    console.log('Restart button found, adding click handler');
    restartBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Restart wizard button clicked');
      restartSetupWizard();
    };
  } else {
    console.log('Restart button not found');
  }
});
