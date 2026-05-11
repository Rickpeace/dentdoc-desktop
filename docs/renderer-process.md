# Renderer Process - UI Komponenten

> Dokumentation für Dashboard, Login, Overlay und Setup-Wizard

## Übersicht

Die App hat mehrere Renderer-Prozesse (BrowserWindows):

| Window | Datei | Beschreibung |
|--------|-------|--------------|
| Dashboard | `dashboard.html` + `dashboard.js` | Hauptfenster mit allen Views |
| Login | `login.html` | Anmelde-Dialog |
| Status Overlay | `status-overlay.html` | Floating Status-Anzeige |
| Notification Popup | `notification-popup.html` | Custom Benachrichtigungen |
| Recorder | `recorder.html` | Hidden Audio-Recorder |

---

## Dashboard (dashboard.html)

### Struktur

Das Dashboard ist ein Single-Page-App mit Tab-Navigation:

```
┌──────────────────────────────────────────────────────┐
│ [Logo] DentDoc          [Theme] [?] [_] [□] [X]     │
├───────────┬──────────────────────────────────────────┤
│           │ ▓▓▓ Upgrade Top Bar (Trial/Expired) ▓▓▓ │
│  Sidebar  ├──────────────────────────────────────────┤
│  Nav      │                                          │
│           │  .views-wrapper (scrollable)             │
│  [Home]   │  ┌──────────────────────────────────┐   │
│  [Archiv] │  │                                  │   │
│  [Stimm]  │  │         Tab-Content              │   │
│  [Einst]  │  │                                  │   │
│  [Abo]    │  └──────────────────────────────────┘   │
│           │                                          │
│  [Status] │                                          │
└───────────┴──────────────────────────────────────────┘
```

**Layout:** `.main-content` ist eine Flex-Column. Der Upgrade Top Bar sitzt oben (flex-shrink: 0), darunter `.views-wrapper` (flex: 1, overflow-y: auto) enthält alle Views.

### Tabs

#### Home Tab
- Onboarding-Card (für neue User, dismissbar)
- Upgrade-Banner (Trial/Expired/Inaktiv — hidden für Abonnenten)
- Stat-Cards: Aufnahmen heute, Stimmprofile, Aktive Arbeitsplätze
- iPhone-Sektion (wenn Smartphone-Mikrofon ausgewählt)
- Letzte Dokumentation

#### Archiv Tab
- Liste aller gespeicherten Transkripte
- Suche und Filter
- Detail-Ansicht mit:
  - Transkript-Text
  - Dokumentation
  - Audio-Wiedergabe
  - Zahnschema (falls vorhanden)

#### Stimmprofile Tab
- Liste registrierter Sprecher
- Profil hinzufügen/bearbeiten/löschen
- Test-Funktion für Erkennung

#### Einstellungen Tab
- Shortcut-Konfiguration
- Theme (Dark/Light)
- Auto-Export Einstellungen
- Pfade für Transkripte/Audio (mit Berechtigungsprüfung)
- Mikrofon-Test
- Mikrofon-Eingangslautstärke (Slider)
- Über/Version

**Auto-Save Einstellungen (ab v1.9.0):**
- Alle Einstellungen speichern sofort bei Änderung via `autoSaveSetting()` Helper
- Kein Speichern/Abbrechen-Dialog, keine Unsaved-Changes-Warnung
- Jede Änderung sendet sofort `ipcRenderer.invoke('save-settings', { key: value })`
- Shortcut-Registrierung mit Fehlerbehandlung: bei Fehlschlag wird UI zurückgesetzt

**Ordner-Validierung:**
- Browse-Buttons verwenden `select-folder-with-validation`
- Bei Fehler: Roter Rahmen + Inline-Fehlermeldung
- Prüft: Lesen, Schreiben, Unterordner erstellen

**Mikrofon-Eingangslautstärke:**
- Slider zeigt/steuert Windows-Eingangslautstärke des ausgewählten Mikrofons
- Dynamischer Füllbalken (orange) via CSS `--fill` Variable
- Wird ausgeblendet wenn kein Mikrofon ausgewählt oder getrennt
- Aktualisiert sich bei `devicechange` Events (USB-Verbindung/Trennung)
- Nach Rückkehr von Windows Sound-Einstellungen wird der Wert neu geladen
- IPC: `get-mic-volume` / `set-mic-volume` (debounced, 150ms)

---

### Dashboard JavaScript (scripts/dashboard.js)

