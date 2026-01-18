/**
 * DentDoc Dashboard
 * Main JavaScript for the integrated dashboard interface
 * Includes: Home, Settings, Voice Profiles, and Bausteine views
 */

const { ipcRenderer } = require('electron');

// ===== View Navigation =====
const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');

function switchView(viewName) {
  // Stop any running mic test and cleanup when leaving settings view
  if (settingsIsTesting) {
    settingsStopMicTest();
  }
  // Clean up mic test audio file when leaving settings
  ipcRenderer.invoke('cleanup-mic-test');
  document.getElementById('settingsMicPlayback').style.display = 'none';

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
    case 'bausteine':
      loadBausteineView();
      break;
    case 'textbausteine':
      loadTextbausteineView();
      break;
    case 'themen':
      loadThemenView();
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
    document.getElementById('homeShortcutKey').textContent = shortcut || 'F9';

    // Load last documentation
    await loadLastDocumentation();
  } catch (error) {
    console.error('Error loading home stats:', error);
  }
}

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
  console.log('!!!!!!! recording-stopped EVENT RECEIVED !!!!!!!');
  console.log('vadIsActive:', vadIsActive, 'vadIsStarting:', vadIsStarting);
  console.log('Stack trace:', new Error().stack);

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

// ===== Recording Quick Action =====
document.getElementById('startRecordingCard').addEventListener('click', async () => {
  try {
    await ipcRenderer.invoke('toggle-recording');
  } catch (error) {
    console.error('Error toggling recording:', error);
  }
});

// ===== Window Controls =====
document.getElementById('minimizeBtn').addEventListener('click', () => {
  ipcRenderer.send('minimize-to-tray');
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
          description: 'Über die Seitenleiste erreichen Sie alle Bereiche: Übersicht, Einstellungen, Stimmprofile und Bausteine.',
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '#startRecordingCard',
        popover: {
          title: 'Schnellstart',
          description: 'Klicken Sie hier oder drücken Sie F9, um eine Aufnahme zu starten. Die Dokumentation wird automatisch erstellt.',
          side: 'bottom',
          align: 'center'
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
        element: '#nav-bausteine',
        popover: {
          title: 'Bausteine',
          description: 'Textvorlagen, die automatisch in Ihre Dokumentation eingefügt werden können.',
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

checkFirstRun();


// =============================================================================
// SETTINGS VIEW
// =============================================================================

let settingsSelectedMicId = null;
let settingsNewShortcut = null;
let settingsIsRecordingShortcut = false;
let settingsIsTesting = false;
let settingsAudioContext = null;
let settingsMediaStream = null;
let settingsAnalyser = null;
let settingsHasUnsavedChanges = false;
let settingsInitialSettings = {};
let settingsMicTestTimeout = null;  // Auto-stop timer for mic test

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
  document.getElementById('settingsTranscriptPath').value = settings.transcriptPath || '';
  document.getElementById('settingsProfilesPath').value = settings.profilesPath || '';
  document.getElementById('settingsAutoCloseCheckbox').checked = settings.autoClose || false;
  document.getElementById('settingsAutoExportCheckbox').checked = settings.autoExport || false;
  document.getElementById('settingsKeepAudioCheckbox').checked = settings.keepAudio || false;
  document.getElementById('settingsDocModeSelect').value = settings.docMode || 'single';
  document.getElementById('settingsVadEnabled').checked = settings.vadEnabled !== false;

  // iPhone microphone settings
  const microphoneSource = settings.microphoneSource || 'desktop';
  document.getElementById('settingsMicSourceDesktop').checked = microphoneSource === 'desktop';
  document.getElementById('settingsMicSourceIphone').checked = microphoneSource === 'iphone';
  await loadIphonePairingStatus(settings);
  updateMicSourceUI(microphoneSource);

  const bausteinePathValue = await ipcRenderer.invoke('get-bausteine-path');
  document.getElementById('settingsBausteinePath').value = bausteinePathValue || '';

  const theme = settings.theme || 'dark';
  document.getElementById('settingsThemeSelect').value = theme;

  await loadSettingsMicrophones();

  settingsInitialSettings = {
    shortcut: settings.shortcut || 'F9',
    microphoneId: settingsSelectedMicId,
    microphoneSource: settings.microphoneSource || 'desktop',
    transcriptPath: settings.transcriptPath || '',
    profilesPath: settings.profilesPath || '',
    bausteinePath: bausteinePathValue || '',
    autoClose: settings.autoClose || false,
    autoExport: settings.autoExport || false,
    keepAudio: settings.keepAudio || false,
    docMode: settings.docMode || 'single',
    theme: settings.theme || 'dark',
    vadEnabled: settings.vadEnabled !== false
  };
}

async function loadSettingsMicrophones() {
  const micSelect = document.getElementById('settingsMicSelect');
  try {
    // Use WebRTC to enumerate audio devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    micSelect.innerHTML = '';

    if (mics.length === 0) {
      micSelect.innerHTML = '<option value="">Kein Mikrofon gefunden</option>';
      return;
    }

    mics.forEach((mic, index) => {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      option.textContent = mic.label || `Mikrofon ${index + 1}`;
      if (mic.deviceId === settingsSelectedMicId) {
        option.selected = true;
      }
      micSelect.appendChild(option);
    });

    // Set default if none selected
    if (!settingsSelectedMicId && mics.length > 0) {
      settingsSelectedMicId = mics[0].deviceId;
    }
  } catch (error) {
    console.error('Error loading microphones:', error);
    micSelect.innerHTML = '<option value="">Fehler beim Laden</option>';
  }
}

function settingsCheckForChanges() {
  const currentSettings = {
    shortcut: settingsNewShortcut || document.getElementById('settingsShortcutDisplay').textContent,
    microphoneId: document.getElementById('settingsMicSelect').value,
    microphoneSource: document.querySelector('input[name="micSource"]:checked')?.value || 'desktop',
    transcriptPath: document.getElementById('settingsTranscriptPath').value,
    profilesPath: document.getElementById('settingsProfilesPath').value,
    bausteinePath: document.getElementById('settingsBausteinePath').value,
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

// Test iPhone microphone connection
async function testIphoneMic() {
  const statusEl = document.getElementById('settingsIphoneTestStatus');
  const testBtn = document.getElementById('settingsIphoneTestBtn');

  if (!statusEl || !testBtn) return;

  testBtn.disabled = true;
  statusEl.className = 'status-message';
  statusEl.textContent = 'Verbindung wird geprüft...';

  try {
    // Check if iPhone is connected via relay
    const result = await ipcRenderer.invoke('iphone-test-connection');

    if (result.connected) {
      statusEl.className = 'status-message success';
      statusEl.textContent = `Verbunden! Latenz: ${result.latency || '?'}ms`;
    } else {
      statusEl.className = 'status-message error';
      statusEl.textContent = result.error || 'iPhone nicht verbunden. Bitte Safari öffnen.';
    }
  } catch (error) {
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Fehler: ' + error.message;
  }

  testBtn.disabled = false;

  // Clear message after 5 seconds
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = 'status-message';
  }, 5000);
}

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
      // Show unpaired state with pairing QR
      unpairedState.style.display = 'block';
      pairedState.style.display = 'none';

      // Generate pairing QR code
      await generateDashboardPairingQRCode();
    }
  } catch (error) {
    console.error('[iPhone] Dashboard status check failed:', error);
    // Default to unpaired state
    unpairedState.style.display = 'block';
    pairedState.style.display = 'none';
    await generateDashboardPairingQRCode();
  }
}

