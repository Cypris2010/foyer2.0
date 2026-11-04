import { useEffect, useState } from 'react';
import { api, can, type Channel, type Slide, type User } from './api.ts';

type Entry = NonNullable<Channel['slides']>[number];

const toLocalInput = (ts: number | null) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocalInput = (value: string) => (value ? new Date(value).getTime() : null);

function ChannelEditor({ channelId, slides, user, onError, onSaved }: { channelId: string; slides: Slide[]; user: User; onError: (e: unknown) => void; onSaved: () => void }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [add, setAdd] = useState('');
  const editable = can(user, 'editor');

  useEffect(() => {
    api
      .get<Channel>(`/channels/${channelId}`)
      .then((c) => {
        setChannel(c);
        setEntries(c.slides ?? []);
      })
      .catch(onError);
  }, [channelId]);

  if (!channel) return null;
  const title = (id: string) => slides.find((s) => s.id === id)?.title ?? '(gelöscht)';
  const move = (i: number, delta: number) => {
    const next = [...entries];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item);
    setEntries(next);
  };
  const update = (i: number, patch: Partial<Entry>) => setEntries(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const save = async () => {
    try {
      const { slides: _omit, slideCount: _count, id: _id, ...settings } = channel;
      await api.put(`/channels/${channel.id}`, settings);
      await api.put(`/channels/${channel.id}/slides`, entries);
      onSaved();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="editor">
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input value={channel.name} disabled={!editable} onChange={(e) => setChannel({ ...channel, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Übergang</span>
          <select value={channel.transition} disabled={!editable} onChange={(e) => setChannel({ ...channel, transition: e.target.value as Channel['transition'] })}>
            <option value="fade">Überblenden</option>
            <option value="slide">Schieben</option>
            <option value="none">Ohne</option>
          </select>
        </label>
        <label className="field">
          <span>Standarddauer (s)</span>
          <input type="number" min={1} value={channel.defaultDuration} disabled={!editable} onChange={(e) => setChannel({ ...channel, defaultDuration: Number(e.target.value) })} />
        </label>
        <label className="field field--check">
          <input type="checkbox" checked={channel.isFavorite} disabled={!editable} onChange={(e) => setChannel({ ...channel, isFavorite: e.target.checked })} />
          Favorit
        </label>
      </div>
      <h3>Folien</h3>
      <table className="table">
        <thead>
          <tr><th>#</th><th>Folie</th><th>Sichtbar ab</th><th>Sichtbar bis</th><th /></tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={`${entry.slideId}-${i}`}>
              <td>{i + 1}</td>
              <td>{title(entry.slideId)}</td>
              <td><input type="datetime-local" value={toLocalInput(entry.windowStart)} disabled={!editable} onChange={(e) => update(i, { windowStart: fromLocalInput(e.target.value) })} /></td>
              <td><input type="datetime-local" value={toLocalInput(entry.windowEnd)} disabled={!editable} onChange={(e) => update(i, { windowEnd: fromLocalInput(e.target.value) })} /></td>
              <td className="actions">
                {editable && (
                  <>
                    <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="nach oben">↑</button>
                    <button disabled={i === entries.length - 1} onClick={() => move(i, 1)} aria-label="nach unten">↓</button>
                    <button className="danger" onClick={() => setEntries(entries.filter((_, idx) => idx !== i))}>Entfernen</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div className="row">
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Folie hinzufügen …</option>
            {slides.map((slide) => (
              <option key={slide.id} value={slide.id}>{slide.title} ({slide.type})</option>
            ))}
          </select>
          <button disabled={!add} onClick={() => { setEntries([...entries, { slideId: add, windowStart: null, windowEnd: null }]); setAdd(''); }}>Hinzufügen</button>
          <button className="primary" onClick={save}>Speichern</button>
        </div>
      )}
    </div>
  );
}

export function Channels({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = () =>
    Promise.all([api.get<Channel[]>('/channels'), api.get<Slide[]>('/slides')])
      .then(([c, s]) => {
        setChannels(c);
        setSlides(s);
      })
      .catch(onError);
  useEffect(() => void load(), []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const res = await api.post<{ id: string }>('/channels', { name });
      setName('');
      await load();
      setSelected(res.id);
    } catch (e) {
      onError(e);
    }
  };

  return (
    <section className="split">
      <div className="list">
        <h1>Channels</h1>
        {can(user, 'editor') && (
          <div className="row">
            <input placeholder="Neuer Channel" value={name} onChange={(e) => setName(e.target.value)} />
            <button onClick={create}>Anlegen</button>
          </div>
        )}
        <ul>
          {channels.map((channel) => (
            <li key={channel.id}>
              <button className={selected === channel.id ? 'link active' : 'link'} onClick={() => setSelected(channel.id)}>
                {channel.isFavorite ? '★ ' : ''}{channel.name} <span className="muted">({channel.slideCount} Folien)</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="detail">
        {selected ? (
          <ChannelEditor key={selected} channelId={selected} slides={slides} user={user} onError={onError} onSaved={load} />
        ) : (
          <p className="muted">Channel auswählen.</p>
        )}
      </div>
    </section>
  );
}
