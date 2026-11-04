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
