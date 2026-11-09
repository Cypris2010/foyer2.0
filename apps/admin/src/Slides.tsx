import { useEffect, useState } from 'react';
import { api, can, type Background, type Slide, type SlideType, type User } from './api.ts';
import { defaultsFor, SchemaForm } from './SchemaForm.tsx';
import { PlayerThumb } from './PlayerThumb.tsx';
import { MediaField } from './Media.tsx';

const BACKGROUND_LABEL = { color: 'Farbe', image: 'Bild', video: 'Video' } as const;

/** Background of a slide: none, a colour, or an image/video from the media library. */
function BackgroundEditor({ allowed, value, user, disabled, onChange, onError }: {
  allowed: Array<keyof typeof BACKGROUND_LABEL>;
  value: Background | null;
  user: User;
  disabled: boolean;
  onChange: (value: Background | null) => void;
  onError: (e: unknown) => void;
}) {
  const choose = (kind: 'none' | keyof typeof BACKGROUND_LABEL) => {
    if (kind === 'none') return onChange(null);
    if (kind === 'color') return onChange({ kind: 'color', value: value?.kind === 'color' ? value.value : '#0f172a' });
    const dim = value && value.kind !== 'color' ? value.dim : 0;
    if (kind === 'image') return onChange({ kind: 'image', mediaId: '', fit: 'cover', dim, zoom: false });
    onChange({ kind: 'video', mediaId: '', dim });
  };
  const current = value?.kind ?? 'none';
  return (
    <div className="form">
      <div className="chips">
        {(['none', ...allowed] as const).map((kind) => (
          <label key={kind} className={current === kind ? 'chip is-active' : 'chip'}>
            <input type="radio" name="background" checked={current === kind} disabled={disabled} onChange={() => choose(kind)} />
            {kind === 'none' ? 'Keiner' : BACKGROUND_LABEL[kind]}
          </label>
        ))}
      </div>
      {value?.kind === 'color' && (
        <label className="field field--inline">
          <input type="color" value={value.value} disabled={disabled} onChange={(e) => onChange({ ...value, value: e.target.value })} />
          <span>{value.value}</span>
        </label>
      )}
      {value && value.kind !== 'color' && (
        <>
          <MediaField
            kind={value.kind}
            value={value.mediaId || null}
            user={user}
            disabled={disabled}
            onError={onError}
            onChange={(mediaId) => (mediaId ? onChange({ ...value, mediaId }) : onChange(null))}
          />
          {value.kind === 'image' && (
            <>
              <label className="field">
                <span>Darstellung</span>
                <select value={value.fit} disabled={disabled} onChange={(e) => onChange({ ...value, fit: e.target.value as 'cover' | 'contain' })}>
                  <option value="cover">Bildschirm füllen (Ränder werden abgeschnitten)</option>
                  <option value="contain">Ganz zeigen (mit Rand)</option>
                </select>
              </label>
              <label className="field field--inline">
                <input type="checkbox" checked={value.zoom === true} disabled={disabled} onChange={(e) => onChange({ ...value, zoom: e.target.checked })} />
                <span>Langsam hineinzoomen</span>
              </label>
            </>
          )}
          <label className="field">
            <span>Abdunkeln für bessere Lesbarkeit: {value.dim} %</span>
            <input type="range" min={0} max={80} step={5} value={value.dim} disabled={disabled} onChange={(e) => onChange({ ...value, dim: Number(e.target.value) })} />
          </label>
        </>
      )}
    </div>
  );
}

interface Draft {
  id: string | null;
  title: string;
  type: string;
  config: Record<string, unknown>;
  background: Background | null;
  duration: number | null;
  published: boolean;
  updatedAt?: number;
}

