# Foyer 2.0 – Rebuild-Konzept (ohne WordPress)

Basis: Analyse von `Cypris2010/wp-foyer` (Stand `f6102f9`, 02.11.2025, Version `2.0.0.alpha`).
Ziel: Funktionsgleicher, eigenständiger Neubau mit (1) sehr leicht ergänzbaren Folientypen und (2) einer robusten Video-Strategie.

---

## 1. Was wp-foyer heute kann (Funktionsinventar)

### 1.1 Kernobjekte

| Objekt | Funktionen heute | WP-Abhängigkeit |
|---|---|---|
| **Display** | Name, Standard-Channel, Fortschrittsbalken an/aus (`foyer_display_show_timer`), Remote-Reset (`foyer_reset_display` → Player lädt neu), öffentliche URL `/foyer/<slug>`, Admin-Grid mit Karten + Live-Vorschau, Pagination/Per-Page, Bulk-Aktionen, Legacy-Zeitplan pro Display | CPT `foyer_display` |
| **Channel** | Geordnete Slide-Liste (Hinzufügen/Entfernen/Drag-&-Drop per AJAX), Slide-Dauer, Übergang (`fade`/`slide`/`none`), Favorit (sortiert oben), **Zeitfenster pro Slide im Channel** (`foyer_channel_slide_windows`: start/end), Vorschau mit Seitenverhältnis | CPT `foyer_channel` |
| **Slide** | Format (Inhaltstyp) + Hintergrund (Bild / YouTube / HTML5-Video / keiner), Status published/draft | CPT `foyer_slide` |
| **Schedule** (zentral) | Channel → mehrere Displays; Einzeltermin **oder** Serie (RRULE `DAILY/WEEKLY/MONTHLY`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `UNTIL`/`COUNT`), `RDATE`, `EXDATE`, Overrides pro Vorkommen (Start/Dauer/Channel), Zeitzone, Serien- vs. Einzel-Bearbeitung, Konflikt-/Überlappungsprüfung, Vorschau der Vorkommen | CPT `foyer_schedule` |
| **Globaler Scheduler** | Kalender (EventCalendar) Woche/Monat/Liste, Farbe pro Display, Display-Filter, Termine per Klick/Drag anlegen, Vorlagen auf mehrere Displays anwenden, Air-Datepicker, Debug-Modus, Migration der Legacy-Zeitpläne | Admin-Seite + AJAX |

**Auflösungsregel aktiver Channel** (`Foyer_Display::get_active_channel`): Alle Vorkommen nach Start sortiert → das *zuletzt begonnene*, gerade laufende Vorkommen mit veröffentlichtem Channel gewinnt; sonst Standard-Channel. Danach filtert der Channel seine Slides nach Status + Slide-Zeitfenster.

### 1.2 Folientypen (Formate)

| Typ | Konfiguration | Besonderheit |
|---|---|---|
| `default` | – | nur Hintergrund |
| `text` | Pretitle, Titel, Untertitel, Inhalt, **QR-Code** (URL + ECC-Level, serverseitig als SVG) | |
| `iframe` | URL | |
| `post` | WP-Beitrag, Auszug ja/nein, Thumbnail | WP-Inhalt → wird zu „interne Meldung“ |
| `recent-posts` | Kategorien, Limit, Auszug, Thumbnail | **Stack** (1 Slide → n Slides) |
| `rss-feed` | Feed-URL, Limit, Cache-Minuten, Feed-Titel zeigen, Zoom-Präferenz, Bild-Extraktion (thumbnail/enclosure/media:content) | Stack |
| `calendar` | mehrere ICS-Feeds, Tage voraus, Titel, Cache | eigener ICS-Parser |
| `pdf` | PDF-Upload → Imagick rendert jede Seite als Bild | Stack |
| `teacher-dashboard` | WebUntis-TXT (Pipe), Lehrkräfte-Auswahl, Theme hell/dunkel, Legende/Statusfilter | Client-Polling 30 s |
| `webuntis-room-display` | WebUntis-TXT, Raum-Mehrfachauswahl, Refresh-Intervall (≥15 s), „Nächste“/„Aktuell“ ausblenden | Zusammenführen von Stunden (Lücke ≤ 5 min), Ausfall-Markierung (`cancelled`/`gone`), generische „Unterricht“-Marker filtern, max. 3 kommende, Uhr, Auto-Skalierung, Fallback-Datei |
| `production`, `upcoming-productions` | Theater-for-WP-Events | nur mit Theater-Plugin → **streichen** oder als ICS/JSON-Quelle neu |

Untis-Zeilenformat (Raumdatei): `raum|start|ende|räume|lehrer|klassen|fach|status|typ|text_vertretung|text_buchung`.

### 1.3 Querschnitt

- Vorschau im Admin: Querformat 16:9 / Hochformat 9:16, Wahl pro Nutzer und Objekt.
- Einstellungen: Datumsformat des Pickers, Hintergrund-Zoom (Ken-Burns), Scheduler-Debug, Login-Redirect auf Displays, Menü-Position, WP-Menüs für Nicht-Admins ausblenden.
- i18n: de_DE + POT.
- Rechte: nur WP-Capabilities `edit_posts` / `edit_post` / `manage_options`.

### 1.4 Player heute

- Server rendert **den kompletten Channel als HTML**, alle Slides gleichzeitig im DOM.
- Alle 5 min `jQuery.get(window.location)` → HTML wird geparst und verglichen (Klassen-String der Channel-Div), neue Slide-Gruppe wird angehängt (Gruppe 1/2 im Wechsel).
- Alle 8 h kompletter Reload. Ticker per `setTimeout` + jQuery-Events (`slide:becoming-active` usw.).

### 1.5 Schwachstellen, die der Rebuild beheben sollte

1. **Video** (siehe Kapitel 6): Jedes `<video preload="auto">` lädt sofort, weil alle Slides im DOM liegen; keine Transkodierung; „Slide halten“ läuft über 500-ms-Polling, das `next-slide` abfängt; YouTube hängt von IFrame-API, Netz und Autoplay-Regeln ab.
2. **Kein Offline-Betrieb**: Netz weg → Inhalte weg (außer bereits geladene).
3. **Änderungen kommen bis zu 5 min verzögert an**; ein Reset geht nur per Polling.
4. **WebUntis-Daten lädt der Browser direkt** von der Untis-Quelle → CORS-abhängig, die Quelle ist öffentlich sichtbar, und jedes Display fragt einzeln ab.
5. **RRULE-Engine selbst gebaut**: `COUNT` zählt nur Vorkommen *im Abfragefenster* (der Zähler `emitted` wird nur bei `intersects_window` erhöht) → Serien mit `COUNT` liefern je nach Fenster zu viele Termine. Außerdem fehlen „2. Dienstag im Monat“ (`BYSETPOS`/`BYDAY=2TU`), `YEARLY` usw.
6. **Folientyp-Erweiterung ist aufwendig**: Filter-Registrierung + Admin-Klasse (Metabox-HTML + Save + Nonce) + PHP-Template + eigenes JS/CSS + Script-Registrierung; die Meta-Keys sind über viele Dateien verteilt.
7. **Displays sind öffentliche URLs** ohne Token/Pairing.
8. Kein Display-Monitoring (online? welche Slide? Fehler?).

---

## 2. Zielplattform: Airtame 2

