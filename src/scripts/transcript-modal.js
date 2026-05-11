/**
 * Transcript Modal Module
 * Handles all transcript detail modal functionality including:
 * - Audio playback with waveform visualization
 * - Utterance rendering with clickable timestamps
 * - Topic tags and passage links
 * - Search with fuzzy matching
 * - Summary version selector
 * - Befund section
 */

const { ipcRenderer } = require('electron');
const utteranceProfileModal = require('../utterance-profile-modal');

// =============================================================================
// MODULE STATE
// =============================================================================

let currentTranscriptData = null;
let currentTopicSegments = null;
let currentSpeedIndex = 0;
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;
let segmentEndMs = null; // When set, audio pauses at this time (for single utterance/segment playback)

const audioSpeeds = [1, 1.25, 1.5, 2];

// =============================================================================
// UTILITIES
// =============================================================================

// Format milliseconds to mm:ss
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Escape HTML special characters
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// MODAL OPEN/CLOSE
// =============================================================================

// Open transcript detail modal
async function openTranscriptModal(filePath) {
  try {
    const result = await ipcRenderer.invoke('get-transcript-detail', filePath);
    if (!result.success) {
      console.error('Failed to load transcript:', result.error);
      return;
    }

    currentTranscriptData = result.transcript;
    const transcript = result.transcript;

    // Set modal title
    const date = new Date(transcript.createdAt);
    const dateStr = date.toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit'
    });
    document.getElementById('transcriptModalTitle').textContent = `${dateStr}, ${timeStr}`;

    // Populate meta badges
    const speakerCount = transcript.speakers?.length || (transcript.utterances ? new Set(transcript.utterances.map(u => u.speaker)).size : 0);
    document.getElementById('transcriptMetaSpeakersText').textContent = speakerCount;

    // Duration will be updated when audio loads
    const durationMs = transcript.durationMs || transcript.duration;
    if (durationMs) {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      document.getElementById('transcriptMetaDurationText').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    } else {
      document.getElementById('transcriptMetaDurationText').textContent = '--:--';
    }

    // Generate waveform bars
    generateWaveformBars();

    // Set summary with clickable passage links (if available)
    const summaryEl = document.getElementById('transcriptSummary');
    if (transcript.docLinks && transcript.docLinks.length > 0 && transcript.audioPath) {
      // Render with clickable links to audio passages
      summaryEl.innerHTML = renderDocumentationWithPassageLinks(
        transcript.summary || 'Keine Zusammenfassung verfuegbar',
        transcript.docLinks
      );
      // Attach click handlers for the links
      attachPassageLinkHandlers(summaryEl);
    } else {
      // No links, just plain text
      summaryEl.textContent = transcript.summary || 'Keine Zusammenfassung verfuegbar';
    }

    // Setup summary version selector
    initSummaryVersions(transcript);

    // Render topic tags if available
    renderTopicTags(transcript.topicSegments);

    // Render utterances (with word-level timestamps if available)
    renderUtterances(transcript.utterances, transcript.words);

    // DSGVO: audio is no longer persisted, so playback in the transcript modal is disabled.
    document.getElementById('transcriptAudioPlayer').style.display = 'none';
    // Hide topics tab (topics are tied to audio navigation)
    document.getElementById('tabThemen').style.display = 'none';

    // Setup Befund section (status01 / statusPA)
    setupBefundSection(transcript.status01, transcript.statusPA);

    // Reset tabs to default (Transkript)
    resetTranscriptTabs();

    // Show modal
    document.getElementById('transcriptModal').style.display = 'flex';

  } catch (error) {
    console.error('Error opening transcript modal:', error);
  }
}

// Close transcript modal
function closeTranscriptModal() {
  document.getElementById('transcriptModal').style.display = 'none';
  // Hide topic popup and reset state
  closeTopicPopup();
  currentTranscriptData = null;
  currentTopicSegments = null;
}

// =============================================================================
// BEFUND SECTION
// =============================================================================

