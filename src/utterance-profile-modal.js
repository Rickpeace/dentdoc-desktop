/**
 * Utterance to Profile Modal
 *
 * Handles the modal for adding transcript utterances to voice profiles.
 * Extracted from dashboard.js for better code organization.
 */

// Dependencies (injected via init)
let ipcRenderer = null;

// Module state
let utteranceModalData = null;
let similarityResolve = null;

/**
 * Show inline error message in the modal
 * @param {string} message - Error message to show
 */
function showInlineError(message) {
  const errorEl = document.getElementById('utteranceError');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'flex';
  }
}

/**
 * Hide inline error message
 */
function hideInlineError() {
  const errorEl = document.getElementById('utteranceError');
  if (errorEl) {
    errorEl.style.display = 'none';
  }
  // Also remove error class from inputs
  const nameInput = document.getElementById('utteranceNewName');
  const roleSelect = document.getElementById('utteranceNewRole');
  if (nameInput) nameInput.classList.remove('error');
  if (roleSelect) roleSelect.classList.remove('error');
}

/**
 * Show notification (for errors that need alert)
 * @param {string} message - Message to show
 * @param {string} type - Type: 'success', 'error', 'warning'
 */
function showNotification(message, type) {
  if (type === 'error') {
    alert(message);
  }
  console.log(`[Notification ${type}]`, message);
}

/**
 * Initialize the module with dependencies
 * @param {Object} deps - Dependencies
 * @param {Object} deps.ipcRenderer - Electron IPC renderer
 */
function init(deps) {
  ipcRenderer = deps.ipcRenderer;
  setupEventListeners();
}

/**
 * Setup all event listeners for both modals
 */
function setupEventListeners() {
  // Radio button toggle for new/existing profile
  document.getElementById('utteranceProfileModal').addEventListener('change', (e) => {
    if (e.target.name === 'utteranceAction') {
      const newInputs = document.getElementById('utteranceNewProfileInputs');
      const existingSelect = document.getElementById('utteranceExistingProfile');

      if (e.target.value === 'new') {
        newInputs.style.display = 'flex';
        existingSelect.disabled = true;
      } else {
        newInputs.style.display = 'none';
        existingSelect.disabled = false;
      }
    }
  });

  // Cancel button
  document.getElementById('utteranceProfileCancelBtn').addEventListener('click', closeUtteranceProfileModal);

  // Close on backdrop click
  document.getElementById('utteranceProfileModal').addEventListener('click', (e) => {
    if (e.target.id === 'utteranceProfileModal') {
      closeUtteranceProfileModal();
    }
  });

  // Confirm button
  document.getElementById('utteranceProfileConfirmBtn').addEventListener('click', handleConfirm);

  // Clear errors when user interacts with form
  document.getElementById('utteranceNewName').addEventListener('input', hideInlineError);
  document.getElementById('utteranceNewRole').addEventListener('change', hideInlineError);
  document.getElementById('utteranceExistingProfile').addEventListener('change', hideInlineError);

  // Similarity modal buttons
  document.getElementById('similarityConfirmBtn').addEventListener('click', () => {
    closeSimilarityWarningModal(true);
  });

  document.getElementById('similarityCancelBtn').addEventListener('click', () => {
    closeSimilarityWarningModal(false);
  });

  // Close similarity modal on backdrop click
  document.getElementById('similarityWarningModal').addEventListener('click', (e) => {
    if (e.target.id === 'similarityWarningModal') {
      closeSimilarityWarningModal(false);
    }
  });

  // Play button for utterance preview
  document.getElementById('utterancePlayBtn').addEventListener('click', handlePlayClick);

  // Audio ended event
  const audio = document.getElementById('utterancePreviewAudio');
  if (audio) {
    audio.addEventListener('ended', () => {
      updatePlayButton(false);
    });
  }
}

/**
 * Handle play button click - play/pause the utterance audio
 */
async function handlePlayClick() {
  const audio = document.getElementById('utterancePreviewAudio');
  const playBtn = document.getElementById('utterancePlayBtn');

  if (!audio || !utteranceModalData) return;

  // Stop transcript audio if playing
  const transcriptAudio = document.getElementById('transcriptAudio');
  if (transcriptAudio && !transcriptAudio.paused) transcriptAudio.pause();

  // If playing, pause
  if (!audio.paused) {
    audio.pause();
    updatePlayButton(false);
    return;
  }

  // Load audio if not loaded yet
  if (!audio.src || audio.dataset.audioPath !== utteranceModalData.audioPath) {
    try {
      playBtn.disabled = true;

      // Get audio data via IPC
      const result = await ipcRenderer.invoke('get-transcript-audio', utteranceModalData.audioPath);
      if (!result.success) {
        console.error('[Utterance Play] Failed to load audio:', result.error);
        playBtn.disabled = false;
        return;
      }

      audio.src = `data:${result.mimeType};base64,${result.data}`;
      audio.dataset.audioPath = utteranceModalData.audioPath;

      // Wait for audio to load
      await new Promise((resolve) => {
        audio.onloadedmetadata = resolve;
      });

      playBtn.disabled = false;
    } catch (err) {
      console.error('[Utterance Play] Error loading audio:', err);
      playBtn.disabled = false;
      return;
    }
  }

  // Seek to start position and play
  const startSec = utteranceModalData.startMs / 1000;
  const endSec = utteranceModalData.endMs / 1000;

  audio.currentTime = startSec;
  audio.play();
  updatePlayButton(true);

  // Stop at end position
  const checkEnd = () => {
    if (audio.currentTime >= endSec) {
      audio.pause();
      updatePlayButton(false);
      audio.removeEventListener('timeupdate', checkEnd);
    }
  };
  audio.addEventListener('timeupdate', checkEnd);
}

