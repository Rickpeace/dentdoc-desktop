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
 * @param {string} options.source - Audio source: 'iphone' | 'mic' (default: 'mic')
 * @returns {Promise<{wavPath: string, speechMap: Array, segments: Array}>}
 */
async function processFileWithVAD(audioPath, options = {}) {
  const { onProgress = () => {}, source = 'mic' } = options;
  const audioConverter = require('../audio-converter');

  // Setup output directory
  const outputDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Log temp folder location and source strategy
  console.log('');
  console.log('///// TEMP DATEIEN /////');
  console.log(`  Ordner: ${outputDir}`);
  console.log(`  Quelle: ${source}`);
  if (source === 'iphone') {
    console.log(`  >>> Auto-Level Strategie: IMMER loudnorm (iPhone)`);
  } else {
    console.log(`  >>> Auto-Level Strategie: RMS-basiert (loudnorm < -50dB | mild_gain -50 bis -28dB | none > -28dB)`);
  }

  // Check if file needs conversion (not already WAV)
  const ext = path.extname(audioPath).toLowerCase();
  let processPath = audioPath;

  if (ext !== '.wav') {
    onProgress({ stage: 'convert', percent: 2, message: `Konvertiere ${ext.toUpperCase()}...` });

    const wavPath = path.join(outputDir, `converted_${Date.now()}.wav`);
    processPath = await audioConverter.convertToWav16k(audioPath, wavPath);

    // Log temp file creation
    const convertedSize = (fs.statSync(processPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  [TEMP] Erstellt: ${path.basename(processPath)} (${convertedSize} MB)`);
  }

  // Auto-Level: Measure RMS and apply appropriate gain/normalization
  // Strategy depends on source: iPhone = always loudnorm, Mic = RMS-based
  onProgress({ stage: 'autolevel', percent: 3, message: 'Audio wird optimiert...' });

  const leveledPath = path.join(outputDir, `leveled_${Date.now()}.wav`);

  try {
    const levelResult = await audioConverter.autoLevel(processPath, leveledPath, { source });
    console.log(`  [TEMP] Erstellt: ${path.basename(leveledPath)} (Auto-Level: ${levelResult.strategy})`);
    processPath = levelResult.outputPath;
  } catch (err) {
    console.warn(`  [AutoLevel] Übersprungen: ${err.message}`);
    // Continue with original file if auto-level fails
  }

  // Run offline VAD
  onProgress({ stage: 'vad', percent: 5, message: 'Stille wird entfernt...' });

  const segments = await runOfflineVAD(processPath, onProgress);

  if (segments.length === 0) {
    throw new Error('Keine Sprache erkannt. Die Datei enthält möglicherweise keine Sprache oder ist zu leise.');
  }

  // Render speech-only WAV
  onProgress({ stage: 'render', percent: 25, message: 'Audio wird vorbereitet...' });

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
