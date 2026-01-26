/**
 * DentDoc Dashboard
 * Main JavaScript for the integrated dashboard interface
 * Includes: Home, Settings, and Voice Profiles views
 */

const { ipcRenderer } = require('electron');
const audioUtils = require('./scripts/audio-utils');

// ===== View Navigation =====
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

// Track current view for warning checks
let currentView = 'home';

async function switchView(viewName) {
  // Check for smartphone mic warning when leaving settings
  if (currentView === 'settings' && viewName !== 'settings') {
    if (typeof checkSmartphoneMicWarning === 'function') {
      const warning = checkSmartphoneMicWarning();
      if (warning && !await showWarningModal(warning.title, warning.message)) {
        return; // Stay on settings
      }
    }
  }

  // Stop any running mic test and cleanup when leaving settings view
  if (typeof settingsMicTester !== 'undefined' && settingsMicTester.isRunning) {
    await settingsMicTester.stop();
    settingsStopMicTest();
  }
  // Also force stop any lingering FFmpeg recording and clean up file
  // BUT ONLY if no real recording (VAD/iPhone) is in progress!
  const recordingState = await ipcRenderer.invoke('get-recording-state').catch(() => ({}));
  if (!recordingState.isRecording && !recordingState.isProcessing) {
    await ipcRenderer.invoke('stop-mic-test').catch(() => {});
    ipcRenderer.invoke('cleanup-mic-test');
  }
  document.getElementById('settingsMicPlayback').style.display = 'none';

  // Cancel any running iPhone audio test when leaving settings
  ipcRenderer.invoke('iphone-audio-test-cancel');
  // Hide iPhone test UI elements
  const iphoneTestProgress = document.getElementById('settingsIphoneTestProgress');
  const iphoneTestResult = document.getElementById('settingsIphoneTestResult');
  if (iphoneTestProgress) iphoneTestProgress.style.display = 'none';
  if (iphoneTestResult) iphoneTestResult.style.display = 'none';

  // Cancel any running iPhone pairing when leaving settings
  if (currentView === 'settings') {
    const qrState = document.getElementById('settingsIphoneQRState');
    if (qrState && qrState.style.display !== 'none') {
      console.log('Cancelling iPhone pairing - user navigated away');
      if (typeof cancelIphonePairing === 'function') {
        cancelIphonePairing();
      }
    }
  }

  // Cancel any running voice enrollment when leaving profiles view
  if (profilesIsRecording) {
    console.log('Cancelling voice enrollment - user navigated away');
    profilesCancelEnrollment();
  }

  // Cancel shortcut recording when leaving settings view
  if (settingsIsRecordingShortcut) {
    settingsIsRecordingShortcut = false;
    const shortcutDisplay = document.getElementById('settingsShortcutDisplay');
    if (shortcutDisplay) {
      shortcutDisplay.classList.remove('recording');
    }
  }

  // Update nav items
  navItems.forEach(item => {
    item.classList.remove('active');
    if (item.dataset.view === viewName) {
      item.classList.add('active');
    }
  });

  // Update views
  views.forEach(view => {
    view.classList.remove('active');
    if (view.id === `view-${viewName}`) {
      view.classList.add('active');
    }
  });

  // Load view content if needed
  loadViewContent(viewName);

  // Track current view
  currentView = viewName;
}

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const viewName = item.dataset.view;
    switchView(viewName);
  });
});

// ===== Load View Content =====
async function loadViewContent(viewName) {
  switch (viewName) {
    case 'home':
      loadHomeStats();
      break;
    case 'settings':
      loadSettingsView();
      break;
    case 'profiles':
      loadProfilesView();
      break;
  }
}

// ===== Home View Stats =====
async function loadHomeStats() {
  try {
    const stats = await ipcRenderer.invoke('get-dashboard-stats');

    document.getElementById('todayRecordings').textContent = stats.todayRecordings || 0;
    document.getElementById('profileCount').textContent = stats.profileCount || 0;

    const shortcut = await ipcRenderer.invoke('get-shortcut');
    document.getElementById('shortcutKey').textContent = shortcut || 'F9';

    // Load device usage
    try {
      const subData = await ipcRenderer.invoke('get-subscription-details');
      const deviceUsage = `${subData.activeDevices || 0}/${subData.maxDevices || 0}`;
      document.getElementById('deviceUsage').textContent = deviceUsage;
    } catch (e) {
      document.getElementById('deviceUsage').textContent = '-/-';
    }

    // Load onboarding card
    await loadOnboardingCard(shortcut || 'F9');

    // Load iPhone dashboard section if iPhone is selected
    await loadIphoneDashboardSection(shortcut || 'F9');

    // Load last documentation
    await loadLastDocumentation();
  } catch (error) {
    console.error('Error loading home stats:', error);
  }
}

// ===== Onboarding Tutorial Card =====
async function loadOnboardingCard(shortcut) {
  try {
    const shouldShow = await ipcRenderer.invoke('check-onboarding-visible');
    const onboardingCard = document.getElementById('onboardingCard');

    if (shouldShow && onboardingCard) {
      onboardingCard.style.display = 'block';

      // Update shortcut keys in the onboarding steps
      const startKey = document.getElementById('onboardingShortcutStart');
      const stopKey = document.getElementById('onboardingShortcutStop');
      if (startKey) startKey.textContent = shortcut;
      if (stopKey) stopKey.textContent = shortcut;
    } else if (onboardingCard) {
      onboardingCard.style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading onboarding card:', error);
  }
}

// Onboarding card event handlers
function initOnboardingCard() {
  const closeBtn = document.getElementById('onboardingCloseBtn');
  const gotItBtn = document.getElementById('onboardingGotItBtn');
  const dontShowCheckbox = document.getElementById('onboardingDontShowAgain');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      hideOnboardingCard(false); // Don't permanently dismiss on X click
    });
  }

  if (gotItBtn) {
    gotItBtn.addEventListener('click', () => {
      const dontShowAgain = dontShowCheckbox && dontShowCheckbox.checked;
      hideOnboardingCard(dontShowAgain);
    });
  }
}

async function hideOnboardingCard(permanently) {
  const onboardingCard = document.getElementById('onboardingCard');

  if (onboardingCard) {
    // Animate out
    onboardingCard.style.animation = 'onboardingSlideOut 0.3s ease-out forwards';

    setTimeout(async () => {
      onboardingCard.style.display = 'none';
      onboardingCard.style.animation = '';

      if (permanently) {
        await ipcRenderer.invoke('dismiss-onboarding-permanently');
      }
    }, 280);
  }
}

// Add slide out animation dynamically
const onboardingStyle = document.createElement('style');
onboardingStyle.textContent = `
  @keyframes onboardingSlideOut {
    from {
      opacity: 1;
      transform: translateY(0);
    }
    to {
      opacity: 0;
      transform: translateY(-20px);
    }
  }
`;
document.head.appendChild(onboardingStyle);

// Initialize onboarding card handlers
initOnboardingCard();

// Listen for recording completed to refresh dashboard
ipcRenderer.on('recording-completed', async () => {
  console.log('Recording completed, refreshing dashboard...');
  await loadHomeStats();
  await loadSubscriptionStatus(); // Refresh trial minutes in sidebar
});

// ===== F9 Recording Audio Monitoring =====
// Real audio level monitoring for status overlay during F9 recording
// FFmpeg records audio, WebAudio monitors levels, IPC bridges them
// IMPORTANT: Uses setInterval instead of requestAnimationFrame because
// requestAnimationFrame pauses when window is in background!
let f9MediaStream = null;
let f9AudioContext = null;
let f9Analyser = null;
let f9LevelInterval = null;

async function startF9AudioMonitoring(microphoneId) {
  // Stop any existing monitoring first
  stopF9AudioMonitoring();

  try {
    console.log('F9 audio monitoring: starting with microphoneId:', microphoneId);

    // Build constraints - same mic as F9 recording for accurate levels
    const constraints = microphoneId ? {
      audio: {
        deviceId: { ideal: microphoneId },
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

    f9MediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('F9 audio monitoring: getUserMedia success');

    f9AudioContext = new AudioContext();
    f9Analyser = f9AudioContext.createAnalyser();
    f9Analyser.fftSize = 2048;  // Larger for better time-domain resolution
    f9Analyser.smoothingTimeConstant = 0;  // NO smoothing

    const source = f9AudioContext.createMediaStreamSource(f9MediaStream);
    source.connect(f9Analyser);

    const bufferLength = f9Analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);

    // Use setInterval (not requestAnimationFrame) so it runs even when window is in background
    f9LevelInterval = setInterval(() => {
      if (!f9Analyser) return;

      // Use time-domain data (raw waveform) - NO FFT smoothing
      f9Analyser.getByteTimeDomainData(dataArray);

      // Find peak amplitude from center (128 = silence)
      let maxDeviation = 0;
      for (let i = 0; i < bufferLength; i++) {
        const deviation = Math.abs(dataArray[i] - 128);
        if (deviation > maxDeviation) maxDeviation = deviation;
      }
      // Normalize with boost: normal speech should fill most of the range
      const raw = maxDeviation / 128;
      const normalized = Math.min(1, raw * 5);  // 5x boost

      // Send to main process -> status overlay
      ipcRenderer.send('audio-level-update', normalized);
    }, 16); // ~60 FPS for instant response

    console.log('F9 audio monitoring started successfully');
  } catch (error) {
    console.error('F9 audio monitoring error:', error);
  }
}

function stopF9AudioMonitoring() {
  if (f9LevelInterval) {
    clearInterval(f9LevelInterval);
    f9LevelInterval = null;
  }
  if (f9MediaStream) {
    f9MediaStream.getTracks().forEach(track => track.stop());
    f9MediaStream = null;
  }
  if (f9AudioContext) {
    f9AudioContext.close();
    f9AudioContext = null;
    f9Analyser = null;
  }
  console.log('F9 audio monitoring stopped');
}

// Listen for F9 recording start/stop from main process
ipcRenderer.on('recording-started', async (event, options) => {
  console.log('F9 recording started, options:', options);

  // If VAD mode, ONLY start VAD integration - skip F9 audio monitoring!
  // VAD has its own audio capture and they conflict with each other.
  if (options?.vadMode) {
    console.log('[VAD] VAD mode - skipping F9 audio monitoring, starting VAD integration only...');
    startVADIntegration(options?.microphoneId).catch(err => {
      console.error('[VAD] startVADIntegration error:', err);
    });
  } else {
    // Normal recording mode - use F9 audio monitoring for level display
    console.log('[F9] Normal mode - starting audio monitoring...');
    await startF9AudioMonitoring(options?.microphoneId);
  }
});

ipcRenderer.on('recording-stopped', () => {
  // Only stop F9 audio monitoring if VAD is not active/starting
  // VAD manages its own audio capture
  if (!vadIsActive && !vadIsStarting) {
    console.log('[F9] Stopping F9 audio monitoring...');
    stopF9AudioMonitoring();
  } else {
    console.log('[VAD] VAD active/starting - skipping F9 audio monitoring stop');
  }

  // Only stop VAD if it's actually active (not starting)
  if (vadIsActive && !vadIsStarting) {
    console.log('[VAD] Stopping VAD integration...');
    stopVADIntegration();
  } else if (vadIsStarting) {
    console.log('[VAD] VAD is still starting - NOT stopping now');
  }
});

// ===== VAD Integration =====
// VAD processing runs in Main Process (Node WorkerThread with Sherpa-ONNX)
// Dashboard captures audio and sends batches to Main Process via IPC

let vadAudioContext = null;
let vadMediaStream = null;
let vadWorkletNode = null;
let vadIsActive = false;
let vadIsStarting = false;  // Prevents stop during async start
let vadStartPromise = null;  // Promise to wait for start completion
let vadIsSpeech = false;

// Listen for VAD state changes from main process
ipcRenderer.on('vad-state-change', (event, data) => {
  console.log('[VAD] State change:', data.oldState, '->', data.newState);
});

ipcRenderer.on('vad-segment-ready', (event, segment) => {
  console.log('[VAD] Segment ready:', segment.index, segment.duration + 'ms');
});

ipcRenderer.on('vad-session-started', () => {
  console.log('[VAD] Session started');
});

ipcRenderer.on('vad-session-stopped', (event, data) => {
  console.log('[VAD] Session stopped, segments:', data?.segments?.length || 0);
});

// Listen for speech detection from main process
ipcRenderer.on('vad-speech-detected', (event, data) => {
  vadIsSpeech = data.isSpeech;
  console.log('[VAD] Speech detected:', vadIsSpeech);
  // Could update UI here if needed (e.g., visual indicator)
});

/**
 * Start VAD audio capture and send batches to Main Process
 * Uses 16kHz AudioContext with AudioWorklet for frame batching
 */
async function startVADIntegration(microphoneId) {
  if (vadIsActive || vadIsStarting) {
    console.log('[VAD] Already active or starting, vadIsActive:', vadIsActive, 'vadIsStarting:', vadIsStarting);
    return;
  }

  vadIsStarting = true;
  console.log('[VAD] ========== STARTING VAD INTEGRATION (LOCKED) ==========');
  console.log('[VAD] microphoneId:', microphoneId);

  // WICHTIG: Cleanup vorher - aber NUR wenn nicht gerade gestartet wird
  // Da wir vadIsStarting bereits gesetzt haben, kann kein anderer Code mehr aufräumen
  if (vadAudioContext || vadMediaStream || vadWorkletNode) {
    console.log('[VAD] Cleaning up leftover resources from previous attempt...');
    // Manuelles Cleanup ohne cleanupVADResources() zu rufen (das könnte Race Conditions haben)
    if (vadWorkletNode) {
      try { vadWorkletNode.disconnect(); } catch (e) { /* ignore */ }
      vadWorkletNode = null;
    }
    if (vadMediaStream) {
      try { vadMediaStream.getTracks().forEach(track => track.stop()); } catch (e) { /* ignore */ }
      vadMediaStream = null;
    }
    if (vadAudioContext) {
      try { vadAudioContext.close(); } catch (e) { /* ignore */ }
      vadAudioContext = null;
    }
  }

  // Lokale Variablen für atomares Setup - werden erst am Ende den globalen zugewiesen
  let localAudioContext = null;
  let localMediaStream = null;
  let localWorkletNode = null;

  try {
    // First, ensure VAD worker is initialized in main process
    console.log('[VAD] Step 1: Initializing VAD worker...');
    const initResult = await ipcRenderer.invoke('vad-initialize');
    if (!initResult.success) {
      console.error('[VAD] Failed to initialize VAD worker:', initResult.error);
      vadIsStarting = false;
      return;
    }
    console.log('[VAD] Worker initialized in main process');

    // Create AudioContext with 16kHz sample rate (required by Sherpa-ONNX)
    console.log('[VAD] Step 2: Creating AudioContext...');
    localAudioContext = new AudioContext({ sampleRate: 16000 });
    console.log('[VAD] AudioContext created, state:', localAudioContext.state, 'sampleRate:', localAudioContext.sampleRate);

    // CRITICAL: Resume AudioContext if suspended (required before addModule in Electron!)
    if (localAudioContext.state !== 'running') {
      console.log('[VAD] AudioContext is suspended, resuming...');
      await localAudioContext.resume();
      console.log('[VAD] AudioContext resumed, state:', localAudioContext.state);
    }

    // Get microphone stream
    console.log('[VAD] Step 3: Getting microphone stream...');
    const constraints = {
      audio: {
        deviceId: microphoneId ? { ideal: microphoneId } : undefined,
        sampleRate: { ideal: 16000 },
        channelCount: { exact: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };

    localMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[VAD] Media stream acquired');

    // Nochmal prüfen ob AudioContext noch running ist
    console.log('[VAD] Step 4: Loading AudioWorklet...');
    console.log('[VAD] AudioContext state before addModule:', localAudioContext.state);
    if (localAudioContext.state !== 'running') {
      console.log('[VAD] AudioContext not running, resuming again...');
      await localAudioContext.resume();
      console.log('[VAD] After resume, state:', localAudioContext.state);
    }

    // Load AudioWorklet using Blob URL (more reliable in Electron)
    // Note: __dirname in Electron renderer can vary - try multiple paths
    const pathModule = require('path');
    const fs = require('fs');

    let workletPath = pathModule.join(__dirname, '..', 'vad', 'vad-worklet.js');
    console.log('[VAD] Initial worklet path:', workletPath, 'exists:', fs.existsSync(workletPath));

    // If path doesn't exist, try alternative paths
    if (!fs.existsSync(workletPath)) {
      const altPaths = [
        pathModule.join(__dirname, 'src', 'vad', 'vad-worklet.js'),
        pathModule.join(__dirname, '..', '..', 'src', 'vad', 'vad-worklet.js'),
        pathModule.join(process.cwd(), 'src', 'vad', 'vad-worklet.js')
      ];
      for (const alt of altPaths) {
        console.log('[VAD] Trying alternative path:', alt, 'exists:', fs.existsSync(alt));
        if (fs.existsSync(alt)) {
          workletPath = alt;
          break;
        }
      }
    }
    console.log('[VAD] Final worklet path:', workletPath);

    const workletCode = fs.readFileSync(workletPath, 'utf8');
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);

    console.log('[VAD] Calling addModule with Blob URL...');
    await localAudioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);  // Cleanup Blob URL
    console.log('[VAD] AudioWorklet loaded successfully');

    // Create AudioWorklet node - pass ACTUAL sample rate from AudioContext
    console.log('[VAD] Step 5: Creating AudioWorkletNode...');
    localWorkletNode = new AudioWorkletNode(localAudioContext, 'vad-processor', {
      processorOptions: {
        sampleRate: localAudioContext.sampleRate,
        frameMs: 20,
        batchFrames: 5  // 100ms batches
      }
    });

    // Forward audio batches from worklet to main process
    localWorkletNode.port.onmessage = (event) => {
      if (event.data.type === 'audio-batch') {
        // Send Float32Array DIRECTLY - Electron IPC supports structured clone
        ipcRenderer.send('vad-audio-batch', {
          samples: event.data.samples,
          timestamp: event.data.timestamp
        });
      } else if (event.data.type === 'debug') {
        console.log('[VAD] Worklet batch size:', event.data.batchSize);
      }
    };

    // Connect audio graph: microphone -> worklet
    console.log('[VAD] Step 6: Connecting audio graph...');
    const source = localAudioContext.createMediaStreamSource(localMediaStream);
    source.connect(localWorkletNode);

    // ERFOLG! Jetzt erst die globalen Variablen zuweisen (atomares Commit)
    vadAudioContext = localAudioContext;
    vadMediaStream = localMediaStream;
    vadWorkletNode = localWorkletNode;
    vadIsActive = true;
    vadIsStarting = false;

    console.log('[VAD] ========== VAD AUDIO CAPTURE ACTIVE ==========');
    console.log('[VAD] AudioContext state:', vadAudioContext.state);
    console.log('[VAD] AudioContext sampleRate:', vadAudioContext.sampleRate);

  } catch (error) {
    console.error('[VAD] ========== FAILED TO START ==========');
    console.error('[VAD] Error:', error);
    console.error('[VAD] Error stack:', error.stack);

    // Cleanup lokale Ressourcen bei Fehler
    if (localWorkletNode) {
      try { localWorkletNode.disconnect(); } catch (e) { /* ignore */ }
    }
    if (localMediaStream) {
      try { localMediaStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    }
    if (localAudioContext) {
      try { localAudioContext.close(); } catch (e) { /* ignore */ }
    }

    vadIsStarting = false;
  }
}

/**
 * Clean up VAD resources without sending IPC messages
 * Used during error recovery
 */
function cleanupVADResources() {
  // CRITICAL: Never cleanup while starting - this causes DOMException!
  if (vadIsStarting) {
    console.log('[VAD] cleanupVADResources BLOCKED - start in progress');
    return;
  }

  console.log('[VAD] Cleaning up VAD resources...');

  if (vadWorkletNode) {
    try {
      vadWorkletNode.port.postMessage({ type: 'stop' });
      vadWorkletNode.disconnect();
    } catch (e) { /* ignore */ }
    vadWorkletNode = null;
  }

  if (vadMediaStream) {
    try {
      vadMediaStream.getTracks().forEach(track => track.stop());
    } catch (e) { /* ignore */ }
    vadMediaStream = null;
  }

  if (vadAudioContext) {
    try {
      vadAudioContext.close();
    } catch (e) { /* ignore */ }
    vadAudioContext = null;
  }

  vadIsActive = false;
  vadIsSpeech = false;
}

/**
 * Stop VAD audio capture
 */
function stopVADIntegration() {
  console.log('[VAD] ========== STOPPING VAD INTEGRATION ==========');
  console.log('[VAD] vadIsActive:', vadIsActive, 'vadIsStarting:', vadIsStarting);

  // If currently starting, just mark that we should stop
  // The start function will handle cleanup
  if (vadIsStarting) {
    console.log('[VAD] Start in progress, cleanup will happen after start completes or fails');
    // Don't send stop IPC - the start is still running
    return;
  }

  // Only send stop if we were actually active
  if (vadIsActive) {
    // Tell main process audio is stopping - allows VAD to flush buffers
    ipcRenderer.send('vad-audio-stop');
  }

  cleanupVADResources();
  console.log('[VAD] Audio capture stopped');
}

// Listen for subscription status refresh (triggered from main.js on window focus)
ipcRenderer.on('refresh-subscription-status', async () => {
  console.log('Window focused, refreshing subscription status...');
  await loadSubscriptionStatus();
});

// Listen for view switch requests from main process
ipcRenderer.on('switch-view', (event, viewName) => {
  console.log('Switching to view:', viewName);
  switchView(viewName);
});

// ===== Last Documentation =====
let lastDocData = null;

async function loadLastDocumentation() {
  try {
    const result = await ipcRenderer.invoke('get-last-documentation');

    if (result && result.documentation) {
      lastDocData = result;
      document.getElementById('lastDocSection').style.display = 'block';

      // Format timestamp
      if (result.timestamp) {
        const date = new Date(result.timestamp);
        const timeStr = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const dateStr = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        document.getElementById('lastDocTime').textContent = `${dateStr}, ${timeStr}`;
      }

      // Show preview (first 200 chars)
      const preview = result.documentation.substring(0, 200) + (result.documentation.length > 200 ? '...' : '');
      document.getElementById('lastDocPreview').textContent = preview;
    } else {
      document.getElementById('lastDocSection').style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading last documentation:', error);
    document.getElementById('lastDocSection').style.display = 'none';
  }
}

document.getElementById('copyLastDocBtn').addEventListener('click', async () => {
  if (lastDocData && lastDocData.documentation) {
    await navigator.clipboard.writeText(lastDocData.documentation);
    const btn = document.getElementById('copyLastDocBtn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Kopiert!';
    setTimeout(() => {
      btn.innerHTML = originalHTML;
    }, 2000);
  }
});

document.getElementById('showLastDocBtn').addEventListener('click', async () => {
  await ipcRenderer.invoke('show-last-result');
});

// ===== Subscription Status =====
async function loadSubscriptionStatus() {
  try {
    const status = await ipcRenderer.invoke('get-subscription-status');
    const statusEl = document.getElementById('subscriptionStatus');
    const indicator = statusEl.querySelector('.subscription-indicator');
    const label = statusEl.querySelector('.subscription-label');

    // Remove all status classes
    statusEl.classList.remove('status-success', 'status-warning', 'status-error', 'status-trial');

    // Add appropriate class based on type
    statusEl.classList.add(`status-${status.type}`);
    label.textContent = status.label;
  } catch (error) {
    console.error('Error loading subscription status:', error);
  }
}

// Load subscription status on init
loadSubscriptionStatus();

// ===== Sidebar Links =====
async function initSidebarLinks() {
  const baseUrl = await ipcRenderer.invoke('get-base-url');

  document.getElementById('linkWebsite').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', baseUrl);
  });

  document.getElementById('linkDatenschutz').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', baseUrl + '/datenschutz');
  });

  document.getElementById('linkImpressum').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', baseUrl + '/impressum');
  });

  document.getElementById('logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('logout');
  });
}

