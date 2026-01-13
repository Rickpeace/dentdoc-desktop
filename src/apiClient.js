const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// DentDoc Vercel API URL

const API_BASE_URL = process.env.API_URL || 'https://dentdoc-app.vercel.app/';

/**
 * Get or create a unique device ID for this installation
 * @param {Object} store - electron-store instance
 * @returns {string} Device ID
 */
function getDeviceId(store) {
  let deviceId = store.get('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    store.set('deviceId', deviceId);
  }
  return deviceId;
}

/**
 * Get device info for identification
 * @returns {Object} Device info
 */
function getDeviceInfo() {
  return {
    os: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    arch: os.arch(),
  };
}

/**
 * Login with device tracking
 * @param {string} email
 * @param {string} password
 * @param {Object} store - electron-store instance for device ID
 * @returns {Promise<Object>} Login response with token and user
 */
async function login(email, password, store) {
  try {
    const deviceId = getDeviceId(store);
    const deviceInfo = getDeviceInfo();

    const response = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      email,
      password,
      deviceId,
      deviceName: deviceInfo.hostname,
      deviceInfo,
    });

    return response.data;
  } catch (error) {
    const errorData = error.response?.data;

    // Handle max devices reached error
    if (errorData?.error === 'max_devices_reached') {
      throw new Error(`MAX_DEVICES:${errorData.message}`);
    }

    throw new Error(errorData?.error || 'Login fehlgeschlagen');
  }
}

/**
 * Logout and free device slot
 * @param {string} token - Auth token
 * @param {Object} store - electron-store instance
 * @returns {Promise<void>}
 */
async function logout(token, store) {
  try {
    const deviceId = store.get('deviceId');
    if (!deviceId) return;

    await axios.post(`${API_BASE_URL}/api/auth/logout`,
      { deviceId },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        }
      }
    );
  } catch (error) {
    console.error('Logout error:', error.response?.data || error.message);
    // Don't throw - logout should always succeed locally even if server fails
  }
}

/**
 * Send heartbeat to keep device session active
 * @param {string} token - Auth token
 * @param {Object} store - electron-store instance
 * @returns {Promise<boolean>} True if successful, false if session expired
 */
async function heartbeat(token, store) {
  try {
    const deviceId = store.get('deviceId');
    if (!deviceId) return false;

    const response = await axios.post(`${API_BASE_URL}/api/device/heartbeat`,
      { deviceId },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
        }
      }
    );

    return response.data.success;
  } catch (error) {
    const errorData = error.response?.data;

    // Session expired - device was logged out remotely
    if (errorData?.error === 'session_expired' || error.response?.status === 401) {
      return false;
    }

    console.error('Heartbeat error:', error.response?.data || error.message);
    // Return true on network errors - don't logout user for temporary issues
    return true;
  }
}

async function getUser(token) {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Cookie': `session=${token}`
      }
    });

    return response.data;
  } catch (error) {
    throw new Error('Benutzerdaten konnten nicht abgerufen werden');
  }
}

/**
 * Upload audio file with progress tracking
 * NEW: Direct upload to AssemblyAI (bypasses Vercel 4.5MB limit)
 *
 * Flow:
 * 1. Get upload URL from backend
 * 2. Upload directly to AssemblyAI
 * 3. Tell backend to start transcription
 *
 * @param {string} audioFilePath - Path to audio file
 * @param {string} token - Auth token
 * @param {Function} onProgress - Progress callback: (progressInfo) => void
 *   progressInfo: { phase, percent, message }
 *     - phase: 'prepare' | 'upload' | 'submit' | 'submitted'
 *     - percent: 0-100
 *     - message: Human-readable status
 * @returns {Promise<number>} Transcription ID
 */
