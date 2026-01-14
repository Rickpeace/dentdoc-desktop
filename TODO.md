# DentDoc Desktop - TODO

## Feature Requests



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
bei aufnahhme X drücken bricht nicht mehr ab !?!??!
---
-confidence score mit in die rolle ? --

---
gucken ob minuite gezählz werden ebi trial
----




microphone: https://www.amazon.de/Anker-Konferenzlautsprecher-integrierte-verbesserter-Gespr%C3%A4chszeit/dp/B0899S421T/ref=sr_1_1?adgrpid=77903328184&dib=eyJ2IjoiMSJ9.7-IkzsIU43ER2uVd-vdFiUZw5bsn5187DLYzlxCPhXjaYdd9GvPk4pFk9bZ2cN_Ef5ApbkTkVUz4rRJ2yy9lBvTO-D5toxmTTDqUQZu5DcyhVMb51iDe5nuAjCGI92UwG7rwLtZBEGRUhQ0a6pqYM-C_dDtpY_eg_ZAzJkmyKt69GsOEeA25NX1JmfJFyvLzZKUjKW_-ztzaItOay1UDbW1eOK3XUNoe7ltbS1SAf6U.gF7b4uPWJFIGDiTIr4HP0wkdSwL82apKWEECOPIejhE&dib_tag=se&hvadid=352728096168&hvdev=c&hvexpln=0&hvlocphy=9192964&hvnetw=g&hvocijid=3668850731596253718--&hvqmt=e&hvrand=3668850731596253718&hvtargid=kwd-940776181362&hydadcr=26672_1770882&keywords=anker%2Bpowerconf%2Bs3&mcid=35ac095e312e356a86875e33e268f56f&qid=1767732848&sr=8-1&th=1



BIN GRAD DABEI APP ZU TESTEN .... TRIAL ASUGLAUFEN POPUPS USW ...

TODO .. BAUSTEINE UND PROMPTS CHEKCEN
BEI MULTI AGEIN WENN KEINE NAHME STEHT IM TRANSKRIPT (NULL)
---
einrichtung stimmprofuil updaten ??? man sieht noch keine vorhanden nach ordenr wechsel....




-------

-------
enn upload scheitert bei vercel keine fehlermelung
------

cleanup tsten für audio
------



----!!!!!!!!!!!!!!!
vercel nur 5 mb ! upload

JETZT DEKSTOP APP LÄDT DIREKT HOCH .. API KEY OFFEN GELEGT !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

LÖSUNG. FÜR SPÄTER... JETZT ERSTMALL PRROF OF CONCEPT MIT DER DESKTOP APP


✅ Ich würde für DEINEN Fall nehmen: Railway + Node.js + Fastify

Und zwar genau so 👇

🥇 Warum Railway?

Schnellster Weg von 0 → läuft

Kein Stress mit Networking, SSL, Ports

Perfekt für kleine Streaming-Proxys

Kosten: ~1–3 € / Monat

Kein Cold-Start-Drama

➡️ Für „ein kleiner, stabiler Upload-Rohr-Service“ ideal.

(Alternative wäre Fly.io, aber das ist mehr Ops-Aufwand.)

🥇 Warum Fastify (nicht Express)?

Sehr gut für Streams

Weniger Overhead

Saubere Error-Handling

Zukunftssicher

Express geht auch – aber Fastify ist cleaner für genau diesen Use-Case.

🧱 Empfohlener Mini-Stack

Runtime

Node.js 18+

Framework

Fastify

HTTP

Native Streams (req.raw → fetch body)

Keine DB

❌ keine Speicherung

❌ keine Logs

❌ kein Temp-Folder

🎯 Ziel-Architektur (minimal)
Desktop-App
  └─► Railway Upload-Service (/upload)
         └─► AssemblyAI /v2/upload (STREAM)
                ◄─ upload_url
Desktop-App
  └─► Vercel (/start)


➡️ Ein Upload. Kein Double-Upload. DSGVO-sauber.

🔒 Sicherheit (realistisch, nicht overkill)

Header:

Authorization: Bearer <DentDoc-Token>

Server:

prüft Token (leicht)

Rate-Limit (optional später)

🧠 Warum ich NICHT nehmen würde

❌ Vercel (Body-Limit)

❌ S3 + Presigned URLs (AssemblyAI unterstützt das nicht)

❌ API-Key im Desktop (nur Notlösung)

❌ Kubernetes / Cloud Run (Overkill)