// Setup Befund section in transcript modal (now as a tab)
function setupBefundSection(status01, statusPA) {
  const tabBtn = document.getElementById('tabBefunde');
  const show01Btn = document.getElementById('transcriptShow01Status');
  const copy01Btn = document.getElementById('transcriptCopy01Json');
  const copyPABtn = document.getElementById('transcriptCopyPAJson');

  // Hide tab and buttons initially
  tabBtn.style.display = 'none';
  show01Btn.style.display = 'none';
  copy01Btn.style.display = 'none';
  copyPABtn.style.display = 'none';

  const hasStatus01 = status01 && typeof status01 === 'object';
  const hasStatusPA = statusPA && typeof statusPA === 'object';

  if (!hasStatus01 && !hasStatusPA) {
    return; // Nothing to show
  }

  // Show Befunde tab
  tabBtn.style.display = 'inline-flex';

  // Setup 01-Status buttons
  if (hasStatus01) {
    show01Btn.style.display = 'inline-flex';
    copy01Btn.style.display = 'inline-flex';

    // Store status01 for button handlers
    show01Btn.dataset.status01 = JSON.stringify(status01);
    copy01Btn.dataset.status01 = JSON.stringify(status01);
  }

  // Setup PA-Status button
  if (hasStatusPA) {
    copyPABtn.style.display = 'inline-flex';
    copyPABtn.dataset.statusPA = JSON.stringify(statusPA);
  }
}

// Initialize Befund section button handlers
function initBefundSectionHandlers() {
  // Show 01-Status in Tooth Chart
  document.getElementById('transcriptShow01Status')?.addEventListener('click', function() {
    const status01Str = this.dataset.status01;
    if (status01Str) {
      try {
        const status01 = JSON.parse(status01Str);
        ipcRenderer.send('open-tooth-chart', { status01 });
      } catch (e) {
        console.error('Failed to parse status01:', e);
      }
    }
  });

  // Copy 01-JSON
  document.getElementById('transcriptCopy01Json')?.addEventListener('click', async function() {
    const status01Str = this.dataset.status01;
    if (status01Str) {
      try {
        const status01 = JSON.parse(status01Str);
        const jsonStr = JSON.stringify(status01, null, 2);
        await ipcRenderer.invoke('copy-to-clipboard', jsonStr);
        this.querySelector('span').textContent = 'Kopiert!';
        setTimeout(() => {
          this.querySelector('span').textContent = '01-JSON kopieren';
        }, 2000);
      } catch (e) {
        console.error('Failed to copy status01:', e);
      }
    }
  });

  // Copy PA-JSON
  document.getElementById('transcriptCopyPAJson')?.addEventListener('click', async function() {
    const statusPAStr = this.dataset.statusPA;
    if (statusPAStr) {
      try {
        const statusPA = JSON.parse(statusPAStr);
        const jsonStr = JSON.stringify(statusPA, null, 2);
        await ipcRenderer.invoke('copy-to-clipboard', jsonStr);
        this.querySelector('span').textContent = 'Kopiert!';
        setTimeout(() => {
          this.querySelector('span').textContent = 'PA-JSON kopieren';
        }, 2000);
      } catch (e) {
        console.error('Failed to copy statusPA:', e);
      }
    }
  });
}

// =============================================================================
// UTTERANCES RENDERING
// =============================================================================

