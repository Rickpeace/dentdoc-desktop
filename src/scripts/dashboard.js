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

async function loadSettingsView() {
  const settings = await ipcRenderer.invoke('get-settings');

  document.getElementById('settingsCurrentShortcut').textContent = settings.shortcut || 'F9';
  document.getElementById('settingsShortcutDisplay').textContent = settings.shortcut || 'F9';
  settingsSelectedMicId = settings.microphoneId || null;
  document.getElementById('settingsTranscriptPath').value = settings.transcriptPath || '';
  document.getElementById('settingsProfilesPath').value = settings.profilesPath || '';
  document.getElementById('settingsRecordingsPath').value = settings.recordingsPath || '';
  document.getElementById('settingsAutoCloseCheckbox').checked = settings.autoClose || false;
  document.getElementById('settingsAutoExportCheckbox').checked = settings.autoExport || false;
  document.getElementById('settingsKeepAudioCheckbox').checked = settings.keepAudio || false;
  document.getElementById('settingsDocModeSelect').value = settings.docMode || 'single';

  const bausteinePathValue = await ipcRenderer.invoke('get-bausteine-path');
  document.getElementById('settingsBausteinePath').value = bausteinePathValue || '';

  const theme = settings.theme || 'dark';
  document.getElementById('settingsThemeSelect').value = theme;

  await loadSettingsMicrophones();

  settingsInitialSettings = {
    shortcut: settings.shortcut || 'F9',
    microphoneId: settingsSelectedMicId,
    transcriptPath: settings.transcriptPath || '',
    profilesPath: settings.profilesPath || '',
    recordingsPath: settings.recordingsPath || '',
    bausteinePath: bausteinePathValue || '',
    autoClose: settings.autoClose || false,
    autoExport: settings.autoExport || false,
    keepAudio: settings.keepAudio || false,
    docMode: settings.docMode || 'single',
    theme: settings.theme || 'dark'
  };
}

async function loadSettingsMicrophones() {
  const micSelect = document.getElementById('settingsMicSelect');
  try {
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
    transcriptPath: document.getElementById('settingsTranscriptPath').value,
    profilesPath: document.getElementById('settingsProfilesPath').value,
    recordingsPath: document.getElementById('settingsRecordingsPath').value,
    bausteinePath: document.getElementById('settingsBausteinePath').value,
    autoClose: document.getElementById('settingsAutoCloseCheckbox').checked,
    autoExport: document.getElementById('settingsAutoExportCheckbox').checked,
    keepAudio: document.getElementById('settingsKeepAudioCheckbox').checked,
    docMode: document.getElementById('settingsDocModeSelect').value,
    theme: document.getElementById('settingsThemeSelect').value
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

// Settings Mic Test
document.getElementById('settingsTestMicBtn').addEventListener('click', async () => {
  if (settingsIsTesting) {
    settingsStopMicTest();
    return;
  }

  try {
    settingsIsTesting = true;
    const btn = document.getElementById('settingsTestMicBtn');
    btn.textContent = 'Test stoppen';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-danger');

    const constraints = {
      audio: settingsSelectedMicId ? { deviceId: { exact: settingsSelectedMicId } } : true
    };

    settingsMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    settingsAudioContext = new AudioContext();
    const source = settingsAudioContext.createMediaStreamSource(settingsMediaStream);
    settingsAnalyser = settingsAudioContext.createAnalyser();
    settingsAnalyser.fftSize = 256;
    source.connect(settingsAnalyser);

    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Sprechen Sie ins Mikrofon...', 'info');

    const dataArray = new Uint8Array(settingsAnalyser.frequencyBinCount);

    function updateLevel() {
      if (!settingsIsTesting) return;

      settingsAnalyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const level = Math.min(100, (average / 128) * 100);
      document.getElementById('settingsMicLevelBar').style.width = level + '%';

      requestAnimationFrame(updateLevel);
    }

    updateLevel();
  } catch (error) {
    console.error('Mic test error:', error);
    settingsShowStatus(document.getElementById('settingsMicStatus'), 'Fehler: ' + error.message, 'error');
    settingsStopMicTest();
  }
});

function settingsStopMicTest() {
  settingsIsTesting = false;
  const btn = document.getElementById('settingsTestMicBtn');
  btn.textContent = 'Test starten';
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-secondary');
  document.getElementById('settingsMicLevelBar').style.width = '0%';

  if (settingsMediaStream) {
    settingsMediaStream.getTracks().forEach(track => track.stop());
    settingsMediaStream = null;
  }
  if (settingsAudioContext) {
    settingsAudioContext.close();
    settingsAudioContext = null;
  }

  settingsHideStatus(document.getElementById('settingsMicStatus'));
}

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

document.getElementById('settingsBrowseRecordingsBtn').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('select-folder');
  if (result) {
    document.getElementById('settingsRecordingsPath').value = result;
    settingsCheckForChanges();
  }
});

document.getElementById('settingsOpenRecordingsFolderBtn').addEventListener('click', async () => {
  const path = document.getElementById('settingsRecordingsPath').value;
  if (path) {
    await ipcRenderer.invoke('open-folder', path);
  } else {
    await ipcRenderer.invoke('open-temp-folder');
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
    transcriptPath: document.getElementById('settingsTranscriptPath').value,
    profilesPath: document.getElementById('settingsProfilesPath').value,
    recordingsPath: document.getElementById('settingsRecordingsPath').value,
    autoClose: document.getElementById('settingsAutoCloseCheckbox').checked,
    autoExport: document.getElementById('settingsAutoExportCheckbox').checked,
    keepAudio: document.getElementById('settingsKeepAudioCheckbox').checked,
    docMode: document.getElementById('settingsDocModeSelect').value,
    theme: document.getElementById('settingsThemeSelect').value
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
      if (!confirm('Möchten Sie dieses Stimmprofil wirklich löschen?')) return;

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
  if (!confirm(`Textbaustein "${key}" wirklich löschen?`)) {
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
  if (!confirm('Alle Textbausteine auf Standard zurücksetzen? Dies kann nicht rückgängig gemacht werden.')) {
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
  if (!confirm(`Thema "${themaName}" wirklich löschen?`)) {
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
  if (!confirm('Alle Themen auf Standard zurücksetzen? Dies kann nicht rückgängig gemacht werden.')) {
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

