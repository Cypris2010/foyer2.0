import { useEffect, useState } from 'react';
import { api, can, type Slide, type SlideType, type User } from './api.ts';
import { defaultsFor, SchemaForm } from './SchemaForm.tsx';
import { SlideThumb } from './SlideThumb.tsx';

interface Draft {
  id: string | null;
  title: string;
  type: string;
  config: Record<string, unknown>;
  duration: number | null;
  published: boolean;
  updatedAt?: number;
}

export function Slides({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [types, setTypes] = useState<SlideType[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape');

  const load = () =>
    Promise.all([api.get<Slide[]>('/slides'), api.get<SlideType[]>('/slide-types')])
      .then(([s, t]) => {
        setSlides(s);
        setTypes(t);
      })
      .catch(onError);
  useEffect(() => void load(), []);

  const typeOf = (id: string) => types.find((t) => t.id === id);
  const mayEdit = (typeId: string) => can(user, typeOf(typeId)?.editRole ?? 'editor');

  const startNew = (type: SlideType) =>
    setDraft({ id: null, title: `Neue ${type.name}-Folie`, type: type.id, config: defaultsFor(type.schema), duration: null, published: true });

  const save = async () => {
    if (!draft) return;
    try {
      const body = { title: draft.title, type: draft.type, config: draft.config, duration: draft.duration, published: draft.published };
      const res = draft.id ? await api.put<{ id: string }>(`/slides/${draft.id}`, body) : await api.post<{ id: string }>('/slides', body);
      const fresh = await api.get<Slide>(`/slides/${res.id}`);
      setDraft({ ...fresh });
      await load();
    } catch (e) {
      onError(e);
    }
  };

  const remove = async () => {
    if (!draft?.id || !confirm(`Folie „${draft.title}“ löschen?`)) return;
    try {
      await api.del(`/slides/${draft.id}`);
      setDraft(null);
      await load();
    } catch (e) {
      onError(e);
    }
  };

  const type = draft ? typeOf(draft.type) : undefined;
  const editable = draft ? mayEdit(draft.type) : false;

  return (
    // Without a selection the overview uses the full width; editing switches to list + editor.
    <section className={draft ? 'split' : 'overview'}>
      <div className="list">
        <h1>Folien</h1>
        {can(user, 'editor') && (
          <div className="types">
            {types.filter((t) => mayEdit(t.id)).map((t) => (
              <button key={t.id} title={t.description} onClick={() => startNew(t)}>+ {t.name}</button>
            ))}
          </div>
        )}
        <ul className="slide-cards">
          {slides.map((slide) => (
            <li key={slide.id}>
              <button className={draft?.id === slide.id ? 'slide-card active' : 'slide-card'} onClick={() => setDraft({ ...slide })}>
                <SlideThumb slideId={slide.id} version={slide.updatedAt} />
                <span className="slide-card__title">{slide.title}</span>
                <span className="muted">
                  {typeOf(slide.type)?.name ?? slide.type}
                  {slide.published ? '' : ' · Entwurf'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {draft && (
      <div className="detail">
        {type ? (
          <div className="editor">
            <div className="row row--end">
              <button onClick={() => setDraft(null)}>Zur Übersicht</button>
            </div>
            <div className="form">
              <label className="field">
                <span>Titel (intern)</span>
                <input value={draft.title} disabled={!editable} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label className="field">
                <span>Dauer in s (leer = Channel-Standard)</span>
                <input
                  type="number"
                  min={1}
                  value={draft.duration ?? ''}
                  disabled={!editable}
                  onChange={(e) => setDraft({ ...draft, duration: e.target.value ? Number(e.target.value) : null })}
                />
              </label>
              <label className="field field--check">
                <input type="checkbox" checked={draft.published} disabled={!editable} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} />
                Veröffentlicht
              </label>
            </div>
            <h3>{type.name}</h3>
            {!editable && <p className="muted">Dieser Folientyp kann nur von Admins bearbeitet werden.</p>}
            <SchemaForm schema={type.schema} value={draft.config} disabled={!editable} onChange={(config) => setDraft({ ...draft, config })} />
            {editable && (
              <div className="row">
                <button className="primary" onClick={save}>Speichern</button>
                {draft.id && <button className="danger" onClick={remove}>Löschen</button>}
              </div>
            )}
            {draft.id && (
              <div className="preview">
                <div className="row">
                  <strong>Vorschau</strong>
                  <button className={orientation === 'landscape' ? 'active' : ''} onClick={() => setOrientation('landscape')}>16:9</button>
                  <button className={orientation === 'portrait' ? 'active' : ''} onClick={() => setOrientation('portrait')}>9:16</button>
                </div>
                <div className={`preview__frame preview__frame--${orientation}`}>
                  <iframe key={`${draft.id}-${draft.updatedAt}`} title="Vorschau" src={`/p/preview/${draft.id}`} />
                </div>
                <p className="muted">Die Vorschau zeigt den zuletzt gespeicherten Stand.</p>
              </div>
            )}
          </div>
        ) : (
          <p className="error">Unbekannter Folientyp: {draft.type}</p>
        )}
      </div>
      )}
    </section>
  );
}
