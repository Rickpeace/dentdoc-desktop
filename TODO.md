# DentDoc Desktop - TODO




knopf für aufnahme .... FLIC !? oder selber bauen ?
-----
after free trial wehen trying to record i get send to /dashboard .. maybe own landingpage ? 
---
  in der desktop app when trial ausglaufen ist.. sieht man es nicht
  vielleicht when trial und minuten 0 dann was anzeigen !?!? vielleicht auch notification ? 
-----
außerdem kann man trotzdfem aufnehmen drücken und aufnehmen . erst wenn man abschicken will gibt er warnung .. das ist zu spät ....
-----
rolle admin bei user statt admin mail ? gibt imme rnur verwirrung..
----
alles normcal teste mit nueem account

----
gut zu wissen ändern bei subsctiption
---
speicehr knopf uten im footer bei einstellungen ? wie bei bausteine

----
config datei global zum aufrufen....
hmm oder auch cniht ....
----

---
-confidence score mit in die rolle ? --

---
gucken ob minuite gezählz werden ebi trial
----

BIN GRAD DABEI APP ZU TESTEN .... TRIAL ASUGLAUFEN POPUPS USW ...

TODO .. BAUSTEINE UND PROMPTS CHEKCEN
BEI MULTI AGEIN WENN KEINE NAHME STEHT IM TRANSKRIPT (NULL)



------------------------
POTENTIAL BUG FIXES (Feb 2025 Audit)
------------------------
- [ ] BUG: main.js:6141 - store.delete('hasSeenTrayHint') läuft bei jedem App-Start → setzt Tray-Hint immer zurück. TODO-Kommentar sagt "nach Testing entfernen" — vergessen.
- [ ] SECURITY: /api/test-email Endpoint hat NULL Auth. Jeder kann Emails spammen. Löschen oder Admin-Check hinzufügen.
- [ ] SECURITY: Admin-Routen prüfen email === 'richard@petrasch.com' statt role-Feld aus DB. Hardcoded → kein zweiter Admin möglich.
- [ ] SECURITY: Kein Rate Limiting auf /api/auth/login → Brute Force möglich. Vercel hat Basic-Schutz aber eigener Limiter wäre besser.
- [ ] UPGRADE: Electron 28 → mind. 33-34 (aktuell ist 40). 12 Major Versions = 12 Runden Security Patches, Node 18→24, Chromium 120→144.
- [ ] BUG: jwt.ts catch-all in getUserFromRequest() returns null on transient DB errors (ECONNRESET) → heartbeat returns 401 → Desktop App loggt User aus. Fix: Transient errors rethrow statt null return (→500 statt 401). Zusätzlich: session.js consecutive-failure counter (2x 401 bevor Logout).
------------------------

------------------------
UPLOAD PROXY: STREAMING STATT BUFFERING (Priorität: Mittel)
Problem: Railway Upload Proxy hält gesamte Audio-Datei im RAM (~25MB/Upload)
Lösung: Node.js Streams - chunk-weise durchpipen statt komplett buffern
Datei: railway-upload-proxy/
Effekt: RAM ~25MB/Upload → ~64KB/Upload, skaliert besser bei vielen gleichzeitigen Uploads
------------------------

------------------------
DSGVO
ALLES LÖSCHEN AUTOMATISCH ...
GESPEICHERTE DATEIN VERSCHLÜSSELN FALLS SIE IM BACKUP LANDEN - UNBRAUCHBAR
SCHLÜSSEL PRO DATEI IN DATENBANK !? DATEN BANK LÖSCHT SCHLÜSSEL UZUSÄTZLICH ZUR AUTOMATISCHEN LÖSCHUNG
PIN CODE UM TRANSCRIPTE AUFZURUFEN UND ANZUHÖREN (ZUGANSGBERECHTIUGUNG)

Hier ist meine empfohlene “Audit-feste” Zielarchitektur (1:1 das, was du jetzt bauen willst), inkl. Logik + Hinweise, was du kommunizieren musst.

✅ Ziel: Audio/Transkript + Replay, aber DSGVO-sauber
1) Zweck & Datenarten klar trennen

Akte (Pflicht, 10 Jahre)

gespeicherte Aktennotiz / Behandlungseintrag