Die Player sind überwiegend **Airtame-2**-Geräte. Foyer läuft dort als **Website-App** (Airtame Cloud → Playlist → „Website“ mit unserer Player-URL). Das bestimmt viele Designentscheidungen.

### 2.1 Was wir über das Gerät wissen

| Thema | Fakt | Quelle |
|---|---|---|
| SoC | NXP i.MX6 Dual, 2× ARM Cortex-A9 @ 1 GHz, GPU Vivante GC2000 | Airtame Tech Spec (Nov 2020) |
| RAM | 2 GB (Airtame 1: 512 MB, Seitenlimit dort ~150 MB) | Tech Spec, Airtame Troubleshooting |
| Ausgabe | HDMI 1.4b, max. 1080p; Video laut Airtame bis ~60 fps@1080p | Airtame Help „Display videos as background“ |
| Browser | Chromium-basiert (abgeleitet aus Fehlermeldungen wie `err_name_not_resolved`), **Version unbekannt** | Airtame Troubleshooting |
| Nicht unterstützt | **WebGL**, Java, Flash, Silverlight; keine Eingabe → kein Login möglich | Airtame Troubleshooting |
| Voraussetzungen | öffentlich erreichbar ohne Login, `https://` (Reload-Intervall nur mit HTTPS), gültiges Zertifikat (sonst Schalter „Ignore Certificate Errors“), vom Airtame-VLAN aus erreichbar | Airtame Help |
| Caching | „limited content caching support“ | TrilbyTV-Doku zu Airtame |
| Ton | Website-App gibt Ton immer aus, stummschalten nur am TV | Airtame Help |
| Unterbrechung | Nach Reboot oder **nach jeder Bildschirmfreigabe** lädt die Seite neu von vorn | Airtame Help |