// Generate pairing QR code for dashboard (starts pairing flow)
async function generateDashboardPairingQRCode() {
  try {
    const QRCode = require('qrcode');

    // Start pairing to get QR URL
    const result = await ipcRenderer.invoke('iphone-pair-start');

    if (!result.success) {
      console.error('[iPhone] Dashboard pairing start failed:', result.error);
      return;
    }

    const qrContainer = document.getElementById('iphoneDashboardPairingQR');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';

    const canvas = document.createElement('canvas');
    await QRCode.toCanvas(canvas, result.pairingUrl, {
      width: 180,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    qrContainer.appendChild(canvas);

    // Show URL
    const urlEl = document.getElementById('iphoneDashboardPairingUrl');
    if (urlEl) {
      urlEl.textContent = result.pairingUrl;
    }

    // Start polling for pairing completion
    startDashboardPairingPoll(result.pairingId);
  } catch (error) {
    console.error('[iPhone] Dashboard QR generation failed:', error);
  }
}

// Poll for pairing completion on dashboard
let dashboardPairingPollInterval = null;
function startDashboardPairingPoll(pairingId) {
  // Clear any existing poll
  if (dashboardPairingPollInterval) {
    clearInterval(dashboardPairingPollInterval);
  }

  dashboardPairingPollInterval = setInterval(async () => {
    try {
      const status = await ipcRenderer.invoke('iphone-pair-status', pairingId);

      if (status.paired || status.status === 'paired') {
        clearInterval(dashboardPairingPollInterval);
        dashboardPairingPollInterval = null;

        // Reload dashboard section to show paired state
        const shortcut = await ipcRenderer.invoke('get-shortcut');
        await loadIphoneDashboardSection(shortcut || 'F9');

        // Also update settings view if visible
        loadIphonePairingStatus({});
      } else if (status.status === 'expired') {
        clearInterval(dashboardPairingPollInterval);
        dashboardPairingPollInterval = null;
        // Regenerate QR code
        await generateDashboardPairingQRCode();
      }
    } catch (error) {
      console.error('[iPhone] Dashboard pairing poll error:', error);
    }
  }, 2000);

  // Auto-stop after 10 minutes
  setTimeout(() => {
    if (dashboardPairingPollInterval) {
      clearInterval(dashboardPairingPollInterval);
      dashboardPairingPollInterval = null;
    }
  }, 10 * 60 * 1000);
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
  const localMicSection = document.getElementById('settingsMicSelect').closest('.settings-section');
  const micSelect = document.getElementById('settingsMicSelect');
  const micTestBtn = document.getElementById('settingsTestMicBtn');
  const iphoneSection = document.getElementById('settingsIphonePairingSection');

  if (source === 'iphone') {
    // Show iPhone pairing, hide local mic controls (but keep the section visible)
    iphoneSection.style.display = 'block';
    micSelect.disabled = true;
    micSelect.style.opacity = '0.5';
    micTestBtn.disabled = true;
    micTestBtn.style.opacity = '0.5';
  } else {
    // Show local mic controls, hide iPhone pairing
    iphoneSection.style.display = 'none';
    micSelect.disabled = false;
    micSelect.style.opacity = '1';
    micTestBtn.disabled = false;
    micTestBtn.style.opacity = '1';
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
  radio.addEventListener('change', (e) => {
    updateMicSourceUI(e.target.value);
    settingsCheckForChanges();
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

// Settings Mic Test - uses real recorder logic for realistic testing
// Audio monitoring variables
let settingsMicAnimationFrameId = null;

async function settingsStartAudioMonitoring() {
  try {
    // Use selected mic or default
    const constraints = settingsSelectedMicId ? {
      audio: {
        deviceId: { ideal: settingsSelectedMicId },
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

    settingsMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    settingsAudioContext = new AudioContext();
    settingsAnalyser = settingsAudioContext.createAnalyser();
    settingsAnalyser.fftSize = 256;

    const source = settingsAudioContext.createMediaStreamSource(settingsMediaStream);
    source.connect(settingsAnalyser);

    const bufferLength = settingsAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function updateLevel() {
      if (!settingsAnalyser || !settingsIsTesting) return;

      settingsAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const normalized = Math.min(average / 128 * 100, 100);
      document.getElementById('settingsMicLevelBar').style.width = normalized + '%';
      settingsMicAnimationFrameId = requestAnimationFrame(updateLevel);
    }

    updateLevel();
  } catch (error) {
    console.error('Settings audio monitoring error:', error);
  }
}

function settingsStopAudioMonitoring() {
  if (settingsMicAnimationFrameId) {
    cancelAnimationFrame(settingsMicAnimationFrameId);
    settingsMicAnimationFrameId = null;
  }
  if (settingsMediaStream) {
    settingsMediaStream.getTracks().forEach(track => track.stop());
    settingsMediaStream = null;
  }
  if (settingsAudioContext) {
    settingsAudioContext.close();
    settingsAudioContext = null;
    settingsAnalyser = null;
  }
}

document.getElementById('settingsTestMicBtn').addEventListener('click', async () => {
  if (settingsIsTesting) {
    // Manual stop - just wait for auto-stop
    return;
  }

  try {
    settingsIsTesting = true;
    const btn = document.getElementById('settingsTestMicBtn');
    btn.textContent = 'Aufnahme läuft...';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-danger');
    btn.disabled = true;

    // Hide previous playback
    document.getElementById('settingsMicPlayback').style.display = 'none';

    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Aufnahme läuft... Sprechen Sie ins Mikrofon (5 Sek.)', 'info');

    // Start real audio monitoring (local, like Stimmprofile)
    await settingsStartAudioMonitoring();

    // Start real recording via IPC (FFmpeg)
    const startResult = await ipcRenderer.invoke('start-mic-test', settingsSelectedMicId);
    if (!startResult.success) {
      throw new Error(startResult.error);
    }

    // Auto-stop after 5 seconds
    settingsMicTestTimeout = setTimeout(async () => {
      if (settingsIsTesting) {
        await settingsStopMicTest();
      }
    }, 5000);

  } catch (error) {
    console.error('Mic test error:', error);
    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler: ' + error.message, 'error');
    settingsStopMicTest();
  }
});

async function settingsStopMicTest() {
  settingsIsTesting = false;

  // Stop audio monitoring (local getUserMedia stream)
  settingsStopAudioMonitoring();

  // Clear auto-stop timer
  if (settingsMicTestTimeout) {
    clearTimeout(settingsMicTestTimeout);
    settingsMicTestTimeout = null;
  }

  const btn = document.getElementById('settingsTestMicBtn');
  btn.textContent = 'Test starten (5 Sek.)';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-secondary');
  btn.disabled = false;
  document.getElementById('settingsMicLevelBar').style.width = '0%';

  try {
    // Stop recording and get audio file
    const stopResult = await ipcRenderer.invoke('stop-mic-test');
    if (stopResult.success) {
      settingsShowStatus(document.getElementById('settingsMicStatus'), 'Test abgeschlossen - Klicken Sie "Anhören" um die Qualität zu prüfen', 'success');
      // Show playback button
      document.getElementById('settingsMicPlayback').style.display = 'flex';
    } else {
      settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler beim Stoppen: ' + stopResult.error, 'error');
    }
  } catch (error) {
    console.error('Stop mic test error:', error);
    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler: ' + error.message, 'error');
  }
}

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
  settingsSelectedMicId = document.getElementById('settingsMicSelect').value;
  if (settingsIsTesting) {
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

document.getElementById('settingsBrowseBausteineBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('select-folder');
  if (!result) return;

  const newPath = result + '\\bausteine.json';
  const dialogResult = await ipcRenderer.invoke('show-bausteine-path-dialog', newPath);

  if (dialogResult.action === 'cancel') return;

  if (dialogResult.action === 'copy_current') {
    await ipcRenderer.invoke('copy-bausteine-to-path', newPath);
  } else if (dialogResult.action === 'use_existing') {
    await ipcRenderer.invoke('set-bausteine-path', newPath);
  } else if (dialogResult.action === 'use_defaults') {
    await ipcRenderer.invoke('set-bausteine-path', newPath);
  }

  document.getElementById('settingsBausteinePath').value = newPath;
  settingsCheckForChanges();
});

document.getElementById('settingsOpenBausteineFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('settingsBausteinePath').value;
  if (path) {
    const folderPath = path.substring(0, path.lastIndexOf('\\'));
    await ipcRenderer.invoke('open-folder', folderPath);
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

// Settings Save/Cancel
document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
  const settings = {
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

document.getElementById('settingsCancelBtn').addEventListener('click', () => {
  settingsHasUnsavedChanges = false;
  switchView('home');
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


// =============================================================================
// BAUSTEINE VIEW
// =============================================================================

let bausteineData = null;
let bausteineDefaultsData = null;
let bausteineHasUnsavedChanges = false;
let bausteineOpenBausteinId = null;
let bausteineCategoryForNewBaustein = null;

async function loadBausteineView() {
  try {
    const result = await ipcRenderer.invoke('get-bausteine-with-categories');
    bausteineData = JSON.parse(JSON.stringify(result.data));
    bausteineDefaultsData = JSON.parse(JSON.stringify(result.defaults));
    document.getElementById('bausteinePathDisplay').textContent = result.path;
    renderBausteineCategories();
  } catch (error) {
    bausteineShowStatus('Fehler beim Laden: ' + error.message, 'error');
  }
}

function renderBausteineCategories() {
  const container = document.getElementById('bausteineCategoriesContainer');
  container.innerHTML = '';

  if (!bausteineData || !bausteineData.categories) return;

  for (const category of bausteineData.categories) {
    const categoryEl = document.createElement('div');
    categoryEl.className = 'category';
    categoryEl.dataset.id = category.id;

    categoryEl.innerHTML = `
      <div class="category-header" data-category-id="${category.id}">
        <div class="category-title">
          <svg class="category-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span class="category-name">${category.name}</span>
          <span class="category-count">${category.bausteine.length} Bausteine</span>
        </div>
        <div class="category-actions">
          <button class="btn btn-ghost btn-sm" data-action="rename" data-category-id="${category.id}">Umbenennen</button>
          <button class="btn btn-ghost btn-sm" data-action="delete" data-category-id="${category.id}">Löschen</button>
          <button class="btn btn-secondary btn-sm" data-action="add-baustein" data-category-id="${category.id}">+ Baustein</button>
        </div>
      </div>
      <div class="category-content">
        <div class="bausteine-list" id="bausteine-${category.id}">
          ${category.bausteine.length === 0 ? `
            <div class="empty-category">
              Keine Bausteine in dieser Kategorie
              <br>
              <button class="btn btn-secondary btn-sm" data-action="add-baustein" data-category-id="${category.id}">Baustein hinzufügen</button>
            </div>
          ` : category.bausteine.map(b => renderBausteinItem(b, category.id)).join('')}
        </div>
      </div>
    `;

    container.appendChild(categoryEl);
  }

  // Add event listeners
  container.querySelectorAll('.category-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.category-actions')) return;
      const categoryId = header.dataset.categoryId;
      const categoryEl = document.querySelector(`.category[data-id="${categoryId}"]`);
      if (categoryEl) categoryEl.classList.toggle('collapsed');
    });
  });

  container.querySelectorAll('[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bausteinRenameCategory(btn.dataset.categoryId);
    });
  });

  container.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bausteinDeleteCategory(btn.dataset.categoryId);
    });
  });

  container.querySelectorAll('[data-action="add-baustein"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bausteinAddBaustein(btn.dataset.categoryId);
    });
  });

  container.querySelectorAll('.baustein-item-header').forEach(header => {
    header.addEventListener('click', () => {
      const bausteinId = header.dataset.bausteinId;
      bausteinToggleBaustein(bausteinId);
    });
  });

  // Move baustein buttons
  container.querySelectorAll('[data-action="move-baustein"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMoveDropdown(btn, btn.dataset.bausteinId, btn.dataset.categoryId);
    });
  });
}

