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

/**
 * Analyze audio file for RMS and Peak levels
 * Used to determine how much gain/normalization is needed
 * @param {string} filePath - Path to audio file
 * @returns {Promise<{rms: number|null, peak: number|null}>} Levels in dBFS
 */
function analyzeAudio(filePath) {
  // Initialize ffmpeg path on first use
  initFFmpegPath();

  return new Promise((resolve) => {
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

    ffmpegProc.on('error', () => {
      resolve({ rms: null, peak: null });
    });
  });
}

/**
 * Auto-level audio based on RMS measurement
 * Applies appropriate gain/normalization based on input level
 *
 * Strategy:
 * - RMS < -24 dB: Very quiet → full loudnorm normalization
 * - RMS -24 to -18 dB: Quiet → gentle volume boost (1.3x)
 * - RMS -18 to -14 dB: Good → minimal boost (1.1x)
 * - RMS > -14 dB: Loud → limiter only (prevent clipping)
 *
 * @param {string} inputPath - Path to input audio file
 * @param {string} outputPath - Path to output audio file (optional)
 * @returns {Promise<{outputPath: string, rms: number|null, filter: string}>}
 */
async function autoLevel(inputPath, outputPath = null) {
  // Initialize ffmpeg path on first use
  initFFmpegPath();

  // Generate output path if not provided
  if (!outputPath) {
    const parsedPath = path.parse(inputPath);
    outputPath = path.join(parsedPath.dir, `${parsedPath.name}_leveled.wav`);
  }

  // Analyze audio first
  const { rms } = await analyzeAudio(inputPath);
  console.log(`[AutoLevel] Input RMS: ${rms !== null ? rms.toFixed(1) + ' dB' : 'unknown'}`);

  let filter;
  let filterName;

  if (rms === null) {
    // Fallback if analysis failed
    filter = 'volume=1.2';
    filterName = 'fallback (1.2x)';
  } else if (rms < -24) {
    // Very quiet → full normalization
    filter = 'loudnorm=I=-16:LRA=11:TP=-1.5';
    filterName = 'loudnorm (very quiet)';
  } else if (rms < -18) {
    // Quiet → gentle boost
    filter = 'volume=1.3';
    filterName = 'volume 1.3x (quiet)';
  } else if (rms < -14) {
    // Good → minimal boost
    filter = 'volume=1.1';
    filterName = 'volume 1.1x (good)';
  } else {
    // Loud → just limit to prevent clipping
    filter = 'alimiter=limit=-1.5dB';
    filterName = 'limiter only (loud)';
  }

  console.log(`[AutoLevel] Applying: ${filterName}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filter)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        console.log(`[AutoLevel] Output saved: ${outputPath}`);
        resolve({ outputPath, rms, filter: filterName });
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
