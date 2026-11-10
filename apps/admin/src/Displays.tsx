import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, can, type Channel, type Display, type User } from './api.ts';
import { PlayerThumb } from './PlayerThumb.tsx';

function since(ts: number): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  if (today.getTime() - ts < 6 * 86400_000) return `${date.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${time}`;
}

const STATE: Record<Display['state'], { className: string; hint: string }> = {
  online: {
    className: 'ok',
    hint: 'Der Player läuft und ist mit dem Server verbunden. Ob der Bildschirm eingeschaltet ist, kann Foyer nicht erkennen.',
  },
  offline: {
    className: 'bad',
    hint: 'Mögliche Gründe: Gerät aus, Netzwerkproblem, Bildschirmfreigabe läuft, URL in Airtame Cloud geändert.',
  },
  never: { className: 'off', hint: 'Player-URL in Airtame Cloud als Website eintragen.' },
  checking: { className: 'off', hint: 'Der Server wurde gerade neu gestartet; die Player verbinden sich neu.' },
};

function stateLabel(display: Display): string {
  if (display.wall && display.state !== 'online') {
    return display.wall.screens ? `${display.wall.online} von ${display.wall.screens} online` : 'Keine Displays zugewiesen';
  }
  switch (display.state) {
    case 'online':
      return 'Online';
    case 'offline':
      return display.lastSeenAt ? `Offline seit ${since(display.lastSeenAt)}` : 'Offline';
    case 'never':
      return 'Noch nie verbunden';
    case 'checking':
      return 'Wird geprüft …';
  }
}

function StateBadge({ display }: { display: Display }) {
  const hint = display.wall ? 'Online, wenn alle Displays der Wand verbunden sind.' : STATE[display.state].hint;
  return (
    <span className={`badge ${STATE[display.state].className}`} title={hint}>
      {stateLabel(display)}
    </span>
  );
}

