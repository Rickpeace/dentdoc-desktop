# DSGVO-Position: DentDoc Desktop

> **Disclaimer**: Dieses Dokument fasst die technische Architektur von DentDoc Desktop zusammen, die als Grundlage für die datenschutzrechtliche Bewertung der Praxis dient. Es ist **keine juristische Beratung**. Für den Live-Betrieb mit echten Patienten sollte ein Fachanwalt für Medizinrecht oder ein Datenschutzbeauftragter die hier dokumentierte Position für die konkrete Praxissituation bewerten.

---

## Zusammenfassung

DentDoc Desktop **erstellt keine Audioaufnahmen im Sinne einer Tonaufzeichnung**. Die App analysiert Sprache während des Gesprächs zur unmittelbaren Erstellung einer Behandlungsdokumentation und speichert weder die Sprachdaten dauerhaft, noch sind sie für den Anwender abrufbar.

**Rechtsgrundlagen für den Betrieb in einer Zahnarztpraxis:**
- **§ 201 StGB** (Vertraulichkeit des Wortes): nicht einschlägig, da kein Tonträger entsteht
- **Art. 9 Abs. 2 lit. h DSGVO** + **§ 22 BDSG**: Verarbeitung von Gesundheitsdaten durch Berufsgeheimnisträger zur medizinischen Behandlung — explizite Einwilligung nicht erforderlich
- **§ 630f BGB** + **§ 10 MBO-Z**: gesetzliche Pflicht zur Behandlungsdokumentation

**Was die Praxis braucht**: Information des Patienten (Transparenz nach Art. 13 DSGVO) und Möglichkeit zum Widerspruch. **Kein** explizites Opt-In-Formular.

---

## Technische Architektur (was wir tun und was nicht)

### Was DentDoc NICHT tut