#### Initialisierung

```javascript
document.addEventListener('DOMContentLoaded', async () => {
  // Theme laden
  const theme = await ipcRenderer.invoke('get-theme');
  document.body.classList.toggle('light-theme', theme === 'light');

  // Tab-Navigation
  initTabNavigation();

  // Audio-Level Updates
  ipcRenderer.on('audio-level', (e, level) => {
    updateAudioMeter(level);
  });

  // Status-Updates
  ipcRenderer.on('refresh-subscription-status', refreshStatus);
});
```

#### IPC Kommunikation

```javascript
// Settings abrufen
const shortcut = await ipcRenderer.invoke('get-shortcut');
const theme = await ipcRenderer.invoke('get-theme');

// Settings setzen
await ipcRenderer.invoke('set-shortcut', 'F10');
await ipcRenderer.invoke('set-theme', 'light');

// Aufnahme steuern
await ipcRenderer.invoke('toggle-recording');
const state = await ipcRenderer.invoke('get-recording-state');

// Transkripte laden
const transcripts = await ipcRenderer.invoke('get-all-transcripts');
const detail = await ipcRenderer.invoke('get-transcript-detail', filePath);
```

#### Upgrade-Prompts (Trial/Conversion)

Zwei Komponenten zeigen Trial-/Abo-Status und leiten zum Kauf weiter:

**1. Upgrade Top Bar** (`#upgradeTopBar`) — Persistente Leiste über allen Views:
- `loadUpgradeTopBar()` — liest `get-subscription-status` IPC
- Orange (Trial aktiv), Rot (abgelaufen/inaktiv), Hidden (Abonnent)
- Klick auf Link → `openSubscriptionPage()` → Web-Abo-Seite

**2. Upgrade Banner** (`#upgradeBanner`) — Karte auf Übersicht:
- `loadUpgradeBanner()` — aufgerufen in `loadHomeStats()`
- Fortschrittsbalken (X/60 Min), Feature-Highlights, Preis, CTA-Button
- 3 Varianten: `.upgrade-trial` (orange), `.upgrade-expired` (rot), `.upgrade-inactive` (amber)

**Refresh-Events:** Beide aktualisieren sich bei:
- `recording-completed` — nach Aufnahme (Minuten können sich geändert haben)
- `refresh-subscription-status` — bei Window-Focus (z.B. nach Abo-Kauf im Browser)

**Show/Hide Logik:**

| `status.type` | Top Bar | Banner |
|---|---|---|
| `'success'` | Hidden | Hidden |
| `'trial'` | Orange | Orange + Fortschrittsbalken |
| `'error'` | Rot | Rot/Amber |
| `'warning'` | Rot | Amber |

#### View-Wechsel & Mic Test Cleanup

Beim Verlassen der Settings-View wird der Mikrofon-Test gestoppt. **Wichtig:** Dies darf nur passieren, wenn KEINE echte Aufnahme läuft!

```javascript
// In dashboard.js - leaveSettingsView()
async function leaveSettingsView() {
  // ... andere Cleanup-Aufgaben ...

  // WICHTIG: Nur cleanup wenn KEINE echte Aufnahme läuft!
  const recordingState = await ipcRenderer.invoke('get-recording-state').catch(() => ({}));
  if (!recordingState.isRecording && !recordingState.isProcessing) {
    await ipcRenderer.invoke('stop-mic-test').catch(() => {});
    ipcRenderer.invoke('cleanup-mic-test');
  }
  // Ohne diesen Check würde das Öffnen der Settings während
  // einer VAD-Aufnahme die echte Aufnahme löschen!
}
```

**Bug-Fix (v1.6.10):** Vorher wurde `stop-mic-test` immer aufgerufen, auch während echter Aufnahmen. Da Mic-Test und VAD-Aufnahme denselben FFmpeg-Recorder verwenden, wurde die echte Aufnahme gelöscht.

---

## Setup Wizard (scripts/setup-wizard.js)

### Übersicht

Der Einrichtungsassistent führt neue User durch die Konfiguration:

```
Schritt 0: Willkommen
Schritt 1: Mikrofon-Auswahl + Test
Schritt 2: Shortcut-Konfiguration
Schritt 3: Export-Einstellungen (Transkripte + Audio)
Schritt 4: iPhone-Setup (optional)
Schritt 5: DSGVO-Hinweis
Schritt 6: Auto-Close Overlay
Schritt 7: Zusammenfassung
```

