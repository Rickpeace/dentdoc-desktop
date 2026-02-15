/**
 * Voice Profiles Module
 * Manages voice profiles via backend API with in-memory cache.
 * Profiles are stored in the backend database, cached locally for fast access.
 */

// In-memory cache of profiles (loaded from API on init)
let profilesCache = [];

// API client reference and token getter (set via init())
let _apiClient = null;
let _getToken = null;

/**
 * Initialize the voice profiles module
 * Must be called after user login, before any profile operations
 * @param {Object} apiClient - The apiClient module
 * @param {Function} getToken - Function that returns the current auth token
 */
async function init(apiClient, getToken) {
  _apiClient = apiClient;
  _getToken = getToken;
  await refreshCache();
}

/**
 * Refresh the in-memory cache from the backend API
 */
async function refreshCache() {
  if (!_apiClient || !_getToken) {
    console.log('[VoiceProfile] Not initialized, cache empty');
    profilesCache = [];
    return;
  }

  try {
    const token = _getToken();
    if (!token) {
      profilesCache = [];
      return;
    }

    const profiles = await _apiClient.getVoiceProfiles(token);
    // Parse profiles for in-memory use
    profilesCache = (profiles || []).map(parseProfileFromDB);
    console.log(`[VoiceProfile] Cache refreshed: ${profilesCache.length} profiles`);
  } catch (error) {
    console.error('[VoiceProfile] Cache refresh failed:', error.message);
    // Keep existing cache on error
  }
}

/**
 * Parse a profile from DB format to in-memory format
 * DB stores embeddings as JSON text strings, we need parsed arrays
 */
function parseProfileFromDB(dbProfile) {
  const profile = {
    id: dbProfile.id,
    name: dbProfile.name || dbProfile.profile_name,
    role: dbProfile.role,
    createdAt: dbProfile.createdAt || dbProfile.created_at,
    updatedAt: dbProfile.updatedAt || dbProfile.updated_at,
    confirmed_embeddings: typeof dbProfile.confirmedEmbeddings === 'string'
      ? JSON.parse(dbProfile.confirmedEmbeddings || dbProfile.confirmed_embeddings || '[]')
      : (dbProfile.confirmedEmbeddings || dbProfile.confirmed_embeddings || []),
    pending_embeddings: typeof dbProfile.pendingEmbeddings === 'string'
      ? JSON.parse(dbProfile.pendingEmbeddings || dbProfile.pending_embeddings || '[]')
      : (dbProfile.pendingEmbeddings || dbProfile.pending_embeddings || []),
    centroid: null,
    centroid_updated_at: dbProfile.centroidUpdatedAt || dbProfile.centroid_updated_at || null,
    embedding: null, // Legacy compat
  };

  // Parse centroid
  const rawCentroid = dbProfile.centroid;
  if (rawCentroid) {
    profile.centroid = typeof rawCentroid === 'string' ? JSON.parse(rawCentroid) : rawCentroid;
  }

  // Legacy compatibility: expose embedding field
  if (!profile.embedding && profile.centroid) {
    profile.embedding = profile.centroid;
  }

  return profile;
}

/**
 * Serialize a profile for sending to the API
 */
function serializeProfileForAPI(profileData) {
  const data = { ...profileData };

  // Ensure embeddings are JSON strings for the API
  if (data.confirmedEmbeddings && typeof data.confirmedEmbeddings !== 'string') {
    data.confirmedEmbeddings = JSON.stringify(data.confirmedEmbeddings);
  }
  if (data.pendingEmbeddings && typeof data.pendingEmbeddings !== 'string') {
    data.pendingEmbeddings = JSON.stringify(data.pendingEmbeddings);
  }
  if (data.centroid && typeof data.centroid !== 'string') {
    data.centroid = JSON.stringify(data.centroid);
  }

  return data;
}

// ===========================================
// Pure math functions (no storage)
// ===========================================

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
 * @param {Object} profile - Profile to check (MUTATED in place)
 * @returns {boolean} Whether promotion occurred
 */
