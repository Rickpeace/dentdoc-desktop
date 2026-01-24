/**
 * Tooth Chart Module V3 - Professional Dental Visualization
 * Anatomically correct tooth shapes with roots
 *
 * Features:
 * - Realistic tooth shapes with roots (OK: 3 roots for molars, UK: 2 roots)
 * - Vitality signs (+/-)
 * - Abbreviation system (K, B, Z, C, F, E)
 * - Root canal visualization (endo, posts)
 * - Implant visualization
 * - Surface-based coloring for fillings/caries
 */

// ipcRenderer is already declared in dashboard.js, reuse it
// const { ipcRenderer } = require('electron');

// ============================================
// TOOTH SHAPES (inline for simplicity)
// ============================================

// Tooth numbers in correct order for display (dentist view / mirror image)
// Standard dental chart: dentist faces patient
// LEFT side of chart = patient's RIGHT (Q1 upper, Q4 lower)
// RIGHT side of chart = patient's LEFT (Q2 upper, Q3 lower)
//
// Visual layout:
//   18 17 16 15 14 13 12 11 | 21 22 23 24 25 26 27 28   <- Oberkiefer
//   ─────────────────────────────────────────────────
//   48 47 46 45 44 43 42 41 | 31 32 33 34 35 36 37 38   <- Unterkiefer
//
const UPPER_RIGHT = ['18', '17', '16', '15', '14', '13', '12', '11']; // Q1 (left side of chart)
const UPPER_LEFT = ['21', '22', '23', '24', '25', '26', '27', '28'];  // Q2 (right side of chart)
const LOWER_RIGHT = ['48', '47', '46', '45', '44', '43', '42', '41']; // Q4 (left side of chart)
const LOWER_LEFT = ['31', '32', '33', '34', '35', '36', '37', '38'];  // Q3 (right side of chart)

// Colors
const COLORS = {
  healthy: '#F5F0E6',      // Cream/beige
  healthyStroke: '#C9BFA5',
  caries: '#E53935',       // Red
  filling: '#FF9800',      // Orange
  crown: '#FFD54F',        // Gold/yellow
  endo: '#9C27B0',         // Purple
  endoInsuff: '#E53935',   // Red for insufficient
  implant: '#78909C',      // Blue-gray metallic
  implantScrew: '#546E7A',
  post: '#90A4AE',         // Metallic gray
  missing: 'transparent',
  missingStroke: '#9E9E9E',
  root: '#E8DFD0',         // Slightly darker than healthy
  rootStroke: '#B8A898',
  canal: '#FFFFFF',        // White for filled canals
  apicalLesion: '#1A1A1A', // Dark for lesion
  gingiva: '#FFB6C1'       // Pink for gum line
};

// Check if tooth is in upper jaw
function isUpperJaw(toothNumber) {
  const firstDigit = toothNumber[0];
  return firstDigit === '1' || firstDigit === '2';
}

// Get tooth type from number
function getToothType(toothNumber) {
  const pos = toothNumber[1];
  if (pos === '8' || pos === '7' || pos === '6') return 'molar';
  if (pos === '5' || pos === '4') return 'premolar';
  if (pos === '3') return 'canine';
  return 'incisor';
}

// Check if it's a wisdom tooth
function isWisdomTooth(toothNumber) {
  return toothNumber[1] === '8';
}

let currentStatus01 = null;
let selectedTooth = null;

/**
 * Initialize the tooth chart module
 */
