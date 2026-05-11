/**
 * DentDoc Dashboard
 * Main JavaScript for the integrated dashboard interface
 * Includes: Home, Settings, and Voice Profiles views
 */

const { ipcRenderer } = require('electron');
// Shared audio utilities - see src/scripts/audio-utils.js for:
// - AudioMonitor, MicTester, loadMicrophones, getSelectedMicrophone
// - isMicrophoneMatch, isMicrophoneAvailable (mic matching with vendor:product ID)
const audioUtils = require('./scripts/audio-utils');
const transcriptModal = require('./scripts/transcript-modal');

// ===== View Navigation =====
const navItems = document.querySelectorAll('.nav-item[data-view]');
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
    case 'format':
      loadFormatView();
      break;
    case 'subscription':
      loadSubscriptionView();
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

    // Load upgrade banner for trial/free users
    await loadUpgradeBanner();

    // Load iPhone dashboard section if iPhone is selected
    await loadIphoneDashboardSection(shortcut || 'F9');

    // Load last documentation
    await loadLastDocumentation();
  } catch (error) {
    console.error('Error loading home stats:', error);
  }
}

// ===== Onboarding Tutorial Card =====
let onboardingDismissedThisSession = false;

async function loadOnboardingCard(shortcut) {
  if (onboardingDismissedThisSession) return;
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
  onboardingDismissedThisSession = true;

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
  await loadSubscriptionStatus();
  await loadActiveRecordingsBadge();
  await loadUpgradeTopBar();
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

  // Refresh active recordings badge (with small delay to let claim resolve)
  setTimeout(() => loadActiveRecordingsBadge(), 1000);

  if (options?.vadMode) {
    // VAD mode: VAD sends audio levels directly via notifyRenderer — no F9 monitoring needed
    // (F9 getUserMedia often gets wrong device or near-zero levels, flooding the overlay with zeros)
    console.log('[VAD] VAD mode - starting VAD integration (VAD handles audio levels)...');
    startVADIntegration(options?.microphoneId).catch(err => {
      console.error('[VAD] startVADIntegration error:', err);
    });
  } else {
    // Non-VAD mode: use F9 audio monitoring as fallback for status bar levels
    await startF9AudioMonitoring(options?.microphoneId);
  }
});

ipcRenderer.on('recording-stopped', () => {
  // Refresh active recordings badge
  setTimeout(() => loadActiveRecordingsBadge(), 500);

  // Always stop F9 audio monitoring (always started now)
  console.log('[F9] Stopping F9 audio monitoring...');
  stopF9AudioMonitoring();

  // Also stop VAD if it's active
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
  await loadActiveRecordingsBadge();
  await loadUpgradeTopBar();
  await loadUpgradeBanner();
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
    await ipcRenderer.invoke('copy-to-clipboard', lastDocData.documentation);
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

// ===== Active Recordings Badge =====
async function loadActiveRecordingsBadge() {
  try {
    const data = await ipcRenderer.invoke('get-active-recordings');
    const badge = document.getElementById('activeRecordingsBadge');
    const text = document.getElementById('activeRecordingsText');

    if (data.maxRecordings > 0) {
      badge.style.display = 'flex';
      const count = data.activeRecordings || 0;
      text.textContent = `${count}/${data.maxRecordings} Aufnahmen aktiv`;

      if (count > 0) {
        badge.classList.remove('no-active');
      } else {
        badge.classList.add('no-active');
      }
    } else {
      badge.style.display = 'none';
    }
  } catch (error) {
    console.error('Error loading active recordings:', error);
  }
}

loadActiveRecordingsBadge();

// ===== Upgrade Top Bar (all views) =====
async function loadUpgradeTopBar() {
  try {
    const status = await ipcRenderer.invoke('get-subscription-status');
    const topBar = document.getElementById('upgradeTopBar');
    if (!topBar) return;

    // Hide for active paid subscribers
    if (status.type === 'success') {
      topBar.style.display = 'none';
      return;
    }

    topBar.style.display = 'block';
    topBar.classList.remove('upgrade-top-bar-expired', 'upgrade-top-bar-inactive');

    const textEl = document.getElementById('upgradeTopBarText');
    const linkEl = document.getElementById('upgradeTopBarLink');

    if (status.type === 'trial') {
      textEl.textContent = status.label.replace('Testphase:', 'Testphase:').replace('Min', 'Min verbleibend');
      linkEl.textContent = 'Jetzt upgraden \u2192';
    } else {
      const isExpiredTrial = status.label.includes('TESTPHASE') || status.label.includes('Testphase beendet');
      if (isExpiredTrial) {
        topBar.classList.add('upgrade-top-bar-expired');
        textEl.textContent = 'Ihre kostenlosen Testminuten sind aufgebraucht';
        linkEl.textContent = 'Jetzt Abo aktivieren \u2192';
      } else {
        topBar.classList.add('upgrade-top-bar-inactive');
        textEl.textContent = 'Kein aktives Abonnement';
        linkEl.textContent = 'Jetzt abonnieren \u2192';
      }
    }
  } catch (error) {
    console.error('Error loading upgrade top bar:', error);
  }
}

// ===== Upgrade Banner Card (Übersicht) =====
async function loadUpgradeBanner() {
  try {
    const status = await ipcRenderer.invoke('get-subscription-status');
    const banner = document.getElementById('upgradeBanner');
    if (!banner) return;

    // Hide for active paid subscribers
    if (status.type === 'success') {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'block';
    banner.classList.remove('upgrade-expired', 'upgrade-inactive');

    const title = document.getElementById('upgradeBannerTitle');
    const subtitle = document.getElementById('upgradeBannerSubtitle');
    const progressSection = document.getElementById('upgradeBannerProgress');
    const progressFill = document.getElementById('upgradeBannerProgressFill');
    const progressText = document.getElementById('upgradeBannerProgressText');
    const btnText = document.getElementById('upgradeBannerBtnText');

    if (status.type === 'trial') {
      title.textContent = 'Testphase aktiv';
      subtitle.textContent = status.label;
      btnText.textContent = 'Jetzt DentDoc Pro holen';
      progressSection.style.display = 'block';

      const minutesMatch = status.label.match(/(\d+)/);
      const minutesRemaining = minutesMatch ? parseInt(minutesMatch[1]) : 0;
      const totalMinutes = 60;
      const usedMinutes = totalMinutes - minutesRemaining;
      const percentUsed = Math.min(100, (usedMinutes / totalMinutes) * 100);

      progressFill.style.width = percentUsed + '%';
      progressText.textContent = `${usedMinutes} / ${totalMinutes} Min verbraucht`;

      if (minutesRemaining <= 10) {
        progressFill.classList.add('urgent');
      } else {
        progressFill.classList.remove('urgent');
      }
    } else {
      progressSection.style.display = 'none';
      const isExpiredTrial = status.label.includes('TESTPHASE') || status.label.includes('Testphase beendet');

      if (isExpiredTrial) {
        banner.classList.add('upgrade-expired');
        title.textContent = 'Testphase beendet';
        subtitle.textContent = 'Ihre kostenlosen 60 Minuten sind aufgebraucht';
        btnText.textContent = 'Jetzt Abo aktivieren';
      } else {
        banner.classList.add('upgrade-inactive');
        title.textContent = 'Kein aktives Abonnement';
        subtitle.textContent = 'Ihr DentDoc Pro Abo ist nicht mehr aktiv';
        btnText.textContent = 'Abo reaktivieren';
      }
    }
  } catch (error) {
    console.error('Error loading upgrade banner:', error);
  }
}

// Upgrade top bar & banner click handlers
async function openSubscriptionPage() {
  const baseUrl = await ipcRenderer.invoke('get-base-url');
  await ipcRenderer.invoke('open-external-url', baseUrl + '/dashboard/subscription');
}

document.getElementById('upgradeTopBarLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  openSubscriptionPage();
});

document.getElementById('upgradeBannerBtn')?.addEventListener('click', () => {
  openSubscriptionPage();
});

// Load upgrade top bar on init (applies to all views)
loadUpgradeTopBar();

// ===== Sidebar Links =====
async function initSidebarLinks() {
  const baseUrl = await ipcRenderer.invoke('get-base-url');
  const websiteUrl = await ipcRenderer.invoke('get-website-url');

  document.getElementById('linkWebsite').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', websiteUrl);
  });

  document.getElementById('linkDatenschutz').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', websiteUrl + '/datenschutz');
  });

  document.getElementById('linkImpressum').addEventListener('click', async (e) => {
    e.preventDefault();
    await ipcRenderer.invoke('open-external-url', websiteUrl + '/impressum');
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

document.getElementById('maximizeBtn').addEventListener('click', () => {
  ipcRenderer.send('maximize-window');
});

document.getElementById('closeBtn').addEventListener('click', () => {
  ipcRenderer.send('minimize-to-tray');
});


// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  loadHomeStats();
  loadAppVersion();
  initUpdateButton();
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
async function autoSaveSetting(settingsPartial) {
  try {
    await ipcRenderer.invoke('save-settings', settingsPartial);
  } catch (error) {
    console.error('Auto-save failed:', error);
    throw error;
  }
}

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
  document.getElementById('settingsAutoCloseCheckbox').checked = settings.autoClose || false;
  document.getElementById('settingsAutoExportCheckbox').checked = settings.autoExport || false;
  document.getElementById('settingsVadEnabled').checked = true; // VAD always enabled

  // iPhone microphone settings
  const microphoneSource = settings.microphoneSource || 'desktop';
  document.getElementById('settingsMicSourceDesktop').checked = microphoneSource === 'desktop';
  document.getElementById('settingsMicSourceIphone').checked = microphoneSource === 'iphone';
  await loadIphonePairingStatus(settings);
  updateMicSourceUI(microphoneSource);

  // DISABLED: Theme toggle - dark mode is now default
  // const theme = settings.theme || 'dark';
  // document.getElementById('settingsThemeSelect').value = theme;

  await loadSettingsMicrophones();
  loadMicVolume();

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
// Uses audioUtils.isMicrophoneAvailable() for smart matching (handles USB renumbering)
// See: src/scripts/audio-utils.js - isMicrophoneMatch(), isMicrophoneAvailable()
let deviceChangeDebounce = null;
let selectedMicWasAvailable = null; // Track if SELECTED mic was available

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
        // Use shared utility function for mic availability check
        const selectedMicAvailable = await audioUtils.isMicrophoneAvailable(selectedMicName);

        console.log(`[DeviceChange] Selected mic "${selectedMicName}" available: ${selectedMicAvailable} (was: ${selectedMicWasAvailable})`);

        // Notify only when selected mic status changes
        if (selectedMicWasAvailable !== null && selectedMicWasAvailable !== selectedMicAvailable) {
          if (selectedMicAvailable) {
            console.log('[DeviceChange] Selected microphone reconnected!');
            ipcRenderer.invoke('show-notification', 'Mikrofon verbunden', selectedMicName);

            // Hide mic error card in profiles view if it's visible
            profilesHideMicError();
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
      await loadSettingsMicrophones();
      loadMicVolume();
    }
  }, 500);
});

