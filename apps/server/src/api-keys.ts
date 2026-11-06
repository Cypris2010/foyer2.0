// Personal API keys: programs (e.g. an AI assistant over MCP, mcp.ts) act with
// the rights of the user who created the key. Sent as "Authorization: Bearer";
// only the hash is stored and the key is shown once.
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { AuthEnv, SessionUser } from './auth.ts';
import type { Db } from './db.ts';
import { audit } from './db.ts';
import { randomToken, sha256 } from './crypto.ts';

export const API_KEY_PREFIX = 'foyer_';
const MAX_KEYS_PER_USER = 20;

const createBody = z.object({ name: z.string().trim().min(1).max(100) });

export function createApiKey(db: Db, userId: string, name: string, now = Date.now()): { id: string; key: string } {
  const key = API_KEY_PREFIX + randomToken();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, userId, name, sha256(key), key.slice(-4), now,
  );
  return { id, key };
}

/** The user behind an "Authorization: Bearer <key>" header, or null. */
export function apiKeyUser(db: Db, header: string | undefined, now = Date.now()): SessionUser | null {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key?.startsWith(API_KEY_PREFIX)) return null;
  const row = db
    .prepare('SELECT k.id AS key_id, k.last_used_at, u.id, u.email, u.name, u.role FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?')
    .get(sha256(key)) as (SessionUser & { key_id: string; last_used_at: number | null }) | undefined;
  if (!row) return null;
  // Throttle writes like sessions: at most once a minute.
  if (!row.last_used_at || now - row.last_used_at > 60_000) db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.key_id);
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/**
 * Each user manages their own keys. Only with a login session: a key cannot
 * create or list further keys.
 */
export function registerApiKeyRoutes(admin: Hono<AuthEnv>, ctx: AppContext) {
  const { db } = ctx;
  const sessionOnly: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.get('authVia') !== 'session') return c.json({ error: 'Nur mit Anmeldung im Admin' }, 403);
    await next();
  };

  admin.get('/api-keys', sessionOnly, (c) => {
    const rows = db
      .prepare('SELECT id, name, hint, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .all(c.get('user').id) as Array<{ id: string; name: string; hint: string; created_at: number; last_used_at: number | null }>;
    return c.json(rows.map((r) => ({ id: r.id, name: r.name, hint: `…${r.hint}`, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
  });

  admin.post('/api-keys', sessionOnly, async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Bitte einen Namen angeben', issues: body.error.issues }, 400);
    const user = c.get('user');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(user.id) as { n: number }).n;
    if (count >= MAX_KEYS_PER_USER) return c.json({ error: `Höchstens ${MAX_KEYS_PER_USER} Schlüssel pro Konto` }, 409);
    const { id, key } = createApiKey(db, user.id, body.data.name, ctx.now());
    audit(db, user.id, 'create', 'api-key', id, { name: body.data.name });
    return c.json({ id, key }, 201);
  });

  admin.delete('/api-keys/:id', sessionOnly, (c) => {
    const result = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(c.req.param('id'), c.get('user').id);
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'api-key', c.req.param('id'));
    return c.json({ ok: true });
  });
}
