# Speaker Recognition - Technische Dokumentation

> **Verweis:** Für eine Übersicht der gesamten Architektur, siehe [ARCHITECTURE.md](ARCHITECTURE.md)

## Inhaltsverzeichnis

1. [Überblick](#überblick)
2. [Datenmodell](#datenmodell)
3. [Enrollment-Flows](#enrollment-flows)
4. [Optimierung (Post-Transkription)](#optimierung-post-transkription)
5. [Promotion-Logik](#promotion-logik)
6. [Sicherheitsregeln](#sicherheitsregeln)
7. [Logging](#logging)
8. [API-Referenz](#api-referenz)

---

## Überblick

DentDoc verwendet lokale Sprechererkennung via **Sherpa-ONNX**, um Sprecher in Aufnahmen zu identifizieren. Die Erkennung erfolgt nach der AssemblyAI-Transkription und mappt die diarisierte Speaker-Labels (A, B, C...) auf bekannte Stimmprofile.

### Kernkonzepte

| Konzept | Beschreibung |
|---------|--------------|
| **Embedding** | 512-dimensionaler Vektor, der eine Stimme repräsentiert |
| **Centroid** | Durchschnitt mehrerer Embeddings (= stabilere Referenz) |
| **Cosine Similarity** | Ähnlichkeitsmaß zwischen Embeddings (0-1, 1=identisch) |
| **Threshold** | Schwellenwert für Erkennung (Standard: 0.7 = 70%) |

### Zwei-Stufen-System (Staged Embeddings)

Neue Stimmproben werden **nicht sofort vertrauenswürdig**. Stattdessen durchlaufen sie ein Staging-System:

```
┌─────────────────────┐     ┌─────────────────────┐
│ pending_embeddings  │ ──► │ confirmed_embeddings│
│ (neu, ungeprüft)    │     │ (vertrauenswürdig)  │
└─────────────────────┘     └─────────────────────┘
         │                            │
         │ Promotion wenn:            │
         │ • ≥30s Audio gesamt        └──► centroid (Cache)
         │ • Similarity stabil                │
         └────────────────────────────────────┘
```

**Warum?** Ein einziger schlechter Clip (Überlappung, Hintergrundgeräusche, falscher Sprecher) kann ein Profil dauerhaft beschädigen. Das Staging verhindert irreversible Fehler.

---

## Datenmodell

### Profil-Struktur (voice-profiles.js)

```javascript
{
  // Identifikation
  id: string,                        // Unique ID (Timestamp)
  name: string,                      // Anzeigename ("Dr. Müller")
  role: 'Arzt' | 'ZFA',             // Rolle (NIEMALS 'Patient')
  createdAt: string,                 // ISO Timestamp
  updatedAt: string,                 // ISO Timestamp

  // Multi-Embedding System
  confirmed_embeddings: [{           // Vertrauenswürdige Embeddings
    embedding: number[],             // 512-dim Vektor (als JSON-String gespeichert)
    sourceType: 'enrollment' | 'optimization',
    sourceDuration: number,          // Dauer in ms
    createdAt: string
  }],

  pending_embeddings: [{             // Neue, noch nicht bestätigte Embeddings
    embedding: number[],
    sourceType: 'optimization',
    sourceDuration: number,
    createdAt: string,
    similarity_to_reference: number  // Ähnlichkeit zum Centroid/Referenz
  }],

  // Cache für schnelleres Matching
  centroid: number[] | null,         // Durchschnitt aller confirmed_embeddings
  centroid_updated_at: string,

  // Legacy (Rückwärtskompatibilität)
  embedding: string | null           // Altes Single-Embedding, wird migriert
}
```

### Migration bestehender Profile

Bestehende Profile mit nur einem `embedding` werden automatisch migriert:

```javascript
// Alte Struktur
{ id, name, role, embedding: "[0.1, 0.2, ...]", createdAt }

// Wird zu
{
  id, name, role, createdAt,
  confirmed_embeddings: [{
    embedding: [0.1, 0.2, ...],
    sourceType: 'enrollment',
    sourceDuration: 30000,
    createdAt: profile.createdAt
  }],
  pending_embeddings: [],
  centroid: [0.1, 0.2, ...],
  embedding: null
}
```

---

## Enrollment-Flows

### 1. Setup Wizard Enrollment (Direkt → confirmed)

Benutzer erstellt bewusst ein neues Profil:

```
Benutzer → Setup Wizard → 30s Aufnahme → confirmed_embeddings
```

**Warum confirmed?** Explizite Benutzerabsicht, kontrollierte Umgebung.

### 2. Dashboard Enrollment (Direkt → confirmed)

Gleicher Flow wie Setup Wizard, nur über Dashboard-UI.

### 3. Optimierung (Immer → pending)

Benutzer verbessert Erkennung nach Transkription:

```
Transkription → Unerkannte Sprecher → Benutzer wählt → pending_embeddings
```

**Warum pending?** Audio stammt aus Live-Aufnahme (potentiell verrauscht), indirekte Erkennung.

---

## Optimierung (Post-Transkription)

### Feature-Flow

```
1. Transkription abgeschlossen
   └── Unerkannte Sprecher vorhanden? ("Sprecher A", "Sprecher B")
       └── Ja: "Sprechererkennung optimieren" Button erscheint

2. Benutzer klickt Optimize
   └── Modal zeigt unerkannte Sprecher
       └── Sprecher A (12.4s Sprechzeit, 8 Äußerungen)
       └── Sprecher B (5.2s Sprechzeit, 3 Äußerungen)

3. Benutzer wählt Sprecher aus
   └── Rolle auswählen: Arzt / ZFA / Patient (deaktiviert)
   └── Audio-Vorschau abspielen (15s Clip)

4. Benutzer wählt Aktion:
   └── "Zu bestehendem Profil hinzufügen" → Dropdown
   └── "Neues Profil erstellen" → Name eingeben

5. Bestätigen
   └── Embedding erstellen aus Utterances
   └── Zu pending_embeddings hinzufügen
   └── Promotion prüfen
```

### Audio-Verfügbarkeit

Die Original-Aufnahme wird unter `{temp}/dentdoc/last-recording.wav` aufbewahrt, bis die nächste Aufnahme sie überschreibt. So bleibt das Audio für Optimierung verfügbar.

---

## Promotion-Logik

### Wann wird pending → confirmed?

```javascript
function checkAndPromotePending(profile) {
  // 1. Mindestdauer: 30 Sekunden gesamt
  const totalDuration = sum(pending.sourceDuration);
  if (totalDuration < 30000) return false;

  // 2. Stabilität: Mittlere Ähnlichkeit ≥ 0.65
  const meanSimilarity = mean(pending.similarity_to_reference);
  if (meanSimilarity < 0.65) {
    // Bei bestehendem Profil: pending verwerfen
    // Bei neuem Profil: pending behalten (nächste Chance)
    if (profile.confirmed_embeddings.length > 0) {
      profile.pending_embeddings = [];
    }
    return false;
  }

  // 3. Promotion durchführen
  confirmed.push(...pending);
  pending = [];
  recomputeCentroid();
  return true;
}
```

### Centroid-Berechnung

```javascript
function computeCentroid(embeddings) {
  // Durchschnitt aller Vektoren
  const sum = embeddings.reduce((acc, emb) => {
    return acc.map((v, i) => v + emb[i]);
  }, new Array(512).fill(0));

  const avg = sum.map(v => v / embeddings.length);

  // Normalisierung auf Einheitslänge
  const norm = Math.sqrt(avg.reduce((s, v) => s + v*v, 0));
  return avg.map(v => v / norm);
}
```

---

## Sicherheitsregeln

### Hard Guards (Müssen durchgesetzt werden)

| Regel | Beschreibung | Code |
|-------|--------------|------|
| **Patient-Block** | Patienten werden NIEMALS gespeichert | `if (role === 'Patient') throw Error()` |
| **Mindest-Audio** | Mindestens 5 Sekunden für Embedding | `if (duration < 5000) throw Error()` |
| **Rollen-Unveränderlichkeit** | Profil-Rolle kann nicht geändert werden | `if (profile.role !== selectedRole) throw Error()` |
| **Optimierung → Pending** | Alles aus Optimierung geht nach pending | Setup Wizard: confirmed, sonst: pending |
| **Confirmed ist append-only** | Confirmed Embeddings werden nie gelöscht | Nur hinzufügen, nie ersetzen |

### Soft Guards (Empfohlen)

| Regel | Beschreibung |
|-------|--------------|
| **Vorschau vor Bestätigung** | Benutzer sollte Audio anhören |
| **Similarity-Gate** | Promotion nur wenn mean ≥ 0.65 |
| **Duration-Gate** | Promotion nur nach 30s pending |
| **Nicht-überlappende Segmente** | Für Clips: Segmente ohne Überlappung bevorzugen |
| **Mitte der Session** | Erste 5s vermeiden (Aufwärmgeräusche) |

### Warum keine Patienten speichern?

1. **Datenschutz/DSGVO**: Stimme = biometrisches Merkmal = hohe Schutzanforderungen
2. **Kein Mehrwert**: Patienten wechseln ständig, Wiedererkennung sinnlos
3. **Risiko > Nutzen**: Verwechslungsgefahr, Speicheraufwand, Compliance-Probleme

---

## Logging

Drei Events werden geloggt für einfaches Debugging:

```javascript
// Pending hinzugefügt
debugLog(`[VoiceProfile] pending added (12.4s) to "Dr. Müller"`);

// Promotion abgelehnt
debugLog(`[VoiceProfile] promotion rejected for "Dr. Müller" (mean sim 0.61)`);

// Promotion erfolgreich
debugLog(`[VoiceProfile] promoted for "Dr. Müller" (38.2s total)`);
```

Log-Datei: `%TEMP%/dentdoc-debug.log`

---

## API-Referenz

### voice-profiles.js

| Funktion | Beschreibung |
|----------|--------------|
| `getAllProfiles()` | Alle Profile laden (mit Migration) |
| `getProfile(id)` | Einzelnes Profil per ID |
| `getProfileByName(name)` | Profil per Name |
| `saveProfile(name, embedding, role)` | Neues Profil (→ confirmed) |
| `saveProfileWithPending(name, embedding, role, metadata)` | Neues Profil (→ pending) |
| `addPendingEmbedding(profileId, embedding, metadata)` | Embedding zu pending |
| `checkAndPromotePending(profile)` | Promotion prüfen |
| `computeCentroid(embeddings)` | Centroid berechnen |
| `deleteProfile(id)` | Profil löschen |

### speaker-recognition/index.js

| Funktion | Beschreibung |
|----------|--------------|
| `initialize()` | Sherpa-ONNX initialisieren |
| `createEmbedding(audioPath, startMs, durationMs)` | Embedding aus Audio |
| `createEmbeddingFromUtterances(audioPath, utterances, targetMs)` | Embedding aus mehreren Segmenten |
| `createPreviewClip(audioPath, utterances, outputPath, maxMs)` | Vorschau-WAV erstellen |
| `identifySpeaker(audioPath, startMs, durationMs, threshold)` | Einzelnen Sprecher identifizieren |
| `identifySpeakersFromUtterances(audioPath, utterances)` | Alle Sprecher identifizieren |
| `cosineSimilarity(emb1, emb2)` | Ähnlichkeit berechnen |
| `enrollSpeaker(name, audioPath, role)` | Neues Profil erstellen |

### IPC Handlers (main.js)

| Handler | Beschreibung |
|---------|--------------|
| `start-speaker-optimization` | Optimierungs-Session starten |
| `get-speaker-preview` | Audio-Vorschau für Sprecher |
| `enroll-optimized-speaker` | Sprecher aus Optimierung hinzufügen |
| `cancel-speaker-optimization` | Session abbrechen |
| `get-profiles-for-optimization` | Profile für Dropdown (ohne Patient) |

---

## Zukunftspläne (Nicht V1)

| Feature | Beschreibung |
|---------|--------------|
| **Promotion beim App-Start** | Alle Profile auf Promotion prüfen |
| **Rollen-spezifische Schwellwerte** | Unterschiedliche Thresholds für Arzt/ZFA |
| **Cross-Session-Stabilität** | Promotion nur nach mehreren Sessions |
| **EMA-Centroid** | Exponential Moving Average statt Durchschnitt |

---

*Letzte Aktualisierung: Januar 2026*