/**
 * Update play button icon
 * @param {boolean} isPlaying - Whether audio is playing
 */
function updatePlayButton(isPlaying) {
  const playBtn = document.getElementById('utterancePlayBtn');
  if (!playBtn) return;

  if (isPlaying) {
    playBtn.classList.add('playing');
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>`;
  } else {
    playBtn.classList.remove('playing');
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>`;
  }
}

/**
 * Handle confirm button click
 */
async function handleConfirm() {
  if (!utteranceModalData) return;

  const action = document.querySelector('input[name="utteranceAction"]:checked').value;
  const isNewProfile = action === 'new';

  const params = {
    audioPath: utteranceModalData.audioPath,
    startMs: utteranceModalData.startMs,
    endMs: utteranceModalData.endMs,
    profileId: null,
    newProfileName: null,
    newProfileRole: null,
  };

  // Get profile name for success message
  let profileName = '';

  // Clear any previous errors
  hideInlineError();

  if (action === 'existing') {
    const select = document.getElementById('utteranceExistingProfile');
    params.profileId = select.value;
    if (!params.profileId) {
      showInlineError('Bitte Profil auswählen');
      return;
    }
    // Get selected option text (e.g., "Dr. Müller (Zahnarzt)" -> "Dr. Müller")
    const selectedText = select.options[select.selectedIndex].text;
    profileName = selectedText.split(' (')[0];
  } else {
    const nameInput = document.getElementById('utteranceNewName');
    const roleSelect = document.getElementById('utteranceNewRole');
    params.newProfileName = nameInput.value.trim();
    params.newProfileRole = roleSelect.value;

    if (!params.newProfileName && !params.newProfileRole) {
      showInlineError('Bitte Name und Rolle eingeben');
      nameInput.classList.add('error');
      roleSelect.classList.add('error');
      nameInput.focus();
      return;
    }
    if (!params.newProfileName) {
      showInlineError('Bitte Name eingeben');
      nameInput.classList.add('error');
      nameInput.focus();
      return;
    }
    if (!params.newProfileRole) {
      showInlineError('Bitte Rolle wählen');
      roleSelect.classList.add('error');
      roleSelect.focus();
      return;
    }
    profileName = params.newProfileName;
  }

  try {
    // Show loading state
    const confirmBtn = document.getElementById('utteranceProfileConfirmBtn');
    const originalText = confirmBtn.textContent;
    confirmBtn.textContent = 'Wird hinzugefügt...';
    confirmBtn.disabled = true;

    const result = await ipcRenderer.invoke('add-utterance-to-profile', params);

    console.log('[Utterance to Profile] Result:', result);

    // Check if similarity warning needed
    if (result && result.needsConfirmation) {
      confirmBtn.textContent = originalText;
      confirmBtn.disabled = false;

      // Show similarity warning modal
      const confirmed = await showUtteranceSimilarityWarning(result.similarity, result.profileName);
      if (confirmed) {
        // Re-call with force: true
        confirmBtn.textContent = 'Wird hinzugefügt...';
        confirmBtn.disabled = true;

        params.force = true;
        const forceResult = await ipcRenderer.invoke('add-utterance-to-profile', params);

        confirmBtn.textContent = originalText;
        confirmBtn.disabled = false;

        if (forceResult && forceResult.success) {
          // Show success and close (function handles the delay)
          await showUtteranceSuccess(result.profileName || profileName, isNewProfile);
        } else {
          showNotification(forceResult?.error || 'Fehler beim Hinzufügen', 'error');
        }
      }
      // Else: User cancelled, do nothing
      return;
    }

    confirmBtn.textContent = originalText;
    confirmBtn.disabled = false;

    if (result && result.success) {
      // Show success and close (function handles the delay)
      await showUtteranceSuccess(result.profileName || profileName, isNewProfile);
    } else {
      showNotification(result?.error || 'Fehler beim Hinzufügen', 'error');
    }
  } catch (err) {
    console.error('[Utterance to Profile] Error:', err);
    showNotification('Fehler: ' + err.message, 'error');
  }
}