initSidebarLinks();

// ===== Window Controls =====
document.getElementById('minimizeBtn').addEventListener('click', () => {
  ipcRenderer.send('minimize-window');
});

document.getElementById('closeBtn').addEventListener('click', () => {
  ipcRenderer.send('minimize-to-tray');
});


// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  loadHomeStats();
  loadAppVersion();
  initUpdateButton();
  initBefundSectionHandlers();
});

// ===== Version & Updates =====
async function loadAppVersion() {
  const versionEl = document.getElementById('appVersion');
  if (!versionEl) return;

  try {
    const version = await ipcRenderer.invoke('get-app-version');
    versionEl.textContent = `Version ${version}`;
  } catch (error) {
    console.error('Error loading app version:', error);
    versionEl.textContent = 'Version unbekannt';
  }
}

function initUpdateButton() {
  const updateBtn = document.getElementById('checkUpdateBtn');
  if (!updateBtn) return;

  updateBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    // Prevent double-clicking
    if (updateBtn.classList.contains('checking')) return;

    updateBtn.classList.add('checking');
    const originalText = updateBtn.innerHTML;
    updateBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
        <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
        <path d="M21 3v5h-5"/>
      </svg>
      Suche...
    `;

    try {
      const result = await ipcRenderer.invoke('check-for-updates');

      if (result.status === 'dev') {
        alert(result.message);
      }
      // For 'checking' status, the autoUpdater events will handle the rest
    } catch (error) {
      console.error('Update check error:', error);
      alert('Fehler beim Prüfen auf Updates: ' + error.message);
    } finally {
      // Reset button after a short delay
      setTimeout(() => {
        updateBtn.classList.remove('checking');
        updateBtn.innerHTML = originalText;
      }, 2000);
    }
  });
}

// ===== Tour =====
const { driver } = require('driver.js');

async function startDashboardTour() {
  const tourDriver = driver({
    showProgress: true,
    progressText: 'Schritt {{current}} von {{total}}',
    nextBtnText: 'Weiter',
    prevBtnText: 'Zurück',
    doneBtnText: 'Fertig',
    showButtons: ['next', 'previous', 'close'],
    animate: true,
    allowClose: true,
    overlayClickNext: false,
    disableActiveInteraction: true,
    stagePadding: 10,
    stageRadius: 12,
    popoverClass: 'dentdoc-tour',
    steps: [
      {
        popover: {
          title: 'Willkommen bei DentDoc!',
          description: 'Diese kurze Tour zeigt Ihnen die wichtigsten Funktionen Ihres neuen Dashboards.',
          side: 'center',
          align: 'center'
        }
      },
      {
        element: '.sidebar',
        popover: {
          title: 'Navigation',
          description: 'Über die Seitenleiste erreichen Sie alle Bereiche: Übersicht, Einstellungen und Stimmprofile.',
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '#nav-settings',
        popover: {
          title: 'Einstellungen',
          description: 'Hier können Sie Mikrofon, Tastenkombination, Speicherorte und mehr anpassen.',
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '#nav-profiles',
        popover: {
          title: 'Stimmprofile',
          description: 'DentDoc erkennt verschiedene Sprecher automatisch. Hier sehen Sie alle erkannten Profile.',
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '.sidebar-footer',
        popover: {
          title: 'Status & Shortcut',
          description: 'Hier sehen Sie den aktuellen Aufnahmestatus und die Tastenkombination zum Starten.',
          side: 'right',
          align: 'end'
        }
      },
      {
        popover: {
          title: 'Fertig!',
          description: 'Sie können jetzt loslegen. Drücken Sie F9 oder klicken Sie auf "Aufnahme starten" für Ihre erste Dokumentation.',
          side: 'center',
          align: 'center'
        }
      }
    ],
    onDestroyed: () => {
      ipcRenderer.invoke('mark-tour-completed', 'dashboard');
    }
  });

  tourDriver.drive();
}

async function checkFirstRun() {
  const isFirstRun = await ipcRenderer.invoke('check-first-run', 'dashboard');
  if (isFirstRun) {
    setTimeout(() => {
      startDashboardTour();
    }, 800);
  }
}

// DISABLED: Dashboard tour temporarily disabled
// checkFirstRun();


// =============================================================================
// SETTINGS VIEW
// =============================================================================

let settingsSelectedMicId = null;
let settingsSelectedMicName = null;  // For FFmpeg (needs device name, not ID)
let settingsNewShortcut = null;
let settingsIsRecordingShortcut = false;
let settingsHasUnsavedChanges = false;
let settingsInitialSettings = {};

async function loadSettingsView() {
  const settings = await ipcRenderer.invoke('get-settings');

  // Reset mic test UI state
  document.getElementById('settingsMicPlayback').style.display = 'none';
  document.getElementById('settingsMicStatus').textContent = '';
  document.getElementById('settingsMicStatus').className = 'status-message';
  document.getElementById('settingsMicLevelBar').style.width = '0%';

  document.getElementById('settingsCurrentShortcut').textContent = settings.shortcut || 'F9';
  document.getElementById('settingsShortcutDisplay').textContent = settings.shortcut || 'F9';
  settingsSelectedMicId = settings.microphoneId || null;
  settingsSelectedMicName = settings.microphoneName || null;  // For FFmpeg
  document.getElementById('settingsTranscriptPath').value = settings.transcriptPath || '';
  document.getElementById('settingsProfilesPath').value = settings.profilesPath || '';
  document.getElementById('settingsAutoCloseCheckbox').checked = settings.autoClose || false;
  document.getElementById('settingsAutoExportCheckbox').checked = settings.autoExport || false;
  document.getElementById('settingsKeepAudioCheckbox').checked = settings.keepAudio || false;
  document.getElementById('settingsVadEnabled').checked = settings.vadEnabled !== false;

  // iPhone microphone settings
  const microphoneSource = settings.microphoneSource || 'desktop';
  document.getElementById('settingsMicSourceDesktop').checked = microphoneSource === 'desktop';
  document.getElementById('settingsMicSourceIphone').checked = microphoneSource === 'iphone';
  await loadIphonePairingStatus(settings);
  updateMicSourceUI(microphoneSource);

  const theme = settings.theme || 'dark';
  document.getElementById('settingsThemeSelect').value = theme;

  const docMode = settings.docMode || 'agent-v2.1';
  document.getElementById('settingsDocModeSelect').value = docMode;

  await loadSettingsMicrophones();

  settingsInitialSettings = {
    shortcut: settings.shortcut || 'F9',
    microphoneId: settingsSelectedMicId,
    microphoneSource: settings.microphoneSource || 'desktop',
    transcriptPath: settings.transcriptPath || '',
    profilesPath: settings.profilesPath || '',
    autoClose: settings.autoClose || false,
    autoExport: settings.autoExport || false,
    keepAudio: settings.keepAudio || false,
    docMode: docMode,
    theme: settings.theme || 'dark',
    vadEnabled: settings.vadEnabled !== false
  };
}

async function loadSettingsMicrophones() {
  const micSelect = document.getElementById('settingsMicSelect');
  const noMicHint = document.getElementById('settingsNoMicrophoneHint');
  const micNotFoundWarning = document.getElementById('settingsMicNotFoundWarning');
  const micNotFoundName = document.getElementById('settingsMicNotFoundName');

  // Remember what was configured before loading
  const configuredMicName = settingsSelectedMicName;
  const hadConfiguredMic = !!(settingsSelectedMicId || settingsSelectedMicName);

  // Pass both ID and name - name is used as fallback if ID not found (device was reconnected)
  const result = await audioUtils.loadMicrophones(micSelect, settingsSelectedMicId, settingsSelectedMicName);

  // Update stored values if mic was found
  if (result.deviceId) {
    settingsSelectedMicId = result.deviceId;
    settingsSelectedMicName = result.deviceName;
  }

  // Show warning if configured mic was not found
  const micNotFound = hadConfiguredMic && !result.deviceId;
  if (micNotFoundWarning) {
    micNotFoundWarning.style.display = micNotFound ? 'flex' : 'none';
    if (micNotFound && micNotFoundName) {
      micNotFoundName.textContent = configuredMicName ? `"${configuredMicName}" ist nicht angeschlossen` : 'Bitte Mikrofon auswählen';
    }
  }

  // Show/hide no microphone hint (only if no mics at all)
  if (noMicHint) {
    const noMicsAvailable = micSelect.options.length === 0 ||
      (micSelect.options.length === 1 && micSelect.options[0].value === '');
    noMicHint.style.display = noMicsAvailable ? 'block' : 'none';
  }
}

// Listen for device changes (mic plugged in/out) and refresh the list
let deviceChangeDebounce = null;
let selectedMicWasAvailable = null; // Track if SELECTED mic was available

/**
 * Check if a microphone matches by vendor:product ID (e.g., "046d:0aba")
 * This handles USB port changes where Windows renumbers devices like "2- Logitech" -> "3- Logitech"
 */
function isMicrophoneMatch(savedName, currentLabel) {
  // Try exact match first
  if (currentLabel === savedName) return true;

  // Extract vendor:product ID from both names
  const savedVendorId = savedName.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();
  const currentVendorId = currentLabel.match(/\(([0-9a-f]{4}:[0-9a-f]{4})\)/i)?.[1]?.toLowerCase();

  // Match by vendor:product ID if both have one
  if (savedVendorId && currentVendorId && savedVendorId === currentVendorId) {
    return true;
  }

  return false;
}

navigator.mediaDevices?.addEventListener('devicechange', () => {
  // Debounce to avoid multiple rapid refreshes
  clearTimeout(deviceChangeDebounce);
  deviceChangeDebounce = setTimeout(async () => {
    // Check if the SELECTED microphone is still available
    try {
      const settings = await ipcRenderer.invoke('get-settings');
      const selectedMicName = settings?.microphoneName;

      // Only check if a specific mic is selected (not default)
      if (selectedMicName) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');

        // Check if selected mic is in the list (by vendor:product ID)
        const selectedMicAvailable = mics.some(m => isMicrophoneMatch(selectedMicName, m.label));

        console.log(`[DeviceChange] Selected mic "${selectedMicName}" available: ${selectedMicAvailable} (was: ${selectedMicWasAvailable})`);

        // Notify only when selected mic status changes
        if (selectedMicWasAvailable !== null && selectedMicWasAvailable !== selectedMicAvailable) {
          if (selectedMicAvailable) {
            console.log('[DeviceChange] Selected microphone reconnected!');
            ipcRenderer.invoke('show-notification', 'Mikrofon verbunden', selectedMicName);
          } else {
            console.log('[DeviceChange] Selected microphone disconnected!');
            ipcRenderer.invoke('show-notification', 'Mikrofon getrennt', selectedMicName);
          }
        }
        selectedMicWasAvailable = selectedMicAvailable;
      }
    } catch (e) {
      console.warn('[DeviceChange] Could not check selected mic:', e.message);
    }

    // Refresh settings UI if active
    const settingsView = document.getElementById('view-settings');
    if (settingsView && settingsView.classList.contains('active')) {
      // Don't refresh during mic test
      if (settingsMicTester && settingsMicTester.isRunning) {
        console.log('Device change detected, but mic test running - skipping refresh');
        return;
      }
      console.log('Device change detected, refreshing microphone list...');
      loadSettingsMicrophones();
    }
  }, 500);
});

// Initialize selected mic status on load
(async () => {
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    const selectedMicName = settings?.microphoneName;
    if (selectedMicName) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      selectedMicWasAvailable = mics.some(m => isMicrophoneMatch(selectedMicName, m.label));
      console.log(`[DeviceChange] Initial selected mic "${selectedMicName}" available: ${selectedMicWasAvailable}`);
    }
  } catch (e) {
    console.warn('[DeviceChange] Could not get initial mic status:', e.message);
  }
})();

function settingsCheckForChanges() {
  const currentSettings = {
    shortcut: settingsNewShortcut || document.getElementById('settingsShortcutDisplay').textContent,
    microphoneId: document.getElementById('settingsMicSelect').value,
    microphoneSource: document.querySelector('input[name="micSource"]:checked')?.value || 'desktop',
    transcriptPath: document.getElementById('settingsTranscriptPath').value,
    profilesPath: document.getElementById('settingsProfilesPath').value,
    autoClose: document.getElementById('settingsAutoCloseCheckbox').checked,
    autoExport: document.getElementById('settingsAutoExportCheckbox').checked,
    keepAudio: document.getElementById('settingsKeepAudioCheckbox').checked,
    docMode: document.getElementById('settingsDocModeSelect').value,
    theme: document.getElementById('settingsThemeSelect').value,
    vadEnabled: document.getElementById('settingsVadEnabled').checked
  };

  settingsHasUnsavedChanges = JSON.stringify(currentSettings) !== JSON.stringify(settingsInitialSettings);
}

function settingsShowStatus(element, message, type) {
  element.textContent = message;
  element.className = 'status-message ' + type;
}

function settingsHideStatus(element) {
  element.textContent = '';
  element.className = 'status-message';
}

// ===========================================
// iPhone Microphone Pairing
// ===========================================

let iphonePairingPollInterval = null;
let iphonePairingTimeout = null;

// Load iPhone pairing status - ALWAYS verify with backend (single source of truth)
async function loadIphonePairingStatus(settings) {
  try {
    // Ask backend for the real pairing status
    const backendStatus = await ipcRenderer.invoke('iphone-get-status');

    if (backendStatus && backendStatus.paired) {
      // Backend confirms: iPhone is paired
      document.getElementById('settingsIphoneUnpairedState').style.display = 'none';
      document.getElementById('settingsIphoneQRState').style.display = 'none';
      document.getElementById('settingsIphonePairedState').style.display = 'block';
      document.getElementById('settingsIphoneDeviceName').textContent = backendStatus.deviceName || 'iPhone';
      document.getElementById('settingsIphoneStatusText').textContent = 'Bereit';

      // Generate QR code for /mic (so user can reopen Safari)
      generateMicQRCode();
    } else {
      // Backend says: not paired (or error) - show unpaired state
      document.getElementById('settingsIphoneUnpairedState').style.display = 'block';
      document.getElementById('settingsIphoneQRState').style.display = 'none';
      document.getElementById('settingsIphonePairedState').style.display = 'none';
    }
  } catch (error) {
    console.error('[iPhone] Failed to verify pairing status:', error);
    // On error, fall back to local store (but show as potentially stale)
    const iphoneDeviceId = settings?.iphoneDeviceId || null;
    const iphoneDeviceName = settings?.iphoneDeviceName || 'iPhone';

    if (iphoneDeviceId) {
      document.getElementById('settingsIphoneUnpairedState').style.display = 'none';
      document.getElementById('settingsIphoneQRState').style.display = 'none';
      document.getElementById('settingsIphonePairedState').style.display = 'block';
      document.getElementById('settingsIphoneDeviceName').textContent = iphoneDeviceName;
      document.getElementById('settingsIphoneStatusText').textContent = 'Offline prüfen...';

      // Generate QR code for /mic (so user can reopen Safari)
      generateMicQRCode();
    } else {
      document.getElementById('settingsIphoneUnpairedState').style.display = 'block';
      document.getElementById('settingsIphoneQRState').style.display = 'none';
      document.getElementById('settingsIphonePairedState').style.display = 'none';
    }
  }
}

// Generate QR code for /mic page (for paired iPhones to reopen Safari)
async function generateMicQRCode() {
  try {
    const QRCode = require('qrcode');
    const micUrl = 'https://dentdoc-app.vercel.app/mic';

    const qrContainer = document.getElementById('settingsIphoneMicQRCode');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';

    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, micUrl, {
      width: 150,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    qrContainer.appendChild(canvas);

    // Show URL
    const urlEl = document.getElementById('settingsIphoneMicUrl');
    if (urlEl) {
      urlEl.textContent = micUrl;
    }
  } catch (error) {
    console.error('[iPhone] Failed to generate mic QR code:', error);
  }
}

// Test iPhone microphone - records 10 seconds and shows levels
let iphoneTestWavPath = null;

async function testIphoneMic() {
  const statusEl = document.getElementById('settingsIphoneTestStatus');
  const testBtn = document.getElementById('settingsIphoneTestBtn');
  const progressEl = document.getElementById('settingsIphoneTestProgress');
  const levelEl = document.getElementById('settingsIphoneTestLevel');
  const progressTextEl = document.getElementById('settingsIphoneTestProgressText');
  const resultEl = document.getElementById('settingsIphoneTestResult');
  const playBtn = document.getElementById('settingsIphonePlayBtn');

  if (!statusEl || !testBtn) return;

  // Hide previous results
  if (resultEl) resultEl.style.display = 'none';
  if (progressEl) progressEl.style.display = 'none';

  testBtn.disabled = true;
  statusEl.className = 'status-message';
  statusEl.textContent = 'Verbindung wird geprüft...';

  try {
    // First check if iPhone is connected
    const connectionCheck = await ipcRenderer.invoke('iphone-test-connection');

    if (!connectionCheck.connected) {
      statusEl.className = 'status-message error';
      statusEl.textContent = connectionCheck.error || 'iPhone nicht verbunden. Bitte Safari öffnen.';
      testBtn.disabled = false;
      return;
    }

    // iPhone is connected - start audio test
    statusEl.textContent = 'Starte Audio-Test...';
    if (progressEl) {
      progressEl.style.display = 'block';
      if (levelEl) levelEl.style.width = '0%';
    }

    // Countdown on button
    let countdown = 10;
    const originalBtnText = testBtn.textContent;
    testBtn.textContent = `Aufnahme... ${countdown}s`;
    const countdownInterval = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        testBtn.textContent = `Aufnahme... ${countdown}s`;
      } else {
        testBtn.textContent = 'Verarbeite...';
        clearInterval(countdownInterval);
      }
    }, 1000);

    // Run the audio test
    const result = await ipcRenderer.invoke('iphone-audio-test');

    // Stop countdown and restore button
    clearInterval(countdownInterval);
    testBtn.textContent = originalBtnText;

    // Hide progress
    if (progressEl) progressEl.style.display = 'none';

    if (result.success) {
      iphoneTestWavPath = result.wavPath;

      // Show play button
      if (resultEl) {
        resultEl.style.display = 'block';
      }

      // Simple success message
      statusEl.className = 'status-message success';
      statusEl.textContent = 'Aufnahme erfolgreich! Klicke auf Abspielen zum Anhören.';
    } else {
      statusEl.className = 'status-message error';
      statusEl.textContent = result.error || 'Audio-Test fehlgeschlagen';
    }
  } catch (error) {
    if (progressEl) progressEl.style.display = 'none';
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Fehler: ' + error.message;
  }

  testBtn.disabled = false;
}

// Listen for test level updates
ipcRenderer.on('iphone-test-level', (event, level) => {
  const levelEl = document.getElementById('settingsIphoneTestLevel');
  if (levelEl) {
    // Sanftere Skalierung: sqrt für weniger extreme Schwankungen
    const scaled = Math.sqrt(level * 5000) * 10;
    const percent = Math.min(100, Math.max(3, scaled));
    levelEl.style.width = `${percent}%`;
  }
});

// Play test audio
async function playIphoneTestAudio() {
  if (!iphoneTestWavPath) {
    console.warn('No test audio to play');
    return;
  }

  try {
    await ipcRenderer.invoke('iphone-play-test-audio', iphoneTestWavPath);
  } catch (error) {
    console.error('Error playing test audio:', error);
  }
}

// Setup play button listener
document.getElementById('settingsIphonePlayBtn')?.addEventListener('click', playIphoneTestAudio);

// Load iPhone Dashboard Section on Home View
async function loadIphoneDashboardSection(shortcut) {
  const section = document.getElementById('iphoneDashboardSection');
  const unpairedState = document.getElementById('iphoneDashboardUnpaired');
  const pairedState = document.getElementById('iphoneDashboardPaired');

  if (!section) return;

  // Check if iPhone is selected as microphone source
  const settings = await ipcRenderer.invoke('get-settings');
  const micSource = settings?.microphoneSource || 'desktop';

  if (micSource !== 'iphone') {
    // Hide section if desktop mic is selected
    section.style.display = 'none';
    return;
  }

  // Show section
  section.style.display = 'block';

  // Update shortcut hint
  const shortcutHint = document.getElementById('iphoneShortcutHint');
  if (shortcutHint) {
    shortcutHint.textContent = shortcut || 'F9';
  }

  // Check pairing status
  try {
    const status = await ipcRenderer.invoke('iphone-get-status');

    if (status && status.paired) {
      // Show paired state
      unpairedState.style.display = 'none';
      pairedState.style.display = 'block';

      // Update device name
      const deviceNameEl = document.getElementById('iphoneDashboardDeviceName');
      if (deviceNameEl) {
        deviceNameEl.textContent = status.deviceName || 'iPhone gekoppelt';
      }

      // Generate QR code for /mic
      await generateDashboardMicQRCode();
    } else {
      // Show unpaired state with button (NOT auto-starting pairing)
      unpairedState.style.display = 'block';
      pairedState.style.display = 'none';

      // Reset to button state (don't auto-start pairing)
      const buttonState = document.getElementById('iphoneDashboardPairButtonState');
      const qrState = document.getElementById('iphoneDashboardQRState');
      if (buttonState) buttonState.style.display = 'block';
      if (qrState) qrState.style.display = 'none';
    }
  } catch (error) {
    console.error('[iPhone] Dashboard status check failed:', error);
    // Default to unpaired state with button
    unpairedState.style.display = 'block';
    pairedState.style.display = 'none';
  }
}

// Generate QR code for /mic on dashboard (for paired iPhones)
async function generateDashboardMicQRCode() {
  try {
    const QRCode = require('qrcode');
    const micUrl = 'https://dentdoc-app.vercel.app/mic';

    const qrContainer = document.getElementById('iphoneDashboardMicQR');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';

    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, micUrl, {
      width: 150,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    qrContainer.appendChild(canvas);

    // Show URL
    const urlEl = document.getElementById('iphoneDashboardMicUrl');
    if (urlEl) {
      urlEl.textContent = micUrl;
    }
  } catch (error) {
    console.error('[iPhone] Dashboard mic QR generation failed:', error);
  }
}

// Update UI based on microphone source selection
function updateMicSourceUI(source) {
  const localMicSection = document.getElementById('settingsLocalMicSection');
  const iphoneSection = document.getElementById('settingsIphonePairingSection');

  if (source === 'iphone') {
    // Show iPhone pairing, hide local mic section
    localMicSection.style.display = 'none';
    iphoneSection.style.display = 'block';
  } else {
    // Show local mic section, hide iPhone pairing
    localMicSection.style.display = 'block';
    iphoneSection.style.display = 'none';
  }
}

// Start iPhone pairing process
async function startIphonePairing() {
  try {
    // Show QR code state
    document.getElementById('settingsIphoneUnpairedState').style.display = 'none';
    document.getElementById('settingsIphoneQRState').style.display = 'block';
    document.getElementById('settingsIphonePairedState').style.display = 'none';

    // Request pairing from backend
    const result = await ipcRenderer.invoke('iphone-pair-start');

    if (!result.success) {
      throw new Error(result.error || 'Pairing fehlgeschlagen');
    }

    // Generate QR code
    const QRCode = require('qrcode');
    const qrContainer = document.getElementById('settingsIphoneQRCode');
    qrContainer.innerHTML = '';

    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, result.pairingUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    qrContainer.appendChild(canvas);

    // Show URL
    document.getElementById('settingsIphonePairingUrl').textContent = result.pairingUrl;

    // Start polling for pairing confirmation
    startPairingPoll(result.pairingId);

    // Set timeout (5 minutes)
    iphonePairingTimeout = setTimeout(() => {
      cancelIphonePairing();
      alert('Kopplung abgelaufen. Bitte erneut versuchen.');
    }, 5 * 60 * 1000);

  } catch (error) {
    console.error('iPhone pairing error:', error);
    cancelIphonePairing();
    alert('Fehler beim Starten der Kopplung: ' + error.message);
  }
}

// Poll for pairing confirmation
function startPairingPoll(pairingId) {
  iphonePairingPollInterval = setInterval(async () => {
    try {
      const status = await ipcRenderer.invoke('iphone-pair-status', pairingId);

      if (status.paired || status.status === 'paired') {
        // Pairing successful!
        clearInterval(iphonePairingPollInterval);
        clearTimeout(iphonePairingTimeout);
        iphonePairingPollInterval = null;
        iphonePairingTimeout = null;

        // Update UI
        document.getElementById('settingsIphoneUnpairedState').style.display = 'none';
        document.getElementById('settingsIphoneQRState').style.display = 'none';
        document.getElementById('settingsIphonePairedState').style.display = 'block';
        document.getElementById('settingsIphoneDeviceName').textContent = status.deviceName || 'iPhone';
        document.getElementById('settingsIphoneStatusText').textContent = 'Bereit';

        // Generate QR code for /mic (so user can reopen Safari later)
        generateMicQRCode();

        // Mark settings as changed
        settingsCheckForChanges();
      } else if (status.status === 'expired') {
        // Pairing code expired
        clearInterval(iphonePairingPollInterval);
        clearTimeout(iphonePairingTimeout);
        iphonePairingPollInterval = null;
        iphonePairingTimeout = null;
        cancelIphonePairing();
        alert('Pairing-Code abgelaufen. Bitte erneut versuchen.');
      }
    } catch (error) {
      console.error('Pairing poll error:', error);
    }
  }, 2000);
}

// Cancel iPhone pairing
function cancelIphonePairing() {
  if (iphonePairingPollInterval) {
    clearInterval(iphonePairingPollInterval);
    iphonePairingPollInterval = null;
  }
  if (iphonePairingTimeout) {
    clearTimeout(iphonePairingTimeout);
    iphonePairingTimeout = null;
  }

  // Reset UI to unpaired state
  document.getElementById('settingsIphoneUnpairedState').style.display = 'block';
  document.getElementById('settingsIphoneQRState').style.display = 'none';
  document.getElementById('settingsIphonePairedState').style.display = 'none';

  // Cancel on backend
  ipcRenderer.invoke('iphone-pair-cancel').catch(console.error);
}

// Unpair iPhone
async function unpairIphone() {
  const confirmed = confirm('Möchten Sie das iPhone wirklich entkoppeln?');
  if (!confirmed) return;

  try {
    await ipcRenderer.invoke('iphone-unpair');

    // Reset UI
    document.getElementById('settingsIphoneUnpairedState').style.display = 'block';
    document.getElementById('settingsIphoneQRState').style.display = 'none';
    document.getElementById('settingsIphonePairedState').style.display = 'none';

    // Switch back to desktop mic
    document.getElementById('settingsMicSourceDesktop').checked = true;
    updateMicSourceUI('desktop');

    settingsCheckForChanges();
  } catch (error) {
    console.error('Unpair error:', error);
    alert('Fehler beim Entkoppeln: ' + error.message);
  }
}

// Event Listeners for iPhone section
document.querySelectorAll('input[name="micSource"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    // If switching away from iPhone, cancel any running pairing
    if (e.target.value === 'desktop') {
      const qrState = document.getElementById('settingsIphoneQRState');
      if (qrState && qrState.style.display !== 'none') {
        cancelIphonePairing();
      }
    }

    updateMicSourceUI(e.target.value);
    // Auto-save microphone source immediately
    await ipcRenderer.invoke('save-settings', { microphoneSource: e.target.value });
  });
});

document.getElementById('settingsIphonePairBtn')?.addEventListener('click', startIphonePairing);
document.getElementById('settingsIphoneCancelPairBtn')?.addEventListener('click', cancelIphonePairing);
document.getElementById('settingsIphoneUnpairBtn')?.addEventListener('click', unpairIphone);
document.getElementById('settingsIphoneTestBtn')?.addEventListener('click', testIphoneMic);

// Listen for iPhone connection status updates from main process
ipcRenderer.on('iphone-connection-status', (event, status) => {
  const statusText = document.getElementById('settingsIphoneStatusText');
  const statusContainer = document.getElementById('settingsIphoneConnectionStatus');

  if (statusText && statusContainer) {
    statusText.textContent = status.connected ? 'Verbunden' : 'Getrennt';
    statusContainer.classList.toggle('disconnected', !status.connected);
  }
});

// Settings Mic Test - uses shared MicTester from audio-utils
const settingsMicTester = new audioUtils.MicTester();

function settingsStopMicTest() {
  // Reset UI
  const btn = document.getElementById('settingsTestMicBtn');
  btn.textContent = 'Test starten (5 Sek.)';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-secondary');
  btn.disabled = false;
  document.getElementById('settingsMicLevelBar').style.width = '0%';
}

document.getElementById('settingsTestMicBtn').addEventListener('click', async () => {
  if (settingsMicTester.isRunning) {
    // Manual stop - just wait for auto-stop
    return;
  }

  const btn = document.getElementById('settingsTestMicBtn');
  btn.textContent = 'Aufnahme läuft...';
  btn.classList.remove('btn-secondary');
  btn.classList.add('btn-danger');
  btn.disabled = true;

  // Hide previous playback
  document.getElementById('settingsMicPlayback').style.display = 'none';

  settingsShowStatus(document.getElementById('settingsMicStatus'), 'Aufnahme läuft... Sprechen Sie ins Mikrofon (5 Sek.)', 'info');

  try {
    await settingsMicTester.start(
      settingsSelectedMicId,      // WebRTC device ID for audio monitoring
      settingsSelectedMicName,    // Device name for FFmpeg
      (level) => {
        // Update level bar
        document.getElementById('settingsMicLevelBar').style.width = level + '%';
      },
      (result) => {
        // On complete callback
        settingsStopMicTest();
        if (result.success) {
          settingsShowStatus(document.getElementById('settingsMicStatus'), 'Test abgeschlossen - Klicken Sie "Anhören" um die Qualität zu prüfen', 'success');
          document.getElementById('settingsMicPlayback').style.display = 'flex';
        } else {
          settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler: ' + result.error, 'error');
        }
      },
      5000  // 5 second duration
    );
  } catch (error) {
    console.error('Mic test error:', error);
    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler: ' + error.message, 'error');
    settingsStopMicTest();
  }
});

// Playback button for settings mic test
document.getElementById('settingsPlayMicBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsPlayMicBtn');
  const audio = document.getElementById('settingsMicAudio');

  // If already playing, stop
  if (!audio.paused) {
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
    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Wiedergabe-Fehler: ' + error.message, 'error');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><polygon points="5,3 19,12 5,21"/></svg>Anhören';
  }
});

document.getElementById('settingsMicSelect').addEventListener('change', () => {
  const select = document.getElementById('settingsMicSelect');
  const mic = audioUtils.getSelectedMicrophone(select);
  settingsSelectedMicId = mic.deviceId;
  settingsSelectedMicName = mic.deviceName;

  // Hide "mic not found" warning when user selects a new mic
  const micNotFoundWarning = document.getElementById('settingsMicNotFoundWarning');
  if (micNotFoundWarning) {
    micNotFoundWarning.style.display = 'none';
  }

  if (settingsMicTester.isRunning) {
    settingsMicTester.stop();
    settingsStopMicTest();
  }
  settingsCheckForChanges();
});

// Settings Shortcut Recording
document.getElementById('settingsRecordShortcutBtn').addEventListener('click', async () => {
  const shortcutDisplay = document.getElementById('settingsShortcutDisplay');
  const recordBtn = document.getElementById('settingsRecordShortcutBtn');
  const shortcutStatus = document.getElementById('settingsShortcutStatus');

  if (settingsIsRecordingShortcut) {
    settingsIsRecordingShortcut = false;
    recordBtn.textContent = 'Ändern';
    shortcutDisplay.classList.remove('recording');
    settingsHideStatus(shortcutStatus);
    await ipcRenderer.invoke('enable-global-shortcut');
    return;
  }

  await ipcRenderer.invoke('disable-global-shortcut');

  settingsIsRecordingShortcut = true;
  recordBtn.textContent = 'Abbrechen';
  shortcutDisplay.classList.add('recording');
  shortcutDisplay.textContent = 'Drücken Sie eine Taste...';
  settingsShowStatus(shortcutStatus, 'Drücken Sie die gewünschte Tastenkombination (z.B. F9, Strg+Shift+R)', 'info');
});

document.addEventListener('keydown', async (e) => {
  if (!settingsIsRecordingShortcut) return;

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
  settingsNewShortcut = parts.join('+');

  const shortcutDisplay = document.getElementById('settingsShortcutDisplay');
  shortcutDisplay.textContent = settingsNewShortcut;
  shortcutDisplay.classList.remove('recording');
  settingsIsRecordingShortcut = false;
  document.getElementById('settingsRecordShortcutBtn').textContent = 'Ändern';

  await ipcRenderer.invoke('enable-global-shortcut');

  settingsShowStatus(document.getElementById('settingsShortcutStatus'), `Neue Tastenkombination: ${settingsNewShortcut}`, 'success');
  settingsCheckForChanges();
});

// Settings Path Buttons
document.getElementById('settingsOpenSoundBtn').addEventListener('click', async () => {
  await ipcRenderer.invoke('open-sound-settings');
});

document.getElementById('settingsBrowseTranscriptBtn').addEventListener('click', async () => {
  console.log('Browse transcript folder clicked');
  const result = await ipcRenderer.invoke('select-folder');
  console.log('select-folder result:', result);
  if (result) {
    document.getElementById('settingsTranscriptPath').value = result;
    console.log('Set transcriptPath input to:', result);
    settingsCheckForChanges();
  } else {
    console.log('No folder selected or dialog cancelled');
  }
});

document.getElementById('settingsOpenTranscriptFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('settingsTranscriptPath').value;
  if (path) {
    await ipcRenderer.invoke('open-folder', path);
  }
});

document.getElementById('settingsBrowseProfilesBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('select-folder');
  if (result) {
    document.getElementById('settingsProfilesPath').value = result;
    settingsCheckForChanges();
  }
});

document.getElementById('settingsOpenProfilesFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('settingsProfilesPath').value;
  if (path) {
    await ipcRenderer.invoke('open-folder', path);
  }
});

// Settings Theme
document.getElementById('settingsThemeSelect').addEventListener('change', () => {
  document.documentElement.setAttribute('data-theme', document.getElementById('settingsThemeSelect').value);
  settingsCheckForChanges();
});

// Settings change tracking
document.getElementById('settingsAutoExportCheckbox').addEventListener('change', settingsCheckForChanges);
document.getElementById('settingsKeepAudioCheckbox').addEventListener('change', settingsCheckForChanges);
document.getElementById('settingsAutoCloseCheckbox').addEventListener('change', settingsCheckForChanges);
document.getElementById('settingsDocModeSelect').addEventListener('change', settingsCheckForChanges);
document.getElementById('settingsVadEnabled').addEventListener('change', settingsCheckForChanges);

// Settings Debug
document.getElementById('settingsOpenLogBtn').addEventListener('click', async () => {
  try {
    await ipcRenderer.invoke('open-debug-log');
    settingsShowStatus(document.getElementById('settingsLogStatus'), 'Debug-Protokoll wurde geöffnet', 'success');
    setTimeout(() => settingsHideStatus(document.getElementById('settingsLogStatus')), 3000);
  } catch (error) {
    settingsShowStatus(document.getElementById('settingsLogStatus'), 'Fehler: ' + error.message, 'error');
  }
});

document.getElementById('settingsCopyLogPathBtn').addEventListener('click', async () => {
  try {
    const path = await ipcRenderer.invoke('get-debug-log-path');
    await navigator.clipboard.writeText(path);
    settingsShowStatus(document.getElementById('settingsLogStatus'), 'Pfad kopiert: ' + path, 'success');
    setTimeout(() => settingsHideStatus(document.getElementById('settingsLogStatus')), 3000);
  } catch (error) {
    settingsShowStatus(document.getElementById('settingsLogStatus'), 'Fehler: ' + error.message, 'error');
  }
});

document.getElementById('settingsUploadLogBtn').addEventListener('click', async () => {
  const btn = document.getElementById('settingsUploadLogBtn');
  const statusEl = document.getElementById('settingsLogStatus');

  try {
    btn.disabled = true;
    btn.textContent = 'Wird gesendet...';
    settingsShowStatus(statusEl, 'Debug-Log wird hochgeladen...', 'info');

    const result = await ipcRenderer.invoke('upload-debug-logs');

    if (result.success) {
      settingsShowStatus(statusEl, `Debug-Log gesendet (ID: ${result.debugLogId})`, 'success');
    } else {
      settingsShowStatus(statusEl, 'Fehler: ' + result.error, 'error');
    }
  } catch (error) {
    settingsShowStatus(statusEl, 'Fehler: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'An Support senden';
    setTimeout(() => settingsHideStatus(statusEl), 5000);
  }
});

// Custom warning modal
function showWarningModal(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('warningModal');
    const titleEl = document.getElementById('warningModalTitle');
    const messageEl = document.getElementById('warningModalMessage');
    const confirmBtn = document.getElementById('warningModalConfirm');
    const cancelBtn = document.getElementById('warningModalCancel');

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.style.display = 'flex';

    const cleanup = () => {
      modal.style.display = 'none';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    };

    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Check if smartphone is selected but not paired
function checkSmartphoneMicWarning() {
  const micSource = document.querySelector('input[name="micSource"]:checked')?.value;
  const isPaired = document.getElementById('settingsIphonePairedState')?.style.display === 'block';

  if (micSource === 'iphone' && !isPaired) {
    return {
      title: 'Kein Mikrofon aktiv',
      message: 'Smartphone als Mikrofon ist ausgewählt, aber kein Gerät ist gekoppelt. Möchten Sie trotzdem fortfahren?'
    };
  }
  return null;
}

// Settings Save/Cancel
document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
  // Check for smartphone mic warning
  const warning = checkSmartphoneMicWarning();
  if (warning && !await showWarningModal(warning.title, warning.message)) {
    return;
  }

  // Get mic name from the selected option (FFmpeg needs device name, not browser ID)
  const micSelect = document.getElementById('settingsMicSelect');
  const selectedMicOption = micSelect.options[micSelect.selectedIndex];
  const micName = selectedMicOption ? selectedMicOption.dataset.micName : null;

  const settings = {
    shortcut: settingsNewShortcut || document.getElementById('settingsShortcutDisplay').textContent,
    microphoneId: micSelect.value,
    microphoneName: micName,  // For FFmpeg
    microphoneSource: document.querySelector('input[name="micSource"]:checked')?.value || 'desktop',
    transcriptPath: document.getElementById('settingsTranscriptPath').value,
    profilesPath: document.getElementById('settingsProfilesPath').value,
    autoClose: document.getElementById('settingsAutoCloseCheckbox').checked,
    autoExport: document.getElementById('settingsAutoExportCheckbox').checked,
    keepAudio: document.getElementById('settingsKeepAudioCheckbox').checked,
    docMode: document.getElementById('settingsDocModeSelect').value,
    theme: document.getElementById('settingsThemeSelect').value,
    vadEnabled: document.getElementById('settingsVadEnabled').checked
  };

  try {
    await ipcRenderer.invoke('save-settings', settings);
    settingsHasUnsavedChanges = false;

    const confirmation = document.getElementById('settingsSaveConfirmation');
    confirmation.style.display = 'block';

    setTimeout(() => {
      confirmation.style.display = 'none';
      switchView('home');
    }, 800);
  } catch (error) {
    settingsShowStatus(document.getElementById('settingsShortcutStatus'), 'Fehler beim Speichern: ' + error.message, 'error');
  }
});

document.getElementById('settingsCancelBtn').addEventListener('click', async () => {
  // Check for smartphone mic warning
  const warning = checkSmartphoneMicWarning();
  if (warning && !await showWarningModal(warning.title, warning.message)) {
    return;
  }

  settingsHasUnsavedChanges = false;
  await switchView('home');
});


// =============================================================================
// PROFILES VIEW
// =============================================================================

let profilesIsRecording = false;
let profilesRecordingTimer = null;
const PROFILES_RECORDING_DURATION = 30;
let profilesAudioContext = null;
let profilesAnalyser = null;
let profilesMediaStream = null;
let profilesAnimationFrameId = null;

async function loadProfilesView() {
  const settings = await ipcRenderer.invoke('get-settings');
  document.getElementById('profilesPathInput').value = settings.profilesPath || 'Standard (AppData)';
  await loadProfiles();
}

document.getElementById('profilesOpenFolderBtn').addEventListener('click', async () => {
  await ipcRenderer.invoke('open-profiles-folder');
});

document.getElementById('profilesBrowseBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('select-folder');
  if (result) {
    document.getElementById('profilesPathInput').value = result;
    await ipcRenderer.invoke('save-profiles-path', result);
    loadProfiles();
  }
});

async function loadProfiles() {
  const profiles = await ipcRenderer.invoke('get-voice-profiles');
  const profileContainer = document.getElementById('profilesContainer');

  if (profiles.length === 0) {
    profileContainer.innerHTML = '<div class="empty-state-small">Keine Stimmprofile vorhanden</div>';
    return;
  }

  const profilesByRole = {};
  for (const profile of profiles) {
    const role = profile.role || 'Sonstige';
    if (!profilesByRole[role]) {
      profilesByRole[role] = [];
    }
    profilesByRole[role].push(profile);
  }

  const roleConfig = {
    'Arzt': { icon: '👨‍⚕️', order: 1 },
    'ZFA': { icon: '👩‍💼', order: 2 },
    'Sonstige': { icon: '👤', order: 3 }
  };

  const sortedRoles = Object.keys(profilesByRole).sort((a, b) => {
    return (roleConfig[a]?.order || 99) - (roleConfig[b]?.order || 99);
  });

  let html = '<div class="profile-columns">';

  for (const role of sortedRoles) {
    const roleProfiles = profilesByRole[role];
    const icon = roleConfig[role]?.icon || '👤';

    html += `
      <div class="profile-column">
        <div class="profile-column-header">
          <span class="role-icon">${icon}</span>
          <span>${role} (${roleProfiles.length})</span>
        </div>
        <ul class="profile-list">
          ${roleProfiles.map(profile => `
            <li class="profile-item">
              <div>
                <div class="profile-name">${profile.name}</div>
                <div class="profile-date">${new Date(profile.createdAt).toLocaleDateString('de-DE')}</div>
              </div>
              <button class="btn-delete" data-profile-id="${profile.id}">Löschen</button>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  html += '</div>';
  profileContainer.innerHTML = html;

  // Add delete handlers
  profileContainer.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.profileId;

      // Use IPC confirm dialog instead of browser confirm() to avoid focus issues
      const confirmed = await ipcRenderer.invoke('confirm-delete-profile');
      if (!confirmed) {
        return;
      }

      try {
        await ipcRenderer.invoke('delete-voice-profile', id);
        profilesShowStatus('Profil erfolgreich gelöscht', 'success');
        loadProfiles();
        setTimeout(() => {
          document.getElementById('profilesStatusMessage').innerHTML = '';
        }, 3000);
      } catch (error) {
        profilesShowStatus('Fehler beim Löschen: ' + error.message, 'error');
      }
    });
  });
}

function profilesShowStatus(message, type) {
  const statusDiv = document.getElementById('profilesStatusMessage');
  statusDiv.innerHTML = `<div class="status-message ${type}">${message}</div>`;
}

document.getElementById('profilesEnrollForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  if (profilesIsRecording) {
    await profilesStopEnrollment();
  } else {
    await profilesStartEnrollment();
  }
});

document.getElementById('profilesCancelBtn').addEventListener('click', async () => {
  await profilesCancelEnrollment();
});

async function profilesStartAudioMonitoring() {
  try {
    profilesMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    profilesAudioContext = new AudioContext();
    profilesAnalyser = profilesAudioContext.createAnalyser();
    profilesAnalyser.fftSize = 256;

    const source = profilesAudioContext.createMediaStreamSource(profilesMediaStream);
    source.connect(profilesAnalyser);

    const bufferLength = profilesAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function updateLevel() {
      profilesAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const normalized = Math.min(average / 128 * 100, 100);
      document.getElementById('profilesAudioLevelBar').style.width = normalized + '%';
      profilesAnimationFrameId = requestAnimationFrame(updateLevel);
    }

    updateLevel();
    document.getElementById('profilesAudioIndicator').classList.add('visible');
  } catch (error) {
    console.error('Audio monitoring error:', error);
  }
}

function profilesStopAudioMonitoring() {
  if (profilesAnimationFrameId) {
    cancelAnimationFrame(profilesAnimationFrameId);
    profilesAnimationFrameId = null;
  }
  if (profilesMediaStream) {
    profilesMediaStream.getTracks().forEach(track => track.stop());
    profilesMediaStream = null;
  }
  if (profilesAudioContext) {
    profilesAudioContext.close();
    profilesAudioContext = null;
  }
  document.getElementById('profilesAudioLevelBar').style.width = '0%';
  document.getElementById('profilesAudioIndicator').classList.remove('visible');
}

async function profilesStartEnrollment() {
  const name = document.getElementById('profilesSpeakerName').value.trim();
  const role = document.getElementById('profilesSpeakerRole').value;

  if (!role) {
    profilesShowStatus('Bitte wählen Sie eine Rolle aus', 'error');
    return;
  }

  if (!name) {
    profilesShowStatus('Bitte geben Sie einen Namen ein', 'error');
    return;
  }

  try {
    profilesIsRecording = true;
    profilesUpdateButton('Aufnahme läuft... (0s / 30s)', true);
    profilesShowStatus('🔴 Sprechen Sie jetzt für 30 Sekunden...', 'recording');

    document.getElementById('profilesProgressBarContainer').classList.add('visible');
    document.getElementById('profilesProgressBar').style.width = '0%';
    document.getElementById('profilesCancelBtn').style.display = 'block';

    await profilesStartAudioMonitoring();
    await ipcRenderer.invoke('start-voice-enrollment', { name, role });

    let seconds = 0;
    profilesRecordingTimer = setInterval(() => {
      seconds++;
      profilesUpdateButton(`Aufnahme läuft... (${seconds}s / ${PROFILES_RECORDING_DURATION}s)`, true);
      document.getElementById('profilesProgressBar').style.width = `${(seconds / PROFILES_RECORDING_DURATION) * 100}%`;

      if (seconds >= PROFILES_RECORDING_DURATION) {
        clearInterval(profilesRecordingTimer);
        profilesStopEnrollment();
      }
    }, 1000);

  } catch (error) {
    profilesShowStatus('Fehler beim Starten: ' + error.message, 'error');
    profilesIsRecording = false;
    document.getElementById('profilesProgressBarContainer').classList.remove('visible');
    document.getElementById('profilesCancelBtn').style.display = 'none';
    profilesUpdateButton('Aufnahme starten (30 Sekunden)', false);
  }
}

async function profilesStopEnrollment() {
  if (profilesRecordingTimer) {
    clearInterval(profilesRecordingTimer);
    profilesRecordingTimer = null;
  }

  profilesStopAudioMonitoring();

  try {
    profilesUpdateButton('Verarbeite Aufnahme...', true);
    document.getElementById('profilesCancelBtn').style.display = 'none';
    profilesShowStatus('⏳ Stimmprofil wird erstellt...', 'processing');

    await ipcRenderer.invoke('stop-voice-enrollment');

    profilesShowStatus('✅ Stimmprofil erfolgreich erstellt!', 'success');
    document.getElementById('profilesSpeakerName').value = '';
    document.getElementById('profilesSpeakerRole').value = '';
    document.getElementById('profilesProgressBarContainer').classList.remove('visible');
    document.getElementById('profilesProgressBar').style.width = '0%';
    loadProfiles();

    setTimeout(() => {
      document.getElementById('profilesStatusMessage').innerHTML = '';
    }, 3000);

  } catch (error) {
    profilesShowStatus('Fehler: ' + error.message, 'error');
  } finally {
    profilesIsRecording = false;
    document.getElementById('profilesProgressBarContainer').classList.remove('visible');
    document.getElementById('profilesCancelBtn').style.display = 'none';
    profilesUpdateButton('Aufnahme starten (30 Sekunden)', false);
  }
}

async function profilesCancelEnrollment() {
  if (profilesRecordingTimer) {
    clearInterval(profilesRecordingTimer);
    profilesRecordingTimer = null;
  }

  try {
    await ipcRenderer.invoke('cancel-voice-enrollment');
  } catch (error) {
    console.error('Cancel error:', error);
  }

  profilesStopAudioMonitoring();
  profilesIsRecording = false;
  document.getElementById('profilesProgressBarContainer').classList.remove('visible');
  document.getElementById('profilesProgressBar').style.width = '0%';
  document.getElementById('profilesCancelBtn').style.display = 'none';
  profilesUpdateButton('Aufnahme starten (30 Sekunden)', false);
  document.getElementById('profilesStatusMessage').innerHTML = '';
}

function profilesUpdateButton(text, disabled) {
  document.getElementById('profilesBtnText').textContent = text;
  document.getElementById('profilesEnrollBtn').disabled = disabled;
}

ipcRenderer.on('enrollment-complete', (event, success, message) => {
  if (success) {
    profilesShowStatus('✅ ' + message, 'success');
    loadProfiles();
  } else {
    profilesShowStatus('❌ ' + message, 'error');
  }
  profilesIsRecording = false;
  profilesUpdateButton('Aufnahme starten (30 Sekunden)', false);
});


// ===========================================
// Settings Tour Button
// ===========================================
let driverModule = null;
try {
  driverModule = require('driver.js');
} catch (e) {
  console.log('driver.js not available for tour');
}

function createSettingsTour() {
  if (!driverModule || !driverModule.driver) {
    console.log('Tour not available - driver.js not loaded');
    return null;
  }
  return driverModule.driver({
    showProgress: true,
    progressText: 'Schritt {{current}} von {{total}}',
    nextBtnText: 'Weiter',
    prevBtnText: 'Zurück',
    doneBtnText: 'Fertig',
    showButtons: ['next', 'previous', 'close'],
    animate: true,
    allowClose: true,
    overlayClickNext: false,
    disableActiveInteraction: true,
    stagePadding: 10,
    stageRadius: 12,
    popoverClass: 'dentdoc-tour',
    steps: [
      {
        popover: {
          title: 'Willkommen bei DentDoc!',
          description: 'Diese kurze Tour zeigt Ihnen die wichtigsten Funktionen. Sie können die Tour jederzeit beenden oder später erneut starten.',
          side: 'center',
          align: 'center'
        }
      },
      {
        element: '#settings-section-mic',
        popover: {
          title: 'Mikrofon-Einstellungen',
          description: 'Wählen Sie hier Ihr Mikrofon aus und testen Sie die Aufnahmequalität. Ein gutes Mikrofon ist wichtig für präzise Transkriptionen.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#settings-section-shortcut',
        popover: {
          title: 'Tastenkombination',
          description: 'Drücken Sie F9 (oder Ihre gewählte Taste), um eine Aufnahme zu starten oder zu stoppen. Sie können die Taste hier ändern.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#settings-section-export',
        popover: {
          title: 'Transkript-Export',
          description: 'Aktivieren Sie diese Option, um alle Transkriptionen automatisch als Textdateien zu speichern.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#settings-section-recordings',
        popover: {
          title: 'Aufnahmen speichern',
          description: 'Optional können Sie die Audio-Aufnahmen dauerhaft speichern für Qualitätskontrolle oder spätere Referenz.',
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '#settings-section-profiles-path',
        popover: {
          title: 'Stimmprofile',
          description: 'Mit Stimmprofilen erkennt DentDoc verschiedene Sprecher automatisch. So wird klar, wer was gesagt hat.',
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '#settings-section-appearance',
        popover: {
          title: 'Erscheinungsbild',
          description: 'Wählen Sie zwischen hellem und dunklem Design - ganz nach Ihrem Geschmack.',
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '#settingsSaveBtn',
        popover: {
          title: 'Einstellungen speichern',
          description: 'Vergessen Sie nicht, Ihre Änderungen zu speichern! Klicken Sie auf "Speichern", wenn Sie fertig sind.',
          side: 'top',
          align: 'end'
        }
      },
      {
        popover: {
          title: 'Sie sind startklar!',
          description: 'Drücken Sie F9, um Ihre erste Aufnahme zu starten. Das Status-Fenster zeigt Ihnen den Fortschritt an. Viel Erfolg!',
          side: 'center',
          align: 'center'
        }
      }
    ],
    onDestroyed: () => {
      ipcRenderer.invoke('mark-tour-completed', 'settings');
    }
  });
}

// DISABLED: Settings tour temporarily disabled
// document.getElementById('settingsStartTourBtn').addEventListener('click', () => {
//   const tourDriver = createSettingsTour();
//   if (tourDriver) {
//     tourDriver.drive();
//   } else {
//     alert('Tour-Funktion ist nicht verfügbar.');
//   }
// });


// =============================================================================
// FEEDBACK VIEW
// =============================================================================

const feedbackForm = document.getElementById('feedbackForm');
const feedbackFormContent = document.getElementById('feedbackFormContent');
const feedbackSuccessMessage = document.getElementById('feedbackSuccessMessage');
const feedbackErrorMessage = document.getElementById('feedbackErrorMessage');
const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
const feedbackCancelBtn = document.getElementById('feedbackCancelBtn');
const feedbackCategorySelect = document.getElementById('feedbackCategory');
const feedbackMessageTextarea = document.getElementById('feedbackMessage');

feedbackCancelBtn.addEventListener('click', () => {
  feedbackCategorySelect.value = '';
  feedbackMessageTextarea.value = '';
  feedbackErrorMessage.classList.remove('visible');
  feedbackErrorMessage.textContent = '';
});

feedbackForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const category = feedbackCategorySelect.value;
  const message = feedbackMessageTextarea.value.trim();

  if (!category || !message) {
    feedbackShowError('Bitte füllen Sie alle Felder aus.');
    return;
  }

  feedbackSubmitBtn.disabled = true;
  feedbackSubmitBtn.textContent = 'Wird gesendet...';
  feedbackErrorMessage.classList.remove('visible');

  try {
    const result = await ipcRenderer.invoke('submit-feedback', {
      category,
      message
    });

    if (result.success) {
      feedbackFormContent.classList.add('hidden');
      feedbackSuccessMessage.classList.add('visible');

      // Reset form and show form again after 3 seconds
      setTimeout(() => {
        feedbackCategorySelect.value = '';
        feedbackMessageTextarea.value = '';
        feedbackFormContent.classList.remove('hidden');
        feedbackSuccessMessage.classList.remove('visible');
        feedbackSubmitBtn.disabled = false;
        feedbackSubmitBtn.textContent = 'Absenden';
      }, 3000);
    } else {
      feedbackShowError(result.error || 'Feedback konnte nicht gesendet werden.');
      feedbackSubmitBtn.disabled = false;
      feedbackSubmitBtn.textContent = 'Absenden';
    }
  } catch (error) {
    feedbackShowError('Verbindungsfehler. Bitte versuchen Sie es später erneut.');
    feedbackSubmitBtn.disabled = false;
    feedbackSubmitBtn.textContent = 'Absenden';
  }
});

function feedbackShowError(msg) {
  feedbackErrorMessage.textContent = msg;
  feedbackErrorMessage.classList.add('visible');
}


// =============================================================================
// SUBSCRIPTION VIEW
// =============================================================================

let subscriptionData = null;

async function loadSubscriptionView() {
  try {
    const data = await ipcRenderer.invoke('get-subscription-details');
    subscriptionData = data;

    // Update plan status
    const planStatus = document.getElementById('subscriptionPlanStatus');
    planStatus.classList.remove('status-success', 'status-warning', 'status-error', 'status-trial');
    planStatus.classList.add(`status-${data.status.type}`);
    planStatus.querySelector('.plan-status-label').textContent = data.status.label;

    // Update plan name
    document.getElementById('subscriptionPlanName').textContent = data.planName || 'Kein Plan';

    // Update devices
    const deviceUsage = `${data.activeDevices || 0}/${data.maxDevices || 0}`;
    document.getElementById('subscriptionDevices').textContent = deviceUsage;
    document.getElementById('deviceUsage').textContent = deviceUsage;

    // Load devices list
    renderDevicesList(data.devices || []);
  } catch (error) {
    console.error('Error loading subscription view:', error);
  }
}

function renderDevicesList(devices) {
  const container = document.getElementById('devicesList');

  if (!devices || devices.length === 0) {
    container.innerHTML = '<div class="devices-empty">Keine Arbeitsplätze registriert</div>';
    return;
  }

  const currentDeviceId = subscriptionData?.currentDeviceId;

  container.innerHTML = devices.map(device => {
    const isCurrent = device.id === currentDeviceId;
    const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
    const lastSeenStr = lastSeen
      ? `Zuletzt aktiv: ${lastSeen.toLocaleDateString('de-DE')} um ${lastSeen.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
      : 'Unbekannt';

    return `
      <div class="device-item${isCurrent ? ' current' : ''}">
        <div class="device-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div class="device-info">
          <div class="device-name">
            ${device.name || 'Unbenanntes Gerät'}
            ${isCurrent ? '<span class="current-badge">Dieses Gerät</span>' : ''}
          </div>
          <div class="device-last-seen">${lastSeenStr}</div>
        </div>
      </div>
    `;
  }).join('');
}

// Manage subscription button
document.getElementById('subscriptionManageBtn').addEventListener('click', async () => {
  const baseUrl = await ipcRenderer.invoke('get-base-url');
  await ipcRenderer.invoke('open-external-url', baseUrl + '/dashboard/subscription');
});

// Device stat card click - navigate to subscription view
document.getElementById('deviceStatCard').addEventListener('click', () => {
  switchView('subscription');
});

// Dashboard iPhone - go to settings link
document.getElementById('iphoneDashboardGoToSettings')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchView('settings');
});

