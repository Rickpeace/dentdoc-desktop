const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Get ffmpeg path - handle both dev and production (unpacked from asar)
// Initialized lazily to avoid app.isPackaged being undefined during module load
let ffmpegPath = null;
let ffmpegPathInitialized = false;

function initFFmpegPath() {
  if (ffmpegPathInitialized) return;

  try {
    // In production, ffmpeg-static needs to be in unpacked location
    const ffmpegStaticPath = require('ffmpeg-static');

    // If we're in an ASAR archive, replace path with unpacked version
    if (app.isPackaged && ffmpegStaticPath.includes('app.asar')) {
      ffmpegPath = ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
    } else {
      ffmpegPath = ffmpegStaticPath;
    }

    // Set ffmpeg path for fluent-ffmpeg
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpegPathInitialized = true;
  } catch (error) {
    throw error;
  }
}

/**
 * Convert WebM audio to WAV 16kHz mono
 * KEINE Filter hier - nur Format-Konvertierung!
 * Audio-Optimierung passiert in autoLevel() (nach Aufnahme, vor VAD)
 *
 * @param {string} inputPath - Path to input WebM file
 * @param {string} outputPath - Path to output WAV file (optional)
 * @returns {Promise<string>} Path to converted WAV file
 */
function convertToWav16k(inputPath, outputPath = null) {
  // Initialize ffmpeg path on first use
  initFFmpegPath();

  return new Promise((resolve, reject) => {
    // Generate output path if not provided
    if (!outputPath) {
      const parsedPath = path.parse(inputPath);
      outputPath = path.join(parsedPath.dir, `${parsedPath.name}_16k.wav`);
    }

    ffmpeg(inputPath)
      .audioFrequency(16000)  // 16kHz sample rate
      .audioChannels(1)        // Mono
      .audioCodec('pcm_s16le') // 16-bit PCM
      // KEINE Filter! Optimierung passiert in autoLevel()
      .format('wav')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`Audio conversion failed: ${err.message}`));
      })
      .save(outputPath);
  });
}

/**
 * Convert audio optimized for AssemblyAI transcription
 * Uses AssemblyAI's recommended filters (more aggressive than speaker recognition)
 * @param {string} inputPath - Path to input audio file
 * @param {string} outputPath - Path to output WAV file (optional)
 * @returns {Promise<string>} Path to converted WAV file
 */
function convertForAssemblyAI(inputPath, outputPath = null) {
  // Initialize ffmpeg path on first use
  initFFmpegPath();

  return new Promise((resolve, reject) => {
    // Generate output path if not provided
    if (!outputPath) {
      const parsedPath = path.parse(inputPath);
      outputPath = path.join(parsedPath.dir, `${parsedPath.name}_assemblyai.wav`);
    }

    ffmpeg(inputPath)
      .audioFrequency(16000)  // 16kHz sample rate (AssemblyAI recommendation)
      .audioChannels(1)        // Mono (AssemblyAI recommendation)
      .audioCodec('pcm_s16le') // 16-bit PCM
      .audioFilters([
        'highpass=f=200',       // AssemblyAI: remove low frequencies below 200Hz
        'lowpass=f=3000'        // AssemblyAI: remove high frequencies above 3kHz
      ])
      .format('wav')
      .on('end', () => {
        resolve(outputPath);
      })
      .on('error', (err) => {
        reject(new Error(`AssemblyAI audio conversion failed: ${err.message}`));
      })
      .save(outputPath);
  });
}

/**
 * Convert WebM to WAV and clean up original file
 * @param {string} webmPath - Path to WebM file
 * @returns {Promise<string>} Path to WAV file
 */
async function convertAndReplace(webmPath) {
  const wavPath = await convertToWav16k(webmPath);

  // Optionally delete original WebM file to save space
  // Commented out for now - keep both files for debugging
  // try {
  //   fs.unlinkSync(webmPath);
  //   console.log('Original WebM file deleted');
  // } catch (err) {
  //   console.warn('Could not delete original file:', err.message);
  // }

  return wavPath;
}

/**
 * Analyze audio file for RMS and Peak levels
 * Used to determine how much gain/normalization is needed
 * @param {string} filePath - Path to audio file
 * @returns {Promise<{rms: number|null, peak: number|null}>} Levels in dBFS
 */
function analyzeAudio(filePath) {
  // Initialize ffmpeg path on first use
  try {
    initFFmpegPath();
  } catch (err) {
    console.error('[analyzeAudio] FFmpeg init failed:', err.message);
    return Promise.resolve({ rms: null, peak: null });
  }

  if (!ffmpegPath) {
    console.error('[analyzeAudio] FFmpeg path is null');
    return Promise.resolve({ rms: null, peak: null });
  }

  return new Promise((resolve) => {
    try {
      const ffmpegProc = spawn(ffmpegPath, [
        '-i', filePath,
        '-af', 'astats=metadata=1:reset=1',
        '-f', 'null',
        '-'
      ]);

      let stderr = '';
      ffmpegProc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpegProc.on('close', () => {
        // Parse RMS and Peak from ffmpeg output
        const rmsMatch = stderr.match(/RMS level dB:\s*(-?\d+(\.\d+)?)/);
        const peakMatch = stderr.match(/Peak level dB:\s*(-?\d+(\.\d+)?)/);

        resolve({
          rms: rmsMatch ? Number(rmsMatch[1]) : null,
          peak: peakMatch ? Number(peakMatch[1]) : null
        });
      });

      ffmpegProc.on('error', (err) => {
        console.error('[analyzeAudio] FFmpeg process error:', err.message);
        resolve({ rms: null, peak: null });
      });
    } catch (err) {
      console.error('[analyzeAudio] Spawn error:', err.message);
      resolve({ rms: null, peak: null });
    }
  });
}

