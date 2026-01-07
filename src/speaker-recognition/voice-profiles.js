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
 * Get all voice profiles
 * @returns {Array} Array of voice profiles
 */
function getAllProfiles() {
  const profiles = store.get('profiles', []);

  // Parse embeddings from JSON strings
  const parsedProfiles = profiles.map(profile => ({
    ...profile,
    embedding: typeof profile.embedding === 'string'
      ? JSON.parse(profile.embedding)
      : profile.embedding
  }));

  return parsedProfiles;
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
 * Save a new voice profile
 * @param {string} name - Speaker name (e.g., "Dr. Notle")
 * @param {Array} embedding - Voice embedding array
 * @param {string} role - Speaker role (e.g., "Arzt" or "ZFA")
 * @returns {Object} Created profile with ID
 */
function saveProfile(name, embedding, role = 'Arzt') {
  const profiles = getAllProfiles();

  // Check if profile with this name already exists
  const existing = getProfileByName(name);
  if (existing) {
    throw new Error(`Ein Stimmprofil für "${name}" existiert bereits`);
  }

  // Convert to plain array if needed
  const embeddingArray = Array.isArray(embedding) ? embedding : Array.from(embedding);

  const profile = {
    id: Date.now().toString(),
    name,
    role,
    embedding: JSON.stringify(embeddingArray), // Store as JSON string
    createdAt: new Date().toISOString()
  };

  profiles.push(profile);
  store.set('profiles', profiles);

  return {
    ...profile,
    embedding: embeddingArray // Return with array, not string
  };
}

/**
 * Update an existing voice profile
 * @param {string} id - Profile ID
 * @param {Object} updates - Fields to update (name, embedding)
 * @returns {Object} Updated profile
 */
function updateProfile(id, updates) {
  const profiles = getAllProfiles();
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
  const profiles = getAllProfiles();
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

module.exports = {
  getAllProfiles,
  getProfile,
  getProfileByName,
  saveProfile,
  updateProfile,
  deleteProfile,
  clearAllProfiles,
  setStorePath,
  getStorePath
};
