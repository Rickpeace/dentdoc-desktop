/**
 * Tray management for DentDoc Desktop
 * Handles system tray icon, context menu, and interactions
 */

const { Tray, Menu, app } = require('electron');
const path = require('path');

let tray = null;

// These will be set by init()
let store = null;
let callbacks = {
  refreshUserData: null,
  openLocalDashboard: null,
  createLoginWindow: null,
  startRecording: null,
  stopRecording: null,
  showLastResult: null,
  selectAndTranscribeAudioFile: null,
  openWebDashboard: null,
  showCustomNotification: null,
  updateStatusOverlay: null,
  logout: null,
  getState: null  // Returns { isRecording, isProcessing, lastDocumentation }
};

/**
 * Initialize tray module with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.store - electron-store instance
 * @param {Function} deps.refreshUserData - Function to refresh user data
 * @param {Function} deps.openLocalDashboard - Function to open local dashboard
 * @param {Function} deps.createLoginWindow - Function to create login window
 * @param {Function} deps.startRecording - Function to start recording
 * @param {Function} deps.stopRecording - Function to stop recording
 * @param {Function} deps.showLastResult - Function to show last result
 * @param {Function} deps.selectAndTranscribeAudioFile - Function to select and transcribe audio file
 * @param {Function} deps.openWebDashboard - Function to open web dashboard
 * @param {Function} deps.showCustomNotification - Function to show custom notification
 * @param {Function} deps.updateStatusOverlay - Function to update status overlay
 * @param {Function} deps.logout - Function to handle logout
 * @param {Function} deps.getState - Function that returns current state object
 */
function init(deps) {
  store = deps.store;
  callbacks.refreshUserData = deps.refreshUserData;
  callbacks.openLocalDashboard = deps.openLocalDashboard;
  callbacks.createLoginWindow = deps.createLoginWindow;
  callbacks.startRecording = deps.startRecording;
  callbacks.stopRecording = deps.stopRecording;
  callbacks.showLastResult = deps.showLastResult;
  callbacks.selectAndTranscribeAudioFile = deps.selectAndTranscribeAudioFile;
  callbacks.openWebDashboard = deps.openWebDashboard;
  callbacks.showCustomNotification = deps.showCustomNotification;
  callbacks.updateStatusOverlay = deps.updateStatusOverlay;
  callbacks.logout = deps.logout;
  callbacks.getState = deps.getState;
}

/**
 * Create the system tray icon and set up event handlers
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);

  // Don't set a static context menu - we'll show it dynamically on right-click
  // This allows us to refresh user data before showing the menu
  tray.setToolTip('DentDoc - Bereit zum Aufnehmen');

  // Cooldown to prevent too many API calls
  let lastRefreshTime = 0;
  const REFRESH_COOLDOWN = 10000; // Only refresh every 10 seconds max

  // Right-click: Refresh data, then show menu
  tray.on('right-click', async () => {
    const token = store.get('authToken');
    const now = Date.now();

    // Refresh user data if logged in and cooldown has passed
    if (token && (now - lastRefreshTime) > REFRESH_COOLDOWN) {
      lastRefreshTime = now;
      if (callbacks.refreshUserData) await callbacks.refreshUserData();
    }

    // Build and show menu with current data
    const menu = buildTrayMenu();
    tray.popUpContextMenu(menu);
  });

  // Left-click: Open dashboard window (or login if not authenticated)
  tray.on('click', () => {
    const token = store.get('authToken');
    if (token) {
      if (callbacks.openLocalDashboard) callbacks.openLocalDashboard();
    } else {
      if (callbacks.createLoginWindow) callbacks.createLoginWindow();
    }
  });
}

/**
 * Build and return the tray menu (called dynamically on right-click)
 * @returns {Menu} The built menu
 */