// Initialize selected mic status on load
(async () => {
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    const selectedMicName = settings?.microphoneName;
    if (selectedMicName) {
      selectedMicWasAvailable = await audioUtils.isMicrophoneAvailable(selectedMicName);
      console.log(`[DeviceChange] Initial selected mic "${selectedMicName}" available: ${selectedMicWasAvailable}`);
    }
  } catch (e) {
    console.warn('[DeviceChange] Could not get initial mic status:', e.message);
  }
})();


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
    const micUrl = 'https://dentdoc.de/mic';

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
    const micUrl = 'https://dentdoc.de/mic';

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

        // Auto-save mic source
        autoSaveSetting({ microphoneSource: 'iphone' });
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

    autoSaveSetting({ microphoneSource: 'desktop' });
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

  // Refresh volume slider for the newly selected mic
  loadMicVolume();

  // Hide "mic not found" warning when user selects a new mic
  const micNotFoundWarning = document.getElementById('settingsMicNotFoundWarning');
  if (micNotFoundWarning) {
    micNotFoundWarning.style.display = 'none';
  }

  // Also hide profiles mic error if user selects a different mic
  profilesHideMicError();

  if (settingsMicTester.isRunning) {
    settingsMicTester.stop();
    settingsStopMicTest();
  }
  autoSaveSetting({ microphoneId: settingsSelectedMicId, microphoneName: settingsSelectedMicName });
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

  const shortcutStatus = document.getElementById('settingsShortcutStatus');
  try {
    await autoSaveSetting({ shortcut: settingsNewShortcut });
    settingsShowStatus(shortcutStatus, `Neue Tastenkombination: ${settingsNewShortcut}`, 'success');
  } catch (error) {
    const settings = await ipcRenderer.invoke('get-settings');
    document.getElementById('settingsShortcutDisplay').textContent = settings.shortcut || 'F9';
    settingsNewShortcut = null;
    settingsShowStatus(shortcutStatus, error.message, 'error');
  }
});

// Settings Path Buttons