// Render utterances in modal (with optional word-level timestamps)
function renderUtterances(utterances, words = null) {
  const container = document.getElementById('transcriptUtterances');
  container.innerHTML = '';

  if (!utterances || utterances.length === 0) {
    container.innerHTML = '<p class="text-muted">Keine Utterances verfügbar</p>';
    return;
  }

  // Check if audio is available for "add to profile" feature
  const audioAvailable = currentTranscriptData?.speechOnlyPath || currentTranscriptData?.audioPath;

  // Speaker color gradients for avatars
  const speakerColors = [
    'linear-gradient(135deg, #f97316, #ea580c)',
    'linear-gradient(135deg, #3b82f6, #2563eb)',
    'linear-gradient(135deg, #10b981, #059669)',
    'linear-gradient(135deg, #8b5cf6, #7c3aed)',
    'linear-gradient(135deg, #ec4899, #db2777)'
  ];

  // Build speaker color map for consistent colors
  const speakerColorMap = new Map();
  let colorIndex = 0;

  // Build word lookup map if words are available
  const wordMap = new Map();
  if (words && words.length > 0) {
    words.forEach(w => {
      wordMap.set(w.start, w);
    });
  }

  utterances.forEach((utterance, index) => {
    const div = document.createElement('div');
    div.className = 'utterance';
    div.dataset.index = index;
    div.dataset.startMs = utterance.start;

    const timeStr = formatTime(utterance.start);
    const speaker = utterance.speaker || 'Sprecher';

    // Assign consistent color to speaker
    if (!speakerColorMap.has(speaker)) {
      speakerColorMap.set(speaker, speakerColors[colorIndex % speakerColors.length]);
      colorIndex++;
    }
    const avatarColor = speakerColorMap.get(speaker);

    // Generate initials for avatar
    const initials = speaker.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

    // Determine role indicator (if speaker name contains role hints)
    let roleIndicator = '';
    const speakerLower = speaker.toLowerCase();
    if (speakerLower.includes('arzt') || speakerLower.includes('dr.') || speakerLower.includes('zahnarzt')) {
      roleIndicator = '<span class="utterance-role dentist">Arzt</span>';
    } else if (speakerLower.includes('assistent') || speakerLower.includes('zfa') || speakerLower.includes('helferin')) {
      roleIndicator = '<span class="utterance-role assistant">ZFA</span>';
    } else if (speakerLower.includes('patient')) {
      roleIndicator = '<span class="utterance-role patient">Patient</span>';
    }

    // If we have words, render text with clickable words
    let textHtml = utterance.text;
    if (words && words.length > 0) {
      const utteranceWords = words.filter(w =>
        w.start >= utterance.start && w.end <= utterance.end
      );

      if (utteranceWords.length > 0) {
        textHtml = utteranceWords.map(w =>
          `<span class="clickable-word" data-start="${w.start}" title="[${formatTime(w.start)}]">${w.text}</span>`
        ).join(' ');
      }
    }

    // Add-to-profile button (only if audio is available)
    const addProfileBtn = audioAvailable ? `
      <button class="utterance-add-profile-btn" data-index="${index}" title="Zu Stimmprofil hinzufügen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="8.5" cy="7" r="4"/>
          <line x1="20" y1="8" x2="20" y2="14"/>
          <line x1="23" y1="11" x2="17" y2="11"/>
        </svg>
      </button>
    ` : '';

    div.innerHTML = `
      <div class="utterance-avatar" style="background: ${avatarColor};">${initials}</div>
      <div class="utterance-content">
        <div class="utterance-header">
          <span class="utterance-speaker">${speaker}</span>
          ${roleIndicator}
          <span class="utterance-time" data-time-ms="${utterance.start}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            ${timeStr}
          </span>
          ${addProfileBtn}
        </div>
        <div class="utterance-text">${textHtml}</div>
      </div>
    `;

    // Click on time to play only this utterance
    const timeEl = div.querySelector('.utterance-time');
    timeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      playSegment(utterance.start, utterance.end);

      // Add playing state to utterance
      container.querySelectorAll('.utterance').forEach(u => u.classList.remove('playing'));
      div.classList.add('playing');
    });

    // Click on words to jump to their position
    div.querySelectorAll('.clickable-word').forEach(wordEl => {
      wordEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const startMs = parseInt(wordEl.dataset.start);
        jumpToTime(startMs);

        // Add playing state
        container.querySelectorAll('.utterance').forEach(u => u.classList.remove('playing'));
        div.classList.add('playing');
      });
    });

    container.appendChild(div);
  });
}

// Handle utterance add button click - gather data and open modal
function handleUtteranceAddClick(utteranceIndex) {
  // Parse utterances (may be string or array)
  let utterances = currentTranscriptData.utterances;
  if (typeof utterances === 'string') {
    utterances = JSON.parse(utterances);
  }

  const utterance = utterances[utteranceIndex];
  if (!utterance) return;

  const audioPath = currentTranscriptData.speechOnlyPath || currentTranscriptData.audioPath;

  // Get speaker label from mapping
  const speakerMapping = currentTranscriptData.speakerMapping;
  let speakerLabel = `Speaker ${utterance.speaker}`;
  if (speakerMapping) {
    const mapping = typeof speakerMapping === 'string' ? JSON.parse(speakerMapping) : speakerMapping;
    if (mapping[utterance.speaker]) {
      speakerLabel = mapping[utterance.speaker];
    }
  }

  // Open modal with data
  utteranceProfileModal.openUtteranceProfileModal({
    audioPath,
    startMs: utterance.start,
    endMs: utterance.end,
    speakerLabel,
    text: utterance.text,
  });
}

// =============================================================================
// AUDIO PLAYER
// =============================================================================

