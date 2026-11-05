# Foyer Geräte-Probe (Airtame-Test)

Diagnoseseite, die auf einem Player (z. B. Airtame 2) misst, was Foyer 2.0 braucht: Browser-Version, APIs, Speicher über Neustarts, Video-Wiedergabe und Animations-Leistung. Jeder Durchlauf schickt einen JSON-Bericht an den Probe-Server. Die Probe braucht am Gerät keine Eingabe.

Die Testclips (`public/clips/*.mp4`) liegen im Repo, ffmpeg wird zum Testen **nicht** gebraucht.

## In der Schule starten

Voraussetzung: ein Rechner oder Server im Schulnetz, den die Airtames erreichen (gleiches Netz/VLAN oder freigegebene Firewall-Regel).

### Variante A: mit Node.js (≥ 24)

```bash
git clone https://github.com/Cypris2010/foyer2.0.git
cd foyer2.0
node apps/probe/server.ts
```

Kein `npm install` nötig, der Server nutzt nur Node-Bordmittel. Standard-Port ist 8090 (`PORT=9000 node apps/probe/server.ts` ändert ihn).

### Variante B: mit Docker

```bash
git clone https://github.com/Cypris2010/foyer2.0.git
cd foyer2.0
docker build -f apps/probe/Dockerfile -t foyer-probe .
docker run --rm -p 8090:8090 -v "$PWD/probe-reports:/data" foyer-probe
```

### Variante C: mit Live-Test (Docker, empfohlen)

Für den Live-Video-Test läuft neben der Probe ein kleiner Streaming-Server ([MediaMTX](https://github.com/bluenviron/mediamtx)) mit einem bewegten Testbild. Er liefert es so aus, wie Foyer später Live-Quellen an die Displays gibt: per **WebRTC** und per **HLS**.

```bash
git clone https://github.com/Cypris2010/foyer2.0.git
cd foyer2.0
docker compose -f apps/probe/live/compose.yaml up -d --build
```

Beide Container laufen im Host-Netz (Linux). Die Airtames müssen diese Ports des Servers erreichen: **8090** (Probe), **8888** (HLS), **8889** (WebRTC-Anmeldung) und **8189 UDP**, ersatzweise TCP (WebRTC-Bild). Läuft der Live-Server auf einem anderen Rechner, gibt man ihn an: `?whep=http://<ip>:8889&hls=http://<ip>:8888`.

Ohne Live-Server läuft die Probe wie bisher und meldet „Live-Testquelle: nicht erreichbar“. Der MediaSource-Test mit einem aufgezeichneten Clip läuft trotzdem.

## Auf dem Airtame aufrufen

1. In Airtame Cloud beim Gerät eine Playlist mit **Website** anlegen. URL: `http://<IP-des-Servers>:8090/?device=<name>`, z. B. `?device=aula-1`. Reload-Intervall leer lassen.
2. Der Test läuft automatisch etwa 3 Minuten (Animationen, 6 Videos, Live-Video, Autoplay) und zeigt die Ergebnisse groß auf dem Bildschirm. Ein Foto davon schadet nicht. Mit `&only=live` laufen nur die Live-Tests (gut 1 Minute).
3. **Neustart-Test:** Danach den Airtame neu starten (Airtame Cloud oder App) und die Seite erneut laufen lassen. Im zweiten Bericht (Lauf #2) steht, ob `localStorage`, Cookie, IndexedDB und Cache den Neustart überlebt haben.
4. Optional: Nach einer Bildschirmfreigabe prüfen, ob die Seite neu lädt (der Laufzähler steigt dann).
5. Optional als Dauertest: `?device=aula-1&repeat=30` startet alle 30 Minuten neu.

### Was der Live-Test misst

| Test | Frage dahinter |
|---|---|
| **Live-Fähigkeiten** | Gibt es MediaSource (für HLS über hls.js), WebRTC mit H.264 und Hardware-Dekodierung? |
| **MSE: 1080p30 Clip** | Spielt das Gerät H.264 ruckelfrei ab, wenn es Stück für Stück über MediaSource kommt? Das ist der Weg, den HLS nimmt, hier noch ohne Netzwerk. |
| **WebRTC: 1080p30 / 720p30 live** | Verzögerung unter 1 s. Gemessen werden verworfene Bilder, Aussetzer („eingefroren“), Puffer in ms, UDP oder TCP und der Decoder. |
| **HLS (MSE): 1080p30 live** | Der robustere Weg mit einigen Sekunden Verzögerung. „s im Puffer“ zeigt, wie weit das Bild hinter live liegt. |

Grün heißt: unter 1 % verworfen, keine Aussetzer. Für Foyer ist **WebRTC** der Wunschweg. Läuft es auf dem Airtame nicht sauber, aber HLS schon, wird HLS der Standard.

## Ergebnisse ansehen

- Übersicht: `http://<IP-des-Servers>:8090/reports`
- Rohdaten: `http://<IP-des-Servers>:8090/api/reports` bzw. die Dateien in `apps/probe/reports/` (Docker: `probe-reports/`)

Mit `PROBE_KEY=geheim node apps/probe/server.ts` sind die Berichte nur noch mit `?key=geheim` lesbar. Die Geräte senden trotzdem ohne Schlüssel.

## Hinweise

- **Service Worker** funktionieren nur über HTTPS (oder `localhost`). Über `http://` meldet die Probe „Service Worker: nein/Fehler“, auch wenn das Gerät sie eigentlich kann. Für ein vollständiges Ergebnis die Probe hinter einen HTTPS-Reverse-Proxy mit gültigem Zertifikat stellen, wie später Foyer selbst.
- Die Berichte enthalten nur Geräte- und Browserdaten sowie die IP-Adresse des Geräts, keine personenbezogenen Daten.
- Testclips neu erzeugen (nur bei Änderungen, braucht ffmpeg): `sh apps/probe/scripts/make-clips.sh`