async function uploadAudio(audioFilePath, token, onProgress = null) {
  try {
    // Check if file exists and has content
    const stats = fs.statSync(audioFilePath);
    if (stats.size < 5000) {
      throw new Error('EMPTY_RECORDING');
    }

    const fileName = require('path').basename(audioFilePath);
    const fileBuffer = fs.readFileSync(audioFilePath);

    // STEP 1: Get upload URL from backend
    if (onProgress) {
      onProgress({ phase: 'prepare', percent: 5, message: 'Vorbereiten...' });
    }

    const urlResponse = await axios.get(
      `${API_BASE_URL}api/transcriptions/get-upload-url`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`
        },
        timeout: 30000
      }
    );

    const { upload_url } = urlResponse.data;

    if (!upload_url) {
      throw new Error('No upload URL received from server');
    }

    // STEP 2: Upload directly to AssemblyAI (NO Vercel limit!)
    if (onProgress) {
      onProgress({ phase: 'upload', percent: 10, message: 'Upload läuft...' });
    }

    await axios.put(upload_url, fileBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileBuffer.length, // WICHTIG: Sonst hängt AssemblyAI
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 300000, // 5 minutes for large files
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          // Map upload progress to 10-90%
          const percent = Math.round((progressEvent.loaded * 80) / progressEvent.total) + 10;
          onProgress({ phase: 'upload', percent, message: `Upload ${percent}%` });
        }
      }
    });

    // STEP 3: Tell backend to start transcription
    if (onProgress) {
      onProgress({ phase: 'submit', percent: 92, message: 'Starte Transkription...' });
    }

    const startResponse = await axios.post(
      `${API_BASE_URL}api/transcriptions/start`,
      { upload_url, fileName },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (onProgress) {
      onProgress({ phase: 'submitted', percent: 100, message: 'Übermittelt' });
    }

    return startResponse.data.id;

  } catch (error) {
    console.error('Upload error:', error.response?.data || error.message);

    if (error.message === 'EMPTY_RECORDING') {
      throw new Error('Die Aufnahme war zu kurz oder leer. Bitte sprechen Sie mindestens 2-3 Sekunden.');
    }

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Upload-Timeout. Bitte versuchen Sie es erneut.');
    }

    const serverError = error.response?.data?.error;
    if (serverError) {
      // Handle trial expired
      if (serverError === 'trial_expired') {
        throw new Error('TRIAL_EXPIRED:Ihre kostenlosen Testminuten sind aufgebraucht. Bitte abonnieren Sie, um fortzufahren.');
      }
      // Handle subscription inactive
      if (serverError === 'subscription_inactive') {
        throw new Error('SUBSCRIPTION_INACTIVE:Ihr Abonnement ist nicht aktiv. Bitte überprüfen Sie Ihren Zahlungsstatus.');
      }
      // Legacy minutes error
      if (serverError.includes('minutes') || serverError.includes('Minuten')) {
        throw new Error('Nicht genügend Minuten übrig. Bitte laden Sie Ihr Guthaben auf.');
      }
      throw new Error(`Upload fehlgeschlagen: ${serverError}`);
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error('Server nicht erreichbar. Bitte prüfen Sie Ihre Internetverbindung.');
    }

    throw new Error('Audio-Upload fehlgeschlagen. Bitte versuchen Sie es erneut.');
  }
}

async function getDocumentation(transcriptionId, token) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/generate-doc`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!response.data.documentation) {
      throw new Error('NO_DOCUMENTATION');
    }

    // Return both documentation and transcript
    return {
      documentation: response.data.documentation,
      transcript: response.data.transcript || null
    };
  } catch (error) {
    console.error('Documentation error:', error.response?.data || error.message);

    const serverError = error.response?.data?.error;

    // Handle specific error cases
    if (serverError === 'No transcript text available' || error.message === 'NO_DOCUMENTATION') {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    if (serverError?.includes('processing') || serverError?.includes('pending')) {
      throw new Error('Die Transkription wird noch verarbeitet. Bitte warten Sie einen Moment.');
    }

    if (serverError?.includes('minutes') || serverError?.includes('Minuten')) {
      throw new Error('Nicht genügend Minuten übrig. Bitte laden Sie Ihr Guthaben auf.');
    }

    if (serverError) {
      throw new Error(`Fehler: ${serverError}`);
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error('Server nicht erreichbar. Bitte prüfen Sie Ihre Internetverbindung.');
    }

    throw new Error('Dokumentation konnte nicht erstellt werden. Bitte versuchen Sie es erneut.');
  }
}

/**
 * Generate documentation using V1.1 (experimental)
 * @param {number} transcriptionId - Transcription ID
 * @param {string} token - Auth token
 * @returns {Promise<{documentation: string, transcript: string|null}>}
 */
async function getDocumentationV1_1(transcriptionId, token) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/generate-doc-v1.1`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!response.data.documentation) {
      throw new Error('NO_DOCUMENTATION');
    }

    return {
      documentation: response.data.documentation,
      transcript: response.data.transcript || null
    };
  } catch (error) {
    console.error('Documentation V1.1 error:', error.response?.data || error.message);

    const serverError = error.response?.data?.error;

    if (serverError === 'No transcript text available' || error.message === 'NO_DOCUMENTATION') {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    if (serverError?.includes('processing') || serverError?.includes('pending')) {
      throw new Error('Die Transkription wird noch verarbeitet. Bitte warten Sie einen Moment.');
    }

    if (serverError?.includes('minutes') || serverError?.includes('Minuten')) {
      throw new Error('Nicht genügend Minuten übrig. Bitte laden Sie Ihr Guthaben auf.');
    }

    if (serverError) {
      throw new Error(`Fehler: ${serverError}`);
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error('Server nicht erreichbar. Bitte prüfen Sie Ihre Internetverbindung.');
    }

    throw new Error('Dokumentation konnte nicht erstellt werden. Bitte versuchen Sie es erneut.');
  }
}

/**
 * Generate documentation using Agent-Chain (V2) with Bausteine
 * @param {number} transcriptionId - Transcription ID
 * @param {string} token - Auth token
 * @param {Object} bausteine - Bausteine object from settings
 * @returns {Promise<{documentation: string, transcript: string|null}>}
 */
async function getDocumentationV2(transcriptionId, token, bausteine) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/generate-doc-v2`,
      { bausteine },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 180000 // 3 minutes timeout for multi-agent processing
      }
    );

    if (!response.data.documentation) {
      throw new Error('NO_DOCUMENTATION');
    }

    return {
      documentation: response.data.documentation,
      transcript: response.data.transcript || null
    };
  } catch (error) {
    console.error('Documentation V2 error:', error.response?.data || error.message);

    const serverError = error.response?.data?.error;

    if (serverError === 'No transcript text available' || error.message === 'NO_DOCUMENTATION') {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    if (serverError?.includes('processing') || serverError?.includes('pending')) {
      throw new Error('Die Transkription wird noch verarbeitet. Bitte warten Sie einen Moment.');
    }

    if (serverError?.includes('minutes') || serverError?.includes('Minuten')) {
      throw new Error('Nicht genügend Minuten übrig. Bitte laden Sie Ihr Guthaben auf.');
    }

    if (serverError) {
      throw new Error(`Fehler: ${serverError}`);
    }

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Die Verarbeitung dauert zu lange. Bitte versuchen Sie es erneut.');
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error('Server nicht erreichbar. Bitte prüfen Sie Ihre Internetverbindung.');
    }

    throw new Error('Dokumentation konnte nicht erstellt werden. Bitte versuchen Sie es erneut.');
  }
}

