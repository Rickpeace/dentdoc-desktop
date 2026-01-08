# DentDoc Agent-Kette Roadmap

## WICHTIG: Grundprinzipien (nicht ändern!)

### 1. Zwei parallele Wege - BEIDE bleiben erhalten!
- **Single Prompt** (aktuell, DEFAULT) - Ein GPT-5 Aufruf für alles
- **Agent-Kette** (neu, OPTIONAL) - Kategorie-Erkennung + Standard-Bausteine + Abweichungs-Erkennung

**Die alte Implementation wird NICHT verändert!** Der neue Weg ist ein separater Code-Pfad.

### 2. Kern-Logik der Bausteine (IMMER TRUE!)
Die Standard-Aufklärungs-Bausteine sind **IMMER "true"** - sie werden IMMER eingefügt wenn die Kategorie erkannt wurde.

Die KI prüft **NICHT** ob aufgeklärt wurde. Sie prüft **NUR**:
- Wurde etwas **ANDERES** gesagt als im Baustein?
- Wurde etwas **ZUSÄTZLICHES** gesagt?

Wenn ja → Baustein anpassen/erweitern
Wenn nein → Baustein bleibt unverändert

**Beispiel:**
- Baustein: "Patient wurde über Kosten, Zuzahlungen und Alternativen aufgeklärt."
- Arzt sagt: "Das kostet ca. 120€ Eigenanteil"
- Ergebnis: "Patient wurde über Kosten, Zuzahlungen und Alternativen aufgeklärt. Es wurde ein Eigenanteil von ca. 120€ genannt."

### 3. Praxis-spezifische Bausteine
- Jede Praxis kann eigene Bausteine als **Freitext** definieren
- Solange keine eigenen definiert sind, werden **Default-Templates** verwendet
- Die Bausteine sind das "Vokabular" der KI - sie nutzt diese Formulierungen

---

## Implementierungs-Schritte

### Phase 1: Grundstruktur [COMPLETED]
- [x] Roadmap-Datei erstellen (diese Datei)
- [x] Settings-Toggle: "Dokumentations-Modus" (single/agent-chain)
- [x] Tray-Menü: "Bausteine" Eintrag hinzufügen
- [x] Bausteine-Fenster (HTML) erstellen
- [x] Store für Bausteine (electron-store)

### Phase 2: Default-Templates [COMPLETED]
- [x] Default-Bausteine definieren (src/bausteine/defaults.js):
  - [x] FUELLUNG (Füllungstherapie)
  - [x] ZE_BERATUNG (Zahnersatz-Beratung)
  - [x] EXTRAKTION (Zahnentfernung)
  - [x] PZR (Professionelle Zahnreinigung)
  - [x] KONTROLLE (Kontrolluntersuchung)
  - [x] WKB (Wurzelkanalbehandlung)
  - [x] PA (Parodontitis-Behandlung)
  - [x] SCHMERZBEHANDLUNG (Akute Beschwerden)
- [x] JSON-Schema für Bausteine

### Phase 3: Backend API (SEPARATER ENDPOINT!) [COMPLETED]
- [x] Neuer Endpoint: `/api/transcriptions/[id]/generate-doc-v2`
  - Der alte `/generate-doc` bleibt UNVERÄNDERT!
- [x] Agent 1: Kategorie-Erkennung (welche Behandlungen im Gespräch?)
- [x] Agent 2: Gesprächs-Fließtext (was Patient erzählt - immer frei formuliert)
- [x] Agent 3: Abweichungs-Erkennung pro Kategorie
- [x] Merge-Logik: Fließtext + Bausteine (mit Abweichungen)

### Phase 4: Desktop Integration [COMPLETED]
- [x] docMode aus Settings lesen
- [x] Bei "agent-chain":
  - Bausteine an API übergeben
  - Neuen Endpoint aufrufen
- [x] Bei "single":
  - Altes Verhalten (wie bisher)
- [x] Status-Overlay: Zeigt "Agent-Kette analysiert Kategorien..." an

### Phase 5: UI für Bausteine-Verwaltung [COMPLETED]
- [x] Bausteine-Editor (Freitext pro Kategorie)
- [x] Import/Export von Bausteinen (für Praxis-übergreifende Nutzung)
- [x] "Zurücksetzen auf Standard" Button pro Kategorie

---

## Datei-Struktur

```
dentdoc-desktop/
├── src/
│   ├── bausteine/
│   │   ├── index.js          # Bausteine-Verwaltung (Load/Save)
│   │   ├── defaults.js       # Vordefinierte Default-Templates
│   │   └── bausteine.html    # UI für Bausteine-Editor
│   └── ...
├── ROADMAP_AGENT_CHAIN.md    # Diese Datei
└── ...

saas-starter/
├── app/api/transcriptions/[id]/
│   ├── generate-doc/route.ts      # UNVERÄNDERT! (Single Prompt)
│   └── generate-doc-v2/route.ts   # NEU (Agent-Kette)
└── ...
```

