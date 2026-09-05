/*
 * lib/users.mjs - accounts, and the one shape of a user the API ever returns.
 *
 * publicUser exists so that no route has to remember which columns are safe to
 * send. The password column is never on that list, and the only way to get it
 * out of here is to ask for the raw row by name.
 */

import { isAdminEmail } from './config.mjs';
import { one, query } from './db.mjs';

export function publicUser(row) {
  if (!row) return null;
  return {
    /* Number, not the driver's own idea of a bigint: node-postgres hands back
       int8 as a string and PGlite as a BigInt, and JSON.stringify refuses the
       second one outright. Nothing here is going past 2^53 rows. */
    id: Number(row.id),
    email: row.email,
    name: row.name,
    phone: row.phone || '',
    createdAt: row.created_at,
    /* Recomputed from the environment on every read rather than stored, so
       removing an address from ADMIN_EMAILS takes effect on the next request
       instead of whenever a stale row happens to be refreshed. */
    isAdmin: isAdminEmail(row.email)
  };
}

/* Callers pass an already-normalised address. The CHECK constraint on the
   table is there for the day one of them forgets. */
export async function findByEmail(email) {
  return one('SELECT * FROM users WHERE email = $1', [email]);
}

export async function createUser(input) {
  return one(
    `INSERT INTO users (email, name, phone, password)
          VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, phone, created_at`,
    [input.email, input.name, input.phone || '', input.password]
  );
}

/* Used when a login succeeds against a digest weaker than the current
   parameters: the plaintext is in hand exactly once, so that is the moment to
   re-hash it. */
export async function setPassword(id, encoded) {
  await query('UPDATE users SET password = $2 WHERE id = $1', [id, encoded]);
}
