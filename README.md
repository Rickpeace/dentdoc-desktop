# DentDoc Desktop App

Windows Desktop-Anwendung für automatische Dokumentation in Zahnarztpraxen.

## Features

- **System Tray Integration**: App läuft im Hintergrund und ist jederzeit über das System Tray verfügbar
- **Globale Tastenkombination**: F9 zum Starten/Stoppen der Aufnahme von überall
- **Automatischer Start**: Startet automatisch mit Windows
- **One-Click Workflow**: Aufnehmen → Transkribieren → Dokumentation in Zwischenablage kopieren
- **Single Instance**: Verhindert mehrfaches Starten der App
- **Benachrichtigungen**: Statusmeldungen für alle Aktionen

## Voraussetzungen

- Windows 10 oder höher
- Node.js 16 oder höher
- npm oder pnpm
- Mikrofon für Audioaufnahmen

## Installation für Entwicklung

1. Abhängigkeiten installieren:
```bash
npm install
# oder
pnpm install
```

2. API-URL konfigurieren:
   - Kopiere `.env.example` zu `.env`
   - Setze `API_URL` auf deine deployed Vercel URL:
   ```
   API_URL=https://your-dentdoc-app.vercel.app
   ```

3. Icons erstellen (siehe `assets/ICONS-NEEDED.txt`):
   - `assets/icon.png` - Haupt-Icon
   - `assets/icon.ico` - Windows Icon
   - `assets/tray-icon.png` - System Tray (normal)
   - `assets/tray-icon-recording.png` - System Tray (aufnahme)

4. App starten:
```bash
npm start
```

## Produktions-Build erstellen

Installer für Windows erstellen:

```bash
npm run build:win
```

Der Installer wird in `dist/` erstellt.

## Verwendung

### Erste Schritte

1. **Anmeldung**:
   - Beim ersten Start öffnet sich das Login-Fenster
   - Melde dich mit deinen DentDoc-Zugangsdaten an
   - Die gleichen Credentials wie in der Web-App

2. **System Tray**:
   - Nach dem Login erscheint das DentDoc-Icon im System Tray (unten rechts)
   - Rechtsklick auf das Icon zeigt das Menü mit:
     - Verbleibende Minuten
     - Aufnahme starten/stoppen
     - Dashboard öffnen
     - Abmelden
     - Beenden

### Aufnahme starten

**Methode 1 - Tastenkombination (empfohlen):**
- Drücke **F9** von überall aus Windows
- Die Aufnahme startet sofort
- Tray-Icon ändert sich zu Aufnahme-Status
- Benachrichtigung erscheint

**Methode 2 - System Tray:**
- Rechtsklick auf DentDoc-Icon
- "Aufnahme starten" auswählen

### Aufnahme stoppen & Dokumentation erhalten

1. **F9** erneut drücken oder "Aufnahme stoppen" im Tray-Menü wählen
2. Die App:
   - Stoppt die Aufnahme
   - Lädt das Audio zur API hoch
   - Transkribiert und erstellt Dokumentation
   - Kopiert die Dokumentation **automatisch in die Zwischenablage**
3. **Einfach Strg+V drücken** um die Dokumentation einzufügen!

### Workflow-Beispiel

```
1. Zahnarzt drückt F9 vor der Behandlung
   → "Aufnahme gestartet" Benachrichtigung

2. Behandlung findet statt, Zahnarzt spricht...

3. Nach der Behandlung: F9 drücken
   → "Aufnahme gestoppt - Verarbeite Audio..."
   → "Transkription läuft..."
   → "Fertig! Dokumentation in Zwischenablage"

4. Im Patienten-System: Strg+V
   → Dokumentation ist eingefügt!
```

## Konfiguration

### API-Endpunkt ändern

In `src/apiClient.js` Zeile 6 oder über Umgebungsvariable:

```javascript
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';
```

Produktions-URL setzen:
```bash
set API_URL=https://your-dentdoc-app.vercel.app
npm start
```

### Auto-Start deaktivieren

Momentan ist Auto-Start hartcodiert aktiviert. Um zu deaktivieren, in `main.js` Zeile 20-23 auskommentieren:

```javascript
// app.setLoginItemSettings({
//   openAtLogin: true,
//   path: app.getPath('exe')
// });
```

### Tastenkombination ändern