function checkAndPromotePending(profile) {
  if (!profile.pending_embeddings || profile.pending_embeddings.length === 0) {
    return false;
  }

  // Duration gate: need 15s minimum
  const totalDuration = profile.pending_embeddings.reduce(
    (sum, p) => sum + p.sourceDuration, 0
  );
  if (totalDuration < 15000) {
    return false;
  }

  // Stability gate: mean similarity >= 0.65
  const similarities = profile.pending_embeddings.map(p => p.similarity_to_reference || 0);
  const meanSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

  if (meanSimilarity < 0.65) {
    if (profile.confirmed_embeddings && profile.confirmed_embeddings.length > 0) {
      console.log(`[VoiceProfile] promotion rejected for "${profile.name}" (mean sim ${meanSimilarity.toFixed(2)})`);
      profile.pending_embeddings = [];
    }
    return false;
  }

  // Promote all pending to confirmed
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

  console.log(`[VoiceProfile] promoted for "${profile.name}" (${(totalDuration / 1000).toFixed(1)}s total)`);

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

// ===========================================
// SYNC read functions (from cache)
// ===========================================

/**
 * Get all voice profiles from cache
 * @returns {Array} Array of voice profiles
 */
function getAllProfiles() {
  return profilesCache;
}

/**
 * Get a specific voice profile by ID
 * @param {number} id - Profile ID (DB serial integer)
 * @returns {Object|null} Voice profile or null
 */
function getProfile(id) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  return profilesCache.find(p => p.id === numId) || null;
}

/**
 * Get a voice profile by name (case-insensitive)
 * @param {string} name - Profile name
 * @returns {Object|null} Voice profile or null
 */
function getProfileByName(name) {
  return profilesCache.find(p => p.name.toLowerCase() === name.toLowerCase()) || null;
}

// ===========================================
// ASYNC write functions (API + cache update)
// ===========================================

/**
 * Save a new voice profile (from enrollment - goes directly to confirmed)
 * @param {string} name - Speaker name
 * @param {Array} embedding - Voice embedding array
 * @param {string} role - Speaker role
 * @returns {Promise<Object>} Created profile
 */
async function saveProfile(name, embedding, role = 'Arzt') {
  // Check for duplicate
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }
  if (role === 'Patient') {
    throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
  }

  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
  const now = new Date().toISOString();

  const confirmedEmbeddings = [{
    embedding: JSON.stringify(embeddingArray),
    sourceType: 'enrollment',
    sourceDuration: 30000,
    createdAt: now
  }];

  const token = _getToken();
  const dbProfile = await _apiClient.createVoiceProfile(token, serializeProfileForAPI({
    name,
    role,
    confirmedEmbeddings,
    pendingEmbeddings: [],
    centroid: embeddingArray,
    centroidUpdatedAt: now,
  }));

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache.push(parsed);

  return {
    ...parsed,
    embedding: embeddingArray // Backward compat
  };
}

/**
 * Save a new profile with initial pending embedding (from optimization)
 * @param {string} name - Speaker name
 * @param {Array} embedding - Voice embedding array
 * @param {string} role - Speaker role
 * @param {Object} metadata - { sourceDuration, transcriptionId }
 * @returns {Promise<Object>} Created profile
 */
async function saveProfileWithPending(name, embedding, role = 'Arzt', metadata = {}) {
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }
  if (role === 'Patient') {
    throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
  }

  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
  const now = new Date().toISOString();

  const pendingEmbeddings = [{
    embedding: JSON.stringify(embeddingArray),
    sourceType: 'optimization',
    sourceDuration: metadata.sourceDuration || 15000,
    createdAt: now,
    transcriptionId: metadata.transcriptionId,
    similarity_to_reference: 1.0
  }];

  const token = _getToken();
  const dbProfile = await _apiClient.createVoiceProfile(token, serializeProfileForAPI({
    name,
    role,
    confirmedEmbeddings: [],
    pendingEmbeddings,
    centroid: null,
    centroidUpdatedAt: null,
  }));

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache.push(parsed);

  console.log(`[VoiceProfile] pending added (${((metadata.sourceDuration || 15000) / 1000).toFixed(1)}s) to "${name}" (new profile)`);
  return parsed;
}

/**
 * Create profile with IMMEDIATELY active embedding (for utterance assignment)
 * @param {string} name - Speaker name
 * @param {number[]} embedding - Voice embedding vector
 * @param {string} role - Speaker role
 * @param {Object} metadata - { sourceType, sourceDuration }
 * @returns {Promise<Object>} Created profile
 */
async function saveProfileDirect(name, embedding, role = 'Arzt', metadata = {}) {
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }
  if (role === 'Patient') {
    throw new Error('Patienten können nicht als Stimmprofil gespeichert werden');
  }

  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);
  const now = new Date().toISOString();

  const confirmedEmbeddings = [{
    embedding: JSON.stringify(embeddingArray),
    sourceType: metadata.sourceType || 'utterance',
    sourceDuration: metadata.sourceDuration || 0,
    createdAt: now
  }];

  const token = _getToken();
  const dbProfile = await _apiClient.createVoiceProfile(token, serializeProfileForAPI({
    name,
    role,
    confirmedEmbeddings,
    pendingEmbeddings: [],
    centroid: embeddingArray,
    centroidUpdatedAt: now,
  }));

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache.push(parsed);

  console.log(`[VoiceProfile] created "${name}" with immediate embedding (utterance)`);
  return parsed;
}

