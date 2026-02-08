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
 * Uses filter_complex for batch extraction (1 FFmpeg call instead of N)
 * Falls back to sequential extraction if filter_complex fails
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

  console.log(`  [TEMP] Extrahiere ${segments.length} Segmente...`);

  // Try batch extraction with filter_complex
  try {
    await extractBatchFilterComplex(segments, fullRecordingPath, outputPath, tempDir);
    return;
  } catch (batchErr) {
    console.warn(`  [TEMP] filter_complex failed (${batchErr.message}), using sequential fallback`);
  }

  // Fallback: sequential extraction (old method)
  await extractSequential(segments, fullRecordingPath, outputPath, tempDir);
}

/**
 * Batch extract using FFmpeg filter_complex (1 spawn instead of N)
 * Splits into chunks if command line would exceed Windows limit (~32k chars)
 */
async function extractBatchFilterComplex(segments, fullRecordingPath, outputPath, tempDir) {
  const ffmpegPath = getFFmpegPath();
  const CMD_LENGTH_LIMIT = 28000; // Windows ~32k, use 28k with safety margin

  // Build filter_complex for a batch of segments
  function buildFilterArgs(segs, inputPath, outPath) {
    const trimFilters = segs.map((seg, i) => {
      const start = seg.startMs / 1000;
      const end = seg.endMs / 1000;
      return `[0:a]atrim=${start.toFixed(3)}:${end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
    }).join(';');

    const concatInput = segs.map((_, i) => `[a${i}]`).join('');
    const filterComplex = `${trimFilters};${concatInput}concat=n=${segs.length}:v=0:a=1[out]`;

    return [
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-acodec', 'pcm_s16le',
      '-y',
      outPath
    ];
  }

  // Check if all segments fit in one command
  const testArgs = buildFilterArgs(segments, fullRecordingPath, outputPath);
  const cmdLength = ['ffmpeg', ...testArgs].join(' ').length;

  if (cmdLength <= CMD_LENGTH_LIMIT) {
    // All segments fit in one command
    console.log(`  [BATCH] Single pass (${segments.length} segments, cmd: ${cmdLength} chars)`);
    await runFFmpeg(ffmpegPath, testArgs);
    return;
  }

  // Need chunking - split segments into groups that fit command length
  console.log(`  [BATCH] Command too long (${cmdLength} chars), chunking...`);

  const chunkFiles = [];
  let chunkStart = 0;

  while (chunkStart < segments.length) {
    // Binary search for max chunk size that fits
    let chunkEnd = Math.min(chunkStart + 100, segments.length); // Start with 100

    while (chunkEnd > chunkStart + 1) {
      const testSegs = segments.slice(chunkStart, chunkEnd);
      const testA = buildFilterArgs(testSegs, fullRecordingPath, 'test.wav');
      const testLen = ['ffmpeg', ...testA].join(' ').length;

      if (testLen <= CMD_LENGTH_LIMIT) break;
      chunkEnd = Math.floor(chunkStart + (chunkEnd - chunkStart) * 0.7);
    }

    // At minimum process 2 segments per chunk
    if (chunkEnd <= chunkStart) chunkEnd = chunkStart + 2;
    if (chunkEnd > segments.length) chunkEnd = segments.length;

    const chunkSegs = segments.slice(chunkStart, chunkEnd);
    const chunkPath = path.join(tempDir, `batch_chunk_${Date.now()}_${chunkFiles.length}.wav`);
    const chunkArgs = buildFilterArgs(chunkSegs, fullRecordingPath, chunkPath);

    console.log(`  [BATCH] Chunk ${chunkFiles.length + 1}: segments ${chunkStart}-${chunkEnd - 1}`);
    await runFFmpeg(ffmpegPath, chunkArgs);
    chunkFiles.push(chunkPath);

    chunkStart = chunkEnd;
  }

  // Concatenate chunk files
  if (chunkFiles.length === 1) {
    fs.renameSync(chunkFiles[0], outputPath);
  } else {
    await concatenateFiles(chunkFiles, outputPath);
    // Clean up chunk files
    for (const f of chunkFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
  }
}

/**
 * Sequential extraction fallback (old method)
 */
async function extractSequential(segments, fullRecordingPath, outputPath, tempDir) {
  const tempFiles = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.duration || (seg.endMs - seg.startMs);
    const tempFile = path.join(tempDir, `extract_${Date.now()}_${i}.wav`);

    await extractSegment(fullRecordingPath, seg.startMs, duration, tempFile);
    tempFiles.push(tempFile);
  }

  await concatenateFiles(tempFiles, outputPath);

  let cleanedCount = 0;
  for (const f of tempFiles) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        cleanedCount++;
      }
    } catch (e) {}
  }
  console.log(`  [TEMP] Geloescht: ${cleanedCount} Segment-Dateien`);
}

/**
 * Run FFmpeg with given args and return promise
 */
function runFFmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });

    ffmpeg.on('error', reject);
  });
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
