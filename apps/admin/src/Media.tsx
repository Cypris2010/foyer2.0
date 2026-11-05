// Media library: upload with progress, import from image databases, transcoding
// status, credits, "used in", and a picker for slide backgrounds and media fields.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, can, formatBytes, formatDuration, uploadMedia, type MediaItem, type MediaKind, type User } from './api.ts';
import { StockSearch } from './StockSearch.tsx';

const KIND_LABEL: Record<MediaKind, string> = { image: 'Bild', video: 'Video' };
const ACCEPT: Record<MediaKind | 'all', string> = {
  image: 'image/*,.heic,.heif',
  video: 'video/*,.mkv',
  all: 'image/*,video/*,.heic,.heif,.mkv',
};

/** Loads the library and refreshes it while files are still being processed. */
function useMediaList(kind: MediaKind | 'all', onError: (e: unknown) => void) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = () =>
    api
      .get<MediaItem[]>(kind === 'all' ? '/media' : `/media?kind=${kind}`)
      .then((list) => {
        setItems(list);
        setLoaded(true);
      })
      .catch(onError);
  useEffect(() => void load(), [kind]);
  const busy = items.some((m) => m.status === 'queued' || m.status === 'processing');
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [busy, kind]);
  return { items, loaded, reload: load };
}

function statusText(item: MediaItem): string {
  if (item.status === 'queued') return 'Wartet auf Umwandlung';
  if (item.status === 'processing') return item.kind === 'video' ? `Wird umgewandelt … ${Math.round((item.progress ?? 0) * 100)} %` : 'Wird verarbeitet …';
  if (item.status === 'failed') return 'Fehler';
  return '';
}

function MediaThumb({ item }: { item: MediaItem }) {
  return (
    <span className="media-thumb">
      {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <span className="media-thumb__empty">{statusText(item) || KIND_LABEL[item.kind]}</span>}
      {item.kind === 'video' && item.duration !== null && <span className="media-thumb__badge">▶ {formatDuration(item.duration)}</span>}
      {item.status === 'processing' && item.progress !== null && (
        <span className="media-thumb__progress" style={{ transform: `scaleX(${item.progress})` }} />
      )}
    </span>
  );
}

interface UploadState {
  key: string;
  name: string;
  progress: number;
  error?: string;
}

