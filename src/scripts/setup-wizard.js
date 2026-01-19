/**
 * DentDoc Setup Wizard (Einrichtungsassistent)
 * Interactive step-by-step onboarding for new users
 */

// Use existing ipcRenderer from dashboard.js (it's already declared there)
// We just reference it directly since both scripts run in the same context

class SetupWizard {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 8; // 0-7 (removed separate audio step)
    this.settings = {
      microphoneId: null, // Windows device name for FFmpeg
      microphoneSource: 'desktop', // 'desktop' or 'iphone'
      shortcut: 'F9',
      docMode: 'single',
      autoExport: true,
      transcriptPath: '',
      keepAudio: false,
      profilesPath: ''
    };

    // Audio test state
    this.isTesting = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.analyser = null;
    this.micTestTimeout = null;  // Auto-stop timer

    // Shortcut recording state
    this.isRecordingShortcut = false;

    // Mic wizard substep state machine
    this.micWizardState = 'initial_question'; // initial_question, has_mic, phone_question, phone_pairing, phone_test, no_mic
    this.phonePairingId = null;
    this.phonePairingPollInterval = null;
    this.isPhoneConnected = false;
    this.isPhoneTesting = false;

    this.init();
  }

  async init() {
    // Always bind events so keyboard shortcuts work
    this.bindEvents();

    // Check if wizard should be shown
    const shouldShow = await ipcRenderer.invoke('check-first-run', 'setup-wizard');

    if (shouldShow) {
      // Load default settings
      const settings = await ipcRenderer.invoke('get-settings');
      this.settings.shortcut = settings.shortcut || 'F9';
      this.settings.transcriptPath = settings.transcriptPath || '';
      this.settings.profilesPath = settings.profilesPath || '';
      this.settings.microphoneId = settings.microphoneId || null; // Windows device name
      this.settings.docMode = settings.docMode || 'single';
      this.settings.autoExport = settings.autoExport !== false;
      this.settings.keepAudio = settings.keepAudio || false;

      // Update path input fields with actual paths
      this.updatePathDisplays();

      this.show();
      this.loadMicrophones();
    }
  }

  updatePathDisplays() {
    const transcriptPathEl = document.getElementById('wizardTranscriptPath');
    const profilesPathEl = document.getElementById('wizardProfilesPath');

    if (transcriptPathEl) {
      transcriptPathEl.value = this.settings.transcriptPath;
      transcriptPathEl.placeholder = this.settings.transcriptPath || 'Kein Pfad gesetzt';
    }
    if (profilesPathEl) {
      profilesPathEl.value = this.settings.profilesPath;
      profilesPathEl.placeholder = this.settings.profilesPath || 'Kein Pfad gesetzt';
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
    document.getElementById('wizardMicSelect')?.addEventListener('change', (e) => {
      this.settings.microphoneId = e.target.value; // Windows device name
      if (this.isTesting) {
        this.stopMicTest();
        this.startMicTest();
      }
    });
    document.getElementById('wizardMicTestBtn')?.addEventListener('click', () => this.toggleMicTest());
    document.getElementById('wizardPlayMicBtn')?.addEventListener('click', () => this.playMicTest());

    // Shortcut
    document.getElementById('wizardChangeShortcutBtn')?.addEventListener('click', () => this.startShortcutRecording());
    document.addEventListener('keydown', (e) => this.handleShortcutKeydown(e));

    // AI Mode
    document.querySelectorAll('.wizard-option[data-mode]').forEach(option => {
      option.addEventListener('click', () => {
        document.querySelectorAll('.wizard-option[data-mode]').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        this.settings.docMode = option.dataset.mode;
      });
    });

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
      const result = await ipcRenderer.invoke('select-folder');
      if (result) {
        this.settings.transcriptPath = result;
        document.getElementById('wizardTranscriptPath').value = result;
      }
    });

    document.getElementById('wizardBrowseProfilesBtn')?.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('select-folder');
      if (result) {
        this.settings.profilesPath = result;
        document.getElementById('wizardProfilesPath').value = result;

        // Save the new path immediately so get-voice-profiles can use it
        await ipcRenderer.invoke('save-settings', { profilesPath: result });

        // Reload existing profiles from the new path
        await this.loadExistingProfiles();
      }
    });

    // Voice profile recording in wizard
    document.getElementById('wizardProfileRecordBtn')?.addEventListener('click', () => {
      this.startProfileRecording();
    });

    document.getElementById('wizardProfileCancelBtn')?.addEventListener('click', () => {
      this.cancelProfileRecording();
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
    document.getElementById('wizardPhoneYes')?.addEventListener('click', () => {
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

    document.getElementById('wizardNoMicBack')?.addEventListener('click', () => {
      this.setMicWizardState('phone_question');
    });

    // No mic - continue anyway button
    document.getElementById('wizardNoMicContinue')?.addEventListener('click', () => {
      // User wants to continue without microphone - proceed to next step
      this.settings.microphoneSource = 'none';
      this.settings.microphoneId = null;
      this.nextStep();
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
      'phone_pairing': 'wizardMicSubstepPhonePairing',
      'phone_test': 'wizardMicSubstepPhoneTest',
      'no_mic': 'wizardMicSubstepNoMic'
    };

    const substepId = substepMap[this.micWizardState];
    if (substepId) {
      const substep = document.getElementById(substepId);
      if (substep) substep.style.display = 'block';
    }
  }

  updateMicNavigation() {
    const nextBtn = document.getElementById('wizardNextBtn');
    const backBtn = document.getElementById('wizardBackBtn');

    // Only handle step 1 - let updateNavigation() handle other steps
    if (this.currentStep !== 1) {
      // Just reset disabled state, don't touch display (updateNavigation handles that)
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
      }
      return;
    }

    // Step 1: Disable next button on question states (must make a choice)
    if (this.micWizardState === 'initial_question' ||
        this.micWizardState === 'phone_question' ||
        this.micWizardState === 'phone_pairing' ||
        this.micWizardState === 'no_mic') {
      // Hide navigation on these screens (user makes choice via substep buttons)
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.5';
        nextBtn.style.pointerEvents = 'none';
      }
    } else {
      // Enable navigation for has_mic and phone_test states
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
        nextBtn.style.display = 'flex';
      }
      if (backBtn) backBtn.style.display = 'flex';
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
      return; // Don't allow manual stop - wait for auto-stop
    } else {
      this.startPhoneTest();
    }
  }

  async startPhoneTest() {
    const btn = document.getElementById('wizardPhoneTestBtn');
    const levelBar = document.getElementById('wizardPhoneLevelBar');
    const status = document.getElementById('wizardPhoneStatus');
    const playbackDiv = document.getElementById('wizardPhonePlayback');

    try {
      this.isPhoneTesting = true;

      if (btn) {
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="3" fill="currentColor"/>
          </svg>
          Aufnahme läuft...
        `;
        btn.disabled = true;
      }

      if (status) status.textContent = 'Aufnahme läuft... Sprechen Sie ins Handy (10 Sek.)';
      if (playbackDiv) playbackDiv.style.display = 'none';

      // Start test recording via IPC (iPhone audio test)
      const startResult = await ipcRenderer.invoke('iphone-audio-test');

      if (!startResult.success) {
        throw new Error(startResult.error || 'Test konnte nicht gestartet werden');
      }

      // Animate level bar during recording
      this.animatePhoneLevel();

      // Auto-stop after 10 seconds
      setTimeout(async () => {
        if (this.isPhoneTesting) {
          await this.stopPhoneTest();
        }
      }, 10000);

    } catch (error) {
      console.error('Phone test error:', error);
      if (status) status.textContent = 'Fehler: ' + error.message;
      this.resetPhoneTestUI();
    }
  }

  async stopPhoneTest() {
    this.isPhoneTesting = false;

    const btn = document.getElementById('wizardPhoneTestBtn');
    const levelBar = document.getElementById('wizardPhoneLevelBar');
    const status = document.getElementById('wizardPhoneStatus');
    const playbackDiv = document.getElementById('wizardPhonePlayback');

    if (btn) {
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="3" fill="currentColor"/>
        </svg>
        Test starten (10 Sek.)
      `;
      btn.disabled = false;
    }

    if (levelBar) levelBar.style.width = '0%';

    // Show success and playback button
    if (status) {
      status.textContent = 'Test abgeschlossen - Klicken Sie "Anhören" um die Qualität zu prüfen';
      status.className = 'wizard-mic-status success';
    }
    if (playbackDiv) playbackDiv.style.display = 'flex';
  }

  resetPhoneTestUI() {
    this.isPhoneTesting = false;

    const btn = document.getElementById('wizardPhoneTestBtn');
    const levelBar = document.getElementById('wizardPhoneLevelBar');

    if (btn) {
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="3" fill="currentColor"/>
        </svg>
        Test starten (10 Sek.)
      `;
      btn.disabled = false;
    }
    if (levelBar) levelBar.style.width = '0%';
  }

  animatePhoneLevel() {
    const levelBar = document.getElementById('wizardPhoneLevelBar');
    if (!levelBar || !this.isPhoneTesting) return;

    // Simulate audio levels (in production, this would come from phone relay IPC events)
    const level = 20 + Math.random() * 60;
    levelBar.style.width = level + '%';

    if (this.isPhoneTesting) {
      requestAnimationFrame(() => setTimeout(() => this.animatePhoneLevel(), 100));
    }
  }

  async playPhoneTest() {
    const btn = document.getElementById('wizardPhonePlayBtn');
    const audio = document.getElementById('wizardPhoneAudio');
    const status = document.getElementById('wizardPhoneStatus');

    // If already playing, stop
    if (audio && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
      if (btn) btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px;">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
        Aufnahme anhören
      `;
      return;
    }

    try {
      if (btn) btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px;">
          <rect x="6" y="4" width="4" height="16"/>
          <rect x="14" y="4" width="4" height="16"/>
        </svg>
        Stoppen
      `;

      const result = await ipcRenderer.invoke('iphone-play-test-audio');
      if (!result.success) {
        throw new Error(result.error || 'Keine Testaufnahme vorhanden');
      }

      if (audio) {
        audio.src = `data:${result.mimeType || 'audio/wav'};base64,${result.data}`;
        audio.onended = () => {
          if (btn) btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px;">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
            Aufnahme anhören
          `;
        };
        await audio.play();
      }
    } catch (error) {
      console.error('Phone playback error:', error);
      if (status) status.textContent = 'Wiedergabe-Fehler: ' + error.message;
      if (btn) btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 6px;">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
        Aufnahme anhören
      `;
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

    try {
      this.profileRecordingState.isRecording = true;
      this.profileRecordingState.seconds = 0;

      // Update UI
      document.getElementById('wizardProfileRecordBtn').style.display = 'none';
      document.getElementById('wizardProfileCancelBtn').style.display = 'flex';
      document.getElementById('wizardProfileProgress').style.display = 'block';
      document.getElementById('wizardProfileAudioLevel').style.display = 'block';
      document.getElementById('wizardProfileRole').disabled = true;
      document.getElementById('wizardProfileName').disabled = true;

      this.showProfileStatus('Aufnahme läuft - bitte den Text vorlesen...', 'recording');

      // Start audio monitoring
      await this.startProfileAudioMonitoring();

      // Start backend recording
      await ipcRenderer.invoke('start-voice-enrollment', { name, role });

      // Start timer
      this.profileRecordingState.timer = setInterval(() => {
        this.profileRecordingState.seconds++;
        const progress = (this.profileRecordingState.seconds / 30) * 100;
        document.getElementById('wizardProfileProgressText').textContent =
          `Aufnahme läuft... ${this.profileRecordingState.seconds}s / 30s`;
        document.getElementById('wizardProfileProgressBar').style.width = `${progress}%`;

        if (this.profileRecordingState.seconds >= 30) {
          this.stopProfileRecording();
        }
      }, 1000);

    } catch (error) {
      console.error('Error starting profile recording:', error);
      this.showProfileStatus('Fehler beim Starten: ' + error.message, 'error');
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

    this.stopProfileAudioMonitoring();

    try {
      this.showProfileStatus('Stimmprofil wird verarbeitet...', 'processing');
      document.getElementById('wizardProfileCancelBtn').style.display = 'none';

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
      this.resetProfileRecordingUI();
    }
  }

  async cancelProfileRecording() {
    if (this.profileRecordingState.timer) {
      clearInterval(this.profileRecordingState.timer);
      this.profileRecordingState.timer = null;
    }

    this.stopProfileAudioMonitoring();

    try {
      await ipcRenderer.invoke('cancel-voice-enrollment');
    } catch (error) {
      console.error('Cancel error:', error);
    }

    this.showProfileStatus('', '');
    this.resetProfileRecordingUI();
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

    try {
      // Use WebRTC to enumerate audio devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');

      select.innerHTML = '';

      if (mics.length === 0) {
        select.innerHTML = '<option value="">Kein Mikrofon gefunden</option>';
        return;
      }

      mics.forEach((mic, index) => {
        const option = document.createElement('option');
        option.value = mic.deviceId;
        option.textContent = mic.label || `Mikrofon ${index + 1}`;
        if (mic.deviceId === this.settings.microphoneId) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      // Set first mic as default if none selected
      if (!this.settings.microphoneId && mics.length > 0) {
        this.settings.microphoneId = mics[0].deviceId;
      }
    } catch (error) {
      console.error('Error loading microphones:', error);
      select.innerHTML = '<option value="">Fehler beim Laden</option>';
    }
  }

  toggleMicTest() {
    if (this.isTesting) {
      // Don't allow manual stop - wait for auto-stop
      return;
    } else {
      this.startMicTest();
    }
  }

  async startAudioMonitoring(deviceId) {
    try {
      // Use selected mic or default
      const constraints = deviceId ? {
        audio: {
          deviceId: { ideal: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      } : {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      };

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const levelBar = document.getElementById('wizardMicLevelBar');

      const updateLevel = () => {
        if (!this.analyser || !this.isTesting) return;

        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalized = Math.min(average / 128 * 100, 100);
        if (levelBar) levelBar.style.width = normalized + '%';
        this.animationFrameId = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch (error) {
      console.error('Wizard audio monitoring error:', error);
    }
  }

  stopAudioMonitoring() {
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

  async startMicTest() {
    const btn = document.getElementById('wizardMicTestBtn');
    const levelBar = document.getElementById('wizardMicLevelBar');
    const status = document.getElementById('wizardMicStatus');
    const playbackDiv = document.getElementById('wizardMicPlayback');

    try {
      this.isTesting = true;
      btn.textContent = 'Aufnahme läuft...';
      btn.classList.remove('wizard-btn-secondary');
      btn.classList.add('wizard-btn-primary');
      btn.disabled = true;
      status.textContent = 'Aufnahme läuft... Sprechen Sie ins Mikrofon (5 Sek.)';
      status.className = 'wizard-mic-status';

      // Hide previous playback
      if (playbackDiv) playbackDiv.style.display = 'none';

      // Get selected microphone ID
      const micSelect = document.getElementById('wizardMicSelect');
      const deviceId = micSelect ? micSelect.value : null;

      // Start real audio monitoring (local, like Stimmprofile)
      await this.startAudioMonitoring(deviceId);

      // Start real recording via IPC (FFmpeg)
      const startResult = await ipcRenderer.invoke('start-mic-test', deviceId);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      // Auto-stop after 5 seconds
      this.micTestTimeout = setTimeout(async () => {
        if (this.isTesting) {
          await this.stopMicTest();
        }
      }, 5000);

    } catch (error) {
      console.error('Mic test error:', error);
      status.textContent = 'Fehler: ' + error.message;
      status.className = 'wizard-mic-status error';
      this.stopMicTest();
    }
  }

  async stopMicTest() {
    const btn = document.getElementById('wizardMicTestBtn');
    const levelBar = document.getElementById('wizardMicLevelBar');
    const status = document.getElementById('wizardMicStatus');
    const playbackDiv = document.getElementById('wizardMicPlayback');

    const wasRecording = this.isTesting;
    this.isTesting = false;

    // Stop audio monitoring (local getUserMedia stream)
    this.stopAudioMonitoring();

    // Clear auto-stop timer
    if (this.micTestTimeout) {
      clearTimeout(this.micTestTimeout);
      this.micTestTimeout = null;
    }

    if (btn) {
      btn.textContent = 'Mikrofon testen (5 Sek.)';
      btn.classList.remove('wizard-btn-primary');
      btn.classList.add('wizard-btn-secondary');
      btn.disabled = false;
    }

    if (levelBar) {
      levelBar.style.width = '0%';
    }

    // Only call stop-mic-test if we were actually recording
    if (!wasRecording) {
      return;
    }

    try {
      // Stop recording and get audio file
      const stopResult = await ipcRenderer.invoke('stop-mic-test');
      if (stopResult.success) {
        status.textContent = 'Test abgeschlossen - Klicken Sie "Anhören" um die Qualität zu prüfen';
        status.className = 'wizard-mic-status success';
        // Show playback button
        if (playbackDiv) playbackDiv.style.display = 'flex';
      } else {
        status.textContent = 'Fehler beim Stoppen: ' + stopResult.error;
        status.className = 'wizard-mic-status error';
      }
    } catch (error) {
      console.error('Stop mic test error:', error);
      status.textContent = 'Fehler: ' + error.message;
      status.className = 'wizard-mic-status error';
    }
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

    // Load existing voice profiles when showing step 6
    if (index === 6) {
      this.loadExistingProfiles();
    }

    // Update shortcut display on final step
    if (index === 8) {
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
      'summaryMode': this.settings.docMode === 'single' ? 'Single Prompt' : 'Agent-Kette',
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
        case 'phone_pairing':
          this.cancelPhonePairing();
          this.setMicWizardState('phone_question');
          return;
        case 'phone_test':
          this.setMicWizardState('phone_pairing');
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
        microphoneId: this.settings.microphoneId, // Windows device name
        shortcut: this.settings.shortcut,
        docMode: this.settings.docMode,
        autoExport: this.settings.autoExport,
        transcriptPath: this.settings.transcriptPath,
        keepAudio: this.settings.keepAudio,
        profilesPath: this.settings.profilesPath
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
        docMode: 'single',
        autoExport: true,
        transcriptPath: '',
        keepAudio: false,
        profilesPath: ''
      };

      // Load current settings
      const settings = await ipcRenderer.invoke('get-settings');
      window.setupWizard.settings.shortcut = settings.shortcut || 'F9';
      window.setupWizard.settings.transcriptPath = settings.transcriptPath || '';
      window.setupWizard.settings.profilesPath = settings.profilesPath || '';
      window.setupWizard.settings.microphoneId = settings.microphoneId || null;
      window.setupWizard.settings.docMode = settings.docMode || 'single';
      window.setupWizard.settings.autoExport = settings.autoExport !== false;
      window.setupWizard.settings.keepAudio = settings.keepAudio || false;

      // Update UI elements to match settings
      const shortcutKeyEl = document.getElementById('wizardShortcutKey');
      if (shortcutKeyEl) shortcutKeyEl.textContent = window.setupWizard.settings.shortcut;

      // Update path displays
      window.setupWizard.updatePathDisplays();

      // Reset AI mode selection
      document.querySelectorAll('.wizard-option[data-mode]').forEach(o => o.classList.remove('selected'));
      const selectedMode = document.querySelector(`.wizard-option[data-mode="${window.setupWizard.settings.docMode}"]`);
      if (selectedMode) selectedMode.classList.add('selected');

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