// Generate waveform bars for audio visualization
function generateWaveformBars() {
  const waveform = document.getElementById('audioWaveform');
  if (!waveform) return;

  waveform.innerHTML = '';

  // Generate 50 bars with random heights (simulate waveform)
  const barCount = 50;
  for (let i = 0; i < barCount; i++) {
    const bar = document.createElement('div');
    bar.className = 'waveform-bar';
    // Random height between 20% and 100%
    const height = 20 + Math.random() * 80;
    bar.style.height = `${height}%`;
    waveform.appendChild(bar);
  }
}

// Update waveform progress (called on timeupdate)
function updateWaveformProgress(percent) {
  const waveform = document.getElementById('audioWaveform');
  if (!waveform) return;

  const bars = waveform.querySelectorAll('.waveform-bar');
  const playedCount = Math.floor((percent / 100) * bars.length);

  bars.forEach((bar, index) => {
    if (index < playedCount) {
      bar.classList.add('played');
    } else {
      bar.classList.remove('played');
    }
  });
}

// DSGVO: audio playback removed — audio files are never persisted.
// setupAudioPlayer / updatePlayingUtterance / jumpToTime are no-ops to keep call sites safe.
async function setupAudioPlayer(_audioPath) { /* no-op */ }
function updatePlayingUtterance(_currentMs) { /* no-op */ }
function jumpToTime(_ms) { /* no-op */ }

// =============================================================================
// TOPIC TAGS
// =============================================================================

// Render topic tags from extracted segments (now as a tab)
function renderTopicTags(topicSegments) {
  const tabBtn = document.getElementById('tabThemen');
  const container = document.getElementById('topicTags');

  if (!topicSegments || topicSegments.length === 0) {
    tabBtn.style.display = 'none';
    return;
  }

  currentTopicSegments = topicSegments;
  tabBtn.style.display = 'inline-flex';
  container.innerHTML = '';

  // Group segments by name
  const groupedTopics = {};
  topicSegments.forEach(segment => {
    const key = segment.name;
    if (!groupedTopics[key]) {
      groupedTopics[key] = {
        name: segment.name,
        type: segment.type,
        segments: []
      };
    }
    groupedTopics[key].segments.push(segment);
  });

  // Create tags for each topic
  Object.values(groupedTopics).forEach(topic => {
    const tag = document.createElement('div');
    tag.className = 'topic-tag';
    tag.dataset.type = topic.type;
    tag.dataset.name = topic.name;

    const count = topic.segments.length;
    tag.innerHTML = `
      <span class="topic-name">${topic.name}</span>
      ${count > 1 ? `<span class="topic-count">${count}x</span>` : ''}
    `;

    tag.addEventListener('click', () => {
      // Close the themen drawer when a topic is clicked
      document.getElementById('themenDrawer')?.classList.remove('open');
      document.getElementById('tabThemen')?.classList.remove('active');
      showTopicPopup(topic.name, topic.segments);
    });

    container.appendChild(tag);
  });
}

// Show popup with all segments for a topic
function showTopicPopup(topicName, segments) {
  const popup = document.getElementById('topicPopup');
  const title = document.getElementById('topicPopupTitle');
  const segmentsContainer = document.getElementById('topicPopupSegments');

  title.textContent = `${topicName} - ${segments.length} ${segments.length === 1 ? 'Stelle' : 'Stellen'}`;
  segmentsContainer.innerHTML = '';

  segments.forEach((segment, index) => {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'topic-segment';
    segmentEl.dataset.startMs = segment.startMs;
    segmentEl.dataset.endMs = segment.endMs;

    const startTime = formatTime(segment.startMs);
    const endTime = formatTime(segment.endMs);

    segmentEl.innerHTML = `
      <div class="topic-segment-play">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="topic-segment-info">
        <div class="topic-segment-time">[${startTime} - ${endTime}]</div>
        <div class="topic-segment-summary">${segment.summary || 'Klicken zum Anhoeren'}</div>
      </div>
    `;

    segmentEl.addEventListener('click', () => {
      playSegment(segment.startMs, segment.endMs);
    });

    segmentsContainer.appendChild(segmentEl);
  });

  popup.style.display = 'flex';
}

// Close topic popup
function closeTopicPopup() {
  const popup = document.getElementById('topicPopup');
  if (popup) popup.style.display = 'none';
}

// =============================================================================
// DOCUMENTATION PASSAGE LINKS
// =============================================================================

/**
 * Render documentation text with clickable passage links.
 * Each link connects documentation text to semantic audio passages (15-40 sec clips).
 */
