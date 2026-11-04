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

## Auf dem Airtame aufrufen

1. In Airtame Cloud beim Gerät eine Playlist mit **Website** anlegen. URL: `http://<IP-des-Servers>:8090/?device=<name>`, z. B. `?device=aula-1`. Reload-Intervall leer lassen.
2. Der Test läuft automatisch etwa 2 Minuten (Animationen, 6 Videos, Autoplay) und zeigt die Ergebnisse groß auf dem Bildschirm. Ein Foto davon schadet nicht.
3. **Neustart-Test:** Danach den Airtame neu starten (Airtame Cloud oder App) und die Seite erneut laufen lassen. Im zweiten Bericht (Lauf #2) steht, ob `localStorage`, Cookie, IndexedDB und Cache den Neustart überlebt haben.
4. Optional: Nach einer Bildschirmfreigabe prüfen, ob die Seite neu lädt (der Laufzähler steigt dann).
5. Optional als Dauertest: `?device=aula-1&repeat=30` startet alle 30 Minuten neu.

## Ergebnisse ansehen

- Übersicht: `http://<IP-des-Servers>:8090/reports`
- Rohdaten: `http://<IP-des-Servers>:8090/api/reports` bzw. die Dateien in `apps/probe/reports/` (Docker: `probe-reports/`)

Mit `PROBE_KEY=geheim node apps/probe/server.ts` sind die Berichte nur noch mit `?key=geheim` lesbar. Die Geräte senden trotzdem ohne Schlüssel.

## Hinweise

- **Service Worker** funktionieren nur über HTTPS (oder `localhost`). Über `http://` meldet die Probe „Service Worker: nein/Fehler“, auch wenn das Gerät sie eigentlich kann. Für ein vollständiges Ergebnis die Probe hinter einen HTTPS-Reverse-Proxy mit gültigem Zertifikat stellen, wie später Foyer selbst.
- Die Berichte enthalten nur Geräte- und Browserdaten sowie die IP-Adresse des Geräts, keine personenbezogenen Daten.
- Testclips neu erzeugen (nur bei Änderungen, braucht ffmpeg): `sh apps/probe/scripts/make-clips.sh`