/**
 * Open modal for adding utterance to profile
 * @param {Object} options - Modal options
 * @param {string} options.audioPath - Path to audio file
 * @param {number} options.startMs - Start time in milliseconds
 * @param {number} options.endMs - End time in milliseconds
 * @param {string} options.speakerLabel - Speaker label to display
 * @param {string} options.text - Utterance text
 */
async function openUtteranceProfileModal(options) {
  const { audioPath, startMs, endMs, speakerLabel, text } = options;

  const durationSec = ((endMs - startMs) / 1000).toFixed(1);

  // Store data for confirmation
  utteranceModalData = {
    audioPath,
    startMs,
    endMs,
  };

  // Populate preview
  document.getElementById('utterancePreviewSpeaker').textContent = speakerLabel;
  document.getElementById('utterancePreviewDuration').textContent = `${durationSec}s`;
  document.getElementById('utterancePreviewText').textContent =
    text.length > 100 ? text.slice(0, 100) + '...' : text;

  // Load profiles list
  await loadProfilesForUtteranceModal();

  // Reset form state
  document.querySelector('input[name="utteranceAction"][value="existing"]').checked = true;
  document.getElementById('utteranceExistingProfile').disabled = false;
  document.getElementById('utteranceNewProfileInputs').style.display = 'none';
  document.getElementById('utteranceNewName').value = '';
  document.getElementById('utteranceNewRole').value = '';

  // Hide any previous errors
  hideInlineError();

  // Hide success overlay (in case it was left visible)
  const successOverlay = document.getElementById('utteranceSuccessOverlay');
  if (successOverlay) successOverlay.style.display = 'none';

  // Show modal
  document.getElementById('utteranceProfileModal').style.display = 'flex';
}

/**
 * Load profiles list for dropdown
 */
async function loadProfilesForUtteranceModal() {
  try {
    const profiles = await ipcRenderer.invoke('get-voice-profiles');
    const select = document.getElementById('utteranceExistingProfile');

    select.innerHTML = '<option value="">Profil wählen...</option>';
    if (profiles && profiles.length > 0) {
      profiles.forEach(p => {
        // Handle both old English values and new German values
        const roleMap = { 'dentist': 'Zahnarzt', 'assistant': 'Assistenz', 'Arzt': 'Zahnarzt', 'ZFA': 'Assistenz' };
        const roleLabel = roleMap[p.role] || p.role;
        select.innerHTML += `<option value="${p.id}">${p.name} (${roleLabel})</option>`;
      });
    }
  } catch (err) {
    console.error('[Utterance Modal] Failed to load profiles:', err);
  }
}

/**
 * Close the utterance profile modal
 */
function closeUtteranceProfileModal() {
  // Stop any playing audio
  const audio = document.getElementById('utterancePreviewAudio');
  if (audio && !audio.paused) {
    audio.pause();
  }
  updatePlayButton(false);

  document.getElementById('utteranceProfileModal').style.display = 'none';
  utteranceModalData = null;
}

/**
 * Show success overlay with message, then close modal
 * @param {string} profileName - Name of the profile that was updated
 * @param {boolean} isNew - Whether this was a new profile
 * @returns {Promise} - Resolves when animation completes
 */
function showUtteranceSuccess(profileName, isNew) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('utteranceSuccessOverlay');
    const title = document.getElementById('utteranceSuccessTitle');
    const message = document.getElementById('utteranceSuccessMessage');

    if (!overlay) {
      resolve();
      return;
    }

    // Set success message
    if (isNew) {
      title.textContent = 'Profil erstellt!';
      message.textContent = `"${profileName}" wurde angelegt`;
    } else {
      title.textContent = 'Stimme hinzugefügt!';
      message.textContent = `"${profileName}" aktualisiert`;
    }

    // Show overlay
    overlay.style.display = 'flex';

    // Close after delay
    setTimeout(() => {
      overlay.style.display = 'none';
      closeUtteranceProfileModal();
      resolve();
    }, 1500);
  });
}

/**
 * Show similarity warning modal
 * @param {number} similarity - Similarity score (0-1)
 * @param {string} profileName - Name of the profile
 * @returns {Promise<boolean>} - Whether user confirmed
 */
function showUtteranceSimilarityWarning(similarity, profileName) {
  return new Promise((resolve) => {
    similarityResolve = resolve;

    // Update modal content
    const pct = Math.round(similarity * 100);
    document.getElementById('similarityBadge').textContent = `${pct}%`;
    document.getElementById('similarityProfileName').textContent = profileName;

    // Show modal
    document.getElementById('similarityWarningModal').style.display = 'flex';
  });
}

/**
 * Close similarity warning modal
 * @param {boolean} confirmed - Whether user confirmed
 */
function closeSimilarityWarningModal(confirmed) {
  document.getElementById('similarityWarningModal').style.display = 'none';
  if (similarityResolve) {
    similarityResolve(confirmed);
    similarityResolve = null;
  }
}

module.exports = {
  init,
  openUtteranceProfileModal,
  closeUtteranceProfileModal,
};