export function Slides({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [types, setTypes] = useState<SlideType[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);

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
    setDraft({ id: null, title: `Neue ${type.name}-Folie`, type: type.id, config: defaultsFor(type.schema), background: null, duration: null, published: true });

  return (
    <section>
      <h1>Folien</h1>
      {can(user, 'editor') && (
        <div className="types">
          {types.filter((t) => mayEdit(t.id)).map((t) => (
            <button key={t.id} title={t.description} onClick={() => startNew(t)}>+ {t.name}</button>
          ))}
        </div>
      )}
      {!slides.length && <p className="muted">Noch keine Folien.</p>}
      <ul className="slide-cards">
        {slides.map((slide) => (
          <li key={slide.id}>
            <button className={draft?.id === slide.id ? 'slide-card active' : 'slide-card'} onClick={() => setDraft({ ...slide })}>
              <PlayerThumb src={`/p/preview/${slide.id}`} reloadKey={slide.updatedAt} />
              <span className="slide-card__title">{slide.title}</span>
              <span className="muted">
                {typeOf(slide.type)?.name ?? slide.type}
                {slide.published ? '' : ' · Entwurf'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {draft && (
        <SlideEditor
          key={draft.id ?? 'new'}
          initial={draft}
          type={typeOf(draft.type)}
          editable={mayEdit(draft.type)}
          user={user}
          onError={onError}
          onSaved={(saved) => {
            setDraft(saved);
            void load();
          }}
          onDeleted={() => {
            setDraft(null);
            void load();
          }}
          onClose={() => setDraft(null)}
        />
      )}
    </section>
  );
}

interface EditorProps {
  initial: Draft;
  type: SlideType | undefined;
  editable: boolean;
  user: User;
  onError: (e: unknown) => void;
  onSaved: (saved: Draft) => void;
  onDeleted: () => void;
  onClose: () => void;
}

/** Edit dialog over the slide grid: form on the left, preview of the saved state on the right. */
function SlideEditor({ initial, type, editable, user, onError, onSaved, onDeleted, onClose }: EditorProps) {
  const [draft, setDraft] = useState<Draft>(initial);
  // What the server has; closing with other values asks first.
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const dirty = draft.id === null || JSON.stringify(draft) !== saved;

  const close = () => {
    if (editable && dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A media picker opened from the form sits on top and closes first.
      if (e.key === 'Escape' && document.querySelectorAll('.modal').length === 1) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const save = async () => {
    setBusy(true);
    try {
      // An image/video background without a chosen file counts as none.
      const background = draft.background && draft.background.kind !== 'color' && !draft.background.mediaId ? null : draft.background;
      const body = { title: draft.title, type: draft.type, config: draft.config, background, duration: draft.duration, published: draft.published };
      const res = draft.id ? await api.put<{ id: string }>(`/slides/${draft.id}`, body) : await api.post<{ id: string }>('/slides', body);
      const fresh: Draft = { ...(await api.get<Slide>(`/slides/${res.id}`)) };
      setDraft(fresh);
      setSaved(JSON.stringify(fresh));
      setJustSaved(true);
      onSaved(fresh);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id || !confirm(`Folie „${draft.title}“ löschen?`)) return;
    try {
      await api.del(`/slides/${draft.id}`);
      onDeleted();
    } catch (e) {
      onError(e);
    }
  };

  const change = (next: Draft) => {
    setDraft(next);
    setJustSaved(false);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={draft.title} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal__box modal__box--editor">
        <header className="modal__head">
          <div>
            <h2>{draft.id ? draft.title : `Neue Folie: ${type?.name ?? draft.type}`}</h2>
            {draft.id && <span className="muted">{type?.name ?? draft.type}</span>}
          </div>
          <button onClick={close} aria-label="Schließen">×</button>
        </header>
        {!type ? (
          <p className="error">Unbekannter Folientyp: {draft.type}</p>
        ) : (
          <div className="slide-editor">
            <div className="slide-editor__form">
              <div className="form">
                <label className="field">
                  <span>Titel (intern)</span>
                  <input value={draft.title} disabled={!editable} onChange={(e) => change({ ...draft, title: e.target.value })} />
                </label>
                <label className="field">
                  <span>{type.durationFromMedia ? 'Dauer in s (leer = so lange wie das Video, sonst in Schleife bis dahin)' : 'Dauer in s (leer = Channel-Standard)'}</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.duration ?? ''}
                    disabled={!editable}
                    onChange={(e) => change({ ...draft, duration: e.target.value ? Number(e.target.value) : null })}
                  />
                </label>
                <label className="field field--check">
                  <input type="checkbox" checked={draft.published} disabled={!editable} onChange={(e) => change({ ...draft, published: e.target.checked })} />
                  Veröffentlicht
                </label>
              </div>
              <h3>{type.name}</h3>
              {!editable && <p className="muted">Dieser Folientyp kann nur von Admins bearbeitet werden.</p>}
              <SchemaForm schema={type.schema} typeId={type.id} value={draft.config} disabled={!editable} user={user} onError={onError} onChange={(config) => change({ ...draft, config })} />
              {type.backgrounds && type.backgrounds.length > 0 && (
                <>
                  <h3>Hintergrund</h3>
                  <BackgroundEditor
                    allowed={type.backgrounds}
                    value={draft.background}
                    user={user}
                    disabled={!editable}
                    onError={onError}
                    onChange={(background) => change({ ...draft, background })}
                  />
                </>
              )}
            </div>
            <div className="slide-editor__preview">
              <div className="row">
                <strong>Vorschau</strong>
                <button className={orientation === 'landscape' ? 'active' : ''} onClick={() => setOrientation('landscape')}>16:9</button>
                <button className={orientation === 'portrait' ? 'active' : ''} onClick={() => setOrientation('portrait')}>9:16</button>
              </div>
              <div className={`preview__frame preview__frame--${orientation}`}>
                {draft.id ? (
                  <iframe key={`${draft.id}-${draft.updatedAt}`} title="Vorschau" src={`/p/preview/${draft.id}`} />
                ) : (
                  <p className="preview__empty">Die Vorschau erscheint nach dem ersten Speichern.</p>
                )}
              </div>
              <p className="muted">{draft.id && dirty ? 'Die Vorschau zeigt den zuletzt gespeicherten Stand.' : '\u00a0'}</p>
            </div>
          </div>
        )}
        {type && editable && (
          <footer className="modal__foot">
            <button className="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Speichert …' : 'Speichern'}</button>
            {justSaved && !dirty && <span className="saved">Gespeichert</span>}
            <span className="spacer" />
            {draft.id && <button className="danger" onClick={remove}>Löschen</button>}
          </footer>
        )}
      </div>
    </div>
  );
}
