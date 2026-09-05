/*
 * lib/sessions.mjs - opaque server-side sessions.
 *
 * The cookie carries 32 random bytes and nothing else. The database stores
 * only their SHA-256, so a leaked backup cannot be replayed as a set of live
 * logins, and revoking one session is a DELETE rather than a signing-key
 * rotation that signs everybody out at once.
 *
 * No JWT here on purpose: there is no second service that needs to verify a
 * token without asking us, and that is the only thing a JWT would buy. What it
 * would cost is the ability to log somebody out.
 */

import { createHash, randomBytes } from 'node:crypto';
import { SESSION_COOKIE, SESSION_DAYS } from './config.mjs';
import { one, query } from './db.mjs';
import { clearSessionCookie, fail, readCookies, setSessionCookie } from './http.mjs';
import { publicUser } from './users.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

function digest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export async function startSession(res, userId) {
  /* base64url, so nothing in the token needs escaping in a Set-Cookie. */
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * DAY_MS);

  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [digest(token), userId, expires]
  );

  setSessionCookie(res, token, SESSION_MAX_AGE_SECONDS);
  return token;
}

/*
 * Resolves the cookie to a user, or null.
 *
 * The expiry is enforced in the WHERE clause rather than in JavaScript: a row
 * that has aged out is not a session, and comparing timestamps in the database
 * means the answer does not depend on the function's clock agreeing with it.
 */
export async function readSession(req) {
  const token = readCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const row = await one(
    `SELECT u.id, u.email, u.name, u.phone, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [digest(token)]
  );
  return publicUser(row);
}

export async function endSession(req, res) {
  const token = readCookies(req)[SESSION_COOKIE];
  /* Clear the cookie whatever happens. A stale cookie whose row is already
     gone should still leave the browser, or the visitor stays "signed in" to
     nothing until it expires on its own. */
  clearSessionCookie(res);
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [digest(token)]);
}

/* Called on login, where one extra cheap statement is unnoticeable and the
   alternative is a table that only ever grows. */
export async function pruneExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at <= now()');
}

export async function requireUser(req, res) {
  const user = await readSession(req);
  if (user) return user;
  fail(res, 401, 'not_signed_in', 'Sign in to do that.');
  return null;
}

/*
 * Staff gate.
 *
 * Deliberately answers 404 rather than 403 to a signed-in non-admin: the
 * existence of the endpoint is not something a curious guest needs confirmed,
 * and there is nothing they can do with the knowledge except try harder.
 */
export async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (user && user.isAdmin) return user;
  fail(res, 404, 'not_found', 'Not found.');
  return null;
}
