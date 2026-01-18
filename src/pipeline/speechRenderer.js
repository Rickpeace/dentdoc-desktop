/**
 * Speech Renderer
 *
 * Converts VAD segments (markers on full recording) into a single speech-only WAV file.
 * Also creates a speechMap for mapping speech-only timeline back to original.
 *
 * NEW: Segments now reference a single full.wav with startMs/endMs markers.
 * We extract and concatenate the marked regions.
 *
 * REGEL 5: VAD läuft IMMER vor OpenAI → speech_only.wav
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Get FFmpeg path (same logic as audio-converter.js)
 */
function getFFmpegPath() {
  const { app } = require('electron');

  // Try bundled FFmpeg first
  const bundledPath = path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe');
  const bundledPathPacked = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    : bundledPath;

  if (fs.existsSync(bundledPathPacked)) {
    return bundledPathPacked;
  }
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // Fallback to ffmpeg-static (handle ASAR unpacking)
  const ffmpegStaticPath = require('ffmpeg-static');

  // If we're in an ASAR archive, replace path with unpacked version
  if (app.isPackaged && ffmpegStaticPath.includes('app.asar')) {
    return ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
  }

  return ffmpegStaticPath;
}

/**
 * Extract a segment from audio file
 */
function extractSegment(inputPath, startMs, durationMs, outputPath) {
  const ffmpegPath = getFFmpegPath();

  return new Promise((resolve, reject) => {
    const args = [
      '-ss', (startMs / 1000).toFixed(3),
      '-i', inputPath,
      '-t', (durationMs / 1000).toFixed(3),
      '-c', 'copy',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg extract failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Render speech-only WAV from VAD segments
 *
 * NEW FORMAT: Segments have startMs/endMs relative to full recording
 * @param {Array} segments - Array of segment objects from VAD controller
 *   Each segment: { index, path, startMs, endMs, duration }
 *   - path: path to full recording (same for all segments)
 *   - startMs/endMs: markers within full recording
 * @param {string} outputPath - Path for the output speech-only WAV
 * @returns {Promise<{wavPath: string, speechMap: Array}>}
 */
async function renderSpeechOnly(segments, outputPath) {
  if (!segments || segments.length === 0) {
    throw new Error('No segments provided');
  }

  // Get full recording path (same for all segments in new format)
  const fullRecordingPath = segments[0].path;

  // Build speechMap for timeline mapping
  const speechMap = [];
  let speechTimeMs = 0;

  for (const segment of segments) {
    const duration = segment.duration || (segment.endMs - segment.startMs);
    speechMap.push({
      speechStartMs: speechTimeMs,
      speechEndMs: speechTimeMs + duration,
      originalStartMs: segment.startMs,
      originalEndMs: segment.endMs,
      segmentIndex: segment.index
    });
    speechTimeMs += duration;
  }

  // Check if segments are markers (new format) or separate files (old format)
  const isNewFormat = segments[0].startMs !== undefined && segments[0].endMs !== undefined;

  if (isNewFormat) {
    // NEW FORMAT: Extract and concatenate from single full recording
    await extractAndConcatenate(segments, fullRecordingPath, outputPath);
  } else {
    // OLD FORMAT: Segments are separate files, just concatenate
    if (segments.length === 1) {
      fs.copyFileSync(segments[0].path, outputPath);
    } else {
      await concatenateFiles(segments.map(s => s.path), outputPath);
    }
  }

  return { wavPath: outputPath, speechMap };
}

/**
 * Extract segments from full recording and concatenate
 */
async function extractAndConcatenate(segments, fullRecordingPath, outputPath) {
  const ffmpegPath = getFFmpegPath();
  const tempDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline', 'extract');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Single segment - just extract directly
  if (segments.length === 1) {
    const seg = segments[0];
    const duration = seg.duration || (seg.endMs - seg.startMs);
    await extractSegment(fullRecordingPath, seg.startMs, duration, outputPath);
    return;
  }

  // Multiple segments - extract each, then concatenate
  const tempFiles = [];

  console.log(`  [TEMP] Extrahiere ${segments.length} Segmente...`);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.duration || (seg.endMs - seg.startMs);
    const tempFile = path.join(tempDir, `extract_${Date.now()}_${i}.wav`);

    await extractSegment(fullRecordingPath, seg.startMs, duration, tempFile);
    tempFiles.push(tempFile);
  }

  // Concatenate all temp files
  await concatenateFiles(tempFiles, outputPath);

  // Clean up temp files
  let cleanedCount = 0;
  for (const f of tempFiles) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        cleanedCount++;
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }
  console.log(`  [TEMP] Geloescht: ${cleanedCount} Segment-Dateien`);
}

/**
 * Concatenate multiple WAV files using FFmpeg
 */
async function concatenateFiles(filePaths, outputPath) {
  const ffmpegPath = getFFmpegPath();
  const tempDir = path.join(os.tmpdir(), 'dentdoc', 'pipeline');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Create file list for FFmpeg concat demuxer
  const listPath = path.join(tempDir, `concat_list_${Date.now()}.txt`);
  const listContent = filePaths
    .map(p => `file '${p.replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent);
  console.log(`  [TEMP] Erstellt: concat_list.txt`);

  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      // Clean up list file
      try {
        fs.unlinkSync(listPath);
        console.log(`  [TEMP] Geloescht: concat_list.txt`);
      } catch (e) {
        // Ignore cleanup errors
      }

      if (code === 0) {
        resolve(outputPath);
      } else {
        console.error('[VAD] FFmpeg concat failed:', stderr);
        reject(new Error(`FFmpeg concat failed with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      try {
        fs.unlinkSync(listPath);
      } catch (e) {
        // Ignore cleanup errors
      }
      reject(err);
    });
  });
}

/**
 * Get total duration of all segments
 */
function getTotalDuration(segments) {
  return segments.reduce((sum, seg) => {
    const duration = seg.duration || (seg.endMs - seg.startMs);
    return sum + duration;
  }, 0);
}

/**
 * Map speech-only time to original recording time
 *
 * @param {number} speechTimeMs - Time in speech-only timeline
 * @param {Array} speechMap - Speech map from renderSpeechOnly
 * @returns {number|null} Original recording time, or null if not found
 */
function mapToOriginalTime(speechTimeMs, speechMap) {
  for (const entry of speechMap) {
    if (speechTimeMs >= entry.speechStartMs && speechTimeMs < entry.speechEndMs) {
      // Calculate offset within this segment
      const offset = speechTimeMs - entry.speechStartMs;
      return entry.originalStartMs + offset;
    }
  }
  return null;
}

/**
 * Map original recording time to speech-only time
 *
 * @param {number} originalTimeMs - Time in original recording
 * @param {Array} speechMap - Speech map from renderSpeechOnly
 * @returns {number|null} Speech-only time, or null if in silence
 */
function mapToSpeechTime(originalTimeMs, speechMap) {
  for (const entry of speechMap) {
    if (originalTimeMs >= entry.originalStartMs && originalTimeMs < entry.originalEndMs) {
      // Calculate offset within this segment
      const offset = originalTimeMs - entry.originalStartMs;
      return entry.speechStartMs + offset;
    }
  }
  return null;  // Time is in a silence gap
}

module.exports = {
  renderSpeechOnly,
  getTotalDuration,
  mapToOriginalTime,
  mapToSpeechTime
};
