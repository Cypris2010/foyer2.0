# Weißes Bild auf Untis-Displays (Airtame)

Stand: 11.11.2026. Betrifft die Folientypen „Raumanzeige (WebUntis)“ und „Lehrkräfte-Dashboard (WebUntis)“ auf Airtame-Geräten (Airtame 2, Firmware 6.2.x, Chrome 124 auf armv7).

## Symptom

Displays mit einer Raum- oder Lehrkräfte-Folie zeigen nach einiger Zeit nur noch ein weißes Bild. Manche gelten danach im Admin als offline, andere melden sich weiter, schicken aber laufend „Failed to fetch“.

Betroffen waren unter anderem T 0.00, T 1.00, T 2.00 und T 3.00 Flur, A 2.11 IT-Büro oben und B 0.11 Lehrerzimmer Mitte. Auf allen läuft nur eine einzige Untis-Folie.

## Ursachen

Es waren drei Fehler, die sich gegenseitig verstärkt haben.

### 1. Der Grafikspeicher des Airtame-Browsers läuft voll (Hauptursache)

Belegt durch das Airtame-Log von A 2.11 IT-Büro oben vom 11.11.2026, 10:35:

- Nach jedem Laden der Foyer-Seite wächst der gemeinsame Speicher des Browsers (in `statistics/ram.txt` als `kbcached`) gleichmäßig um rund 16 MB pro Minute: von etwa 200 MB auf die Obergrenze von rund 1,15 GB in etwa 60 Minuten. Nach dem Neuladen um 09:17 war er um 10:19 voll.
- Ab genau diesem Zeitpunkt meldet `airtame-browser.txt` rund 1000 Grafikfehler pro Minute (`Attempt to read from an uninitialized SharedImage … Size: (1920, 288)`, dazu `TransferBuffer::Initialize() failed` und `AllocateRingBuffer() failed`). Der Browser kann die vier Bildstreifen, aus denen er den Bildschirm zusammensetzt, nicht mehr füllen; zu sehen ist nur der weiße Hintergrund der Folie.
- Netzwerk-Anfragen brauchen denselben Speicher. Sie scheitern mit `net::ERR_INSUFFICIENT_RESOURCES`, bevor sie das Gerät verlassen: daher „Failed to fetch“, und der Server sieht diese Anfragen nie. Um 09:17 scheiterte daran sogar das Neuladen der Seite.
- Nur ein Neuladen gab den Speicher frei (sichtbar nachts beim 8-Stunden-Reload und um 09:17).
- Vor dem Umstieg auf Foyer 2.0 (bis 09.11.2026, 17:40) blieb der Speicher auf demselben Gerät tagelang flach bei rund 230 MB.

Erklärung, durch die Zahlen gestützt, aber nicht am Gerät bewiesen: Die Untis-Folien zeichnen den ganzen Bildschirm regelmäßig neu, das Lehrkräfte-Dashboard alle 30 Sekunden, die Raumanzeige alle 60 Sekunden, auch ohne geänderte Daten. Ein kompletter Neuaufbau kostet vier Bildstreifen zu je 1920×288 Pixeln, also etwa 8,8 MB. Bei zwei Neuaufbauten pro Minute sind das rund 17 MB pro Minute; gemessen sind 16. Offenbar gibt der Airtame-Browser den Speicher einer Fläche, die immer wieder übermalt wird, nicht frei. Andere Displays wechseln die Folie: Die alte wird entfernt und ihr Speicher freigegeben. Die Raumanzeige zeichnet halb so oft neu und hält entsprechend etwa zwei Stunden durch.

Den Fehler im Grafikteil selbst können wir nicht beheben, nur umgehen.

### 2. Ein Netzaussetzer ließ die Untis-Folie verschwinden

Die Untis-Daten holt der Player getrennt vom Folienplan (sie dürfen nicht in den Offline-Cache). Schlug dieser Abruf einmal fehl, flog die Folie aus dem Ablauf. Beim nächsten Abruf hatte der Folienplan dieselbe Version, der Player hielt ihn für unverändert und holte die Folie erst zurück, wenn sich die Untis-Daten änderten. Das konnte Stunden dauern. Displays mit nur dieser Folie blieben so lange leer.

