/**
 * Tooth Shapes - Professional Dental SVG Definitions
 * Anatomically correct tooth shapes with roots
 *
 * ViewBox: 0 0 60 140 (width x height)
 * - OK (upper): Crown at bottom, roots pointing up
 * - UK (lower): Crown at top, roots pointing down
 */

// ============================================
// OK (Upper Jaw) - Roots point UP
// ============================================

const MOLAR_OK = {
  // 3 Wurzeln: palatinal (Mitte), mesiobukkal (links), distobukkal (rechts)
  crown: {
    outline: "M 10 95 Q 10 85 15 80 L 45 80 Q 50 85 50 95 Q 50 105 45 110 L 15 110 Q 10 105 10 95 Z",
    surfaces: {
      // Okklusalfläche (Mitte)
      o: "M 20 88 L 40 88 L 40 102 L 20 102 Z",
      // Mesial (links)
      m: "M 10 85 L 20 88 L 20 102 L 10 105 Z",
      // Distal (rechts)
      d: "M 50 85 L 40 88 L 40 102 L 50 105 Z",
      // Vestibulär/Bukkal (unten - zur Lippe)
      v: "M 15 110 L 20 102 L 40 102 L 45 110 Q 30 115 15 110 Z",
      // Palatinal (oben - zum Gaumen)
      p: "M 15 80 L 20 88 L 40 88 L 45 80 Q 30 75 15 80 Z"
    }
  },
  cervical: "M 15 80 Q 30 77 45 80",
  roots: {
    // Palatinale Wurzel (Mitte, breit)
    palatinal: "M 25 80 Q 27 50 30 20 Q 33 50 35 80",
    // Mesiobukkale Wurzel (links)
    mesiobuccal: "M 15 80 Q 12 55 8 25 Q 15 55 18 80",
    // Distobukkale Wurzel (rechts)
    distobuccal: "M 42 80 Q 45 55 52 25 Q 48 55 45 80"
  },
  canals: {
    palatinal: "M 29 78 L 30 25",
    mesiobuccal: "M 16 78 L 10 28",
    distobuccal: "M 44 78 L 50 28"
  },
  apex: {
    palatinal: { x: 30, y: 20 },
    mesiobuccal: { x: 8, y: 25 },
    distobuccal: { x: 52, y: 25 }
  }
};

const MOLAR_OK_8 = {
  // Weisheitszahn OK - oft fusionierte Wurzeln
  crown: {
    outline: "M 12 95 Q 12 85 17 80 L 43 80 Q 48 85 48 95 Q 48 105 43 110 L 17 110 Q 12 105 12 95 Z",
    surfaces: {
      o: "M 22 88 L 38 88 L 38 102 L 22 102 Z",
      m: "M 12 85 L 22 88 L 22 102 L 12 105 Z",
      d: "M 48 85 L 38 88 L 38 102 L 48 105 Z",
      v: "M 17 110 L 22 102 L 38 102 L 43 110 Q 30 115 17 110 Z",
      p: "M 17 80 L 22 88 L 38 88 L 43 80 Q 30 75 17 80 Z"
    }
  },
  cervical: "M 17 80 Q 30 77 43 80",
  roots: {
    // Fusionierte Wurzeln (oft verwachsen)
    fused: "M 20 80 Q 15 50 18 25 Q 25 45 30 25 Q 35 45 42 25 Q 45 50 40 80"
  },
  canals: {
    main: "M 25 78 L 22 30 M 35 78 L 38 30"
  },
  apex: {
    main: { x: 30, y: 22 }
  }
};

const PREMOLAR_OK = {
  // 1-2 Wurzeln (dargestellt mit 2, leicht zusammen)
  crown: {
    outline: "M 15 95 Q 15 85 20 80 L 40 80 Q 45 85 45 95 Q 45 105 40 110 L 20 110 Q 15 105 15 95 Z",
    surfaces: {
      o: "M 22 88 L 38 88 L 38 102 L 22 102 Z",
      m: "M 15 85 L 22 88 L 22 102 L 15 105 Z",
      d: "M 45 85 L 38 88 L 38 102 L 45 105 Z",
      v: "M 20 110 L 22 102 L 38 102 L 40 110 Q 30 115 20 110 Z",
      p: "M 20 80 L 22 88 L 38 88 L 40 80 Q 30 75 20 80 Z"
    }
  },
  cervical: "M 20 80 Q 30 77 40 80",
  roots: {
    buccal: "M 25 80 Q 23 55 22 30 Q 27 55 28 80",
    palatinal: "M 32 80 Q 33 55 38 30 Q 35 55 35 80"
  },
  canals: {
    buccal: "M 26 78 L 24 32",
    palatinal: "M 34 78 L 36 32"
  },
  apex: {
    buccal: { x: 22, y: 30 },
    palatinal: { x: 38, y: 30 }
  }
};