// Update loadViewContent to include subscription
const originalLoadViewContent = loadViewContent;
async function loadViewContent(viewName) {
  switch (viewName) {
    case 'home':
      loadHomeStats();
      break;
    case 'settings':
      loadSettingsView();
      break;
    case 'profiles':
      loadProfilesView();
      break;
    case 'subscription':
      loadSubscriptionView();
      break;
  }
}

// =============================================================================
// SPEAKER OPTIMIZATION
// =============================================================================

let optimizationData = null;           // Data from main.js: { unrecognizedSpeakers, speakerMapping }
let optimizationSelectedSpeaker = null; // Currently selected speaker ID (e.g., 'SPEAKER_00')
let optimizationSelectedRole = null;    // 'Arzt' | 'ZFA'
let optimizationAudioElement = null;    // Audio element for preview playback
let optimizationProfiles = [];          // Available profiles for dropdown

/**
 * Listen for 'show-speaker-optimization-modal' from main.js
 * This is triggered when user clicks "Optimize" in status-overlay
 */
ipcRenderer.on('show-speaker-optimization-modal', async (event, data) => {
  console.log('[SpeakerOptimization] Modal requested with data:', data);
  optimizationData = data;
  await openSpeakerOptimizationModal();
});

/**
 * Opens the speaker optimization modal and populates it with data
 */
