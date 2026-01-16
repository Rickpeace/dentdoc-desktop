const Store = require('electron-store');
const path = require('path');
const fs = require('fs');

// Store voice profiles in electron-store
let store = new Store({
  name: 'voice-profiles',
  defaults: {
    profiles: [] // Array of { id, name, embedding }
  }
});

// Debug logging helper (imported from main process or standalone)
let debugLog = console.log;
try {
  const { debugLog: mainDebugLog } = require('../../main.js');
  if (mainDebugLog) debugLog = mainDebugLog;
} catch (e) {
  // Running standalone, use console.log
}

/**
 * Set a custom storage path for voice profiles
 * @param {string} customPath - Custom directory path (e.g., network folder)
 */
let currentStorePath = null;

function setStorePath(customPath) {
  if (!customPath) {
    // Reset to default
    store = new Store({
      name: 'voice-profiles',
      defaults: { profiles: [] }
    });
    currentStorePath = null;
    return;
  }

  // Ensure directory exists
  if (!fs.existsSync(customPath)) {
    fs.mkdirSync(customPath, { recursive: true });
  }

  // Create store in custom location
  currentStorePath = customPath;
  store = new Store({
    name: 'voice-profiles',
    cwd: customPath,
    defaults: { profiles: [] }
  });
}

function getStorePath() {
  if (currentStorePath) {
    return currentStorePath;
  }
  // Return default path
  const { app } = require('electron');
  return path.join(app.getPath('userData'));
}

/**
 * Migrate a legacy profile (single embedding) to multi-embedding structure
 * @param {Object} profile - Legacy profile
 * @returns {Object} Migrated profile
 */
function migrateProfileToMultiEmbedding(profile) {
  // Already migrated
  if (profile.confirmed_embeddings) {
    return profile;
  }

  // Parse legacy embedding
  const legacyEmbedding = typeof profile.embedding === 'string'
    ? JSON.parse(profile.embedding)
    : profile.embedding;

  return {
    ...profile,
    confirmed_embeddings: legacyEmbedding ? [{
      embedding: JSON.stringify(legacyEmbedding),
      sourceType: 'enrollment',
      sourceDuration: 30000,
      createdAt: profile.createdAt
    }] : [],
    pending_embeddings: [],
    centroid: legacyEmbedding,
    centroid_updated_at: profile.createdAt,
    embedding: null // Clear legacy field
  };
}

/**
 * Compute centroid (average) of multiple embeddings
 * @param {Array<number[]>} embeddings - Array of embedding vectors
 * @returns {number[]|null} Centroid vector or null
 */
function computeCentroid(embeddings) {
  if (!embeddings || embeddings.length === 0) return null;
  if (embeddings.length === 1) return [...embeddings[0]];

  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    centroid[i] /= embeddings.length;
  }

  // Normalize to unit length
  const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return centroid;
  return centroid.map(v => v / norm);
}

/**
 * Calculate cosine similarity between two embeddings
 * @param {number[]} emb1 - First embedding
 * @param {number[]} emb2 - Second embedding
 * @returns {number} Similarity (0-1)
 */
function cosineSimilarity(emb1, emb2) {
  if (!emb1 || !emb2 || emb1.length !== emb2.length) return 0;

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < emb1.length; i++) {
    dotProduct += emb1[i] * emb2[i];
    norm1 += emb1[i] * emb1[i];
    norm2 += emb2[i] * emb2[i];
  }

  norm1 = Math.sqrt(norm1);
  norm2 = Math.sqrt(norm2);

  if (norm1 === 0 || norm2 === 0) return 0;
  return dotProduct / (norm1 * norm2);
}

/**
 * Check if pending embeddings should be promoted to confirmed
 * Promotion criteria:
 *   - Total pending duration >= 30s
 *   - Mean similarity to reference >= 0.65
 * @param {Object} profile - Profile to check
 * @returns {boolean} Whether promotion occurred
 */