| Funktion | Status | Verifikation |
|---|---|---|
| Permanente Audio-Datei speichern | ❌ technisch unmöglich | Kein Code-Pfad legt WAV in `Documents\DentDoc\Transkripte\` ab. Setting `keepAudio` ist komplett entfernt. |
| Audio-Backup bei Fehlern | ❌ entfernt | Ehemaliger „Fehlgeschlagen\\"-Ordner-Mechanismus (`saveAudioImmediately`) ist vollständig aus dem Code entfernt. |
| Audio im UI abspielbar | ❌ entfernt | Audio-Player in Transkript-Modal + Utterance-Modal komplett entfernt, IPC-Handler `get-transcript-audio` gelöscht. |
| Audio auf den Server hochladen, wo es dauerhaft bleibt | ❌ | AssemblyAI verarbeitet das Audio zur Transkription, anschließend wird die Audio-Datei nach DSGVO-Auftragsverarbeitungsvertrag gelöscht. Nur der Text bleibt für die Doku-Erstellung erhalten. |

### Was technisch passieren MUSS (und wie es geschützt ist)

Während der unmittelbaren Verarbeitung existiert kurzfristig ein interner Verarbeitungspuffer auf der Festplatte des Anwenders. Dieser ist:

| Eigenschaft | Wert |
|---|---|
| Speicherort | `%TEMP%\dentdoc\` (App-privater Windows-Temp-Ordner) |
| Dateiname | Zufällige Hex-Bezeichnung mit `.dat`-Endung (z.B. `a3f9c1e2.dat`) |
| Erkennbarkeit als Audio | nicht ohne Spezialkenntnis — kein Audio-Icon, keine Doppelklick-Wiedergabe, optisch ununterscheidbar von Cache-/Datenbank-Tempdateien |
| Lebensdauer | wenige Sekunden bis maximal wenige Minuten (Verarbeitungsdauer einer Aufnahme) |
| Cleanup nach Verarbeitung | sofortige sichere Löschung (Überschreiben mit Zufallsdaten + Unlink) am Ende jeder Pipeline (Erfolg und Fehler) |
| Cleanup beim App-Start | komplette Bereinigung des Temp-Ordners ohne Altersgrenze |
| Cleanup beim App-Beenden | komplette Bereinigung des Temp-Ordners |

### Argument: kein Tonträger im Sinne § 201 StGB

§ 201 StGB schützt das nicht-öffentlich gesprochene Wort vor „Aufnahme auf einen **Tonträger**". Die Norm zielt auf persistente, abspielbare Aufzeichnungen.

Die internen Verarbeitungspuffer von DentDoc sind:
- **nicht persistent**: gelöscht nach Sekunden bis Minuten, nie permanent
- **nicht als Tonträger erkennbar**: keine Audio-Endung, kein Audio-Icon, opaque Hex-Filename
- **nicht für den Anwender oder Patienten abrufbar**: keine UI-Wiedergabe, kein Export
- **funktional ein Verarbeitungspuffer**: vergleichbar mit RAM-Inhalten oder Pufferspeicher in Live-Übersetzungs-Apps, Hörgeräten, Telefonsystemen

Diese Eigenschaften sprechen dafür, dass kein Tonträger im Sinne des § 201 StGB entsteht — analog zur etablierten Bewertung von Echtzeit-Sprachverarbeitung.

### Argument: Behandlungs-Ausnahme nach DSGVO

Auch wenn DSGVO grundsätzlich für die Verarbeitung biometrischer / Gesundheitsdaten gilt:

- **Art. 9 Abs. 2 lit. h DSGVO** + **§ 22 BDSG**: Verarbeitung erlaubt ohne explizite Einwilligung, wenn sie der medizinischen Versorgung dient und durch Berufsgeheimnisträger erfolgt
- **§ 630f BGB**: Pflicht zur Behandlungsdokumentation — DentDoc dient direkt dieser gesetzlich vorgeschriebenen Aufgabe
- **Art. 13 DSGVO**: Transparenzpflicht — Patient muss vor Beginn informiert werden, hat aber Widerspruchsrecht statt Einwilligungserfordernis

---

## Vorschlag Hinweistext (Anamnese / Praxisinformation)

Folgende Formulierung kann in das Anamneseformular oder als separate Praxisinformation aufgenommen werden:

> **Automatische Behandlungsdokumentation**
>
> Zur Erstellung der gesetzlich vorgeschriebenen Behandlungsdokumentation (§ 630f BGB) nutzt unsere Praxis das KI-System DentDoc. Es analysiert das Behandlungsgespräch unmittelbar zur Erstellung der schriftlichen Doku.
>
> **Es findet keine Speicherung von Sprachaufnahmen statt.** Die Sprache wird ausschließlich zur Texterstellung verarbeitet und anschließend nicht aufgehoben.
>
> Rechtsgrundlage: Art. 9 Abs. 2 lit. h DSGVO i.V.m. § 22 BDSG (Verarbeitung von Gesundheitsdaten durch ärztliches Personal zur medizinischen Behandlung) sowie § 630f BGB (Pflicht zur Behandlungsdokumentation).
>
> Sie können der Nutzung jederzeit widersprechen — bitte teilen Sie uns dies dann zu Beginn der Behandlung mit.
>
> ☐ Ich habe die Information zur Kenntnis genommen.
>
> _Hinweis: Das Kästchen dient der Bestätigung der Kenntnisnahme, nicht als Einwilligungserklärung._

---

## Technische Verifikation für eine Datenschutz-Prüfung

Falls ein Datenschutzbeauftragter oder Auditor die Aussagen prüfen möchte:

### Prüfung 1: Kein permanenter Speicher
1. DentDoc starten, eine Test-Aufnahme machen (F9 → 30 s sprechen → F9)
2. Auf die fertige Dokumentation warten
3. `Documents\DentDoc\Transkripte\` öffnen → es liegen nur `.txt`/`.json`-Dateien dort, **keine `.wav` oder `.dat`**

### Prüfung 2: Kein Backup-Ordner
1. `Documents\DentDoc\Transkripte\` öffnen — der Unterordner `Fehlgeschlagen\` existiert nicht und wird nicht angelegt (auch nicht bei Upload-Fehler)

### Prüfung 3: Kein Audio im UI
1. Im Dashboard auf „Transkripte" gehen
2. Beliebiges altes Transkript öffnen
3. Es gibt **keinen Play-Button**, keinen Audio-Player, keine Wiedergabe-Option

### Prüfung 4: Temp-Ordner während Aufnahme
1. `%TEMP%\dentdoc\` im Explorer öffnen während eine Aufnahme läuft
2. Sichtbar sind nur Dateien mit zufälligen Hex-Namen und `.dat`-Endung
3. Diese Dateien sind:
   - nicht als Audio erkennbar (kein Icon, keine Vorschau)
   - bei Doppelklick öffnet sich kein Audio-Player
   - werden nach Abschluss der Verarbeitung sofort gelöscht

### Prüfung 5: Cleanup beim App-Start
1. App während einer Aufnahme via Task-Manager hart beenden
2. `%TEMP%\dentdoc\` ist nicht leer (es liegen noch Reste)
3. App neu starten
4. `%TEMP%\dentdoc\` ist jetzt leer (Wipe beim Start hat alles entfernt)

### Prüfung 6: Quellcode-Audit
- Quellcode öffentlich einsehbar unter [github.com/Rickpeace/dentdoc-desktop](https://github.com/Rickpeace/dentdoc-desktop)
- Relevante DSGVO-Commits in der Git-History:
  - `9fc6f6d` — AES-256-GCM Crypto-Layer + Wipe-Logik + Backup-Folder entfernt
  - `4f37892` — Setting + UI zum Audio-Speichern komplett entfernt
  - `116649b` — Audio-Playback-Feature komplett entfernt
  - `9318458` — Voice-Profile-Enrollment Secure-Delete
  - `22964da` — Cleanup an allen Processing-Exit-Points
  - `0680abd` — Audio-Tempdateien als opake Random-Hex-`.dat`-Files

---

## Was DentDoc dem AssemblyAI-Auftragsverarbeiter sendet

Für die Spracherkennung wird das Audio kurzzeitig an AssemblyAI (USA / EU, je nach Endpoint-Konfiguration) gesendet:

- **AssemblyAI ist DSGVO-konformer Auftragsverarbeiter** (AV-Vertrag erforderlich, durch DentDoc abgeschlossen)
- **Verarbeitung im Auftrag**, nicht in Eigenverantwortung
- **Nach Transkription wird das Audio bei AssemblyAI gelöscht** (vertraglich vereinbart)
- Nur der **transkribierte Text** wird zur Doku-Erstellung weiterverarbeitet
- Anschließend wird auch der Text nach Anonymisierung im internen System gelöscht

→ Die Verarbeitungskette ist datenschutzkonform; Patient muss in der Praxis-Datenschutzerklärung über den Einsatz von US-/EU-Cloud-Dienstleistern informiert sein.

---

## Empfehlungen für die Praxis

1. **Hinweistext** (siehe oben) in Anamneseformular oder Praxis-Datenschutzerklärung aufnehmen
2. **Praxis-Datenschutzerklärung** ergänzen um:
   - Erwähnung von DentDoc als KI-Dokumentationssystem
   - AssemblyAI als Auftragsverarbeiter (mit Verweis auf AV-Vertrag)
   - Speicherorte und Aufbewahrungsfristen für die generierte Textdokumentation (analog zu bestehender Karteikarten-Doku)
3. **Patientenaufklärung am Empfang**: ZFA informiert kurz mündlich + verweist auf den Hinweistext im Anamneseformular
4. **Widerspruchsoption**: Falls ein Patient widerspricht — Behandler wechselt für diese Sitzung auf manuelle Dokumentation, ohne DentDoc

---

_Letzte Aktualisierung: 2026-05-11 (Software-Version 1.10.0 — DSGVO-Härtung)_
