// Admin authentication: password login, server-side sessions, roles, CSRF and
// login throttling (KONZEPT 3.2).
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Role } from '@foyer/slide-sdk';
import type { Db } from './db.ts';
import { randomToken, sha256, verifyPassword } from './crypto.ts';
import { config } from './config.ts';

export const SESSION_COOKIE = 'foyer_session';
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type AuthEnv = { Variables: { user: SessionUser; clientIp: string } };

export function hasRole(user: SessionUser, role: Role): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[role];
}

// --- Login throttling per client IP (in memory, sliding window) --------------

const attemptsByIp = new Map<string, number[]>();
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_ATTEMPTS = 20;

export function loginThrottled(ip: string, now = Date.now()): boolean {
  const recent = (attemptsByIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  attemptsByIp.set(ip, recent);
  return recent.length >= IP_MAX_ATTEMPTS;
}

function recordAttempt(ip: string, now = Date.now()) {
  const recent = attemptsByIp.get(ip) ?? [];
  recent.push(now);
  attemptsByIp.set(ip, recent);
}

export function resetLoginThrottle() {
  attemptsByIp.clear();
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  failed_logins: number;
  locked_until: number | null;
}

export type LoginResult = { ok: true; user: SessionUser; sessionId: string } | { ok: false; reason: 'invalid' | 'locked' | 'throttled' };

export async function login(db: Db, email: string, password: string, ip: string): Promise<LoginResult> {
  if (loginThrottled(ip)) return { ok: false, reason: 'throttled' };
  recordAttempt(ip);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  const now = Date.now();
  if (row?.locked_until && row.locked_until > now) return { ok: false, reason: 'locked' };
  // Verify against a dummy hash for unknown users so timing does not reveal accounts.
  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !valid) {
    if (row) {
      const failed = row.failed_logins + 1;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(
        failed >= MAX_FAILED_LOGINS ? 0 : failed,
        failed >= MAX_FAILED_LOGINS ? now + LOCK_MS : null,
        row.id,
      );
    }
    return { ok: false, reason: 'invalid' };
  }
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(row.id);
  const sessionId = randomToken();
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(sha256(sessionId), row.id, now, now);
  return { ok: true, sessionId, user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

// Precomputed scrypt hash of a random string, used only to equalise timing.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

export function sessionUser(db: Db, sessionId: string | undefined, now = Date.now()): SessionUser | null {
  if (!sessionId) return null;
  const idHash = sha256(sessionId);
  const row = db
    .prepare(
      `SELECT s.created_at, s.last_seen_at, u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as (SessionUser & { created_at: number; last_seen_at: number }) | undefined;
  if (!row) return null;
  const idle = now - row.last_seen_at > config.sessionIdleHours * 3600_000;
  const expired = now - row.created_at > config.sessionMaxDays * 86400_000;
  if (idle || expired) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  // Throttle writes: refresh last_seen at most once a minute.
  if (now - row.last_seen_at > 60_000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function setSessionCookie(c: Context, sessionId: string) {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Strict',
    path: '/',
    maxAge: config.sessionMaxDays * 86400,
  });
}

export function logout(c: Context, db: Db) {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sessionId));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function requireUser(db: Db, role: Role = 'viewer'): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: 'Nicht angemeldet' }, 401);
    if (!hasRole(user, role)) return c.json({ error: 'Keine Berechtigung' }, 403);
    c.set('user', user);
    await next();
  };
}

/**
 * Rejects cross-site state-changing requests. Browsers send Sec-Fetch-Site;
 * Origin is the fallback check.
 */
export function csrfProtection(): MiddlewareHandler {
  return async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'Cross-Site-Anfrage abgelehnt' }, 403);
    const origin = c.req.header('origin');
    if (!site && origin) {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      if (new URL(origin).host !== host) return c.json({ error: 'Cross-Site-Anfrage abgelehnt' }, 403);
    }
    await next();
  };
}
