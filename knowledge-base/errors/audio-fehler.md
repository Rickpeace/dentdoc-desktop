# Audio- und Mikrofon-Fehler

Hier finden Sie Lösungen für Probleme mit Audio, Mikrofon und Aufnahmen.

---

## "Kein Mikrofon gefunden"

### Ursachen
- Kein Mikrofon angeschlossen
- Mikrofon von Windows nicht erkannt
- Falscher Audioeingang ausgewählt

### Lösungen

1. **Mikrofon prüfen**
   - Ist ein Mikrofon angeschlossen?
   - Bei Headsets: Ist der Stecker richtig eingesteckt?
   - Bei USB-Mikrofonen: Leuchtet eine Anzeige?

2. **Windows-Einstellungen prüfen**
   - Rechtsklick auf Lautsprecher-Symbol → Sounds
   - Tab "Aufnahme" öffnen
   - Prüfen, ob ein Mikrofon angezeigt wird
   - Wenn nicht: Gerät ist nicht erkannt

3. **In DentDoc prüfen**
   - Einstellungen → Mikrofon
   - Richtiges Gerät aus der Liste wählen

4. **Treiber aktualisieren**
   - Windows-Taste → "Geräte-Manager"
   - "Audioeingänge und -ausgänge" erweitern
   - Rechtsklick auf Mikrofon → "Treiber aktualisieren"

---

## "Mikrofon wird verwendet"

### Ursachen
- Ein anderes Programm nutzt das Mikrofon exklusiv
- Videocall-Software (Teams, Zoom) ist aktiv

### Lösungen

1. **Andere Programme schließen**
   - Beenden Sie Videocall-Software
   - Schließen Sie Browser-Tabs mit Mikrofon-Zugriff
   - Beenden Sie andere Aufnahme-Software

2. **DentDoc neu starten**
   - Schließen Sie DentDoc komplett (auch im System Tray)
   - Starten Sie DentDoc erneut

3. **Computer neu starten**
   - Manchmal hilft nur ein Neustart

---

## Aufnahme ist stumm / kein Audio

### Symptome
- Aufnahme läuft, aber Pegel zeigt nichts
- Transkript ist leer oder zeigt "Keine Sprache erkannt"

### Lösungen

1. **Mikrofon-Test machen**
   - Einstellungen → Mikrofon → Test
   - Sprechen Sie und beobachten Sie den Pegelausschlag
   - Wenn kein Ausschlag: Mikrofon-Problem

2. **Richtiges Mikrofon wählen**
   - Haben Sie mehrere Mikrofone? (Laptop + Headset + Webcam)
   - Wählen Sie explizit das gewünschte Mikrofon in den Einstellungen

3. **Mikrofon nicht stummgeschaltet?**
   - Manche Headsets haben einen Mute-Knopf
   - Prüfen Sie Windows-Einstellungen (Lautstärke-Mixer)

4. **Mikrofon-Pegel zu niedrig**
   - Windows-Einstellungen → Sound → Aufnahme
   - Doppelklick auf Mikrofon → Pegel erhöhen

---

## Audio-Qualität ist schlecht

### Symptome
- Rauschen in der Aufnahme
- Verzerrte Stimmen
- Unverständliche Passagen

### Lösungen

1. **Mikrofon-Position verbessern**
   - 30-50 cm Abstand zum Mund
   - Nicht direkt vor dem Mund (vermeidet Plopp-Geräusche)
   - Auf Sprecher ausrichten

2. **Hintergrundgeräusche reduzieren**
   - Fenster schließen
   - Klimaanlage/Lüfter möglichst leise
   - Radio/Musik ausschalten

3. **Besseres Mikrofon verwenden**
   - Laptop-Mikrofone sind oft schlecht
   - Ein einfaches USB-Mikrofon verbessert die Qualität deutlich
   - Headset-Mikrofone sind oft gut

4. **Mikrofon-Pegel anpassen**
   - Zu hoch = Verzerrung
   - Zu niedrig = Rauschen wird verstärkt
   - Optimal: Pegel im grünen Bereich bei normaler Lautstärke

---

## "Aufnahme fehlgeschlagen"

### Ursachen
- Technisches Problem beim Starten der Aufnahme
- Mikrofon-Zugriff blockiert
- Speicherplatz voll

### Lösungen

1. **Erneut versuchen**
   - Warten Sie einige Sekunden
   - Versuchen Sie erneut mit F9

2. **DentDoc neu starten**
   - Komplett beenden und neu starten

3. **Speicherplatz prüfen**
   - Windows-Taste → "Speicherplatz"
   - Mindestens 1 GB frei sollte vorhanden sein

4. **Als Administrator starten**
   - Rechtsklick auf DentDoc → "Als Administrator ausführen"

---

## Aufnahme bricht ab

### Symptome
- Aufnahme stoppt unerwartet
- Nur Teile werden aufgenommen

### Ursachen
- Computer geht in Ruhezustand
- Mikrofon wurde getrennt
- Speicherplatz wird knapp

### Lösungen

1. **Energieeinstellungen anpassen**
   - Windows-Einstellungen → System → Netzbetrieb
   - "Bildschirm ausschalten nach" auf längere Zeit
   - "Ruhezustand nach" deaktivieren während Nutzung

2. **Mikrofon-Verbindung prüfen**
   - USB-Stecker fest?
   - Kabel nicht beschädigt?

3. **Speicherplatz freigeben**
   - Alte Dateien löschen
   - Papierkorb leeren

---

## FFmpeg-Fehler

### Was ist FFmpeg?
FFmpeg ist die Audio-Software, die DentDoc für Aufnahmen nutzt. Normalerweise arbeitet sie unsichtbar im Hintergrund.

### "FFmpeg nicht gefunden"

**Lösung:**
1. DentDoc neu installieren
2. Antivirensoftware prüfen (könnte FFmpeg blockieren)
3. Als Administrator ausführen

### "FFmpeg-Fehler bei Aufnahme"

**Lösung:**
1. DentDoc neu starten
2. Computer neu starten
3. Wenn es weiterhin auftritt: Support kontaktieren

---

## Häufige Fragen

### Welches Mikrofon ist am besten?
Ein einfaches USB-Mikrofon (ab ca. 30€) ist für die meisten Praxen ausreichend. Wichtiger als teures Equipment ist die richtige Positionierung.

### Funktioniert DentDoc mit Bluetooth-Headsets?
Ja, aber kabelgebundene Mikrofone sind oft zuverlässiger. Bei Bluetooth kann es zu Verbindungsabbrüchen kommen.

### Warum ist mein Laptop-Mikrofon schlecht?
Laptop-Mikrofone sind für Videocalls optimiert, nicht für längere Aufnahmen. Sie nehmen viele Umgebungsgeräusche auf und haben oft eine niedrigere Qualität.