---

## Bausteine-Schema (JSON)

```json
{
  "FUELLUNG": {
    "name": "Füllungstherapie",
    "standardText": "Patient wurde über Kosten, Zuzahlungen, Materialalternativen (Kunststoff, Keramik, Amalgam) sowie Risiken der Füllungstherapie aufgeklärt.",
    "keywords": ["füllung", "karies", "loch", "kunststoff", "amalgam", "keramik", "komposit"]
  },
  "ZE_BERATUNG": {
    "name": "Zahnersatz-Beratung",
    "standardText": "Patient wurde über Versorgungsalternativen, Festzuschuss-Systematik und mögliche Eigenanteile aufgeklärt.",
    "keywords": ["zahnersatz", "krone", "brücke", "prothese", "implantat", "festzuschuss"]
  },
  "EXTRAKTION": {
    "name": "Zahnentfernung",
    "standardText": "Patient wurde über Risiken (Nachblutung, Schwellung, Nervschädigung), Verhaltenshinweise und Alternativen zur Extraktion aufgeklärt.",
    "keywords": ["extraktion", "ziehen", "entfernen", "zahn raus"]
  },
  "PZR": {
    "name": "Professionelle Zahnreinigung",
    "standardText": "Patient wurde über Ablauf, Kosten und Nutzen der professionellen Zahnreinigung aufgeklärt.",
    "keywords": ["pzr", "zahnreinigung", "prophylaxe", "reinigung"]
  },
  "WKB": {
    "name": "Wurzelkanalbehandlung",
    "standardText": "Patient wurde über Ablauf, Risiken, Erfolgsaussichten und Alternativen der Wurzelkanalbehandlung aufgeklärt.",
    "keywords": ["wurzelbehandlung", "wurzelkanal", "wkb", "endo", "nerv"]
  },
  "KONTROLLE": {
    "name": "Kontrolluntersuchung",
    "standardText": "Kontrolluntersuchung durchgeführt.",
    "keywords": ["kontrolle", "check", "nachschauen", "kontrolltermin"]
  }
}
```

---

## Agent-Flow (Technisch)

```
Gespräch-Transkript
       ↓
[Agent 1: Kategorie-Erkennung]
       ↓
Erkannte Kategorien: ["FUELLUNG", "ZE_BERATUNG"]
       ↓
[Agent 2: Fließtext-Generator] ──────────────────────┐
       ↓                                              │
"Patient berichtet über Schmerzen                     │
 regio 26 seit einer Woche..."                        │
       ↓                                              │
[Agent 3a: Abweichungs-Check FUELLUNG]               │
       ↓                                              │
Standard-Baustein + Abweichungen                      │
       ↓                                              │
[Agent 3b: Abweichungs-Check ZE_BERATUNG]            │
       ↓                                              │
Standard-Baustein + Abweichungen                      │
       ↓                                              │
[MERGE]  ←────────────────────────────────────────────┘
       ↓
Finale Dokumentation:
- Fließtext (was Patient erzählt)
- Behandlungs-Dokumentation mit Bausteinen
```

---

## API-Aufruf (Desktop → Backend)

```javascript
// Bei docMode === 'single' (UNCHANGED!)
POST /api/transcriptions/{id}/generate-doc

// Bei docMode === 'agent-chain' (NEW!)
POST /api/transcriptions/{id}/generate-doc-v2
Body: {
  bausteine: {
    "FUELLUNG": { "standardText": "..." },
    "ZE_BERATUNG": { "standardText": "..." },
    // ... weitere
  }
}
```

---

## Status-Log

| Datum | Status | Notizen |
|-------|--------|---------|
| 2026-01-07 | Gestartet | Roadmap erstellt, Settings-Toggle implementiert |
| 2026-01-07 | Phase 1+2 fertig | Bausteine-UI, Store, Default-Templates implementiert |
| 2026-01-07 | ALLE PHASEN FERTIG | Backend API, Desktop Integration komplett |

---

## Offene Fragen / Entscheidungen

1. **Kategorie-Erkennung**: Keywords vs. GPT?
   - Aktuell: GPT-basiert für Flexibilität

2. **Mehrere Kategorien**: Wie werden sie zusammengeführt?
   - Aktuell: Chronologisch nach Gespräch

3. **Fallback**: Was wenn keine Kategorie erkannt?
   - Aktuell: Nur Fließtext (wie Single Prompt)