const CANINE_OK = {
  // 1 lange Wurzel
  crown: {
    outline: "M 18 95 Q 18 87 22 82 L 30 75 L 38 82 Q 42 87 42 95 Q 42 105 38 110 L 22 110 Q 18 105 18 95 Z",
    surfaces: {
      // Schneidekante (spitz)
      o: "M 25 82 L 30 75 L 35 82 Z",
      m: "M 18 87 L 25 82 L 25 102 L 18 105 Z",
      d: "M 42 87 L 35 82 L 35 102 L 42 105 Z",
      v: "M 22 110 L 25 102 L 35 102 L 38 110 Q 30 115 22 110 Z"
    }
  },
  cervical: "M 22 82 Q 30 78 38 82",
  roots: {
    single: "M 26 82 Q 28 45 30 15 Q 32 45 34 82"
  },
  canals: {
    single: "M 30 80 L 30 18"
  },
  apex: {
    single: { x: 30, y: 15 }
  }
};

const INCISOR_OK = {
  // 1 Wurzel
  crown: {
    outline: "M 18 92 Q 18 85 22 80 L 38 80 Q 42 85 42 92 Q 42 105 38 110 L 22 110 Q 18 105 18 92 Z",
    surfaces: {
      // Schneidekante (gerade)
      o: "M 22 80 L 38 80 L 38 88 L 22 88 Z",
      m: "M 18 85 L 22 88 L 22 102 L 18 105 Z",
      d: "M 42 85 L 38 88 L 38 102 L 42 105 Z",
      v: "M 22 110 L 22 102 L 38 102 L 38 110 Q 30 115 22 110 Z"
    }
  },
  cervical: "M 22 80 Q 30 77 38 80",
  roots: {
    single: "M 27 80 Q 29 50 30 25 Q 31 50 33 80"
  },
  canals: {
    single: "M 30 78 L 30 28"
  },
  apex: {
    single: { x: 30, y: 25 }
  }
};

const LATERAL_INCISOR_OK = {
  // Kleinerer Schneidezahn
  crown: {
    outline: "M 20 92 Q 20 85 24 80 L 36 80 Q 40 85 40 92 Q 40 105 36 110 L 24 110 Q 20 105 20 92 Z",
    surfaces: {
      o: "M 24 80 L 36 80 L 36 88 L 24 88 Z",
      m: "M 20 85 L 24 88 L 24 102 L 20 105 Z",
      d: "M 40 85 L 36 88 L 36 102 L 40 105 Z",
      v: "M 24 110 L 24 102 L 36 102 L 36 110 Q 30 115 24 110 Z"
    }
  },
  cervical: "M 24 80 Q 30 77 36 80",
  roots: {
    single: "M 28 80 Q 29 50 30 25 Q 31 50 32 80"
  },
  canals: {
    single: "M 30 78 L 30 28"
  },
  apex: {
    single: { x: 30, y: 25 }
  }
};

// ============================================
// UK (Lower Jaw) - Roots point DOWN
// ============================================

const MOLAR_UK = {
  // 2 Wurzeln: mesial (links), distal (rechts)
  crown: {
    outline: "M 10 30 Q 10 40 15 45 L 45 45 Q 50 40 50 30 Q 50 20 45 15 L 15 15 Q 10 20 10 30 Z",
    surfaces: {
      o: "M 20 23 L 40 23 L 40 37 L 20 37 Z",
      m: "M 10 20 L 20 23 L 20 37 L 10 40 Z",
      d: "M 50 20 L 40 23 L 40 37 L 50 40 Z",
      v: "M 15 15 L 20 23 L 40 23 L 45 15 Q 30 10 15 15 Z",
      l: "M 15 45 L 20 37 L 40 37 L 45 45 Q 30 50 15 45 Z"
    }
  },
  cervical: "M 15 45 Q 30 48 45 45",
  roots: {
    mesial: "M 18 45 Q 15 70 12 115 Q 20 70 22 45",
    distal: "M 38 45 Q 40 70 48 115 Q 42 70 42 45"
  },
  canals: {
    mesial: "M 19 47 L 14 112",
    distal: "M 41 47 L 46 112"
  },
  apex: {
    mesial: { x: 12, y: 115 },
    distal: { x: 48, y: 115 }
  }
};