> **Hinweis:** KI-Dokumentation Step wurde in v1.9.0 entfernt (nur Agent V2.1 aktiv)

### Klasse: SetupWizard

```javascript
class SetupWizard {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 8; // 0-7
    this.settings = {
      microphoneId: null,
      microphoneSource: 'desktop',
      shortcut: 'F9',
      autoExport: true,
      transcriptPath: ''
    };
    // Hinweis (v1.10.0+): keepAudio wurde entfernt. Audio wird nicht mehr persistent gespeichert.
  }

  // Navigation
  nextStep() { /* ... */ }
  previousStep() { /* ... */ }
  goToStep(index) { /* ... */ }

  // Mikrofon
  async loadMicrophones() { /* ... */ }
  async toggleMicTest() { /* ... */ }
  selectMicrophone(deviceId) { /* ... */ }

  // Shortcut
  startShortcutRecording() { /* ... */ }
  handleShortcutKeydown(e) { /* ... */ }

  // Speichern
  async saveSettings() {
    await ipcRenderer.invoke('save-wizard-settings', this.settings);
  }
}
```

### Mikrofon-Eingangslautstärke (Wizard)

Der Setup-Wizard zeigt ebenfalls den Eingangslautstärke-Slider im Mikrofon-Schritt:
- `loadWizardMicVolume()` — lädt Volume für das im Wizard ausgewählte Mikrofon
- Wird bei `loadMicrophones()` und Dropdown-Änderung aufgerufen
- Gleiche Debounce-Logik (150ms) wie in Settings
- Wird ausgeblendet wenn kein Mikrofon ausgewählt

### Mikrofon-Test

```javascript
async toggleMicTest() {
  if (this.isTesting) {
    await ipcRenderer.invoke('stop-mic-test');
    this.isTesting = false;
  } else {
    await ipcRenderer.invoke('start-mic-test', this.settings.microphone);
    this.isTesting = true;
  }
}
```

### Shortcut-Erfassung

```javascript
startShortcutRecording() {
  this.recordingShortcut = true;
  // UI zeigt "Drücken Sie eine Taste..."
}

handleShortcutKeydown(e) {
  if (!this.recordingShortcut) return;

  e.preventDefault();
  const key = e.key.toUpperCase();
  const modifiers = [];

  if (e.ctrlKey) modifiers.push('Ctrl');
  if (e.shiftKey) modifiers.push('Shift');
  if (e.altKey) modifiers.push('Alt');

  this.settings.shortcut = [...modifiers, key].join('+');
  this.recordingShortcut = false;
}
```

---

## Shared Utilities (scripts/audio-utils.js)

### Übersicht

Gemeinsam genutzte Audio-Funktionen für dashboard.js und setup-wizard.js.

**Import:**
```javascript
// In dashboard.js
const audioUtils = require('./scripts/audio-utils');

// In setup-wizard.js
const wizardAudioUtils = require('./scripts/audio-utils');
```

### Exports

| Export | Typ | Beschreibung |
|--------|-----|--------------|
| `AudioMonitor` | Klasse | Echtzeit Audio-Level Monitoring |
| `MicTester` | Klasse | Mikrofon-Test mit Aufnahme & Wiedergabe |
| `loadMicrophones()` | async function | Mikrofon-Dropdown befüllen (mit smartem Matching) |
| `getSelectedMicrophone()` | function | Ausgewähltes Mikrofon aus Dropdown abrufen |
| `isMicrophoneMatch()` | function | Prüft ob zwei Mic-Namen zusammengehören |
| `isMicrophoneAvailable()` | async function | Prüft ob Mikrofon in Geräteliste verfügbar ist |

### Mikrofon-Matching

Windows benennt USB-Geräte manchmal um (z.B. "Jabra" → "Jabra (2)" nach Reconnect).

Die Funktionen `isMicrophoneMatch()` und `isMicrophoneAvailable()` lösen das Problem:
- Zuerst: Exakter Name-Vergleich
- Falls nicht: Vergleich der Vendor:Product ID (z.B. "046d:0aba")

```javascript
// Beispiel: Mic wurde reconnected mit anderem Namen
const savedMic = "Jabra Link 370 (0b0e:245d)";
const currentMic = "2- Jabra Link 370 (0b0e:245d)";

audioUtils.isMicrophoneMatch(savedMic, currentMic); // true (gleiche Vendor ID)

// Async Check gegen aktuelle Geräteliste
const available = await audioUtils.isMicrophoneAvailable(savedMic); // true
```

