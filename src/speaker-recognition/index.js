const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.tmpdir(), 'dentdoc-debug.log');

// Log module loading
fs.appendFileSync(LOG_PATH, `\n\n[${new Date().toISOString()}] ============= SPEAKER RECOGNITION MODULE LOADING =============\n`);

let sherpa;
try {
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Loading sherpa-onnx-node...\n`);
  sherpa = require('sherpa-onnx-node');
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sherpa-onnx-node loaded successfully\n`);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Available sherpa exports: ${Object.keys(sherpa).join(', ')}\n`);
} catch (error) {
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ERROR loading sherpa-onnx-node: ${error.message}\n`);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Stack: ${error.stack}\n`);
  throw error;
}

const { app } = require('electron');

let voiceProfiles;
try {
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Loading voice-profiles...\n`);
  voiceProfiles = require('./voice-profiles');
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] voice-profiles loaded successfully\n`);
} catch (error) {
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ERROR loading voice-profiles: ${error.message}\n`);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Stack: ${error.stack}\n`);
  throw error;
}

let recognizer = null;
let modelPath = null;

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

  console.log('Initializing Sherpa-ONNX with model:', modelPath);
  fs.appendFileSync(LOG_PATH, `\n[${new Date().toISOString()}] Initializing Sherpa-ONNX with model: ${modelPath}\n`);

  // Create recognizer config
  const config = {
    model: modelPath,
    numThreads: 2,
    debug: true,
    provider: 'cpu'
  };

  try {
    // Check what functions are available
    console.log('Available Sherpa functions:', Object.keys(sherpa));

    // Try different possible function names
    if (typeof sherpa.SpeakerEmbeddingExtractor === 'function') {
      recognizer = new sherpa.SpeakerEmbeddingExtractor(config);
    } else if (typeof sherpa.createSpeakerEmbeddingExtractor === 'function') {
      recognizer = sherpa.createSpeakerEmbeddingExtractor(config);
    } else {
      throw new Error('No suitable Sherpa-ONNX function found. Available: ' + Object.keys(sherpa).join(', '));
    }

    console.log('Sherpa-ONNX speaker recognition initialized');
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] Sherpa-ONNX initialized successfully\n`);
    return recognizer;
  } catch (error) {
    console.error('Failed to initialize Sherpa-ONNX:', error);
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ERROR initializing Sherpa: ${error.message}\n${error.stack}\n`);
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
  const audioConverter = require('../audio-converter');

  let wavPath = audioFilePath;

  // Convert to WAV 16kHz if needed
  if (audioFilePath.toLowerCase().endsWith('.webm') ||
      audioFilePath.toLowerCase().endsWith('.mp3') ||
      audioFilePath.toLowerCase().endsWith('.m4a')) {
    console.log('Converting audio to WAV 16kHz for speaker identification...');
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

  // Identify each speaker by concatenating their segments
  for (const [speaker, segments] of Object.entries(speakerSegments)) {
    try {
      // Concatenate audio from all speaker segments until we have 30 seconds
      const audioSegments = [];
      let totalDuration = 0;

      for (const segment of segments) {
        if (totalDuration >= 30000) break; // We have enough

        const segmentAudio = extractAudioSegment(
          wavPath,
          segment.start,
          Math.min(segment.duration, 30000 - totalDuration)
        );

        audioSegments.push(segmentAudio);
        totalDuration += Math.min(segment.duration, 30000 - totalDuration);
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
      await initialize();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: concatenatedAudio });
      stream.inputFinished();
      const embedding = recognizer.compute(stream, false);

      // Compare with profiles
      const profiles = voiceProfiles.getAllProfiles();
      let bestMatch = null;
      let bestScore = 0;

      for (const profile of profiles) {
        const similarity = cosineSimilarity(embedding, profile.embedding);
        if (similarity > bestScore) {
          bestScore = similarity;
          bestMatch = profile;
        }
      }

      if (bestScore >= 0.7) {
        // Format as "Rolle - Name" (e.g., "Arzt - Dr. Notle")
        speakerMapping[speaker] = `${bestMatch.role || 'Arzt'} - ${bestMatch.name}`;
        console.log(`Speaker ${speaker} identified as ${bestMatch.role || 'Arzt'} - ${bestMatch.name} (similarity: ${bestScore.toFixed(2)})`);
      } else {
        speakerMapping[speaker] = `Sprecher ${speaker}`;
        console.log(`Speaker ${speaker} could not be identified`);
      }
    } catch (error) {
      console.error(`Failed to identify speaker ${speaker}:`, error);
      speakerMapping[speaker] = `Sprecher ${speaker}`;
    }
  }

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

  let wavPath = audioFilePath;

  // Convert to WAV 16kHz if needed
  if (audioFilePath.toLowerCase().endsWith('.webm') ||
      audioFilePath.toLowerCase().endsWith('.mp3') ||
      audioFilePath.toLowerCase().endsWith('.m4a')) {
    console.log('Converting audio to WAV 16kHz...');
    wavPath = await audioConverter.convertToWav16k(audioFilePath);
  }

  // Create embedding from first 30 seconds
  const embedding = await createEmbedding(wavPath, 0, 30000);

  // Save profile with role
  const profile = voiceProfiles.saveProfile(name, embedding, role);

  console.log(`Enrolled speaker: ${name} (${role})`);
  return profile;
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
  identifySpeaker,
  identifySpeakersFromUtterances,
  enrollSpeaker,
  cleanup
};
