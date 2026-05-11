/**
 * Recording slot management for license enforcement
 * 1 license = 1 simultaneous recording (not 1 device login)
 *
 * Handles claim/heartbeat/release lifecycle with the backend.
 */

const axios = require('axios');
const os = require('os');

let heartbeatInterval = null;
let heartbeatPending = false;
let heartbeatFailCount = 0;
let apiBaseUrl = null;

/**
 * Initialize with the API base URL
 * @param {string} baseUrl - e.g. 'https://dentdoc.de/'
 */
function init(baseUrl) {
  apiBaseUrl = baseUrl;
}

/**
 * Claim a recording slot from the backend
 * @param {string} token - Auth token
 * @param {string} deviceId - Device UUID
 * @returns {Promise<{recordingId: number}>}
 * @throws Error with 'MAX_RECORDINGS' prefix if all slots are in use
 */
async function claimSlot(token, deviceId) {
  if (!apiBaseUrl) {
    throw new Error('recordingSlot not initialized — call init() first');
  }

  try {
    const response = await axios.post(
      `${apiBaseUrl}api/recording/claim`,
      {
        deviceId,
        deviceName: os.hostname(),
      },
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 5000,
      }
    );

    return { recordingId: response.data.recordingId };
  } catch (error) {
    if (error.response?.data?.error === 'max_recordings_reached') {
      throw new Error(`MAX_RECORDINGS:${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * Start heartbeat to keep recording slot alive (every 60s)
 * @param {string} token - Auth token
 * @param {number} recordingId - Recording slot ID from claimSlot()
 */
function startHeartbeat(token, recordingId) {
  stopHeartbeat();
  heartbeatFailCount = 0;

  heartbeatInterval = setInterval(async () => {
    if (heartbeatPending) return; // Skip if previous heartbeat still in flight
    heartbeatPending = true;
    try {
      await axios.post(
        `${apiBaseUrl}api/recording/heartbeat`,
        { recordingId },
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 5000,
        }
      );
      if (heartbeatFailCount > 0) {
        console.log('[RecordingSlot] Heartbeat recovered after', heartbeatFailCount, 'failures');
      }
      heartbeatFailCount = 0;
    } catch (err) {
      heartbeatFailCount++;
      if (heartbeatFailCount <= 4) {
        console.warn('[RecordingSlot] Heartbeat failed (' + heartbeatFailCount + '/4):', err.message);
      }
    } finally {
      heartbeatPending = false;
    }
  }, 60 * 1000); // 60 seconds
}

/**
 * Release a recording slot (fire-and-forget, idempotent)
 * @param {string} token - Auth token
 * @param {number} recordingId - Recording slot ID
 * @returns {Promise<void>}
 */
async function releaseSlot(token, recordingId) {
  await axios.post(
    `${apiBaseUrl}api/recording/release`,
    { recordingId },
    {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 5000,
    }
  );
}

/**
 * Stop the heartbeat interval
 */
function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  heartbeatPending = false;
  heartbeatFailCount = 0;
}

module.exports = {
  init,
  claimSlot,
  startHeartbeat,
  releaseSlot,
  stopHeartbeat,
};
