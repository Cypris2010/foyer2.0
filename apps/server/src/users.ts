// User management (admins) and the own account (everyone): accounts with
// roles, password resets, unlocking after too many failed logins.
import type { Hono, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { requireUser, SESSION_COOKIE, type AuthEnv } from './auth.ts';
import { audit } from './db.ts';
import { hashPassword, sha256, verifyPassword } from './crypto.ts';

const MIN_PASSWORD = 12;
const role = z.enum(['admin', 'editor', 'viewer']);
const password = z.string().min(MIN_PASSWORD, `Mindestens ${MIN_PASSWORD} Zeichen`).max(1000);
const email = z.email('Keine gültige E-Mail-Adresse').max(320);
const name = z.string().trim().min(1, 'Bitte einen Namen angeben').max(200);

const createBody = z.object({ email, name, role, password });
const patchBody = z.object({
  email: email.optional(),
  name: name.optional(),
  role: role.optional(),
  password: password.optional(),
  /** Lift the lock after too many failed logins. */
  unlock: z.literal(true).optional(),
});
const passwordBody = z.object({ current: z.string().min(1).max(1000), password });

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: z.infer<typeof role>;
  created_at: number;
  locked_until: number | null;
  last_seen_at: number | null;
  key_count: number;
}

export function registerUserRoutes(admin: Hono<AuthEnv>, ctx: AppContext) {
  const { db } = ctx;
  const adminOnly = requireUser(db, 'admin');
  const sessionOnly: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (c.get('authVia') !== 'session') return c.json({ error: 'Nur mit Anmeldung im Admin' }, 403);
    await next();
  };
  const invalid = (error: z.ZodError) => ({ error: error.issues[0]?.message ?? 'Ungültige Eingabe', issues: error.issues });

  const list = () =>
    (
      db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, u.created_at, u.locked_until,
             (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
             (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count
           FROM users u ORDER BY u.name COLLATE NOCASE, u.email`,
        )
        .all() as unknown as UserRow[]
    ).map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      locked: !!r.locked_until && r.locked_until > ctx.now(),
      apiKeys: r.key_count,
    }));

  admin.get('/users', adminOnly, (c) => c.json(list()));

  admin.post('/users', adminOnly, async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error), 400);
    const userId = crypto.randomUUID();
    try {
      db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        userId, body.data.email, body.data.name, await hashPassword(body.data.password), body.data.role, ctx.now(),
      );
    } catch {
      return c.json({ error: 'E-Mail bereits vergeben' }, 409);
    }
    audit(db, c.get('user').id, 'create', 'user', userId, { email: body.data.email, role: body.data.role });
    return c.json({ id: userId }, 201);
  });

  admin.patch('/users/:id', adminOnly, async (c) => {
    const body = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error), 400);
    const target = c.req.param('id');
    const self = c.get('user');
    const exists = db.prepare('SELECT role FROM users WHERE id = ?').get(target) as { role: string } | undefined;
    if (!exists) return c.json({ error: 'Nicht gefunden' }, 404);
    // Admins cannot lock themselves out; another admin has to change the role.
    if (target === self.id && body.data.role && body.data.role !== exists.role) {
      return c.json({ error: 'Die eigene Rolle kann nur ein anderer Admin ändern' }, 400);
    }
    const { email, name, role, password, unlock } = body.data;
    try {
      if (email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, target);
    } catch {
      return c.json({ error: 'E-Mail bereits vergeben' }, 409);
    }
    if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, target);
    if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target);
    if (password !== undefined || unlock) db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(target);
    if (password !== undefined) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), target);
      // A new password signs the account out everywhere (except this browser).
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(target, sha256(getCookie(c, SESSION_COOKIE) ?? ''));
    }
    audit(db, self.id, 'update', 'user', target, { email, name, role, password: password !== undefined || undefined, unlock });
    return c.json(list().find((u) => u.id === target));
  });

  admin.delete('/users/:id', adminOnly, (c) => {
    if (c.req.param('id') === c.get('user').id) return c.json({ error: 'Eigenes Konto kann nicht gelöscht werden' }, 400);
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Nicht gefunden' }, 404);
    audit(db, c.get('user').id, 'delete', 'user', c.req.param('id'));
    return c.json({ ok: true });
  });

  // Own account: every role may change its password.
  admin.put('/account/password', sessionOnly, async (c) => {
    const body = passwordBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error), 400);
    const user = c.get('user');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!(await verifyPassword(body.data.current, row.password_hash))) return c.json({ error: 'Aktuelles Passwort falsch' }, 400);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.data.password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(user.id, sha256(getCookie(c, SESSION_COOKIE) ?? ''));
    audit(db, user.id, 'password', 'user', user.id);
    return c.json({ ok: true });
  });
}