/** Drop zone and file button; uploads one file after the other. */
function Uploader({ kind, onUploaded, onError }: { kind: MediaKind | 'all'; onUploaded: (item: MediaItem) => void; onError: (e: unknown) => void }) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<UploadState>) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const start = async (files: File[]) => {
    const queued = files.map((file) => ({ file, key: `${file.name}-${file.size}-${Math.random()}` }));
    setUploads((list) => [...list, ...queued.map(({ file, key }) => ({ key, name: file.name, progress: 0 }))]);
    for (const { file, key } of queued) {
      try {
        const item = await uploadMedia(file, (progress) => update(key, { progress }));
        setUploads((list) => list.filter((u) => u.key !== key));
        onUploaded(item);
      } catch (err) {
        update(key, { error: (err as Error).message });
      }
    }
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void start(files).catch(onError);
  };

  return (
    <div className="uploader">
      <div
        className={over ? 'dropzone is-over' : 'dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        <span><strong>Dateien hierher ziehen</strong> oder klicken zum Auswählen</span>
        <span className="muted">
          {kind === 'video' ? 'MP4, MOV, WebM' : kind === 'image' ? 'JPEG, PNG, WebP, HEIC' : 'Bilder (JPEG, PNG, WebP, HEIC) und Videos (MP4, MOV, WebM)'}
          {kind !== 'image' && ' · Videos werden automatisch für die Displays umgewandelt (1080p, 30 fps)'}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT[kind]}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void start(files).catch(onError);
          }}
        />
      </div>
      {uploads.length > 0 && (
        <ul className="uploads">
          {uploads.map((u) => (
            <li key={u.key}>
              <span className="uploads__name">{u.name}</span>
              {u.error ? (
                <>
                  <span className="error">{u.error}</span>
                  <button onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}>×</button>
                </>
              ) : (
                <>
                  <progress max={1} value={u.progress} />
                  <span className="muted">{Math.round(u.progress * 100)} %</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MediaGrid({ items, selectedId, onSelect, disabled }: { items: MediaItem[]; selectedId?: string | null; onSelect: (item: MediaItem) => void; disabled?: (item: MediaItem) => boolean }) {
  return (
    <ul className="media-grid">
      {items.map((item) => (
        <li key={item.id}>
          <button className={item.id === selectedId ? 'media-card active' : 'media-card'} disabled={disabled?.(item)} onClick={() => onSelect(item)} title={item.name}>
            <MediaThumb item={item} />
            <span className="media-card__name">{item.name}</span>
            <span className="muted media-card__meta">
              {KIND_LABEL[item.kind]}
              {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
              {item.source ? ` · ${item.source.license}` : ''}
              {item.status === 'failed' ? ' · Fehler' : item.usageCount ? ` · ${item.usageCount}× verwendet` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const external = (href: string | null, text: string) =>
  href ? (
    <a href={href} target="_blank" rel="noreferrer">{text}</a>
  ) : (
    text
  );

/** Author, source and license of an imported item; the credit line for displays. */
function SourceInfo({ item, editable, onCredit }: { item: MediaItem; editable: boolean; onCredit: (show: boolean) => void }) {
  const source = item.source!;
  return (
    <>
      <h3>Herkunft</h3>
      <table className="table media-info">
        <tbody>
          <tr><th>Urheber</th><td>{external(source.authorUrl, source.author ?? 'unbekannt')}</td></tr>
          {source.title && <tr><th>Titel</th><td>{source.title}</td></tr>}
          <tr>
            <th>Quelle</th>
            <td>
              {external(source.pageUrl, source.via)}
              {source.via !== source.providerName && <span className="muted"> (gefunden über {source.providerName})</span>}
            </td>
          </tr>
          <tr>
            <th>Lizenz</th>
            <td>
              {external(source.licenseUrl, source.license)}
              <div className="muted">{source.attribution ? 'Namensnennung ist Pflicht, wo das Medium gezeigt wird.' : 'Keine Namensnennung nötig.'}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <label className="field--check credit-toggle">
        <input type="checkbox" checked={item.showCredit} disabled={!editable} onChange={(e) => onCredit(e.target.checked)} />
        <span>Bildnachweis auf den Displays zeigen</span>
      </label>
      <p className="credit-preview">{item.credit}</p>
      {source.attribution && !item.showCredit && (
        <p className="error">Die Lizenz verlangt den Bildnachweis. Ohne ihn darf das Medium nur gezeigt werden, wenn der Nachweis anders sichtbar ist.</p>
      )}
    </>
  );
}

function MediaDetail({ id, user, onChanged, onClose, onError }: { id: string; user: User; onChanged: () => void; onClose: () => void; onError: (e: unknown) => void }) {
  const [item, setItem] = useState<MediaItem | null>(null);
  const [name, setName] = useState('');
  const editable = can(user, 'editor');

  const load = () =>
    api
      .get<MediaItem>(`/media/${id}`)
      .then((m) => {
        setItem(m);
        setName(m.name);
      })
      .catch(onError);
  useEffect(() => void load(), [id]);
  // Follow the transcoding progress.
  useEffect(() => {
    if (!item || (item.status !== 'queued' && item.status !== 'processing')) return;
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, [item]);

  if (!item) return null;

  const rename = async () => {
    try {
      await api.patch(`/media/${id}`, { name });
      await load();
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  const setCredit = async (showCredit: boolean) => {
    try {
      await api.patch(`/media/${id}`, { showCredit });
      await load();
    } catch (e) {
      onError(e);
    }
  };
  const retry = async () => {
    try {
      await api.post(`/media/${id}/retry`);
      await load();
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  const remove = async () => {
    if (!confirm(`„${item.name}“ endgültig löschen?`)) return;
    try {
      await api.del(`/media/${id}`);
      onChanged();
      onClose();
    } catch (e) {
      onError(e);
    }
  };

  const used = item.usage ?? [];
  return (
    <div className="editor">
      <div className="row row--end">
        <button onClick={onClose}>Zur Übersicht</button>
      </div>
      <div className="media-preview">
        {item.status === 'ready' && item.url ? (
          item.kind === 'image' ? (
            <img src={item.url} alt={item.name} />
          ) : (
            <video src={item.url} poster={item.poster ?? undefined} controls muted playsInline preload="metadata" />
          )
        ) : (
          <div className="media-preview__status">
            <p>{statusText(item)}</p>
            {item.status === 'processing' && item.progress !== null && <progress max={1} value={item.progress} />}
            {item.error && <p className="error">{item.error}</p>}
            {item.status === 'failed' && editable && <button onClick={retry}>Erneut versuchen</button>}
          </div>
        )}
      </div>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <div className="row" style={{ margin: 0 }}>
            <input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            {editable && name !== item.name && name.trim() && <button onClick={rename}>Umbenennen</button>}
          </div>
        </label>
      </div>
      <table className="table media-info">
        <tbody>
          <tr><th>Typ</th><td>{KIND_LABEL[item.kind]}</td></tr>
          {item.width && item.height && <tr><th>Original</th><td>{item.width} × {item.height} px · {formatBytes(item.size)}</td></tr>}
          {item.duration !== null && <tr><th>Dauer</th><td>{formatDuration(item.duration)}</td></tr>}
          {Object.entries(item.variants).map(([key, v]) => (
            <tr key={key}>
              <th>{key === 'main' ? 'Für Displays' : 'Kleine Variante'}</th>
              <td>{v.width} × {v.height} px{item.kind === 'video' ? ` · H.264${key === 'main' ? ', ≤ 30 fps' : ''}` : ''}</td>
            </tr>
          ))}
          <tr><th>{item.source ? 'Übernommen' : 'Hochgeladen'}</th><td>{new Date(item.createdAt).toLocaleString('de-DE')}</td></tr>
        </tbody>
      </table>
      {item.source && <SourceInfo item={item} editable={editable} onCredit={setCredit} />}
      <h3>Verwendet in</h3>
      {used.length ? (
        <ul className="usage">
          {used.map((s) => (
            <li key={s.id}><a href="#slides">{s.title}</a></li>
          ))}
        </ul>
      ) : (
        <p className="muted">Wird in keiner Folie verwendet.</p>
      )}
      {editable && (
        <div className="row">
          <button className="danger" onClick={remove} disabled={used.length > 0} title={used.length ? 'Erst aus den Folien entfernen' : undefined}>
            Löschen
          </button>
          {used.length > 0 && <span className="muted">Löschen geht erst, wenn keine Folie die Datei mehr nutzt.</span>}
        </div>
      )}
    </div>
  );
}

export function MediaPage({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [kind, setKind] = useState<MediaKind | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const { items, loaded, reload } = useMediaList(kind, onError);
  const editor = can(user, 'editor');

  return (
    <section className={selected ? 'split split--media' : 'overview'}>
      <div className="list">
        <h1>Medien</h1>
        {editor && (
          <div className="row tabs">
            <button className={!searching ? 'active' : ''} onClick={() => setSearching(false)}>Mediathek</button>
            <button className={searching ? 'active' : ''} onClick={() => setSearching(true)}>Aus Bilddatenbank</button>
          </div>
        )}
        {searching && editor ? (
          <StockSearch
            onError={onError}
            onOpen={setSelected}
            onImported={(item) => {
              void reload();
              setSelected(item.id);
            }}
          />
        ) : (
          <>
            <div className="row">
              {(['all', 'image', 'video'] as const).map((k) => (
                <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                  {k === 'all' ? 'Alle' : k === 'image' ? 'Bilder' : 'Videos'}
                </button>
              ))}
            </div>
            {can(user, 'editor') && (
              <Uploader
                kind="all"
                onError={onError}
                onUploaded={(item) => {
                  void reload();
                  if (!selected) setSelected(item.id);
                }}
              />
            )}
            {loaded && !items.length && <p className="muted">Noch keine {kind === 'image' ? 'Bilder' : kind === 'video' ? 'Videos' : 'Medien'}.</p>}
            <MediaGrid items={items} selectedId={selected} onSelect={(item) => setSelected(item.id)} />
          </>
        )}
      </div>
      {selected && (
        <div className="detail">
          <MediaDetail key={selected} id={selected} user={user} onChanged={reload} onClose={() => setSelected(null)} onError={onError} />
        </div>
      )}
    </section>
  );
}

/** Modal to choose one item of a kind; uploading right here is possible too. */
export function MediaPicker({ kind, user, onPick, onClose, onError }: { kind: MediaKind; user: User; onPick: (item: MediaItem) => void; onClose: () => void; onError: (e: unknown) => void }) {
  const { items, loaded, reload } = useMediaList(kind, onError);
  const [searching, setSearching] = useState(false);
  const editor = can(user, 'editor');
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box modal__box--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>{kind === 'image' ? 'Bild wählen' : 'Video wählen'}</h2>
          <button onClick={onClose}>×</button>
        </div>
        {editor && (
          <div className="row tabs" style={{ margin: 0 }}>
            <button className={!searching ? 'active' : ''} onClick={() => setSearching(false)}>Mediathek</button>
            <button className={searching ? 'active' : ''} onClick={() => setSearching(true)}>Aus Bilddatenbank</button>
          </div>
        )}
        {searching && editor ? (
          <div className="picker-grid">
            <StockSearch
              kind={kind}
              actionLabel="Übernehmen und wählen"
              onError={onError}
              onImported={onPick}
              onOpen={(id) => void api.get<MediaItem>(`/media/${id}`).then(onPick, onError)}
            />
          </div>
        ) : (
          <>
            {editor && <Uploader kind={kind} onError={onError} onUploaded={() => void reload()} />}
            {loaded && !items.length && <p className="muted">Noch keine {kind === 'image' ? 'Bilder' : 'Videos'} in der Mediathek.</p>}
            <div className="picker-grid">
              <MediaGrid items={items} onSelect={onPick} disabled={(item) => item.status === 'failed'} />
            </div>
          </>
        )}
        {kind === 'video' && <p className="muted">Videos, die noch umgewandelt werden, kann man schon wählen. Die Displays zeigen sie, sobald sie fertig sind.</p>}
      </div>
    </div>
  );
}

/** Selected media item with "change" and "remove"; used by backgrounds and schema fields. */
export function MediaField({ kind, value, user, disabled, onChange, onError }: { kind: MediaKind; value: string | null; user: User; disabled?: boolean; onChange: (id: string | null) => void; onError: (e: unknown) => void }) {
  const [item, setItem] = useState<MediaItem | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!value) return setItem(null);
    api.get<MediaItem>(`/media/${value}`).then(setItem, () => setItem(null));
  }, [value]);
  // Keep the status current while the chosen video is still being converted.
  useEffect(() => {
    if (!item || (item.status !== 'queued' && item.status !== 'processing')) return;
    const timer = setTimeout(() => api.get<MediaItem>(`/media/${item.id}`).then(setItem, () => undefined), 2000);
    return () => clearTimeout(timer);
  }, [item]);

  return (
    <div className="media-field">
      {value && item ? (
        <>
          <MediaThumb item={item} />
          <span className="media-field__info">
            <strong>{item.name}</strong>
            <span className="muted">{statusText(item) || (item.width ? `${item.width}×${item.height}` : '')}</span>
          </span>
        </>
      ) : value ? (
        <span className="error">Datei nicht mehr vorhanden</span>
      ) : (
        <span className="muted">Keine Datei gewählt</span>
      )}
      {!disabled && (
        <span className="row" style={{ margin: 0 }}>
          <button onClick={() => setPicking(true)}>{value ? 'Ändern' : kind === 'image' ? 'Bild wählen' : 'Video wählen'}</button>
          {value && <button onClick={() => onChange(null)}>Entfernen</button>}
        </span>
      )}
      {picking && (
        <MediaPicker
          kind={kind}
          user={user}
          onError={onError}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false);
            onChange(picked.id);
          }}
        />
      )}
    </div>
  );
}
