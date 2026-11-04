import { useEffect, useState } from 'react';
import { api, can, type Channel, type Display, type User } from './api.ts';

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

export function Displays({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [revealed, setRevealed] = useState<{ name: string; url: string } | null>(null);
  const [name, setName] = useState('');

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

  const playerUrl = (path: string) => `${location.origin}${path}`;

  const create = async () => {
    if (!name.trim()) return;
    try {
      const res = await api.post<{ playerPath: string }>('/displays', { name });
      setRevealed({ name, url: playerUrl(res.playerPath) });
      setName('');
      await load();
    } catch (e) {
      onError(e);
    }
  };

  const rotate = async (display: Display) => {
    if (!confirm(`Neue URL für „${display.name}“ erzeugen? Die alte URL funktioniert danach nicht mehr.`)) return;
    try {
      const res = await api.post<{ playerPath: string }>(`/displays/${display.id}/rotate-token`);
      setRevealed({ name: display.name, url: playerUrl(res.playerPath) });
    } catch (e) {
      onError(e);
    }
  };

  const patch = (display: Display, body: Partial<Display>) => api.patch(`/displays/${display.id}`, body).then(load).catch(onError);
  const action = (display: Display, what: 'reload' | 'identify') => api.post(`/displays/${display.id}/${what}`).catch(onError);
  const remove = (display: Display) =>
    confirm(`Display „${display.name}“ löschen?`) && api.del(`/displays/${display.id}`).then(load).catch(onError);

  return (
    <section>
      <h1>Displays</h1>
      {revealed && (
        <div className="notice">
          <strong>Player-URL für „{revealed.name}“</strong> (wird nur jetzt angezeigt; in Airtame Cloud als Website eintragen):
          <code className="secret">{revealed.url}</code>
          <button onClick={() => navigator.clipboard?.writeText(revealed.url)}>Kopieren</button>
          <button onClick={() => setRevealed(null)}>Schließen</button>
        </div>
      )}
      {can(user, 'admin') && (
        <div className="row">
          <input placeholder="Name, z. B. Aula" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={create}>Display anlegen</button>
        </div>
      )}
      <div className="cards">
        {displays.map((display) => (
          <article key={display.id} className="card">
            <header>
              <h2>{display.name}</h2>
              <span className={`badge ${STATE[display.state].className}`} title={STATE[display.state].hint}>
                {stateLabel(display)}
              </span>
            </header>
            {display.status?.screen && <p className="muted">Bildschirm {display.status.screen}</p>}
            {display.status?.errors?.length ? <p className="error">{display.status.errors.join(' · ')}</p> : null}
            <label className="field">
              <span>Standard-Channel</span>
              <select
                value={display.defaultChannelId ?? ''}
                disabled={!can(user, 'editor')}
                onChange={(e) => patch(display, { defaultChannelId: e.target.value || null })}
              >
                <option value="">– keiner –</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channel.name}</option>
                ))}
              </select>
            </label>
            <label className="field field--check">
              <input type="checkbox" checked={display.showProgress} disabled={!can(user, 'editor')} onChange={(e) => patch(display, { showProgress: e.target.checked })} />
              Fortschrittsbalken
            </label>
            {can(user, 'admin') && (
              <label className="field">
                <span>Erlaubte Netze (CIDR, leer = global)</span>
                <input
                  defaultValue={display.networks}
                  placeholder="z. B. 10.20.0.0/16"
                  onBlur={(e) => e.target.value !== display.networks && patch(display, { networks: e.target.value })}
                />
              </label>
            )}
            {can(user, 'editor') && (
              <div className="row">
                <button onClick={() => action(display, 'identify')}>Identifizieren</button>
                <button onClick={() => action(display, 'reload')}>Neu laden</button>
                {can(user, 'admin') && <button onClick={() => rotate(display)}>Neue URL</button>}
                {can(user, 'admin') && <button className="danger" onClick={() => remove(display)}>Löschen</button>}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
