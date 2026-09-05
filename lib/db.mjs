/*
 * lib/db.mjs - the only file that talks to Postgres.
 *
 * Two drivers, one database. Production uses node-postgres against whatever
 * DATABASE_URL points at; the test suite injects PGlite, which is real
 * Postgres compiled to WebAssembly, so the SQL under test is the SQL that
 * ships rather than a SQLite-shaped approximation of it.
 *
 * The pool lives at module scope on purpose. A warm serverless instance
 * handles many requests, and reconnecting per request would spend more time on
 * TLS and authentication than on the query.
 */

import { DATABASE_URL, hasDatabase } from './config.mjs';

let driver = null;
let pending = null;

/* Postgres error codes worth naming. Anything that reaches a route as one of
   these has a specific, useful thing to tell the caller. */
const UNDEFINED_TABLE = '42P01';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

export function isMissingSchema(error) {
  return Boolean(error) && error.code === UNDEFINED_TABLE;
}

export function isOverCapacity(error) {
  return (
    Boolean(error) &&
    error.code === CHECK_VIOLATION &&
    String(error.constraint || '').includes('slot_load_within_capacity')
  );
}

export function isDuplicate(error, constraint) {
  if (!error || error.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return String(error.constraint || '').includes(constraint);
}

/* Tests call this before anything else; production never does. */
export function setDriver(next) {
  driver = next;
  pending = null;
}

async function pgDriver() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    /* One connection per instance. Serverless scales by adding instances, not
       by adding connections inside one, and a pool of ten per instance is how
       a Postgres runs out of slots at the worst possible moment. Pair this
       with the host's pooled connection string. */
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    /* Hosted Postgres is TLS-only and presents a certificate for its own
       hostname, which is exactly what the default verification checks. */
    ssl: /\bsslmode=disable\b/.test(DATABASE_URL) ? false : { rejectUnauthorized: true }
  });

  /* An idle client that errors would otherwise take the process down. */
  pool.on('error', () => {});

  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    transaction: async (run) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          /* The connection is already unusable; the original error is the
             one worth propagating. */
        }
        throw error;
      } finally {
        client.release();
      }
    },
    end: () => pool.end()
  };
}

async function get() {
  if (driver) return driver;
  if (!hasDatabase()) {
    const error = new Error('No DATABASE_URL is configured.');
    error.code = 'UF_NO_DATABASE';
    throw error;
  }
  if (!pending) {
    pending = pgDriver().then((made) => {
      driver = made;
      return made;
    });
  }
  return pending;
}

export async function query(sql, params) {
  const active = await get();
  return active.query(sql, params);
}

export async function rows(sql, params) {
  const result = await query(sql, params);
  return result.rows;
}

export async function one(sql, params) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

export async function transaction(run) {
  const active = await get();
  return active.transaction(run);
}

export async function exec(sql) {
  const active = await get();
  return active.exec(sql);
}

export async function close() {
  const active = driver;
  driver = null;
  pending = null;
  if (active && typeof active.end === 'function') await active.end();
}