In `main.js` Zeile 223 die Tastenkombination anpassen:

```javascript
const registered = globalShortcut.register('F9', () => {
  // ...
});
```

Mögliche Alternativen: `'F10'`, `'CommandOrControl+Shift+R'`, etc.

## Architektur

### Projekt-Struktur

```
dentdoc-desktop/
├── main.js                 # Hauptprozess - Electron entry point
├── package.json            # Dependencies & Build-Konfiguration
├── assets/                 # Icons und Ressourcen
│   ├── icon.png
│   ├── icon.ico
│   ├── tray-icon.png
│   └── tray-icon-recording.png
└── src/
    ├── login.html         # Login-Fenster UI
    ├── audioRecorder.js   # Audio-Aufnahme Modul
    └── apiClient.js       # Backend API Client
```

### Komponenten

**main.js**:
- Electron Hauptprozess
- System Tray Management
- Globale Shortcuts (F9)
- Auto-Launch Konfiguration
- Workflow-Orchestrierung
- IPC Handler für Login

**audioRecorder.js**:
- Nutzt `node-record-lpcm16` für Audio-Aufnahme
- Aufnahme als WAV (16kHz, Mono)
- Temporäre Dateispeicherung

**apiClient.js**:
- Axios-basierte API-Kommunikation
- Endpunkte:
  - `POST /api/auth/login` - Authentifizierung
  - `GET /api/user` - Benutzerdaten abrufen
  - `POST /api/transcriptions/upload` - Audio hochladen
  - `GET /api/transcriptions/:id/generate-doc` - Dokumentation abrufen

**login.html**:
- Renderer-Prozess für Login
- IPC-Kommunikation mit Hauptprozess
- Deutsches UI mit Orange-Branding

## API-Integration

Die Desktop-App nutzt die gleiche Backend-API wie die Web-App:

- **Authentifizierung**: Token-basiert mit Cookie-Session
- **Gemeinsame Datenbank**: Gleiche User, Subscriptions, Minuten
- **Parallel nutzbar**: Web-App und Desktop-App gleichzeitig verwendbar

## Troubleshooting

### "Aufnahme konnte nicht gestartet werden"

**Problem**: Mikrofon-Zugriff verweigert oder kein Mikrofon gefunden

**Lösung**:
1. Windows-Einstellungen → Datenschutz → Mikrofon
2. "Apps Zugriff auf Mikrofon erlauben" aktivieren
3. Mikrofon anschließen und als Standard setzen
4. App neu starten

### "Login fehlgeschlagen"

**Problem**: API nicht erreichbar oder falsche Credentials

**Lösung**:
1. Prüfe Internetverbindung
2. Verifiziere API_URL ist korrekt gesetzt
3. Teste Login in Web-App mit gleichen Credentials
4. Prüfe Browser Developer Console für API-Errors

### "F9 funktioniert nicht"

**Problem**: Shortcut bereits von anderer App belegt

**Lösung**:
1. Andere Apps schließen (besonders Gaming-Software, Screen Recorder)
2. In `main.js` alternative Taste konfigurieren (z.B. F10)
3. App neu starten

### "Dokumentation nicht in Zwischenablage"

**Problem**: Transkription/Dokumentation fehlgeschlagen

**Lösung**:
1. Prüfe verbleibende Minuten im Tray-Menü
2. Prüfe Mikrofonqualität (klare Aufnahme?)
3. Mindestens 3-5 Sekunden sprechen
4. API-Logs prüfen für Fehler

### App startet nicht automatisch

**Problem**: Auto-Launch Einstellung nicht aktiviert

**Lösung**:
1. Windows Task-Manager → Autostart-Tab öffnen
2. Prüfe ob "DentDoc" aufgelistet ist
3. Falls nicht: App neu installieren mit Installer
4. Manuell testen: `main.js` Zeile 20-23 prüfen

## Sicherheit

- **Token-Speicherung**: Lokal in verschlüsseltem electron-store
- **Kein Passwort-Caching**: Passwort wird nicht gespeichert
- **HTTPS**: Alle API-Calls über HTTPS (Produktion)
- **Audio-Dateien**: Temporär gespeichert, werden nach Upload gelöscht

## Lizenz

MIT

## Support

Bei Problemen oder Fragen:
- GitHub Issues: [Repository URL]
- Email: support@dentdoc.de