function checkAndPromotePending(profile) {
  if (!profile.pending_embeddings || profile.pending_embeddings.length === 0) {
    return false;
  }

  // 1. Duration gate: need 30s minimum
  const totalDuration = profile.pending_embeddings.reduce(
    (sum, p) => sum + p.sourceDuration, 0
  );
  if (totalDuration < 30000) {
    return false;
  }

  // 2. Stability gate: mean similarity must be >= 0.65
  const similarities = profile.pending_embeddings.map(p => p.similarity_to_reference || 0);
  const meanSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

  if (meanSimilarity < 0.65) {
    // Only wipe pending if profile already has confirmed embeddings
    // For new profiles (no confirmed yet), keep pending but don't promote
    if (profile.confirmed_embeddings && profile.confirmed_embeddings.length > 0) {
      debugLog(`[VoiceProfile] promotion rejected for "${profile.name}" (mean sim ${meanSimilarity.toFixed(2)})`);
      profile.pending_embeddings = [];
    }
    return false;
  }

  // 3. Promote all pending to confirmed
  if (!profile.confirmed_embeddings) {
    profile.confirmed_embeddings = [];
  }

  for (const pending of profile.pending_embeddings) {
    profile.confirmed_embeddings.push({
      embedding: pending.embedding,
      sourceType: pending.sourceType,
      sourceDuration: pending.sourceDuration,
      createdAt: pending.createdAt
    });
  }

  debugLog(`[VoiceProfile] promoted for "${profile.name}" (${(totalDuration / 1000).toFixed(1)}s total)`);

  profile.pending_embeddings = [];

  // Recompute centroid
  const allEmbeddings = profile.confirmed_embeddings.map(e =>
    typeof e.embedding === 'string' ? JSON.parse(e.embedding) : e.embedding
  );
  profile.centroid = computeCentroid(allEmbeddings);
  profile.centroid_updated_at = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();

  return true;
}

/**
 * Get all voice profiles (with migration)
 * @returns {Array} Array of voice profiles
 */
function getAllProfiles() {
  const profiles = store.get('profiles', []);

  // Migrate and parse all profiles
  const migratedProfiles = profiles.map(profile => {
    const migrated = migrateProfileToMultiEmbedding(profile);

    // Parse centroid if it's a string
    if (migrated.centroid && typeof migrated.centroid === 'string') {
      migrated.centroid = JSON.parse(migrated.centroid);
    }

    // Legacy compatibility: expose embedding field for backward compat
    if (!migrated.embedding && migrated.centroid) {
      migrated.embedding = migrated.centroid;
    }

    return migrated;
  });

  return migratedProfiles;
}

/**
 * Get a specific voice profile by ID
 * @param {string} id - Profile ID
 * @returns {Object|null} Voice profile or null
 */
function getProfile(id) {
  const profiles = getAllProfiles();
  return profiles.find(p => p.id === id) || null;
}

/**
 * Get a voice profile by name
 * @param {string} name - Profile name
 * @returns {Object|null} Voice profile or null
 */
function getProfileByName(name) {
  const profiles = getAllProfiles();
  return profiles.find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
}

/**
 * Save a new voice profile (from Setup Wizard/Dashboard enrollment)
 * Goes directly to confirmed_embeddings
 * @param {string} name - Speaker name (e.g., "Dr. Notle")
 * @param {Array} embedding - Voice embedding array
 * @param {string} role - Speaker role (e.g., "Arzt" or "ZFA")
 * @returns {Object} Created profile with ID
 */
function saveProfile(name, embedding, role = 'Arzt') {
  const profiles = store.get('profiles', []);

  // Check if profile with this name already exists
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }

  // Never allow Patient role
  if (role === 'Patient') {
    throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
  }

  // Convert to plain array if needed
  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);

  const now = new Date().toISOString();
  const profile = {
    id: Date.now().toString(),
    name,
    role,
    createdAt: now,
    updatedAt: now,
    // New multi-embedding structure
    confirmed_embeddings: [{
      embedding: JSON.stringify(embeddingArray),
      sourceType: 'enrollment',
      sourceDuration: 30000,
      createdAt: now
    }],
    pending_embeddings: [],
    centroid: embeddingArray,
    centroid_updated_at: now,
    // Legacy field (null for new profiles)
    embedding: null
  };

  profiles.push(profile);
  store.set('profiles', profiles);

  return {
    ...profile,
    embedding: embeddingArray // Return with array for backward compat
  };
}

/**
 * Save a new voice profile with initial pending embedding (from optimization)
 * Goes to pending_embeddings, NOT confirmed
 * @param {string} name - Speaker name
 * @param {Array} embedding - Voice embedding array
 * @param {string} role - Speaker role
 * @param {Object} metadata - { sourceDuration, transcriptionId }
 * @returns {Object} Created profile
 */
