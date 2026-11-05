// Search in an image database (Wikimedia Commons, Openverse, Pixabay, Unsplash)
// with previews; one click downloads a hit into the media library.
import { useEffect, useState, type FormEvent } from 'react';
import { api, formatDuration, type MediaItem, type MediaKind, type MediaSourceProvider, type SourceHit, type SourceSearch } from './api.ts';

const STORED_SOURCE = 'foyer.mediaSource';

function storedSource(): string | null {
  try {
    return localStorage.getItem(STORED_SOURCE);
  } catch {
    return null;
  }
}

function storeSource(id: string) {
  try {
    localStorage.setItem(STORED_SOURCE, id);
  } catch {
    // private window: just not remembered
  }
}

function HitCard({ hit, importing, error, actionLabel, onImport, onOpen }: {
  hit: SourceHit;
  importing: boolean;
  error?: string;
  actionLabel: string;
  onImport: () => void;
  onOpen?: (mediaId: string) => void;
}) {
  return (
    <li className="stock-hit">
      <a className="media-thumb" href={hit.pageUrl} target="_blank" rel="noreferrer" title="Auf der Seite der Bilddatenbank ansehen">
        {/* No preview from the database: the dark box stays, without the broken-image icon. */}
        <img src={hit.thumb} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        {hit.kind === 'video' && hit.duration !== null && <span className="media-thumb__badge">▶ {formatDuration(hit.duration)}</span>}
      </a>
      <span className="stock-hit__title" title={hit.title ?? undefined}>{hit.title || 'Ohne Titel'}</span>
      <span className="muted stock-hit__meta">
        {hit.author ? `von ${hit.author}` : 'Urheber unbekannt'}
        {hit.width && hit.height ? ` · ${hit.width}×${hit.height}` : ''}
      </span>
      <span className="stock-hit__license">
        <span className="badge" title={hit.attribution ? 'Die Lizenz verlangt einen Bildnachweis, wo das Bild gezeigt wird' : 'Kein Bildnachweis nötig'}>
          {hit.license}
        </span>
        {hit.attribution && <span className="muted">Nachweis nötig</span>}
      </span>
      {hit.mediaId ? (
        <button onClick={() => onOpen?.(hit.mediaId!)} disabled={!onOpen}>In der Mediathek ✓</button>
      ) : (
        <button className="primary" onClick={onImport} disabled={importing}>{importing ? 'Wird übernommen …' : actionLabel}</button>
      )}
      {error && <span className="error stock-hit__error">{error}</span>}
    </li>
  );
}

/**
 * `kind` fixed: only that kind (media picker); otherwise a choice of images and videos.
 * `onImported` gets the new library item (still being converted).
 */