// Move dropdown functionality
let activeMoveDropdown = null;

function showMoveDropdown(button, bausteinId, currentCategoryId) {
  // Remove any existing dropdown
  hideMoveDropdown();

  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'move-dropdown active';
  dropdown.innerHTML = bausteineData.categories
    .map(cat => `
      <div class="move-dropdown-item ${cat.id === currentCategoryId ? 'disabled' : ''}"
           data-target-category="${cat.id}"
           data-baustein-id="${bausteinId}"
           data-source-category="${currentCategoryId}">
        ${cat.name}${cat.id === currentCategoryId ? ' (aktuell)' : ''}
      </div>
    `).join('');

  // Position dropdown
  const rect = button.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left}px`;

  document.body.appendChild(dropdown);
  activeMoveDropdown = dropdown;

  // Add click handlers
  dropdown.querySelectorAll('.move-dropdown-item:not(.disabled)').forEach(item => {
    item.addEventListener('click', () => {
      moveBausteinToCategory(
        item.dataset.bausteinId,
        item.dataset.sourceCategory,
        item.dataset.targetCategory
      );
      hideMoveDropdown();
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', hideMoveDropdownOnOutsideClick);
  }, 0);
}

function hideMoveDropdown() {
  if (activeMoveDropdown) {
    activeMoveDropdown.remove();
    activeMoveDropdown = null;
  }
  document.removeEventListener('click', hideMoveDropdownOnOutsideClick);
}

function hideMoveDropdownOnOutsideClick(e) {
  if (activeMoveDropdown && !activeMoveDropdown.contains(e.target)) {
    hideMoveDropdown();
  }
}

async function moveBausteinToCategory(bausteinId, sourceCategoryId, targetCategoryId) {
  // Find and remove baustein from source category
  const sourceCategory = bausteineData.categories.find(c => c.id === sourceCategoryId);
  const targetCategory = bausteineData.categories.find(c => c.id === targetCategoryId);

  if (!sourceCategory || !targetCategory) return;

  const bausteinIndex = sourceCategory.bausteine.findIndex(b => b.id === bausteinId);
  if (bausteinIndex === -1) return;

  const [baustein] = sourceCategory.bausteine.splice(bausteinIndex, 1);
  targetCategory.bausteine.push(baustein);

  bausteineHasUnsavedChanges = true;
  document.getElementById('bausteineSaveBtn').disabled = false;
  bausteineShowStatus(`"${baustein.name}" verschoben nach "${targetCategory.name}"`, 'success');
  renderBausteineCategories();
}

function renderBausteinItem(baustein, categoryId) {
  const isOpen = bausteineOpenBausteinId === baustein.id;
  const isCustom = bausteinIsCustom(baustein.id);

  return `
    <div class="baustein-item ${isOpen ? 'open' : ''}" data-id="${baustein.id}" data-category="${categoryId}">
      <div class="baustein-item-header" data-baustein-id="${baustein.id}">
        <div class="baustein-title-row">
          <svg class="baustein-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <span class="baustein-name">${baustein.name}</span>
          <span class="baustein-id">${baustein.id}</span>
        </div>
        <div class="baustein-meta">
          <span class="badge ${isCustom ? 'badge-custom' : 'badge-default'}">
            ${isCustom ? 'Angepasst' : 'Standard'}
          </span>
        </div>
      </div>
      <div class="baustein-content">
        <div class="baustein-content-inner">
          <div class="baustein-field">
            <label>Name</label>
            <input type="text" value="${baustein.name}" data-baustein-id="${baustein.id}" data-field="name">
          </div>
          <div class="baustein-field">
            <label>Aufklärungstext</label>
            <textarea data-baustein-id="${baustein.id}" data-field="standardText">${baustein.standardText}</textarea>
          </div>
          <div class="baustein-field">
            <label>Erkennungshinweise (kommagetrennt)</label>
            <input type="text" value="${(baustein.keywords || []).join(', ')}" data-baustein-id="${baustein.id}" data-field="keywords">
          </div>
          <div class="baustein-actions">
            <div class="baustein-actions-left">
              <button class="btn-icon" title="Verschieben" data-action="move-baustein" data-baustein-id="${baustein.id}" data-category-id="${categoryId}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M5 9l-3 3 3 3"/>
                  <path d="M9 5l3-3 3 3"/>
                  <path d="M15 19l3 3 3-3"/>
                  <path d="M19 9l3 3-3 3"/>
                  <line x1="2" y1="12" x2="22" y2="12"/>
                  <line x1="12" y1="2" x2="12" y2="22"/>
                </svg>
              </button>
              <button class="btn-icon danger" title="Löschen" data-action="delete-baustein" data-baustein-id="${baustein.id}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
            <button class="btn-reset" data-action="reset-baustein" data-baustein-id="${baustein.id}" ${!isCustom ? 'disabled' : ''}>
              Auf Standard zurücksetzen
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bausteinToggleBaustein(bausteinId) {
  const wasOpen = bausteineOpenBausteinId === bausteinId;
  bausteineOpenBausteinId = wasOpen ? null : bausteinId;

  document.querySelectorAll('.baustein-item').forEach(item => {
    if (item.dataset.id === bausteinId && !wasOpen) {
      item.classList.add('open');
    } else {
      item.classList.remove('open');
    }
  });
}

