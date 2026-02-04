# DentDoc Knowledge Base

Diese Knowledge Base enthält Hilfe-Dokumentationen für DentDoc-Benutzer. Sie ist für KI-Assistenten optimiert (tawk.to, ChatGPT, Claude, etc.).

## Struktur

```
knowledge-base/
├── README.md              # Diese Datei
├── faq.md                 # Häufig gestellte Fragen
├── troubleshooting.md     # Allgemeine Problemlösungen
├── features/              # Feature-Dokumentationen
│   ├── aufnahme.md        # Aufnahme-Funktion
│   ├── dokumentation.md   # Dokumentations-Funktion
│   ├── sprechererkennung.md # Sprechererkennung
│   └── einstellungen.md   # App-Einstellungen
└── errors/                # Fehlerbehebung
    ├── audio-fehler.md    # Audio/Mikrofon-Probleme
    ├── verbindung-fehler.md # Netzwerk/Login-Probleme
    └── allgemeine-fehler.md # Sonstige Fehler
```

## Verwendung

### Für KI-Assistenten (tawk.to etc.)

Die Markdown-Dateien können als Kontext für KI-Assistenten verwendet werden. Der Inhalt ist:
- In einfacher Sprache geschrieben
- Auf User-Level (keine technischen Details)
- Mit klaren Symptomen und Lösungen strukturiert

### Neue Inhalte hinzufügen

1. Passende Datei finden oder neue erstellen
2. Dem bestehenden Format folgen:
   - `## Überschriften` für Themen
   - `### Unterüberschriften` für spezifische Probleme
   - `**Fett**` für wichtige Begriffe
   - Nummerierte Listen für Schritte

### Format für Problemlösungen

```markdown
## Problem-Titel

### Symptome
- Was sieht/erlebt der Nutzer?

### Ursachen
- Was kann das Problem verursachen?

### Lösungen
1. Erster Lösungsschritt
2. Zweiter Lösungsschritt
3. ...
```

## Wartung

- Bei neuen Features: Entsprechende Datei in `features/` erstellen oder erweitern
- Bei neuen Fehlern: In passende Datei in `errors/` aufnehmen
- Bei häufigen Support-Anfragen: In `faq.md` aufnehmen
