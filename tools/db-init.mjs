/*
 * tools/db-init.mjs - applies lib/schema.sql.
 *
 *   node tools/db-init.mjs        (npm run db:init)
 *
 * Separate from the API on purpose. Serverless instances cold-start in
 * parallel, and half a dozen of them racing to CREATE TABLE is a good way to
 * deadlock a fresh deploy, so the API reports a missing schema rather than
 * trying to fix one. This is the deliberate, one-at-a-time version of that
 * fix, and it is idempotent: running it against a live database changes
 * nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(repo);

/* Imported after the .env is loaded, because config.mjs reads process.env once
   when it is first evaluated. */
const { DATABASE_URL, hasDatabase } = await import('../lib/config.mjs');
const { close, exec, one } = await import('../lib/db.mjs');

if (!hasDatabase()) {
  console.error('No DATABASE_URL (or POSTGRES_URL) is set.');
  console.error('Copy .env.example to .env and put your connection string in it,');
  console.error('or set the variable in your host\'s project settings.');
  process.exit(1);
}

/* Host and database only. A connection string contains a password, and this
   line ends up pasted into issues and CI logs. */
function describe(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch (error) {
    return 'the configured database';
  }
}

const schema = readFileSync(resolve(repo, 'lib/schema.sql'), 'utf8');

console.log('Applying lib/schema.sql to ' + describe(DATABASE_URL) + ' ...');

try {
  await exec(schema);

  const tables = await one(
    `SELECT count(*)::int AS found
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'sessions', 'enquiries', 'bookings', 'slot_load', 'rate_limits')`
  );

  if (!tables || tables.found !== 6) {
    console.error('Expected six tables afterwards, found ' + ((tables && tables.found) || 0) + '.');
    process.exitCode = 1;
  } else {
    console.log('Done. Six tables present, and the API will stop answering 503.');
  }
} catch (error) {
  console.error('Failed: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
} finally {
  await close();
}