### Verwendung

**devicechange Listener (dashboard.js & setup-wizard.js):**
```javascript
navigator.mediaDevices?.addEventListener('devicechange', async () => {
  const settings = await ipcRenderer.invoke('get-settings');
  const micAvailable = await audioUtils.isMicrophoneAvailable(settings?.microphoneName);

  if (micAvailable) {
    // Mikrofon wieder verbunden
  }
});
```

---

## Status Overlay (status-overlay.html)

### Zweck

Floating-Fenster das Aufnahme-Status und Ergebnisse anzeigt.

### Eigenschaften

```javascript
// Window-Eigenschaften (erstellt in main.js)
{
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  focusable: false,  // Kein Fokus-Stealing
  movable: true      // User kann Position ändern
}
```

### Status-Typen

| Type | Anzeige |
|------|---------|
| `starting` | "Aufnahme wird gestartet..." |
| `recording` | Timer + Audio-Level |
| `processing` | Fortschrittsbalken |
| `success` | Dokumentation + Buttons |
| `error` | Fehlermeldung |

### IPC Events

```javascript
// Empfangen
ipcRenderer.on('update-status', (e, data) => {
  // data: { title, message, type, audioLevel, progress, ... }
  updateDisplay(data);
});

// Senden
ipcRenderer.send('close-status-overlay');
ipcRenderer.send('overlay:resize', { width, height });
ipcRenderer.send('overlay:set-ignore-mouse', true);
```

### Dynamische Größenanpassung

```javascript
function resizeToContent() {
  const height = document.body.scrollHeight;
  const width = document.body.scrollWidth;
  ipcRenderer.send('overlay:resize', { width, height });
}

// Nach Content-Änderung aufrufen
new MutationObserver(resizeToContent).observe(document.body, {
  childList: true,
  subtree: true
});
```

---

## Login Window (login.html)

### Struktur

```html
<div class="login-container">
  <img src="logo.png" class="logo">
  <h1>DentDoc</h1>

  <form id="loginForm">
    <input type="email" id="email" required>
    <input type="password" id="password" required>
    <button type="submit">Anmelden</button>
  </form>

  <a href="#" id="forgotPassword">Passwort vergessen?</a>
  <a href="#" id="register">Registrieren</a>
</div>
```

### Login-Flow

```javascript
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const result = await ipcRenderer.invoke('login', email, password);
    // Window wird automatisch geschlossen bei Erfolg
  } catch (error) {
    showError(error.message);
  }
};
```

### Registrierung

Öffnet Web-Browser zur Registration auf dentdoc.de:

```javascript
document.getElementById('register').onclick = () => {
  ipcRenderer.invoke('open-external-url', 'https://dentdoc.de/register');
};
```

---

## Notification Popup (notification-popup.html)

### Zweck

Custom Benachrichtigungen mit Klick-Aktionen (statt native OS Notifications).

### Struktur

```html
<div class="notification" data-type="warning">
  <div class="icon">⚠️</div>
  <div class="content">
    <h3 class="title">Titel</h3>
    <p class="body">Nachricht</p>
  </div>
  <button class="close">×</button>
</div>
```

### IPC Events

```javascript
// Empfangen
ipcRenderer.on('show-notification', (e, data) => {
  // data: { title, body, type, hasClickAction }
  document.querySelector('.title').textContent = data.title;
  document.querySelector('.body').textContent = data.body;
  document.querySelector('.notification').dataset.type = data.type;
});

// Senden
document.querySelector('.notification').onclick = () => {
  ipcRenderer.send('notification-popup-clicked');
};

document.querySelector('.close').onclick = () => {
  ipcRenderer.send('close-notification-popup');
};
```

---

## Tooth Chart (scripts/tooth-chart.js)

### Übersicht

Interaktives Zahnschema zur Anzeige von Befunden.

### Klasse: ToothChart

```javascript
class ToothChart {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.selectedTeeth = new Set();
  }

  // Zähne markieren
  highlightTeeth(toothNumbers, color) { /* ... */ }

  // Befunde anzeigen
  showFindings(findings) {
    // findings: [{ tooth: 26, finding: 'Karies', type: 'diagnosis' }]
  }

  // Interaktion
  onToothClick(callback) { /* ... */ }
}
```

### FDI Zahnschema

