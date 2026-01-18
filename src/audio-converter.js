const ffmpeg = require('fluent-ffmpeg');
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
      .audioFilters([
        'highpass=f=90',        // Remove rumble (chair, footsteps) below 90Hz
        'alimiter=limit=0.97'   // Prevent clipping at -0.26 dBFS
      ])
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

module.exports = {
  convertToWav16k,
  convertForAssemblyAI,
  convertAndReplace
};
