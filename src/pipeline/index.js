/**
 * VAD Pipeline für Stille-Entfernung
 *
 * Einfacher Flow:
 * 1. VAD Segments (live oder offline) → speech_only.wav rendern
 * 2. speech_only.wav zurückgeben für AssemblyAI Upload
 *
 * OpenAI Pipeline wurde entfernt - nur noch VAD + Render.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const speechRenderer = require('./speechRenderer');

/**
 * Render speech-only WAV from VAD segments
 *
 * @param {Array} segments - VAD segments from vad-controller
 * @param {string} outputPath - Optional output path
 * @returns {Promise<{wavPath: string, speechMap: Array}>}
 */
async function renderSpeechOnlyFromSegments(segments, outputPath = null) {
  if (!outputPath) {
    const outputDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    outputPath = path.join(outputDir, `speech_only_${Date.now()}.wav`);
  }

  const result = await speechRenderer.renderSpeechOnly(segments, outputPath);
  return result;
}

/**
 * Run offline VAD on an audio file
 *
 * @param {string} audioPath - Path to audio file (WAV)
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Array>} VAD segments
 */
async function runOfflineVAD(audioPath, onProgress = () => {}) {
  const offlineVad = require('./offlineVad');
  return await offlineVad.runOfflineVAD(audioPath, onProgress);
}

/**
 * Process uploaded file with VAD for silence removal
 *
 * @param {string} audioPath - Path to uploaded audio file
 * @param {Object} options - Options
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<{wavPath: string, speechMap: Array, segments: Array}>}
 */
async function processFileWithVAD(audioPath, options = {}) {
  const { onProgress = () => {} } = options;

  // Log temp folder location
  const tempDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');
  console.log('');
  console.log('///// TEMP DATEIEN /////');
  console.log(`  Ordner: ${tempDir}`);

  // Check if file needs conversion (not already WAV)
  const ext = path.extname(audioPath).toLowerCase();
  let processPath = audioPath;

  if (ext !== '.wav') {
    onProgress({ stage: 'convert', percent: 2, message: `Konvertiere ${ext.toUpperCase()}...` });

    const audioConverter = require('../audio-converter');
    const outputDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const wavPath = path.join(outputDir, `converted_${Date.now()}.wav`);
    processPath = await audioConverter.convertToWav16k(audioPath, wavPath);

    // Log temp file creation
    const convertedSize = (fs.statSync(processPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  [TEMP] Erstellt: ${path.basename(processPath)} (${convertedSize} MB)`);
  }

  // Run offline VAD
  onProgress({ stage: 'vad', percent: 5, message: 'Stille wird entfernt...' });

  const segments = await runOfflineVAD(processPath, onProgress);

  if (segments.length === 0) {
    throw new Error('Keine Sprache erkannt. Die Datei enthält möglicherweise keine Sprache oder ist zu leise.');
  }

  // Render speech-only WAV
  onProgress({ stage: 'render', percent: 25, message: 'Audio wird vorbereitet...' });

  const outputDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');
  const speechOnlyPath = path.join(outputDir, `speech_only_${Date.now()}.wav`);

  const { wavPath, speechMap } = await speechRenderer.renderSpeechOnly(segments, speechOnlyPath);

  // Log speech-only file creation with size
  const speechOnlySize = (fs.statSync(wavPath).size / (1024 * 1024)).toFixed(2);
  console.log(`  [TEMP] Erstellt: speech_only.wav (${speechOnlySize} MB)`);
  console.log('////////////////////////');
  console.log('');

  const speechDuration = speechRenderer.getTotalDuration(segments);
  onProgress({ stage: 'render', percent: 30, message: `${(speechDuration / 1000).toFixed(0)}s Sprache` });

  return { wavPath, speechMap, segments };
}

module.exports = {
  renderSpeechOnlyFromSegments,
  runOfflineVAD,
  processFileWithVAD,
  speechRenderer
};
