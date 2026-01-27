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
├──────────────────────────────────────────────────────┤
│                                                      │
│  [Home] [Archiv] [Stimmprofile] [Einstellungen]     │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │                                              │   │
│  │            Tab-Content                       │   │
│  │                                              │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Tabs

#### Home Tab
- Aufnahme-Button (F9)
- Echtzeit-Audio-Pegel
- Mikrofon-Auswahl
- Quick-Access zu Einstellungen

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
- Pfade für Transkripte/Audio
- Mikrofon-Test
- Über/Version

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
Schritt 1: Willkommen
Schritt 2: Mikrofon-Auswahl + Test
Schritt 3: Shortcut-Konfiguration
Schritt 4: Export-Einstellungen
Schritt 5: DSGVO-Hinweis
Schritt 6: Zusammenfassung
```

### Klasse: SetupWizard

```javascript
class SetupWizard {
  constructor() {
    this.currentStep = 0;
    this.totalSteps = 6;
    this.settings = {
      microphone: null,
      shortcut: 'F9',
      autoExport: false,
      transcriptSavePath: '',
      keepAudio: false,
      audioSavePath: '',
      dsgvoAccepted: false
    };
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

Öffnet Web-Browser zur Registration auf dentdoc-app.vercel.app:

```javascript
document.getElementById('register').onclick = () => {
  ipcRenderer.invoke('open-external-url', 'https://dentdoc-app.vercel.app/register');
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
