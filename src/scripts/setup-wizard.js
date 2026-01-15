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

      // Start real recording via IPC
      const startResult = await ipcRenderer.invoke('start-mic-test', deviceId);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      // Listen for audio level updates from recorder
      this.levelHandler = (event, level) => {
        if (this.isTesting) {
          const percent = Math.min(100, level * 100);
          levelBar.style.width = percent + '%';
        }
      };
      ipcRenderer.on('audio-level-update', this.levelHandler);

      // Auto-stop after 5 seconds
      this.micTestTimeout = setTimeout(async () => {
        if (this.isTesting) {
          ipcRenderer.removeListener('audio-level-update', this.levelHandler);
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

    this.isTesting = false;

    // Clear auto-stop timer
    if (this.micTestTimeout) {
      clearTimeout(this.micTestTimeout);
      this.micTestTimeout = null;
    }

    // Remove level handler
    if (this.levelHandler) {
      ipcRenderer.removeListener('audio-level-update', this.levelHandler);
      this.levelHandler = null;
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

    // Reset mic test UI when showing microphone step (step 1)
    if (index === 1) {
      const playbackDiv = document.getElementById('wizardMicPlayback');
      const statusDiv = document.getElementById('wizardMicStatus');
      const levelBar = document.getElementById('wizardMicLevelBar');
      if (playbackDiv) playbackDiv.style.display = 'none';
      if (statusDiv) {
        statusDiv.textContent = 'Klicken Sie auf "Mikrofon testen" und sprechen Sie';
        statusDiv.className = 'wizard-mic-status';
      }
      if (levelBar) levelBar.style.width = '0%';
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
