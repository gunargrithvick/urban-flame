/*
 * test/helpers.mjs - PGlite as the database, and a small HTTP client.
 *
 * PGlite is real Postgres compiled to WebAssembly, so the SQL these tests run
 * is the SQL that ships: the CHECK constraint that prevents overselling, the
 * ON CONFLICT upserts, make_interval, FOR UPDATE and all. A SQLite stand-in
 * would have quietly accepted several statements that Postgres rejects, which
 * is the opposite of what a test is for.
 *
 * Not a test file itself - the npm script names the two that are, so nothing
 * here is collected by the runner.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Fresh in-memory database, schema applied, injected into lib/db.mjs.
 *
 * One caveat worth being honest about: PGlite has a single connection, so two
 * "concurrent" transactions here are really sequential. That is enough to test
 * the constraint - which is what actually prevents an oversell - but it cannot
 * reproduce two instances racing. The comment in lib/schema.sql explains why
 * the constraint is the guarantee and the lock ordering is only an optimisation.
 */
export async function useDatabase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { close, setDriver } = await import('../lib/db.mjs');

  const db = await PGlite.create();
  await db.exec(readFileSync(resolve(repo, 'lib/schema.sql'), 'utf8'));

  setDriver({
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (run) =>
      db.transaction((tx) => run({ query: (sql, params) => tx.query(sql, params) })),
    end: () => db.close()
  });

  return { db: db, close: close };
}

/*
 * A browser's cookie jar, minus everything this suite does not need.
 *
 * Attributes are deliberately ignored when storing: the tests assert on the
 * raw Set-Cookie string where the flags matter, and a jar that enforced Secure
 * would refuse the plain-http localhost the dev server runs on.
 *
 * defaults.ip is the one option worth explaining. The rate limiter keys on
 * clientIp, which prefers X-Forwarded-For exactly as it will behind Vercel, so
 * giving each test its own address stops one test's six signups an hour from
 * being spent by the test before it. Real requests share an address; these do
 * not, and pretending otherwise would make the order of the file load-bearing.
 */
export function makeClient(origin, defaults) {
  const base = defaults || {};
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => name + '=' + value).join('; ');
  }

  function remember(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const first = line.split(';')[0];
      const eq = first.indexOf('=');
      if (eq < 1) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value === '' || /Max-Age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function request(method, path, body, options) {
    const settings = options || {};
    const headers = {};

    /* fetch refuses a body on these outright, the same as a browser would, so a
       caller that passes one is asking for a request that cannot be sent. */
    const sendable = method !== 'GET' && method !== 'HEAD' ? body : undefined;

    /* Every real fetch from the site carries this, and lib/http.mjs's CSRF
       check looks for it first. Tests that need to forge a cross-site request
       pass origin: false or a foreign Origin instead. */
    if (settings.site !== false) headers['Sec-Fetch-Site'] = settings.site || 'same-origin';
    if (settings.origin) headers.Origin = settings.origin;
    if (sendable !== undefined) headers['Content-Type'] = 'application/json';

    const ip = settings.ip || base.ip;
    if (ip) headers['X-Forwarded-For'] = ip;

    const cookies = cookieHeader();
    if (cookies && settings.cookies !== false) headers.Cookie = cookies;

    /* Last, so a test that has to send a specific header - a forged Cookie,
       say - wins over both the jar and the sugar above. */
    Object.assign(headers, base.headers || {}, settings.headers || {});

    const res = await fetch(origin + path, {
      method: method,
      headers: headers,
      /* settings.raw means the caller has already produced the bytes, which is
         the only way to send something readJson is meant to refuse. */
      body: sendable === undefined ? undefined : settings.raw ? sendable : JSON.stringify(sendable),
      redirect: 'manual'
    });

    remember(res);

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = null;
    }

    return { status: res.status, headers: res.headers, body: json, text: text };
  }

  return {
    jar: jar,
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body || {}, options),
    patch: (path, body, options) => request('PATCH', path, body || {}, options),
    del: (path, body, options) => request('DELETE', path, body || {}, options),
    raw: (method, path, text, options) =>
      request(method, path, text, Object.assign({ raw: true }, options || {}))
  };
}

/* A date far enough ahead to be inside the horizon and never today, so a test
   run at 23:55 does not fail because the slots have gone. */
export function soon(days) {
  const at = new Date(Date.now() + (days || 3) * 24 * 60 * 60 * 1000);
  return at.toISOString().slice(0, 10);
}