/**
 * Generate documentation using V1.2 Hybrid (1 API call, 60% cost savings)
 * @param {number} transcriptionId - Transcription ID
 * @param {string} token - Auth token
 * @param {boolean} runVerifier - Optional: Force verifier check
 * @returns {Promise<{documentation: string, transcript: string|null, meta: object|null}>}
 */
async function getDocumentationV1_2(transcriptionId, token, runVerifier = false) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/generate-doc-v1.2`,
      { runVerifier },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 minutes (faster than V1.1)
      }
    );

    if (!response.data.documentation) {
      throw new Error('NO_DOCUMENTATION');
    }

    return {
      documentation: response.data.documentation,
      transcript: response.data.transcript || null,
      meta: response.data.meta || null
    };
  } catch (error) {
    console.error('Documentation V1.2 error:', error.response?.data || error.message);

    const serverError = error.response?.data?.error;

    if (serverError === 'No transcript text available' || error.message === 'NO_DOCUMENTATION') {
      throw new Error('Keine Sprache erkannt. Bitte sprechen Sie deutlich ins Mikrofon und versuchen Sie es erneut.');
    }

    if (serverError?.includes('processing') || serverError?.includes('pending')) {
      throw new Error('Die Transkription wird noch verarbeitet. Bitte warten Sie einen Moment.');
    }

    if (serverError?.includes('minutes') || serverError?.includes('Minuten')) {
      throw new Error('Nicht genügend Minuten übrig. Bitte laden Sie Ihr Guthaben auf.');
    }

    if (serverError) {
      throw new Error(`Fehler: ${serverError}`);
    }

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Die Verarbeitung dauert zu lange. Bitte versuchen Sie es erneut.');
    }

    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      throw new Error('Server nicht erreichbar. Bitte prüfen Sie Ihre Internetverbindung.');
    }

    throw new Error('Dokumentation konnte nicht erstellt werden. Bitte versuchen Sie es erneut.');
  }
}

async function updateSpeakerMapping(transcriptionId, speakerMapping, token) {
  try {
    const url = `${API_BASE_URL}api/transcriptions/${transcriptionId}/update-speakers`;

    const response = await axios.post(
      url,
      { speakerMapping },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Update speakers error:', error.response?.data || error.message);
    throw new Error('Speaker-Zuordnung konnte nicht aktualisiert werden');
  }
}

async function getTranscription(transcriptionId, token) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Get transcription error:', error.response?.data || error.message);
    throw new Error('Transkription konnte nicht abgerufen werden');
  }
}

/**
 * Poll transcription status from AssemblyAI (real-time status)
 * @param {number} transcriptionId - Transcription ID
 * @param {string} token - Auth token
 * @returns {Promise<{id: number, status: string, transcriptText?: string, utterances?: string, error?: string}>}
 */
async function getTranscriptionStatus(transcriptionId, token) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/status`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Get transcription status error:', error.response?.data || error.message);
    throw new Error('Status konnte nicht abgerufen werden');
  }
}