/**
 * Auto-level audio based on source profile and RMS measurement
 *
 * ZWEI PROFILE:
 *
 * 1. iPhone/Web (source='iphone'):
 *    - IMMER loudnorm (I=-16, LRA=11, TP=-1.5)
 *    - Kein RMS-Branching - Konsistenz wichtiger als Performance
 *    - Leise, variabler Abstand, kein echtes AGC
 *
 * 2. Desktop Mic (source='mic'):
 *    - RMS < -50 dB: Very quiet → loudnorm (I=-16, LRA=9, TP=-1.5)
 *    - RMS -50 to -28 dB: Quiet → mild_gain (+6dB)
 *    - RMS > -28 dB: Good → none (bereits gut eingepegelt)
 *
 * @param {string} inputPath - Path to input audio file
 * @param {string} outputPath - Path to output audio file (optional)
 * @param {Object} options - Options
 * @param {string} options.source - 'iphone' | 'mic' (default: 'mic')
 * @returns {Promise<{outputPath: string, rms: number|null, strategy: string, source: string}>}
 */
async function autoLevel(inputPath, outputPath = null, options = {}) {
  // Initialize ffmpeg path on first use
  initFFmpegPath();

  const source = options.source || 'mic';

  // Generate output path if not provided
  if (!outputPath) {
    const parsedPath = path.parse(inputPath);
    outputPath = path.join(parsedPath.dir, `${parsedPath.name}_leveled.wav`);
  }

  // Analyze audio first
  const { rms } = await analyzeAudio(inputPath);
  console.log('');
  console.log('///// AUTO-LEVEL /////');
  console.log(`[AutoLevel] Source: ${source}`);
  console.log(`[AutoLevel] Input RMS: ${rms !== null ? rms.toFixed(1) + ' dB' : 'unknown'}`);

  let filter;
  let strategy;

  if (source === 'iphone') {
    // iPhone: IMMER loudnorm - keine Entscheidung, maximale Konsistenz
    filter = 'loudnorm=I=-16:LRA=11:TP=-1.5';
    strategy = 'loudnorm';
    console.log(`[AutoLevel] Strategy: loudnorm (iPhone - always)`);
    console.log(`[AutoLevel] Filter: ${filter}`);
  } else {
    // Desktop Mic: RMS-basierte Entscheidung
    if (rms === null || rms < -50) {
      // Very quiet or unknown → full normalization (tighter LRA for direct speech)
      filter = 'loudnorm=I=-16:LRA=9:TP=-1.5';
      strategy = 'loudnorm';
      console.log(`[AutoLevel] Strategy: loudnorm (very quiet, RMS < -50dB)`);
      console.log(`[AutoLevel] Filter: ${filter}`);
    } else if (rms < -28) {
      // Quiet → mild gain boost (+6dB)
      filter = 'volume=6dB';
      strategy = 'mild_gain';
      console.log(`[AutoLevel] Strategy: mild_gain (quiet, -50dB < RMS < -28dB)`);
      console.log(`[AutoLevel] Filter: ${filter}`);
    } else {
      // Good level → no processing needed
      // Just copy the file (pass-through)
      console.log(`[AutoLevel] Strategy: none (good level, RMS > -28dB)`);
      console.log(`[AutoLevel] Filter: (passthrough - no filter)`);

      // For 'none' strategy, just copy without processing
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .audioFrequency(16000)
          .audioChannels(1)
          .audioCodec('pcm_s16le')
          .format('wav')
          .on('end', () => {
            console.log(`[AutoLevel] Output saved: ${outputPath} (passthrough)`);
            resolve({ outputPath, rms, strategy: 'none', source });
          })
          .on('error', (err) => {
            console.error(`[AutoLevel] Error: ${err.message}`);
            reject(new Error(`Auto-level failed: ${err.message}`));
          })
          .save(outputPath);
      });
    }
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filter)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        console.log(`[AutoLevel] Output saved: ${outputPath}`);
        resolve({ outputPath, rms, strategy, source });
      })
      .on('error', (err) => {
        console.error(`[AutoLevel] Error: ${err.message}`);
        reject(new Error(`Auto-level failed: ${err.message}`));
      })
      .save(outputPath);
  });
}

module.exports = {
  convertToWav16k,
  convertForAssemblyAI,
  convertAndReplace,
  analyzeAudio,
  autoLevel
};
