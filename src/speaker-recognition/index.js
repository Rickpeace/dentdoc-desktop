const fs = require('fs');
const path = require('path');
const os = require('os');

const sherpa = require('sherpa-onnx-node');
const { app } = require('electron');
const voiceProfiles = require('./voice-profiles');

let recognizer = null;
let modelPath = null;

/**
 * Check if file is already 16kHz mono PCM WAV (skip conversion)
 * Reads only WAV header (64 bytes) - very fast, zero risk
 * @param {string} filePath - Path to audio file
 * @returns {boolean} true if already optimal format
 */
function is16kMonoPcmWav(filePath) {
  try {
    if (!filePath) return false;
    // Accept legacy .wav and our internal audio-temp extensions (.dat / .tmp).
    // Format validity is verified below via RIFF/WAVE magic regardless of extension.
    const lower = filePath.toLowerCase();
    if (!lower.endsWith('.wav') && !lower.endsWith('.dat') && !lower.endsWith('.tmp')) return false;

    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    fs.closeSync(fd);

    // Check RIFF/WAVE header
    if (header.toString('ascii', 0, 4) !== 'RIFF') return false;
    if (header.toString('ascii', 8, 12) !== 'WAVE') return false;

    const audioFormat = header.readUInt16LE(20);   // 1 = PCM
    const numChannels = header.readUInt16LE(22);   // 1 = mono
    const sampleRate = header.readUInt32LE(24);    // 16000
    const bitsPerSample = header.readUInt16LE(34); // 16

    return audioFormat === 1 && numChannels === 1 && sampleRate === 16000 && bitsPerSample === 16;
  } catch {
    return false; // Bei Fehler: sicherheitshalber konvertieren
  }
}

/**
 * Run async functions with concurrency limit
 * Prevents CPU overload on old PCs
 * @param {Array} items - Items to process
 * @param {number} limit - Max concurrent operations
 * @param {Function} fn - Async function to run
 * @returns {Promise<Array>} Results
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  // Start workers (max = limit or items.length, whichever is smaller)
  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(worker);

  await Promise.all(workers);
  return results;
}

/**
 * Initialize Sherpa-ONNX speaker recognition
 * Uses bundled model from app directory
 */
async function initialize() {
  if (recognizer) {
    return recognizer; // Already initialized
  }

  // Use bundled model from app directory
  // In production (asar packed), models are in app.asar.unpacked
  const appPath = app.getAppPath();
  const unpackedPath = appPath.replace('app.asar', 'app.asar.unpacked');

  // Try unpacked path first (production), then regular path (development)
  const possiblePaths = [
    path.join(unpackedPath, 'models', '3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx'),
    path.join(appPath, 'models', '3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx')
  ];

  modelPath = possiblePaths.find(p => fs.existsSync(p));

  if (!modelPath) {
    throw new Error(`Model not found. Tried:\n${possiblePaths.join('\n')}`);
  }

  // Create recognizer config - disable debug to reduce console output
  const config = {
    model: modelPath,
    numThreads: 2,
    debug: false,
    provider: 'cpu'
  };

  try {
    if (typeof sherpa.SpeakerEmbeddingExtractor === 'function') {
      recognizer = new sherpa.SpeakerEmbeddingExtractor(config);
    } else if (typeof sherpa.createSpeakerEmbeddingExtractor === 'function') {
      recognizer = sherpa.createSpeakerEmbeddingExtractor(config);
    } else {
      throw new Error('No suitable Sherpa-ONNX function found');
    }

    return recognizer;
  } catch (error) {
    throw new Error('Spracherkennung konnte nicht initialisiert werden: ' + error.message);
  }
}

// Model is now bundled with the app, no download needed

/**
 * Extract audio segment from WAV file
 * @param {string} audioFilePath - Path to audio file
 * @param {number} startMs - Start time in milliseconds
 * @param {number} durationMs - Duration in milliseconds (default 30000 = 30 seconds)
 * @returns {Float32Array} Audio samples
 */