async function openSpeakerOptimizationModal() {
  const modal = document.getElementById('speakerOptimizationModal');
  if (!modal) {
    console.error('[SpeakerOptimization] Modal element not found');
    return;
  }

  // Reset state
  optimizationSelectedSpeaker = null;
  optimizationSelectedRole = null;
  optimizationAudioElement = null;

  // Load available profiles for dropdown
  try {
    optimizationProfiles = await ipcRenderer.invoke('get-profiles-for-optimization');
  } catch (error) {
    console.error('[SpeakerOptimization] Error loading profiles:', error);
    optimizationProfiles = [];
  }

  // Populate unrecognized speakers list
  populateUnrecognizedSpeakers();

  // Reset detail panel to initial state
  resetOptimizationDetailPanel();

  // Show modal
  modal.classList.add('active');
}

/**
 * Populates the list of unrecognized speakers
 */
function populateUnrecognizedSpeakers() {
  const listEl = document.getElementById('optimizationSpeakersList');
  if (!listEl || !optimizationData) return;

  const { unrecognizedSpeakers, speakerMapping } = optimizationData;

  if (!unrecognizedSpeakers || unrecognizedSpeakers.length === 0) {
    listEl.innerHTML = '<div class="empty-state">Keine unerkannten Sprecher</div>';
    return;
  }

  listEl.innerHTML = unrecognizedSpeakers.map(speaker => {
    // Get speaker info from mapping
    const mappingEntry = speakerMapping?.find(m => m.speakerId === speaker.speakerId);
    const utteranceCount = speaker.utteranceCount || 0;
    const totalDuration = speaker.totalDurationMs || 0;
    const durationSec = (totalDuration / 1000).toFixed(1);
    const displayLabel = mappingEntry?.displayLabel || speaker.speakerId;

    return `
      <div class="speaker-card" data-speaker-id="${speaker.speakerId}">
        <div class="speaker-card-header">
          <span class="speaker-label">${escapeHtml(displayLabel)}</span>
          <span class="speaker-badge unrecognized">Unerkannt</span>
        </div>
        <div class="speaker-card-stats">
          <span>${utteranceCount} Äußerungen</span>
          <span>${durationSec}s Audio</span>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  listEl.querySelectorAll('.speaker-card').forEach(card => {
    card.addEventListener('click', () => {
      selectOptimizationSpeaker(card.dataset.speakerId);
    });
  });
}

/**
 * Selects a speaker and shows the detail panel
 */
async function selectOptimizationSpeaker(speakerId) {
  optimizationSelectedSpeaker = speakerId;
  optimizationSelectedRole = null;

  // Update speaker card selection
  document.querySelectorAll('#optimizationSpeakersList .speaker-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.speakerId === speakerId);
  });

  // Show detail panel
  const detailPanel = document.getElementById('optimizationDetailPanel');
  const placeholder = document.getElementById('optimizationPlaceholder');

  if (placeholder) placeholder.style.display = 'none';
  if (detailPanel) detailPanel.style.display = 'block';

  // Get speaker info
  const speaker = optimizationData.unrecognizedSpeakers.find(s => s.speakerId === speakerId);
  const mappingEntry = optimizationData.speakerMapping?.find(m => m.speakerId === speakerId);
  const displayLabel = mappingEntry?.displayLabel || speakerId;

  // Update header
  const headerEl = document.getElementById('optimizationSpeakerHeader');
  if (headerEl) {
    headerEl.textContent = `${displayLabel} konfigurieren`;
  }

  // Reset role selection
  document.querySelectorAll('.role-btn').forEach(btn => {
    btn.classList.remove('selected');
  });

  // Reset action selection
  document.getElementById('optimizationActionSelect').value = '';
  document.getElementById('optimizationNewProfileSection').style.display = 'none';
  document.getElementById('optimizationExistingProfileSection').style.display = 'none';

  // Update preview button state
  updateOptimizationPreviewButton();

  // Update confirm button state
  updateOptimizationConfirmButton();
}

/**
 * Resets the detail panel to initial state
 */
function resetOptimizationDetailPanel() {
  const detailPanel = document.getElementById('optimizationDetailPanel');
  const placeholder = document.getElementById('optimizationPlaceholder');

  if (detailPanel) detailPanel.style.display = 'none';
  if (placeholder) placeholder.style.display = 'flex';
}

/**
 * Updates the preview button state based on selection
 */
function updateOptimizationPreviewButton() {
  const btn = document.getElementById('optimizationPreviewBtn');
  if (btn) {
    btn.disabled = !optimizationSelectedSpeaker;
  }
}

/**
 * Updates the confirm button state
 */
function updateOptimizationConfirmButton() {
  const btn = document.getElementById('optimizationConfirmBtn');
  if (!btn) return;

  const actionSelect = document.getElementById('optimizationActionSelect');
  const action = actionSelect?.value;

  let isValid = false;

  if (optimizationSelectedSpeaker && optimizationSelectedRole) {
    if (action === 'new') {
      const nameInput = document.getElementById('optimizationNewProfileName');
      isValid = nameInput?.value.trim().length > 0;
    } else if (action === 'existing') {
      const profileSelect = document.getElementById('optimizationProfileSelect');
      isValid = profileSelect?.value.length > 0;
    }
  }

  btn.disabled = !isValid;
}

/**
 * Handles role button clicks
 */
function handleRoleSelection(role) {
  if (role === 'Patient') {
    // Patients cannot be enrolled - show tooltip/message
    return;
  }

  optimizationSelectedRole = role;

  // Update button states
  document.querySelectorAll('.role-btn').forEach(btn => {
    btn.classList.remove('selected');
    if (btn.dataset.role === role) {
      btn.classList.add('selected');
    }
  });

  // Update profile dropdown to filter by role
  populateOptimizationProfileDropdown();
  updateOptimizationConfirmButton();
}

/**
 * Populates the existing profile dropdown filtered by role
 */
function populateOptimizationProfileDropdown() {
  const select = document.getElementById('optimizationProfileSelect');
  if (!select) return;

  select.innerHTML = '<option value="">Profil auswählen...</option>';

  if (!optimizationSelectedRole) return;

  // Filter profiles by selected role
  const matchingProfiles = optimizationProfiles.filter(p => p.role === optimizationSelectedRole);

  matchingProfiles.forEach(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  });
}

/**
 * Handles action selection (new profile vs existing)
 */
function handleActionSelection(action) {
  const newSection = document.getElementById('optimizationNewProfileSection');
  const existingSection = document.getElementById('optimizationExistingProfileSection');

  if (action === 'new') {
    newSection.style.display = 'block';
    existingSection.style.display = 'none';
  } else if (action === 'existing') {
    newSection.style.display = 'none';
    existingSection.style.display = 'block';
    populateOptimizationProfileDropdown();
  } else {
    newSection.style.display = 'none';
    existingSection.style.display = 'none';
  }

  updateOptimizationConfirmButton();
}

/**
 * Plays audio preview for selected speaker
 */
async function playOptimizationPreview() {
  if (!optimizationSelectedSpeaker) return;

  const btn = document.getElementById('optimizationPreviewBtn');
  const originalContent = btn.innerHTML;

  try {
    // If already playing, stop
    if (optimizationAudioElement && !optimizationAudioElement.paused) {
      optimizationAudioElement.pause();
      optimizationAudioElement.currentTime = 0;
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Anhören';
      return;
    }

    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke="currentColor" fill="none" stroke-width="2" stroke-dasharray="30 70"/></svg> Lädt...';
    btn.disabled = true;

    // Get audio preview from main process
    const result = await ipcRenderer.invoke('get-speaker-preview', optimizationSelectedSpeaker);

    if (!result.success) {
      throw new Error(result.error || 'Preview konnte nicht geladen werden');
    }

    // Create audio element
    optimizationAudioElement = new Audio(`data:audio/wav;base64,${result.audioData}`);

    optimizationAudioElement.onended = () => {
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Anhören';
      btn.disabled = false;
    };

    optimizationAudioElement.onerror = () => {
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Anhören';
      btn.disabled = false;
      console.error('[SpeakerOptimization] Audio playback error');
    };

    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stoppen';
    btn.disabled = false;

    await optimizationAudioElement.play();
  } catch (error) {
    console.error('[SpeakerOptimization] Preview error:', error);
    btn.innerHTML = originalContent;
    btn.disabled = false;
    alert('Fehler beim Laden der Vorschau: ' + error.message);
  }
}

/**
 * Confirms the speaker enrollment
 */
async function confirmOptimizationEnrollment() {
  if (!optimizationSelectedSpeaker || !optimizationSelectedRole) {
    return;
  }

  const actionSelect = document.getElementById('optimizationActionSelect');
  const action = actionSelect?.value;

  const btn = document.getElementById('optimizationConfirmBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Wird gespeichert...';

  try {
    let enrollData = {
      speakerId: optimizationSelectedSpeaker,
      role: optimizationSelectedRole,
      action: action
    };

    if (action === 'new') {
      const nameInput = document.getElementById('optimizationNewProfileName');
      enrollData.newProfileName = nameInput.value.trim();

      if (!enrollData.newProfileName) {
        throw new Error('Bitte geben Sie einen Namen ein');
      }
    } else if (action === 'existing') {
      const profileSelect = document.getElementById('optimizationProfileSelect');
      enrollData.existingProfileId = profileSelect.value;

      if (!enrollData.existingProfileId) {
        throw new Error('Bitte wählen Sie ein Profil');
      }
    }

    const result = await ipcRenderer.invoke('enroll-optimized-speaker', enrollData);

    if (!result.success) {
      throw new Error(result.error || 'Speichern fehlgeschlagen');
    }

    // Show success feedback
    btn.textContent = '✓ Gespeichert!';
    btn.classList.add('success');

    // Remove the enrolled speaker from list
    optimizationData.unrecognizedSpeakers = optimizationData.unrecognizedSpeakers.filter(
      s => s.speakerId !== optimizationSelectedSpeaker
    );

    // Check if there are more speakers to process
    if (optimizationData.unrecognizedSpeakers.length === 0) {
      // All done - close modal after delay
      setTimeout(() => {
        closeSpeakerOptimizationModal();
      }, 1000);
    } else {
      // Refresh the list and reset selection
      setTimeout(() => {
        populateUnrecognizedSpeakers();
        resetOptimizationDetailPanel();
        btn.textContent = originalText;
        btn.classList.remove('success');
        btn.disabled = false;
      }, 1000);
    }

  } catch (error) {
    console.error('[SpeakerOptimization] Enrollment error:', error);
    btn.textContent = originalText;
    btn.disabled = false;
    alert('Fehler: ' + error.message);
  }
}

/**
 * Closes the speaker optimization modal
 */
async function closeSpeakerOptimizationModal() {
  const modal = document.getElementById('speakerOptimizationModal');
  if (modal) {
    modal.classList.remove('active');
  }

  // Stop any playing audio
  if (optimizationAudioElement) {
    optimizationAudioElement.pause();
    optimizationAudioElement = null;
  }

  // Cancel optimization session
  try {
    await ipcRenderer.invoke('cancel-speaker-optimization');
  } catch (error) {
    console.error('[SpeakerOptimization] Cancel error:', error);
  }

  // Reset state
  optimizationData = null;
  optimizationSelectedSpeaker = null;
  optimizationSelectedRole = null;
  optimizationProfiles = [];
}

// Speaker Optimization Event Listeners
document.getElementById('optimizationCloseBtn')?.addEventListener('click', closeSpeakerOptimizationModal);
document.getElementById('optimizationCancelBtn')?.addEventListener('click', closeSpeakerOptimizationModal);
document.getElementById('optimizationPreviewBtn')?.addEventListener('click', playOptimizationPreview);
document.getElementById('optimizationConfirmBtn')?.addEventListener('click', confirmOptimizationEnrollment);

// Role buttons
document.querySelectorAll('.role-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    handleRoleSelection(btn.dataset.role);
  });
});

// Action select
document.getElementById('optimizationActionSelect')?.addEventListener('change', (e) => {
  handleActionSelection(e.target.value);
});

// Profile select
document.getElementById('optimizationProfileSelect')?.addEventListener('change', () => {
  updateOptimizationConfirmButton();
});

// New profile name input
document.getElementById('optimizationNewProfileName')?.addEventListener('input', () => {
  updateOptimizationConfirmButton();
});

// Close modal on overlay click
document.getElementById('speakerOptimizationModal')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    closeSpeakerOptimizationModal();
  }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('speakerOptimizationModal');
    if (modal?.classList.contains('active')) {
      closeSpeakerOptimizationModal();
    }
    // Also close transcript modal
    const transcriptModal = document.getElementById('transcriptModal');
    if (transcriptModal?.style.display !== 'none') {
      closeTranscriptModal();
    }
  }
});

// =============================================================================
// TRANSCRIPTS VIEW
// =============================================================================

let allTranscripts = [];
let filteredTranscripts = [];
let currentTranscriptData = null;
let currentDateFilter = 'all';
let currentSearchQuery = '';
let customDateFrom = null;
let customDateTo = null;
const TRANSCRIPTS_PER_PAGE = 30;
let displayedTranscriptsCount = 0;
let isLoadingMore = false;

// Load all transcripts
async function loadTranscripts() {
  try {
    const result = await ipcRenderer.invoke('get-all-transcripts');
    if (result.success) {
      allTranscripts = result.transcripts;
      applyFilters();
    } else {
      console.error('Failed to load transcripts:', result.error);
    }
  } catch (error) {
    console.error('Error loading transcripts:', error);
  }
}

// Apply both date filter and search query
function applyFilters() {
  let result = allTranscripts;

  // Apply date filter
  if (currentDateFilter !== 'all') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    result = result.filter(t => {
      const transcriptDate = new Date(t.createdAt);

      if (currentDateFilter === 'today') {
        return transcriptDate >= today;
      } else if (currentDateFilter === 'week') {
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        return transcriptDate >= weekAgo;
      } else if (currentDateFilter === 'month') {
        const monthAgo = new Date(today);
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        return transcriptDate >= monthAgo;
      } else if (currentDateFilter === 'custom') {
        // Custom date range filter
        if (customDateFrom) {
          const fromDate = new Date(customDateFrom);
          fromDate.setHours(0, 0, 0, 0);
          if (transcriptDate < fromDate) return false;
        }
        if (customDateTo) {
          const toDate = new Date(customDateTo);
          toDate.setHours(23, 59, 59, 999);
          if (transcriptDate > toDate) return false;
        }
      }
      return true;
    });
  }

  // Apply search query
  if (currentSearchQuery.trim()) {
    const lowerQuery = currentSearchQuery.toLowerCase();
    result = result.filter(t => {
      const date = new Date(t.createdAt);
      const dateStr = date.toLocaleDateString('de-DE');
      const timeStr = date.toLocaleTimeString('de-DE');
      const speakers = t.speakers?.join(' ') || '';
      const folder = t.folderName || '';

      return dateStr.includes(lowerQuery) ||
             timeStr.includes(lowerQuery) ||
             speakers.toLowerCase().includes(lowerQuery) ||
             folder.toLowerCase().includes(lowerQuery);
    });
  }

  filteredTranscripts = result;
  displayedTranscriptsCount = 0;
  renderTranscriptsList(true);
  document.getElementById('transcriptCount').textContent = filteredTranscripts.length;
}

// Set date filter
function setDateFilter(filter) {
  // If clicking custom, show the date picker popup
  if (filter === 'custom') {
    openDateRangePicker();
    return;
  }

  currentDateFilter = filter;
  customDateFrom = null;
  customDateTo = null;

  // Update active chip
  document.querySelectorAll('.date-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  });

  // Update custom button text
  updateCustomDateButtonText();

  applyFilters();
}

// Date Range Picker functions
function openDateRangePicker() {
  const picker = document.getElementById('dateRangePicker');
  const dateFromInput = document.getElementById('dateFrom');
  const dateToInput = document.getElementById('dateTo');

  // Set current values if they exist
  if (customDateFrom) dateFromInput.value = customDateFrom;
  if (customDateTo) dateToInput.value = customDateTo;

  // Set max date to today
  const today = new Date().toISOString().split('T')[0];
  dateFromInput.max = today;
  dateToInput.max = today;

  picker.style.display = 'block';
}

function closeDateRangePicker() {
  document.getElementById('dateRangePicker').style.display = 'none';
}

function applyDateRange() {
  const dateFromInput = document.getElementById('dateFrom');
  const dateToInput = document.getElementById('dateTo');

  customDateFrom = dateFromInput.value || null;
  customDateTo = dateToInput.value || null;

  // Only apply if at least one date is set
  if (customDateFrom || customDateTo) {
    currentDateFilter = 'custom';

    // Update active chip
    document.querySelectorAll('.date-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === 'custom');
    });

    updateCustomDateButtonText();
    applyFilters();
  }

  closeDateRangePicker();
}

function clearDateRange() {
  document.getElementById('dateFrom').value = '';
  document.getElementById('dateTo').value = '';
  customDateFrom = null;
  customDateTo = null;

  currentDateFilter = 'all';

  // Update active chip
  document.querySelectorAll('.date-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === 'all');
  });

  updateCustomDateButtonText();
  closeDateRangePicker();
  applyFilters();
}

function updateCustomDateButtonText() {
  const btn = document.getElementById('customDateBtn');
  if (!btn) return;

  if (customDateFrom || customDateTo) {
    const fromStr = customDateFrom ? new Date(customDateFrom).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '...';
    const toStr = customDateTo ? new Date(customDateTo).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '...';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      ${fromStr} - ${toStr}
    `;
  } else {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
      Zeitraum
    `;
  }
}

// Filter transcripts by search query
function filterTranscripts(query) {
  currentSearchQuery = query;
  applyFilters();
}

// Render transcripts list with lazy loading
function renderTranscriptsList(reset = false) {
  const listEl = document.getElementById('transcriptsList');
  const emptyEl = document.getElementById('transcriptsEmpty');

  // Remove load more button if exists
  const existingLoadMore = listEl.querySelector('.load-more-btn');
  if (existingLoadMore) existingLoadMore.remove();

  if (reset) {
    // Clear existing cards (keep empty state)
    const cards = listEl.querySelectorAll('.transcript-card');
    cards.forEach(card => card.remove());
    displayedTranscriptsCount = 0;
  }

  if (filteredTranscripts.length === 0) {
    emptyEl.style.display = 'flex';
    return;
  }

  emptyEl.style.display = 'none';

  // Calculate how many to show
  const startIndex = displayedTranscriptsCount;
  const endIndex = Math.min(startIndex + TRANSCRIPTS_PER_PAGE, filteredTranscripts.length);

  // Render next batch
  for (let i = startIndex; i < endIndex; i++) {
    const card = createTranscriptCard(filteredTranscripts[i]);
    listEl.appendChild(card);
  }

  displayedTranscriptsCount = endIndex;

  // Add "Load more" button if there are more transcripts
  if (displayedTranscriptsCount < filteredTranscripts.length) {
    const remaining = filteredTranscripts.length - displayedTranscriptsCount;
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
      Weitere ${Math.min(remaining, TRANSCRIPTS_PER_PAGE)} von ${remaining} laden
    `;
    loadMoreBtn.addEventListener('click', () => {
      loadMoreBtn.remove();
      renderTranscriptsList(false);
    });
    listEl.appendChild(loadMoreBtn);
  }
}

// Create a transcript card element
function createTranscriptCard(transcript) {
  const card = document.createElement('div');
  card.className = 'transcript-card';
  card.dataset.filePath = transcript.filePath;

  // Format date
  const date = new Date(transcript.createdAt);
  const dateStr = date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const timeStr = date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Get speakers
  const speakers = transcript.speakers?.length > 0
    ? transcript.speakers.join(', ')
    : transcript.folderName || 'Unbekannt';

  // Get summary preview (first 150 chars)
  const summaryPreview = transcript.summary
    ? transcript.summary.substring(0, 150) + (transcript.summary.length > 150 ? '...' : '')
    : 'Keine Zusammenfassung verfügbar';

  // Badges container
  const badges = [];

  // Audio badge
  if (transcript.hasAudio) {
    badges.push(`<div class="transcript-card-badge audio">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Audio
    </div>`);
  }

  // 01-Status badge (Zahnstatus) - clickable to open tooth chart
  if (transcript.status01) {
    const status01Json = JSON.stringify(transcript.status01).replace(/"/g, '&quot;');
    badges.push(`<div class="transcript-card-badge status01 clickable" title="Klicken um Zahnstatus anzuzeigen" data-status01="${status01Json}">01</div>`);
  }

  // PA-Status badge (Parodontalstatus) - clickable to copy PA JSON
  if (transcript.statusPA) {
    const statusPAJson = JSON.stringify(transcript.statusPA).replace(/"/g, '&quot;');
    badges.push(`<div class="transcript-card-badge statuspa clickable" title="Klicken um PA-JSON zu kopieren" data-statuspa="${statusPAJson}">PA</div>`);
  }

  const badgesHtml = badges.length > 0
    ? `<div class="transcript-card-badges">${badges.join('')}</div>`
    : '';

  card.innerHTML = `
    <div class="transcript-card-header">
      <div>
        <div class="transcript-card-date">${dateStr}, ${timeStr}</div>
        <div class="transcript-card-speakers">${speakers}</div>
      </div>
      ${badgesHtml}
    </div>
    <div class="transcript-card-summary">${summaryPreview}</div>
  `;

  card.addEventListener('click', () => openTranscriptModal(transcript.filePath));

  // Add click handlers for status badges (prevent opening modal)
  const status01Badge = card.querySelector('.transcript-card-badge.status01');
  if (status01Badge) {
    status01Badge.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't open transcript modal
      const status01Str = status01Badge.dataset.status01;
      if (status01Str) {
        try {
          const status01 = JSON.parse(status01Str);
          ipcRenderer.send('open-tooth-chart', { status01 });
        } catch (err) {
          console.error('Failed to parse status01:', err);
        }
      }
    });
  }

  const statusPABadge = card.querySelector('.transcript-card-badge.statuspa');
  if (statusPABadge) {
    statusPABadge.addEventListener('click', async (e) => {
      e.stopPropagation(); // Don't open transcript modal
      const statusPAStr = statusPABadge.dataset.statuspa;
      if (statusPAStr) {
        try {
          const statusPA = JSON.parse(statusPAStr);
          const jsonStr = JSON.stringify(statusPA, null, 2);
          await ipcRenderer.invoke('copy-to-clipboard', jsonStr);
          // Show brief feedback
          const originalText = statusPABadge.textContent;
          statusPABadge.textContent = '✓';
          setTimeout(() => {
            statusPABadge.textContent = originalText;
          }, 1500);
        } catch (err) {
          console.error('Failed to copy PA status:', err);
        }
      }
    });
  }

  return card;
}

// Filter transcripts by search query
function filterTranscripts(query) {
  if (!query.trim()) {
    renderTranscriptsList(allTranscripts);
    document.getElementById('transcriptCount').textContent = allTranscripts.length;
    return;
  }

  const lowerQuery = query.toLowerCase();
  const filtered = allTranscripts.filter(t => {
    const date = new Date(t.createdAt);
    const dateStr = date.toLocaleDateString('de-DE');
    const timeStr = date.toLocaleTimeString('de-DE');
    const speakers = t.speakers?.join(' ') || '';
    const folder = t.folderName || '';

    return dateStr.includes(lowerQuery) ||
           timeStr.includes(lowerQuery) ||
           speakers.toLowerCase().includes(lowerQuery) ||
           folder.toLowerCase().includes(lowerQuery);
  });

  renderTranscriptsList(filtered);
  document.getElementById('transcriptCount').textContent = filtered.length;
}

// Open transcript detail modal
async function openTranscriptModal(filePath) {
  try {
    const result = await ipcRenderer.invoke('get-transcript-detail', filePath);
    if (!result.success) {
      console.error('Failed to load transcript:', result.error);
      return;
    }

    currentTranscriptData = result.transcript;
    const transcript = result.transcript;

    // Set modal title
    const date = new Date(transcript.createdAt);
    const dateStr = date.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit'
    });
    document.getElementById('transcriptModalTitle').textContent = `${dateStr}, ${timeStr}`;

    // Set summary with clickable passage links (if available)
    const summaryEl = document.getElementById('transcriptSummary');
    if (transcript.docLinks && transcript.docLinks.length > 0 && transcript.audioPath) {
      // Render with clickable links to audio passages
      summaryEl.innerHTML = renderDocumentationWithPassageLinks(
        transcript.summary || 'Keine Zusammenfassung verfuegbar',
        transcript.docLinks
      );
      // Attach click handlers for the links
      attachPassageLinkHandlers(summaryEl);
    } else {
      // No links, just plain text
      summaryEl.textContent = transcript.summary || 'Keine Zusammenfassung verfuegbar';
    }

    // Render topic tags if available
    renderTopicTags(transcript.topicSegments);

    // Render utterances (with word-level timestamps if available)
    renderUtterances(transcript.utterances, transcript.words);

    // Setup audio player if audio exists
    // Prefer speechOnlyPath (VAD-processed) because timestamps match this version
    const audioToPlay = transcript.speechOnlyPath || transcript.audioPath;
    if (audioToPlay) {
      console.log('[Transcript] Loading audio from:', audioToPlay, transcript.speechOnlyPath ? '(speech_only)' : '(original)');
      await setupAudioPlayer(audioToPlay);
      document.getElementById('transcriptAudioPlayer').style.display = 'flex';
    } else {
      console.log('[Transcript] No audio file found for this transcript');
      document.getElementById('transcriptAudioPlayer').style.display = 'none';
      // Hide topic section if no audio (topics are useless without audio)
      document.getElementById('topicSection').style.display = 'none';
    }

    // Setup Befund section (status01 / statusPA)
    setupBefundSection(transcript.status01, transcript.statusPA);

    // Show modal
    document.getElementById('transcriptModal').style.display = 'flex';

  } catch (error) {
    console.error('Error opening transcript modal:', error);
  }
}