```
       18 17 16 15 14 13 12 11 | 21 22 23 24 25 26 27 28
       ─────────────────────────────────────────────────
       48 47 46 45 44 43 42 41 | 31 32 33 34 35 36 37 38
```

---

## Transcript Modal (scripts/transcript-modal.js)

### Übersicht

Vollständige Transkript-Detailansicht als Modal-Dialog im Archiv-Tab.

### Features

| Feature | Beschreibung |
|---------|--------------|
| Audio-Player | Play/Pause, Waveform-Visualisierung, Geschwindigkeit (1x-2x), Seekbar |
| Utterances | Sprecher-Avatare, klickbare Zeitstempel, Word-Level Highlighting |
| Topic Tags | Themen-Extraktion mit klickbaren Audio-Passagen |
| Suche | Fuzzy-Matching mit Prev/Next Navigation (Enter/Shift+Enter) |
| Befund-Tab | 01-Status Zahnschema anzeigen, JSON kopieren (01 + PA) |
| Doc-Versionen | Umschalten zwischen Dokumentation, KZV, Z-Dokumentation |
| Passage Links | Klickbare Links in Dokumentation → Audio-Stellen |
| Profil-Zuordnung | "Zu Stimmprofil hinzufügen" Button pro Utterance |

### Exports

```javascript
module.exports = {
  openTranscriptModal,    // Modal öffnen mit filePath
  closeTranscriptModal,   // Modal schließen
  initTranscriptModal,    // Event-Listener initialisieren
  getCurrentTranscriptData // Aktuelle Transkript-Daten abrufen
};
```

### Audio-Wiedergabe

- **Audio-Playback entfernt (v1.10.0+):** `setupAudioPlayer`, `playSegment`, `jumpToTime`, `updatePlayingUtterance` sind seit DSGVO-Härtung No-Op-Stubs. Audio existiert nach Pipeline-Ende nicht mehr, daher gibt's auch nichts mehr abzuspielen.

### IPC Aufrufe

- `get-transcript-detail` — Transkript laden
- `copy-to-clipboard` — JSON kopieren
- `open-tooth-chart` — Zahnschema öffnen

> `get-transcript-audio` wurde in v1.10.0 entfernt.

---

## Utterance Profile Modal (utterance-profile-modal.js)

### Übersicht

Modal zum Hinzufügen von Transkript-Utterances zu Stimmprofilen. Wird aus `transcript-modal.js` aufgerufen.

### Funktionen

- **Existierendes Profil**: Dropdown mit allen gespeicherten Profilen
- **Neues Profil**: Name + Rolle (Zahnarzt/Assistenz) eingeben
- **Similarity-Warnung**: Warnung wenn Stimme dem Profil nicht ähnlich genug ist (mit Force-Option)
- **Erfolgs-Overlay**: Animierte Bestätigung nach erfolgreichem Hinzufügen

> **Audio-Vorschau entfernt (v1.10.0+)**: Der Play-Button für Utterance-Ausschnitte sowie `handlePlayClick` wurden im Zuge der DSGVO-Härtung entfernt.

### Exports

```javascript
module.exports = {
  init,                        // Initialisierung mit { ipcRenderer }
  openUtteranceProfileModal,   // Modal öffnen mit { audioPath, startMs, endMs, speakerLabel, text }
  closeUtteranceProfileModal   // Modal schließen
};
```

### IPC Aufrufe

- `get-voice-profiles` — Profile für Dropdown laden
- `add-utterance-to-profile` — Utterance zu Profil hinzufügen

---

## Theming

### CSS Variablen

```css
:root {
  /* Dark Theme (default) */
  --bg-primary: #0a0a0b;
  --bg-secondary: #1a1a1b;
  --text-primary: #ffffff;
  --text-secondary: #a0a0a0;
  --accent: #3b82f6;
  --accent-hover: #2563eb;
  --border: #333333;
  --error: #ef4444;
  --success: #22c55e;
  --warning: #f59e0b;
}

.light-theme {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --border: #e0e0e0;
}
```

### Theme-Wechsel

```javascript
// In dashboard.js
async function toggleTheme() {
  const current = await ipcRenderer.invoke('get-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  await ipcRenderer.invoke('set-theme', newTheme);
  document.body.classList.toggle('light-theme', newTheme === 'light');
}
```

---

## Siehe auch

- [ARCHITECTURE.md](ARCHITECTURE.md) - Hauptübersicht
- [main-process.md](main-process.md) - IPC Handler Details
- [data-storage.md](data-storage.md) - Einstellungen