### 3. Neuladen bei Netzausfall endete auf der Fehlerseite

Der Player lädt alle 8 Stunden, nach einem Update und auf Befehl aus dem Admin neu. War der Server in diesem Moment nicht erreichbar, blieb der Browser auf seiner eigenen weißen Fehlerseite stehen. Dort läuft kein Player-Code mehr, der es erneut versucht; das Display gilt dann als offline, bis jemand das Gerät neu startet.

## Lösung

| Commit | Änderung |
|---|---|
| `adcf805` | Schlägt der Datenabruf fehl, behält die Folie ihre letzten Daten. Der Player versucht es nach 30 Sekunden erneut; ein unvollständiger Folienplan bekommt eine eigene Version, damit der nächste vollständige nicht als unverändert gilt (`apps/player/src/data.ts`, `main.ts`). |
| `adcf805` | Neuladen nur, wenn der Server antwortet; sonst neuer Versuch alle 30 Sekunden (`apps/player/src/wall.ts`). |
| `8211d12` | Untis-Folien auf dem Bildschirm werden zu jeder vollen fünften Minute der Server-Uhr (:00, :05, :10 …) frisch aufgebaut und übergeblendet, wie bei einem Folienwechsel. Das gilt nur für die keepAlive-Typen (die beiden Untis-Folien); Videos, Live-Bilder und Webseiten bleiben unberührt (`apps/player/src/ticker.ts`, `renew()`). |
| `8211d12` | Displays mit nur einer Folie laden zusätzlich alle 2 Stunden ganz neu, zwischen zwei Durchläufen und nur bei erreichbarem Server (`apps/player/src/main.ts`). |
| `8211d12` | Raumanzeige und Lehrkräfte-Dashboard zeichnen nur noch neu, wenn sich der Inhalt ändert; Uhr, Zeitstempel und Kacheltexte ändern nur, was sich unterscheidet (`slide-types/*/legacy.js`). |

Beide Commits sind am 11.11.2026 auf abydos deployt. Die vier T-Displays mussten einmal am Gerät neu gestartet werden, weil sie auf der Fehlerseite hingen.

## Geprüft

- Unit-Test für das Verhalten bei fehlgeschlagenem Datenabruf (`tests/player-data.test.ts`).
- Lokal im Browser mit dem echten Player und beiden Folien: 20 Aktualisierungen mit gleichen Daten ändern auf der Seite nichts mehr; geänderte Daten werden weiter angezeigt; der Neuaufbau tauscht die Folie sauber gegen eine gleiche, die alte wird entfernt; der Statusfilter des Dashboards funktioniert.
- Nach dem Deploy laden die Displays den neuen Player und melden keine Fehler.

## Offen

- Ob der Neuaufbau alle fünf Minuten den Speicher auf dem Airtame wirklich freigibt, ist noch nicht gemessen. Prüfen mit einem Airtame-Log von A 2.11 IT-Büro oben, frühestens eine Stunde nach dem Deploy: In `statistics/ram.txt` sollte `kbcached` alle fünf Minuten wieder fallen statt bis etwa 1,15 GB zu steigen, und in `airtame-browser.txt` sollten keine `SharedImage`-Fehler mehr auftauchen.
- Falls nicht: Das 2-Stunden-Neuladen hält die Displays trotzdem am Laufen; dann wäre als Nächstes zu prüfen, welcher Teil der Seite den Speicher füllt (zum Beispiel der Fortschrittsbalken, der auf diesen Displays ständig läuft).

## Airtame-Log lesen

Das Log kommt als ZIP aus Airtame Cloud. Hilfreich sind:

- `statistics/ram.txt`: Speicher alle 5 Minuten (UTC). `kbcached` ist der gemeinsame Speicher, `kbavail` der freie.
- `airtame-browser.txt`: Browser-Log. Konsolenausgaben des Players stehen dort als `console message from https://foyer.lgsit.de/player/assets/…` mit dem Präfix `[foyer]`.
- `journal-errors.txt`: Systemfehler, auch Neustarts des Geräts (`-- Boot …`).
