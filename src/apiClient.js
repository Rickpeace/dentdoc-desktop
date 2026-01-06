const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// DentDoc Vercel API URL

const API_BASE_URL = process.env.API_URL || 'https://dentdoc-app.vercel.app/';

async function login(email, password) {
  try {
    const response = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      email,
      password
    });

    return response.data;
  } catch (error) {
    throw new Error(error.response?.data?.error || 'Login fehlgeschlagen');
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

async function uploadAudio(audioFilePath, token) {
  try {
    // Check if file exists and has content
    const stats = fs.statSync(audioFilePath);
    if (stats.size < 5000) {
      throw new Error('EMPTY_RECORDING');
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFilePath));

    const response = await axios.post(`${API_BASE_URL}api/transcriptions/upload`, formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${token}`,
        'Cookie': `session=${token}`
      },
      timeout: 120000 // 2 minutes timeout
    });

    return response.data.id;
  } catch (error) {
    console.error('Upload error:', error.response?.data || error.message);

    if (error.message === 'EMPTY_RECORDING') {
      throw new Error('Die Aufnahme war zu kurz oder leer. Bitte sprechen Sie mindestens 2-3 Sekunden.');
    }

    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('Die Aufnahme war zu lang oder leer. Bitte versuchen Sie es erneut.');
    }

    const serverError = error.response?.data?.error;
    if (serverError) {
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

function getBaseUrl() {
  return API_BASE_URL;
}

module.exports = {
  login,
  getUser,
  uploadAudio,
  getDocumentation,
  updateSpeakerMapping,
  getTranscription,
  getBaseUrl
};
