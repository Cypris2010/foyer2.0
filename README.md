# Foyer 2.0

Eigenständige Digital-Signage-Lösung für Schulen: Neubau von [wp-foyer](https://github.com/Cypris2010/wp-foyer) ohne WordPress, ausgelegt auf Airtame-2-Player.

- **Konzept:** [KONZEPT.md](KONZEPT.md)
- **Geräte-Probe für Airtame:** [apps/probe](apps/probe/README.md), zum Testen in der Schule

## Aufbau

| Ordner | Inhalt |
|---|---|
| `apps/probe` | Diagnoseseite + Mini-Server für Gerätetests (ohne Abhängigkeiten) |
| `apps/server` | API, Schedule-Auflösung, Player-Manifest, Live-Updates |
| `apps/player` | Player für die Displays (kleines Bundle, ES2017) |
| `apps/admin` | Verwaltungsoberfläche |
| `packages/slide-sdk` | Vertrag für Folientypen |
| `slide-types/*` | ein Ordner pro Folientyp |

Voraussetzung: Node.js ≥ 24 und für die Mediathek `ffmpeg`/`ffprobe` (macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`).

## Entwicklung

```bash
npm install
npm run build                                   # Player + Admin bauen
npm run cli -w @foyer/server -- test:seed       # Testkonten, Demo-Folien, zwei Displays
npm start                                       # http://127.0.0.1:8080/admin/
```

Nach einem Update (`npm run build` und Server-Neustart) laden die Displays den neuen Player selbst, an der nächsten Foliengrenze. Nur Displays, die noch einen Player von vor dieser Funktion laufen haben, muss man einmal über „Neu laden“ anstoßen.

Mit `test:seed --reset` beginnt man mit einer leeren lokalen Datenbank. Läuft auf Port 8080 schon etwas anderes, beide Befehle mit `FOYER_PORT=8088` aufrufen.

**Testkonten** (nur für lokale Tests; die Passwörter sind öffentlich, der Server warnt beim Start, solange sie existieren):

| Rolle | E-Mail | Passwort |
|---|---|---|
| admin | `admin@test.local` | `test-admin-1234` |
| editor | `redaktion@test.local` | `test-redaktion-1234` |
| viewer | `ansicht@test.local` | `test-ansicht-1234` |

Für eine echte Installation stattdessen eigene Konten anlegen:

```bash
npm run cli -w @foyer/server -- user:create vorname.nachname@schule.de "Vorname Nachname" admin
```

Konfiguration über Umgebungsvariablen (siehe `apps/server/src/config.ts`):

| Variable | Standard | Zweck |
|---|---|---|
| `FOYER_HOST` / `FOYER_PORT` | `127.0.0.1` / `8080` | Nur lokal lauschen, nach außen über TLS-Reverse-Proxy |
| `FOYER_DATA_DIR` | `./data` | SQLite-Datenbank und `token.key` (Schlüssel für die gespeicherten Display-URLs) |
| `FOYER_TOKEN_KEY` | – | Alternativ zu `token.key`: 32 Bytes base64. Geht der Schlüssel verloren, müssen alle Display-URLs neu erzeugt werden. |
| `FOYER_PLAYER_NETWORKS` | private Netze | Netze, aus denen Displays zugreifen dürfen (CIDR, kommagetrennt) |
| `FOYER_TRUSTED_PROXIES` | `127.0.0.1,::1` | Nur von diesen Adressen wird `X-Forwarded-For` beachtet |
| `FOYER_TIMEZONE` / `FOYER_LOCALE` | `Europe/Berlin` / `de-DE` | Zeitzone und Sprache |
| `FOYER_MEDIA_MAX_MB` | `2048` | Größte erlaubte Upload-Datei |
| `FOYER_FFMPEG` / `FOYER_FFPROBE` | `ffmpeg` / `ffprobe` | Pfade, falls nicht im `PATH` |
| `FOYER_FFMPEG_NDI` | `/opt/ffmpeg-ndi/bin/ffmpeg`, falls vorhanden | Eigenes ffmpeg mit NDI-Eingang (siehe „Deployment“) |
| `FOYER_MEDIAMTX` | `/opt/mediamtx/mediamtx`, falls vorhanden | Streaming-Server für Live-Folien (im Docker-Image enthalten) |
| `FOYER_LIVE_PORT` | `8189` | WebRTC-Bild der Live-Folien (UDP, ersatzweise TCP); muss von den Displays erreichbar sein |
| `FOYER_LIVE_HOSTS` | – | Zusätzliche Adressen, die den Displays fürs Bild genannt werden (z. B. die LAN-IP, wenn der Server hinter NAT läuft) |
| `FOYER_NDI_EXTRA_IPS` | – | NDI-Sender in anderen Subnetzen (dorthin reicht mDNS nicht) |
| `FOYER_LIVE_LOCAL_PORTS` | `18550` | Erster von drei Ports, die der Streaming-Server nur auf 127.0.0.1 belegt |

### Live-Video

Die Folie **Live-Video** zeigt eine NDI-Quelle oder eine Stream-Adresse (RTSP-Kamera, SRT, RTMP, HLS, UDP) mit unter einer Sekunde Verzögerung. Im Admin wählt man bei NDI die Quelle über „Quellen suchen“ aus der Liste der Quellen, die der Server sieht.

- **Weg zum Display:** WebRTC. Die Geräte-Probe hat auf Airtame 2 gemessen, dass das sauber läuft (720p30: 0,7 % verworfene Bilder), HLS über MediaSource dagegen nicht. Standard ist deshalb **720p30**; 1080p30 geht, verliert auf Airtame aber ca. 5 % der Bilder.
- **Auf dem Server** wandelt [MediaMTX](https://github.com/bluenviron/mediamtx) mit ffmpeg jede Quelle in H.264 Baseline (+ Opus bei „Mit Ton“) um. Mehrere Folien mit derselben Quelle teilen sich eine Umwandlung, und sie läuft nur, solange ein Display oder eine Vorschau zuschaut (danach noch 30 s).
- **Zugriff:** Die Displays holen das Bild über eine signierte Adresse aus ihrem Manifest, nur aus den Schulnetzen; Admin-Vorschauen brauchen eine Anmeldung. Der Streaming-Server selbst ist nur über Foyer erreichbar, offen ist allein der Bild-Port `FOYER_LIVE_PORT`.
- **Fällt die Quelle aus**, zeigt die Folie „Live-Bild nicht verfügbar · neuer Versuch …“ und verbindet neu, sobald die Quelle zurück ist (oder überspringt die Folie, je nach Einstellung).
- **Firewall:** Displays → Server **8189 UDP** (oder TCP). Bei NDI zusätzlich Server ↔ NDI-Quellen (mDNS 5353 UDP, NDI 5960 ff. TCP).


### Deployment (Docker)

Ein Image mit Server, Admin und Player. `deploy/compose.yaml` startet es hinter einem TLS-Reverse-Proxy auf demselben Host:

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec foyer node apps/server/src/cli.ts user:create vorname.nachname@schule.de "Vorname Nachname" admin
```

Die Daten (Datenbank, `token.key`, Medien) liegen im Volume `foyer-data` unter `/data`.

**NDI als Live-Quelle (optional).** Das normale ffmpeg kann kein NDI mehr: Die ffmpeg-Entwickler haben den NDI-Baustein 2019 entfernt, und das NDI-SDK ist proprietär. Deshalb baut [`deploy/ffmpeg-ndi/build.sh`](deploy/ffmpeg-ndi/build.sh) ein **zweites** ffmpeg nach `/opt/ffmpeg-ndi`: ffmpeg 5.1 mit dem Community-Patch [lplassman/FFMPEG-NDI](https://github.com/lplassman/FFMPEG-NDI) (auf einen Commit festgelegt) und dem NDI-SDK 6. Die Mediathek nutzt weiter das normale ffmpeg; bricht der NDI-Build, ist nur NDI betroffen.

```bash
docker compose -f deploy/compose.yaml build --build-arg FOYER_NDI=1 --build-arg NDI_LICENSE=accept
docker compose -f deploy/compose.yaml exec foyer node apps/server/src/cli.ts ndi:sources
```

- `NDI_LICENSE=accept` bestätigt die [NDI-SDK-Lizenz](https://docs.ndi.video/docs/sdk/licensing). Ohne das bricht der Build ab.
- So ein Image enthält ein **nonfree-ffmpeg und das NDI-SDK**: auf dem eigenen Server nutzen, **nie in eine öffentliche Registry pushen** oder weitergeben. Andere Schulen bauen ihr Image selbst.
- NDI findet Quellen per mDNS/Multicast über den **avahi-daemon des Hosts** (`apt install avahi-daemon`; die Compose-Datei bindet dafür `/run/dbus` ein). Der Container läuft deshalb mit `network_mode: host`, und der Server muss im selben Netz wie die NDI-Quellen stehen. Quellen in anderen Subnetzen trägt man in `FOYER_NDI_EXTRA_IPS` ein (testen mit `ndi:sources 10.48.20.5,10.48.20.9`); das geht auch ohne Avahi.
- Ohne Docker auf Debian/Ubuntu: `sudo NDI_LICENSE=accept deploy/ffmpeg-ndi/build.sh`.
- Beim Start meldet der Server `NDI-Eingang verfügbar`, wenn er das NDI-ffmpeg gefunden hat.

### Mediathek

Bilder und Videos lädt man im Admin unter **Medien** hoch und nutzt sie als Folienhintergrund (Bild oder Video, mit Abdunkeln) oder in der **Videofolie**. Die Videofolie läuft so lange wie das Video und schaltet am Ende weiter; trägt man eine Dauer ein, läuft das Video bis dahin in Schleife. Ton gibt es nur, wenn die Folie „Mit Ton“ hat **und** beim Display „Ton erlaubt“ an ist (z. B. Aula ja, Flure nein); Vorschauen im Admin bleiben stumm. Der Server prüft den Dateityp am Inhalt und wandelt alles für die Displays um:

- **Bilder** → höchstens 1920 px an der langen Seite (JPEG, mit Transparenz PNG) plus Vorschaubild.
- **Videos** → H.264 High mit AAC, MP4 mit `faststart`, höchstens 1080p bei ≤ 30 fps und ca. 5 Mbit/s, dazu eine 720p-Variante und ein Posterbild. Das ist das Profil, das die Airtame-Probe bestätigt hat (1080p60 verliert dort die Hälfte der Bilder).

Die Dateien liegen unter `FOYER_DATA_DIR/media` (`originals/` für die Uploads, `files/` für die umgewandelten Dateien mit Inhalts-Hash im Namen). Ausgeliefert werden sie unter `/media/…` nur ins Schulnetz (`FOYER_PLAYER_NETWORKS`) und an angemeldete Benutzer. Dateien, die eine Folie noch nutzt, lassen sich nicht löschen.

### WebUntis: Raumanzeige und Lehrkräfte-Dashboard

Die beiden Folien sind 1:1 aus wp-foyer übernommen (gleiche Darstellung, Beschriftungen und Optionen). Neu ist, wo die Daten herkommen:

- Die **Datenquelle** (Adresse des Untis-TXT-Exports, `raeume_ganzer_tag.txt` bzw. `lehrer.txt`) wird pro Folie eingetragen; im Code steht keine Adresse.
- Der **Server** holt den Export (geteilter Cache, Timeout, höchstens 5 MB), filtert ihn auf die gewählten Räume bzw. Lehrkräfte und schickt den Playern nur diese Zeilen. Die Daten liegen nur im Arbeitsspeicher, nie in der Datenbank oder im Log. Auch das Manifest enthält sie nicht (der Player speichert es für den Kaltstart): Der Player holt die Zeilen über eine signierte URL (`/content/data/…`, nur Schulnetz bzw. Admin-Sitzung) und hält sie nur im Speicher. Folientypen markieren das mit `personalData: true`. Fällt die Quelle aus, zeigen die Folien bis zu eine Stunde lang den letzten Stand.
- Ändern sich die Daten, merkt das der Server (Takt 15 s, je nach Folie alle 30–120 s neu geholt) und meldet es den Displays. Die laufende Folie bekommt die neuen Zeilen über `update()`, ohne neu aufgebaut zu werden.
- Räume und Lehrkräfte wählt man im Admin aus einer Liste, die aus der eingetragenen Quelle kommt.

Die Quelle ist austauschbar ([`slide-types/_untis/source.ts`](slide-types/_untis/source.ts)): Eine spätere WebUntis-API-Quelle liefert dieselben Zeilen, die Folien bleiben unverändert.

Tests:

```bash
npm test                                         # Unit- und API-Tests (Sicherheitsregeln, Manifest, HTML-Folie, Untis)
npm run typecheck
node tests/e2e/player-smoke.ts <player-url>      # Player in echtem Chrome (braucht Google Chrome)
node tests/e2e/untis-compare.ts <foyer-url> <wp-foyer-checkout> <out-dir>   # Untis-Folien alt gegen neu
```

Die Testdaten in `tests/fixtures/untis/` sind anonymisierte echte Exporte: Namen, Kürzel, Klassen und Texte sind ersetzt, Zeiten und Status unverändert.

### Neuen Folientyp anlegen

Ordner `slide-types/<id>/` mit `index.ts` (Definition + Zod-Schema) und `render.ts` (Darstellung), optional `server.ts` und `style.css`. Server, Admin-Formular und Player finden ihn automatisch. Beispiele: [`slide-types/text`](slide-types/text), [`slide-types/html`](slide-types/html).