function renderDocumentationWithPassageLinks(documentation, docLinks) {
  if (!docLinks || docLinks.length === 0 || !documentation) {
    return escapeHtml(documentation || '');
  }

  // Collect all positions with their passage data
  const allPositions = [];
  docLinks.forEach(link => {
    if (!link.positions || !link.passages || link.passages.length === 0) return;
    link.positions.forEach(pos => {
      // Validate position is within bounds
      if (pos.start >= 0 && pos.end <= documentation.length && pos.start < pos.end) {
        allPositions.push({
          start: pos.start,
          end: pos.end,
          docText: link.docText,
          passages: link.passages
        });
      }
    });
  });

  // Sort by start position (ascending) to process in order
  allPositions.sort((a, b) => a.start - b.start);

  // Remove overlapping positions (keep first occurrence)
  const nonOverlapping = [];
  let lastEnd = 0;
  allPositions.forEach(pos => {
    if (pos.start >= lastEnd) {
      nonOverlapping.push(pos);
      lastEnd = pos.end;
    }
  });

  // Build result string by replacing positions with clickable spans
  let result = '';
  let currentIndex = 0;

  nonOverlapping.forEach(pos => {
    // Add text before this position (escaped)
    if (pos.start > currentIndex) {
      result += escapeHtml(documentation.slice(currentIndex, pos.start));
    }

    // Add the linked text as a clickable span
    const linkText = documentation.slice(pos.start, pos.end);
    const passagesJson = JSON.stringify(pos.passages).replace(/"/g, '&quot;');
    // Determine type from first passage's topic for styling
    const topic = pos.passages[0]?.topic || 'Sonstiges';
    result += `<span class="doc-audio-link" data-topic="${topic}" data-text="${escapeHtml(pos.docText)}" data-passages="${passagesJson}">${escapeHtml(linkText)}</span>`;

    currentIndex = pos.end;
  });

  // Add remaining text (escaped)
  if (currentIndex < documentation.length) {
    result += escapeHtml(documentation.slice(currentIndex));
  }

  // Convert newlines to <br> for proper display
  result = result.replace(/\n/g, '<br>');

  return result;
}

/**
 * Show popup for a clicked documentation link with its audio passages.
 */
function showPassagePopup(linkText, passages, clickEvent) {
  const popup = document.getElementById('topicPopup');
  const title = document.getElementById('topicPopupTitle');
  const segmentsContainer = document.getElementById('topicPopupSegments');

  title.textContent = `"${linkText}" - ${passages.length} ${passages.length === 1 ? 'Audio-Passage' : 'Audio-Passagen'}`;
  segmentsContainer.innerHTML = '';

  passages.forEach((passage, index) => {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'topic-segment';
    segmentEl.dataset.startMs = passage.startMs;
    segmentEl.dataset.endMs = passage.endMs;

    const startTime = formatTime(passage.startMs);
    const endTime = formatTime(passage.endMs);
    const durationSec = Math.round((passage.endMs - passage.startMs) / 1000);

    segmentEl.innerHTML = `
      <div class="topic-segment-play">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="topic-segment-info">
        <div class="topic-segment-time">[${startTime} - ${endTime}] (${durationSec}s)</div>
        <div class="topic-segment-topic">${passage.topic || 'Sonstiges'}</div>
        <div class="topic-segment-summary">${passage.summary || passage.text?.substring(0, 100) + '...' || 'Klicken zum Anhoeren'}</div>
      </div>
    `;

    segmentEl.addEventListener('click', () => {
      playSegment(passage.startMs, passage.endMs);
    });

    segmentsContainer.appendChild(segmentEl);
  });

  popup.style.display = 'flex';
}

/**
 * Attach click handlers to passage links in documentation
 */
function attachPassageLinkHandlers(container) {
  container.querySelectorAll('.doc-audio-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = link.dataset.text;
      const passagesJson = link.dataset.passages;
      try {
        const passages = JSON.parse(passagesJson);
        if (passages && passages.length > 0) {
          showPassagePopup(text, passages, e);
        }
      } catch (err) {
        console.error('Failed to parse passages JSON:', err);
      }
    });
  });
}

// DSGVO: audio playback removed — playSegment is a no-op.
function playSegment(_startMs, _endMs) { /* no-op */ }

// =============================================================================
// DRAWER TOGGLES
// =============================================================================

