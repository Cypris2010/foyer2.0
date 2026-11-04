// Central settings (admins only): connections to outside services.
import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from './api.ts';

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
    <section className="card">
      <header>
        <h2>WebUntis-API</h2>
        <span className={state.keySet && state.url ? 'badge ok' : 'badge off'}>{state.keySet && state.url ? 'eingerichtet' : 'nicht eingerichtet'}</span>
      </header>
      <p className="muted">
        Datenquelle für die Raumanzeige und das Lehrkräfte-Dashboard (WebUntis-Datendienst). Folien ohne eigene TXT-Adresse nutzen diese
        Verbindung. Der Schlüssel wird verschlüsselt gespeichert und nicht wieder angezeigt.
      </p>
      <form className="form" onSubmit={(e) => void save(e)}>
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

export function SettingsPage({ onError }: { user: User; onError: (e: unknown) => void }) {
  return (
    <div className="cards">
      <UntisApiSettings onError={onError} />
    </div>
  );
}