// Close transcript modal
function closeTranscriptModal() {
  document.getElementById('transcriptModal').style.display = 'none';
  // Stop audio if playing
  const audio = document.getElementById('transcriptAudio');
  if (audio) {
    audio.pause();
    audio.src = '';
  }
  // Hide topic popup and reset state
  closeTopicPopup();
  currentTranscriptData = null;
  currentTopicSegments = null;
}

// Setup Befund section in transcript modal
function setupBefundSection(status01, statusPA) {
  const section = document.getElementById('transcriptBefundSection');
  const show01Btn = document.getElementById('transcriptShow01Status');
  const copy01Btn = document.getElementById('transcriptCopy01Json');
  const copyPABtn = document.getElementById('transcriptCopyPAJson');

  // Hide all initially
  section.style.display = 'none';
  show01Btn.style.display = 'none';
  copy01Btn.style.display = 'none';
  copyPABtn.style.display = 'none';

  const hasStatus01 = status01 && typeof status01 === 'object';
  const hasStatusPA = statusPA && typeof statusPA === 'object';

  if (!hasStatus01 && !hasStatusPA) {
    return; // Nothing to show
  }

  // Show section
  section.style.display = 'block';

  // Setup 01-Status buttons
  if (hasStatus01) {
    show01Btn.style.display = 'inline-flex';
    copy01Btn.style.display = 'inline-flex';

    // Store status01 for button handlers
    show01Btn.dataset.status01 = JSON.stringify(status01);
    copy01Btn.dataset.status01 = JSON.stringify(status01);
  }

  // Setup PA-Status button
  if (hasStatusPA) {
    copyPABtn.style.display = 'inline-flex';
    copyPABtn.dataset.statusPA = JSON.stringify(statusPA);
  }
}