function getBaseUrl() {
  return API_BASE_URL;
}

async function submitFeedback(token, category, message) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/feedback`,
      { category, message },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Cookie': `session=${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return { success: true, data: response.data };
  } catch (error) {
    console.error('Submit feedback error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error || 'Feedback konnte nicht gesendet werden' };
  }
}

// =============================================================================
// PRAXIS-EINSTELLUNGEN API (V1.2 Hybrid)
// =============================================================================

/**
 * Get Praxis-Einstellungen (Textbausteine, Themen-Anpassungen, etc.)
 * @param {string} token - Auth token
 * @returns {Promise<{einstellungen: object, isDefault: boolean, availableThemen: string[]}>}
 */
async function getPraxisEinstellungen(token) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}api/praxis/einstellungen`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Get Praxis-Einstellungen error:', error.response?.data || error.message);
    throw new Error('Einstellungen konnten nicht geladen werden');
  }
}

/**
 * Update Praxis-Einstellungen (PATCH - partial update)
 * @param {string} token - Auth token
 * @param {object} updates - Fields to update
 * @returns {Promise<{einstellungen: object, updatedAt: string}>}
 */
async function updatePraxisEinstellungen(token, updates) {
  try {
    const response = await axios.patch(
      `${API_BASE_URL}api/praxis/einstellungen`,
      updates,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Update Praxis-Einstellungen error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || 'Einstellungen konnten nicht gespeichert werden');
  }
}

/**
 * Add a Textbaustein
 * @param {string} token - Auth token
 * @param {string} key - Baustein key (e.g. "aufklaerung_standard")
 * @param {string} text - Baustein text
 */
async function addTextbaustein(token, key, text) {
  return updatePraxisEinstellungen(token, {
    addTextbaustein: { key, text }
  });
}

/**
 * Remove a Textbaustein
 * @param {string} token - Auth token
 * @param {string} key - Baustein key to remove
 */
async function removeTextbaustein(token, key) {
  return updatePraxisEinstellungen(token, {
    removeTextbaustein: key
  });
}

/**
 * Add/Update a Themen-Anpassung
 * @param {string} token - Auth token
 * @param {object} themenAnpassung - { thema, pflichtfelder, hinweistext }
 */
async function addThemenAnpassung(token, themenAnpassung) {
  return updatePraxisEinstellungen(token, {
    addThemenAnpassung: themenAnpassung
  });
}

/**
 * Remove a Themen-Anpassung
 * @param {string} token - Auth token
 * @param {string} thema - Thema to remove
 */
async function removeThemenAnpassung(token, thema) {
  return updatePraxisEinstellungen(token, {
    removeThema: thema
  });
}

/**
 * Reset Praxis-Einstellungen to defaults
 * @param {string} token - Auth token
 */
async function resetPraxisEinstellungen(token) {
  try {
    const response = await axios.delete(
      `${API_BASE_URL}api/praxis/einstellungen`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Reset Praxis-Einstellungen error:', error.response?.data || error.message);
    throw new Error('Einstellungen konnten nicht zurückgesetzt werden');
  }
}

module.exports = {
  login,
  logout,
  heartbeat,
  getUser,
  uploadAudio,
  getDocumentation,
  getDocumentationV1_1,
  getDocumentationV1_2,
  getDocumentationV2,
  updateSpeakerMapping,
  getTranscription,
  getTranscriptionStatus,
  getBaseUrl,
  submitFeedback,
  getDeviceId,
  getDeviceInfo,
  // Praxis-Einstellungen (V1.2)
  getPraxisEinstellungen,
  updatePraxisEinstellungen,
  addTextbaustein,
  removeTextbaustein,
  addThemenAnpassung,
  removeThemenAnpassung,
  resetPraxisEinstellungen,
};
