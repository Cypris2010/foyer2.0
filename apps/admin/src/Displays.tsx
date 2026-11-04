import { useEffect, useState } from 'react';
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

interface CardProps {
  display: Display;
  channels: Channel[];
  user: User;
  onChanged: () => void;
  onReveal: (name: string, url: string) => void;
  onError: (e: unknown) => void;
}

function DisplayCard({ display, channels, user, onChanged, onReveal, onError }: CardProps) {
  const [saved, setSaved] = useState(false);
  const channel = channels.find((c) => c.id === display.defaultChannelId);
  const playerUrl = (path: string) => `${location.origin}${path}`;

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
  const patch = (body: Partial<Display>) => run(() => api.patch(`/displays/${display.id}`, body), true);

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
  const remove = () => confirm(`Display „${display.name}“ löschen?`) && run(() => api.del(`/displays/${display.id}`));

  return (
    <article className="card display-card">
      <PlayerThumb src={`/p/preview-display/${display.id}`} reloadKey={display.defaultChannelId ?? ''} orientation={display.orientation} />
      <header>
        <h2>{display.name}</h2>
        <span className={`badge ${STATE[display.state].className}`} title={STATE[display.state].hint}>
          {stateLabel(display)}
        </span>
      </header>
      <p className="muted display-card__meta">
        {channel ? `Channel: ${channel.name}` : 'Kein Channel zugewiesen'}
        {display.currentSlideTitle ? ` · zeigt gerade: ${display.currentSlideTitle}` : ''}
      </p>
      {display.status?.errors?.length ? <p className="error">{display.status.errors.join(' · ')}</p> : null}

      {can(user, 'editor') && (
        <div className="row display-card__actions">
          <button onClick={() => run(() => api.post(`/displays/${display.id}/identify`))} title="Zeigt den Namen 10 s groß auf dem Bildschirm">
            Identifizieren
          </button>
          <button onClick={() => run(() => api.post(`/displays/${display.id}/reload`))}>Neu laden</button>
          {saved && <span className="saved">Gespeichert ✓</span>}
        </div>
      )}

      {can(user, 'editor') && (
        <details className="settings">
          <summary>Einstellungen</summary>
          <div className="form">
            <label className="field">
              <span>Standard-Channel</span>
              <select value={display.defaultChannelId ?? ''} onChange={(e) => patch({ defaultChannelId: e.target.value || null })}>
                <option value="">– keiner –</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
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
                  <button className="danger" onClick={remove}>Löschen</button>
                </div>
              </>
            )}
          </div>
        </details>
      )}
    </article>
  );
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

  const create = async () => {
    if (!name.trim()) return;
    try {
      const res = await api.post<{ playerPath: string }>('/displays', { name });
      setRevealed({ name, url: `${location.origin}${res.playerPath}` });
      setName('');
      await load();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <section>
      <h1>Displays</h1>
      {revealed && (
        <div className="notice">
          <strong>Player-URL für „{revealed.name}“</strong>
          <span>In Airtame Cloud als Website eintragen. Wer diese URL kennt, sieht aus dem Schulnetz die Inhalte des Displays, also nicht weitergeben.</span>
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
          <DisplayCard
            key={display.id}
            display={display}
            channels={channels}
            user={user}
            onChanged={load}
            onReveal={(n, url) => setRevealed({ name: n, url })}
            onError={onError}
          />
        ))}
      </div>
    </section>
  );
}
