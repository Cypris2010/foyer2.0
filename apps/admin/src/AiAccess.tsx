// AI access: personal API keys and how to connect an AI assistant (Claude)
// to the MCP endpoint (/mcp). Every user manages their own keys; the
// assistant then has exactly the rights of that account.
import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from './api.ts';

interface ApiKey {
  id: string;
  name: string;
  /** End of the key ("…1a2b"); the key itself is shown once. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'nie');

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="snippet">
      <div className="row row--snippet">
        <strong>{label}</strong>
        <button type="button" onClick={() => void copy()}>{copied ? 'Kopiert' : 'Kopieren'}</button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function AiAccessPage({ user, onError }: { user: User; onError: (e: unknown) => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('Claude');
  const [fresh, setFresh] = useState<string | null>(null);

  const load = () => api.get<ApiKey[]>('/api-keys').then(setKeys, onError);
  useEffect(() => void load(), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await api.post<{ key: string }>('/api-keys', { name: name.trim() });
      setFresh(res.key);
      void load();
    } catch (err) {
      onError(err);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (!confirm(`Schlüssel „${key.name}“ (${key.hint}) widerrufen? Programme, die ihn nutzen, haben dann keinen Zugriff mehr.`)) return;
    try {
      await api.del(`/api-keys/${key.id}`);
      void load();
    } catch (err) {
      onError(err);
    }
  };

  const endpoint = `${location.origin}/mcp`;
  const key = fresh ?? '<SCHLÜSSEL>';
  // mcp-remote bridges Claude Desktop's local servers to a remote HTTP endpoint;
  // the header goes through env because some clients split arguments at spaces.
  const desktop = JSON.stringify(
    {
      mcpServers: {
        foyer: {
          command: 'npx',
          args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${FOYER_AUTH}', ...(location.protocol === 'http:' ? ['--allow-http'] : [])],
          env: { FOYER_AUTH: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="cards">
      <section className="card card--wide">
        <header>
          <h2>KI-Zugang (MCP)</h2>
        </header>
        <p className="muted">
          Mit einem persönlichen Schlüssel kann ein KI-Assistent wie Claude Folien anlegen, die Mediathek und die Bilddatenbanken durchsuchen
          und Folien einplanen. Er arbeitet dabei mit den Rechten deines Kontos ({user.role}); HTML-Folien also nur, wenn du Admin bist. Alle
          Änderungen stehen wie sonst im Audit-Log. Behandle den Schlüssel wie ein Passwort.
        </p>
        <form className="row" onSubmit={create}>
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Name, z. B. Claude auf meinem Laptop" aria-label="Name des Schlüssels" />
          <button className="primary" type="submit" disabled={!name.trim()}>Neuen Schlüssel erzeugen</button>
        </form>
        {fresh && (
          <div className="notice">
            <strong>Neuer Schlüssel, wird nur jetzt angezeigt:</strong>
            <code className="secret">{fresh}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(fresh)}>Kopieren</button>
            <button type="button" onClick={() => setFresh(null)}>Ausblenden</button>
          </div>
        )}
        {keys && keys.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Schlüssel</th><th>Erzeugt</th><th>Zuletzt benutzt</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code>{k.hint}</code></td>
                  <td>{date(k.createdAt)}</td>
                  <td>{date(k.lastUsedAt)}</td>
                  <td className="actions"><button className="danger" onClick={() => void revoke(k)}>Widerrufen</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card--wide">
        <header>
          <h2>Verbinden</h2>
        </header>
        <p className="muted">
          Adresse: <code>{endpoint}</code>. {fresh ? 'Der neue Schlüssel ist unten schon eingesetzt.' : 'Für <SCHLÜSSEL> einen neuen Schlüssel erzeugen, dann steht er hier schon drin.'}
        </p>
        <Snippet label="Claude Code (Terminal)" text={`claude mcp add --transport http foyer ${endpoint} --header "Authorization: Bearer ${key}"`} />
        <Snippet label="Claude Desktop (Einstellungen → Entwickler → Konfiguration bearbeiten, claude_desktop_config.json; braucht Node.js)" text={desktop} />
        <p className="muted">
          Danach z. B.: „Mach eine Folie zum Sommerfest am Freitag um 15 Uhr mit einem passenden Foto und zeig sie bis dahin jeden Tag im Channel
          Foyer.“ Die Antwort enthält einen Vorschau-Link.
        </p>
      </section>
    </div>
  );
}
