const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { convertForAssemblyAI } = require('./audio-converter');

/**
 * Check if audio file is already optimized (16kHz mono WAV)
 * Reads only the WAV header (44 bytes) - very fast
 * @param {string} filePath - Path to audio file
 * @returns {boolean} true if already 16kHz mono WAV
 */
function isAlreadyOptimized(filePath) {
  try {
    // Only check WAV files
    if (!filePath.toLowerCase().endsWith('.wav')) {
      return false;
    }

    const buffer = Buffer.alloc(44);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 44, 0);
    fs.closeSync(fd);

    // Check RIFF/WAVE header
    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      return false;
    }

    // Read audio format info from WAV header
    const channels = buffer.readUInt16LE(22);
    const sampleRate = buffer.readUInt32LE(24);

    return channels === 1 && sampleRate === 16000;
  } catch (err) {
    console.log(`[Upload] Header check failed: ${err.message}`);
    return false;
  }
}

// DentDoc Vercel API URL
const API_BASE_URL = process.env.API_URL || 'https://dentdoc-app.vercel.app/';

// Railway Upload-Proxy URL (API-Key bleibt auf Railway, nicht im Desktop!)
const UPLOAD_PROXY_URL = process.env.UPLOAD_PROXY_URL || 'https://dentdoc-upload-proxy.up.railway.app';
const UPLOAD_PROXY_TOKEN = process.env.UPLOAD_PROXY_TOKEN;

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
  let optimizedFilePath = null;
  let uploadFilePath = audioFilePath;

  try {
    // Check if file exists and has content
    const stats = fs.statSync(audioFilePath);
    if (stats.size < 5000) {
      throw new Error('EMPTY_RECORDING');
    }

    // Check if file is already optimized (16kHz mono WAV from VAD pipeline)
    const alreadyOptimized = isAlreadyOptimized(audioFilePath);

    if (alreadyOptimized) {
      // Skip conversion - file is already 16kHz mono WAV
      console.log(`  [Upload] Bereits optimiert (16kHz mono) - Konvertierung übersprungen`);
      uploadFilePath = audioFilePath;
    } else {
      // Convert audio with AssemblyAI-optimized filters
      // (highpass=200Hz, lowpass=3000Hz for better transcription)
      if (onProgress) {
        onProgress({ phase: 'prepare', percent: 0, message: 'Audio wird optimiert...' });
      }
      console.log(`  [Upload] Konvertiere zu 16kHz mono...`);
      optimizedFilePath = await convertForAssemblyAI(audioFilePath);
      uploadFilePath = optimizedFilePath;
      console.log(`  [Upload] Konvertiert: ${require('path').basename(optimizedFilePath)}`);
    }

    const fileName = require('path').basename(uploadFilePath);
    const fileBuffer = fs.readFileSync(uploadFilePath);
    const fileSizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`  [Upload] Datei: ${fileName} (${fileSizeMB} MB)`);

    // STEP 1: Upload via Railway Proxy (API-Key bleibt auf Railway, nicht im Desktop!)
    if (onProgress) {
      onProgress({ phase: 'prepare', percent: 5, message: 'Vorbereiten...' });
    }

    if (!UPLOAD_PROXY_TOKEN) {
      throw new Error('Upload-Proxy Token nicht konfiguriert. Bitte UPLOAD_PROXY_TOKEN in .env setzen.');
    }

    if (onProgress) {
      onProgress({ phase: 'upload', percent: 0, message: 'Upload läuft...' });
    }

    // Use native https for real upload progress tracking
    const fileSize = fileBuffer.length;
    const https = require('https');
    const url = require('url');

    const upload_url = await new Promise((resolve, reject) => {
      const proxyUrl = new url.URL(`${UPLOAD_PROXY_URL}/upload`);

      const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 443,
        path: proxyUrl.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPLOAD_PROXY_TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              if (!json.upload_url) {
                reject(new Error('Keine upload_url vom Proxy erhalten'));
                return;
              }
              resolve(json.upload_url);
            } else if (res.statusCode === 401) {
              reject(new Error('Upload-Proxy Authentifizierung fehlgeschlagen. Bitte Token prüfen.'));
            } else {
              reject(new Error(json.error || json.message || `Upload failed with status ${res.statusCode}`));
            }
          } catch (e) {
            reject(new Error(`Ungültige Antwort vom Upload-Proxy: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error('Upload-Proxy nicht erreichbar. Bitte später erneut versuchen.'));
        } else {
          reject(err);
        }
      });

      // Timeout handling
      req.setTimeout(300000, () => {
        req.destroy(new Error('Upload timeout'));
      });

      // Track progress using chunked writing for accurate progress reporting
      const chunkSize = 5 * 1024 * 1024; // 5MB chunks (weniger Overhead)
      let lastReportedPercent = 0;
      let offset = 0;

      const writeNextChunk = () => {
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileBuffer.slice(offset, end);
          offset = end;

          const percent = Math.round(offset * 100 / fileSize);
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent;
            onProgress?.({ phase: 'upload', percent, message: `Upload ${percent}%` });
          }

          if (!req.write(chunk)) {
            // Buffer full, wait for drain and continue
            req.once('drain', writeNextChunk);
            return;
          }
        }
        // All chunks written
        req.end();
      };

      writeNextChunk();
    });

    if (!upload_url) {
      throw new Error('No upload_url received from upload proxy');
    }

    // STEP 2: Tell backend to start transcription (creates DB entry)
    if (onProgress) {
      onProgress({ phase: 'submit', percent: 90, message: 'Starte Transkription...' });
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

    // Cleanup optimized temp file
    if (optimizedFilePath && fs.existsSync(optimizedFilePath)) {
      try {
        fs.unlinkSync(optimizedFilePath);
        console.log(`  [TEMP] Geloescht: ${require('path').basename(optimizedFilePath)}`);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
    }

    return startResponse.data.id;

  } catch (error) {
    // Cleanup optimized temp file on error too
    if (optimizedFilePath && fs.existsSync(optimizedFilePath)) {
      try {
        fs.unlinkSync(optimizedFilePath);
        console.log(`  [TEMP] Geloescht (Fehler): ${require('path').basename(optimizedFilePath)}`);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
    }

    if (error.message === 'EMPTY_RECORDING') {
      throw new Error('Die Aufnahme war zu kurz oder leer. Bitte sprechen Sie mindestens 2-3 Sekunden.');
    }

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Upload-Timeout. Die Datei ist möglicherweise zu groß oder die Verbindung zu langsam. Bitte versuchen Sie es erneut.');
    }

    // Network errors during upload
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.message.includes('socket hang up')) {
      throw new Error('Verbindung während des Uploads abgebrochen. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.');
    }

    if (error.code === 'ERR_NETWORK' || error.message.includes('Network Error')) {
      throw new Error('Netzwerkfehler beim Upload. Bitte prüfen Sie Ihre Internetverbindung.');
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
 * Generate documentation using Agent V2.1 (Multi-Agent Pipeline)
 *
 * Pipeline:
 * 1. Agent 1 (Rekonstruktion): Bereinigt das Roh-Transkript zu sachlichem Klartext
 * 2. Agent X (Detektor): Erkennt ob 01-Befund / PA-Status im Text
 * 3. 01-Extractor (optional): Extrahiert strukturierten Zahnstatus
 * 4. PA-Extractor (optional): Extrahiert strukturierten PA-Status
 * 5. Agent 2 (Dokumentation): Erstellt finale Behandlungsdokumentation
 *
 * @param {number} transcriptionId - Transcription ID
 * @param {string} token - Auth token
 * @returns {Promise<Object>} Full response with documentation, detection, status01, statusPA
 */
async function getDocumentationAgentV2_1(transcriptionId, token) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/transcriptions/${transcriptionId}/generate-doc-agent-v2.1`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 300000 // 5 minutes (multi-agent pipeline with extractors)
      }
    );

    if (!response.data.documentation) {
      throw new Error('NO_DOCUMENTATION');
    }

    return {
      documentation: response.data.documentation,
      kzvDocumentation: response.data.kzvDocumentation || null,
      transcript: response.data.transcript || null,
      reconstructedTranscript: response.data.reconstructedTranscript || null,
      transcriptWithSpeakers: response.data.transcriptWithSpeakers || null,
      recognizedSpeakers: response.data.recognizedSpeakers || [],
      stages: response.data.stages || null,
      // NEU: Befund-Detektion
      detection: response.data.detection || null,
      // NEU: Strukturierte Befunde (01-Zahnstatus, PA-Parodontalstatus)
      status01: response.data.status01 || null,
      statusPA: response.data.statusPA || null,
    };
  } catch (error) {
    console.error('Documentation Agent V2.1 error:', error.response?.data || error.message);

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

// ===========================================
// iPhone Microphone Pairing API
// ===========================================

/**
 * Start iPhone pairing process
 * @param {string} token - User auth token
 * @returns {Promise<{pairingId: string, qrUrl: string}>}
 */
async function iphonePairStart(token) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}api/iphone/pair/start`,
      {},
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    return {
      pairingId: response.data.pairingId,
      pairingUrl: response.data.pairingUrl
    };
  } catch (error) {
    console.error('iPhone pair start error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || 'Pairing konnte nicht gestartet werden');
  }
}

/**
 * Check iPhone pairing status
 * @param {string} pairingId - The pairing ID to check
 * @param {string} token - User auth token
 * @returns {Promise<{paired: boolean, iphoneDeviceId?: string, deviceName?: string, iphoneAuthToken?: string}>}
 */
async function iphonePairStatus(pairingId, token) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}api/iphone/pair/status?pairingId=${pairingId}`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    // Status can be: 'pending', 'paired', 'expired'
    if (response.data.status === 'paired') {
      return {
        status: 'paired',
        paired: true,
        iphoneDeviceId: response.data.device?.iphoneDeviceId,
        deviceName: response.data.device?.deviceName,
      };
    }

    return {
      status: response.data.status,
      paired: false,
      expiresAt: response.data.expiresAt
    };
  } catch (error) {
    console.error('iPhone pair status error:', error.response?.data || error.message);
    return { paired: false };
  }
}