const MOLAR_UK_8 = {
  // Weisheitszahn UK - oft fusionierte Wurzeln
  crown: {
    outline: "M 12 30 Q 12 40 17 45 L 43 45 Q 48 40 48 30 Q 48 20 43 15 L 17 15 Q 12 20 12 30 Z",
    surfaces: {
      o: "M 22 23 L 38 23 L 38 37 L 22 37 Z",
      m: "M 12 20 L 22 23 L 22 37 L 12 40 Z",
      d: "M 48 20 L 38 23 L 38 37 L 48 40 Z",
      v: "M 17 15 L 22 23 L 38 23 L 43 15 Q 30 10 17 15 Z",
      l: "M 17 45 L 22 37 L 38 37 L 43 45 Q 30 50 17 45 Z"
    }
  },
  cervical: "M 17 45 Q 30 48 43 45",
  roots: {
    fused: "M 20 45 Q 15 75 18 115 Q 25 85 30 115 Q 35 85 42 115 Q 45 75 40 45"
  },
  canals: {
    main: "M 25 47 L 22 110 M 35 47 L 38 110"
  },
  apex: {
    main: { x: 30, y: 118 }
  }
};

const PREMOLAR_UK = {
  // 1 Wurzel
  crown: {
    outline: "M 15 30 Q 15 40 20 45 L 40 45 Q 45 40 45 30 Q 45 20 40 15 L 20 15 Q 15 20 15 30 Z",
    surfaces: {
      o: "M 22 23 L 38 23 L 38 37 L 22 37 Z",
      m: "M 15 20 L 22 23 L 22 37 L 15 40 Z",
      d: "M 45 20 L 38 23 L 38 37 L 45 40 Z",
      v: "M 20 15 L 22 23 L 38 23 L 40 15 Q 30 10 20 15 Z",
      l: "M 20 45 L 22 37 L 38 37 L 40 45 Q 30 50 20 45 Z"
    }
  },
  cervical: "M 20 45 Q 30 48 40 45",
  roots: {
    single: "M 27 45 Q 28 75 30 115 Q 32 75 33 45"
  },
  canals: {
    single: "M 30 47 L 30 112"
  },
  apex: {
    single: { x: 30, y: 115 }
  }
};

const CANINE_UK = {
  // 1 lange Wurzel
  crown: {
    outline: "M 18 30 Q 18 38 22 43 L 30 50 L 38 43 Q 42 38 42 30 Q 42 20 38 15 L 22 15 Q 18 20 18 30 Z",
    surfaces: {
      o: "M 25 43 L 30 50 L 35 43 Z",
      m: "M 18 38 L 25 43 L 25 23 L 18 20 Z",
      d: "M 42 38 L 35 43 L 35 23 L 42 20 Z",
      v: "M 22 15 L 25 23 L 35 23 L 38 15 Q 30 10 22 15 Z"
    }
  },
  cervical: "M 22 43 Q 30 47 38 43",
  roots: {
    single: "M 26 43 Q 28 80 30 125 Q 32 80 34 43"
  },
  canals: {
    single: "M 30 45 L 30 122"
  },
  apex: {
    single: { x: 30, y: 125 }
  }
};

const INCISOR_UK = {
  // 1 Wurzel (schmaler als OK)
  crown: {
    outline: "M 20 32 Q 20 40 24 45 L 36 45 Q 40 40 40 32 Q 40 20 36 15 L 24 15 Q 20 20 20 32 Z",
    surfaces: {
      o: "M 24 15 L 36 15 L 36 23 L 24 23 Z",
      m: "M 20 20 L 24 23 L 24 37 L 20 40 Z",
      d: "M 40 20 L 36 23 L 36 37 L 40 40 Z",
      v: "M 24 45 L 24 37 L 36 37 L 36 45 Q 30 50 24 45 Z"
    }
  },
  cervical: "M 24 45 Q 30 48 36 45",
  roots: {
    single: "M 28 45 Q 29 75 30 115 Q 31 75 32 45"
  },
  canals: {
    single: "M 30 47 L 30 112"
  },
  apex: {
    single: { x: 30, y: 115 }
  }
};

