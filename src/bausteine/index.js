/**
 * Bausteine-Verwaltung für DentDoc
 *
 * Verwaltet die Dokumentations-Bausteine:
 * - Lädt praxis-spezifische Bausteine aus electron-store
 * - Fällt auf Default-Bausteine zurück wenn keine eigenen definiert
 * - Erlaubt Speichern/Laden/Zurücksetzen von Bausteinen
 */

const Store = require('electron-store');
const { DEFAULT_BAUSTEINE } = require('./defaults');

const store = new Store();
const STORE_KEY = 'bausteine';

/**
 * Lädt alle Bausteine (praxis-spezifisch oder Defaults)
 * @returns {Object} Bausteine-Objekt
 */
function getAllBausteine() {
  const customBausteine = store.get(STORE_KEY);

  if (!customBausteine || Object.keys(customBausteine).length === 0) {
    return { ...DEFAULT_BAUSTEINE };
  }

  // Merge: Custom überschreibt Defaults
  return { ...DEFAULT_BAUSTEINE, ...customBausteine };
}

/**
 * Lädt einen einzelnen Baustein
 * @param {string} kategorie - Kategorie-ID (z.B. 'FUELLUNG')
 * @returns {Object|null} Baustein oder null
 */
function getBaustein(kategorie) {
  const allBausteine = getAllBausteine();
  return allBausteine[kategorie] || null;
}

/**
 * Speichert einen Baustein (überschreibt Default)
 * @param {string} kategorie - Kategorie-ID
 * @param {Object} baustein - Baustein-Objekt mit name, standardText, keywords
 */
function saveBaustein(kategorie, baustein) {
  const customBausteine = store.get(STORE_KEY) || {};
  customBausteine[kategorie] = baustein;
  store.set(STORE_KEY, customBausteine);
}

/**
 * Speichert alle Bausteine auf einmal
 * @param {Object} bausteine - Komplettes Bausteine-Objekt
 */
function saveAllBausteine(bausteine) {
  store.set(STORE_KEY, bausteine);
}

/**
 * Setzt einen Baustein auf den Default zurück
 * @param {string} kategorie - Kategorie-ID
 */
function resetBaustein(kategorie) {
  const customBausteine = store.get(STORE_KEY) || {};
  delete customBausteine[kategorie];
  store.set(STORE_KEY, customBausteine);
}

/**
 * Setzt alle Bausteine auf Defaults zurück
 */
function resetAllBausteine() {
  store.delete(STORE_KEY);
}

/**
 * Prüft ob ein Baustein vom Default abweicht
 * @param {string} kategorie - Kategorie-ID
 * @returns {boolean} true wenn custom, false wenn default
 */
function isCustomBaustein(kategorie) {
  const customBausteine = store.get(STORE_KEY) || {};
  return kategorie in customBausteine;
}

/**
 * Gibt die Default-Bausteine zurück (ohne custom overrides)
 * @returns {Object} Default-Bausteine
 */
function getDefaultBausteine() {
  return { ...DEFAULT_BAUSTEINE };
}

/**
 * Exportiert Bausteine als JSON-String
 * @returns {string} JSON-String
 */
function exportBausteine() {
  return JSON.stringify(getAllBausteine(), null, 2);
}

/**
 * Importiert Bausteine aus JSON-String
 * @param {string} json - JSON-String mit Bausteinen
 * @returns {boolean} true wenn erfolgreich
 */
function importBausteine(json) {
  try {
    const imported = JSON.parse(json);

    // Validierung: Muss ein Objekt sein mit gültigen Bausteinen
    if (typeof imported !== 'object' || imported === null) {
      throw new Error('Ungültiges Format: Muss ein Objekt sein');
    }

    for (const [key, value] of Object.entries(imported)) {
      if (!value.name || !value.standardText) {
        throw new Error(`Baustein "${key}" fehlt name oder standardText`);
      }
    }

    saveAllBausteine(imported);
    return true;
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  }
}

module.exports = {
  getAllBausteine,
  getBaustein,
  saveBaustein,
  saveAllBausteine,
  resetBaustein,
  resetAllBausteine,
  isCustomBaustein,
  getDefaultBausteine,
  exportBausteine,
  importBausteine,
  DEFAULT_BAUSTEINE
};