function bausteinIsCustom(bausteinId) {
  if (!bausteineDefaultsData || !bausteineDefaultsData.categories) return true;

  let defaultBaustein = null;
  for (const cat of bausteineDefaultsData.categories) {
    const found = cat.bausteine.find(b => b.id === bausteinId);
    if (found) {
      defaultBaustein = found;
      break;
    }
  }

  if (!defaultBaustein) return true;

  let currentBaustein = null;
  for (const cat of bausteineData.categories) {
    const found = cat.bausteine.find(b => b.id === bausteinId);
    if (found) {
      currentBaustein = found;
      break;
    }
  }

  if (!currentBaustein) return true;

  return currentBaustein.standardText !== defaultBaustein.standardText ||
         currentBaustein.name !== defaultBaustein.name ||
         JSON.stringify(currentBaustein.keywords) !== JSON.stringify(defaultBaustein.keywords);
}

function bausteineShowStatus(message, type = '') {
  const el = document.getElementById('bausteineStatusMessage');
  el.textContent = message;
  el.className = 'status-message ' + type;
}

// Bausteine Event Delegation for dynamic content
document.getElementById('bausteineCategoriesContainer').addEventListener('input', (e) => {
  const bausteinId = e.target.dataset.bausteinId;
  const field = e.target.dataset.field;
  if (!bausteinId || !field) return;

  for (const cat of bausteineData.categories) {
    const baustein = cat.bausteine.find(b => b.id === bausteinId);
    if (baustein) {
      if (field === 'keywords') {
        baustein.keywords = e.target.value.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
      } else {
        baustein[field] = e.target.value;
      }
      break;
    }
  }

  bausteineHasUnsavedChanges = true;
  bausteineShowStatus('Ungespeicherte Änderungen', 'warning');
  document.getElementById('bausteineSaveBtn').disabled = false;
});

document.getElementById('bausteineCategoriesContainer').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const bausteinId = e.target.closest('[data-baustein-id]')?.dataset.bausteinId;

  if (action === 'delete-baustein' && bausteinId) {
    await bausteinDeleteBaustein(bausteinId);
  } else if (action === 'reset-baustein' && bausteinId) {
    await bausteinResetBaustein(bausteinId);
  }
});