/**
 * Add a new embedding to pending (from optimization flow)
 * @param {number} profileId - Profile ID
 * @param {number[]} embedding - Voice embedding vector
 * @param {Object} metadata - { sourceDuration, transcriptionId }
 * @returns {Promise<Object>} Updated profile
 */
async function addPendingEmbedding(profileId, embedding, metadata = {}) {
  const numId = typeof profileId === 'string' ? parseInt(profileId, 10) : profileId;
  const index = profilesCache.findIndex(p => p.id === numId);
  if (index === -1) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  let profile = { ...profilesCache[index] };
  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);

  // Compute similarity to current reference
  let similarity = 1.0;
  if (profile.centroid) {
    similarity = cosineSimilarity(embeddingArray, profile.centroid);
  } else if (profile.pending_embeddings && profile.pending_embeddings.length > 0) {
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

  console.log(`[VoiceProfile] pending added (${((metadata.sourceDuration || 15000) / 1000).toFixed(1)}s) to "${profile.name}"`);

  // Check for promotion
  checkAndPromotePending(profile);

  // Persist to API
  const token = _getToken();
  const dbProfile = await _apiClient.updateVoiceProfile(token, numId, serializeProfileForAPI({
    confirmedEmbeddings: profile.confirmed_embeddings,
    pendingEmbeddings: profile.pending_embeddings,
    centroid: profile.centroid,
    centroidUpdatedAt: profile.centroid_updated_at,
  }));

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache[index] = parsed;
  return parsed;
}

/**
 * Add embedding DIRECTLY to confirmed (for manual utterance-to-profile)
 * @param {number} profileId - Profile ID
 * @param {number[]} embedding - Voice embedding vector
 * @param {Object} metadata - { sourceType, sourceDuration }
 * @returns {Promise<Object|null>} Updated profile or null
 */
async function addConfirmedEmbedding(profileId, embedding, metadata = {}) {
  const numId = typeof profileId === 'string' ? parseInt(profileId, 10) : profileId;
  const index = profilesCache.findIndex(p => p.id === numId);
  if (index === -1) return null;

  let profile = { ...profilesCache[index] };
  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);

  if (!profile.confirmed_embeddings) {
    profile.confirmed_embeddings = [];
  }

  profile.confirmed_embeddings.push({
    embedding: JSON.stringify(embeddingArray),
    sourceType: metadata.sourceType || 'utterance',
    sourceDuration: metadata.sourceDuration || 0,
    createdAt: new Date().toISOString()
  });

  // Recompute centroid
  const allEmbeddings = profile.confirmed_embeddings.map(e =>
    typeof e.embedding === 'string' ? JSON.parse(e.embedding) : e.embedding
  );
  profile.centroid = computeCentroid(allEmbeddings);
  profile.centroid_updated_at = new Date().toISOString();
  profile.updatedAt = new Date().toISOString();

  // Persist to API
  const token = _getToken();
  const dbProfile = await _apiClient.updateVoiceProfile(token, numId, serializeProfileForAPI({
    confirmedEmbeddings: profile.confirmed_embeddings,
    centroid: profile.centroid,
    centroidUpdatedAt: profile.centroid_updated_at,
  }));

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache[index] = parsed;

  console.log(`[VoiceProfile] confirmed embedding added to "${parsed.name}" (now ${parsed.confirmed_embeddings.length} samples)`);
  return parsed;
}

/**
 * Update an existing voice profile (e.g., rename)
 * @param {number} id - Profile ID
 * @param {Object} updates - Fields to update (name)
 * @returns {Promise<Object>} Updated profile
 */
async function updateProfile(id, updates) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const index = profilesCache.findIndex(p => p.id === numId);
  if (index === -1) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  const token = _getToken();
  const dbProfile = await _apiClient.updateVoiceProfile(token, numId, updates);

  const parsed = parseProfileFromDB(dbProfile);
  profilesCache[index] = parsed;
  return parsed;
}

/**
 * Delete a voice profile
 * @param {number} id - Profile ID
 * @returns {Promise<boolean>} Success
 */
async function deleteProfile(id) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const index = profilesCache.findIndex(p => p.id === numId);
  if (index === -1) {
    throw new Error('Stimmprofil nicht gefunden');
  }

  const token = _getToken();
  await _apiClient.deleteVoiceProfile(token, numId);

  profilesCache.splice(index, 1);
  return true;
}

module.exports = {
  init,
  refreshCache,
  getAllProfiles,
  getProfile,
  getProfileByName,
  saveProfile,
  saveProfileWithPending,
  saveProfileDirect,
  addPendingEmbedding,
  addConfirmedEmbedding,
  checkAndPromotePending,
  computeCentroid,
  cosineSimilarity,
  updateProfile,
  deleteProfile,
};