// Helper function to show folder validation error inline
function showFolderValidationError(inputId, errorMessage) {
  const input = document.getElementById(inputId);
  if (!input) return;

  // Remove any existing error
  clearFolderValidationError(inputId);

  // Create error element
  const errorEl = document.createElement('div');
  errorEl.id = inputId + 'Error';
  errorEl.className = 'path-validation-error';
  errorEl.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
    <span>${errorMessage}</span>
  `;

  // Insert after the input's parent row
  const parentRow = input.closest('.path-input-row') || input.parentElement;
  parentRow.insertAdjacentElement('afterend', errorEl);

  // Add error styling to input
  input.classList.add('input-error');
}

// Helper function to clear folder validation error
function clearFolderValidationError(inputId) {
  const input = document.getElementById(inputId);
  const errorEl = document.getElementById(inputId + 'Error');

  if (errorEl) {
    errorEl.remove();
  }
  if (input) {
    input.classList.remove('input-error');
  }
}

document.getElementById('settingsOpenSoundBtn').addEventListener('click', async () => {
  await ipcRenderer.invoke('open-sound-settings');
  // Refresh mic volume after returning from Windows Sound Settings
  loadMicVolume();
});

// ===== Mic Volume Slider =====

async function loadMicVolume() {
  const container = document.getElementById('micVolumeContainer');
  const slider = document.getElementById('micVolumeSlider');
  const valueDisplay = document.getElementById('micVolumeValue');
  if (!container || !slider || !valueDisplay) return;

  // Don't show volume if no mic is selected/connected
  const micSelect = document.getElementById('settingsMicSelect');
  if (!micSelect || !micSelect.value) {
    container.style.display = 'none';
    return;
  }

  try {
    // Pass currently selected mic name so it targets the right device
    const result = await ipcRenderer.invoke('get-mic-volume', settingsSelectedMicName);
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
    console.error('[MicVolume] Failed to load:', err);
    container.style.display = 'none';
  }
}

// Debounce slider changes to avoid spamming PowerShell
let micVolumeTimeout = null;
document.getElementById('micVolumeSlider').addEventListener('input', (e) => {
  // Update display and filled track immediately for responsiveness
  document.getElementById('micVolumeValue').textContent = e.target.value + '%';
  e.target.style.setProperty('--fill', e.target.value + '%');

  // Debounce the actual system call
  if (micVolumeTimeout) clearTimeout(micVolumeTimeout);
  micVolumeTimeout = setTimeout(async () => {
    try {
      await ipcRenderer.invoke('set-mic-volume', parseInt(e.target.value), settingsSelectedMicName);
    } catch (err) {
      console.error('[MicVolume] Failed to set:', err);
    }
  }, 150);
});

document.getElementById('settingsBrowseTranscriptBtn').addEventListener('click', async () => {
  console.log('Browse transcript folder clicked');
  const result = await ipcRenderer.invoke('select-folder-with-validation', {
    title: 'Transkript-Ordner auswählen'
  });
  console.log('select-folder-with-validation result:', result);

  if (result.canceled) {
    console.log('Dialog cancelled');
    return;
  }

  if (!result.success) {
    console.log('Folder validation failed:', result.validation?.error);
    showFolderValidationError('settingsTranscriptPath', result.validation?.error || 'Ordner nicht verwendbar');
    return;
  }

  // Success - clear any previous error and update the path
  clearFolderValidationError('settingsTranscriptPath');
  document.getElementById('settingsTranscriptPath').value = result.path;
  console.log('Set transcriptPath input to:', result.path);
  autoSaveSetting({ transcriptPath: result.path });
});

document.getElementById('settingsOpenTranscriptFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('settingsTranscriptPath').value;
  if (path) {
    await ipcRenderer.invoke('open-folder', path);
  }
});


// DISABLED: Theme toggle - dark mode is now default
// document.getElementById('settingsThemeSelect').addEventListener('change', async () => {
//   const theme = document.getElementById('settingsThemeSelect').value;
//   document.documentElement.setAttribute('data-theme', theme);
//   await ipcRenderer.invoke('set-theme', theme);
// });

// Settings change tracking
document.getElementById('settingsAutoExportCheckbox').addEventListener('change', (e) => {
  autoSaveSetting({ autoExport: e.target.checked });
});
document.getElementById('settingsAutoCloseCheckbox').addEventListener('change', (e) => {
  autoSaveSetting({ autoClose: e.target.checked });
});
document.getElementById('settingsVadEnabled').addEventListener('change', (e) => {
  autoSaveSetting({ vadEnabled: e.target.checked });
});

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
  await loadProfiles();
}

async function loadProfiles() {
  const profiles = await ipcRenderer.invoke('get-voice-profiles');
  const profileContainer = document.getElementById('profilesContainer');

  if (profiles.length === 0) {
    profileContainer.innerHTML = '<div class="empty-state-small">Keine Stimmprofile vorhanden</div>';
    return;
  }

  // Normalize old English role values to German
  const roleNormalize = { 'dentist': 'Arzt', 'assistant': 'ZFA', 'other': 'Sonstige' };

  const profilesByRole = {};
  for (const profile of profiles) {
    const role = roleNormalize[profile.role] || profile.role || 'Sonstige';
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
            <li class="profile-item" data-profile-id="${profile.id}">
              <div class="profile-info">
                <div class="profile-name" data-name="${profile.name}">${profile.name}</div>
                <div class="profile-date">${new Date(profile.createdAt).toLocaleDateString('de-DE')}</div>
              </div>
              <div class="profile-actions">
                <button class="btn-edit" data-profile-id="${profile.id}" title="Umbenennen">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="btn-delete" data-profile-id="${profile.id}" title="Löschen">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
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

  // Add edit (rename) handlers
  profileContainer.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.profileId;
      const item = btn.closest('.profile-item');
      const nameEl = item.querySelector('.profile-name');
      const currentName = nameEl.dataset.name;

      // Replace name with input field
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'profile-name-input';
      input.value = currentName;
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      // Save on Enter or blur
      const saveEdit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== currentName) {
          try {
            await ipcRenderer.invoke('rename-voice-profile', { id, newName });
            profilesShowStatus('Profil umbenannt', 'success');
            setTimeout(() => {
              document.getElementById('profilesStatusMessage').innerHTML = '';
            }, 3000);
          } catch (error) {
            profilesShowStatus('Fehler beim Umbenennen: ' + error.message, 'error');
          }
        }
        loadProfiles(); // Refresh list
      };

      let saved = false;
      input.addEventListener('blur', () => {
        if (!saved) {
          saved = true;
          saveEdit();
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saved = true;
          saveEdit();
        } else if (e.key === 'Escape') {
          saved = true;
          loadProfiles(); // Cancel - just refresh
        }
      });
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
  profilesStopAudioMonitoring(); // Clean up previous AudioContext if still open
  try {
    // Use selected microphone from settings (like setup wizard does)
    const settings = await ipcRenderer.invoke('get-settings');
    const micId = settings?.microphoneId;
    const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };
    console.log('[Profiles] Starting audio monitoring with mic:', micId || 'default');

    profilesMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
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

// ============================================================================
// Voice Profile Recording Overlay
// ============================================================================

// Overlay state
let profilesOverlayAudioContext = null;
let profilesOverlayAnalyser = null;
let profilesOverlayMediaStream = null;
let profilesOverlayAnimFrame = null;
let profilesPendingEnrollment = null; // Store name/role for when Start is clicked

/**
 * Show recording overlay in ready state (with Start button)
 */
async function profilesShowRecordingOverlay(name, role) {
  // Store enrollment data for when Start is clicked
  profilesPendingEnrollment = { name, role };

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
  await profilesStartOverlayMicMonitoring();
}

/**
 * Switch overlay to recording state and start actual recording
 */
async function profilesStartRecordingFromOverlay() {
  if (!profilesPendingEnrollment) return;

  const { name, role } = profilesPendingEnrollment;
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
    profilesIsRecording = true;

    // Start backend recording
    const result = await ipcRenderer.invoke('start-voice-enrollment', { name, role });

    // Check if start was cancelled (race condition with cancel button)
    if (result.cancelled) {
      profilesCloseRecordingOverlay();
      profilesIsRecording = false;
      profilesPendingEnrollment = null;
      return;
    }

    // Check if there was an error
    if (result.error) {
      throw new Error(result.error);
    }

    // Timer updates overlay progress
    let seconds = 0;
    profilesRecordingTimer = setInterval(() => {
      seconds++;
      profilesUpdateOverlayProgress(seconds, PROFILES_RECORDING_DURATION);

      if (seconds >= PROFILES_RECORDING_DURATION) {
        clearInterval(profilesRecordingTimer);
        profilesStopEnrollment();
      }
    }, 1000);

  } catch (error) {
    // Close overlay on error
    profilesCloseRecordingOverlay();

    // Check if it's a mic disconnected error
    if (error.message && error.message.includes('Mikrofon nicht verbunden')) {
      const deviceMatch = error.message.match(/: (.+)$/);
      const deviceName = deviceMatch ? deviceMatch[1] : null;
      profilesShowMicError(deviceName);
      profilesShowStatus('', '');
    } else {
      profilesShowStatus('Fehler beim Starten: ' + error.message, 'error');
    }

    profilesIsRecording = false;
    profilesPendingEnrollment = null;
  }
}

/**
 * Update progress display in overlay
 */
function profilesUpdateOverlayProgress(seconds, total) {
  const timeEl = document.getElementById('profilesOverlayTime');
  const progressEl = document.getElementById('profilesOverlayProgressFill');
  if (timeEl) timeEl.textContent = `${seconds}s / ${total}s`;
  if (progressEl) progressEl.style.width = `${(seconds / total) * 100}%`;
}

/**
 * Close recording overlay
 */
function profilesCloseRecordingOverlay() {
  const overlay = document.getElementById('profilesRecordingOverlay');
  if (overlay) overlay.style.display = 'none';
  profilesStopOverlayMicMonitoring();
  profilesPendingEnrollment = null;
}

/**
 * Start mic level monitoring for overlay
 */
async function profilesStartOverlayMicMonitoring() {
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    const micId = settings?.microphoneId;
    const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };

    profilesOverlayMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    profilesOverlayAudioContext = new AudioContext();
    profilesOverlayAnalyser = profilesOverlayAudioContext.createAnalyser();
    profilesOverlayAnalyser.fftSize = 256;

    const source = profilesOverlayAudioContext.createMediaStreamSource(profilesOverlayMediaStream);
    source.connect(profilesOverlayAnalyser);

    const bufferLength = profilesOverlayAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function updateLevel() {
      profilesOverlayAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const normalized = Math.min(average / 128 * 100, 100);
      const micBar = document.getElementById('profilesOverlayMicBar');
      if (micBar) micBar.style.width = normalized + '%';
      profilesOverlayAnimFrame = requestAnimationFrame(updateLevel);
    }

    updateLevel();
  } catch (error) {
    console.error('[Profiles Overlay] Audio monitoring error:', error);
  }
}

/**
 * Stop mic level monitoring for overlay
 */
function profilesStopOverlayMicMonitoring() {
  if (profilesOverlayAnimFrame) {
    cancelAnimationFrame(profilesOverlayAnimFrame);
    profilesOverlayAnimFrame = null;
  }
  if (profilesOverlayMediaStream) {
    profilesOverlayMediaStream.getTracks().forEach(track => track.stop());
    profilesOverlayMediaStream = null;
  }
  if (profilesOverlayAudioContext) {
    profilesOverlayAudioContext.close();
    profilesOverlayAudioContext = null;
  }
  const micBar = document.getElementById('profilesOverlayMicBar');
  if (micBar) micBar.style.width = '0%';
}

/**
 * Show mic error card with device name
 */
function profilesShowMicError(deviceName) {
  const errorCard = document.getElementById('profilesMicError');
  const deviceEl = document.getElementById('profilesMicErrorDevice');

  deviceEl.textContent = deviceName || 'Unbekanntes Gerät';
  errorCard.style.display = 'block';

  // Hide the start button when error is shown
  document.getElementById('profilesEnrollBtn').style.display = 'none';
  document.getElementById('profilesCancelBtn').style.display = 'none';
}

/**
 * Hide mic error card
 */
function profilesHideMicError() {
  const errorCard = document.getElementById('profilesMicError');
  if (errorCard) {
    errorCard.style.display = 'none';
  }
  document.getElementById('profilesEnrollBtn').style.display = 'block';
}

// Setup mic error settings link
document.getElementById('profilesMicErrorSettingsLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  profilesHideMicError();
  // Navigate to settings view
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  document.querySelector('[data-view="settings"]').classList.add('active');
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById('view-settings').classList.add('active');
});

// Setup overlay cancel button (handles both dashboard and wizard)
document.getElementById('profilesOverlayCancelBtn')?.addEventListener('click', async () => {
  // Check if wizard is recording
  if (window.setupWizard && window.setupWizard.profileRecordingState?.isRecording) {
    await window.setupWizard.cancelProfileRecording();
  } else {
    await profilesCancelEnrollment();
  }
});

// Setup overlay start button (handles both dashboard and wizard)
document.getElementById('profilesOverlayStartBtn')?.addEventListener('click', async () => {
  // Check if wizard is in overlay mode
  if (window.setupWizard && window.setupWizard.profilePendingEnrollment) {
    await window.setupWizard.startRecordingFromOverlay();
  } else {
    await profilesStartRecordingFromOverlay();
  }
});

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

  // Hide any previous mic error
  profilesHideMicError();

  // Show overlay in ready state (recording starts when Start button is clicked)
  await profilesShowRecordingOverlay(name, role);
}

async function profilesStopEnrollment() {
  if (profilesRecordingTimer) {
    clearInterval(profilesRecordingTimer);
    profilesRecordingTimer = null;
  }

  // Close the overlay
  profilesCloseRecordingOverlay();

  try {
    profilesShowStatus('⏳ Stimmprofil wird erstellt...', 'processing');

    await ipcRenderer.invoke('stop-voice-enrollment');

    profilesShowStatus('✅ Stimmprofil erfolgreich erstellt!', 'success');
    document.getElementById('profilesSpeakerName').value = '';
    document.getElementById('profilesSpeakerRole').value = '';
    loadProfiles();

    setTimeout(() => {
      document.getElementById('profilesStatusMessage').innerHTML = '';
    }, 3000);

  } catch (error) {
    profilesShowStatus('Fehler: ' + error.message, 'error');
  } finally {
    profilesIsRecording = false;
  }
}

async function profilesCancelEnrollment() {
  if (profilesRecordingTimer) {
    clearInterval(profilesRecordingTimer);
    profilesRecordingTimer = null;
  }

  // Close the overlay
  profilesCloseRecordingOverlay();

  try {
    await ipcRenderer.invoke('cancel-voice-enrollment');
  } catch (error) {
    console.error('Cancel error:', error);
  }

  profilesIsRecording = false;
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
        element: '#settings-section-appearance',
        popover: {
          title: 'Erscheinungsbild',
          description: 'Wählen Sie zwischen hellem und dunklem Design - ganz nach Ihrem Geschmack.',
          side: 'top',
          align: 'start'
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

    // Update license count
    document.getElementById('subscriptionDevices').textContent = `${data.maxDevices || 0}`;
    document.getElementById('deviceUsage').textContent = `${data.maxDevices || 0}`;

    // Load devices list
    renderDevicesList(data.devices || []);
  } catch (error) {
    console.error('Error loading subscription view:', error);
  }
}

function renderDevicesList(devices) {
  const container = document.getElementById('devicesList');

  if (!devices || devices.length === 0) {
    container.innerHTML = '<div class="devices-empty">Keine Geräte angemeldet</div>';
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

// Note: loadViewContent is defined once at the top of the file (line ~130)
// subscription was previously added here as a duplicate — now consolidated above

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
    const transcriptModalEl = document.getElementById('transcriptModal');
    if (transcriptModalEl?.style.display !== 'none') {
      transcriptModal.closeTranscriptModal();
    }
  }
});

// =============================================================================
// TRANSCRIPTS VIEW
// =============================================================================

let allTranscripts = [];
let filteredTranscripts = [];
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

  // Get speakers - just show the main one or combine
  const speakersArray = transcript.speakers?.length > 0
    ? transcript.speakers
    : [transcript.folderName || 'Unbekannt'];
  const speakersText = speakersArray.join(', ');

  // Duration string
  const durationMs = transcript.durationMs || transcript.duration;
  let durationStr = '';
  if (durationMs) {
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Summary - shorter for compact view
  const summaryPreview = transcript.summary
    ? transcript.summary.substring(0, 80) + (transcript.summary.length > 80 ? '...' : '')
    : '';

  // Status badges (01, PA)
  const badges = [];
  if (transcript.status01) {
    const status01Json = JSON.stringify(transcript.status01).replace(/"/g, '&quot;');
    badges.push(`<span class="card-badge" data-status01="${status01Json}" title="Zahnstatus">01</span>`);
  }
  if (transcript.statusPA) {
    const statusPAJson = JSON.stringify(transcript.statusPA).replace(/"/g, '&quot;');
    badges.push(`<span class="card-badge pa" data-statuspa="${statusPAJson}" title="PA-Status">PA</span>`);
  }
  const badgesHtml = badges.join('');

  // Status indicator
  const isProcessing = transcript.status === 'processing';

  card.innerHTML = `
    <div class="card-row card-row-main">
      <span class="card-date">${dateStr}</span>
      <span class="card-time">${timeStr}</span>
      ${durationStr ? `<span class="card-duration">${durationStr}</span>` : ''}
      ${badgesHtml}
      <span class="card-status ${isProcessing ? 'processing' : ''}"></span>
    </div>
    <div class="card-row card-row-speaker">${speakersText}</div>
    ${summaryPreview ? `<div class="card-row card-row-summary">${summaryPreview}</div>` : ''}
  `;

  card.addEventListener('click', () => transcriptModal.openTranscriptModal(transcript.filePath));

  // Add click handlers for status badges (prevent opening modal)
  const status01Badge = card.querySelector('.card-badge[data-status01]');
  if (status01Badge) {
    status01Badge.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        const status01 = JSON.parse(status01Badge.dataset.status01);
        ipcRenderer.send('open-tooth-chart', { status01 });
      } catch (err) {
        console.error('Failed to parse status01:', err);
      }
    });
  }

  const statusPABadge = card.querySelector('.card-badge[data-statuspa]');
  if (statusPABadge) {
    statusPABadge.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const statusPA = JSON.parse(statusPABadge.dataset.statuspa);
        await ipcRenderer.invoke('copy-to-clipboard', JSON.stringify(statusPA, null, 2));
        statusPABadge.textContent = '✓';
        setTimeout(() => { statusPABadge.textContent = 'PA'; }, 1500);
      } catch (err) {
        console.error('Failed to copy PA status:', err);
      }
    });
  }

  return card;
}


// Initialize transcript modal module (extracted to transcript-modal.js)
transcriptModal.initTranscriptModal();

// Load transcripts when view becomes active
const navTranscripts = document.getElementById('nav-transcripts');
if (navTranscripts) {
  navTranscripts.addEventListener('click', () => {
    loadTranscripts();
  });
}

// Initialize date filter chips
document.querySelectorAll('.date-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    setDateFilter(chip.dataset.filter);
  });
});

// ============================================
// Support Chat Modal
// ============================================

function openSupportModal() {
  const modal = document.getElementById('supportPanel');
  const btn = document.getElementById('supportBtn');
  const navBtn = document.getElementById('nav-livechat');
  const badge = document.getElementById('chatBadge');
  const fabBadge = document.getElementById('fabBadge');
  if (modal) {
    modal.classList.add('active');
    btn?.classList.add('active');
    btn?.classList.remove('has-message');
    navBtn?.classList.add('chat-open');
    // Reset badges when opening chat
    if (badge) {
      badge.style.display = 'none';
      badge.textContent = '0';
    }
    if (fabBadge) {
      fabBadge.style.display = 'none';
      fabBadge.textContent = '0';
    }
    unreadChatMessages = 0;

    // Maximize tawk chat to skip menu screen and scroll to top
    const webview = document.getElementById('tawkWebview');
    if (webview) {
      webview.executeJavaScript(`
        if (typeof Tawk_API !== 'undefined' && Tawk_API.maximize) {
          Tawk_API.maximize();
        }
        // Scroll the page to top so chat isn't scrolled down
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      `).catch(() => {}); // Ignore errors if Tawk not ready
    }
  }
}

function closeSupportModal() {
  const modal = document.getElementById('supportPanel');
  const btn = document.getElementById('supportBtn');
  const navBtn = document.getElementById('nav-livechat');
  if (modal?.classList.contains('active')) {
    modal.classList.remove('active');
    btn?.classList.remove('active');
    navBtn?.classList.remove('chat-open');
  }
}

// Track unread messages
let unreadChatMessages = 0;

function toggleSupportModal() {
  const modal = document.getElementById('supportPanel');
  if (modal?.classList.contains('active')) {
    closeSupportModal();
  } else {
    openSupportModal();
  }
}

// Help button click (FAB)
document.getElementById('supportBtn')?.addEventListener('click', toggleSupportModal);

// Live Chat nav button click
document.getElementById('nav-livechat')?.addEventListener('click', (e) => {
  e.preventDefault();
  toggleSupportModal();
});

// Escape closes panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSupportModal();
  }
});

// Initialize tawk.to webview with user data
async function initTawkWebview() {
  const webview = document.getElementById('tawkWebview');
  if (!webview) return;

  // Get user data, app info, and support context
  let user = null;
  let appVersion = '';
  let supportContext = {};
  try {
    user = await ipcRenderer.invoke('get-user');
    appVersion = await ipcRenderer.invoke('get-app-version');
    supportContext = await ipcRenderer.invoke('get-support-context');
  } catch (err) {
    console.log('Could not get data for tawk.to:', err);
  }

  // Wait for webview to load, then inject styles and user data
  webview.addEventListener('did-finish-load', () => {
    // Prevent the tawk.to page from scrolling (keeps chat widget at top)
    webview.insertCSS('html, body { overflow: hidden !important; scroll-behavior: auto !important; }')
      .catch(() => {});
    if (user && user.email) {
      // Prepare data (escape single quotes for JS injection)
      const escape = (str) => (str || '').toString().replace(/'/g, "\\'").replace(/\n/g, ' ');

      const userData = {
        // User info
        name: escape(user.name || user.email),
        email: escape(user.email),
        userId: escape(user.id),
        // App info
        appVersion: escape(appVersion),
        platform: 'Windows',
        // Subscription
        planTier: escape(user.planTier || 'unknown'),
        subscriptionStatus: escape(user.subscriptionStatus || 'unknown'),
        minutesRemaining: user.minutesRemaining || 0,
        maxDevices: user.maxDevices || 1,
        // Settings
        shortcut: escape(supportContext.shortcut || 'F9'),
        theme: escape(supportContext.theme || 'dark'),
        vadEnabled: supportContext.vadEnabled !== false ? 'Ja' : 'Nein',
        microphoneName: escape(supportContext.microphoneName || 'Default'),
        microphoneSource: escape(supportContext.microphoneSource || 'desktop'),
        // Stats
        todayRecordings: supportContext.todayRecordings || 0,
        lastDocumentation: escape(supportContext.lastDocumentation || 'Noch keine'),
        // Last error
        lastError: escape(supportContext.lastError || 'Keine Fehler')
      };

      const script = `
        (function() {
          // Wait for Tawk_API to be ready
          function setupTawk() {
            if (typeof Tawk_API !== 'undefined') {
              // Set user attributes
              if (Tawk_API.setAttributes) {
                Tawk_API.setAttributes({
                  name: '${userData.name}',
                  email: '${userData.email}',
                  userId: '${userData.userId}',
                  appVersion: '${userData.appVersion}',
                  platform: '${userData.platform}',
                  planTier: '${userData.planTier}',
                  subscriptionStatus: '${userData.subscriptionStatus}',
                  minutesRemaining: '${userData.minutesRemaining}',
                  maxDevices: '${userData.maxDevices}',
                  shortcut: '${userData.shortcut}',
                  theme: '${userData.theme}',
                  vadEnabled: '${userData.vadEnabled}',
                  microphoneName: '${userData.microphoneName}',
                  microphoneSource: '${userData.microphoneSource}',
                  todayRecordings: '${userData.todayRecordings}',
                  lastDocumentation: '${userData.lastDocumentation}',
                  lastError: '${userData.lastError}'
                }, function(error) {
                  if (error) console.log('Tawk setAttributes error:', error);
                });
              }

              // Listen for agent messages (notify parent via console.log marker)
              Tawk_API.onChatMessageAgent = function(message) {
                console.log('DENTDOC_TAWK_NEW_MESSAGE');
              };
            } else {
              setTimeout(setupTawk, 500);
            }
          }
          setupTawk();
        })();
      `;
      webview.executeJavaScript(script).catch(err => {
        console.log('Could not inject user data into tawk.to:', err);
      });
    }
  });

  // Listen for console messages from webview (for new message notifications)
  webview.addEventListener('console-message', (e) => {
    if (e.message === 'DENTDOC_TAWK_NEW_MESSAGE') {
      // Check if chat panel is closed
      const modal = document.getElementById('supportPanel');
      if (!modal?.classList.contains('active')) {
        unreadChatMessages++;
        const countText = unreadChatMessages > 9 ? '9+' : unreadChatMessages.toString();

        // Update sidebar badge
        const badge = document.getElementById('chatBadge');
        if (badge) {
          badge.textContent = countText;
          badge.style.display = 'flex';
        }

        // Update FAB badge
        const fabBadge = document.getElementById('fabBadge');
        if (fabBadge) {
          fabBadge.textContent = countText;
          fabBadge.style.display = 'flex';
        }

        // Pulse the FAB button
        const fab = document.getElementById('supportBtn');
        fab?.classList.add('has-message');
      }
    }
  });
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', initTawkWebview);

// ============================================================================
// FORMAT BLOCK VIEW (Kundenspezifisches Dokumentationsformat)
// ============================================================================

let formatBlockLoaded = false;
let currentFormatBlock = null; // Cache the current block for preview

async function loadFormatView() {
  if (formatBlockLoaded) return;
  try {
    const data = await ipcRenderer.invoke('get-format-block');
    if (data?.error) {
      document.getElementById('formatBlockPreview').textContent = 'Fehler: ' + data.error;
      return;
    }
    displayFormatBlock(data);
    currentFormatBlock = data.block;
    formatBlockLoaded = true;
    // Show demo transcript
    if (data.demoTranscript) {
      document.getElementById('formatDemoTranscript').textContent = data.demoTranscript;
    }
    // Load expert prompt if exists
    if (data.customPrompt) {
      document.getElementById('formatCustomPrompt').value = data.customPrompt;
    }
    // Set correct mode
    if (data.activeMode === 'expert') {
      setFormatMode('expert');
    }
    // Load history
  } catch (error) {
    console.error('[Format] Load error:', error);
    document.getElementById('formatBlockPreview').textContent = 'Fehler beim Laden: ' + (error.message || error);
  }
}

function displayFormatBlock(data) {
  const lastUpdated = document.getElementById('formatLastUpdated');

  // Store block in hidden field for preview generation
  document.getElementById('formatBlockPreview').value = data.block;
  currentFormatBlock = data.block;

  if (data.updatedAt) {
    const date = new Date(data.updatedAt);
    lastUpdated.textContent = date.toLocaleDateString('de-DE') + ', ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } else {
    lastUpdated.textContent = '';
  }

  // Refresh rules display
  displayActiveRules(data.activeRules);
}

async function updateFormatBlock() {
  const textarea = document.getElementById('formatChangeRequest');
  const changeRequest = textarea.value.trim();

  if (!changeRequest) {
    showFormatStatus('Bitte beschreiben Sie Ihre Änderungswünsche.', 'error');
    return;
  }

  setFormatLoading(true, 'KI passt Ihr Format an...');

  try {
    const result = await ipcRenderer.invoke('update-format-block', changeRequest);
    if (result?.error) {
      showFormatStatus(result.error, 'error');
      return;
    }
    displayFormatBlock(result);
    textarea.value = '';
    showFormatStatus('Format angepasst!', 'success');
    generateFormatPreview();
  } catch (error) {
    console.error('[Format] Update error:', error);
    showFormatStatus(error.message || 'Fehler bei der Anpassung.', 'error');
  } finally {
    setFormatLoading(false);
  }
}

async function resetFormatBlock() {
  const confirmed = await ipcRenderer.invoke('confirm-format-reset');
  if (!confirmed) return;

  const btn = document.getElementById('formatResetBtn');
  btn.disabled = true;

  try {
    const result = await ipcRenderer.invoke('reset-format-block');
    if (result?.error) {
      showFormatStatus(result.error, 'error');
      return;
    }
    displayFormatBlock(result);
    showFormatStatus('Format auf Standard zurückgesetzt.', 'success');
    // Clear preview
    document.getElementById('formatPreviewContent').textContent = 'Klicken Sie auf "Vorschau laden" um die neue Vorschau zu sehen.';
    // Reset to simple mode
    setFormatMode('simple');
    document.getElementById('formatCustomPrompt').value = '';
    formatBlockLoaded = false; // Force reload
  } catch (error) {
    console.error('[Format] Reset error:', error);
    showFormatStatus(error.message || 'Fehler beim Zurücksetzen.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ===== Preview =====

async function generateFormatPreview() {
  if (!currentFormatBlock) return;

  const previewContent = document.getElementById('formatPreviewContent');
  const previewSpinner = document.getElementById('formatPreviewSpinner');
  const previewBtn = document.getElementById('formatPreviewBtn');

  previewBtn.disabled = true;
  previewSpinner.style.display = 'inline-block';
  previewContent.textContent = 'Vorschau wird generiert...';
  previewContent.style.color = 'var(--text-secondary)';

  try {
    const result = await ipcRenderer.invoke('preview-format-block', currentFormatBlock);
    if (result?.error) {
      previewContent.textContent = 'Fehler: ' + result.error;
      return;
    }
    previewContent.textContent = result.documentation;
    previewContent.style.color = 'var(--text-primary, #e0e0e0)';
    // Show demo transcript
    if (result.demoTranscript) {
      document.getElementById('formatDemoTranscript').textContent = result.demoTranscript;
    }
  } catch (error) {
    console.error('[Format] Preview error:', error);
    previewContent.textContent = 'Fehler bei der Vorschau: ' + (error.message || error);
  } finally {
    previewBtn.disabled = false;
    previewSpinner.style.display = 'none';
  }
}

// ===== Active Rules Display =====

function displayActiveRules(activeRules) {
  const rulesList = document.getElementById('formatRulesList');

  if (!activeRules || activeRules.trim().length === 0) {
    rulesList.innerHTML = `<div style="color: var(--text-secondary); padding: 12px; text-align: center;">
      <p style="margin: 0 0 4px 0;">Standard-Format aktiv</p>
      <p style="margin: 0; font-size: 12px;">Geben Sie unten Ihre Änderungswünsche ein um Ihr Format anzupassen.</p>
    </div>`;
    return;
  }

  const rules = activeRules.split('\n').filter(r => r.trim().length > 0);
  rulesList.innerHTML = rules.map((rule, i) => {
    // Remove leading "- " or "1. " etc if present
    const cleanRule = rule.replace(/^[-•]\s*/, '').replace(/^\d+\.\s*/, '').trim();
    const escaped = cleanRule.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `<div style="display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
      <span style="min-width: 24px; font-weight: 600; color: var(--primary, #4a90d9);">${i + 1}.</span>
      <span style="flex: 1;">${cleanRule}</span>
      <button class="format-rule-delete" onclick="removeFormatRule('${escaped}')" title="Diese Regel entfernen" style="background: none; border: none; cursor: pointer; padding: 4px 8px; font-size: 14px; opacity: 0.4; transition: opacity 0.2s; color: var(--text-secondary);" onmouseover="this.style.opacity='1';this.style.color='var(--danger, #e74c3c)'" onmouseout="this.style.opacity='0.4';this.style.color='var(--text-secondary)'">&times;</button>
    </div>`;
  }).join('');
}

// ===== History =====

async function loadFormatHistory() {
  const historyList = document.getElementById('formatHistoryList');
  try {
    cachedHistory = await ipcRenderer.invoke('get-format-history') || [];

    if (cachedHistory.length === 0) {
      historyList.innerHTML = '<p style="color: var(--text-secondary); margin: 0;">Noch keine Änderungen vorgenommen.</p>';
      return;
    }

    historyList.innerHTML = cachedHistory.map(entry => {
      const date = new Date(entry.createdAt);
      const dateStr = date.toLocaleDateString('de-DE') + ', ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const changeText = entry.changeRequest
        ? entry.changeRequest.substring(0, 80) + (entry.changeRequest.length > 80 ? '...' : '')
        : 'Keine Beschreibung';

      return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
        <div>
          <span style="font-weight: 600; color: var(--primary, #4a90d9);">V${entry.version}</span>
          <span style="margin-left: 8px;">${changeText}</span>
          <span style="margin-left: 8px; color: var(--text-secondary); font-size: 11px;">${dateStr}</span>
        </div>
        <button class="btn btn-outline" style="padding: 2px 10px; font-size: 11px;" onclick="revertFormatBlock(${entry.version})">
          Wiederherstellen
        </button>
      </div>`;
    }).join('');

  } catch (error) {
    console.error('[Format] History error:', error);
    historyList.innerHTML = '<p style="color: var(--danger);">Fehler beim Laden der Historie.</p>';
  }
}