// ============================================
// Implantat SVG (ersetzt Wurzel)
// ============================================

const IMPLANT_OK = {
  // Schraube nach oben
  screw: "M 25 80 L 22 75 L 28 70 L 22 65 L 28 60 L 22 55 L 28 50 L 22 45 L 28 40 L 25 35 L 35 35 L 32 40 L 38 45 L 32 50 L 38 55 L 32 60 L 38 65 L 32 70 L 38 75 L 35 80 Z",
  abutment: "M 24 80 L 24 90 L 36 90 L 36 80 Z",
  apex: { x: 30, y: 35 }
};

const IMPLANT_UK = {
  // Schraube nach unten
  screw: "M 25 45 L 22 50 L 28 55 L 22 60 L 28 65 L 22 70 L 28 75 L 22 80 L 28 85 L 25 90 L 35 90 L 32 85 L 38 80 L 32 75 L 38 70 L 32 65 L 38 60 L 32 55 L 38 50 L 35 45 Z",
  abutment: "M 24 35 L 24 45 L 36 45 L 36 35 Z",
  apex: { x: 30, y: 90 }
};

// ============================================
// Wurzelstift (Post)
// ============================================

const POST = {
  ok: "M 28 78 L 27 50 L 33 50 L 32 78",
  uk: "M 28 47 L 27 90 L 33 90 L 32 47"
};

// ============================================
// Export: Zahntyp-Mapping
// ============================================

const TOOTH_SHAPES = {
  // OK (Upper Jaw)
  ok: {
    molar: MOLAR_OK,
    molar_8: MOLAR_OK_8,
    premolar: PREMOLAR_OK,
    canine: CANINE_OK,
    incisor_central: INCISOR_OK,
    incisor_lateral: LATERAL_INCISOR_OK
  },
  // UK (Lower Jaw)
  uk: {
    molar: MOLAR_UK,
    molar_8: MOLAR_UK_8,
    premolar: PREMOLAR_UK,
    canine: CANINE_UK,
    incisor: INCISOR_UK
  },
  // Extras
  implant: {
    ok: IMPLANT_OK,
    uk: IMPLANT_UK
  },
  post: POST
};

/**
 * Get tooth shape based on tooth number
 * @param {string} toothNumber - FDI tooth number (e.g., "16", "46")
 * @returns {Object} Shape definition
 */
function getToothShape(toothNumber) {
  const quadrant = toothNumber[0];
  const position = toothNumber[1];
  const isUpper = quadrant === '1' || quadrant === '2';
  const jaw = isUpper ? 'ok' : 'uk';

  // Determine tooth type based on position
  if (position === '8') {
    return { shape: TOOTH_SHAPES[jaw].molar_8, jaw };
  } else if (position === '6' || position === '7') {
    return { shape: TOOTH_SHAPES[jaw].molar, jaw };
  } else if (position === '4' || position === '5') {
    return { shape: TOOTH_SHAPES[jaw].premolar, jaw };
  } else if (position === '3') {
    return { shape: TOOTH_SHAPES[jaw].canine, jaw };
  } else if (position === '1') {
    return isUpper
      ? { shape: TOOTH_SHAPES.ok.incisor_central, jaw }
      : { shape: TOOTH_SHAPES.uk.incisor, jaw };
  } else if (position === '2') {
    return isUpper
      ? { shape: TOOTH_SHAPES.ok.incisor_lateral, jaw }
      : { shape: TOOTH_SHAPES.uk.incisor, jaw };
  }

  // Fallback
  return { shape: TOOTH_SHAPES[jaw].molar, jaw };
}

/**
 * Get implant shape for jaw
 */
function getImplantShape(isUpper) {
  return isUpper ? TOOTH_SHAPES.implant.ok : TOOTH_SHAPES.implant.uk;
}

/**
 * Get post shape for jaw
 */
function getPostShape(isUpper) {
  return isUpper ? TOOTH_SHAPES.post.ok : TOOTH_SHAPES.post.uk;
}

// Export for use in tooth-chart.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TOOTH_SHAPES, getToothShape, getImplantShape, getPostShape };
}
