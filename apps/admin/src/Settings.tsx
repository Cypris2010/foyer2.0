// Settings: everyone manages their AI access (API keys); admins also the
// connections to outside services (WebUntis-API, image databases).
import { useEffect, useState, type FormEvent } from 'react';
import { api, can, type User } from './api.ts';
import { AiAccessSettings } from './AiAccess.tsx';

interface UntisApiState {
  url: string;
  keySet: boolean;
  /** End of the stored key ("…1a2b"); the key itself never comes back. */
  keyHint: string | null;
  keyUnreadable: boolean;
}

type Check = { ok: true; count: number } | { ok: false; error: string };
interface UntisApiTest {
  lessons: Check;
  rooms: Check;
  teachers: Check;
}

const CHECKS: Array<[keyof UntisApiTest, string, string]> = [
  ['lessons', 'Stunden heute', 'Freigabe „stundenplan“, nötig für beide Folien'],
  ['rooms', 'Räume', 'Freigabe „stundenplan“, Auswahlliste der Raumanzeige'],
  ['teachers', 'Lehrkräfte', 'Freigabe „stammdaten“, optional: auch Lehrkräfte ohne Unterricht heute'],
];

function UntisApiSettings({ onError }: { onError: (e: unknown) => void }) {
  const [state, setState] = useState<UntisApiState | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<UntisApiTest | null>(null);
  const [testing, setTesting] = useState(false);

  const apply = (next: UntisApiState) => {
    setState(next);
    setUrl(next.url);
    setKey('');
  };
  useEffect(() => void api.get<UntisApiState>('/settings/untis-api').then(apply, onError), []);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.post<UntisApiTest>('/settings/untis-api/test'));
    } catch (e) {
      onError(e);
    } finally {
      setTesting(false);
    }
  };

  const save = async (e: FormEvent, body: { url: string; key?: string } = { url, ...(key ? { key } : {}) }) => {
    e.preventDefault();
    try {
      apply(await api.put<UntisApiState>('/settings/untis-api', body));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (body.url && (body.key || state?.keySet)) void runTest();
      else setTest(null);
    } catch (err) {
      onError(err);
    }
  };

  const removeKey = (e: FormEvent) => {
    if (!confirm('Gespeicherten API-Schlüssel löschen? Die WebUntis-Folien zeigen dann keine Daten mehr.')) return;
    void save(e, { url, key: '' });
  };

  if (!state) return null;
  return (
    <section className="card card--wide" id="settings-untis">
      <header>
        <h2>WebUntis-API</h2>
        <span className={state.keySet && state.url ? 'badge ok' : 'badge off'}>{state.keySet && state.url ? 'eingerichtet' : 'nicht eingerichtet'}</span>
      </header>
      <p className="muted">
        Datenquelle für die Raumanzeige und das Lehrkräfte-Dashboard (WebUntis-Datendienst). Folien ohne eigene TXT-Adresse nutzen diese
        Verbindung. Der Schlüssel wird verschlüsselt gespeichert und nicht wieder angezeigt.
      </p>
      <form className="form" onSubmit={(e) => void save(e)}>
        <div className="row row--fields">
          <label className="field">
            <span>Adresse</span>
            <input type="url" placeholder="https://webuntis-api.example.de" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="field">
            <span>
              API-Schlüssel
              {state.keySet && ` (gespeichert: ${state.keyHint}; leer lassen, um ihn zu behalten)`}
              {state.keyUnreadable && ' (gespeicherter Schlüssel nicht mehr lesbar, bitte neu eingeben)'}
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={state.keySet ? '••••••••' : 'wu_…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        </div>
        <div className="row">
          <button className="primary" type="submit">Speichern</button>
          <button type="button" disabled={!state.keySet || !state.url || testing} onClick={() => void runTest()}>
            {testing ? 'Teste …' : 'Verbindung testen'}
          </button>
          {state.keySet && (
            <button type="button" className="danger" onClick={removeKey}>Schlüssel löschen</button>
          )}
          {saved && <span className="saved">Gespeichert</span>}
        </div>
      </form>
      {test && (
        <ul className="checks">
          {CHECKS.map(([name, label, hint]) => {
            const check = test[name];
            return (
              <li key={name}>
                <span className={check.ok ? 'badge ok' : 'badge bad'}>{check.ok ? '✓' : '✗'}</span> <strong>{label}</strong>
                {check.ok ? `: ${check.count}` : `: ${check.error}`}
                <div className="muted">{hint}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface MediaSourceState {
  id: string;
  name: string;
  kinds: Array<'image' | 'video'>;
  terms: string;
  homepage: string;
  needsKey: boolean;
  /** Where to get a key. */
  signup: string | null;
  placeholder: string | null;
  keySet: boolean;
  keyHint: string | null;
  keyUnreadable: boolean;
}

/** One image database: key (if it needs one) and a connection test. */
function MediaSourceCard({ source, onSaved, onError }: { source: MediaSourceState; onSaved: (all: MediaSourceState[]) => void; onError: (e: unknown) => void }) {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<(Check & { more?: boolean }) | null>(null);
  const [testing, setTesting] = useState(false);
  const ready = !source.needsKey || source.keySet;

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.post<Check & { more?: boolean }>(`/settings/media-sources/${source.id}/test`));
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const store = async (value: string) => {
    try {
      onSaved(await api.put<MediaSourceState[]>(`/settings/media-sources/${source.id}`, { key: value }));
      setKey('');
      setTest(null);
      if (value) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) {
      onError(e);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) void store(key.trim());
  };

  const removeKey = () => {
    if (!confirm(`API-Schlüssel für ${source.name} löschen? Die Suche dort geht dann nicht mehr; übernommene Medien bleiben.`)) return;
    void store('');
  };

  return (
    <div className="media-source">
      <header>
        <strong>{source.name}</strong>
        <span className="muted"> · {source.kinds.map((k) => (k === 'image' ? 'Bilder' : 'Videos')).join(' und ')}</span>
        <span className={ready ? 'badge ok' : 'badge off'}>{!source.needsKey ? 'ohne Schlüssel' : source.keySet ? 'eingerichtet' : 'kein Schlüssel'}</span>
      </header>
      <p className="muted">{source.terms}</p>
      {source.needsKey && (
        <form className="form" onSubmit={save}>
          <label className="field">
            <span>
              API-Schlüssel
              {source.keySet && ` (gespeichert: ${source.keyHint}; neuen eingeben, um ihn zu ersetzen)`}
              {source.keyUnreadable && ' (gespeicherter Schlüssel nicht mehr lesbar, bitte neu eingeben)'}
              {source.signup && (
                <>
                  {' · '}
                  <a href={source.signup} target="_blank" rel="noreferrer">Schlüssel beantragen</a>
                </>
              )}
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={source.keySet ? '••••••••' : (source.placeholder ?? '')}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="row" style={{ margin: 0 }}>
            <button className="primary" type="submit" disabled={!key.trim()}>Speichern</button>
            <button type="button" disabled={!ready || testing} onClick={() => void runTest()}>{testing ? 'Teste …' : 'Verbindung testen'}</button>
            {source.keySet && <button type="button" className="danger" onClick={removeKey}>Schlüssel löschen</button>}
            {saved && <span className="saved">Gespeichert</span>}
          </div>
        </form>
      )}
      {!source.needsKey && (
        <div className="row" style={{ margin: 0 }}>
          <button type="button" disabled={testing} onClick={() => void runTest()}>{testing ? 'Teste …' : 'Verbindung testen'}</button>
        </div>
      )}
      {test && (
        <p>
          <span className={test.ok ? 'badge ok' : 'badge bad'}>{test.ok ? '✓' : '✗'}</span>{' '}
          {test.ok ? `Erreichbar, Testsuche „Schule“: ${test.count.toLocaleString('de-DE')}${test.more ? '+' : ''} Treffer` : test.error}
        </p>
      )}
    </div>
  );
}

function MediaSourceSettings({ onError }: { onError: (e: unknown) => void }) {
  const [sources, setSources] = useState<MediaSourceState[] | null>(null);
  useEffect(() => void api.get<MediaSourceState[]>('/settings/media-sources').then(setSources, onError), []);
  if (!sources) return null;
  return (
    <section className="card card--wide" id="settings-media-sources">
      <header>
        <h2>Bilddatenbanken</h2>
      </header>
      <p className="muted">
        Redakteure suchen unter <strong>Medien → Aus Bilddatenbank</strong> und übernehmen Treffer mit einem Klick in die Mediathek. Urheber,
        Quelle und Lizenz werden mitgespeichert. Verlangt die Lizenz eine Namensnennung (z. B. CC BY), zeigen die Displays einen Bildnachweis.
        Schlüssel werden verschlüsselt gespeichert und nicht wieder angezeigt.
      </p>
      {sources.map((source) => (
        <MediaSourceCard key={source.id} source={source} onSaved={setSources} onError={onError} />
      ))}
    </section>
  );
}

/** Sections of the settings page, in page order, for the sub menu. */
const SECTIONS: Array<{ id: string; label: string; admin: boolean }> = [
  { id: 'settings-untis', label: 'WebUntis-API', admin: true },
  { id: 'settings-media-sources', label: 'Bilddatenbanken', admin: true },
  { id: 'settings-ai', label: 'KI-Zugang', admin: false },
];

/** Sub menu below the main navigation; stays at the top while scrolling and marks the section in view. */
export function SettingsNav({ user }: { user: User }) {
  const sections = SECTIONS.filter((s) => !s.admin || can(user, 'admin'));
  const [active, setActive] = useState(sections[0].id);

  useEffect(() => {
    const update = () => {
      const top = (document.querySelector('.subnav')?.getBoundingClientRect().bottom ?? 0) + 24;
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && (atEnd || el.getBoundingClientRect().top <= top)) current = s.id;
      }
      setActive(current);
    };
    update();
    // The cards load their data after mounting and change the page height.
    const resize = new ResizeObserver(update);
    resize.observe(document.body);
    window.addEventListener('scroll', update, { passive: true });
    return () => {
      resize.disconnect();
      window.removeEventListener('scroll', update);
    };
  }, [user.role]);

  // Editors only see the AI access: nothing to choose from.
  if (sections.length < 2) return null;
  return (
    <nav className="subnav" aria-label="Einstellungen">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className={active === s.id ? 'active' : ''}
          aria-current={active === s.id ? 'location' : undefined}
          onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

export function SettingsPage({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  return (
    <div className="cards">
      {can(user, 'admin') && (
        <>
          <UntisApiSettings onError={onError} />
          <MediaSourceSettings onError={onError} />
        </>
      )}
      <AiAccessSettings user={user} onError={onError} />
    </div>
  );
}