async function revertFormatBlock(version) {
  const confirmed = confirm(`Möchten Sie auf Version ${version} zurücksetzen?`);
  if (!confirmed) return;

  try {
    showFormatStatus('Wird wiederhergestellt...', 'info');
    const result = await ipcRenderer.invoke('revert-format-block', version);
    if (result?.error) {
      showFormatStatus(result.error, 'error');
      return;
    }
    displayFormatBlock(result);
    showFormatStatus(`Version ${version} wiederhergestellt!`, 'success');
    // Clear preview
    document.getElementById('formatPreviewContent').textContent = 'Klicken Sie auf "Vorschau laden" um die neue Vorschau zu sehen.';
  } catch (error) {
    console.error('[Format] Revert error:', error);
    showFormatStatus(error.message || 'Fehler beim Wiederherstellen.', 'error');
  }
}

let formatLoadingTimeout = null;

function setFormatLoading(loading, message) {
  const overlay = document.getElementById('formatLoadingOverlay');
  if (loading) {
    // Safety timeout: 2 minutes max
    if (formatLoadingTimeout) clearTimeout(formatLoadingTimeout);
    formatLoadingTimeout = setTimeout(() => {
      setFormatLoading(false);
      showFormatStatus('Zeitüberschreitung — bitte erneut versuchen.', 'error');
    }, 120000);
    if (!overlay) {
      const el = document.createElement('div');
      el.id = 'formatLoadingOverlay';
      el.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10;';
      el.innerHTML = `<div style="text-align: center; color: var(--text-primary, #e0e0e0);"><div class="spinner" style="display: inline-block; margin-bottom: 8px;"></div><div style="font-size: 13px;">${message || 'Wird verarbeitet...'}</div></div>`;
      const mainContent = document.getElementById('mainContent');
      mainContent.style.position = 'relative';
      mainContent.appendChild(el);
    }
  } else {
    if (formatLoadingTimeout) { clearTimeout(formatLoadingTimeout); formatLoadingTimeout = null; }
    overlay?.remove();
  }
}