/**
 * Get iPhone connection status
 * @param {string} token - User auth token
 * @returns {Promise<{paired: boolean, deviceName?: string, lastSeen?: string}>}
 */
async function iphoneStatus(token) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}api/iphone/status`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    return {
      paired: response.data.paired || false,
      deviceName: response.data.deviceName,
      iphoneDeviceId: response.data.iphoneDeviceId,  // Required for syncing to new devices
      lastSeen: response.data.lastSeen
    };
  } catch (error) {
    console.error('iPhone status error:', error.response?.data || error.message);
    return { paired: false };
  }
}

/**
 * Unpair iPhone
 * @param {string} token - User auth token
 * @returns {Promise<{success: boolean}>}
 */
async function iphoneUnpair(token) {
  try {
    await axios.delete(
      `${API_BASE_URL}api/iphone/unpair`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    return { success: true };
  } catch (error) {
    console.error('iPhone unpair error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || 'Entkoppeln fehlgeschlagen');
  }
}

/**
 * Segment transcript into semantic audio passages using AI
 * Each passage is a thematically coherent 15-40 second audio clip.
 *
 * @param {string} token - Auth token
 * @param {string} transcriptText - Full transcript text
 * @param {Array} words - Word-level timestamps from AssemblyAI [{text, start, end}, ...]
 * @returns {Promise<Object>} { passages: Passage[] }
 */
async function segmentPassages(token, transcriptText, words) {
  try {
    console.log('[apiClient] Segmenting transcript into passages...');
    console.log('[apiClient] Transcript length:', transcriptText?.length || 0);
    console.log('[apiClient] Words count:', words?.length || 0);

    const response = await axios.post(
      `${API_BASE_URL}api/segment-passages`,
      { transcriptText, words },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 min timeout for AI processing (long transcripts can take time)
      }
    );

    console.log('[apiClient] Passages created:', response.data.passages?.length || 0);
    return response.data;
  } catch (error) {
    console.error('[apiClient] Segment passages error:', error.response?.data || error.message);
    // Return empty passages on error - don't fail the whole process
    return { passages: [] };
  }
}

/**
 * Match documentation sections to audio passages using AI
/**
 * Extract topic segments from transcript using AI
 * @param {string} token - Auth token
 * @param {string} transcriptText - Full transcript text
 * @param {Array} words - Word-level timestamps from AssemblyAI [{text, start, end}, ...]
 * @returns {Promise<Object>} { topics: TopicSegment[] }
 */
async function extractTopicSegments(token, transcriptText, words) {
  try {
    console.log('[apiClient] Extracting topic segments...');
    console.log('[apiClient] Transcript length:', transcriptText?.length || 0);
    console.log('[apiClient] Words count:', words?.length || 0);

    const response = await axios.post(
      `${API_BASE_URL}api/extract-topics`,
      { transcriptText, words },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30s timeout for AI processing
      }
    );

    console.log('[apiClient] Topics extracted:', response.data.topics?.length || 0);
    return response.data;
  } catch (error) {
    console.error('[apiClient] Extract topics error:', error.response?.data || error.message);
    // Return empty topics on error - don't fail the whole transcription
    return { topics: [] };
  }
}

/**
 * Upload debug logs to backend for remote troubleshooting
 * @param {string} token - Auth token
 * @param {Object} store - electron-store instance
 * @param {string} logs - The log content to upload
 * @param {string} appVersion - App version
 * @returns {Promise<Object>} { success: boolean, debugLogId: number }
 */
async function uploadDebugLogs(token, store, logs, appVersion) {
  try {
    const deviceId = getDeviceId(store);
    const deviceInfo = getDeviceInfo();

    const response = await axios.post(
      `${API_BASE_URL}api/debug-logs`,
      {
        deviceId,
        hostname: deviceInfo.hostname,
        appVersion,
        logs,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data;
  } catch (error) {
    console.error('[apiClient] Upload debug logs error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || 'Debug-Log Upload fehlgeschlagen');
  }
}

module.exports = {
  login,
  logout,
  heartbeat,
  getUser,
  uploadAudio,
  getDocumentation,
  getDocumentationAgentV2_1,
  updateSpeakerMapping,
  getTranscription,
  getTranscriptionStatus,
  getBaseUrl,
  submitFeedback,
  getDeviceId,
  getDeviceInfo,
  // iPhone Pairing
  iphonePairStart,
  iphonePairStatus,
  iphoneStatus,
  iphoneUnpair,
  // Topic Extraction
  extractTopicSegments,
  // Passage Segmentation
  segmentPassages,
  // Debug Logs
  uploadDebugLogs,
};