function extractAudioSegment(audioFilePath, startMs, durationMs = 30000) {
  // Read only the WAV header first (44 bytes)
  const headerBuffer = Buffer.alloc(44);
  const fd = fs.openSync(audioFilePath, 'r');

  try {
    fs.readSync(fd, headerBuffer, 0, 44, 0);

    // Parse WAV header
    const dataStart = 44; // Standard WAV header size
    const sampleRate = headerBuffer.readUInt32LE(24);
    const bitsPerSample = headerBuffer.readUInt16LE(34);

    if (sampleRate !== 16000) {
      throw new Error(`Audio must be 16kHz, got ${sampleRate}Hz`);
    }

    if (bitsPerSample !== 16) {
      throw new Error(`Audio must be 16-bit PCM, got ${bitsPerSample}-bit`);
    }

    // Calculate byte positions
    const startSample = Math.floor((startMs / 1000) * sampleRate);
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    const startByte = dataStart + (startSample * 2);
    const bytesToRead = numSamples * 2; // 2 bytes per sample for 16-bit

    // Get file size to avoid reading past end
    const fileStats = fs.fstatSync(fd);
    const actualBytesToRead = Math.min(bytesToRead, fileStats.size - startByte);

    if (actualBytesToRead <= 0) {
      return new Float32Array(0);
    }

    // Read only the segment we need
    const segmentBuffer = Buffer.alloc(actualBytesToRead);
    fs.readSync(fd, segmentBuffer, 0, actualBytesToRead, startByte);

    // Convert to Float32Array
    const numSamplesActual = Math.floor(actualBytesToRead / 2);
    const pcmData = new Float32Array(numSamplesActual);

    for (let i = 0; i < numSamplesActual; i++) {
      pcmData[i] = segmentBuffer.readInt16LE(i * 2) / 32768.0;
    }

    return pcmData;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create voice embedding from audio segment
 * @param {string} audioFilePath - Path to audio file (must be 16kHz WAV)
 * @param {number} startMs - Start time in milliseconds
 * @param {number} durationMs - Duration in milliseconds (default 30000)
 * @returns {Array} Voice embedding (normalized vector)
 */
async function createEmbedding(audioFilePath, startMs = 0, durationMs = 30000) {
  await initialize();

  try {
    const samples = extractAudioSegment(audioFilePath, startMs, durationMs);

    if (samples.length === 0) {
      throw new Error('Keine Audio-Daten gefunden');
    }

    // Create stream for processing
    const stream = recognizer.createStream();

    // Accept waveform (16kHz, mono) - use Float32Array directly
    stream.acceptWaveform({ sampleRate: 16000, samples: samples });

    // Signal input finished
    stream.inputFinished();

    // Compute embedding - DISABLE external buffer (enableExternalBuffer = false)
    // This returns a regular array instead of Float32Array
    const embeddingArray = recognizer.compute(stream, false);

    // Note: stream doesn't have a free() method in sherpa-onnx-node
    // Garbage collection will handle cleanup

    // Return as regular array
    return embeddingArray;
  } catch (error) {
    console.error('Failed to create embedding:', error);
    throw new Error('Stimmprofil konnte nicht erstellt werden: ' + error.message);
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * @param {Array} embedding1 - First embedding
 * @param {Array} embedding2 - Second embedding
 * @returns {number} Similarity score (0-1, higher is more similar)
 */
function cosineSimilarity(embedding1, embedding2) {
  if (embedding1.length !== embedding2.length) {
    throw new Error(`Embeddings must have same length: ${embedding1.length} vs ${embedding2.length}`);
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) {
    return 0;
  }

  return dotProduct / (norm1 * norm2);
}

/**
 * Identify speaker from audio segment
 * @param {string} audioFilePath - Path to audio file
 * @param {number} startMs - Start time in milliseconds
 * @param {number} durationMs - Duration in milliseconds
 * @param {number} threshold - Similarity threshold (default 0.7)
 * @returns {Object|null} Matched profile and similarity, or null if no match
 */
async function identifySpeaker(audioFilePath, startMs, durationMs = 30000, threshold = 0.7) {
  // Create embedding from audio segment
  const embedding = await createEmbedding(audioFilePath, startMs, durationMs);

  // Get all saved voice profiles
  const profiles = voiceProfiles.getAllProfiles();

  if (profiles.length === 0) {
    return null; // No profiles to compare against
  }

  // Find best match
  let bestMatch = null;
  let bestScore = 0;

  for (const profile of profiles) {
    const similarity = cosineSimilarity(embedding, profile.embedding);
    const logMsg = `[Speaker Recognition] Comparing with "${profile.name}" (${profile.role}): similarity = ${(similarity * 100).toFixed(2)}%`;
    console.log(logMsg);
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${logMsg}\n`);

    if (similarity > bestScore) {
      bestScore = similarity;
      bestMatch = profile;
    }
  }

  const bestLog = `[Speaker Recognition] Best match: "${bestMatch?.name}" with ${(bestScore * 100).toFixed(2)}% similarity (threshold: ${(threshold * 100)}%)`;
  console.log(bestLog);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${bestLog}\n`);

  // Return match if above threshold
  if (bestScore >= threshold) {
    const matchLog = `[Speaker Recognition] ✓ Match found: ${bestMatch.name}`;
    console.log(matchLog);
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${matchLog}\n`);
    return {
      profile: bestMatch,
      similarity: bestScore
    };
  }

  const noMatchLog = '[Speaker Recognition] ✗ No match above threshold';
  console.log(noMatchLog);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${noMatchLog}\n`);
  return null; // No confident match
}

/**
 * Identify all speakers from utterances
 * @param {string} audioFilePath - Path to local audio file (can be WebM or WAV)
 * @param {Array} utterances - AssemblyAI utterances with speaker labels and timestamps
 * @returns {Object} Speaker mapping { "A": "Dr. Notle", "B": "Patient" }
 */
async function identifySpeakersFromUtterances(audioFilePath, utterances) {
  // EARLY EXIT: Keine Profile = keine Sprechererkennung nötig
  // Spart ~5-15s (kein Model-Loading, kein Audio-Processing)
  const profiles = voiceProfiles.getAllProfiles();
  if (!profiles || profiles.length === 0) {
    console.log('[Speaker Recognition] Keine Profile vorhanden - Überspringe Sprechererkennung');
    const speakerMapping = {};
    if (utterances && utterances.length > 0) {
      const speakers = [...new Set(utterances.map(u => u?.speaker).filter(Boolean))];
      for (const speaker of speakers) {
        speakerMapping[speaker] = `Sprecher ${speaker}`;
      }
    }
    return speakerMapping;
  }

  let wavPath = audioFilePath;

  // Smart conversion skip: nur konvertieren wenn wirklich nötig
  if (is16kMonoPcmWav(audioFilePath)) {
    console.log('[Speaker Recognition] Audio bereits 16kHz mono PCM - Konvertierung übersprungen');
  } else {
    console.log('[Speaker Recognition] Konvertiere Audio zu 16kHz mono...');
    const audioConverter = require('../audio-converter');
    wavPath = await audioConverter.convertToWav16k(audioFilePath);
  }

  const speakerMapping = {};
  const speakerSegments = {};

  // Collect ALL segments for each speaker (not just continuous blocks)
  for (const utterance of utterances) {
    const speaker = utterance.speaker;

    if (!speakerSegments[speaker]) {
      speakerSegments[speaker] = [];
    }

    speakerSegments[speaker].push({
      start: utterance.start,
      end: utterance.end,
      duration: utterance.end - utterance.start
    });
  }

  // Initialize model once before parallel processing
  await initialize();

  // Process speakers in PARALLEL with limit=2 (prevents CPU overload on old PCs)
  const speakerEntries = Object.entries(speakerSegments);
  const PARALLEL_LIMIT = 2;

  // Logging für Support/Debugging
  console.log(`[Speaker Recognition] Profile: ${profiles.length}, Speaker: ${speakerEntries.length}, Parallel: ${PARALLEL_LIMIT}`);

  // Fallback-Funktion für Fehlerfall (basiert auf utterances, nicht speakerEntries)
  const createFallbackMapping = (utts) => {
    const mapping = {};
    const speakers = new Set(utts?.map(u => u?.speaker).filter(Boolean));
    for (const s of speakers) mapping[s] = `Sprecher ${s}`;
    return mapping;
  };

  // Segment selection constants
  const MIN_SEGMENT_MS = 800;      // Ignore short utterances (ja, mhm, ok)
  const MAX_PER_SEGMENT_MS = 5000;  // Cap per segment at 5s (more diversity, avoid diarization errors)
  const TARGET_MS = 30000;          // Total audio to collect per speaker (30s)

  let results;
  try {
    results = await mapLimit(speakerEntries, PARALLEL_LIMIT, async ([speaker, segments]) => {
    try {
      // Smart segment selection: longest first, filter short ones, cap each
      let candidates = segments
        .filter(s => s.duration >= MIN_SEGMENT_MS)
        .sort((a, b) => b.duration - a.duration);

      // Fallback: wenn alle Segmente zu kurz, nimm alle (sortiert nach Länge)
      if (candidates.length === 0) {
        console.log(`[Speaker ${speaker}] Fallback: alle Segmente < ${MIN_SEGMENT_MS}ms, nutze ungefiltert`);
        candidates = [...segments].sort((a, b) => b.duration - a.duration);
      }

      // Debug: zeige Segment-Statistik
      console.log(`[Speaker ${speaker}] Segmente: ${segments.length} total, ${candidates.length} filtered (>=${MIN_SEGMENT_MS}ms), longest: ${candidates[0]?.duration || 0}ms`);

      const audioSegments = [];
      let totalDuration = 0;

      let segIdx = 0;
      for (const segment of candidates) {
        if (totalDuration >= TARGET_MS) break;

        // Cap each segment and respect remaining budget
        const takeMs = Math.min(
          segment.duration,
          MAX_PER_SEGMENT_MS,
          TARGET_MS - totalDuration
        );

        // Skip if takeMs is invalid
        if (takeMs <= 0) continue;

        // Extract from MIDDLE of segment (avoid speaker transitions at start/end)
        const middleOffset = Math.max(0, Math.floor((segment.duration - takeMs) / 2));
        const extractStart = segment.start + middleOffset;
        const segmentAudio = extractAudioSegment(wavPath, extractStart, takeMs);

        // Guard: nur hinzufügen wenn tatsächlich Samples extrahiert wurden
        if (segmentAudio?.length > 0) {
          audioSegments.push(segmentAudio);
          totalDuration += takeMs;
          segIdx++;
          // Log first 5 segments taken (we expect ~6 with 5s cap)
          if (segIdx <= 5) {
            console.log(`[Speaker ${speaker}] Seg ${segIdx}: utt@${(segment.start / 1000).toFixed(1)}s (${segment.duration}ms) → extract@${(extractStart / 1000).toFixed(1)}s, take=${takeMs}ms`);
          }
        } else {
          console.warn(`[Speaker ${speaker}] Leeres Segment bei start=${segment.start}ms, takeMs=${takeMs}`);
        }
      }
      if (segIdx > 5) {
        console.log(`[Speaker ${speaker}] ... and ${segIdx - 5} more segments`);
      }

      // Guard: wenn keine Audio-Daten, kein Matching möglich
      if (audioSegments.length === 0 || totalDuration === 0) {
        console.warn(`[Speaker ${speaker}] Keine Audio-Daten extrahiert, skip matching`);
        return [speaker, `Sprecher ${speaker}`];
      }

      // Concatenate all segments into one Float32Array
      const totalSamples = audioSegments.reduce((sum, arr) => sum + arr.length, 0);
      const concatenatedAudio = new Float32Array(totalSamples);
      let offset = 0;

      for (const segment of audioSegments) {
        concatenatedAudio.set(segment, offset);
        offset += segment.length;
      }

      // Create embedding from concatenated pure speaker audio
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: concatenatedAudio });
      stream.inputFinished();
      const embedding = recognizer.compute(stream, false);

      // Log segment collection results
      console.log(`[Speaker ${speaker}] Collected: ${audioSegments.length} segments, ${(totalDuration / 1000).toFixed(1)}s total audio`);

      // Compare with profiles (profiles already loaded at function start)
      let bestMatch = null;
      let bestScore = 0;

      console.log(`[Speaker ${speaker}] Comparing against ${profiles.length} profiles:`);
      for (const profile of profiles) {
        // Skip profiles without a usable embedding (pending-only profiles)
        if (!profile.embedding && !profile.centroid) {
          console.log(`    [SKIP] "${profile.name}" - no embedding yet (pending only)`);
          continue;
        }
        const profileEmbedding = profile.embedding || profile.centroid;
        const similarity = cosineSimilarity(embedding, profileEmbedding);
        const pct = (similarity * 100).toFixed(1);
        const marker = similarity >= 0.7 ? '✓' : ' ';
        console.log(`  ${marker} "${profile.name}" (${profile.role}): ${pct}%`);

        if (similarity > bestScore) {
          bestScore = similarity;
          bestMatch = profile;
        }
      }

      const threshold = 0.7;
      if (bestScore >= threshold) {
        console.log(`[Speaker ${speaker}] ✓ MATCH: "${bestMatch.name}" with ${(bestScore * 100).toFixed(1)}% (threshold: ${(threshold * 100)}%)`);
        return [speaker, `${bestMatch.role || 'Arzt'} - ${bestMatch.name}`];
      } else {
        console.log(`[Speaker ${speaker}] ✗ No match - best was "${bestMatch?.name}" with ${(bestScore * 100).toFixed(1)}% (threshold: ${(threshold * 100)}%)`);
        return [speaker, `Sprecher ${speaker}`];
      }
    } catch (error) {
      console.error(`[Speaker ${speaker}] Error during recognition:`, error?.message);
      console.error(`[Speaker ${speaker}] Stack:`, error?.stack);
      return [speaker, `Sprecher ${speaker}`];
    }
    });
  } catch (parallelError) {
    // Fallback bei kritischem Fehler - Pipeline darf nie komplett sterben
    console.warn('[Speaker Recognition] Kritischer Fehler, verwende Fallback:', parallelError?.message);
    return createFallbackMapping(utterances);
  }

  // Convert results array to mapping object
  for (const [speaker, label] of results) {
    speakerMapping[speaker] = label;
  }

  // Nice formatted log
  console.log('');
  console.log('///// SPRECHER ERKANNT /////');
  Object.entries(speakerMapping).forEach(([key, value]) => {
    console.log(`  ${key} --> ${value}`);
  });
  console.log('////////////////////////////');
  console.log('');

  return speakerMapping;
}

/**
 * Enroll a new voice profile
 * @param {string} name - Speaker name (e.g., "Dr. Notle")
 * @param {string} audioFilePath - Path to enrollment audio (30+ seconds, can be WebM or WAV)
 * @param {string} role - Speaker role (e.g., "Arzt" or "ZFA")
 * @returns {Object} Created profile
 */
async function enrollSpeaker(name, audioFilePath, role = 'Arzt') {
  const audioConverter = require('../audio-converter');

  // Safety: ensure WAV 16kHz (recorder now records at 16kHz, but keep as fallback)
  const wavPath = await audioConverter.convertToWav16k(audioFilePath);

  // Create embedding from first 30 seconds
  const embedding = await createEmbedding(wavPath, 0, 30000);

  // Save profile with role (async - saves to backend API)
  const profile = await voiceProfiles.saveProfile(name, embedding, role);
  return profile;
}

/**
 * Create embedding from multiple utterance segments for a single speaker
 * Used by speaker optimization to collect audio from transcript utterances
 * @param {string} audioFilePath - Path to WAV file
 * @param {Array} utterances - Utterances for this speaker [{start, end, text}]
 * @param {number} targetDurationMs - Target total duration (default 15000)
 * @returns {Object} { embedding, totalDuration, segments }
 */
async function createEmbeddingFromUtterances(audioFilePath, utterances, targetDurationMs = 15000) {
  await initialize();

  const audioSegments = [];
  let totalDuration = 0;
  const usedSegments = [];

  // Sort by duration (prefer longer segments for better quality)
  const sorted = [...utterances].sort((a, b) =>
    (b.end - b.start) - (a.end - a.start)
  );

  for (const utt of sorted) {
    if (totalDuration >= targetDurationMs) break;

    const segmentDuration = Math.min(
      utt.end - utt.start,
      targetDurationMs - totalDuration
    );

    // Skip very short segments (less than 500ms)
    if (segmentDuration < 500) continue;

    const segment = extractAudioSegment(audioFilePath, utt.start, segmentDuration);
    if (segment.length > 0) {
      audioSegments.push(segment);
      totalDuration += segmentDuration;
      usedSegments.push({ start: utt.start, duration: segmentDuration });
    }
  }

  if (totalDuration < 5000) {
    throw new Error('Nicht genug Audio-Daten (mindestens 5 Sekunden benötigt)');
  }

  // Concatenate segments
  const totalSamples = audioSegments.reduce((sum, arr) => sum + arr.length, 0);
  const concatenated = new Float32Array(totalSamples);
  let offset = 0;
  for (const seg of audioSegments) {
    concatenated.set(seg, offset);
    offset += seg.length;
  }

  // Create embedding
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: concatenated });
  stream.inputFinished();
  const embedding = recognizer.compute(stream, false);

  return {
    embedding: Array.from(embedding),
    totalDuration,
    segments: usedSegments
  };
}

