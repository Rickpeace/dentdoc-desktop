/**
 * Bausteine-Verwaltung für DentDoc
 *
 * Verwaltet die Dokumentations-Bausteine:
 * - Lädt Bausteine aus einer JSON-Datei (netzwerkfähig)
 * - Unterstützt Kategorien/Ordner für bessere Organisation
 * - Fällt auf Default-Bausteine zurück wenn keine eigenen definiert
 * - Erlaubt Speichern/Laden/Zurücksetzen von Bausteinen
 */

const Store = require('electron-store');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DEFAULT_BAUSTEINE } = require('./defaults');

const store = new Store();
const STORE_KEY = 'bausteine';
const PATH_KEY = 'bausteinePath';

// Default-Pfad für Bausteine-Datei
function getDefaultBausteinePath() {
  const documentsPath = app.getPath('documents');
  return path.join(documentsPath, 'DentDoc', 'bausteine.json');
}

// Aktuellen Speicherpfad holen
function getBausteinePath() {
  return store.get(PATH_KEY) || getDefaultBausteinePath();
}

// Speicherpfad setzen
function setBausteinePath(newPath) {
  store.set(PATH_KEY, newPath);
}

// Bausteine aus Datei laden
function loadBausteineFromFile() {
  const filePath = getBausteinePath();

  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(data);

      // Prüfe ob neues Format mit Kategorien oder altes Format
      if (parsed.categories) {
        return parsed;
      } else {
        // Altes Format: Migrieren zu neuem Format
        return migrateToNewFormat(parsed);
      }
    }
  } catch (error) {
    console.error('Fehler beim Laden der Bausteine-Datei:', error);
  }

  return null;
}

// Altes Format zu neuem Format migrieren
function migrateToNewFormat(oldBausteine) {
  return {
    version: 1,
    categories: [
      {
        id: 'default',
        name: 'Allgemein',
        bausteine: Object.entries(oldBausteine).map(([id, b]) => ({
          id,
          name: b.name,
          standardText: b.standardText,
          keywords: b.keywords || []
        }))
      }
    ]
  };
}

