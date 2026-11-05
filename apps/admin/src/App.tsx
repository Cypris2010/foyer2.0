import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, type User } from './api.ts';
import { Displays } from './Displays.tsx';
import { Channels } from './Channels.tsx';
import { Slides } from './Slides.tsx';
import { CalendarPage } from './CalendarPage.tsx';
import { MediaPage } from './Media.tsx';
import { SettingsPage } from './Settings.tsx';

const pages = { displays: 'Displays', calendar: 'Kalender', channels: 'Channels', slides: 'Folien', media: 'Medien', settings: 'Einstellungen' } as const;
// Pages only admins see.
const adminPages = new Set<Page>(['settings']);
type Page = keyof typeof pages;

function currentPage(): Page {
  const hash = location.hash.replace('#', '');
  return hash in pages ? (hash as Page) : 'displays';
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ user: User }>('/auth/login', { email, password });
      onLogin(res.user);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>Foyer</h1>
      <label className="field">
        <span>E-Mail</span>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="field">
        <span>Passwort</span>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit">Anmelden</button>
    </form>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(currentPage());
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ user: User }>('/auth/me').then((r) => setUser(r.user), () => setUser(null));
    const onHash = () => setPage(currentPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const onError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) setUser(null);
    setError((err as Error).message);
  };

  if (user === undefined) return null;
  if (!user) return <Login onLogin={setUser} />;

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
  };

  return (
    <div className="app">
      <nav className="nav">
        <strong>Foyer</strong>
        {(Object.keys(pages) as Page[]).filter((p) => !adminPages.has(p) || can(user, 'admin')).map((p) => (
          <a key={p} href={`#${p}`} className={page === p ? 'active' : ''}>{pages[p]}</a>
        ))}
        <span className="spacer" />
        <span className="muted">{user.name} ({user.role})</span>
        <button onClick={logout}>Abmelden</button>
      </nav>
      {error && (
        <div className="notice error" role="alert">
          {error} <button onClick={() => setError('')}>×</button>
        </div>
      )}
      <main>
        {page === 'displays' && <Displays user={user} onError={onError} />}
        {page === 'calendar' && <CalendarPage user={user} onError={onError} />}
        {page === 'channels' && <Channels user={user} onError={onError} />}
        {page === 'slides' && <Slides user={user} onError={onError} />}
        {page === 'media' && <MediaPage user={user} onError={onError} />}
        {page === 'settings' && can(user, 'admin') && <SettingsPage user={user} onError={onError} />}
      </main>
    </div>
  );
}