fällt unter Dokumentationspflicht (§630f BGB)

Arbeitsdaten (optional, Komfort)

Audio + Volltranskript + “Click-to-play”

nicht zwingend Teil der Akte → daher Retention & Minimierung

Wichtig für Audit: Du erklärst: „Audio/Transkript sind Komfort/Qualität – nicht die rechtliche Akte.“

2) Speicherlogik: Retention + Auto-Delete (Pflichtbaustein)

In der App einstellbar pro Praxis:

Audio speichern: AN/AUS

Transkript speichern: AN/AUS

Aufbewahrung: 7 / 30 / 180 Tage

Technik:

jedes Objekt hat expiresAt

Server job löscht täglich alles Abgelaufene

Das erfüllt Speicherbegrenzung (DSGVO Art. 5)

3) “Crypto-Delete”: Backup-unabhängig löschen können (Gamechanger)

Weil du die Backup-Rotation der Praxis nicht kontrollierst:

✅ Envelope Encryption

pro Recording eigener dataKey

Datei = AES-GCM(dataKey)

dataKey liegt nur serverseitig verschlüsselt (Key-Store)

✅ Wenn Retention abläuft:

Datei löschen und/oder

Schlüsselmaterial entfernen → danach nicht mehr entschlüsselbar (“crypto delete”)

Damit bist du “audit-sicher”, auch wenn Backups länger leben.

4) Verschlüsselung “at rest” + Key nur auf Server

Ganz wichtig: Die Clients haben keinen Key.

Im Netzwerkordner liegen nur .enc → ohne App wertlos

Entschlüsselung passiert serverseitig nach Login

Das ist direkt DSGVO Art. 32 “Verschlüsselung” / Sicherheit der Verarbeitung
Und weil es Gesundheitsdaten sind (Art. 9), ist genau das die richtige Härte

5) Zugriff nur via Login + Rollen

Minimum-Rollen:

Doctor: sehen/abspielen/arbeiten

Admin: zusätzlich export + retention settings

Staff: ggf. nur Aktennotiz (kein Audio)

Regel: Replay/Export nur, wenn Rolle passt.

6) Audit Log (musst du haben, wenn du Audio speicherst)

Logge mindestens:

PLAY_AUDIO

EXPORT_AUDIO

DELETE_RECORDING

CHANGE_RETENTION

Damit kannst du bei “Wer hat was angehört/rausgezogen?” sauber antworten.

7) Export-Regel (sonst ist alles für die Katz)

Default:

Export nur Admin/Doctor

Export wird immer geloggt

Optional: Export nur als Clip statt Full Recording

✅ Was du in der App / Doku klar kommunizieren musst

Damit Ärzte/DSB “sofort ja” sagen:

Audio/Transkript sind optional (Privacy Mode verfügbar)

Automatische Löschung nach X Tagen (einstellbar)

Backups egal, weil nach Ablauf nicht mehr entschlüsselbar (crypto delete)

Im Ordner liegen nur verschlüsselte Dateien

Zugriff nur via Login + Rollen + Protokollierung

✅ Reicht das für Audits?

Ja. Das deckt die typischen Prüfpunkte ab:

Datenminimierung & Speicherbegrenzung (Art. 5)

Gesundheitsdaten-Schutz (Art. 9)

Sicherheitsmaßnahmen / Verschlüsselung (Art. 32)

Akte bleibt 10 Jahre (§630f BGB)

Löschlogik ist begründbar (Art. 17 – wenn Zweck endet / Ausnahmen für Pflichtdaten)

✅ Meine “Minimal-Umsetzung”, die du wirklich bauen solltest

Wenn du nur 6 Dinge baust, dann genau diese:

Retention Settings (7/30/180 + AUS)

Auto-Delete Job (serverseitig)

.enc Speicherung (AES-GCM Envelope)

Keys nur auf Server (kein Client Key)

Replay = Server streamt decrypted range

Audit Log (Play/Export/Delete/Retention)

Das ist schon “seriös wie Praxissoftware”.

Wenn du willst, schreibe ich dir als nächstes die perfekte “Datenschutz-/Security-Kurzbeschreibung” (1 Seite) für Onboarding + DSB, in deinem Ton, inkl. genau den Punkten oben.