async function removeFormatRule(ruleText) {
  setFormatLoading(true, 'Regel wird entfernt...');

  try {
    const changeRequest = `Folgende Regel entfernen und die entsprechende Änderung im Block rückgängig machen: "${ruleText}"`;
    const result = await ipcRenderer.invoke('update-format-block', changeRequest);
    if (result?.error) {
      showFormatStatus(result.error, 'error');
      return;
    }
    displayFormatBlock(result);
    showFormatStatus('Regel entfernt!', 'success');
    generateFormatPreview();
  } catch (error) {
    console.error('[Format] Remove rule error:', error);
    showFormatStatus(error.message || 'Fehler beim Entfernen.', 'error');
  } finally {
    setFormatLoading(false);
  }
}

function showFormatStatus(message, type) {
  const statusEl = document.getElementById('formatStatusMsg');
  statusEl.textContent = message;
  statusEl.style.display = 'inline';
  statusEl.style.color = type === 'error' ? 'var(--danger, #e74c3c)' :
                          type === 'success' ? 'var(--success, #27ae60)' :
                          'var(--text-secondary)';

  if (type !== 'info') {
    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
  }
}

// ===== Format Mode Toggle (Einfach / Experte) =====

async function setFormatMode(mode) {
  const simpleMode = document.getElementById('formatSimpleMode');
  const expertMode = document.getElementById('formatExpertMode');
  const simpleBtn = document.getElementById('formatModeSimple');
  const expertBtn = document.getElementById('formatModeExpert');
  const simpleOnlyCards = document.querySelectorAll('.format-simple-only');

  if (mode === 'expert') {
    simpleMode.style.display = 'none';
    simpleOnlyCards.forEach(el => el.style.display = 'none');
    expertMode.style.display = 'block';
    simpleBtn.style.background = 'transparent';
    simpleBtn.style.color = 'var(--text-secondary)';
    expertBtn.style.background = 'var(--primary, #f97316)';
    expertBtn.style.color = 'white';
  } else {
    simpleMode.style.display = 'grid';
    simpleOnlyCards.forEach(el => el.style.display = '');
    expertMode.style.display = 'none';
    simpleBtn.style.background = 'var(--primary, #f97316)';
    simpleBtn.style.color = 'white';
    expertBtn.style.background = 'transparent';
    expertBtn.style.color = 'var(--text-secondary)';
  }

  // Persist mode on server
  ipcRenderer.invoke('set-format-mode', mode).catch(e =>
    console.error('[Format] Set mode error:', e)
  );
}