function initToothChart() {
  console.log('[Tooth Chart V3] Initializing...');

  const modal = document.getElementById('toothChartModal');
  const backdrop = document.getElementById('toothChartBackdrop');
  const closeBtn = document.getElementById('toothChartClose');
  const copyJsonBtn = document.getElementById('toothChartCopyJson');

  if (!modal) {
    console.log('[Tooth Chart V3] Modal not found in DOM!');
    return;
  }

  console.log('[Tooth Chart V3] Modal found, setting up handlers...');

  // Close handlers
  backdrop?.addEventListener('click', closeToothChart);
  closeBtn?.addEventListener('click', closeToothChart);

  // Copy JSON handler
  copyJsonBtn?.addEventListener('click', () => {
    if (currentStatus01) {
      const jsonStr = JSON.stringify(currentStatus01, null, 2);
      ipcRenderer.invoke('copy-to-clipboard', jsonStr);
      copyJsonBtn.textContent = '✓ Kopiert!';
      setTimeout(() => {
        copyJsonBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          JSON kopieren
        `;
      }, 2000);
    }
  });

  // ESC key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') {
      closeToothChart();
    }
  });

  // Listen for IPC to open chart
  ipcRenderer.on('open-tooth-chart', (event, data) => {
    if (data && data.status01) {
      openToothChart(data.status01);
    }
  });
}

/**
 * Open the tooth chart modal with data
 */
function openToothChart(status01) {
  currentStatus01 = status01;
  selectedTooth = null;

  const modal = document.getElementById('toothChartModal');
  modal.style.display = 'flex';

  // Render teeth
  renderTeeth();

  // Hide detail panel initially
  const detailPanel = document.getElementById('toothDetailPanel');
  if (detailPanel) detailPanel.style.display = 'none';
}

/**
 * Close the tooth chart modal
 */
function closeToothChart() {
  const modal = document.getElementById('toothChartModal');
  modal.style.display = 'none';
  currentStatus01 = null;
  selectedTooth = null;
}

/**
 * Render all teeth in the chart
 */
function renderTeeth() {
  renderToothRow('upperRight', UPPER_RIGHT, true);
  renderToothRow('upperLeft', UPPER_LEFT, true);
  renderToothRow('lowerLeft', LOWER_LEFT, false);
  renderToothRow('lowerRight', LOWER_RIGHT, false);
}

/**
 * Render a single row of teeth
 */
function renderToothRow(containerId, toothNumbers, isUpper) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  toothNumbers.forEach(num => {
    const toothData = currentStatus01?.teeth?.[num];
    const toothEl = createToothElementV3(num, toothData, isUpper);
    container.appendChild(toothEl);
  });
}

/**
 * Create a tooth element with anatomical shape and roots
 */
function createToothElementV3(toothNumber, data, isUpper) {
  const tooth = document.createElement('div');
  tooth.className = 'tooth-v3';
  tooth.dataset.tooth = toothNumber;

  const isMissing = !data || data.present === false;
  const hasImplant = data?.implant?.present;
  const hasCrown = data?.prosthetics?.type === 'krone' || data?.prosthetics?.type === 'teilkrone';
  const isBridge = data?.prosthetics?.type === 'brueckenglied';
  const hasEndo = data?.endo?.treated;
  const hasCaries = data?.caries?.present;
  const hasApicalLesion = data?.apical?.lesion;

  if (isMissing) tooth.classList.add('missing');
  if (hasImplant) tooth.classList.add('implant');

  // Get abbreviation
  const abbr = getAbbreviation(data, isMissing);

  // Get vitality sign
  const vitality = getVitalitySign(data, isMissing, hasImplant);

  // Create SVG
  const svg = createToothSVGV3(toothNumber, data, isUpper);

  // Build structure based on jaw
  if (isUpper) {
    // Upper jaw: vitality -> abbr -> number -> crown -> roots (down)
    if (vitality) {
      const vitalityEl = document.createElement('div');
      vitalityEl.className = 'tooth-vitality';
      vitalityEl.textContent = vitality;
      if (vitality === '-') vitalityEl.classList.add('devital');
      tooth.appendChild(vitalityEl);
    }

    if (abbr) {
      const abbrEl = document.createElement('div');
      abbrEl.className = 'tooth-abbr ' + getAbbrClass(abbr);
      abbrEl.textContent = abbr;
      tooth.appendChild(abbrEl);
    }

    const numberEl = document.createElement('div');
    numberEl.className = 'tooth-number-v3';
    numberEl.textContent = toothNumber;
    tooth.appendChild(numberEl);

    tooth.appendChild(svg);
  } else {
    // Lower jaw: roots (up) -> crown -> number -> abbr -> vitality
    tooth.appendChild(svg);

    const numberEl = document.createElement('div');
    numberEl.className = 'tooth-number-v3';
    numberEl.textContent = toothNumber;
    tooth.appendChild(numberEl);

    if (abbr) {
      const abbrEl = document.createElement('div');
      abbrEl.className = 'tooth-abbr ' + getAbbrClass(abbr);
      abbrEl.textContent = abbr;
      tooth.appendChild(abbrEl);
    }

    if (vitality) {
      const vitalityEl = document.createElement('div');
      vitalityEl.className = 'tooth-vitality';
      vitalityEl.textContent = vitality;
      if (vitality === '-') vitalityEl.classList.add('devital');
      tooth.appendChild(vitalityEl);
    }
  }

  // Click handler
  tooth.addEventListener('click', () => selectTooth(toothNumber, data));

  return tooth;
}

/**
 * Get abbreviation for tooth status
 */
function getAbbreviation(data, isMissing) {
  if (isMissing) return 'f';
  if (data?.implant?.present) return 'i';
  if (data?.prosthetics?.type === 'krone') return 'k';
  if (data?.prosthetics?.type === 'teilkrone') return 'tk';
  if (data?.prosthetics?.type === 'brueckenglied') return 'b';
  if (data?.prosthetics?.type === 'teleskop') return 't';
  if (data?.caries?.present && data.caries.surfaces?.length >= 3) return 'z'; // zerstört
  if (data?.caries?.present) return 'c';
  if (data?.restorations?.length > 0) {
    // Check if all surfaces have fillings
    const totalSurfaces = data.restorations.reduce((acc, r) => acc + (r.surfaces?.length || 0), 0);
    if (totalSurfaces >= 4) return 'k'; // Effectively a crown
  }
  return null;
}

/**
 * Get abbreviation CSS class
 */
function getAbbrClass(abbr) {
  const classes = {
    'k': 'abbr-crown',
    'tk': 'abbr-crown',
    'b': 'abbr-bridge',
    'z': 'abbr-destroyed',
    'c': 'abbr-caries',
    'f': 'abbr-missing',
    'e': 'abbr-replaced',
    'i': 'abbr-implant',
    't': 'abbr-crown'
  };
  return classes[abbr] || '';
}

/**
 * Get vitality sign (+/-)
 */
function getVitalitySign(data, isMissing, hasImplant) {
  if (isMissing || hasImplant) return null;
  if (data?.endo?.treated) return '-';
  // Could add vitality test data here if available
  return '+';
}

/**
 * Create anatomically correct SVG for tooth
 */
function createToothSVGV3(toothNumber, data, isUpper) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 60 100');
  svg.setAttribute('class', 'tooth-svg-v3');

  const toothType = getToothType(toothNumber);
  const isMissing = !data || data.present === false;
  const hasImplant = data?.implant?.present;
  const hasEndo = data?.endo?.treated;
  const endoSufficient = data?.endo?.fillingStatus === 'suffizient';
  const hasPost = data?.endo?.post;
  const hasApicalLesion = data?.apical?.lesion;
  const hasCrown = data?.prosthetics?.type === 'krone' || data?.prosthetics?.type === 'teilkrone';
  const isBridge = data?.prosthetics?.type === 'brueckenglied';

  // Get caries and filling surfaces
  const cariesSurfaces = data?.caries?.present ? (data.caries.surfaces || []) : [];
  const fillingSurfaces = [];
  if (data?.restorations) {
    data.restorations.forEach(r => {
      if (r.surfaces) fillingSurfaces.push(...r.surfaces);
    });
  }

  if (isMissing && !hasImplant) {
    // Missing tooth - just show dashed outline
    svg.appendChild(createMissingToothOutline(toothType, isUpper));
  } else if (hasImplant) {
    // Implant instead of natural tooth
    svg.appendChild(createImplant(isUpper, hasCrown));
  } else {
    // Natural tooth with roots
    if (isUpper) {
      // Upper jaw: crown at bottom, roots pointing up
      svg.appendChild(createRoots(toothNumber, toothType, isUpper, hasEndo, endoSufficient, hasPost, hasApicalLesion));
      svg.appendChild(createCrown(toothType, isUpper, cariesSurfaces, fillingSurfaces, hasCrown, isBridge, data));
    } else {
      // Lower jaw: crown at top, roots pointing down
      svg.appendChild(createCrown(toothType, isUpper, cariesSurfaces, fillingSurfaces, hasCrown, isBridge, data));
      svg.appendChild(createRoots(toothNumber, toothType, isUpper, hasEndo, endoSufficient, hasPost, hasApicalLesion));
    }
  }

  return svg;
}

/**
 * Create missing tooth outline (dashed)
 */
function createMissingToothOutline(toothType, isUpper) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'missing-outline');

  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');

  // Simple tooth shape outline
  if (isUpper) {
    outline.setAttribute('d', 'M 15 95 Q 15 80 20 70 L 40 70 Q 45 80 45 95 Q 45 98 30 98 Q 15 98 15 95 Z M 25 70 L 28 25 L 32 25 L 35 70');
  } else {
    outline.setAttribute('d', 'M 15 5 Q 15 2 30 2 Q 45 2 45 5 Q 45 20 40 30 L 20 30 Q 15 20 15 5 Z M 25 30 L 28 75 L 32 75 L 35 30');
  }

  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', COLORS.missingStroke);
  outline.setAttribute('stroke-width', '1');
  outline.setAttribute('stroke-dasharray', '3 2');
  outline.setAttribute('opacity', '0.5');

  g.appendChild(outline);
  return g;
}

/**
 * Create implant SVG
 */
function createImplant(isUpper, hasCrown) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'implant-group');

  if (isUpper) {
    // Implant screw (pointing up)
    const screw = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    screw.setAttribute('d', `
      M 26 70 L 23 65 L 27 60 L 23 55 L 27 50 L 23 45 L 27 40 L 23 35 L 27 30 L 30 25
      L 33 30 L 37 35 L 33 40 L 37 45 L 33 50 L 37 55 L 33 60 L 37 65 L 34 70 Z
    `);
    screw.setAttribute('fill', COLORS.implantScrew);
    screw.setAttribute('stroke', COLORS.implant);
    screw.setAttribute('stroke-width', '0.5');
    g.appendChild(screw);

    // Abutment
    const abutment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    abutment.setAttribute('x', '24');
    abutment.setAttribute('y', '70');
    abutment.setAttribute('width', '12');
    abutment.setAttribute('height', '10');
    abutment.setAttribute('fill', COLORS.post);
    abutment.setAttribute('stroke', COLORS.implant);
    abutment.setAttribute('stroke-width', '0.5');
    g.appendChild(abutment);

    // Crown if present
    if (hasCrown) {
      const crown = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      crown.setAttribute('d', 'M 15 80 Q 15 95 30 98 Q 45 95 45 80 L 36 80 L 24 80 Z');
      crown.setAttribute('fill', COLORS.crown);
      crown.setAttribute('stroke', COLORS.healthyStroke);
      crown.setAttribute('stroke-width', '1');
      g.appendChild(crown);
    }
  } else {
    // Lower jaw - crown if present
    if (hasCrown) {
      const crown = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      crown.setAttribute('d', 'M 15 20 Q 15 5 30 2 Q 45 5 45 20 L 36 20 L 24 20 Z');
      crown.setAttribute('fill', COLORS.crown);
      crown.setAttribute('stroke', COLORS.healthyStroke);
      crown.setAttribute('stroke-width', '1');
      g.appendChild(crown);
    }

    // Abutment
    const abutment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    abutment.setAttribute('x', '24');
    abutment.setAttribute('y', '20');
    abutment.setAttribute('width', '12');
    abutment.setAttribute('height', '10');
    abutment.setAttribute('fill', COLORS.post);
    abutment.setAttribute('stroke', COLORS.implant);
    abutment.setAttribute('stroke-width', '0.5');
    g.appendChild(abutment);

    // Implant screw (pointing down)
    const screw = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    screw.setAttribute('d', `
      M 26 30 L 23 35 L 27 40 L 23 45 L 27 50 L 23 55 L 27 60 L 23 65 L 27 70 L 30 75
      L 33 70 L 37 65 L 33 60 L 37 55 L 33 50 L 37 45 L 33 40 L 37 35 L 34 30 Z
    `);
    screw.setAttribute('fill', COLORS.implantScrew);
    screw.setAttribute('stroke', COLORS.implant);
    screw.setAttribute('stroke-width', '0.5');
    g.appendChild(screw);
  }

  return g;
}

/**
 * Create roots for natural tooth
 */
function createRoots(toothNumber, toothType, isUpper, hasEndo, endoSufficient, hasPost, hasApicalLesion) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'roots-group');

  const isWisdom = isWisdomTooth(toothNumber);

  if (isUpper) {
    // Upper jaw roots (pointing up from y=70)
    if (toothType === 'molar') {
      if (isWisdom) {
        // Wisdom tooth - often fused roots
        g.appendChild(createRootPath('M 20 70 Q 15 45 18 20 Q 25 40 30 20 Q 35 40 42 20 Q 45 45 40 70', isUpper, hasEndo, endoSufficient));
        if (hasEndo) {
          g.appendChild(createCanalPath('M 25 68 L 22 25', endoSufficient));
          g.appendChild(createCanalPath('M 35 68 L 38 25', endoSufficient));
        }
        if (hasPost) g.appendChild(createPostPath('M 28 68 L 27 40 L 33 40 L 32 68', isUpper));
        if (hasApicalLesion) g.appendChild(createApicalLesion(30, 15));
      } else {
        // Regular molar - 3 roots
        // Palatinal (middle, wider)
        g.appendChild(createRootPath('M 26 70 Q 28 45 30 15 Q 32 45 34 70', isUpper, hasEndo, endoSufficient));
        // Mesiobuccal (left)
        g.appendChild(createRootPath('M 16 70 Q 13 50 10 20 Q 17 50 19 70', isUpper, hasEndo, endoSufficient));
        // Distobuccal (right)
        g.appendChild(createRootPath('M 41 70 Q 43 50 50 20 Q 47 50 44 70', isUpper, hasEndo, endoSufficient));

        if (hasEndo) {
          g.appendChild(createCanalPath('M 30 68 L 30 18', endoSufficient));
          g.appendChild(createCanalPath('M 17 68 L 12 23', endoSufficient));
          g.appendChild(createCanalPath('M 43 68 L 48 23', endoSufficient));
        }
        if (hasPost) g.appendChild(createPostPath('M 28 68 L 28 35 L 32 35 L 32 68', isUpper));
        if (hasApicalLesion) {
          g.appendChild(createApicalLesion(30, 10));
        }
      }
    } else if (toothType === 'premolar') {
      // 1-2 roots
      g.appendChild(createRootPath('M 24 70 Q 22 50 20 25 Q 27 50 28 70', isUpper, hasEndo, endoSufficient));
      g.appendChild(createRootPath('M 32 70 Q 33 50 40 25 Q 35 50 36 70', isUpper, hasEndo, endoSufficient));

      if (hasEndo) {
        g.appendChild(createCanalPath('M 26 68 L 22 28', endoSufficient));
        g.appendChild(createCanalPath('M 34 68 L 38 28', endoSufficient));
      }
      if (hasPost) g.appendChild(createPostPath('M 28 68 L 27 45 L 33 45 L 32 68', isUpper));
      if (hasApicalLesion) g.appendChild(createApicalLesion(30, 22));
    } else {
      // Canine or incisor - single root
      const rootWidth = toothType === 'canine' ? 'M 26 70 Q 28 40 30 10 Q 32 40 34 70' : 'M 27 70 Q 29 45 30 20 Q 31 45 33 70';
      g.appendChild(createRootPath(rootWidth, isUpper, hasEndo, endoSufficient));

      if (hasEndo) {
        g.appendChild(createCanalPath('M 30 68 L 30 ' + (toothType === 'canine' ? '13' : '23'), endoSufficient));
      }
      if (hasPost) g.appendChild(createPostPath('M 28 68 L 28 40 L 32 40 L 32 68', isUpper));
      if (hasApicalLesion) g.appendChild(createApicalLesion(30, toothType === 'canine' ? 5 : 15));
    }
  } else {
    // Lower jaw roots (pointing down from y=30)
    if (toothType === 'molar') {
      if (isWisdom) {
        // Wisdom tooth - often fused
        g.appendChild(createRootPath('M 20 30 Q 15 55 18 80 Q 25 60 30 80 Q 35 60 42 80 Q 45 55 40 30', isUpper, hasEndo, endoSufficient));
        if (hasEndo) {
          g.appendChild(createCanalPath('M 25 32 L 22 75', endoSufficient));
          g.appendChild(createCanalPath('M 35 32 L 38 75', endoSufficient));
        }
        if (hasPost) g.appendChild(createPostPath('M 28 32 L 27 60 L 33 60 L 32 32', isUpper));
        if (hasApicalLesion) g.appendChild(createApicalLesion(30, 85));
      } else {
        // Regular molar - 2 roots
        // Mesial
        g.appendChild(createRootPath('M 18 30 Q 15 55 12 85 Q 20 55 22 30', isUpper, hasEndo, endoSufficient));
        // Distal
        g.appendChild(createRootPath('M 38 30 Q 40 55 48 85 Q 43 55 42 30', isUpper, hasEndo, endoSufficient));

        if (hasEndo) {
          g.appendChild(createCanalPath('M 19 32 L 14 82', endoSufficient));
          g.appendChild(createCanalPath('M 41 32 L 46 82', endoSufficient));
        }
        if (hasPost) g.appendChild(createPostPath('M 28 32 L 27 60 L 33 60 L 32 32', isUpper));
        if (hasApicalLesion) {
          g.appendChild(createApicalLesion(30, 90));
        }
      }
    } else if (toothType === 'premolar') {
      // Single root
      g.appendChild(createRootPath('M 27 30 Q 28 55 30 85 Q 32 55 33 30', isUpper, hasEndo, endoSufficient));

      if (hasEndo) {
        g.appendChild(createCanalPath('M 30 32 L 30 82', endoSufficient));
      }
      if (hasPost) g.appendChild(createPostPath('M 28 32 L 27 60 L 33 60 L 32 32', isUpper));
      if (hasApicalLesion) g.appendChild(createApicalLesion(30, 88));
    } else {
      // Canine or incisor - single root
      const rootEnd = toothType === 'canine' ? 90 : 85;
      g.appendChild(createRootPath(`M 26 30 Q 28 55 30 ${rootEnd} Q 32 55 34 30`, isUpper, hasEndo, endoSufficient));

      if (hasEndo) {
        g.appendChild(createCanalPath(`M 30 32 L 30 ${rootEnd - 5}`, endoSufficient));
      }
      if (hasPost) g.appendChild(createPostPath('M 28 32 L 28 55 L 32 55 L 32 32', isUpper));
      if (hasApicalLesion) g.appendChild(createApicalLesion(30, rootEnd + 5));
    }
  }

  return g;
}

/**
 * Create a single root path
 */
function createRootPath(d, isUpper, hasEndo, endoSufficient) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', COLORS.root);
  path.setAttribute('stroke', COLORS.rootStroke);
  path.setAttribute('stroke-width', '0.8');
  path.setAttribute('class', 'root');
  return path;
}

/**
 * Create root canal path (for endo-treated teeth)
 */
function createCanalPath(d, sufficient) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', sufficient ? COLORS.canal : COLORS.endoInsuff);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('class', 'canal' + (sufficient ? '' : ' insufficient'));
  return path;
}

/**
 * Create post/stift path
 */
function createPostPath(d, isUpper) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', COLORS.post);
  path.setAttribute('stroke', COLORS.implant);
  path.setAttribute('stroke-width', '0.5');
  path.setAttribute('class', 'post');
  return path;
}

/**
 * Create apical lesion circle
 */
function createApicalLesion(cx, cy) {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', cx);
  circle.setAttribute('cy', cy);
  circle.setAttribute('r', '5');
  circle.setAttribute('fill', COLORS.apicalLesion);
  circle.setAttribute('opacity', '0.7');
  circle.setAttribute('class', 'apical-lesion');
  return circle;
}

/**
 * Create crown/clinical portion with surfaces
 */
function createCrown(toothType, isUpper, cariesSurfaces, fillingSurfaces, hasCrown, isBridge, data) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'crown-group');

  const palLabel = isUpper ? 'p' : 'l';

  // Crown position based on jaw
  const crownY = isUpper ? 70 : 5;
  const crownHeight = 28;

  if (hasCrown || isBridge) {
    // Full crown - single colored shape
    const crown = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (isUpper) {
      crown.setAttribute('d', 'M 12 70 Q 12 85 15 93 Q 30 98 45 93 Q 48 85 48 70 Z');
    } else {
      crown.setAttribute('d', 'M 12 30 Q 12 15 15 7 Q 30 2 45 7 Q 48 15 48 30 Z');
    }
    crown.setAttribute('fill', COLORS.crown);
    crown.setAttribute('stroke', isBridge ? COLORS.healthyStroke : COLORS.rootStroke);
    crown.setAttribute('stroke-width', isBridge ? '1.5' : '1');
    if (isBridge) crown.setAttribute('stroke-dasharray', '3 2');
    g.appendChild(crown);
  } else {
    // Natural tooth with surface-based coloring
    // Create 5-surface layout for molars/premolars, 4-surface for others
    if (toothType === 'molar' || toothType === 'premolar') {
      // 5-surface cross pattern
      if (isUpper) {
        // Occlusal (center)
        g.appendChild(createSurfacePathV3('M 22 77 L 38 77 L 38 88 L 22 88 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial (left)
        g.appendChild(createSurfacePathV3('M 12 72 L 22 77 L 22 88 L 12 93 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal (right)
        g.appendChild(createSurfacePathV3('M 48 72 L 38 77 L 38 88 L 48 93 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular (bottom - towards lip)
        g.appendChild(createSurfacePathV3('M 12 93 L 22 88 L 38 88 L 48 93 Q 30 98 12 93 Z', 'v', cariesSurfaces, fillingSurfaces, data));
        // Palatinal (top - cervical)
        g.appendChild(createSurfacePathV3('M 12 72 L 22 77 L 38 77 L 48 72 Q 30 70 12 72 Z', palLabel, cariesSurfaces, fillingSurfaces, data));
      } else {
        // Occlusal (center)
        g.appendChild(createSurfacePathV3('M 22 12 L 38 12 L 38 23 L 22 23 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial (left)
        g.appendChild(createSurfacePathV3('M 12 7 L 22 12 L 22 23 L 12 28 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal (right)
        g.appendChild(createSurfacePathV3('M 48 7 L 38 12 L 38 23 L 48 28 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular (top - towards lip)
        g.appendChild(createSurfacePathV3('M 12 7 L 22 12 L 38 12 L 48 7 Q 30 2 12 7 Z', 'v', cariesSurfaces, fillingSurfaces, data));
        // Lingual (bottom - cervical)
        g.appendChild(createSurfacePathV3('M 12 28 L 22 23 L 38 23 L 48 28 Q 30 30 12 28 Z', palLabel, cariesSurfaces, fillingSurfaces, data));
      }
    } else if (toothType === 'canine') {
      // Canine - pointed shape
      if (isUpper) {
        // Incisal point
        g.appendChild(createSurfacePathV3('M 25 75 L 30 70 L 35 75 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial
        g.appendChild(createSurfacePathV3('M 15 75 L 25 75 L 25 90 L 15 93 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal
        g.appendChild(createSurfacePathV3('M 45 75 L 35 75 L 35 90 L 45 93 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular
        g.appendChild(createSurfacePathV3('M 15 93 L 25 90 L 35 90 L 45 93 Q 30 98 15 93 Z', 'v', cariesSurfaces, fillingSurfaces, data));
      } else {
        // Incisal point
        g.appendChild(createSurfacePathV3('M 25 25 L 30 30 L 35 25 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial
        g.appendChild(createSurfacePathV3('M 15 25 L 25 25 L 25 10 L 15 7 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal
        g.appendChild(createSurfacePathV3('M 45 25 L 35 25 L 35 10 L 45 7 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular
        g.appendChild(createSurfacePathV3('M 15 7 L 25 10 L 35 10 L 45 7 Q 30 2 15 7 Z', 'v', cariesSurfaces, fillingSurfaces, data));
      }
    } else {
      // Incisor - rectangular
      if (isUpper) {
        // Incisal edge
        g.appendChild(createSurfacePathV3('M 18 72 L 42 72 L 42 78 L 18 78 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial
        g.appendChild(createSurfacePathV3('M 12 72 L 18 72 L 18 93 L 12 93 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal
        g.appendChild(createSurfacePathV3('M 48 72 L 42 72 L 42 93 L 48 93 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular
        g.appendChild(createSurfacePathV3('M 18 78 L 42 78 L 42 93 L 18 93 Z', 'v', cariesSurfaces, fillingSurfaces, data));
      } else {
        // Incisal edge
        g.appendChild(createSurfacePathV3('M 18 28 L 42 28 L 42 22 L 18 22 Z', 'o', cariesSurfaces, fillingSurfaces, data));
        // Mesial
        g.appendChild(createSurfacePathV3('M 12 28 L 18 28 L 18 7 L 12 7 Z', 'm', cariesSurfaces, fillingSurfaces, data));
        // Distal
        g.appendChild(createSurfacePathV3('M 48 28 L 42 28 L 42 7 L 48 7 Z', 'd', cariesSurfaces, fillingSurfaces, data));
        // Vestibular
        g.appendChild(createSurfacePathV3('M 18 22 L 42 22 L 42 7 L 18 7 Z', 'v', cariesSurfaces, fillingSurfaces, data));
      }
    }
  }

  return g;
}

/**
 * Create a surface path with appropriate coloring
 */
function createSurfacePathV3(pathD, surfaceId, cariesSurfaces, fillingSurfaces, data) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('class', 'tooth-surface');
  path.setAttribute('data-surface', surfaceId);

  // Normalize surface IDs
  const normalizedSurface = surfaceId === 'b' ? 'v' : surfaceId;
  const hasCaries = cariesSurfaces.some(s =>
    s === normalizedSurface || s === surfaceId ||
    (s === 'b' && surfaceId === 'v') || (s === 'v' && surfaceId === 'b') ||
    s === 'c' // cervical affects all
  );
  const hasFilling = fillingSurfaces.some(s =>
    s === normalizedSurface || s === surfaceId ||
    (s === 'b' && surfaceId === 'v') || (s === 'v' && surfaceId === 'b') ||
    s === 'c'
  );

  // Set fill color based on condition
  let fillColor = COLORS.healthy;
  if (data?.endo?.treated && !hasCaries && !hasFilling) {
    fillColor = COLORS.endo;
  } else if (hasCaries) {
    fillColor = COLORS.caries;
  } else if (hasFilling) {
    fillColor = COLORS.filling;
  }

  path.setAttribute('fill', fillColor);
  path.setAttribute('stroke', COLORS.healthyStroke);
  path.setAttribute('stroke-width', '0.5');

  return path;
}

/**
 * Select a tooth and show details
 */
function selectTooth(toothNumber, data) {
  // Update selection UI
  document.querySelectorAll('.tooth-v3').forEach(t => t.classList.remove('selected'));
  const toothEl = document.querySelector(`.tooth-v3[data-tooth="${toothNumber}"]`);
  if (toothEl) toothEl.classList.add('selected');

  selectedTooth = toothNumber;

  // Show detail panel
  const panel = document.getElementById('toothDetailPanel');
  const numberEl = document.getElementById('toothDetailNumber');
  const statusEl = document.getElementById('toothDetailStatus');
  const contentEl = document.getElementById('toothDetailContent');

  if (!panel || !numberEl || !statusEl || !contentEl) return;

  numberEl.textContent = `Zahn ${toothNumber}`;
  statusEl.textContent = getStatusText(data);
  contentEl.innerHTML = buildDetailContent(data, toothNumber);

  panel.style.display = 'block';
}

/**
 * Get status text for a tooth
 */
function getStatusText(data) {
  if (!data || data.present === false) return 'Nicht vorhanden';
  if (data.implant?.present) return 'Implantat';
  if (data.prosthetics) {
    const types = {
      krone: 'Krone',
      teilkrone: 'Teilkrone',
      teleskop: 'Teleskopkrone',
      brueckenglied: 'Brückenglied'
    };
    return types[data.prosthetics.type] || 'Prothetik';
  }
  if (data.endo?.treated) return 'Endodontisch behandelt';
  if (data.caries?.present) return 'Karies';
  if (data.restorations?.length > 0) return 'Restauriert';
  return 'Gesund';
}

/**
 * Build HTML content for tooth details
 */
function buildDetailContent(data, toothNumber) {
  if (!data || data.present === false) {
    return '<p style="color: var(--text-muted);">Zahn nicht vorhanden</p>';
  }

  const isUpper = isUpperJaw(toothNumber);
  const rows = [];

  // Caries
  if (data.caries?.present) {
    const surfaces = data.caries.surfaces?.map(s => formatSurface(s, isUpper)).join(', ') || '-';
    rows.push(`<div class="detail-row"><span class="detail-label">Karies:</span><span class="detail-value caries-text">Flächen: ${surfaces}</span></div>`);
  }

  // Restorations
  if (data.restorations && data.restorations.length > 0) {
    data.restorations.forEach((rest) => {
      const kind = { fuellung: 'Füllung', inlay: 'Inlay', onlay: 'Onlay', teilkrone: 'Teilkrone' }[rest.kind] || rest.kind;
      const mat = { komposit: 'Komposit', amalgam: 'Amalgam', keramik: 'Keramik', gold: 'Gold', glasio: 'GIZ' }[rest.material] || rest.material;
      const surfaces = rest.surfaces?.map(s => formatSurface(s, isUpper)).join('') || '-';
      const statusIcon = rest.status === 'suffizient' ? '✓' : rest.status === 'insuffizient' ? '⚠' : '✗';
      const statusClass = rest.status === 'suffizient' ? 'status-ok' : 'status-warn';
      rows.push(`<div class="detail-row"><span class="detail-label">${kind}:</span><span class="detail-value">${mat} ${surfaces} <span class="${statusClass}">${statusIcon}</span></span></div>`);
    });
  }

  // Prosthetics
  if (data.prosthetics) {
    const type = { krone: 'Krone', teilkrone: 'Teilkrone', teleskop: 'Teleskop', brueckenglied: 'Brückenglied' }[data.prosthetics.type] || data.prosthetics.type;
    const mat = { vmk: 'VMK', zirkon: 'Zirkon', keramik: 'Keramik', gold: 'Gold', metall: 'Metall' }[data.prosthetics.material] || data.prosthetics.material;
    const statusIcon = data.prosthetics.status === 'suffizient' ? '✓' : '⚠';
    const statusClass = data.prosthetics.status === 'suffizient' ? 'status-ok' : 'status-warn';
    rows.push(`<div class="detail-row"><span class="detail-label">Prothetik:</span><span class="detail-value crown-text">${type} (${mat}) <span class="${statusClass}">${statusIcon}</span></span></div>`);
  }

  // Implant
  if (data.implant?.present) {
    rows.push(`<div class="detail-row"><span class="detail-label">Implantat:</span><span class="detail-value implant-text">Vorhanden</span></div>`);
  }

  // Endo
  if (data.endo?.treated) {
    const canals = data.endo.canals ? `${data.endo.canals} Kanäle` : '';
    const fillingIcon = data.endo.fillingStatus ? (data.endo.fillingStatus === 'suffizient' ? '✓' : '⚠') : '';
    const fillingClass = data.endo.fillingStatus === 'suffizient' ? 'status-ok' : 'status-warn';
    const post = data.endo.post ? '+ Stift' : '';
    rows.push(`<div class="detail-row"><span class="detail-label">Endo:</span><span class="detail-value endo-text">${canals} <span class="${fillingClass}">${fillingIcon}</span> ${post}</span></div>`);
  }

  // Apical
  if (data.apical?.lesion) {
    const status = { akut: 'akut', chronisch: 'chronisch', unklar: 'unklar' }[data.apical.status] || '';
    rows.push(`<div class="detail-row"><span class="detail-label">Apikal:</span><span class="detail-value status-warn">Läsion ${status}</span></div>`);
  }

  // Gingiva
  if (data.gingiva?.inflammation || data.gingiva?.bleeding) {
    const issues = [];
    if (data.gingiva.inflammation) issues.push('Entzündung');
    if (data.gingiva.bleeding) issues.push('Blutung');
    rows.push(`<div class="detail-row"><span class="detail-label">Gingiva:</span><span class="detail-value status-warn">${issues.join(', ')}</span></div>`);
  }

  // Mobility
  if (data.mobility && data.mobility > 0) {
    rows.push(`<div class="detail-row"><span class="detail-label">Lockerung:</span><span class="detail-value status-warn">Grad ${data.mobility}</span></div>`);
  }

  // Remarks
  if (data.remarks) {
    rows.push(`<div class="detail-row"><span class="detail-label">Notiz:</span><span class="detail-value">${data.remarks}</span></div>`);
  }

  if (rows.length === 0) {
    return '<p style="color: var(--text-muted);">Keine Befunde dokumentiert</p>';
  }

  return rows.join('');
}

/**
 * Format surface label for display
 */
function formatSurface(surface, isUpper) {
  const labels = {
    'm': 'M',
    'd': 'D',
    'o': 'O',
    'v': 'V',
    'b': 'B',
    'p': isUpper ? 'P' : 'L',
    'l': isUpper ? 'P' : 'L',
    'c': 'C'
  };
  return labels[surface] || surface.toUpperCase();
}

// Export for global access
window.toothChart = {
  init: initToothChart,
  open: openToothChart,
  close: closeToothChart
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToothChart);
} else {
  initToothChart();
}
