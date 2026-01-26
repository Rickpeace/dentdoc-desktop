/**
 * Notification utilities for DentDoc Desktop
 * Handles both native OS notifications and custom popup windows
 */

const { BrowserWindow, Notification, ipcMain, screen } = require('electron');
const path = require('path');

// State for custom notification popup
let notificationPopupWindow = null;
let notificationClickCallback = null;

/**
 * Show a native OS notification
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {Function|null} onClick - Optional click callback
 */
function showNotification(title, body, onClick = null) {
  const notification = new Notification({
    title,
    body,
    icon: path.join(__dirname, '..', 'assets', 'icon.png')
  });

  if (onClick) {
    notification.on('click', onClick);
  }

  notification.show();
}

/**
 * Show a custom styled notification popup window
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {string} type - Notification type: 'warning', 'success', 'error', 'info'
 * @param {Function|null} onClick - Optional click callback
 */
function showCustomNotification(title, body, type = 'warning', onClick = null) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  // Close existing popup if any
  if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
    notificationPopupWindow.close();
  }

  notificationClickCallback = onClick;

  notificationPopupWindow = new BrowserWindow({
    width: 380,
    height: 160,
    x: workArea.x + workArea.width - 400,
    y: workArea.y + workArea.height - 180,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  notificationPopupWindow.loadFile(path.join(__dirname, 'notification-popup.html'));

  notificationPopupWindow.webContents.on('did-finish-load', () => {
    // Check if window still exists (could be closed rapidly)
    if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
      notificationPopupWindow.webContents.send('show-notification', {
        title,
        body,
        type,
        hasClickAction: !!onClick
      });
    }
  });

  notificationPopupWindow.on('closed', () => {
    notificationPopupWindow = null;
    notificationClickCallback = null;
  });
}

/**
 * Initialize IPC handlers for notification popup
 * Must be called once during app initialization
 */
function initNotificationIPC() {
  ipcMain.on('close-notification-popup', () => {
    if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
      notificationPopupWindow.close();
    }
  });

  ipcMain.on('notification-popup-clicked', () => {
    if (notificationClickCallback) {
      notificationClickCallback();
    }
    if (notificationPopupWindow && !notificationPopupWindow.isDestroyed()) {
      notificationPopupWindow.close();
    }
  });
}

module.exports = {
  showNotification,
  showCustomNotification,
  initNotificationIPC
};