function initTranscriptDrawers() {
  // Befunde toggle
  const befundeBtn = document.getElementById('tabBefunde');
  const befundeDrawer = document.getElementById('befundeDrawer');

  if (befundeBtn && befundeDrawer) {
    befundeBtn.addEventListener('click', () => {
      const isOpen = befundeDrawer.classList.toggle('open');
      befundeBtn.classList.toggle('active', isOpen);
      // Close other drawer
      document.getElementById('themenDrawer')?.classList.remove('open');
      document.getElementById('tabThemen')?.classList.remove('active');
    });
  }

  // Themen toggle
  const themenBtn = document.getElementById('tabThemen');
  const themenDrawer = document.getElementById('themenDrawer');

  if (themenBtn && themenDrawer) {
    themenBtn.addEventListener('click', () => {
      const isOpen = themenDrawer.classList.toggle('open');
      themenBtn.classList.toggle('active', isOpen);
      // Close other drawer
      document.getElementById('befundeDrawer')?.classList.remove('open');
      document.getElementById('tabBefunde')?.classList.remove('active');
    });
  }
}

// Reset drawers when opening modal (close all)
function resetTranscriptTabs() {
  // Close all drawers
  document.querySelectorAll('.transcript-drawer').forEach(drawer => {
    drawer.classList.remove('open');
  });
  document.querySelectorAll('.toolbar-toggle').forEach(btn => {
    btn.classList.remove('active');
  });
  // Reset search
  const searchInput = document.getElementById('transcriptSearchInput');
  const searchCount = document.getElementById('searchCount');
  if (searchInput) {
    searchInput.value = '';
    if (searchCount) searchCount.textContent = '';
    // Clear any highlights
    document.querySelectorAll('#transcriptUtterances .utterance').forEach(u => {
      u.classList.remove('search-match', 'search-current');
      const textEl = u.querySelector('.utterance-text');
      if (textEl && textEl.dataset.originalText) {
        textEl.innerHTML = textEl.dataset.originalText;
      }
    });
  }
  // Reset progress bar
  const progressBar = document.getElementById('audioProgressBar');
  if (progressBar) progressBar.style.width = '0%';
  // Reset search state
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
}

// =============================================================================
// SEARCH
// =============================================================================

