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

Voraussetzung: Node.js ≥ 24.

## Entwicklung

```bash
npm install
npm run build                                   # Player + Admin bauen
npm run cli -w @foyer/server -- test:seed       # Testkonten, Demo-Folien, zwei Displays
npm start                                       # http://127.0.0.1:8080/admin/
```

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

Tests:

```bash
npm test                                         # Unit- und API-Tests (Sicherheitsregeln, Manifest, HTML-Folie)
npm run typecheck
node tests/e2e/player-smoke.ts <player-url>      # Player in echtem Chrome (braucht Google Chrome)
```

### Neuen Folientyp anlegen

Ordner `slide-types/<id>/` mit `index.ts` (Definition + Zod-Schema) und `render.ts` (Darstellung), optional `server.ts` und `style.css`. Server, Admin-Formular und Player finden ihn automatisch. Beispiele: [`slide-types/text`](slide-types/text), [`slide-types/html`](slide-types/html).