interface Shared {
  /** All displays (walls look up their screens, screens their wall). */
  displays: Display[];
  channels: Channel[];
  user: User;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

function useActions(display: Display, onChanged: () => void, onError: (e: unknown) => void) {
  const [saved, setSaved] = useState(false);
  const run = async (action: () => Promise<unknown>, confirmSaved = false) => {
    try {
      await action();
      if (confirmSaved) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  const patch = (body: Record<string, unknown>) => run(() => api.patch(`/displays/${display.id}`, body), true);
  return { saved, run, patch };
}

/** Test patterns: stepped through by hand, end by themselves after 10 minutes. */
function TestPatternControls({ display, run }: { display: Display; run: (action: () => Promise<unknown>) => unknown }) {
  const send = (action: 'start' | 'next' | 'prev' | 'stop') => run(() => api.post(`/displays/${display.id}/test-pattern`, { action }));
  const test = display.testPattern;
  if (!test) {
    return (
      <button onClick={() => send('start')} title="Testbilder für Ausrichtung, Rahmen, Farben und Synchronität">
        Testbild
      </button>
    );
  }
  return (
    <div className="test-pattern" role="group" aria-label="Testbild">
      <button onClick={() => send('prev')} aria-label="Vorheriges Testbild">◀</button>
      <span className="test-pattern__name" title={test.hint}>
        {test.index + 1}/{test.count} {test.name}
      </span>
      <button onClick={() => send('next')} aria-label="Nächstes Testbild">▶</button>
      <button onClick={() => send('stop')}>Beenden</button>
    </div>
  );
}

/** Stack wall: each screen in its cell, every one with its own live preview. */
function StackThumb({ display, displays }: { display: Display; displays: Display[] }) {
  const { rows, cols } = display.wall!;
  const screen = display.orientation === 'portrait' ? { w: 9, h: 16 } : { w: 16, h: 9 };
  const at = (row: number, col: number) => displays.find((d) => d.wallId === display.id && d.wallRow === row && d.wallCol === col);
  return (
    <div className="stack-thumb" style={{ aspectRatio: `${cols * screen.w} / ${rows * screen.h}`, gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {Array.from({ length: rows * cols }, (_, i) => {
        const occupant = at(Math.floor(i / cols), i % cols);
        return occupant ? (
          <PlayerThumb key={occupant.id} src={`/p/preview-display/${occupant.id}`} reloadKey={display.defaultChannelId ?? ''} orientation={display.orientation} />
        ) : (
          <span key={i} className="stack-thumb__empty" />
        );
      })}
    </div>
  );
}

/** Live miniature of what the display shows; a screen in a wall shows its part of the wall. */
function DisplayThumb({ display, displays }: { display: Display; displays: Display[] }) {
  const wall = display.wallId ? displays.find((d) => d.id === display.wallId) : undefined;
  if (display.wall?.mode === 'stack') return <StackThumb display={display} displays={displays} />;
  // In a stack the screen plays its own slide, a few places behind the first screen.
  if (wall?.wall?.mode === 'stack') {
    return <PlayerThumb src={`/p/preview-display/${display.id}`} reloadKey={`${wall.defaultChannelId}-${display.wallRow}-${display.wallCol}`} orientation={wall.orientation} />;
  }
  if (display.wall) {
    return (
      <PlayerThumb
        src={`/p/preview-display/${display.id}`}
        reloadKey={`${display.defaultChannelId}-${display.wall.rows}x${display.wall.cols}`}
        orientation={display.orientation}
        wall={{ rows: display.wall.rows, cols: display.wall.cols }}
      />
    );
  }
  if (wall?.wall) {
    return (
      <PlayerThumb
        src={`/p/preview-display/${wall.id}`}
        reloadKey={`${wall.defaultChannelId}-${wall.wall.rows}x${wall.wall.cols}`}
        orientation={wall.orientation}
        wall={{ rows: wall.wall.rows, cols: wall.wall.cols, row: display.wallRow ?? 0, col: display.wallCol ?? 0 }}
      />
    );
  }
  return <PlayerThumb src={`/p/preview-display/${display.id}`} reloadKey={display.defaultChannelId ?? ''} orientation={display.orientation} />;
}

function DisplayCard({ display, displays, channels, user, onEdit, onChanged, onError }: Shared & { display: Display; onEdit: () => void }) {
  const { saved, run } = useActions(display, onChanged, onError);
  const channel = channels.find((c) => c.id === display.defaultChannelId);
  const wall = display.wallId ? displays.find((d) => d.id === display.wallId) : undefined;
  const screens = display.wall ? displays.filter((d) => d.wallId === display.id) : [];
  const editor = can(user, 'editor');
  const remove = () =>
    confirm(
      display.wall
        ? `Wand „${display.name}“ löschen? Ihre Displays zeigen danach wieder ihren eigenen Channel.`
        : `Display „${display.name}“ endgültig löschen? Das lässt sich nicht rückgängig machen: Ein neu angelegtes Display bekommt eine neue Player-Adresse, die im Gerät neu eingetragen werden muss.`,
    ) && run(() => api.del(`/displays/${display.id}`));

  return (
    <article className="card display-card">
      <button className="display-card__thumb" onClick={onEdit} disabled={!editor} aria-label={`„${display.name}“ bearbeiten`}>
        <DisplayThumb display={display} displays={displays} />
      </button>
      <h2>
        {editor ? (
          <button className="display-card__title" onClick={onEdit}>{display.name}</button>
        ) : (
          display.name
        )}
      </h2>
      <dl className="display-card__info">
        {display.wall && (
          <>
            <dt>Wand:</dt>
            <dd>
              {display.wall.rows} × {display.wall.cols}
              {display.wall.mode === 'stack' ? ' · Stapel' : ''}
              {screens.length ? ` · ${screens.map((d) => d.name).join(', ')}` : ''}
            </dd>
          </>
        )}
        {wall ? (
          <>
            <dt>Teil der Wand:</dt>
            <dd>
              {wall.name} (Zeile {(display.wallRow ?? 0) + 1}, Spalte {(display.wallCol ?? 0) + 1})
            </dd>
          </>
        ) : (
          <>
            <dt>Standard-Channel:</dt>
            <dd>{channel ? channel.name : <span className="muted">Keiner</span>}</dd>
          </>
        )}
        <dt>Zeigt gerade:</dt>
        <dd>{display.currentSlideTitle ?? <span className="muted">–</span>}</dd>
        <dt>Status:</dt>
        <dd>
          <StateBadge display={display} />
        </dd>
        {!display.wall && (
          <>
            <dt>Zuletzt gesehen:</dt>
            <dd>{display.state === 'online' ? 'jetzt' : display.lastSeenAt ? since(display.lastSeenAt) : <span className="muted">nie</span>}</dd>
          </>
        )}
      </dl>
      {display.status?.errors?.length ? <p className="error">{display.status.errors.join(' · ')}</p> : null}

      {editor && (
        <div className="row display-card__actions">
          <button className="primary" onClick={onEdit}>Bearbeiten</button>
          <button
            onClick={() => window.open(`/p/preview-display/${display.id}`, '_blank', 'noopener')}
            title="Zeigt den Plan des Displays in einem neuen Tab"
          >
            Vorschau
          </button>
          <button
            onClick={() => run(() => api.post(`/displays/${display.id}/identify`))}
            title={display.wall ? 'Zeigt auf jedem Bildschirm 10 s seinen Namen und sein Feld' : 'Zeigt den Namen 10 s groß auf dem Bildschirm'}
          >
            Identifizieren
          </button>
          <button onClick={() => run(() => api.post(`/displays/${display.id}/reload`))}>Neu laden</button>
          <TestPatternControls display={display} run={run} />
          {can(user, 'admin') && (
            <button className="danger" onClick={remove}>Löschen</button>
          )}
          {saved && <span className="saved">Gespeichert ✓</span>}
        </div>
      )}
    </article>
  );
}

function ChannelSelect({ display, channels, patch }: { display: Display; channels: Channel[]; patch: (body: Record<string, unknown>) => unknown }) {
  return (
    <label className="field">
      <span>Standard-Channel</span>
      <select value={display.defaultChannelId ?? ''} onChange={(e) => patch({ defaultChannelId: e.target.value || null })}>
        <option value="">– keiner –</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </label>
  );
}

function NameField({ display, patch }: { display: Display; patch: (body: Record<string, unknown>) => unknown }) {
  return (
    <label className="field">
      <span>Name</span>
      <input
        key={display.name}
        defaultValue={display.name}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== display.name) patch({ name });
        }}
      />
    </label>
  );
}

function ScreenSettings({ display, displays, channels, user, onChanged, onReveal, onError }: Shared & { display: Display; onReveal: (name: string, url: string) => void }) {
  const { saved, run, patch } = useActions(display, onChanged, onError);
  const wall = display.wallId ? displays.find((d) => d.id === display.wallId) : undefined;
  const playerUrl = (path: string) => `${location.origin}${path}`;

  const reveal = () =>
    run(async () => {
      const res = await api.post<{ playerPath: string }>(`/displays/${display.id}/reveal-url`);
      onReveal(display.name, playerUrl(res.playerPath));
    });
  const rotate = () =>
    confirm(`Neue URL für „${display.name}“ erzeugen? Die alte URL funktioniert danach nicht mehr.`) &&
    run(async () => {
      const res = await api.post<{ playerPath: string }>(`/displays/${display.id}/rotate-token`);
      onReveal(display.name, playerUrl(res.playerPath));
    });
  const release = () =>
    confirm(`Gerät ${display.device?.ip ?? ''} von „${display.name}“ trennen? Ein anderes Gerät kann das Display dann übernehmen.`) &&
    run(() => api.post(`/displays/${display.id}/release`));

  return (
    <div className="form">
      <NameField display={display} patch={patch} />
      {wall && <p className="muted">Solange das Display Teil der Wand „{wall.name}“ ist, zeigt es deren Inhalt. Channel und Kalender gelten wieder, sobald es die Wand verlässt.</p>}
      <ChannelSelect display={display} channels={channels} patch={patch} />
      <label className="field">
        <span>Ausrichtung</span>
        <select value={display.orientation} onChange={(e) => patch({ orientation: e.target.value as Display['orientation'] })}>
          <option value="landscape">Querformat (16:9)</option>
          <option value="portrait">Hochformat (9:16)</option>
        </select>
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={display.showProgress} onChange={(e) => patch({ showProgress: e.target.checked })} />
        Fortschrittsbalken
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={display.soundAllowed} onChange={(e) => patch({ soundAllowed: e.target.checked })} />
        Ton erlaubt (Videofolien mit „Mit Ton“ spielen hier hörbar)
      </label>
      <VideoQualitySelect display={display} patch={patch} />
      {can(user, 'admin') && (
        <>
          <label className="field">
            <span>Erlaubte Netze (CIDR, leer = globale Einstellung)</span>
            <input
              defaultValue={display.networks}
              placeholder="z. B. 10.20.0.0/16"
              onBlur={(e) => e.target.value !== display.networks && patch({ networks: e.target.value })}
            />
          </label>
          <p className="muted">
            {display.device ? `Gerät ${display.device.ip}, verbunden seit ${since(display.device.since)}` : 'Kein Gerät verbunden'}
            {display.status?.screen ? ` · Bildschirm ${display.status.screen}` : ''}
          </p>
          <div className="row">
            {display.device && (
              <button onClick={release} title="Trennt das aktuelle Gerät für 2 Minuten, damit ein anderes das Display übernehmen kann">
                Gerät freigeben
              </button>
            )}
            <button onClick={reveal}>URL anzeigen</button>
            <button onClick={rotate}>Neue URL</button>
          </div>
        </>
      )}
      <p className="muted modal__hint">Änderungen werden sofort gespeichert. {saved && <span className="saved">Gespeichert ✓</span>}</p>
    </div>
  );
}

const SIDES = [1, 2, 3, 4];

function WallSettings({ display, displays, channels, onChanged, onError }: Shared & { display: Display }) {
  const { saved, run, patch } = useActions(display, onChanged, onError);
  const wall = display.wall!;
  const screens = displays.filter((d) => d.wallId === display.id);
  // Displays that can go into a cell: free ones and those already in this wall.
  const candidates = displays.filter((d) => d.kind === 'screen' && (!d.wallId || d.wallId === display.id));
  const at = (row: number, col: number) => screens.find((d) => d.wallRow === row && d.wallCol === col);

  // Puts a display into a cell; one already there swaps into the display's old cell.
  const assign = (row: number, col: number, displayId: string) => {
    const cells = new Map(screens.map((d) => [d.id, { row: d.wallRow!, col: d.wallCol! }]));
    const occupant = at(row, col);
    const previous = displayId ? cells.get(displayId) : undefined;
    if (occupant) {
      cells.delete(occupant.id);
      if (previous && occupant.id !== displayId) cells.set(occupant.id, previous);
    }
    if (displayId) cells.set(displayId, { row, col });
    const body = { cells: [...cells].map(([id, cell]) => ({ displayId: id, ...cell })) };
    return run(() => api.put(`/displays/${display.id}/cells`, body), true);
  };
  const resize = (rows: number, cols: number) => {
    const outside = screens.filter((d) => d.wallRow! >= rows || d.wallCol! >= cols);
    if (outside.length && !confirm(`${outside.map((d) => `„${d.name}“`).join(', ')} liegt dann außerhalb und verlässt die Wand. Fortfahren?`)) return;
    return patch({ wallRows: rows, wallCols: cols });
  };

  return (
    <div className="form">
      <NameField display={display} patch={patch} />
      <div className="row row--fields">
        <label className="field">
          <span>Zeilen</span>
          <select value={wall.rows} onChange={(e) => resize(Number(e.target.value), wall.cols)}>
            {SIDES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Spalten</span>
          <select value={wall.cols} onChange={(e) => resize(wall.rows, Number(e.target.value))}>
            {SIDES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="wall-grid" style={{ gridTemplateColumns: `repeat(${wall.cols}, 1fr)` }}>
        {Array.from({ length: wall.rows * wall.cols }, (_, i) => {
          const row = Math.floor(i / wall.cols);
          const col = i % wall.cols;
          const occupant = at(row, col);
          return (
            <label key={`${row}-${col}`} className={`wall-grid__cell${occupant ? '' : ' is-empty'}`}>
              <span className="muted">Zeile {row + 1}, Spalte {col + 1}</span>
              <select value={occupant?.id ?? ''} onChange={(e) => assign(row, col, e.target.value)}>
                <option value="">– frei –</option>
                {candidates.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <label className="field">
        <span>Modus</span>
        <select value={wall.mode} onChange={(e) => patch({ wallMode: e.target.value })}>
          <option value="span">Großes Bild: alle Displays zeigen zusammen eine Folie</option>
          <option value="stack">Stapel: jedes Display zeigt eine Folie, die beim Wechsel zum nächsten weiterrutscht</option>
        </select>
      </label>
      {wall.mode === 'stack' && (
        <p className="muted">
          Die neue Folie erscheint auf dem ersten Display (oben links) und rückt bei jedem Wechsel ein Display weiter, in Leserichtung. Alle
          Displays wechseln gleichzeitig. Videos laufen so lange, wie die Folie auf dem ersten Display steht.
        </p>
      )}
      <ChannelSelect display={display} channels={channels} patch={patch} />
      <label className="field">
        <span>Bildschirme</span>
        <select value={display.orientation} onChange={(e) => patch({ orientation: e.target.value })}>
          <option value="landscape">Querformat (16:9)</option>
          <option value="portrait">Hochformat (9:16)</option>
        </select>
      </label>
      {wall.mode === 'span' && (
        <label className="field">
          <span>Rahmenausgleich in Pixeln (Abstand zwischen den Bildflächen)</span>
          <input
            type="number"
            min={0}
            max={500}
            defaultValue={wall.bezel}
            onBlur={(e) => Number(e.target.value) !== wall.bezel && patch({ wallBezel: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </label>
      )}
      <label className="field field--check">
        <input type="checkbox" checked={display.showProgress} onChange={(e) => patch({ showProgress: e.target.checked })} />
        Fortschrittsbalken
      </label>
      <label className="field field--check">
        <input type="checkbox" checked={display.soundAllowed} onChange={(e) => patch({ soundAllowed: e.target.checked })} />
        Ton erlaubt (spielt nur auf einem Display, sonst gibt es Echo: oben links, im Stapel auf dem ersten)
      </label>
      <VideoQualitySelect display={display} patch={patch} />
      <p className="muted modal__hint">Änderungen werden sofort gespeichert. {saved && <span className="saved">Gespeichert ✓</span>}</p>
    </div>
  );
}

function VideoQualitySelect({ display, patch }: { display: Display; patch: (body: Record<string, unknown>) => unknown }) {
  return (
    <label className="field">
      <span>Videoqualität</span>
      <select value={display.videoQuality} onChange={(e) => patch({ videoQuality: e.target.value as Display['videoQuality'] })}>
        <option value="main">1080p (Standard)</option>
        <option value="sd">720p (wenn Videos auf dem Gerät ruckeln)</option>
      </select>
    </label>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
}

function EditDialog({ display, notice, onClose, onReveal, ...shared }: Shared & { display: Display; notice: ReactNode; onClose: () => void; onReveal: (name: string, url: string) => void }) {
  useEscape(onClose);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${display.name} bearbeiten`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box display-dialog">
        <header className="modal__head">
          <h2>{display.wall ? 'Wand' : 'Display'} „{display.name}“</h2>
          <StateBadge display={display} />
          <span className="spacer" />
          <button onClick={onClose}>Schließen</button>
        </header>
        {notice}
        {/* No second live preview here: each one holds an event stream, and browsers allow only 6 connections per host without HTTP/2. */}
        {display.wall ? <WallSettings display={display} {...shared} /> : <ScreenSettings display={display} onReveal={onReveal} {...shared} />}
      </div>
    </div>
  );
}

function CreateDialog({ kind, onCreate, onClose }: { kind: Display['kind']; onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  useEscape(onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void onCreate(name.trim());
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal__box" onSubmit={submit}>
        <header className="modal__head">
          <h2>{kind === 'wall' ? 'Neue Wand' : 'Neues Display'}</h2>
          <button type="button" onClick={onClose}>Abbrechen</button>
        </header>
        <label className="field">
          <span>Name</span>
          <input autoFocus placeholder={kind === 'wall' ? 'z. B. Wand Foyer' : 'z. B. Aula'} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {kind === 'wall' && <p className="muted">Größe, Displays und Channel legst du danach im Bearbeiten-Dialog fest.</p>}
        <div className="row row--end">
          <button className="primary" type="submit" disabled={!name.trim()}>Anlegen</button>
        </div>
      </form>
    </div>
  );
}

const FILTERS = {
  all: { label: 'Alle', test: () => true },
  screen: { label: 'Displays', test: (d: Display) => d.kind === 'screen' },
  wall: { label: 'Wände', test: (d: Display) => d.kind === 'wall' },
  offline: { label: 'Nicht online', test: (d: Display) => d.state !== 'online' },
} satisfies Record<string, { label: string; test: (d: Display) => boolean }>;

export function Displays({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [revealed, setRevealed] = useState<{ name: string; url: string } | null>(null);
  const [creating, setCreating] = useState<Display['kind'] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [filter, setFilter] = useState<keyof typeof FILTERS>('all');
  const [search, setSearch] = useState('');

  const load = () =>
    Promise.all([api.get<Display[]>('/displays'), api.get<Channel[]>('/channels')])
      .then(([d, c]) => {
        setDisplays(d);
        setChannels(c);
      })
      .catch(onError);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  const create = async (name: string) => {
    if (!creating) return;
    try {
      const res = await api.post<{ id: string; playerPath?: string }>('/displays', { name, kind: creating });
      if (res.playerPath) setRevealed({ name, url: `${location.origin}${res.playerPath}` });
      setCreating(null);
      await load();
      // A new wall is empty; go straight on to choosing its size and displays.
      if (creating === 'wall') setEditId(res.id);
    } catch (e) {
      onError(e);
    }
  };

  const query = search.trim().toLowerCase();
  // Walls first, then screens, each by name as the server sorts them.
  const shown = [...displays]
    .sort((a, b) => Number(b.kind === 'wall') - Number(a.kind === 'wall'))
    .filter((d) => FILTERS[filter].test(d) && (!query || d.name.toLowerCase().includes(query)));
  const editing = displays.find((d) => d.id === editId);
  const shared = { displays, channels, user, onChanged: load, onError };
  const reveal = (n: string, url: string) => setRevealed({ name: n, url });
  const notice = revealed && (
    <div className="notice">
      <strong>Player-URL für „{revealed.name}“</strong>
      <span>In Airtame Cloud als Website eintragen. Wer diese URL kennt, sieht aus dem Schulnetz die Inhalte des Displays, also nicht weitergeben.</span>
      <code className="secret">{revealed.url}</code>
      <button onClick={() => navigator.clipboard?.writeText(revealed.url)}>Kopieren</button>
      <button onClick={() => setRevealed(null)}>Schließen</button>
    </div>
  );

  return (
    <section>
      <div className="page-head">
        <h1>Displays</h1>
        {can(user, 'admin') && (
          <>
            <button onClick={() => setCreating('screen')}>Neues Display hinzufügen</button>
            <button onClick={() => setCreating('wall')} title="Mehrere Displays zeigen zusammen ein großes Bild">
              Neue Wand
            </button>
          </>
        )}
      </div>
      {!editing && notice}
      <div className="toolbar">
        <nav className="filters" aria-label="Filter">
          {(Object.keys(FILTERS) as Array<keyof typeof FILTERS>).map((key, i) => (
            <span key={key}>
              {i > 0 && <span className="muted"> | </span>}
              <button className={filter === key ? 'filter is-active' : 'filter'} onClick={() => setFilter(key)}>
                {FILTERS[key].label}
              </button>{' '}
              <span className="muted">({displays.filter(FILTERS[key].test).length})</span>
            </span>
          ))}
        </nav>
        <input type="search" placeholder="Displays durchsuchen" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="spacer" />
        <span className="muted">{shown.length === 1 ? '1 Eintrag' : `${shown.length} Einträge`}</span>
      </div>
      <div className="cards display-cards">
        {shown.map((display) => (
          <DisplayCard key={display.id} display={display} onEdit={() => setEditId(display.id)} {...shared} />
        ))}
      </div>
      {!shown.length && <p className="muted">{displays.length ? 'Keine Displays gefunden.' : 'Noch keine Displays angelegt.'}</p>}
      {editing && <EditDialog display={editing} notice={notice} onClose={() => {
            setEditId(null);
            setRevealed(null);
          }} onReveal={reveal} {...shared} />}
      {creating && <CreateDialog kind={creating} onCreate={create} onClose={() => setCreating(null)} />}
    </section>
  );
}