// Initialize Befund section button handlers
function initBefundSectionHandlers() {
  // Show 01-Status in Tooth Chart
  document.getElementById('transcriptShow01Status')?.addEventListener('click', function() {
    const status01Str = this.dataset.status01;
    if (status01Str) {
      try {
        const status01 = JSON.parse(status01Str);
        ipcRenderer.send('open-tooth-chart', { status01 });
      } catch (e) {
        console.error('Failed to parse status01:', e);
      }
    }
  });

  // Copy 01-JSON
  document.getElementById('transcriptCopy01Json')?.addEventListener('click', async function() {
    const status01Str = this.dataset.status01;
    if (status01Str) {
      try {
        const status01 = JSON.parse(status01Str);
        const jsonStr = JSON.stringify(status01, null, 2);
        await ipcRenderer.invoke('copy-to-clipboard', jsonStr);
        this.querySelector('span').textContent = 'Kopiert!';
        setTimeout(() => {
          this.querySelector('span').textContent = '01-JSON kopieren';
        }, 2000);
      } catch (e) {
        console.error('Failed to copy status01:', e);
      }
    }
  });

  // Copy PA-JSON
  document.getElementById('transcriptCopyPAJson')?.addEventListener('click', async function() {
    const statusPAStr = this.dataset.statusPA;
    if (statusPAStr) {
      try {
        const statusPA = JSON.parse(statusPAStr);
        const jsonStr = JSON.stringify(statusPA, null, 2);
        await ipcRenderer.invoke('copy-to-clipboard', jsonStr);
        this.querySelector('span').textContent = 'Kopiert!';
        setTimeout(() => {
          this.querySelector('span').textContent = 'PA-JSON kopieren';
        }, 2000);
      } catch (e) {
        console.error('Failed to copy statusPA:', e);
      }
    }
  });
}