async function saveCustomPrompt() {
  const textarea = document.getElementById('formatCustomPrompt');
  const prompt = textarea.value.trim();

  if (!prompt) {
    showExpertStatus('Bitte geben Sie einen Prompt ein.', 'error');
    return;
  }

  setFormatLoading(true, 'Prompt wird gespeichert...');

  try {
    const result = await ipcRenderer.invoke('save-custom-prompt', prompt);
    if (result?.error) {
      showExpertStatus(result.error, 'error');
      return;
    }
    currentFormatBlock = result.block;
    showExpertStatus('Prompt gespeichert!', 'success');
  } catch (error) {
    console.error('[Format] Save prompt error:', error);
    showExpertStatus(error.message || 'Fehler beim Speichern.', 'error');
  } finally {
    setFormatLoading(false);
  }
}

async function generateExpertPreview() {
  const textarea = document.getElementById('formatCustomPrompt');
  const prompt = textarea.value.trim();

  if (!prompt) {
    showExpertStatus('Bitte geben Sie erst einen Prompt ein.', 'error');
    return;
  }

  const previewContent = document.getElementById('formatExpertPreviewContent');
  const previewSpinner = document.getElementById('formatExpertPreviewSpinner');
  const previewBtn = document.getElementById('formatExpertPreviewBtn');

  previewBtn.disabled = true;
  previewSpinner.style.display = 'inline-block';
  previewContent.textContent = 'Vorschau wird generiert...';
  previewContent.style.color = 'var(--text-secondary)';

  try {
    const result = await ipcRenderer.invoke('preview-format-block', prompt, true);
    if (result?.error) {
      previewContent.textContent = 'Fehler: ' + result.error;
      return;
    }
    previewContent.textContent = result.documentation;
    previewContent.style.color = 'var(--text-primary, #e0e0e0)';
  } catch (error) {
    console.error('[Format] Expert preview error:', error);
    previewContent.textContent = 'Fehler: ' + (error.message || error);
  } finally {
    previewBtn.disabled = false;
    previewSpinner.style.display = 'none';
  }
}