Quellen: [Tech Spec](https://airtame.com/wp-content/uploads/2020/11/Airtame-2-Technical-Specification-Nov-2020-EN.pdf) · [Website als Signage](https://help.airtame.com/hc/en-us/articles/5148470820893) · [Videos als Hintergrund](https://help.airtame.com/hc/en-us/articles/5339437517597) · [Troubleshooting](https://help.airtame.com/hc/en-us/articles/5340377300637) · [TrilbyTV auf Airtame](https://kb.trilbytv.co.uk/using-trilbytv-player-on-airtame)

### 2.2 Konsequenzen für Foyer

1. **Player muss schnell starten.** Weil jede Präsentation den Player neu lädt, sind Kaltstart und Wiedereinstieg der Normalfall. Ziel: < 3 s bis zur ersten Slide. Dafür ein winziges Bundle (Ziel < 80 KB gzip, kein React im Player), das letzte Manifest wird lokal gehalten, Assets haben Hash-Namen mit `Cache-Control: immutable`.
2. **Display-Identität steckt in der URL.** Ohne Eingabe gibt es kein Pairing am Gerät, und ob `localStorage` einen Reboot übersteht, ist offen. Daher pro Display eine URL mit nicht erratbarem Token, z. B. `https://foyer.schule.de/p/7Kq2…`, die man einmalig in Airtame Cloud einträgt. Das Pairing per Code bleibt für andere Geräte optional.
3. **Airtame-Playlist auf ein Element reduzieren.** Die Website-App zeigt nur Foyer, das Reload-Intervall bleibt **aus**: Foyer aktualisiert sich selbst per SSE, ein Airtame-Reload würde mitten in eine Slide schneiden. Die Zeitplanung macht Foyer, nicht Airtame Cloud.
4. **Server im Schulnetz (oder zumindest LAN-nah).** Videos und Bilder kommen bei jedem Neustart unter Umständen neu vom Server, weil der Cache begrenzt ist. Aus dem LAN ist das billig, über das Internet nicht. Ein gültiges TLS-Zertifikat ist Pflicht (Let's Encrypt per DNS-Challenge funktioniert auch für interne Hosts).
5. **Rendering-Budget für eine schwache CPU:**
   - Im DOM liegen nur aktive + nächste Slide.
   - Übergänge animieren nur `opacity`/`transform` (GPU-Compositing). Kein `filter: blur`, kein `backdrop-filter`, keine großen `box-shadow`-Animationen.
   - Kein WebGL und keine Canvas-Vollbildanimationen.
   - Ausnahme: Die WebUntis-Folien werden 1:1 übernommen, inklusive ihrer Skalierungslogik und ihres CSS (siehe 5.6).
6. **Ton immer explizit stumm**, außer eine Slide fordert ihn an (siehe 6.2 Punkt 6).
7. **Präsentationen erkennen:** Eine Heartbeat-Lücke mit anschließendem Kaltstart wird im Admin als „wahrscheinlich Bildschirmfreigabe“ angezeigt, nicht als Störung.
8. **Ältere JS-Engine einplanen:** Player auf ES2017 transpilieren und jede neuere API per Feature-Detection nutzen (Service Worker, Cache API, `EventSource` mit Polling-Fallback).

### 2.3 Erster Schritt: Geräte-Probe

Bevor Video- und Cache-Strategie festgezurrt werden, kommt eine **Diagnoseseite** `/probe`. Man trägt sie auf einem Airtame ein, und sie meldet an den Server:
- User-Agent bzw. Chromium-Version, Auflösung, `devicePixelRatio`
- Verfügbarkeit von Service Worker, Cache API, IndexedDB, OPFS, `EventSource`, WebSocket
- ob `localStorage` und Cache **einen Reboot überleben** (Marker setzen, Gerät neu starten, erneut prüfen)
- `canPlayType` für H.264 Baseline/Main/High, HEVC, VP9, AV1
- Testclips 720p30 / 1080p30 / 1080p60 bei 3, 5 und 8 Mbit/s, gemessen über `getVideoPlaybackQuality()` (verworfene Frames)
- Messung einer CSS-Übergangs- und HTML-Animationsszene (Frame-Zeiten per `requestAnimationFrame`)
- Speicherbudget (`performance.memory`, falls vorhanden)

Die Ergebnisse legen das Standard-Videoprofil und den Cache-Pfad fest. Umgesetzt in `apps/probe` (Anleitung: `apps/probe/README.md`).

---

## 3. Sicherheit und Datenschutz

Die WebUntis-Folien verarbeiten **personenbezogene Daten**: Namen bzw. Kürzel von Lehrkräften, An-/Abwesenheit, Vertretungen und Raumbelegungen mit Klassen. Daraus folgt: **kein Zugriff ohne Berechtigung, weder auf Admin noch auf Player-Daten noch auf die Quellen**. Sicherheit ist Teil von Phase 0, nicht ein späteres Extra.

### 3.1 Schutzziele und Grundsätze

- **Standardmäßig geschlossen:** Jede API verlangt eine Authentifizierung. Öffentlich sind nur Login-Seite, statische Player-Dateien (ohne Daten) und Health-Check.
- **Datenminimierung:** Ein Display bekommt nur die Daten seiner aktuellen Folien, bei WebUntis nur die Zeilen der ausgewählten Räume bzw. Lehrkräfte (siehe 3.4).
- **Keine Speicherung personenbezogener Daten auf Platte:** Untis-Daten liegen nur im Arbeitsspeicher-Cache des Servers (TTL ≤ Refresh-Intervall), nicht in der DB, nicht in Logs, nicht im Manifest und nicht im Offline-Cache des Players.
- **Verteidigung in der Tiefe:** Anwendungsschutz (Login/Token) **plus** Netzwerkschutz (nur Schulnetz) **plus** Transportverschlüsselung.

### 3.2 Admin-Zugang

- Eigene Benutzerkonten mit Rollen (`admin`, `editor`, `viewer`). Passwörter mit `scrypt` (Node-Bordmittel) gehasht, Mindestlänge 12.
- Sitzungen als zufällige Session-ID in einem Cookie `HttpOnly; Secure; SameSite=Strict`, serverseitig gespeichert, mit Ablauf (Leerlauf 8 h, absolut 7 Tage) und Logout überall.
- CSRF-Schutz: `SameSite=Strict` plus Prüfung von `Origin`/`Sec-Fetch-Site` bei allen schreibenden Requests.
- Login-Bremse: Rate-Limit pro IP und Konto, Sperre nach wiederholten Fehlversuchen, Protokollierung.
- Optional später SSO per OIDC (Schul-IdP) und TOTP als zweiter Faktor.
- Audit-Log: wer hat wann welche Folie, welchen Zeitplan oder welche Datenquelle geändert.

### 3.3 Player-Zugang (Airtame)

- Jedes Display hat ein zufälliges Token (256 Bit), rotierbar mit einem Klick (alte URL ist sofort tot).
- Gespeichert wird es zweifach: als SHA-256-Hash zum Nachschlagen und AES-256-GCM-verschlüsselt, damit Admins die URL jederzeit wieder anzeigen können („URL anzeigen“, nur Rolle `admin`, jeder Abruf im Audit-Log). Der Schlüssel liegt **außerhalb der Datenbank** (`data/token.key` mit Rechten 0600 oder `FOYER_TOKEN_KEY`). Eine Kopie von `foyer.sqlite` allein verrät also keine URLs; Schlüssel und DB-Backup getrennt aufbewahren.
- Das Token steht im URL-Pfad, weil Airtame keine Eingabe und keine Header erlaubt. Gegen Abfluss über die URL: `Referrer-Policy: no-referrer`, keine Tokens in Server-Logs (Logger maskiert `/p/<token>`), keine externen Ressourcen auf der Player-Seite.
- **Zweiter Faktor über das Netz:** Player-Endpunkte akzeptieren Anfragen nur aus konfigurierten Netzen (z. B. Airtame-VLAN als CIDR), global und optional pro Display. Ein geleaktes Token ist von außerhalb nutzlos.
- Player-Antworten mit `Cache-Control: no-store`, außer bei Hash-benannten Assets ohne Personenbezug.

### 3.4 WebUntis-Daten

- **Der Datenweg „über Foyer-Server“ ist Pflicht** (die Option „direkt“ aus 5.6 entfällt): Die Untis-Quelle ist nur für den Foyer-Server erreichbar, nicht für Browser.
- Zugangsdaten zur Quelle (z. B. Basic Auth, Token oder Client-Zertifikat) liegen nur serverseitig in den Einstellungen und werden nie an Player oder Admin-Frontend ausgeliefert.
- **Zeilenfilter auf dem Server:** Der Server liefert dem Display nur die **unveränderten Zeilen** der in der Folie gewählten Räume bzw. Lehrkräfte (Vergleich auf Spalte 0 mit derselben Normalisierung wie im Client). Die übernommene Client-Logik arbeitet darauf exakt wie bisher, die Ausgabe bleibt pixelgleich (Golden Tests prüfen das). Ausnahme: Lehrkräfte-Dashboard mit leerer Auswahl = alle, wie heute.
- **Befund im Altbestand:** Die Standardquellen `…/untisdata/lehrer.txt` und `…/raeume_ganzer_tag.txt` stehen fest im Code des öffentlichen wp-foyer-Repos. Falls sie ohne Anmeldung aus dem Internet abrufbar sind, sind Abwesenheitsdaten heute schon öffentlich. **Empfehlung:** Quelle sofort auf Zugriff nur aus dem Schulnetz bzw. vom Foyer-Server beschränken. Im neuen Repo stehen keine konkreten Quell-URLs, sie werden nur in den Einstellungen gepflegt.

### 3.5 Netzwerk und Betrieb

- Der Foyer-Server steht im Schulnetz und ist **nicht aus dem Internet erreichbar**. Admin-Zugriff von außen nur über VPN.
- Reverse Proxy (z. B. Caddy oder nginx) mit TLS und gültigem Zertifikat, HSTS; die App selbst lauscht nur auf `127.0.0.1`.
- Security-Header: strikte CSP für Admin und Player, `frame-ancestors 'none'` für Admin, `X-Content-Type-Options: nosniff`.
- HTML-Folien laufen in einer Sandbox ohne `allow-same-origin` (5.5), sie sehen weder Token noch API.
- Abhängigkeiten klein halten (Server nutzt Node-Bordmittel: `node:sqlite`, `node:crypto`), `npm audit` in CI, Container ohne Root.
- Backups der DB verschlüsselt; Untis-Daten sind darin nicht enthalten (3.1).

### 3.6 Datenschutz-Organisation

- Verzeichnis von Verarbeitungstätigkeiten und TOMs mit dem/der Datenschutzbeauftragten abstimmen; dieses Kapitel liefert die technische Grundlage.
- Transparenz: Information an das Kollegium, welche Daten auf welchen Bildschirmen erscheinen.
- Standort der Displays bedenken: Lehrkräfte-Dashboard nur auf Bildschirmen, die für Schüler und Besucher nicht einsehbar sind, falls Abwesenheitsgründe sichtbar werden. Das ist eine organisatorische Entscheidung, technisch unterstützt durch die Zuordnung Folie → Display.

---

## 4. Zielarchitektur

```
┌──────────────┐   REST/JSON    ┌──────────────────────────┐   SSE/WebSocket  ┌──────────────┐
│ Admin-SPA    │ ─────────────▶ │ Server (Node/TypeScript) │ ◀──────────────▶ │ Player (PWA) │
│ (Editor,     │                │  • API + Auth            │   Manifest +     │  • Ticker     │
│  Scheduler)  │                │  • Schedule-Resolver     │   Push-Events    │  • Cache/Off- │
└──────────────┘                │  • Slide-Type-Registry   │                  │    line       │
                                │  • Daten-Fetcher (RSS,   │  /media (HTTP    │  • Heartbeat  │
                                │    ICS, Untis) + Cache   │   Range)         └──────────────┘
                                │  • Media-Pipeline (ffmpeg│
                                │    , pdftoppm)           │
                                └──────────┬───────────────┘
                                           │
                                 SQLite (Standard) / Postgres
```

### Stack-Empfehlung

**TypeScript durchgehend.** Der Hauptgrund ist dein Erweiterungswunsch: Ein Folientyp braucht ein Admin-Formular, einen Renderer im Player und manchmal einen Daten-Fetcher auf dem Server. Wenn alle drei dasselbe Schema (Zod) teilen, ist ein neuer Typ *eine* Datei bzw. *ein* Ordner.

| Schicht | Wahl | Warum |
|---|---|---|
| Server | Node ≥ 24 (TypeScript direkt, ohne Build) + **Hono** | schlank, typisiert, SSE eingebaut |
| DB | **SQLite** über `node:sqlite` (Bordmittel, keine native Abhängigkeit) | eine Datei, Backup = Datei kopieren; reicht für hunderte Displays |
| Jobs | einfache DB-Queue im Prozess (oder BullMQ bei Bedarf) | Transkodierung, PDF-Rendering, Feed-Refresh |
| Admin | React + Vite, Formulare aus dem JSON-Schema der Folientypen generiert | umgesetzt (Grundgerüst) |
| Kalender | EventCalendar (vkurko, MIT) weiterverwenden | ist heute schon im Einsatz |
| Recurrence | **`rrule`** (bzw. `rrule-temporal`) statt eigener Engine | RFC 5545 komplett, behebt den COUNT-Bug |
| Player | Vanilla TS (ES2017), eigenes kleines Bundle; Service Worker nach Probe-Ergebnis | läuft auf schwachen Geräten (Pi, Fire TV, Smart TV) |
| Medien | ffmpeg/ffprobe, `pdftoppm` (poppler) statt Imagick | |
| Deployment | ein Docker-Image (Server + Admin + Player) | |

Alternative, falls du bei PHP bleiben willst: Laravel + Inertia. Das Folientyp-System geht dann auch, aber Schema und Renderer leben in zwei Sprachen. Deshalb empfehle ich es nicht.

---

## 5. Folientyp-System („Slide Types“) – leicht ergänzbar

### 5.1 Prinzip

Ein Folientyp ist **ein Ordner** unter `slide-types/`. Er wird automatisch gefunden (Vite `import.meta.glob` im Admin/Player, Dateisystem-Scan im Server). Es gibt keine zentrale Registrierungsliste, die man pflegen muss.

```
slide-types/
  text/
    index.ts        # Definition + Zod-Schema (Pflicht)
    render.ts       # Player-Darstellung, reines DOM ohne Framework (Pflicht)
    server.ts       # optional: Daten holen, Optionen liefern, Sandbox-Dokument
    style.css       # optional
    i18n.json       # optional
  webuntis-room/
  rss/
  ...
```

### 5.2 Vertrag (Typdefinition)

Umgesetzt in `packages/slide-sdk/src/index.ts`. Der Renderer ist bewusst **reines DOM** statt JSX: Der Player bleibt winzig (aktuell ~4 KB gzip), und die WebUntis-Module lassen sich 1:1 als `mount`/`unmount` einhängen.

```ts
export interface SlideTypeDefinition<S extends z.ZodType> {
  id: string;                           // = Ordnername
  name: string;
  category?: 'content' | 'media' | 'data' | 'school';
  config: S;                            // Zod-Schema → Admin-Formular + Validierung + Typen
  backgrounds?: BackgroundKind[] | false;
  defaultDuration?: number;
  keepAlive?: boolean;                  // im DOM halten (WebUntis, 5.6)
  editRole?: 'admin' | 'editor';        // HTML-Folien: nur Admins
}

export interface SlideServer<C, D> {
  data?(config: C, ctx: ServerContext): Promise<D> | D;  // serverseitig berechnen/holen, gecacht
  refreshSeconds?: number | ((config: C) => number);
  options?: Record<string, (config: Partial<C>, ctx) => Promise<Option[]>>;  // Auswahllisten
  document?(config: C, ctx): { html: string; csp: string };  // Sandbox-Dokument (HTML-Folie)
}

// Player: bekommt einen Container, liefert den Lebenszyklus zurück
export type SlideRenderer<C, D> = (root: HTMLElement, props: { config: C; data: D; ctx: PlayerContext; documentUrl?: string })
  => { prepare?(); start?(); stop?(); update?(data); destroy?() } | void;
```

Stack-Folien (eine Folie → n Folien, z. B. PDF-Seiten, RSS-Einträge) kommen als `expand`-Hook in Phase 4 dazu.

### 5.3 Beispiel: so klein wird ein neuer Typ

```ts
// slide-types/countdown/index.ts
export default defineSlideType({
  id: 'countdown',
  name: 'Countdown',
  config: z.object({
    title: z.string().describe('Titel'),
    target: z.string().datetime().describe('Zieldatum'),
    showSeconds: z.boolean().default(false),
  }),
  backgrounds: ['image', 'video', 'color'],
});

// slide-types/countdown/render.ts
export default defineRenderer((root, { config }) => {
  const node = document.createElement('div');
  root.appendChild(node);
  let timer: number;
  return {
    start: () => { timer = setInterval(() => (node.textContent = remaining(config.target)), 1000); },
    stop: () => clearInterval(timer),
  };
});
```

Das Admin-Formular entsteht aus dem Schema: `.describe()` liefert das Label. Spezial-Widgets kommen über Metadaten dazu, z. B. `z.string().meta({ widget: 'media', accept: 'image/*' })`, `widget: 'richtext'`, `widget: 'select', options: 'rooms'` (ruft `server.options.rooms` auf).

### 5.4 Gemeinsame Bausteine statt Copy-Paste

- **Hintergründe** sind ein eigenes, kleines Registry (`image`, `video`, `color`, `gradient`, später `stream`). Jeder Folientyp erlaubt eine Teilmenge davon.
- **Overlays** sind ein typübergreifender Baustein: QR-Code (heute nur bei `text`), Uhr, Logo, Laufschrift.
- **Daten-Fetcher-Helfer**: `fetchText(url, {cacheMinutes})`, `parseIcs`, `parseRss`, `parsePipeCsv`. Die beiden WebUntis-Folien behalten wegen der 1:1-Übernahme ihre eigenen, bestehenden Parser (5.6).
- **Schema-Versionierung**: `config` als JSON in der DB plus `version` im Manifest und optionale `migrate(old)`-Funktion.

### 5.5 Folientyp „HTML“ (mit Animationen)

Mit dieser Folie gestaltet man frei mit eigenem HTML, CSS und JS, inklusive CSS-Animationen, Web Animations API und SVG-Animationen.

**Erstellung**
- **Editor-Modus:** drei Felder HTML / CSS / JS (CodeMirror) mit Live-Vorschau in 16:9 und 9:16.
- **Paket-Modus:** ZIP-Upload (`index.html` + Assets, relative Pfade). Der Server entpackt nach `/content/html/<sha256>/`, und die Assets landen im Manifest, damit der Player sie wie Medien vorlädt.
- **Vorlagen** zum Kopieren, z. B. animierte Überschrift, Laufschrift, Countdown, Zahlen-Ticker, Logo-Reveal.
- **Medien aus der Mediathek:** `{{media:<id>}}` in HTML, CSS und JS wird zur signierten Adresse der umgewandelten Datei (`/media/<datei>?s=…`); die CSP erlaubt dafür `img-src`/`media-src 'self'`.
- **Platzhalter:** `{{date}}`, `{{time}}`, `{{display.name}}` und Werte aus dem Formular. Eigene Konfigurationsfelder lassen sich als kleines Schema an der Folie definieren, z. B. „Titel“ oder „Farbe“. Damit können Redakteure eine HTML-Vorlage befüllen, ohne Code anzufassen.

**Isolation**
- Rendert in `<iframe sandbox="allow-scripts">` **ohne** `allow-same-origin`. Das Iframe hat damit einen opaken Ursprung: Es kann weder auf Token/`localStorage` des Players noch auf die API zugreifen.
- Inhalte laufen idealerweise über eine eigene Content-Origin (z. B. `content.foyer.schule.de`). Eine CSP im Iframe erlaubt nur eigene Assets; externe URLs nur, wenn sie in der Folie freigegeben sind.
- Nur die Rolle `admin` bzw. ein Recht „HTML-Folien“ darf solche Folien anlegen oder ändern.

**Lebenszyklus (das Wichtige für Animationen)**

Der Player bereitet die nächste Slide vor, bevor sie sichtbar ist. Ohne Steuerung wären Animationen deshalb schon vorbei, wenn die Folie erscheint. Darum injiziert der Player eine winzige Runtime (`foyer-html-runtime.js`, < 2 KB) und steuert per `postMessage`:

| Nachricht | Wirkung im Iframe |
|---|---|
| `prepare` | Folie geladen, unsichtbar; `<html class="foyer-prepared">` |
| `start` | Folie wird sichtbar; Klasse `foyer-active`, Event `foyer:start` |
| `stop` | Folie verlässt die Anzeige; Klasse weg, Event `foyer:stop`, Animationen werden pausiert |
| ← `done` | optional: die Folie meldet „fertig“ und der Player schaltet weiter (z. B. nach Animationsende) |
| ← `error` | landet in der Telemetrie |

Wer nur CSS schreibt, braucht kein JS:

```css
.headline { opacity: 0; transform: translateY(40px); }
.foyer-active .headline { animation: rise 1.2s ease-out forwards; }
```

Mit JS: `foyer.onStart(() => tl.play())`, `foyer.onStop(() => tl.pause())`, `foyer.done()`.

**Dauer:** fest (Standard) oder „bis `done`“, mit Sicherheits-Timeout.

**Performance-Leitplanken für Airtame (im Editor angezeigt)**
- Nur `transform` und `opacity` animieren, kein WebGL, keine Blur- oder Filter-Animationen, keine Vollbild-Canvas.
- Die Vorschau zeigt beim Abspielen eine **Frame-Zeit-Anzeige**. Optional gibt es eine „Airtame-Drosselung“ (CPU-Throttling in der Vorschau), damit man schon am PC sieht, ob es ruckelt.
- Größenlimit für Pakete (z. B. 20 MB) und Warnung bei großen Bildern.
- Lottie- oder Rive-Animationen kommen als eigener Typ später. Auf dem i.MX6 erst per Probe prüfen, weil der SVG-Renderer von Lottie CPU-lastig ist.

### 5.6 WebUntis-Folien: 1:1-Übernahme

**Grundsatz:** Raumanzeige (`webuntis-room-display`) und Lehrkräfte-Dashboard (`teacher-dashboard`) werden **verhaltens- und pixelgleich** übernommen: gleiche Optionen, Texte, Logik, DOM-Struktur, Klassennamen und CSS. Es gibt kein Redesign und keine „Verbesserung“ der Darstellung. Einzige Ausnahmen: Ab drei Räumen zeigt die Raumanzeige kleinere Kacheln (`compact.ts`), weil die Karten dann die laufende Stunde abschneiden; die Karten bis zwei Räume bleiben pixelgleich. Räume, die genau dasselbe anzeigen würden, teilen sich eine Karte oder Kachel (`same-booking.ts`), etwa Aula I und Aula II bei einer gemeinsamen Veranstaltung.

**Umsetzung: Code übernehmen, nicht nachbauen**
- Die bestehenden Dateien `webuntis-room-display.js` (1249 Zeilen) und `teacher-dashboard.js` (508 Zeilen) kommen nahezu unverändert in die Folientyp-Ordner. Geändert wird nur die Hülle: Statt globalem `MutationObserver` + `DOMContentLoaded` exportiert jedes Modul `mount(node)` / `unmount(node)`. Das sind die vorhandenen `initInstance`/`destroyInstance`, die Logik darin bleibt Zeile für Zeile gleich.
- Das CSS (37 Regeln Lehrkräfte-Dashboard, 63 Regeln Raumanzeige) wird **unverändert** aus `public/css/foyer-public.css` übernommen (Z. 164–459 und 1191–1588). Achtung: Es existiert nur in der kompilierten Datei, nicht in den LESS-Quellen unter `raw/less`.
- **Auch der Rahmen muss gleich sein**, denn die Optik hängt nicht nur am Folien-CSS. Für diese Folien übernimmt der neue Player auch die Basis-Styles des alten Displays (`foyer-public.css` Z. 1–160: `body.single-foyer_display`-Regeln, Box-Sizing, Hintergrund) und die Schriftskalierung `html { font-size: calc(16 / 1080 * 100vmin) }` aus `foyer-public-slide.less`. Sie werden auf den Folien-Container begrenzt, damit sie andere Folientypen nicht beeinflussen. Falls `wp_head` dort zusätzlich Theme-CSS einbindet, wird das beim Golden-Test-Abgleich sichtbar und dann ebenfalls übernommen.
- Schrift: `system-ui`-Stack wie heute, also keine Webfonts. Auf Airtame rendert damit dieselbe Systemschrift wie bisher.
- Das Template erzeugt dasselbe Markup mit denselben `data-*`-Attributen und Texten wie die PHP-Templates.
- Ausnahme für Airtame: Die Performance-Leitplanken aus 2.2 gelten für **neue** Inhalte. Das WebUntis-CSS bleibt, wie es ist (inkl. `backdrop-filter: blur(7px)`). Erst wenn die Geräte-Probe dort echte Probleme zeigt, wird nachjustiert, und dann nur bei unverändertem Aussehen.

**Was sich unsichtbar ändert (nur Infrastruktur)**
1. **`keepAlive: true`** im Manifest beider Typen. Die Folien bleiben im DOM (versteckt) und pollen weiter, genau wie heute, wo alle Slides permanent im DOM liegen. Ohne das würde bei jedem Durchlauf kurz „Lade Belegungen …“ erscheinen. Das ist die einzige Ausnahme von „nur aktive + nächste Slide im DOM“.
2. **Datenweg immer über den Foyer-Server** (Datenschutz, siehe 3.4; der direkte Abruf durch den Browser entfällt). Der Server reicht die Datei **byteidentisch** durch und **leitet `Last-Modified`/`Date` weiter**, denn daraus berechnet die Raumanzeige „Aktualisiert um …“. Außerdem cacht er sie wenige Sekunden für alle Displays. Vorteile: kein CORS-Problem, die Quelle ist im Browser nicht sichtbar, und es gibt eine Abfrage statt einer pro Display.
3. **Auswahllisten im Admin** über `server.options` mit derselben Logik wie die PHP-Klassen und 5-Minuten-Cache.
4. Zeitzone und Locale kommen aus den Foyer-Einstellungen statt aus WordPress.

**Verhaltensspezifikation Raumanzeige** (wird zu Testfällen)

| Bereich | Verhalten heute (beizubehalten) |
|---|---|
| Optionen | Quelle (Standard `<untis-quelle>/raeume_ganzer_tag.txt`; leer → Fallback-Datei), Räume (Mehrfachauswahl), Refresh in s (Standard 60, min. 15), „Nächste Belegungen ausblenden“, „‚Aktuell‘-Überschrift ausblenden“ |
| Raumliste im Admin | eindeutige Werte aus Spalte 0, `natcasesort`, Cache 5 min, Fehlermeldungen wie heute; gespeicherte Auswahl bleibt bei Ladefehler erhalten |
| Format | `raum\|start\|ende\|räume\|lehrer\|klassen\|fach\|status\|typ\|text_vertretung\|text_buchung`, Datum `YYYY-MM-DD HH:MM` (lokal) |
| Parsing | Leerzeilen/ungültige Daten überspringen; Raum whitespace-normalisiert; entfällt, wenn Status `cancelled` oder `gone`; Titel = `Fach • Klassen`; Klassen mit `, ` |
| Zusammenführen | gleicher Raum + gleiche Lehrkräfte-Tokens + gleiche Klassen-Tokens + gleiches Fach, Überlappung oder Lücke ≤ 5 min; Texte mit ` • ` verbinden (außer schon enthalten); `cancelled` per ODER |
| Einteilung | nur Einträge mit Ende > jetzt; „aktuell“ = Start ≤ jetzt < Ende (mehrere möglich); „kommend“ = Start > jetzt, max. 3 |
| Raster | Spalten = min(⌈√n⌉, n), Zeilen = ⌈n/Spalten⌉ |
| Spalte | Raumname + Badge „Belegt“ (wenn ein nicht entfallener Eintrag läuft) bzw. „Frei“; Abschnitt „Aktuell“: Block aktive + Block entfallene, **Rotation alle 10 s** mit Overlay (180/420 ms); sonst „Der Raum ist aktuell frei.“; „Nächste Belegungen“ als Karten (bis 3 Spalten) oder „Keine weiteren Belegungen heute.“ |
| Details | `HH:MM – HH:MM`, Titel, „Lehrperson(en): …“, „Hinweis: …“ aus Typ • Vertretungstext • Buchungstext (generisches „Unterricht“ ausgefiltert) |
| Skalierung | pro Spalte Höhe/480, oberhalb 1 gedämpft (×0,35), begrenzt auf 0,5–1,4; ab 1,15 Klasse `--spacious`; neu bei Render und Resize |
| Kopf | Uhr `d.m.Y` / `H:i` in Schulzeitzone, minutengenau; „Aktualisiert um HH:MM“ aus `Last-Modified` → `Date` → jetzt |
| Fehler | „Daten konnten nicht geladen werden. (HTTP …)“; Polling läuft weiter; ohne Räume Hinweis „Bitte wählen Sie mindestens einen Raum …“ |

**Verhaltensspezifikation Lehrkräfte-Dashboard**

| Bereich | Verhalten heute (beizubehalten) |
|---|---|
| Optionen | Quelle (Standard `<untis-quelle>/lehrer.txt`), Lehrkräfte (leer = alle), Theme dunkel/hell, Legende ja/nein; Refresh **fest 30 s** |
| Auswahlliste | Schlüssel Spalte 0, Label „Kürzel – Name“ aus Spalte 4, sonst 3 (wenn nicht `-` und ungleich Kürzel), natürlich sortiert, Cache 5 min |
| Format | Zeilen mit ≥ 8 Spalten; 0 Lehrkraft, 1 Start, 2 Ende, 3/5/6 Zeilen 3–5 der Kachel, 7 Status |
| Datumsformate | `d.m.y(yy) H:i[:s]` (Tag/Monat-Heuristik), ISO, `d.m. H:i`, nur Uhrzeit (mit Folgetag-Regel bei < −12 h) |
| Status | Farben `bg-gone/nodata/irregular/none/cancelled`; `none` mit Start > 45 min in der Zukunft → `bg-future` |
| Kacheln | eine pro Lehrkraft (deutsche Sortierung, numerisch), Einträge nach Zeit; mehrere Einträge **rotieren alle 2 s**; Rotation und Refresh pausieren bei verstecktem Dokument |
| Legende | 5 Chips mit Anzahl (nach Lehrkräfte-Filter), bei 0 deaktiviert, Klick schaltet Statusfilter (alle an = kein Filter) |
| Raster | Spalten = round(√(n · B/H)); 1 Spalte bei ≤ 2 Kacheln und schmal/hochkant/Kachel < 520 px; Basisschrift = max(10, min(KachelB, KachelH) · 0,068) px |
| Fehler | Box „CSV konnte nicht geladen werden“ + Meldung |

**Gefundene Fehler: beheben nur, wenn unsichtbar**
- `teacher-dashboard.php`: Das Attribut `data-error-no-source="…'` wird mit `'` statt `"` geschlossen. Dadurch verschluckt es `data-theme` und liefert einen kaputten Fehlertext. Das Theme wirkt trotzdem, weil es zusätzlich als Klasse gesetzt wird → **beheben** (keine sichtbare Änderung).
- `buildUpcomingList` und `MAX_UPCOMING` sind ungenutzt (kommende Belegungen werden als Karten gerendert) → beim Übernehmen weglassen.
- „Keine weiteren Belegungen **heute**“, obwohl nicht nach Datum gefiltert wird → **beibehalten** (1:1).
- Die Fallback-Datei `public/js/raeume_ganzer_tag.txt` steht in `.gitignore` und fehlt im Repo → im neuen System optional als hochladbare Fallback-Datei pro Quelle.

**Abnahme (Golden Tests)**
- Fixture-Dateien aus echten (anonymisierten) Untis-Exporten: normaler Tag, Doppelstunden mit 5-min-Lücke, parallele Belegungen, Ausfälle (`cancelled`/`gone`), leerer Raum, 1/2/4/9 Räume, viele Lehrkräfte.
- **Eingefrorene Uhr** zu mehreren Zeitpunkten (vor Unterricht, mitten in der Stunde, in der Lücke, nach Schulschluss).
- Das alte Plugin läuft in `wp-env` (Konfiguration liegt im Repo), Playwright rendert alt und neu bei 1920×1080 und 1080×1920 → Pixel-Diff muss ≈ 0 sein. Zusätzlich werden die Ausgaben von `parseUntis`/`mergeEntries`/`buildRoomData` bzw. `parsePSV`/`sortGroups` direkt verglichen.

### 5.7 Optional später: Drittanbieter-Typen zur Laufzeit

Für den Start reicht „Ordner ins Repo, neu bauen“. Wenn Typen *ohne Rebuild* nachrüstbar sein sollen, lässt sich derselbe Vertrag als ESM-Bundle aus `/data/plugins` laden. Der Renderer läuft dann im Player per dynamischem `import()`, das Formular kommt weiter aus dem JSON-Schema (`zod-to-json-schema`). Das Interface ist von Anfang an darauf ausgelegt, die Funktion selbst kann warten.

---

## 6. Video-Strategie

### 6.1 Probleme heute

| Problem | Ursache im Code |
|---|---|
| Hohe Last und Ruckeln auf schwachen Playern | Alle Slides gleichzeitig im DOM, jedes `<video preload="auto">` puffert parallel |
| Videos laufen nicht oder stottern | Keine Transkodierung: HEVC/4K/hohe Bitraten vom Handy gehen 1:1 an den Player |
| Unsauberes Ende, Flackern am Start | „Slide halten“ per 500-ms-Polling; der Startpunkt wird erst nach `playing` gesucht (sichtbarer Sprung) |
| Ausfälle ohne Netz | Jede Runde wird vom Server gestreamt, nichts ist lokal |
| YouTube unzuverlässig | IFrame-API, Consent/Werbung, Autoplay-Policies, iOS Low-Power-Mode |
| Ton geht nicht | Browser-Autoplay-Policy (stumm Pflicht ohne Nutzergeste) |

### 6.2 Neue Strategie

**1. Upload-Pipeline (Server, Hintergrundjob)**
- `ffprobe` liest Dauer, Auflösung, Codec und Rotation; die Werte landen in der DB.
- `ffmpeg` erzeugt ein **Standardprofil**: H.264 (High, Level 4.1) + AAC, MP4 mit `+faststart`, max. 1080p30, ~5 Mbit/s. Zusätzlich eine **720p-Variante**; das Display-Profil wählt die Variante. Für Airtame 2 haben die Probe-Messungen (2.3) das Standardprofil bestätigt: Das Gerät stellt höchstens 30 fps dar, 1080p60 verliert ~50 % der Bilder, 1080p30 mit 5 Mbit/s nur ~4 %. 50/60-fps-Quellen werden deshalb auf 25/30 fps halbiert.
- Ein **Trim (Start/Ende) wird beim Transkodieren angewendet** und erzeugt einen eigenen Clip. Damit gibt es kein Seek beim Abspielen und die Dauer stimmt exakt.
- Ein Posterbild entsteht für Vorschau und als Standbild während des Ladens.
- Inhaltsbasierte Dateinamen (`<sha256>.mp4`) → unbegrenzt cachebar.

**2. Dauer ist deterministisch** (umgesetzt: Folientyp `video`, SDK-Feld `durationFromMedia`)
- Bei einer Video-Slide ist die Dauer standardmäßig gleich der Clip-Länge, weil die Dauer per ffprobe bekannt ist. „Slide halten“ ist damit kein Sonderfall mehr. Der Ticker plant mit der echten Dauer und schaltet zusätzlich beim `ended`-Event weiter (Sicherheitsnetz: Timeout = Dauer + 3 s).
- „Loop bis Slide-Dauer“ bleibt als Option für kurze Loops (Hintergrundvideos).

**3. Offline-first im Player**
- Der Player bekommt ein **Manifest** (JSON) mit allen Slides und Asset-Hashes. Der Service Worker lädt fehlende Assets **im Voraus** in Cache Storage bzw. OPFS und löscht verwaiste.
- Die Wiedergabe läuft aus dem lokalen Cache. Der Service Worker muss dafür `Range`-Requests bedienen (bekannte Falle bei Cache-API + `<video>`). Alternativ wird aus OPFS eine Blob-URL gebaut.
- Netzausfall → Player spielt den letzten Stand weiter und zeigt im Admin „offline seit …“.
- **Airtame-Sonderfall:** Laut Airtame ist das Caching begrenzt, und ob der Cache einen Reboot übersteht, ist offen (Probe). Deshalb gibt es zwei Stufen: (a) Service-Worker-Cache, wenn verfügbar und persistent; (b) sonst nur HTTP-Cache mit `immutable`-Assets plus Server im LAN. Dann ist ein erneuter Download nach dem Neustart kurz und billig. Große Videos gehen erst in die Rotation, wenn sie vollständig gepuffert sind (`canplaythrough`). Bis dahin wird die Slide übersprungen oder das Posterbild gezeigt.

**4. Nur zwei Videoelemente**
- Im DOM liegen nur die **aktive und die nächste** Slide. Das nächste Video wird ~5 s vorher muted mit `preload="auto"` vorbereitet und erst beim Übergang gestartet. RAM-Verbrauch bleibt so konstant, egal wie lang der Channel ist.

**5. YouTube/Vimeo/Streams als eigener Typ „Online-Video“**
- Klar gekennzeichnet: braucht Internet und ist nicht cachebar. Das Admin-UI empfiehlt bei eigenen Videos den Upload.
- Livestreams: umgesetzt als Folientyp `live` über WebRTC statt HLS. Die erweiterte Probe hat gezeigt, dass Airtame 2 WebRTC sauber abspielt (720p30: 0,7 % verworfene Bilder), MediaSource/HLS dagegen nicht (rund 37 % verworfen). Ein eigenes Live-Gateway (`apps/live-gateway`, eigener Container) wandelt jede Quelle (NDI, RTSP, SRT, RTMP, HLS, UDP) mit MediaMTX + ffmpeg in H.264 Baseline um, nur solange ein Display zuschaut; die Signalisierung (WHEP) läuft über Foyer mit signierter URL und geht mit der Quelle der Folie per gemeinsamem Schlüssel an das Gateway, das Bild dann direkt vom Gateway zum Display. Getrennt, damit das Gateway im AV-Netz stehen kann (NDI per mDNS), die Umwandlung Foyer nicht ausbremst und das Foyer-Image ohne nonfree-ffmpeg und NDI-SDK weitergegeben werden darf.

**6. Ton**
- Standard ist stumm. Der Player setzt `muted` auf jedem `<video>` explizit, weil Airtame Ton sonst immer ausgibt.
- Ton nur bei Slides mit „Ton an“ **und** Displays mit Flag „Ton erlaubt“, z. B. die Aula ja, Flure nein.
- Auf eigenen Kiosk-PCs: Browser mit `--autoplay-policy=no-user-gesture-required` starten. Ob Airtame Autoplay mit Ton zulässt, klärt die Probe.

**7. Telemetrie**
- Der Player meldet Wiedergabefehler (`MediaError`-Code), Stalls und Cache-Füllstand per Heartbeat. Im Admin sieht man dann pro Display, *welches* Video Probleme macht.

---

## 7. Player-Protokoll (ersetzt HTML-Polling)

1. **Identität**: Standard (Airtame) ist eine Display-URL mit Token `/p/<token>`, im Admin kopierbar und einmal in Airtame Cloud eingetragen. Das Token lässt sich rotieren. Für Geräte mit persistentem Speicher gibt es alternativ das Pairing: `/p` zeigt einen 6-stelligen Code, den der Admin einem Display zuweist.
2. `GET /api/player/manifest` → `{ version, display, channel, slides:[{id,type,config,data,duration,background,assets}], nextChange }`. Den aktiven Channel und die Slide-Fenster löst der Server auf. `nextChange` sagt dem Player, wann sich laut Zeitplan etwas ändert; er braucht also kein Polling dafür.
3. **SSE-Stream** `/api/player/events`: `manifest-changed`, `data-changed:<slideId>` (für RSS/Untis), `reload`, `identify` (Display blinkt kurz) und optional `screenshot`.
4. **Heartbeat** alle 30 s: aktuelle Slide, Version, Cache-Status, Fehler, Auflösung.
   - Zusätzlich meldet der Player **jeden Folienwechsel sofort** (`now-playing`). Die Live-Vorschau im Admin (`/p/preview-display/<id>`) folgt dieser Meldung per SSE und zeigt so dieselbe Folie wie das echte Display. Ist das Display nicht verbunden, spielt sie den Plan und kennzeichnet das sichtbar.
   - **Ein Gerät pro Display:** Jede Player-Seite schickt eine zufällige Sitzungs-ID. Die erste Sitzung hält das Display; andere Geräte bekommen `409` und eine Meldung. Dieselbe IP darf sofort übernehmen (Neuladen nach Bildschirmfreigabe), andere erst nach 90 s Stille. Admins können ein Gerät freigeben; es pausiert dann 2 min. Übernahmen landen im Audit-Log.
5. Der Ticker wechselt nur an Slide-Grenzen auf ein neues Manifest, ohne harten Schnitt. Das entspricht der heutigen Logik mit `foyer_ticker_shutdown`.

---

## 8. Datenmodell (Entwurf)

```
users(id, email, name, password_hash, role)            -- admin | editor | viewer
displays(id, name, default_channel_id, show_progress, orientation, profile, token_hash,
         last_seen_at, status_json, location, tags)
channels(id, name, transition, default_duration, is_favorite, published)
slides(id, title, type, type_version, config_json, background_json, duration, published,
       updated_at)
channel_slides(channel_id, slide_id, position, window_start, window_end)   -- Slide-Zeitfenster
schedules(id, title, channel_id, tz, dtstart_local, duration_s, rrule, rdates_json,
          exdates_json, start_utc, end_utc)
schedule_displays(schedule_id, display_id)                   -- statt serialisiertem Array + LIKE
schedule_overrides(schedule_id, occ_id, start_local, duration_s, channel_id)
media(id, sha256, kind, mime, size, width, height, duration_s, variants_json, poster, status)
data_cache(key, fetched_at, ttl, payload)                    -- RSS/ICS/Untis
settings(key, value_json)
audit_log(id, user_id, action, entity, entity_id, at, diff_json)   -- optional, nützlich bei mehreren Redakteuren
```

**Für „Split-Channels“ (im README geplant)** gleich vorsehen: `displays.layout_id` → `layouts(zones_json)` mit Zonen (z. B. 70/30 oder Haupt + Ticker), jede Zone mit eigenem Channel bzw. Schedule. Ohne Layout gilt eine Vollbild-Zone, das ist der heutige Stand.

---

## 9. Admin-Oberfläche (1:1-Abdeckung + Verbesserungen)

- **Displays**: Kachel-Grid mit Live-Vorschau, Online-Status, aktuelle Slide, „Neu laden“, „Identifizieren“, Pairing.
- **Channels**: Slide-Liste per Drag & Drop, Zeitfenster pro Slide (mit Status geplant/aktiv/abgelaufen wie heute), Dauer/Übergang, Favoriten, Vorschau 16:9/9:16.
- **Slides**: Typ-Auswahl als Kachelgalerie, schema-generiertes Formular mit Live-Vorschau daneben, Hintergrund-Auswahl.
- **Kalender** (umgesetzt, `apps/admin/src/ScheduleCalendar.tsx`, EventCalendar wie in wp-foyer): Woche/Monat/Liste, Farbe pro Display, Display-Filter, Termine per Klick oder Ziehen, Dialog mit Wiederholung (täglich, wöchentlich an Tagen, monatlich am Tag oder am n-ten Wochentag, Intervall, Ende nie/am/nach N), „Nur dieser Termin / Ganze Serie“, Verschieben per Drag & Drop (nur dieser Termin).
  - **Zwei Ebenen, ein Kalender:** Auf Displays plant man einen **Channel oder eine einzelne Folie**; im Channel plant man, **wann welche Folie läuft**. Eine Folie im Channel läuft **nur mit Termin** („unbefristet“ für dauerhaft).
  - **Regeln auf dem Display** (`apps/server/src/planning.ts`): Exklusive Termine zeigen nur sich selbst. Sonst ersetzt ein geplanter Channel den Standard-Channel; **mehrere gleichzeitig werden gekoppelt** (Folien nacheinander). Geplante Einzelfolien kommen zum laufenden Programm hinzu. Der Kalender markiert gekoppelte Termine.
  - Serien rechnen in Schulzeit (Wandzeit, DST-sicher) mit `rrule`; „endet nach N“ zählt ab Serienbeginn (in wp-foyer falsch). Ferien werden nicht berücksichtigt (bewusst entschieden).
  - Noch offen: Vorlagen auf mehrere Displays anwenden (wp-foyer „Templates“), Wochen-Zeitstrahl, „Vorschau für Zeitpunkt“.
- **Medienbibliothek** (umgesetzt, `apps/admin/src/Media.tsx`, Server `apps/server/src/media.ts`): Upload per Drag & Drop mit Fortschritt, Status und Fortschritt der Transkodierung, „Verwendet in“, Löschschutz für genutzte Dateien, Auswahl-Dialog mit Upload für Folienhintergründe (Bild/Video, Abdunkeln) und das Formular-Widget `widget: 'media'`.
- **Einstellungen**: Zeitzone, Datumsformat, Standarddauer/-übergang, Hintergrund-Zoom, Datenquellen-Proxy (Untis-URLs, die der Server durchreicht; die URL pro Folie bleibt wie heute), Rollen.
- Die WP-Sonderfälle (Login-Redirect, WP-Menüs ausblenden) entfallen, weil es ein eigenes Admin gibt.

---

## 10. Migration aus WordPress

Ein CLI-Importer (`foyer import-wp --db mysql://… --uploads /pfad`) liest `wp_posts`/`wp_postmeta` der Typen `foyer_display|channel|slide|schedule`:
- übernimmt die Meta-Keys pro Typ in `config_json` (Mapping-Tabelle je Folientyp, siehe 1.2),
- holt die Anhänge (`slide_bg_image_image`, `slide_pdf_file`, Videos) aus `wp-content/uploads` und schickt sie durch die neue Media-Pipeline,
- übernimmt zentrale und Legacy-Zeitpläne (`foyer_display_schedule`) sowie die Slide-Fenster,
- liefert einen Trockenlauf-Report, was nicht abbildbar ist (z. B. `production`-Slides).

---

## 11. Vorgeschlagene Phasen

| Phase | Inhalt | Ergebnis |
|---|---|---|
| **0 Fundament** | **Airtame-Probe-Seite (2.3) zuerst**, dann Monorepo (`server`, `admin`, `player`, `slide-sdk`, `slide-types`), DB-Schema, Auth, Docker | Messwerte vom Gerät + lauffähiges Gerüst |
| **1 MVP** | Displays mit Token-URL, Channels, Slides `text` (+QR), `image`, `iframe`, **`html` (mit Lebenszyklus)**, Player mit Manifest/SSE/Ticker/Übergängen, Fortschrittsbalken | ersetzt Basis-Foyer |
| **2 Video** | Media-Pipeline (ffmpeg), Video-Hintergrund + Video-Slide, Offline-Cache, Heartbeat/Monitoring | Kapitel 6 umgesetzt |
| **3 Scheduler** | ✅ Kalender für Displays und Channels, Serien mit `rrule`, Overrides/Ausnahmen, Kopplung, Einzelfolien, exklusiv. Offen: Vorlagen | Funktionsgleich zum Scheduler, plus Folien-Kalender |
| **4 Datenquellen** | `rss`, `calendar` (ICS), `pdf`; **`webuntis-room-display` + `teacher-dashboard` als 1:1-Port mit Golden Tests** (5.6) | alle heutigen Typen |
| **5 Migration & Extras** | WP-Importer, Layouts/Zonen (Split-Channels), Rollen/Audit | Umstieg |

---

## 12. Offene Entscheidungen

1. Stack: TypeScript/Node (empfohlen) oder PHP/Laravel?
2. ~~Player-Hardware~~ → überwiegend **Airtame 2** (Kapitel 2). Offen: Gibt es daneben andere Geräte? Läuft der Foyer-Server im Schulnetz, und ist er vom Airtame-VLAN aus per HTTPS mit gültigem Zertifikat erreichbar?
3. Braucht es mehrere Mandanten/Standorte oder reicht eine Instanz pro Schule?
4. Theater-Formate (`production`) streichen oder als generischen „Events aus ICS/JSON“-Typ nachbauen?
5. Login: lokale Konten genügen, oder SSO (z. B. Schul-IdP via OIDC)?
6. WebUntis: Sollen die beiden Folien früher kommen (z. B. schon in Phase 1), weil sie im Alltag am wichtigsten sind? Gibt es anonymisierbare Beispiel-Exporte (`raeume_ganzer_tag.txt`, `lehrer.txt`) für die Golden Tests?
