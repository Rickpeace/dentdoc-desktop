# Support Chat - tawk.to Integration

> Dokumentation für den integrierten Live-Support-Chat

## Übersicht

Die App enthält einen integrierten tawk.to Live-Chat für Kundensupport:

```
┌─────────────────────────────────────────────┐
│  DentDoc Dashboard                          │
├──────┬──────────────────────────────────────┤
│      │                              ┌──────┐│
│ Menu │   Content                    │tawk  ││
│      │                              │Chat  ││
│ Live │                              │Popup ││
│ Chat │                              └──────┘│
│  [2] │                           [FAB btn] │
└──────┴──────────────────────────────────────┘
```

### Zugriffspunkte

| Element | Location | Funktion |
|---------|----------|----------|
| **FAB Button** | Unten rechts (fixed) | Toggle Chat öffnen/schließen |
| **Menü Button** | Sidebar "Live Chat" | Toggle Chat öffnen/schließen |
| **Badge** | Beide Buttons | Zeigt ungelesene Nachrichten |

---

## Technische Umsetzung

### Warum WebView statt Embed-Script?

Das native tawk.to Embed-Script funktioniert **nicht** in Electron:

```
❌ Embed-Script → 400 Error (file:// Origin wird blockiert)
✅ WebView + Chat-URL → Funktioniert einwandfrei
```

### tawk.to Konfiguration

```javascript
// IDs (aus tawk.to Dashboard)
Property ID: '697dbe56926cbc1c35c8371a'
Widget ID: '1jg9iv0fk'

// Direkte Chat-URL
https://tawk.to/chat/697dbe56926cbc1c35c8371a/1jg9iv0fk
```

---

## Dateien

| Datei | Inhalt |
|-------|--------|
| `src/dashboard.html` | WebView, FAB Button, Menü-Eintrag |
| `src/styles/dashboard.css` | Styling für FAB, Popup, Badges |
| `src/scripts/dashboard.js` | Toggle-Logik, User-Daten Injection, Nachrichten-Erkennung |
| `main.js` | `webviewTag: true`, IPC Handler für Support-Context |

---

## User-Daten an tawk.to

Der Support sieht automatisch Kontext zum eingeloggten User:

### Übertragene Daten

```javascript
// User Info
name: 'Dr. Max Mustermann'
email: 'max@praxis.de'
userId: 'user_abc123'

// App Info
appVersion: '1.6.13'
platform: 'Windows'

// Subscription
planTier: 'pro'              // free_trial, pro, etc.
subscriptionStatus: 'active' // active, canceled, etc.
minutesRemaining: 45         // Trial-Minuten
maxDevices: 3

// Settings
shortcut: 'F9'
theme: 'dark'
vadEnabled: 'Ja'
microphoneName: 'Blue Yeti'
microphoneSource: 'desktop'  // desktop, iphone

// Stats
todayRecordings: 5
lastDocumentation: '2026-02-01T14:30:00Z'

// Debugging
lastError: 'Recording error: Microphone not found'
```

### Implementierung (dashboard.js)

```javascript
// WebView Setup
<webview
  id="tawkWebview"
  src="https://tawk.to/chat/..."
  partition="persist:tawk"
  class="support-iframe"
/>

// Nach Load: User-Daten injizieren
webview.addEventListener('did-finish-load', () => {
  webview.executeJavaScript(`
    Tawk_API.setAttributes({
      name: '${userData.name}',
      email: '${userData.email}',
      // ... weitere Felder
    });
  `);
});
```

### IPC Handler (main.js)

```javascript
// Support-Context für tawk.to
ipcMain.handle('get-support-context', () => {
  return {
    shortcut: store.get('shortcut', 'F9'),
    theme: store.get('theme', 'dark'),
    vadEnabled: store.get('vadEnabled', true),
    microphoneName: store.get('microphoneName', 'Default'),
    todayRecordings: store.get('todayRecordings', { count: 0 }).count,
    lastDocumentation: store.get('lastDocumentationTime', null),
    lastError: lastErrorMessage,  // Letzter console.error
    // ...
  };
});
```

---

## Nachrichten-Benachrichtigung

### Wie es funktioniert

```
1. Agent sendet Nachricht
   ↓
2. Tawk_API.onChatMessageAgent wird getriggert
   ↓
3. WebView sendet console.log('DENTDOC_TAWK_NEW_MESSAGE')
   ↓
4. Parent hört auf 'console-message' Event
   ↓
5. Badge-Counter wird erhöht + FAB pulsiert
```

### Code (dashboard.js)

```javascript
// Im WebView injiziert:
Tawk_API.onChatMessageAgent = function(message) {
  console.log('DENTDOC_TAWK_NEW_MESSAGE');
};

// Im Parent:
webview.addEventListener('console-message', (e) => {
  if (e.message === 'DENTDOC_TAWK_NEW_MESSAGE') {
    // Badge aktualisieren
    unreadChatMessages++;
    badge.textContent = unreadChatMessages.toString();
    badge.style.display = 'flex';
    fab.classList.add('has-message');
  }
});
```

---

## CSS Klassen

### FAB Button

```css
.support-fab              /* Basis-Style */
.support-fab.active       /* Chat ist offen */
.support-fab.has-message  /* Neue Nachricht (pulsiert) */
.fab-badge                /* Zähler-Badge auf FAB */
```

### Menü Button

```css
.nav-item-livechat        /* Basis-Style */
.nav-item-livechat.chat-open  /* Chat ist offen (grün) */
.chat-badge               /* Zähler-Badge im Menü */
```

### Popup

```css
.support-modal-overlay    /* Container */
.support-modal-overlay.active  /* Sichtbar */
.support-modal            /* Das eigentliche Popup */
.support-iframe           /* WebView im Popup */
```

---

## Datenschutz

### Erlaubte Daten (an tawk.to)

- Name, Email, User-ID
- App-Version, Platform
- Abo-Status, Plan
- Einstellungen (nicht-sensitiv)
- Letzte Fehlermeldung

### Verbotene Daten

- Patientennamen
- Transkripte
- Medizinische Inhalte
- Gesprächsinhalte
- Vollständige Logs

---

## Troubleshooting

### Chat lädt nicht

1. Prüfen: `webviewTag: true` in main.js webPreferences?
2. Prüfen: Internet-Verbindung?
3. DevTools öffnen → WebView inspizieren

### User-Daten erscheinen nicht im tawk.to Dashboard

1. Prüfen: `did-finish-load` Event wird getriggert?
2. Prüfen: `Tawk_API.setAttributes` wird aufgerufen?
3. Im tawk.to Dashboard: Visitor Details aktiviert?

### Nachrichten-Badge aktualisiert nicht

1. Prüfen: `console-message` Event wird empfangen?
2. Prüfen: Chat-Panel ist geschlossen während Nachricht kommt?