const EXPERT_DEFAULT_PROMPT = `Erstelle aus dem Text eine kompakte Behandlungsdokumentation.

FORMAT
Diktathafter Fließtext, keine Überschriften, keine Aufzählungszeichen.
Stichpunkte mit Kommas getrennt, ein Absatz pro Behandlungsschritt.

STIL
- Patient → immer "Pat."
- Zahnangaben ohne Punkt: 36 (nicht 3.6)
- Gängige Abkürzungen: empf., einv., Fllg, Rö, ZF, BF, OPG, Zst, MSH, PZR, WF, WB
- So kurz wie möglich, so lang wie medizinisch nötig

INHALT
- Nur medizinisch, rechtlich oder abrechnungsrelevante Inhalte
- Befunde mit Zahnangabe dokumentieren
- Aufklärungen und Patientenentscheidungen festhalten
- Keine Ablaufdetails (Spülen, Absaugen, Materialwechsel etc.)
- Keine erfundenen Befunde

REIHENFOLGE
1. Anlass / Beratungsgrund
2. Befunde und Diagnostik
3. Durchgeführte Maßnahmen
4. Aufklärung und Patientenwunsch
5. Planung / Weiterbehandlung`;

function resetExpertPrompt() {
  document.getElementById('formatCustomPrompt').value = EXPERT_DEFAULT_PROMPT;
  showExpertStatus('Prompt auf Vorlage zurückgesetzt.', 'success');
}

function showExpertStatus(message, type) {
  const statusEl = document.getElementById('formatExpertStatusMsg');
  statusEl.textContent = message;
  statusEl.style.display = 'inline';
  statusEl.style.color = type === 'error' ? 'var(--danger, #e74c3c)' :
                          type === 'success' ? 'var(--success, #27ae60)' :
                          'var(--text-secondary)';
  if (type !== 'info') {
    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
  }
}