function saveProfileWithPending(name, embedding, role = 'Arzt', metadata = {}) {
  const profiles = store.get('profiles', []);

  // Check if profile with this name already exists
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }

  // Never allow Patient role
  if (role === 'Patient') {
    throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
  }

  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
  const now = new Date().toISOString();

  const profile = {
    id: Date.now().toString(),
    name,
    role,
    createdAt: now,
    updatedAt: now,
    confirmed_embeddings: [],
    pending_embeddings: [{
      embedding: JSON.stringify(embeddingArray),
      sourceType: 'optimization',
      sourceDuration: metadata.sourceDuration || 15000,
      createdAt: now,
      transcriptionId: metadata.transcriptionId,
      similarity_to_reference: 1.0 // First embedding is its own reference
    }],
    centroid: null, // No centroid until confirmed
    centroid_updated_at: null,
    embedding: null
  };

  profiles.push(profile);
  store.set('profiles', profiles);

  debugLog(`[VoiceProfile] pending added (${((metadata.sourceDuration || 15000) / 1000).toFixed(1)}s) to "${name}" (new profile)`);

  return profile;
}

/**
 * Add a new embedding to pending (from optimization flow)
 * @param {string} profileId - Profile ID
 * @param {number[]} embedding - Voice embedding vector
 * @param {Object} metadata - { sourceDuration, transcriptionId }
 * @returns {Object} Updated profile
 */
function addPendingEmbedding(profileId, embedding, metadata = {}) {
  const profiles = store.get('profiles', []);
  const index = profiles.findIndex(p => p.id === profileId);

  if (index === -1) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  let profile = migrateProfileToMultiEmbedding(profiles[index]);

  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);

  // Compute similarity to current reference
  let similarity = 1.0;
  if (profile.centroid) {
    similarity = cosineSimilarity(embeddingArray, profile.centroid);
  } else if (profile.pending_embeddings && profile.pending_embeddings.length > 0) {
    // No centroid yet, compare to mean of pending
    const pendingEmbeddings = profile.pending_embeddings.map(p =>
      typeof p.embedding === 'string' ? JSON.parse(p.embedding) : p.embedding
    );
    const pendingMean = computeCentroid(pendingEmbeddings);
    if (pendingMean) {
      similarity = cosineSimilarity(embeddingArray, pendingMean);
    }
  }

  if (!profile.pending_embeddings) {
    profile.pending_embeddings = [];
  }

  profile.pending_embeddings.push({
    embedding: JSON.stringify(embeddingArray),
    sourceType: 'optimization',
    sourceDuration: metadata.sourceDuration || 15000,
    createdAt: new Date().toISOString(),
    transcriptionId: metadata.transcriptionId,
    similarity_to_reference: similarity
  });

  profile.updatedAt = new Date().toISOString();

  debugLog(`[VoiceProfile] pending added (${((metadata.sourceDuration || 15000) / 1000).toFixed(1)}s) to "${profile.name}"`);

  // Check for promotion
  checkAndPromotePending(profile);

  profiles[index] = profile;
  store.set('profiles', profiles);

  return profile;
}

/**
 * Update an existing voice profile
 * @param {string} id - Profile ID
 * @param {Object} updates - Fields to update (name, embedding)
 * @returns {Object} Updated profile
 */
function updateProfile(id, updates) {
  const profiles = store.get('profiles', []);
  const index = profiles.findIndex(p => p.id === id);

  if (index === -1) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  profiles[index] = {
    ...profiles[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  store.set('profiles', profiles);
  return profiles[index];
}

/**
 * Delete a voice profile
 * @param {string} id - Profile ID
 * @returns {boolean} Success
 */
function deleteProfile(id) {
  const profiles = store.get('profiles', []);
  const filtered = profiles.filter(p => p.id !== id);

  if (filtered.length === profiles.length) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  store.set('profiles', filtered);
  return true;
}

/**
 * Clear all voice profiles (useful for testing)
 * @returns {boolean} Success
 */
function clearAllProfiles() {
  store.set('profiles', []);
  return true;
}

/**
 * Set the debug log function (called from main process)
 * @param {Function} logFn - Debug log function
 */
function setDebugLog(logFn) {
  debugLog = logFn;
}

module.exports = {
  getAllProfiles,
  getProfile,
  getProfileByName,
  saveProfile,
  saveProfileWithPending,
  addPendingEmbedding,
  checkAndPromotePending,
  computeCentroid,
  cosineSimilarity,
  updateProfile,
  deleteProfile,
  clearAllProfiles,
  setStorePath,
  getStorePath,
  setDebugLog
};
