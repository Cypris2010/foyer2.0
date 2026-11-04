import { defineRenderer } from '@foyer/slide-sdk';
import type { RoomDisplayConfig, RoomDisplayData } from './index.ts';
import { mount, unmount, update } from './legacy.js';

// Markup and labels of the wp-foyer template (webuntis-room-display.php).
const LABELS: Record<string, string> = {
  'label-free': 'Frei',
  'label-occupied': 'Belegt',
  'label-current': 'Aktuell',
  'label-upcoming': 'Nächste Belegungen',
  'label-no-upcoming': 'Keine weiteren Belegungen heute.',
  'label-free-now': 'Der Raum ist aktuell frei.',
  'label-updated': 'Aktualisiert um %s',
  'label-subject': 'Fach',
  'label-classes': 'Klasse(n)',
  'label-teachers': 'Lehrperson(en)',
  'label-remarks': 'Hinweis',
  'error-message': 'Daten konnten nicht geladen werden.',
  'error-no-rooms': 'Bitte wählen Sie mindestens einen Raum in den Folieneinstellungen aus.',
};

const TEMPLATE = `
  <header class="foyer-webuntis-room-display__page-header">
    <div class="foyer-webuntis-room-display__page-meta">
      <div class="foyer-webuntis-room-display__clock" data-format-date="d.m.Y" data-format-time="H:i">
        <span class="foyer-webuntis-room-display__clock-date">--.--.----</span>
        <span class="foyer-webuntis-room-display__clock-time">--:--</span>
      </div>
      <p class="foyer-webuntis-room-display__updated" aria-live="polite">Aktualisiert um --:--</p>
    </div>
  </header>
  <div class="foyer-webuntis-room-display__grid" aria-live="polite">
    <div class="foyer-webuntis-room-display__placeholder">Lade Belegungen …</div>
  </div>
  <div class="foyer-webuntis-room-display__error" role="alert" hidden></div>`;

export default defineRenderer<RoomDisplayConfig, RoomDisplayData>((root, { config, data, ctx }) => {
  root.classList.add('foyer-slide-webuntis-room-display');
  const node = document.createElement('div');
  node.className = 'foyer-webuntis-room-display';
  const attrs: Record<string, string> = {
    rooms: JSON.stringify(config.rooms),
    refresh: String(config.refresh),
    locale: ctx.locale,
    timezone: ctx.timeZone,
    'hide-upcoming': config.hideUpcoming ? '1' : '0',
    'hide-current': config.hideCurrent ? '1' : '0',
    ...LABELS,
  };
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(`data-${name}`, value);
  node.innerHTML = TEMPLATE;
  root.appendChild(node);
  mount(node, data);

  return {
    update(next) {
      update(node, next as RoomDisplayData);
    },
    destroy() {
      unmount(node);
    },
  };
});