export function StockSearch({ kind: fixedKind, actionLabel = 'Übernehmen', onImported, onOpen, onError }: {
  kind?: MediaKind;
  actionLabel?: string;
  onImported: (item: MediaItem) => void;
  onOpen?: (mediaId: string) => void;
  onError: (e: unknown) => void;
}) {
  const [sources, setSources] = useState<MediaSourceProvider[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(storedSource);
  const [kindChoice, setKind] = useState<MediaKind>('image');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState<{ q: string; page: number } | null>(null);
  const [result, setResult] = useState<SourceSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const kind = fixedKind ?? kindChoice;

  useEffect(() => void api.get<MediaSourceProvider[]>('/media-sources').then(setSources, onError), []);

  const usable = (sources ?? []).filter((s) => s.kinds.includes(kind));
  const source = usable.find((s) => s.id === sourceId && s.ready) ?? usable.find((s) => s.ready) ?? null;

  const run = async (q: string, page: number) => {
    if (!source || !q.trim()) return;
    setLoading(true);
    setSearchError(null);
    try {
      const params = new URLSearchParams({ q: q.trim(), kind, page: String(page) });
      const next = await api.get<SourceSearch>(`/media-sources/${source.id}/search?${params}`);
      setResult((prev) => (page > 1 && prev ? { ...next, hits: [...prev.hits, ...next.hits.filter((h) => !prev.hits.some((p) => p.id === h.id))] } : next));
      setSearched({ q: q.trim(), page });
    } catch (e) {
      setSearchError((e as Error).message);
      if (page === 1) setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // A new source or kind searches the same words again.
  useEffect(() => {
    setResult(null);
    setErrors({});
    if (searched) void run(searched.q, 1);
  }, [source?.id, kind]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    void run(query, 1);
  };

  const importHit = async (hit: SourceHit) => {
    if (!source) return;
    setImporting((set) => new Set(set).add(hit.id));
    setErrors(({ [hit.id]: _, ...rest }) => rest);
    try {
      const item = await api.post<MediaItem & { existing: boolean }>('/media/import', { source: source.id, id: hit.id, kind: hit.kind });
      setResult((prev) => prev && { ...prev, hits: prev.hits.map((h) => (h.id === hit.id ? { ...h, mediaId: item.id } : h)) });
      onImported(item);
    } catch (e) {
      setErrors((all) => ({ ...all, [hit.id]: (e as Error).message }));
    } finally {
      setImporting((set) => {
        const next = new Set(set);
        next.delete(hit.id);
        return next;
      });
    }
  };

  if (!sources) return null;
  return (
    <div className="stock">
      <div className="row stock__sources" role="group" aria-label="Bilddatenbank">
        {usable.map((s) => (
          <button
            key={s.id}
            className={s.id === source?.id ? 'active' : ''}
            disabled={!s.ready}
            title={s.ready ? undefined : 'API-Schlüssel fehlt; ein Admin trägt ihn unter Einstellungen → Bilddatenbanken ein'}
            onClick={() => {
              setSourceId(s.id);
              storeSource(s.id);
            }}
          >
            {s.name}
            {!s.ready && ' (kein Schlüssel)'}
          </button>
        ))}
        {!fixedKind && (
          <span className="stock__kinds">
            {(['image', 'video'] as const).map((k) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {k === 'image' ? 'Bilder' : 'Videos'}
              </button>
            ))}
          </span>
        )}
      </div>
      {!source ? (
        <p className="muted">
          {usable.length
            ? 'Für keine dieser Bilddatenbanken ist ein API-Schlüssel eingetragen. Ein Admin kann das unter Einstellungen nachholen.'
            : `Keine Bilddatenbank liefert ${kind === 'video' ? 'Videos' : 'Bilder'}.`}
        </p>
      ) : (
        <>
          <form className="row stock__form" onSubmit={submit}>
            <input
              type="search"
              placeholder={`In ${source.name} suchen, z. B. „Herbstwald“`}
              value={query}
              maxLength={100}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Suchbegriff"
            />
            <button className="primary" type="submit" disabled={!query.trim() || loading}>{loading ? 'Suche …' : 'Suchen'}</button>
          </form>
          <p className="muted stock__terms">
            Ergebnisse von{' '}
            <a href={source.homepage} target="_blank" rel="noreferrer">{source.name}</a>. {source.terms}
          </p>
          {searchError && <p className="error">{searchError}</p>}
          {result && !result.hits.length && <p className="muted">Keine Treffer für „{searched?.q}“.</p>}
          {result && result.hits.length > 0 && (
            <>
              <ul className="stock-grid">
                {result.hits.map((hit) => (
                  <HitCard
                    key={hit.id}
                    hit={hit}
                    importing={importing.has(hit.id)}
                    error={errors[hit.id]}
                    actionLabel={actionLabel}
                    onImport={() => void importHit(hit)}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
              <div className="row">
                {result.hasMore && (
                  <button onClick={() => searched && void run(searched.q, searched.page + 1)} disabled={loading}>
                    {loading ? 'Lädt …' : 'Mehr laden'}
                  </button>
                )}
                {result.total !== null && <span className="muted">{result.total.toLocaleString('de-DE')} Treffer</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