// Initialize transcript search with fuzzy matching and navigation
function initTranscriptSearch() {
  const input = document.getElementById('transcriptSearchInput');
  const countEl = document.getElementById('searchCount');
  const prevBtn = document.getElementById('searchPrev');
  const nextBtn = document.getElementById('searchNext');
  if (!input) return;

  function performSearch() {
    const query = input.value.toLowerCase().trim();
    const utterances = document.querySelectorAll('#transcriptUtterances .utterance');
    transcriptSearchMatches = [];
    transcriptSearchIndex = -1;

    // Clear previous highlights
    document.querySelectorAll('#transcriptUtterances mark.search-current').forEach(m => {
      m.classList.remove('search-current');
    });

    utterances.forEach(u => {
      const textEl = u.querySelector('.utterance-text');
      if (!textEl) return;

      // Store original text on first search
      if (!textEl.dataset.originalText) {
        textEl.dataset.originalText = textEl.textContent;
      }
      const originalText = textEl.dataset.originalText;

      u.classList.remove('search-match');

      if (!query) {
        textEl.innerHTML = originalText;
        return;
      }

      // Check if query is present
      const textLower = originalText.toLowerCase();
      if (textLower.includes(query)) {
        u.classList.add('search-match');

        // Highlight all occurrences
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escaped})`, 'gi');
        textEl.innerHTML = originalText.replace(regex, '<mark>$1</mark>');
      } else {
        textEl.innerHTML = originalText;
      }
    });

    // Collect all <mark> elements as individual matches
    transcriptSearchMatches = Array.from(document.querySelectorAll('#transcriptUtterances mark'));

    // Update count
    if (countEl) {
      countEl.textContent = transcriptSearchMatches.length > 0
        ? `0/${transcriptSearchMatches.length}`
        : '';
    }

    // Jump to first match
    if (transcriptSearchMatches.length > 0) {
      jumpToSearchMatch(0);
    }
  }

  function jumpToSearchMatch(index) {
    if (transcriptSearchMatches.length === 0) return;

    // Remove current highlight from all marks
    document.querySelectorAll('#transcriptUtterances mark.search-current').forEach(m => {
      m.classList.remove('search-current');
    });

    // Wrap around
    transcriptSearchIndex = ((index % transcriptSearchMatches.length) + transcriptSearchMatches.length) % transcriptSearchMatches.length;

    // Highlight current match
    const current = transcriptSearchMatches[transcriptSearchIndex];
    current.classList.add('search-current');
    current.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update count
    if (countEl) {
      countEl.textContent = `${transcriptSearchIndex + 1}/${transcriptSearchMatches.length}`;
    }
  }

  input.addEventListener('input', performSearch);

  // Enter key = next match, Shift+Enter = previous
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        jumpToSearchMatch(transcriptSearchIndex - 1);
      } else {
        jumpToSearchMatch(transcriptSearchIndex + 1);
      }
    }
  });

  // Nav buttons
  if (prevBtn) prevBtn.addEventListener('click', () => jumpToSearchMatch(transcriptSearchIndex - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => jumpToSearchMatch(transcriptSearchIndex + 1));
}

// =============================================================================
// COPY & SUMMARY VERSIONS
// =============================================================================

// Initialize copy summary button
function initCopySummaryButton() {
  const copyBtn = document.getElementById('copySummaryBtn');
  if (!copyBtn) return;

  copyBtn.addEventListener('click', async () => {
    const summary = document.getElementById('transcriptSummary');
    if (!summary) return;

    try {
      await navigator.clipboard.writeText(summary.innerText);
      // Show checkmark icon
      const originalSvg = copyBtn.innerHTML;
      copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>`;
      copyBtn.style.color = 'var(--success-color)';
      setTimeout(() => {
        copyBtn.innerHTML = originalSvg;
        copyBtn.style.color = '';
      }, 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });
}

// Initialize summary version selector
function initSummaryVersions(transcript) {
  const select = document.getElementById('summaryVersionSelect');
  const summaryEl = document.getElementById('transcriptSummary');
  if (!select || !summaryEl) return;

  // Store transcript data for version switching
  select.dataset.summary = transcript.summary || '';
  select.dataset.kzv = transcript.kzvDocumentation || '';
  select.dataset.zdoku = transcript.zDocumentation || '';

  // Hide options if not available
  const kzvOption = select.querySelector('[value="kzv"]');
  const zdokuOption = select.querySelector('[value="zdoku"]');
  if (kzvOption) kzvOption.style.display = transcript.kzvDocumentation ? '' : 'none';
  if (zdokuOption) zdokuOption.style.display = transcript.zDocumentation ? '' : 'none';

  // Hide entire select if only main summary exists
  const hasAlternatives = transcript.kzvDocumentation || transcript.zDocumentation;
  select.style.display = hasAlternatives ? '' : 'none';

  // Reset to main summary
  select.value = 'summary';

  // Handle version change
  select.onchange = () => {
    switch(select.value) {
      case 'kzv':
        summaryEl.textContent = select.dataset.kzv || 'Nicht verfügbar';
        break;
      case 'zdoku':
        summaryEl.textContent = select.dataset.zdoku || 'Nicht verfügbar';
        break;
      default:
        summaryEl.textContent = select.dataset.summary || 'Keine Zusammenfassung verfügbar';
    }
  };
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize transcript modal module
 * Sets up all event listeners
 */
function initTranscriptModal() {
  // Initialize utterance profile modal module
  utteranceProfileModal.init({ ipcRenderer });

  // Event delegation for add-to-profile button clicks
  document.getElementById('transcriptUtterances')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.utterance-add-profile-btn');
    if (btn) {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index, 10);
      handleUtteranceAddClick(index);
    }
  });

  // Event listeners for topic popup
  document.getElementById('topicPopupClose')?.addEventListener('click', closeTopicPopup);

  // Close popup when clicking outside
  document.getElementById('topicPopup')?.addEventListener('click', (e) => {
    if (e.target.id === 'topicPopup') {
      closeTopicPopup();
    }
  });

  // Modal close button
  document.getElementById('transcriptModalClose')?.addEventListener('click', closeTranscriptModal);

  // Close modal when clicking backdrop
  document.getElementById('transcriptModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'transcriptModal') {
      closeTranscriptModal();
    }
  });

  // Initialize drawers, search, and copy button
  initTranscriptDrawers();
  initTranscriptSearch();
  initCopySummaryButton();
  initBefundSectionHandlers();
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  openTranscriptModal,
  closeTranscriptModal,
  initTranscriptModal,
  // Expose current transcript data for external access if needed
  getCurrentTranscriptData: () => currentTranscriptData
};
