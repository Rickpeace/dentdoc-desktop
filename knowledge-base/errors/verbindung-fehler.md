# Verbindungs- und Netzwerk-Fehler

Hier finden Sie Lösungen für Probleme mit Internet, Login und Server-Verbindung.

---

## "Keine Internetverbindung"

### Schnelltest
Öffnen Sie einen Browser und rufen Sie eine Webseite auf (z.B. google.de). Funktioniert das?

### Wenn Browser funktioniert, aber DentDoc nicht:

1. **Firewall prüfen**
   - Windows-Suche → "Firewall"
   - "Eine App durch die Firewall zulassen"
   - DentDoc suchen und Häkchen setzen (Privat + Öffentlich)

2. **Antivirensoftware prüfen**
   - Manche Antivirenprogramme blockieren unbekannte Apps
   - DentDoc als Ausnahme hinzufügen

3. **Proxy-Einstellungen**
   - In manchen Praxen wird ein Proxy verwendet
   - IT-Administrator fragen, ob Proxy-Einstellungen nötig sind

### Wenn auch Browser nicht funktioniert:

1. **WLAN-Verbindung prüfen**
   - Sind Sie mit dem richtigen Netzwerk verbunden?
   - WLAN-Symbol in der Taskleiste prüfen

2. **Router neu starten**
   - Router vom Strom trennen
   - 30 Sekunden warten
   - Wieder einstecken

3. **Netzwerkkabel prüfen** (bei LAN)
   - Kabel richtig eingesteckt?
   - Anderes Kabel testen

---

## "Verbindung zum Server fehlgeschlagen"

### Ursachen
- Kurze Netzwerkunterbrechung
- Server-Wartung (selten)
- Firewall blockiert

### Lösungen

1. **Erneut versuchen**
   - Warten Sie 10-30 Sekunden
   - Versuchen Sie die Aktion erneut

2. **DentDoc neu starten**
   - Komplett schließen (auch System Tray)
   - Neu starten

3. **Internetverbindung testen**
   - Browser öffnen, Webseite aufrufen

4. **Später erneut versuchen**
   - Bei Server-Wartung: In 15-30 Minuten erneut versuchen

---

## Login-Probleme

### "Ungültige Anmeldedaten"

**Lösungen:**
1. E-Mail-Adresse prüfen (Tippfehler?)
2. Passwort prüfen:
   - Groß-/Kleinschreibung beachten
   - Feststelltaste (Caps Lock) aus?
   - Keine Leerzeichen am Anfang/Ende?
3. "Passwort vergessen" nutzen

### "E-Mail nicht gefunden"

**Lösungen:**
1. Haben Sie sich mit dieser E-Mail registriert?
2. Andere E-Mail-Adressen versuchen
3. Bei Unsicherheit: Support kontaktieren

### "Konto nicht aktiviert"

**Lösungen:**
1. E-Mail-Postfach prüfen (auch Spam-Ordner)
2. Aktivierungslink in der E-Mail klicken
3. "Aktivierungsmail erneut senden" klicken

### "Passwort vergessen"

1. Auf Login-Seite: "Passwort vergessen" klicken
2. E-Mail-Adresse eingeben
3. E-Mail mit Reset-Link wird gesendet
4. Link klicken und neues Passwort setzen

**Keine E-Mail erhalten?**
- Spam-Ordner prüfen
- Richtige E-Mail-Adresse eingegeben?
- Nach 5 Minuten erneut versuchen
- Support kontaktieren

---

## "Sitzung abgelaufen"

### Ursache
Die Anmeldung ist nach längerer Inaktivität abgelaufen (Sicherheitsmaßnahme).

### Lösung
Melden Sie sich einfach erneut an. Ihre Daten sind nicht verloren.

---

## "Upload fehlgeschlagen"

### Symptome
- Aufnahme wird nicht hochgeladen
- "Fehler beim Hochladen" Meldung
- Dokumentation erscheint nicht

### Lösungen

1. **Internetverbindung prüfen**
   - Browser-Test machen
   - WLAN-Verbindung prüfen

2. **Erneut versuchen**
   - Die App versucht automatisch erneut
   - Oder: Dashboard öffnen und manuell "Erneut hochladen"

3. **Bei langsamer Verbindung warten**
   - Große Aufnahmen brauchen Zeit
   - Nicht unterbrechen während Upload

4. **Firewall/Proxy prüfen**
   - In Praxis-Netzwerken können Uploads blockiert sein
   - IT-Administrator fragen

### Aufnahme verloren?

Aufnahmen werden lokal zwischengespeichert. Auch nach einem Upload-Fehler können sie später hochgeladen werden, wenn die Verbindung wieder funktioniert.

---

## "Timeout" / Zeitüberschreitung

### Ursache
Die Verbindung ist zu langsam oder wurde unterbrochen.

### Lösungen

1. **Erneut versuchen**
   - Oft klappt es beim zweiten Mal

2. **Näher zum Router gehen** (bei WLAN)
   - Schwaches Signal kann Timeouts verursachen

3. **Internetgeschwindigkeit testen**
   - Im Browser: "speedtest" suchen und Test durchführen
   - Bei sehr langsamer Verbindung: Provider kontaktieren oder Hotspot nutzen

---

## VPN-Probleme

### DentDoc funktioniert nicht mit VPN

Manche VPNs blockieren bestimmte Verbindungen oder verlangsamen die Verbindung erheblich.

**Lösungen:**
1. VPN temporär deaktivieren
2. DentDoc als Ausnahme im VPN konfigurieren (IT fragen)
3. Split-Tunneling aktivieren (IT fragen)

---

## Häufige Fragen

### Braucht DentDoc viel Internet?
Für Uploads wird ca. 1 MB pro Minute Aufnahme benötigt. Eine normale DSL-Verbindung ist ausreichend.

### Funktioniert DentDoc offline?
Aufnahmen können offline gemacht werden. Für Transkription und Dokumentation ist Internet erforderlich. Aufnahmen werden hochgeladen, sobald wieder Verbindung besteht.

### Ist meine Verbindung sicher?
Ja, alle Daten werden verschlüsselt übertragen (HTTPS/TLS).

### Was tun bei häufigen Verbindungsproblemen?
- WLAN durch LAN-Kabel ersetzen (stabiler)
- Router-Position optimieren
- IT-Support der Praxis einbeziehen