// Bausteine in Datei speichern
function saveBausteineToFile(data) {
  const filePath = getBausteinePath();
  const dir = path.dirname(filePath);

  // Ordner erstellen falls nötig
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Default-Bausteine im neuen Format
function getDefaultBausteineWithCategories() {
  return {
    version: 1,
    categories: [
      {
        id: 'behandlungen',
        name: 'Behandlungen',
        bausteine: [
          { id: 'FUELLUNG', ...DEFAULT_BAUSTEINE.FUELLUNG },
          { id: 'EXTRAKTION', ...DEFAULT_BAUSTEINE.EXTRAKTION },
          { id: 'WKB', ...DEFAULT_BAUSTEINE.WKB },
          { id: 'PA', ...DEFAULT_BAUSTEINE.PA },
          { id: 'SCHMERZBEHANDLUNG', ...DEFAULT_BAUSTEINE.SCHMERZBEHANDLUNG }
        ]
      },
      {
        id: 'beratung',
        name: 'Beratung & Prophylaxe',
        bausteine: [
          { id: 'ZE_BERATUNG', ...DEFAULT_BAUSTEINE.ZE_BERATUNG },
          { id: 'PZR', ...DEFAULT_BAUSTEINE.PZR },
          { id: 'KONTROLLE', ...DEFAULT_BAUSTEINE.KONTROLLE }
        ]
      }
    ]
  };
}

/**
 * Lädt alle Bausteine mit Kategorien (neues Format)
 * @returns {Object} Bausteine-Objekt mit categories Array
 */
function getAllBausteineWithCategories() {
  const fromFile = loadBausteineFromFile();
  if (fromFile) {
    return fromFile;
  }
  return getDefaultBausteineWithCategories();
}

/**
 * Lädt alle Bausteine im alten flachen Format (für API-Kompatibilität)
 * @returns {Object} Bausteine-Objekt (flach)
 */
function getAllBausteine() {
  const data = getAllBausteineWithCategories();

  // Flaches Format für API erstellen
  const flat = {};
  for (const category of data.categories) {
    for (const baustein of category.bausteine) {
      flat[baustein.id] = {
        name: baustein.name,
        standardText: baustein.standardText,
        keywords: baustein.keywords || []
      };
    }
  }

  return flat;
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
 * Speichert alle Bausteine (neues Format mit Kategorien)
 * @param {Object} data - Komplettes Bausteine-Objekt mit categories
 */
function saveAllBausteineWithCategories(data) {
  saveBausteineToFile(data);
}

/**
 * Speichert alle Bausteine (altes flaches Format - wird konvertiert)
 * @param {Object} bausteine - Flaches Bausteine-Objekt
 */
function saveAllBausteine(bausteine) {
  // Konvertiere altes Format zu neuem
  const newFormat = migrateToNewFormat(bausteine);
  saveBausteineToFile(newFormat);
}

/**
 * Setzt einen Baustein auf den Default zurück
 * @param {string} bausteinId - Baustein-ID
 */
function resetBaustein(bausteinId) {
  const data = getAllBausteineWithCategories();
  const defaults = getDefaultBausteineWithCategories();

  // Finde den Default-Baustein
  let defaultBaustein = null;
  let defaultCategoryId = null;
  for (const cat of defaults.categories) {
    const found = cat.bausteine.find(b => b.id === bausteinId);
    if (found) {
      defaultBaustein = found;
      defaultCategoryId = cat.id;
      break;
    }
  }

  if (!defaultBaustein) return;

  // Finde und ersetze den Baustein in den aktuellen Daten
  for (const cat of data.categories) {
    const idx = cat.bausteine.findIndex(b => b.id === bausteinId);
    if (idx !== -1) {
      cat.bausteine[idx] = { ...defaultBaustein };
      break;
    }
  }

  saveBausteineToFile(data);
}

/**
 * Setzt alle Bausteine auf Defaults zurück
 */
function resetAllBausteine() {
  const filePath = getBausteinePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Gibt die Default-Bausteine zurück (flaches Format)
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
  return JSON.stringify(getAllBausteineWithCategories(), null, 2);
}

/**
 * Importiert Bausteine aus JSON-String
 * @param {string} json - JSON-String mit Bausteinen
 * @returns {boolean} true wenn erfolgreich
 */
function importBausteine(json) {
  try {
    const imported = JSON.parse(json);

    // Prüfe ob neues oder altes Format
    if (imported.categories && Array.isArray(imported.categories)) {
      // Neues Format - validieren
      for (const cat of imported.categories) {
        if (!cat.id || !cat.name || !Array.isArray(cat.bausteine)) {
          throw new Error(`Kategorie ungültig: ${JSON.stringify(cat)}`);
        }
        for (const b of cat.bausteine) {
          if (!b.id || !b.name || !b.standardText) {
            throw new Error(`Baustein ungültig: ${JSON.stringify(b)}`);
          }
        }
      }
      saveBausteineToFile(imported);
    } else {
      // Altes flaches Format
      for (const [key, value] of Object.entries(imported)) {
        if (!value.name || !value.standardText) {
          throw new Error(`Baustein "${key}" fehlt name oder standardText`);
        }
      }
      saveAllBausteine(imported);
    }

    return true;
  } catch (error) {
    console.error('Import failed:', error);
    throw error;
  }
}

// ============================================
// Kategorien-Management
// ============================================

/**
 * Erstellt eine neue Kategorie
 * @param {string} name - Name der Kategorie
 * @returns {Object} Die neue Kategorie
 */
function createCategory(name) {
  const data = getAllBausteineWithCategories();
  const id = 'cat_' + Date.now();

  const newCategory = {
    id,
    name,
    bausteine: []
  };

  data.categories.push(newCategory);
  saveBausteineToFile(data);

  return newCategory;
}

/**
 * Benennt eine Kategorie um
 * @param {string} categoryId - ID der Kategorie
 * @param {string} newName - Neuer Name
 */
function renameCategory(categoryId, newName) {
  const data = getAllBausteineWithCategories();
  const cat = data.categories.find(c => c.id === categoryId);

  if (cat) {
    cat.name = newName;
    saveBausteineToFile(data);
  }
}

/**
 * Löscht eine Kategorie (Bausteine werden in "Allgemein" verschoben)
 * @param {string} categoryId - ID der Kategorie
 */
function deleteCategory(categoryId) {
  const data = getAllBausteineWithCategories();
  const catIndex = data.categories.findIndex(c => c.id === categoryId);

  if (catIndex === -1) return;

  const category = data.categories[catIndex];

  // Finde oder erstelle "Allgemein" Kategorie
  let defaultCat = data.categories.find(c => c.id === 'default');
  if (!defaultCat) {
    defaultCat = { id: 'default', name: 'Allgemein', bausteine: [] };
    data.categories.unshift(defaultCat);
  }

  // Verschiebe Bausteine
  defaultCat.bausteine.push(...category.bausteine);

  // Lösche Kategorie
  data.categories.splice(catIndex, 1);
  saveBausteineToFile(data);
}

/**
 * Verschiebt einen Baustein in eine andere Kategorie
 * @param {string} bausteinId - ID des Bausteins
 * @param {string} targetCategoryId - Ziel-Kategorie-ID
 */
function moveBausteinToCategory(bausteinId, targetCategoryId) {
  const data = getAllBausteineWithCategories();

  // Finde und entferne den Baustein aus seiner aktuellen Kategorie
  let baustein = null;
  for (const cat of data.categories) {
    const idx = cat.bausteine.findIndex(b => b.id === bausteinId);
    if (idx !== -1) {
      baustein = cat.bausteine.splice(idx, 1)[0];
      break;
    }
  }

  if (!baustein) return;

  // Füge zur Zielkategorie hinzu
  const targetCat = data.categories.find(c => c.id === targetCategoryId);
  if (targetCat) {
    targetCat.bausteine.push(baustein);
    saveBausteineToFile(data);
  }
}

/**
 * Erstellt einen neuen Baustein
 * @param {string} categoryId - Kategorie-ID
 * @param {Object} baustein - Baustein-Daten (name, standardText, keywords)
 * @returns {Object} Der neue Baustein
 */
function createBaustein(categoryId, baustein) {
  const data = getAllBausteineWithCategories();
  const cat = data.categories.find(c => c.id === categoryId);

  if (!cat) throw new Error('Kategorie nicht gefunden');

  const id = baustein.id || 'baustein_' + Date.now();
  const newBaustein = {
    id,
    name: baustein.name,
    standardText: baustein.standardText,
    keywords: baustein.keywords || []
  };

  cat.bausteine.push(newBaustein);
  saveBausteineToFile(data);

  return newBaustein;
}

/**
 * Aktualisiert einen Baustein
 * @param {string} bausteinId - ID des Bausteins
 * @param {Object} updates - Zu aktualisierende Felder
 */
function updateBaustein(bausteinId, updates) {
  const data = getAllBausteineWithCategories();

  for (const cat of data.categories) {
    const baustein = cat.bausteine.find(b => b.id === bausteinId);
    if (baustein) {
      Object.assign(baustein, updates);
      saveBausteineToFile(data);
      return;
    }
  }
}

/**
 * Löscht einen Baustein
 * @param {string} bausteinId - ID des Bausteins
 */
function deleteBaustein(bausteinId) {
  const data = getAllBausteineWithCategories();

  for (const cat of data.categories) {
    const idx = cat.bausteine.findIndex(b => b.id === bausteinId);
    if (idx !== -1) {
      cat.bausteine.splice(idx, 1);
      saveBausteineToFile(data);
      return;
    }
  }
}

module.exports = {
  // Pfad-Management
  getBausteinePath,
  setBausteinePath,
  getDefaultBausteinePath,

  // Bausteine laden (flach für API)
  getAllBausteine,
  getBaustein,
  getDefaultBausteine,

  // Bausteine laden (mit Kategorien für UI)
  getAllBausteineWithCategories,
  getDefaultBausteineWithCategories,

  // Bausteine speichern
  saveAllBausteine,
  saveAllBausteineWithCategories,

  // Reset
  resetBaustein,
  resetAllBausteine,

  // Import/Export
  exportBausteine,
  importBausteine,

  // Kategorien-Management
  createCategory,
  renameCategory,
  deleteCategory,

  // Baustein-Management
  createBaustein,
  updateBaustein,
  deleteBaustein,
  moveBausteinToCategory,

  // Legacy
  DEFAULT_BAUSTEINE
};
