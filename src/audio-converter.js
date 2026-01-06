const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Get ffmpeg path - handle both dev and production (unpacked from asar)
let ffmpegPath;
try {
  // In production, ffmpeg-static needs to be in unpacked location
  const ffmpegStaticPath = require('ffmpeg-static');

  // If we're in an ASAR archive, replace path with unpacked version
  if (app.isPackaged && ffmpegStaticPath.includes('app.asar')) {
    ffmpegPath = ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
  } else {
    ffmpegPath = ffmpegStaticPath;
  }

  console.log('FFmpeg path:', ffmpegPath);
  console.log('FFmpeg exists:', fs.existsSync(ffmpegPath));
} catch (error) {
  console.error('Error loading ffmpeg-static:', error);
  throw error;
}

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Convert WebM audio to WAV 16kHz mono
 * @param {string} inputPath - Path to input WebM file
 * @param {string} outputPath - Path to output WAV file (optional)
 * @returns {Promise<string>} Path to converted WAV file
 */
function convertToWav16k(inputPath, outputPath = null) {
  return new Promise((resolve, reject) => {
    // Generate output path if not provided
    if (!outputPath) {
      const parsedPath = path.parse(inputPath);
      outputPath = path.join(parsedPath.dir, `${parsedPath.name}_16k.wav`);
    }

    console.log(`Converting ${inputPath} to 16kHz WAV...`);

    ffmpeg(inputPath)
      .audioFrequency(16000)  // 16kHz sample rate
      .audioChannels(1)        // Mono
      .audioCodec('pcm_s16le') // 16-bit PCM
      .format('wav')
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`Conversion progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`Conversion completed: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('FFmpeg conversion error:', err);
        reject(new Error(`Audio conversion failed: ${err.message}`));
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
  convertAndReplace
};
