import { useEffect, useState } from 'react';
import { api, can, type Channel, type Slide, type User } from './api.ts';
import { ScheduleCalendar } from './ScheduleCalendar.tsx';

function ChannelEditor({ channelId, slides, user, onError, onSaved }: { channelId: string; slides: Slide[]; user: User; onError: (e: unknown) => void; onSaved: () => void }) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const editable = can(user, 'editor');

  const reload = () =>
    api
      .get<Channel>(`/channels/${channelId}`)
      .then((c) => {
        setChannel(c);
        setOrder((c.slides ?? []).map((s) => s.slideId));
      })
      .catch(onError);
  useEffect(() => void reload(), [channelId]);

  if (!channel) return null;
  const title = (id: string) => slides.find((s) => s.id === id)?.title ?? '(gelöscht)';
  const move = (i: number, delta: number) => {
    const next = [...order];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item);
    setOrder(next);
  };

  const save = async (nextOrder = order) => {
    try {
      const { slides: _omit, slideCount: _count, id: _id, ...settings } = channel;
      await api.put(`/channels/${channel.id}`, settings);
      await api.put(`/channels/${channel.id}/slides`, nextOrder.map((slideId) => ({ slideId })));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (e) {
      onError(e);
    }
  };

  const remove = (slideId: string) => {
    if (!confirm(`„${title(slideId)}“ aus dem Channel entfernen? Ihre Termine in diesem Channel werden gelöscht.`)) return;
    const next = order.filter((id) => id !== slideId);
    setOrder(next);
    void save(next).then(reload);
  };

  return (
    <div className="editor">
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input value={channel.name} disabled={!editable} onChange={(e) => setChannel({ ...channel, name: e.target.value })} />
        </label>
        <div className="row row--fields">
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
        </div>
        <label className="field field--check">
          <input type="checkbox" checked={channel.isFavorite} disabled={!editable} onChange={(e) => setChannel({ ...channel, isFavorite: e.target.checked })} />
          Favorit
        </label>
      </div>

      <h3>Reihenfolge</h3>
      <p className="muted">So laufen die Folien nacheinander ab, sofern sie laut Kalender gerade dran sind.</p>
      {order.length ? (
        <ol className="order">
          {order.map((slideId, i) => (
            <li key={slideId}>
              <span>{title(slideId)}</span>
              {editable && (
                <span className="actions">
                  <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="nach oben">↑</button>
                  <button disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="nach unten">↓</button>
                  <button className="danger" onClick={() => remove(slideId)}>Entfernen</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">Noch keine Folien. Über „Folie einplanen“ im Kalender hinzufügen.</p>
      )}
      {editable && (
        <div className="row">
          <button className="primary" onClick={() => save()}>Speichern</button>
          {saved && <span className="saved">Gespeichert ✓</span>}
        </div>
      )}

      <h3>Kalender</h3>
      <p className="muted">Eine Folie läuft nur, wenn sie hier einen Termin hat. Für „immer“ einen unbefristeten Termin anlegen.</p>
      <ScheduleCalendar
        scope="channel"
        channelId={channel.id}
        channels={[]}
        slides={slides}
        displays={[]}
        canEdit={editable}
        onChanged={() => {
          void reload();
          onSaved();
        }}
        onError={onError}
      />
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
