/**
 * Session management for DentDoc Desktop
 * Handles heartbeat to keep device session alive and user data refresh
 */

const apiClient = require('./apiClient');

let heartbeatInterval = null;

// These will be set by init()
let store = null;
let callbacks = {
  updateTrayMenu: null,
  showNotification: null,
  createLoginWindow: null
};

/**
 * Initialize session module with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.store - electron-store instance
 * @param {Function} deps.updateTrayMenu - Function to update tray menu
 * @param {Function} deps.showNotification - Function to show notifications
 * @param {Function} deps.createLoginWindow - Function to create login window
 */
function init(deps) {
  store = deps.store;
  callbacks.updateTrayMenu = deps.updateTrayMenu;
  callbacks.showNotification = deps.showNotification;
  callbacks.createLoginWindow = deps.createLoginWindow;
}

/**
 * Start heartbeat to keep device session active
 * Sends heartbeat every 5 minutes
 */
function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Send heartbeat every 5 minutes (just to keep session alive)
  heartbeatInterval = setInterval(async () => {
    const token = store.get('authToken');
    if (!token) {
      stopHeartbeat();
      return;
    }

    const isValid = await apiClient.heartbeat(token, store);
    if (!isValid) {
      // Session expired - device was logged out remotely
      console.log('Session expired - logging out locally');
      stopHeartbeat();
      store.delete('authToken');
      store.delete('user');
      if (callbacks.updateTrayMenu) callbacks.updateTrayMenu();
      if (callbacks.showNotification) {
        callbacks.showNotification('Sitzung beendet', 'Sie wurden von einem anderen Gerät abgemeldet.');
      }
      if (callbacks.createLoginWindow) callbacks.createLoginWindow();
    }
  }, 5 * 60 * 1000); // 5 minutes

  // Also send immediate heartbeat on start
  const token = store.get('authToken');
  if (token) {
    apiClient.heartbeat(token, store).catch(console.error);
  }
}

/**
 * Refresh user data and check for subscription changes
 */
async function refreshUserData() {
  const token = store.get('authToken');
  if (!token) return;

  try {
    const oldUser = store.get('user');
    const newUser = await apiClient.getUser(token);
    if (newUser) {
      store.set('user', newUser);

      // Check if subscription status changed (e.g., user just subscribed)
      const wasTrialExpired = oldUser?.planTier === 'free_trial' && (oldUser?.minutesRemaining || 0) <= 0 && oldUser?.subscriptionStatus !== 'active';
      const isNowActive = newUser.subscriptionStatus === 'active';

      if (wasTrialExpired && isNowActive) {
        // User just subscribed! Show notification
        if (callbacks.showNotification) {
          callbacks.showNotification(
            '🎉 Willkommen bei DentDoc Pro!',
            `Ihr Abonnement ist jetzt aktiv. Sie können unbegrenzt dokumentieren.`
          );
        }
      }

      if (callbacks.updateTrayMenu) callbacks.updateTrayMenu();
    }
  } catch (e) {
    console.error('[Session] Could not refresh user data:', e.message);
  }
}

/**
 * Stop the heartbeat interval
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

module.exports = {
  init,
  startHeartbeat,
  refreshUserData,
  stopHeartbeat
};