function buildTrayMenu() {
  const token = store.get('authToken');
  const user = store.get('user');
  const state = callbacks.getState ? callbacks.getState() : { isRecording: false, isProcessing: false, lastDocumentation: null };

  if (!token) {
    return Menu.buildFromTemplate([
      { label: 'Anmelden', click: () => callbacks.createLoginWindow && callbacks.createLoginWindow() },
      { type: 'separator' },
      { label: 'Beenden', click: () => app.quit() }
    ]);
  }

  const shortcut = store.get('shortcut') || 'F9';

  // Check subscription/trial status (matching web app logic)
  const hasActiveSubscription = user?.subscriptionStatus === 'active';
  const isCanceled = user?.subscriptionStatus === 'canceled';
  const minutesRemaining = user?.minutesRemaining || 0;

  // Distinguish between true trial users and ex-subscribers
  // Ex-subscriber: has stripeCustomerId (was once a paying customer) or subscription is canceled
  const wasSubscriber = isCanceled || (user?.planTier === 'free_trial' && user?.stripeCustomerId);
  const isRealTrial = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining > 0;
  const trialExpired = user?.planTier === 'free_trial' && !wasSubscriber && minutesRemaining <= 0 && !hasActiveSubscription;

  // No active subscription (either trial expired or was subscriber)
  const noActiveSubscription = !hasActiveSubscription && (trialExpired || wasSubscriber);

  // Determine menu label based on state
  let recordingLabel;
  let recordingEnabled = true;
  if (state.isProcessing) {
    recordingLabel = '⏳ Verarbeitung läuft...';
    recordingEnabled = false;
  } else if (state.isRecording) {
    recordingLabel = `⏺ Aufnahme stoppen (${shortcut})`;
  } else {
    recordingLabel = `▶ Aufnahme starten (${shortcut})`;
    // Disable if no active subscription
    if (noActiveSubscription) {
      recordingEnabled = false;
    }
  }

  // Build status label for trial/subscription (matching web app)
  let statusLabel;
  if (hasActiveSubscription && user?.cancelAtPeriodEnd) {
    const endDate = user?.currentPeriodEnd
      ? new Date(user.currentPeriodEnd).toLocaleDateString('de-DE')
      : '';
    statusLabel = `⚠️ Abo gekündigt (bis ${endDate})`;
  } else if (hasActiveSubscription) {
    statusLabel = `✓ DentDoc Pro (${user?.maxDevices || 1} Lizenz${(user?.maxDevices || 1) !== 1 ? 'en' : ''})`;
  } else if (isRealTrial) {
    statusLabel = `Testphase: ${minutesRemaining} Min übrig`;
  } else if (wasSubscriber) {
    // Was a subscriber but now canceled/expired - same as web app
    statusLabel = '⚠️ KEIN AKTIVES ABO';
  } else if (trialExpired) {
    // True trial user who never subscribed
    statusLabel = '⚠️ TESTPHASE BEENDET';
  } else {
    statusLabel = 'Kein aktives Abo';
  }

  return Menu.buildFromTemplate([
    // Status display - clickable if trial expired to open subscription page
    {
      label: statusLabel,
      enabled: trialExpired ? true : false,
      click: trialExpired ? () => callbacks.openWebDashboard && callbacks.openWebDashboard('/subscription') : undefined,
    },
    // If trial expired or no subscription, show upgrade link
    ...(trialExpired || (!hasActiveSubscription && !isRealTrial) ? [{
      label: '🛒 JETZT ABO KAUFEN →',
      click: () => {
        if (callbacks.openWebDashboard) callbacks.openWebDashboard('/subscription');
      }
    }] : []),
    { type: 'separator' },
    {
      label: recordingLabel,
      enabled: recordingEnabled,
      click: async () => {
        if (state.isRecording) {
          if (callbacks.stopRecording) callbacks.stopRecording();
        } else {
          // Show immediate feedback before startRecording() does async work
          if (callbacks.updateStatusOverlay) {
            callbacks.updateStatusOverlay('Aufnahme wird gestartet...', 'Bitte warten...', 'starting');
          }
          if (callbacks.startRecording) await callbacks.startRecording();
        }
      }
    },
    {
      label: 'Audio-Datei transkribieren...',
      enabled: !state.isRecording && !state.isProcessing && !noActiveSubscription,
      click: () => {
        if (callbacks.selectAndTranscribeAudioFile) callbacks.selectAndTranscribeAudioFile();
      }
    },
    {
      label: 'Letzte Dokumentation anzeigen',
      enabled: state.lastDocumentation !== null,
      click: () => {
        if (callbacks.showLastResult) callbacks.showLastResult();
      }
    },
    { type: 'separator' },
    {
      label: 'App öffnen',
      click: () => {
        if (callbacks.openLocalDashboard) callbacks.openLocalDashboard();
      }
    },
    { type: 'separator' },
    {
      label: 'Abmelden',
      click: async () => {
        if (callbacks.logout) await callbacks.logout();
      }
    },
    { type: 'separator' },
    { label: 'Beenden', click: () => {
      app.isQuitting = true;
      app.quit();
    }},
    { type: 'separator' },
    { label: `v${app.getVersion()}`, enabled: false }
  ]);
}

/**
 * Legacy function for compatibility - menu is built dynamically on right-click
 */
function updateTrayMenu() {
  // No longer sets a static menu - menu is built dynamically on right-click
  // This function is kept for compatibility with other code that calls it
}

/**
 * Get the tray instance
 * @returns {Tray|null} The tray instance
 */
function getTray() {
  return tray;
}

module.exports = {
  init,
  createTray,
  buildTrayMenu,
  updateTrayMenu,
  getTray
};
