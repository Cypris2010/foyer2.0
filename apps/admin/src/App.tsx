import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, can, type User } from './api.ts';
import { Displays } from './Displays.tsx';
import { Channels } from './Channels.tsx';
import { Slides } from './Slides.tsx';
import { CalendarPage } from './CalendarPage.tsx';
import { MediaPage } from './Media.tsx';
import { SettingsNav, SettingsPage } from './Settings.tsx';

const pages = { displays: 'Displays', calendar: 'Kalender', channels: 'Channels', slides: 'Folien', media: 'Medien', settings: 'Einstellungen' } as const;
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

  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.get<{ user: User }>('/auth/me').then((r) => setUser(r.user), () => setUser(null));
    const onHash = () => {
      setPage(currentPage());
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // The header stays at the top; jumps to sections below it need its height.
  const topbar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topbar.current;
    if (!el) return;
    const resize = new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-height', `${el.offsetHeight}px`));
    resize.observe(el);
    return () => resize.disconnect();
  }, [user]);

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
      <header className="topbar" ref={topbar}>
        <nav className="nav">
          <strong>Foyer</strong>
          {/* Phones: the page name and a button that folds the menu out. */}
          <button
            type="button"
            className="nav__toggle"
            aria-expanded={menuOpen}
            aria-controls="nav-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {pages[page]}
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              {menuOpen ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
            </svg>
          </button>
          <div className={menuOpen ? 'nav__menu nav__menu--open' : 'nav__menu'} id="nav-menu">
            {(Object.keys(pages) as Page[]).map((p) => (
              <a key={p} href={`#${p}`} className={page === p ? 'active' : ''} aria-current={page === p ? 'page' : undefined}>{pages[p]}</a>
            ))}
            <span className="spacer" />
            <span className="muted">{user.name} ({user.role})</span>
            <button onClick={logout}>Abmelden</button>
          </div>
        </nav>
        {page === 'settings' && <SettingsNav user={user} />}
      </header>
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
        {page === 'settings' && <SettingsPage user={user} onError={onError} />}
      </main>
    </div>
  );
}