async function bausteinRenameCategory(categoryId) {
  const cat = bausteineData.categories.find(c => c.id === categoryId);
  if (!cat) return;

  const newName = prompt('Neuer Name für die Kategorie:', cat.name);
  if (!newName || newName === cat.name) return;

  try {
    await ipcRenderer.invoke('rename-category', categoryId, newName);
    await loadBausteineView();
    bausteineShowStatus(`Kategorie umbenannt zu "${newName}"`, 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
}

async function bausteinDeleteCategory(categoryId) {
  const cat = bausteineData.categories.find(c => c.id === categoryId);
  if (!cat) return;

  const confirmed = await ipcRenderer.invoke('confirm-delete-category', cat.name);
  if (!confirmed) return;

  try {
    await ipcRenderer.invoke('delete-category', categoryId);
    await loadBausteineView();
    bausteineShowStatus(`Kategorie "${cat.name}" gelöscht`, 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
}

function bausteinAddBaustein(categoryId) {
  bausteineCategoryForNewBaustein = categoryId;
  document.getElementById('bausteineNewBausteinName').value = '';
  document.getElementById('bausteineNewBausteinModal').classList.add('active');
  document.getElementById('bausteineNewBausteinName').focus();
}

async function bausteinDeleteBaustein(bausteinId) {
  let baustein = null;
  for (const cat of bausteineData.categories) {
    baustein = cat.bausteine.find(b => b.id === bausteinId);
    if (baustein) break;
  }
  if (!baustein) return;

  const confirmed = await ipcRenderer.invoke('confirm-delete-baustein', baustein.name);
  if (!confirmed) return;

  try {
    await ipcRenderer.invoke('delete-baustein', bausteinId);
    await loadBausteineView();
    bausteineShowStatus(`Baustein "${baustein.name}" gelöscht`, 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
}

async function bausteinResetBaustein(bausteinId) {
  let baustein = null;
  for (const cat of bausteineData.categories) {
    baustein = cat.bausteine.find(b => b.id === bausteinId);
    if (baustein) break;
  }
  if (!baustein) return;

  const confirmed = await ipcRenderer.invoke('confirm-reset-baustein', baustein.name);
  if (!confirmed) return;

  try {
    await ipcRenderer.invoke('reset-baustein', bausteinId);
    await loadBausteineView();
    bausteineShowStatus(`"${baustein.name}" zurückgesetzt`, 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
}

// Bausteine Toolbar Buttons
document.getElementById('bausteineAddCategoryBtn').addEventListener('click', () => {
  document.getElementById('bausteineNewCategoryName').value = '';
  document.getElementById('bausteineNewCategoryModal').classList.add('active');
  document.getElementById('bausteineNewCategoryName').focus();
});

document.getElementById('bausteineExportBtn').addEventListener('click', async () => {
  const data = await ipcRenderer.invoke('export-bausteine');
  document.getElementById('bausteineExportData').value = data;
  document.getElementById('bausteineExportModal').classList.add('active');
});

document.getElementById('bausteineImportBtn').addEventListener('click', () => {
  document.getElementById('bausteineImportData').value = '';
  document.getElementById('bausteineImportModal').classList.add('active');
});

document.getElementById('bausteineResetAllBtn').addEventListener('click', async () => {
  const confirmed = await ipcRenderer.invoke('confirm-reset-all-bausteine');
  if (!confirmed) return;

  try {
    await ipcRenderer.invoke('reset-all-bausteine');
    await loadBausteineView();
    bausteineHasUnsavedChanges = false;
    document.getElementById('bausteineSaveBtn').disabled = true;
    bausteineShowStatus('Alle Bausteine zurückgesetzt', 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
});

document.getElementById('bausteineChangePathBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('select-folder');
  if (!result) return;

  const newPath = result + '\\bausteine.json';
  const dialogResult = await ipcRenderer.invoke('show-bausteine-path-dialog', newPath);

  if (dialogResult.action === 'cancel') return;

  if (dialogResult.action === 'copy_current') {
    await ipcRenderer.invoke('copy-bausteine-to-path', newPath);
  } else {
    await ipcRenderer.invoke('set-bausteine-path', newPath);
  }

  document.getElementById('bausteinePathDisplay').textContent = newPath;
  await loadBausteineView();
  bausteineHasUnsavedChanges = false;
  document.getElementById('bausteineSaveBtn').disabled = true;
  bausteineShowStatus('Speicherort geändert', 'success');
});

document.getElementById('bausteineOpenFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('bausteinePathDisplay').textContent;
  const folderPath = path.substring(0, path.lastIndexOf('\\'));
  await ipcRenderer.invoke('open-folder', folderPath);
});

document.getElementById('bausteineSaveBtn').addEventListener('click', async () => {
  try {
    await ipcRenderer.invoke('save-bausteine-with-categories', bausteineData);
    bausteineHasUnsavedChanges = false;
    bausteineShowStatus('Gespeichert!', 'success');
    document.getElementById('bausteineSaveBtn').disabled = true;
    await loadBausteineView();
  } catch (error) {
    bausteineShowStatus('Fehler beim Speichern: ' + error.message, 'error');
  }
});

// Bausteine Modal handlers
document.getElementById('bausteineCloseExportModal').addEventListener('click', () => {
  document.getElementById('bausteineExportModal').classList.remove('active');
});

document.getElementById('bausteineCopyExportBtn').addEventListener('click', () => {
  const data = document.getElementById('bausteineExportData').value;
  navigator.clipboard.writeText(data);
  bausteineShowStatus('In Zwischenablage kopiert!', 'success');
});

document.getElementById('bausteineCloseImportModal').addEventListener('click', () => {
  document.getElementById('bausteineImportModal').classList.remove('active');
});

document.getElementById('bausteineDoImportBtn').addEventListener('click', async () => {
  const data = document.getElementById('bausteineImportData').value;
  try {
    await ipcRenderer.invoke('import-bausteine', data);
    await loadBausteineView();
    document.getElementById('bausteineImportModal').classList.remove('active');
    bausteineShowStatus('Bausteine importiert!', 'success');
  } catch (error) {
    bausteineShowStatus('Import fehlgeschlagen: ' + error.message, 'error');
  }
});

document.getElementById('bausteineCloseCategoryModal').addEventListener('click', () => {
  document.getElementById('bausteineNewCategoryModal').classList.remove('active');
});

document.getElementById('bausteineCreateCategoryBtn').addEventListener('click', async () => {
  const name = document.getElementById('bausteineNewCategoryName').value.trim();
  if (!name) return;

  try {
    await ipcRenderer.invoke('create-category', name);
    await loadBausteineView();
    document.getElementById('bausteineNewCategoryModal').classList.remove('active');
    bausteineShowStatus(`Kategorie "${name}" erstellt`, 'success');
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
});

document.getElementById('bausteineCloseBausteinModal').addEventListener('click', () => {
  document.getElementById('bausteineNewBausteinModal').classList.remove('active');
});

document.getElementById('bausteineCreateBausteinBtn').addEventListener('click', async () => {
  const name = document.getElementById('bausteineNewBausteinName').value.trim();
  if (!name || !bausteineCategoryForNewBaustein) return;

  try {
    const result = await ipcRenderer.invoke('create-baustein', bausteineCategoryForNewBaustein, {
      name,
      standardText: 'Aufklärungstext hier eingeben...',
      keywords: []
    });
    await loadBausteineView();
    document.getElementById('bausteineNewBausteinModal').classList.remove('active');
    bausteineShowStatus(`Baustein "${name}" erstellt`, 'success');

    bausteineOpenBausteinId = result.baustein.id;
    renderBausteineCategories();
  } catch (error) {
    bausteineShowStatus('Fehler: ' + error.message, 'error');
  }
});

// Modal Enter key handlers
document.getElementById('bausteineNewCategoryName').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('bausteineCreateCategoryBtn').click();
});

document.getElementById('bausteineNewBausteinName').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('bausteineCreateBausteinBtn').click();
});

// Bausteine Unsaved Changes Modal handlers
document.getElementById('bausteineSaveAndContinue').addEventListener('click', async () => {
  try {
    await ipcRenderer.invoke('save-bausteine-with-categories', bausteineData);
    bausteineHasUnsavedChanges = false;
    document.getElementById('bausteineSaveBtn').disabled = true;
    document.getElementById('bausteineUnsavedModal').classList.remove('active');
  } catch (error) {
    bausteineShowStatus('Fehler beim Speichern: ' + error.message, 'error');
  }
});

document.getElementById('bausteineDiscardChanges').addEventListener('click', async () => {
  bausteineHasUnsavedChanges = false;
  await loadBausteineView();
  document.getElementById('bausteineUnsavedModal').classList.remove('active');
});

document.getElementById('bausteineCloseUnsavedModal').addEventListener('click', () => {
  document.getElementById('bausteineUnsavedModal').classList.remove('active');
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
        element: '#settings-section-bausteine-path',
        popover: {
          title: 'Bausteine',
          description: 'Bausteine sind vordefinierte Textvorlagen, die automatisch in Ihre Dokumentation eingefügt werden können.',
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '#settings-section-docmode',
        popover: {
          title: 'Dokumentations-Modus',
          description: 'Single Prompt: Schnelle Dokumentation. Agent-Kette: Erkennt Behandlungstypen und fügt passende Bausteine automatisch ein.',
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

document.getElementById('settingsStartTourBtn').addEventListener('click', () => {
  const tourDriver = createSettingsTour();
  if (tourDriver) {
    tourDriver.drive();
  } else {
    alert('Tour-Funktion ist nicht verfügbar.');
  }
});


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
    case 'bausteine':
      loadBausteineView();
      break;
    case 'textbausteine':
      loadTextbausteineView();
      break;
    case 'themen':
      loadThemenView();
      break;
    case 'subscription':
      loadSubscriptionView();
      break;
  }
}

// Also load device usage on home stats
const originalLoadHomeStats = loadHomeStats;
async function loadHomeStatsWithDevices() {
  try {
    const stats = await ipcRenderer.invoke('get-dashboard-stats');

    document.getElementById('todayRecordings').textContent = stats.todayRecordings || 0;
    document.getElementById('profileCount').textContent = stats.profileCount || 0;

    const shortcut = await ipcRenderer.invoke('get-shortcut');
    document.getElementById('shortcutKey').textContent = shortcut || 'F9';
    document.getElementById('homeShortcutKey').textContent = shortcut || 'F9';

    // Load device usage
    try {
      const subData = await ipcRenderer.invoke('get-subscription-details');
      const deviceUsage = `${subData.activeDevices || 0}/${subData.maxDevices || 0}`;
      document.getElementById('deviceUsage').textContent = deviceUsage;
    } catch (e) {
      document.getElementById('deviceUsage').textContent = '-/-';
    }

    // Load iPhone dashboard section if iPhone is selected
    await loadIphoneDashboardSection(shortcut || 'F9');

    // Load last documentation
    await loadLastDocumentation();
  } catch (error) {
    console.error('Error loading home stats:', error);
  }
}

// Override loadHomeStats
loadHomeStats = loadHomeStatsWithDevices;

// =============================================================================
// TEXTBAUSTEINE V1.2 VIEW
// =============================================================================

let textbausteineData = {};
let textbausteineEditingKey = null;

async function loadTextbausteineView() {
  const statusEl = document.getElementById('textbausteineStatus');
  const listEl = document.getElementById('textbausteineList');
  const emptyEl = document.getElementById('textbausteineEmpty');

  // Show loading
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Lade Einstellungen vom Server...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    if (!token) {
      statusEl.innerHTML = '<span class="status-indicator error"></span><span>Nicht angemeldet</span>';
      return;
    }

    const response = await ipcRenderer.invoke('api-get-praxis-einstellungen', token);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    textbausteineData = response.einstellungen?.textbausteine || {};

    const isDefault = response.isDefault;
    const count = Object.keys(textbausteineData).length;

    statusEl.innerHTML = `<span class="status-indicator"></span><span>${count} Textbausteine geladen${isDefault ? ' (Standard)' : ''}</span>`;

    renderTextbausteine();
  } catch (error) {
    console.error('Error loading Textbausteine:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler beim Laden: ${error.message}</span>`;
  }
}

function renderTextbausteine() {
  const listEl = document.getElementById('textbausteineList');
  const emptyEl = document.getElementById('textbausteineEmpty');

  const keys = Object.keys(textbausteineData);

  if (keys.length === 0) {
    emptyEl.style.display = 'flex';
    // Clear any existing items
    listEl.querySelectorAll('.textbausteine-item').forEach(el => el.remove());
    return;
  }

  emptyEl.style.display = 'none';

  // Clear existing items
  listEl.querySelectorAll('.textbausteine-item').forEach(el => el.remove());

  // Add items
  keys.sort().forEach(key => {
    const text = textbausteineData[key];
    const item = document.createElement('div');
    item.className = 'textbausteine-item';
    item.innerHTML = `
      <div class="textbausteine-item-header">
        <span class="textbausteine-item-key">${escapeHtml(key)}</span>
        <div class="textbausteine-item-actions">
          <button class="edit" data-key="${escapeHtml(key)}">Bearbeiten</button>
          <button class="delete" data-key="${escapeHtml(key)}">Löschen</button>
        </div>
      </div>
      <div class="textbausteine-item-content">${escapeHtml(text)}</div>
    `;
    listEl.appendChild(item);
  });

  // Add event listeners
  listEl.querySelectorAll('.textbausteine-item-actions .edit').forEach(btn => {
    btn.addEventListener('click', () => openTextbausteineModal(btn.dataset.key));
  });

  listEl.querySelectorAll('.textbausteine-item-actions .delete').forEach(btn => {
    btn.addEventListener('click', () => deleteTextbaustein(btn.dataset.key));
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function openTextbausteineModal(key = null) {
  const modal = document.getElementById('textbausteineModal');
  const titleEl = document.getElementById('textbausteineModalTitle');
  const keyInput = document.getElementById('textbausteineKey');
  const textInput = document.getElementById('textbausteineText');

  textbausteineEditingKey = key;

  if (key) {
    titleEl.textContent = 'Textbaustein bearbeiten';
    keyInput.value = key;
    keyInput.disabled = true;
    textInput.value = textbausteineData[key] || '';
  } else {
    titleEl.textContent = 'Neuer Textbaustein';
    keyInput.value = '';
    keyInput.disabled = false;
    textInput.value = '';
  }

  modal.classList.add('active');
  if (!key) {
    keyInput.focus();
  } else {
    textInput.focus();
  }
}

function closeTextbausteineModal() {
  const modal = document.getElementById('textbausteineModal');
  modal.classList.remove('active');
  textbausteineEditingKey = null;
}

async function saveTextbaustein() {
  const keyInput = document.getElementById('textbausteineKey');
  const textInput = document.getElementById('textbausteineText');
  const statusEl = document.getElementById('textbausteineStatus');

  const key = keyInput.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const text = textInput.value.trim();

  if (!key) {
    alert('Bitte geben Sie einen Schlüssel ein.');
    return;
  }

  if (!text) {
    alert('Bitte geben Sie einen Text ein.');
    return;
  }

  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Speichere...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    const response = await ipcRenderer.invoke('api-add-textbaustein', token, key, text);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    textbausteineData = response.einstellungen?.textbausteine || {};
    renderTextbausteine();
    closeTextbausteineModal();

    const count = Object.keys(textbausteineData).length;
    statusEl.innerHTML = `<span class="status-indicator"></span><span>${count} Textbausteine - Gespeichert!</span>`;
  } catch (error) {
    console.error('Error saving Textbaustein:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

async function deleteTextbaustein(key) {
  const confirmed = await ipcRenderer.invoke('confirm-delete-textbaustein', key);
  if (!confirmed) {
    return;
  }

  const statusEl = document.getElementById('textbausteineStatus');
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Lösche...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    const response = await ipcRenderer.invoke('api-remove-textbaustein', token, key);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    textbausteineData = response.einstellungen?.textbausteine || {};
    renderTextbausteine();

    const count = Object.keys(textbausteineData).length;
    statusEl.innerHTML = `<span class="status-indicator"></span><span>${count} Textbausteine - Gelöscht!</span>`;
  } catch (error) {
    console.error('Error deleting Textbaustein:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

async function resetTextbausteine() {
  const confirmed = await ipcRenderer.invoke('confirm-reset-textbausteine');
  if (!confirmed) {
    return;
  }

  const statusEl = document.getElementById('textbausteineStatus');
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Setze zurück...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    const response = await ipcRenderer.invoke('api-reset-praxis-einstellungen', token);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    textbausteineData = response.einstellungen?.textbausteine || {};
    renderTextbausteine();

    statusEl.innerHTML = '<span class="status-indicator"></span><span>Auf Standard zurückgesetzt</span>';
  } catch (error) {
    console.error('Error resetting:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

// Textbausteine Event Listeners
document.getElementById('textbausteineAddBtn')?.addEventListener('click', () => openTextbausteineModal());
document.getElementById('textbausteineAddFirstBtn')?.addEventListener('click', () => openTextbausteineModal());
document.getElementById('textbausteineRefreshBtn')?.addEventListener('click', loadTextbausteineView);
document.getElementById('textbausteineResetBtn')?.addEventListener('click', resetTextbausteine);
document.getElementById('textbausteineSaveBtn')?.addEventListener('click', saveTextbaustein);
document.getElementById('textbausteineCloseModal')?.addEventListener('click', closeTextbausteineModal);

// Close modal on overlay click
document.getElementById('textbausteineModal')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    closeTextbausteineModal();
  }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('textbausteineModal');
    if (modal?.classList.contains('active')) {
      closeTextbausteineModal();
    }
    const themenModal = document.getElementById('themenModal');
    if (themenModal?.classList.contains('active')) {
      closeThemenModal();
    }
  }
});

// =============================================================================
// THEMEN-ANPASSUNGEN V1.2
// =============================================================================

// =============================================================================
// THEMEN VIEW V2 (Vollständig dynamisch)
// =============================================================================

// Themen-Daten (neues Format mit themen-Array)
let themenData = [];
let defaultThemen = [];
let editingThemaName = null; // Name des aktuell bearbeiteten Themas (null = neues Thema)

async function loadThemenView() {
  const statusEl = document.getElementById('themenStatus');
  const listEl = document.getElementById('themenList');
  const emptyEl = document.getElementById('themenEmpty');
  const countEl = document.getElementById('themenCount');

  // Show loading
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Lade Einstellungen vom Server...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    if (!token) {
      statusEl.innerHTML = '<span class="status-indicator error"></span><span>Nicht angemeldet</span>';
      return;
    }

    const response = await ipcRenderer.invoke('api-get-praxis-einstellungen', token);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    // Neues Format: themen-Array
    themenData = response.einstellungen?.themen || [];
    defaultThemen = response.defaultThemen || [];

    const isDefault = response.isDefault;
    const count = themenData.length;

    statusEl.innerHTML = `<span class="status-indicator"></span><span>${count} Themen aktiv${isDefault ? ' (Standard)' : ''}</span>`;
    countEl.textContent = `${count} Themen`;

    renderThemen();
  } catch (error) {
    console.error('Error loading Themen:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler beim Laden: ${error.message}</span>`;
  }
}

function renderThemen() {
  const listEl = document.getElementById('themenList');
  const emptyEl = document.getElementById('themenEmpty');

  // Clear existing items
  listEl.querySelectorAll('.themen-item').forEach(el => el.remove());

  if (themenData.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  // Render all themen
  themenData.forEach(thema => {
    const hasPflichtfelder = thema.pflichtfelder && thema.pflichtfelder.length > 0;
    const hasHinweis = !!thema.hinweistext;
    const hasAntiSplit = thema.antiSplit && thema.antiSplit.length > 0;

    const item = document.createElement('div');
    item.className = 'themen-item' + (hasPflichtfelder ? ' has-anpassung' : '');

    let contentHtml = '';

    // Pflichtfelder
    if (hasPflichtfelder) {
      const pflichtfelderHtml = thema.pflichtfelder
        .map(pf => `<span class="pflichtfeld">${escapeHtml(pf)}</span>`)
        .join('');
      contentHtml += `<div class="themen-item-pflichtfelder">${pflichtfelderHtml}</div>`;
    }

    // Hinweistext
    if (hasHinweis) {
      contentHtml += `<div class="themen-item-hinweis">${escapeHtml(thema.hinweistext)}</div>`;
    }

    // Anti-Split
    if (hasAntiSplit) {
      contentHtml += `<div class="themen-item-antisplit">Anti-Split: ${thema.antiSplit.map(s => escapeHtml(s)).join(', ')}</div>`;
    }

    if (!contentHtml) {
      contentHtml = '<div class="themen-item-no-config">Keine Pflichtfelder konfiguriert</div>';
    }

    item.innerHTML = `
      <div class="themen-item-header">
        <span class="themen-item-name">
          ${escapeHtml(thema.name)}
          ${hasPflichtfelder ? '<span class="badge">Konfiguriert</span>' : ''}
        </span>
        <div class="themen-item-actions">
          <button class="edit" data-thema="${escapeHtml(thema.name)}">Bearbeiten</button>
          <button class="delete" data-thema="${escapeHtml(thema.name)}">Löschen</button>
        </div>
      </div>
      <div class="themen-item-content">${contentHtml}</div>
    `;
    listEl.appendChild(item);
  });

  // Add event listeners
  listEl.querySelectorAll('.themen-item-actions .edit').forEach(btn => {
    btn.addEventListener('click', () => openThemenModal(btn.dataset.thema));
  });

  listEl.querySelectorAll('.themen-item-actions .delete').forEach(btn => {
    btn.addEventListener('click', () => deleteThema(btn.dataset.thema));
  });
}

function openThemenModal(themaName = null) {
  const modal = document.getElementById('themenModal');
  const titleEl = document.getElementById('themenModalTitle');
  const themaNameInput = document.getElementById('themenModalThemaName');
  const pflichtfelderInput = document.getElementById('themenPflichtfelder');
  const hinweistextInput = document.getElementById('themenHinweistext');
  const antiSplitInput = document.getElementById('themenAntiSplit');

  editingThemaName = themaName;

  if (themaName) {
    // Bearbeiten
    const thema = themenData.find(t => t.name === themaName);
    titleEl.textContent = 'Thema bearbeiten';
    themaNameInput.value = thema?.name || '';
    themaNameInput.disabled = true; // Name kann nicht geändert werden beim Bearbeiten
    pflichtfelderInput.value = (thema?.pflichtfelder || []).join(', ');
    hinweistextInput.value = thema?.hinweistext || '';
    antiSplitInput.value = (thema?.antiSplit || []).join(', ');
  } else {
    // Neues Thema
    titleEl.textContent = 'Neues Thema hinzufügen';
    themaNameInput.value = '';
    themaNameInput.disabled = false;
    pflichtfelderInput.value = '';
    hinweistextInput.value = '';
    antiSplitInput.value = '';
  }

  modal.classList.add('active');
  if (themaName) {
    pflichtfelderInput.focus();
  } else {
    themaNameInput.focus();
  }
}

function closeThemenModal() {
  const modal = document.getElementById('themenModal');
  modal.classList.remove('active');
  editingThemaName = null;
}

async function saveThema() {
  const themaNameInput = document.getElementById('themenModalThemaName');
  const pflichtfelderInput = document.getElementById('themenPflichtfelder');
  const hinweistextInput = document.getElementById('themenHinweistext');
  const antiSplitInput = document.getElementById('themenAntiSplit');
  const statusEl = document.getElementById('themenStatus');

  const name = themaNameInput.value.trim();
  const pflichtfelderRaw = pflichtfelderInput.value.trim();
  const hinweistext = hinweistextInput.value.trim();
  const antiSplitRaw = antiSplitInput.value.trim();

  if (!name) {
    alert('Bitte geben Sie einen Namen für das Thema ein.');
    return;
  }

  // Check for duplicate name when creating new
  if (!editingThemaName && themenData.some(t => t.name === name)) {
    alert('Ein Thema mit diesem Namen existiert bereits.');
    return;
  }

  // Parse arrays
  const pflichtfelder = pflichtfelderRaw
    .split(',')
    .map(f => f.trim())
    .filter(f => f.length > 0);

  const antiSplit = antiSplitRaw
    .split(',')
    .map(f => f.trim())
    .filter(f => f.length > 0);

  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Speichere...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');

    // Build thema object
    const thema = {
      name,
      pflichtfelder,
      hinweistext: hinweistext || undefined,
      antiSplit: antiSplit.length > 0 ? antiSplit : undefined
    };

    const response = await ipcRenderer.invoke('api-update-praxis-einstellungen', token, {
      addThema: thema
    });

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    themenData = response.einstellungen?.themen || [];
    renderThemen();
    closeThemenModal();

    const count = themenData.length;
    document.getElementById('themenCount').textContent = `${count} Themen`;
    statusEl.innerHTML = `<span class="status-indicator"></span><span>Gespeichert!</span>`;
  } catch (error) {
    console.error('Error saving Thema:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

async function deleteThema(themaName) {
  const confirmed = await ipcRenderer.invoke('confirm-delete-thema', themaName);
  if (!confirmed) {
    return;
  }

  const statusEl = document.getElementById('themenStatus');
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Lösche...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    const response = await ipcRenderer.invoke('api-update-praxis-einstellungen', token, {
      removeThema: themaName
    });

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    themenData = response.einstellungen?.themen || [];
    renderThemen();

    const count = themenData.length;
    document.getElementById('themenCount').textContent = `${count} Themen`;
    statusEl.innerHTML = `<span class="status-indicator"></span><span>Gelöscht!</span>`;
  } catch (error) {
    console.error('Error deleting Thema:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

async function resetThemen() {
  const confirmed = await ipcRenderer.invoke('confirm-reset-themen');
  if (!confirmed) {
    return;
  }

  const statusEl = document.getElementById('themenStatus');
  statusEl.innerHTML = '<span class="status-indicator loading"></span><span>Setze zurück...</span>';

  try {
    const token = await ipcRenderer.invoke('get-token');
    const response = await ipcRenderer.invoke('api-reset-praxis-einstellungen', token);

    if (response.error) {
      statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${response.error}</span>`;
      return;
    }

    themenData = response.einstellungen?.themen || [];
    renderThemen();

    const count = themenData.length;
    document.getElementById('themenCount').textContent = `${count} Themen`;
    statusEl.innerHTML = '<span class="status-indicator"></span><span>Auf Standard zurückgesetzt</span>';
  } catch (error) {
    console.error('Error resetting:', error);
    statusEl.innerHTML = `<span class="status-indicator error"></span><span>Fehler: ${error.message}</span>`;
  }
}

// Themen Event Listeners
document.getElementById('themenRefreshBtn')?.addEventListener('click', loadThemenView);
document.getElementById('themenResetBtn')?.addEventListener('click', resetThemen);
document.getElementById('themenAddBtn')?.addEventListener('click', () => openThemenModal(null));
document.getElementById('themenSaveBtn')?.addEventListener('click', saveThema);
document.getElementById('themenCloseModal')?.addEventListener('click', closeThemenModal);

// Close modal on overlay click
document.getElementById('themenModal')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    closeThemenModal();
  }
});


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
  }
});

