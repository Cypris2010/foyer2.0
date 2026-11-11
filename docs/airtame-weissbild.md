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
| `8211d12` | Displays mit nur einer Folie laden zusätzlich alle 2 Stunden ganz neu, zwischen zwei Durchläufen und nur bei erreichbarem Server (`apps/player/src/main.ts`). Hat nie gegriffen, siehe unten. |
| Nachtrag | Jedes Display auf einem Airtame lädt nach 40 Minuten zwischen zwei Folien neu, spätestens nach 50 Minuten. Die Prüfung, ob der Server antwortet, bricht nach 15 Sekunden ab, und ein vom Browser verworfenes Neuladen blockiert die nächsten Versuche nicht mehr (`apps/player/src/main.ts`, `wall.ts`). |
| `8211d12` | Raumanzeige und Lehrkräfte-Dashboard zeichnen nur noch neu, wenn sich der Inhalt ändert; Uhr, Zeitstempel und Kacheltexte ändern nur, was sich unterscheidet (`slide-types/*/legacy.js`). |

Beide Commits sind am 11.11.2026 auf abydos deployt. Die vier T-Displays mussten einmal am Gerät neu gestartet werden, weil sie auf der Fehlerseite hingen.

## Geprüft

- Unit-Test für das Verhalten bei fehlgeschlagenem Datenabruf (`tests/player-data.test.ts`).
- Lokal im Browser mit dem echten Player und beiden Folien: 20 Aktualisierungen mit gleichen Daten ändern auf der Seite nichts mehr; geänderte Daten werden weiter angezeigt; der Neuaufbau tauscht die Folie sauber gegen eine gleiche, die alte wird entfernt; der Statusfilter des Dashboards funktioniert.
- Nach dem Deploy laden die Displays den neuen Player und melden keine Fehler.

## Nachtrag 11.11.2026, 17 Uhr: Neuaufbau hilft nicht

Am Nachmittag waren A 2.11 IT-Büro oben und T 1.00 Flur wieder weiß, alle Untis-Displays meldeten „Failed to fetch“. A 1.00 Flur Verwaltung (wechselnde Folien) meldete sich seit 15:45 nicht mehr per Heartbeat.

- Das Airtame-Log von A 2.11 oben von 13:18 zeigt: Mit dem neuen Player (`index-jeAWSoku.js`) wächst `kbcached` nach dem Neuladen um 10:50 weiter gleichmäßig um rund 16 MB pro Minute und ist um 11:55 voll. Kein Abfall zu den vollen fünf Minuten. Der Neuaufbau gibt den Speicher also nicht frei, und auch das seltenere Neuzeichnen hat am Tempo nichts geändert. Die Erklärung über das Neuzeichnen ist damit widerlegt; die Ursache läuft unabhängig davon ständig.
- Das 2-Stunden-Neuladen hat auf keinem Untis-Display gegriffen: Alle hatten um 17 Uhr noch die Sitzung von 10:48. Ein Neuladen-Befehl aus dem Admin kam an (`connected: 1`), änderte aber nichts. Ist der Speicher voll, kann sich die Seite nicht mehr selbst neu laden. Entweder scheitert die Prüfung, ob der Server antwortet, oder der Browser verwirft das Neuladen; danach blieb `reloading` für immer gesetzt.
- Folge: Neu laden muss das Display, bevor der Speicher voll ist. Deshalb jetzt alle 40 Minuten auf Airtame (siehe Tabelle). Hängende Geräte müssen einmal über Airtame Cloud oder am Gerät neu gestartet werden.

## Offen

- Was den Speicher füllt, ist weiter offen. Es betrifft wahrscheinlich nicht nur Untis-Folien (A 1.00 Flur Verwaltung). Der Fortschrittsbalken ist es vermutlich nicht: wp-foyer hatte auch einen und lief auf denselben Geräten ohne Leck. Gesucht ist etwas, das Foyer 2.0 anders macht als wp-foyer und das ständig läuft. Eingrenzen lässt es sich nur am Gerät: einzelne Teile auf einem Display abschalten und `kbcached` im Airtame-Log vergleichen.
- Ob das Neuladen alle 40 Minuten zuverlässig greift: im nächsten Log sollte `kbcached` ein Sägezahn sein, der nie über etwa 900 MB steigt, und im Admin sollte sich `device.since` alle 40 Minuten ändern.

## Airtame-Log lesen

Das Log kommt als ZIP aus Airtame Cloud. Hilfreich sind:

- `statistics/ram.txt`: Speicher alle 5 Minuten (UTC). `kbcached` ist der gemeinsame Speicher, `kbavail` der freie.
- `airtame-browser.txt`: Browser-Log. Konsolenausgaben des Players stehen dort als `console message from https://foyer.lgsit.de/player/assets/…` mit dem Präfix `[foyer]`.
- `journal-errors.txt`: Systemfehler, auch Neustarts des Geräts (`-- Boot …`).