// Format milliseconds to mm:ss
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Render utterances in modal (with optional word-level timestamps)
function renderUtterances(utterances, words = null) {
  const container = document.getElementById('transcriptUtterances');
  container.innerHTML = '';

  if (!utterances || utterances.length === 0) {
    container.innerHTML = '<p class="text-muted">Keine Utterances verfügbar</p>';
    return;
  }

  // Build word lookup map if words are available
  // Map: wordText_startMs -> { start, end, text }
  const wordMap = new Map();
  if (words && words.length > 0) {
    words.forEach(w => {
      // Key by start time for lookup
      wordMap.set(w.start, w);
    });
  }

  utterances.forEach((utterance, index) => {
    const div = document.createElement('div');
    div.className = 'utterance';
    div.dataset.index = index;
    div.dataset.startMs = utterance.start;

    const timeStr = formatTime(utterance.start);

    // If we have words, render text with clickable words
    let textHtml = utterance.text;
    if (words && words.length > 0) {
      // Find words that belong to this utterance (between start and end)
      const utteranceWords = words.filter(w =>
        w.start >= utterance.start && w.end <= utterance.end
      );

      if (utteranceWords.length > 0) {
        // Render each word as clickable span
        textHtml = utteranceWords.map(w =>
          `<span class="clickable-word" data-start="${w.start}" title="[${formatTime(w.start)}]">${w.text}</span>`
        ).join(' ');
      }
    }

    div.innerHTML = `
      <div class="utterance-header">
        <span class="utterance-time" data-time-ms="${utterance.start}">[${timeStr}]</span>
        <span class="utterance-speaker">${utterance.speaker || 'Sprecher'}</span>
      </div>
      <div class="utterance-text">${textHtml}</div>
    `;

    // Click on time to jump to audio position
    const timeEl = div.querySelector('.utterance-time');
    timeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToTime(utterance.start);
    });

    // Click on words to jump to their position
    div.querySelectorAll('.clickable-word').forEach(wordEl => {
      wordEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const startMs = parseInt(wordEl.dataset.start);
        jumpToTime(startMs);
      });
    });

    container.appendChild(div);
  });
}