/**
 * Create a playable WAV preview clip from utterance segments
 * @param {string} audioFilePath - Source WAV file
 * @param {Array} utterances - Utterances to extract
 * @param {string} outputPath - Where to save the preview
 * @param {number} maxDurationMs - Max duration (default 15000)
 * @returns {Promise<string>} Path to preview WAV file
 */
async function createPreviewClip(audioFilePath, utterances, outputPath, maxDurationMs = 15000) {
  const audioSegments = [];
  let totalDuration = 0;

  // Sort by duration (prefer longer segments)
  const sorted = [...utterances].sort((a, b) =>
    (b.end - b.start) - (a.end - a.start)
  );

  for (const utt of sorted) {
    if (totalDuration >= maxDurationMs) break;

    const segmentDuration = Math.min(utt.end - utt.start, maxDurationMs - totalDuration);

    // Skip very short segments
    if (segmentDuration < 500) continue;

    const segment = extractAudioSegment(audioFilePath, utt.start, segmentDuration);

    if (segment.length > 0) {
      audioSegments.push(segment);
      totalDuration += segmentDuration;
    }
  }

  // Concatenate and write WAV
  const totalSamples = audioSegments.reduce((sum, arr) => sum + arr.length, 0);
  const concatenated = new Float32Array(totalSamples);
  let offset = 0;
  for (const seg of audioSegments) {
    concatenated.set(seg, offset);
    offset += seg.length;
  }

  // Write WAV file
  writeWavFile(outputPath, concatenated, 16000);

  return outputPath;
}

/**
 * Write Float32Array samples to WAV file
 * @param {string} filePath - Output file path
 * @param {Float32Array} samples - Audio samples (-1 to 1)
 * @param {number} sampleRate - Sample rate (default 16000)
 */
function writeWavFile(filePath, samples, sampleRate = 16000) {
  const buffer = Buffer.alloc(44 + samples.length * 2);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);       // Chunk size
  buffer.writeUInt16LE(1, 20);        // PCM format
  buffer.writeUInt16LE(1, 22);        // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);  // Byte rate
  buffer.writeUInt16LE(2, 32);        // Block align
  buffer.writeUInt16LE(16, 34);       // Bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);

  // Audio data (convert float to int16)
  for (let i = 0; i < samples.length; i++) {
    const val = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
}

/**
 * Clean up resources
 */
function cleanup() {
  if (recognizer) {
    recognizer.free();
    recognizer = null;
  }
}

module.exports = {
  initialize,
  createEmbedding,
  createEmbeddingFromUtterances,
  createPreviewClip,
  identifySpeaker,
  identifySpeakersFromUtterances,
  enrollSpeaker,
  cleanup,
  extractAudioSegment
};
