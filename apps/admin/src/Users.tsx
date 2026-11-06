// User management (admins only) and the own account (everyone): create
// accounts, change roles, reset passwords, unlock after failed logins.
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Role, type User } from './api.ts';

interface ManagedUser extends User {
  createdAt: number;
  /** Last activity of any login session; null if never or all expired. */
  lastSeenAt: number | null;
  /** Locked for a while after too many wrong passwords. */
  locked: boolean;
  apiKeys: number;
}

const MIN_PASSWORD = 12;

const ROLES: Array<{ value: Role; label: string; hint: string }> = [
  { value: 'viewer', label: 'Ansicht', hint: 'sieht alles, ändert nichts' },
  { value: 'editor', label: 'Redaktion', hint: 'Folien, Channels, Kalender und Medien' },
  { value: 'admin', label: 'Admin', hint: 'zusätzlich Displays, HTML-Folien, Einstellungen und Benutzer' },
];
export const roleLabel = (role: Role) => ROLES.find((r) => r.value === role)?.label ?? role;

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

/** Random password without look-alike characters, to pass on to the user. */
function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function PasswordField({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row" style={{ margin: 0, flexWrap: 'nowrap' }}>
        <input
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          minLength={value || required ? MIN_PASSWORD : undefined}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="button" onClick={() => setVisible(!visible)}>{visible ? 'Verbergen' : 'Zeigen'}</button>
        <button
          type="button"
          onClick={() => {
            onChange(generatePassword());
            setVisible(true);
          }}
        >
          Erzeugen
        </button>
      </div>
    </label>
  );
}

function UserDialog({ user, self, onClose, onSaved, onError }: {
  /** null: new user. */
  user: ManagedUser | null;
  self: User;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'editor');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isSelf = user?.id === self.id;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (user) {
        await api.patch(`/users/${user.id}`, {
          ...(name.trim() !== user.name ? { name: name.trim() } : {}),
          ...(email.trim() !== user.email ? { email: email.trim() } : {}),
          ...(role !== user.role ? { role } : {}),
          ...(password ? { password } : {}),
        });
      } else {
        await api.post('/users', { name: name.trim(), email: email.trim(), role, password });
      }
      onSaved();
    } catch (err) {
      // Validation problems belong next to the form, everything else is a toast.
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) setError((err as Error).message);
      else onError(err);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    try {
      await api.patch(`/users/${user!.id}`, { unlock: true });
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={user ? `${user.name} bearbeiten` : 'Neuer Benutzer'} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal__box" onSubmit={submit}>
        <header className="modal__head">
          <h2>{user ? `${user.name} bearbeiten` : 'Neuer Benutzer'}</h2>
          <button type="button" onClick={onClose} aria-label="Schließen">✕</button>
        </header>
        {user?.locked && (
          <div className="notice">
            Nach zu vielen falschen Passwörtern vorübergehend gesperrt.
            <button type="button" onClick={() => void unlock()}>Entsperren</button>
          </div>
        )}
        <div className="row row--fields">
          <label className="field">
            <span>Name</span>
            <input value={name} maxLength={200} required autoFocus={!user} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>E-Mail (Anmeldename)</span>
            <input type="email" value={email} maxLength={320} required autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        <fieldset className="fieldset">
          <legend>Rolle{isSelf && ' (die eigene Rolle kann nur ein anderer Admin ändern)'}</legend>
          {ROLES.map((r) => (
            <label key={r.value} className="field--check">
              <input type="radio" name="role" value={r.value} checked={role === r.value} disabled={isSelf} onChange={() => setRole(r.value)} />
              <span><strong>{r.label}</strong> <span className="muted">· {r.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <PasswordField
          label={user ? `Neues Passwort (leer lassen, um es zu behalten; mind. ${MIN_PASSWORD} Zeichen)` : `Passwort (mind. ${MIN_PASSWORD} Zeichen)`}
          value={password}
          onChange={setPassword}
          required={!user}
        />
        {password && (
          <p className="muted modal__hint">
            Das Passwort bitte selbst weitergeben, Foyer verschickt keine E-Mails.
            {user && !isSelf && ' Der Benutzer wird dabei überall abgemeldet.'}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row row--end">
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button className="primary" type="submit" disabled={busy}>{user ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>
    </div>
  );
}

export function UserSettings({ user: self, onError }: { user: User; onError: (e: unknown) => void }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  // undefined: no dialog; null: new user.
  const [editing, setEditing] = useState<ManagedUser | null | undefined>(undefined);

  const load = () => api.get<ManagedUser[]>('/users').then(setUsers, onError);
  useEffect(() => void load(), []);

  const remove = async (u: ManagedUser) => {
    const keys = u.apiKeys ? ` Seine ${u.apiKeys} API-Schlüssel werden mit gelöscht.` : '';
    if (!confirm(`Konto „${u.name}“ (${u.email}) löschen? Die Person kann sich dann nicht mehr anmelden.${keys}`)) return;
    try {
      await api.del(`/users/${u.id}`);
      void load();
    } catch (err) {
      onError(err);
    }
  };

  if (!users) return null;
  return (
    <section className="card card--wide" id="settings-users">
      <header>
        <h2>Benutzer</h2>
        <button className="primary" onClick={() => setEditing(null)}>Neuer Benutzer</button>
      </header>
      <p className="muted">
        Wer sich im Admin anmelden darf und mit welcher Rolle. {ROLES.map((r) => `${r.label}: ${r.hint}`).join('. ')}.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Zuletzt aktiv</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.name}
                  {u.id === self.id && <span className="badge off" style={{ marginLeft: '0.4rem' }}>du</span>}
                  {u.locked && <span className="badge bad" style={{ marginLeft: '0.4rem' }} title="Zu viele falsche Passwörter">gesperrt</span>}
                </td>
                <td>{u.email}</td>
                <td>{roleLabel(u.role)}</td>
                <td>{date(u.lastSeenAt)}</td>
                <td className="actions">
                  <button onClick={() => setEditing(u)}>Bearbeiten</button>{' '}
                  {u.id !== self.id && <button className="danger" onClick={() => void remove(u)}>Löschen</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing !== undefined && (
        <UserDialog
          user={editing}
          self={self}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

/** Own account: change the password (every role). */
export function AccountSettings({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== repeat) return setError('Die beiden neuen Passwörter stimmen nicht überein');
    try {
      await api.put('/account/password', { current, password });
      setCurrent('');
      setPassword('');
      setRepeat('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setError((err as Error).message);
      else onError(err);
    }
  };

  return (
    <section className="card card--wide" id="settings-account">
      <header>
        <h2>Mein Konto</h2>
      </header>
      <p className="muted">
        Angemeldet als <strong>{user.name}</strong> ({user.email}), Rolle {roleLabel(user.role)}. Nach einer Passwortänderung bleibst du hier
        angemeldet, andere Geräte werden abgemeldet.
      </p>
      <form className="form" onSubmit={submit}>
        {/* Lets password managers attach the new password to the right account. */}
        <input type="email" autoComplete="username" value={user.email} readOnly hidden />
        <div className="row row--fields">
          <label className="field">
            <span>Aktuelles Passwort</span>
            <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="field">
            <span>Neues Passwort (mind. {MIN_PASSWORD} Zeichen)</span>
            <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>Neues Passwort wiederholen</span>
            <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ margin: 0 }}>
          <button className="primary" type="submit">Passwort ändern</button>
          {saved && <span className="saved">Passwort geändert</span>}
        </div>
      </form>
    </section>
  );
}