// Setup audio player
async function setupAudioPlayer(audioPath) {
  const audio = document.getElementById('transcriptAudio');
  const playBtn = document.getElementById('audioPlayBtn');
  const progressBar = document.getElementById('audioProgressBar');
  const progress = document.getElementById('audioProgress');
  const currentTimeEl = document.getElementById('audioCurrentTime');
  const durationEl = document.getElementById('audioDuration');

  // Load audio as base64
  const result = await ipcRenderer.invoke('get-transcript-audio', audioPath);
  if (!result.success) {
    console.error('Failed to load audio:', result.error);
    return;
  }

  audio.src = `data:${result.mimeType};base64,${result.data}`;

  // Play/Pause button
  playBtn.onclick = () => {
    if (audio.paused) {
      audio.play();
      playBtn.classList.add('playing');
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>`;
    } else {
      audio.pause();
      playBtn.classList.remove('playing');
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>`;
    }
  };

  // Update progress bar
  audio.ontimeupdate = () => {
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      progressBar.style.width = `${percent}%`;
      currentTimeEl.textContent = formatTime(audio.currentTime * 1000);
    }
  };

  // Update duration when loaded
  audio.onloadedmetadata = () => {
    durationEl.textContent = formatTime(audio.duration * 1000);
  };

  // Reset when audio ends
  audio.onended = () => {
    playBtn.classList.remove('playing');
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>`;
  };

  // Click on progress bar to seek
  progress.onclick = (e) => {
    const rect = progress.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audio.currentTime = percent * audio.duration;
  };
}

// Jump to specific time in audio
function jumpToTime(ms) {
  const audio = document.getElementById('transcriptAudio');
  if (audio && audio.src) {
    audio.currentTime = ms / 1000;
    if (audio.paused) {
      audio.play();
      const playBtn = document.getElementById('audioPlayBtn');
      playBtn.classList.add('playing');
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>`;
    }
  }
}

// ===== Topic Tags Functions =====

// Store topic segments for popup access
let currentTopicSegments = null;

// Render topic tags from extracted segments
function renderTopicTags(topicSegments) {
  const section = document.getElementById('topicSection');
  const container = document.getElementById('topicTags');

  if (!topicSegments || topicSegments.length === 0) {
    section.style.display = 'none';
    return;
  }

  currentTopicSegments = topicSegments;
  section.style.display = 'block';
  container.innerHTML = '';

  // Group segments by name
  const groupedTopics = {};
  topicSegments.forEach(segment => {
    const key = segment.name;
    if (!groupedTopics[key]) {
      groupedTopics[key] = {
        name: segment.name,
        type: segment.type,
        segments: []
      };
    }
    groupedTopics[key].segments.push(segment);
  });

  // Create tags for each topic
  Object.values(groupedTopics).forEach(topic => {
    const tag = document.createElement('div');
    tag.className = 'topic-tag';
    tag.dataset.type = topic.type;
    tag.dataset.name = topic.name;

    const count = topic.segments.length;
    tag.innerHTML = `
      <span class="topic-name">${topic.name}</span>
      ${count > 1 ? `<span class="topic-count">${count}x</span>` : ''}
    `;

    tag.addEventListener('click', () => {
      showTopicPopup(topic.name, topic.segments);
    });

    container.appendChild(tag);
  });
}

// Show popup with all segments for a topic
function showTopicPopup(topicName, segments) {
  const popup = document.getElementById('topicPopup');
  const title = document.getElementById('topicPopupTitle');
  const segmentsContainer = document.getElementById('topicPopupSegments');

  title.textContent = `${topicName} - ${segments.length} ${segments.length === 1 ? 'Stelle' : 'Stellen'}`;
  segmentsContainer.innerHTML = '';

  segments.forEach((segment, index) => {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'topic-segment';
    segmentEl.dataset.startMs = segment.startMs;
    segmentEl.dataset.endMs = segment.endMs;

    const startTime = formatTime(segment.startMs);
    const endTime = formatTime(segment.endMs);

    segmentEl.innerHTML = `
      <div class="topic-segment-play">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="topic-segment-info">
        <div class="topic-segment-time">[${startTime} - ${endTime}]</div>
        <div class="topic-segment-summary">${segment.summary || 'Klicken zum Anhoeren'}</div>
      </div>
    `;

    segmentEl.addEventListener('click', () => {
      playSegment(segment.startMs, segment.endMs);
    });

    segmentsContainer.appendChild(segmentEl);
  });

  popup.style.display = 'flex';
}

// Close topic popup
function closeTopicPopup() {
  document.getElementById('topicPopup').style.display = 'none';
}

// ===== Clickable Documentation Terms =====
// Render documentation/summary with clickable terms that link to audio

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * NEUER PASSAGEN-BASIERTER ANSATZ
 *
 * Render documentation text with clickable passage links.
 * Each link connects documentation text to semantic audio passages (15-40 sec clips).
 *
 * @param {string} documentation - The documentation text
 * @param {Array} docLinks - Array of doc links: { docText, positions, passages }
 * @returns {string} HTML with clickable spans for passage links
 */
function renderDocumentationWithPassageLinks(documentation, docLinks) {
  if (!docLinks || docLinks.length === 0 || !documentation) {
    return escapeHtml(documentation || '');
  }

  // Collect all positions with their passage data
  const allPositions = [];
  docLinks.forEach(link => {
    if (!link.positions || !link.passages || link.passages.length === 0) return;
    link.positions.forEach(pos => {
      // Validate position is within bounds
      if (pos.start >= 0 && pos.end <= documentation.length && pos.start < pos.end) {
        allPositions.push({
          start: pos.start,
          end: pos.end,
          docText: link.docText,
          passages: link.passages
        });
      }
    });
  });

  // Sort by start position (ascending) to process in order
  allPositions.sort((a, b) => a.start - b.start);

  // Remove overlapping positions (keep first occurrence)
  const nonOverlapping = [];
  let lastEnd = 0;
  allPositions.forEach(pos => {
    if (pos.start >= lastEnd) {
      nonOverlapping.push(pos);
      lastEnd = pos.end;
    }
  });

  // Build result string by replacing positions with clickable spans
  let result = '';
  let currentIndex = 0;

  nonOverlapping.forEach(pos => {
    // Add text before this position (escaped)
    if (pos.start > currentIndex) {
      result += escapeHtml(documentation.slice(currentIndex, pos.start));
    }

    // Add the linked text as a clickable span
    const linkText = documentation.slice(pos.start, pos.end);
    const passagesJson = JSON.stringify(pos.passages).replace(/"/g, '&quot;');
    // Determine type from first passage's topic for styling
    const topic = pos.passages[0]?.topic || 'Sonstiges';
    result += `<span class="doc-audio-link" data-topic="${topic}" data-text="${escapeHtml(pos.docText)}" data-passages="${passagesJson}">${escapeHtml(linkText)}</span>`;

    currentIndex = pos.end;
  });

  // Add remaining text (escaped)
  if (currentIndex < documentation.length) {
    result += escapeHtml(documentation.slice(currentIndex));
  }

  // Convert newlines to <br> for proper display
  result = result.replace(/\n/g, '<br>');

  return result;
}

/**
 * Show popup for a clicked documentation link with its audio passages.
 * Each passage is a semantic audio clip (15-40 seconds) about a specific topic.
 */
function showPassagePopup(linkText, passages, clickEvent) {
  const popup = document.getElementById('topicPopup');
  const title = document.getElementById('topicPopupTitle');
  const segmentsContainer = document.getElementById('topicPopupSegments');

  title.textContent = `"${linkText}" - ${passages.length} ${passages.length === 1 ? 'Audio-Passage' : 'Audio-Passagen'}`;
  segmentsContainer.innerHTML = '';

  passages.forEach((passage, index) => {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'topic-segment';
    segmentEl.dataset.startMs = passage.startMs;
    segmentEl.dataset.endMs = passage.endMs;

    const startTime = formatTime(passage.startMs);
    const endTime = formatTime(passage.endMs);
    const durationSec = Math.round((passage.endMs - passage.startMs) / 1000);

    segmentEl.innerHTML = `
      <div class="topic-segment-play">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="topic-segment-info">
        <div class="topic-segment-time">[${startTime} - ${endTime}] (${durationSec}s)</div>
        <div class="topic-segment-topic">${passage.topic || 'Sonstiges'}</div>
        <div class="topic-segment-summary">${passage.summary || passage.text?.substring(0, 100) + '...' || 'Klicken zum Anhoeren'}</div>
      </div>
    `;

    segmentEl.addEventListener('click', () => {
      playSegment(passage.startMs, passage.endMs);
    });

    segmentsContainer.appendChild(segmentEl);
  });

  popup.style.display = 'flex';
}

/**
 * Attach click handlers to passage links in documentation
 */
function attachPassageLinkHandlers(container) {
  container.querySelectorAll('.doc-audio-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = link.dataset.text;
      const passagesJson = link.dataset.passages;
      try {
        const passages = JSON.parse(passagesJson);
        if (passages && passages.length > 0) {
          showPassagePopup(text, passages, e);
        }
      } catch (err) {
        console.error('Failed to parse passages JSON:', err);
      }
    });
  });
}

// Legacy functions for backwards compatibility
function renderDocumentationWithLinks(documentation, linkedTerms) {
  return renderDocumentationWithPassageLinks(documentation, linkedTerms);
}

function showDocTermPopup(termName, segments, clickEvent) {
  // Convert old segment format to passage format
  const passages = segments.map(seg => ({
    id: 'legacy',
    topic: 'Sonstiges',
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.preview || '',
    summary: seg.preview || ''
  }));
  showPassagePopup(termName, passages, clickEvent);
}

function attachDocLinkHandlers(container) {
  attachPassageLinkHandlers(container);
}

// Play a specific audio segment
function playSegment(startMs, endMs) {
  const audio = document.getElementById('transcriptAudio');
  if (!audio || !audio.src) return;

  // Jump to start time
  audio.currentTime = startMs / 1000;

  // Start playing
  audio.play();
  const playBtn = document.getElementById('audioPlayBtn');
  playBtn.classList.add('playing');
  playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16"/>
    <rect x="14" y="4" width="4" height="16"/>
  </svg>`;

  // Optional: Auto-stop at end of segment
  // Uncomment if you want audio to stop at endMs
  /*
  const checkEnd = setInterval(() => {
    if (audio.currentTime >= endMs / 1000) {
      audio.pause();
      playBtn.classList.remove('playing');
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>`;
      clearInterval(checkEnd);
    }
  }, 100);
  */

  // Close popup after starting playback
  closeTopicPopup();
}

// Event listeners for topic popup
document.getElementById('topicPopupClose')?.addEventListener('click', closeTopicPopup);

// Close popup when clicking outside
document.getElementById('topicPopup')?.addEventListener('click', (e) => {
  if (e.target.id === 'topicPopup') {
    closeTopicPopup();
  }
});

// Event listeners for transcript view
document.getElementById('transcriptSearch')?.addEventListener('input', (e) => {
  filterTranscripts(e.target.value);
});

// Date filter chips
document.querySelectorAll('.date-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    setDateFilter(chip.dataset.filter);
  });
});

// Date range picker buttons
document.getElementById('dateRangeClose')?.addEventListener('click', closeDateRangePicker);
document.getElementById('dateRangeClear')?.addEventListener('click', clearDateRange);
document.getElementById('dateRangeApply')?.addEventListener('click', applyDateRange);

// Close date picker when clicking outside
document.addEventListener('click', (e) => {
  const picker = document.getElementById('dateRangePicker');
  const customBtn = document.getElementById('customDateBtn');
  if (picker?.style.display === 'block' && !picker.contains(e.target) && !customBtn?.contains(e.target)) {
    closeDateRangePicker();
  }
});

document.getElementById('transcriptModalClose')?.addEventListener('click', closeTranscriptModal);

document.getElementById('transcriptModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'transcriptModal') {
    closeTranscriptModal();
  }
});

// Load transcripts when view becomes active
const navTranscripts = document.getElementById('nav-transcripts');
if (navTranscripts) {
  navTranscripts.addEventListener('click', () => {
    loadTranscripts();
  });
}

