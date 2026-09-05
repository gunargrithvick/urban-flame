/*
 * test/api.test.mjs - the API as a client sees it: over HTTP, end to end.
 *
 * Nothing here is stubbed. tools/dev-server.mjs serves the same api/*.mjs
 * handlers Vercel will run, on an ephemeral port; PGlite stands in for the
 * deployed Postgres, so the SQL exercised is the SQL that ships. Every
 * assertion is made against a status line, a header or a JSON body rather than
 * against a module's internals, which is what lets these survive a refactor
 * that keeps the wire behaviour.
 *
 * Two facts are read straight out of the database instead, deliberately: that
 * a session token is stored only as a digest and a password only as a scrypt
 * record are precisely the things no endpoint will ever tell you, and ageing a
 * session past its expiry has no API either.
 *
 * The database is shared by the whole file - PGlite has one connection, and
 * node:test runs a file's tests in order - so tests take a date each and an
 * address each rather than trying to clean up after themselves.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

/*
 * These three have to be set before lib/config.mjs is first evaluated, which is
 * where process.env is read and never read again.
 *
 * DATABASE_URL is never dialled: setDriver hands lib/db.mjs PGlite instead. It
 * is set because api/health.mjs asks hasDatabase() on its own account, and
 * without it that endpoint would truthfully report no backend while every other
 * route worked - the one combination the client cannot cope with.
 * UF_INSECURE_COOKIES is pinned to '0' rather than left unset so the Set-Cookie
 * lines carry the Secure flag they will carry in production; the jar in
 * helpers.mjs ignores attributes, so plain-http localhost is unbothered.
 */
process.env.DATABASE_URL = 'postgres://pglite/urban-flame-test';
process.env.ADMIN_EMAILS = 'chef@urbanflame.test';
process.env.UF_INSECURE_COOKIES = '0';

/* Dynamic, and in this order: the dev server's own module body loads .env and
   would otherwise get UF_INSECURE_COOKIES=1 in ahead of the line above. */
const { start } = await import('../tools/dev-server.mjs');
const {
  COVERS_TOTAL, HORIZON_DAYS, SESSION_COOKIE, SESSION_DAYS,
  SLOT_MINUTES, TURN_MINUTES, TZ_LABEL
} = await import('../lib/config.mjs');
const { POLICY } = await import('../lib/ratelimit.mjs');
const { localDateString, localMinutesOf } = await import('../lib/slots.mjs');
const { makeClient, soon, useDatabase } = await import('./helpers.mjs');

let db = null;
let closeDb = null;
let server = null;
let origin = '';

before(async () => {
  const started = await useDatabase();
  db = started.db;
  closeDb = started.close;
  /* Port 0, so a machine already running npm start is not a reason for the
     suite to fail. */
  server = await start({ port: 0, quiet: true });
  origin = server.origin;
});

after(async () => {
  if (server) await server.close();
  if (closeDb) await closeDb();
});

/*
 * A client per test, each with its own address.
 *
 * The rate limiter keys on clientIp, which prefers X-Forwarded-For exactly as
 * it will behind Vercel. Sharing one address across the file would mean the
 * signup test spent the six-an-hour budget the login test needed, and the order
 * of this file would quietly become part of its meaning.
 */
let addresses = 0;
function client(options) {
  addresses += 1;
  return makeClient(origin, Object.assign({ ip: '203.0.113.' + addresses }, options || {}));
}

/* Passes checkPassword: length, both cases, a digit and a symbol. */
const PASSWORD = 'Chettinad#2026';

let accounts = 0;
function address(label) {
  accounts += 1;
  return label + '-' + accounts + '@urbanflame.test';
}

/* A date each, so one test's covers are never another's. Three days out is far
   enough that the slot cannot have passed while the suite runs. */
let days = 2;
function freeDate() {
  days += 1;
  return soon(days);
}

function signUp(api, email, extra) {
  return api.post(
    '/api/auth/signup',
    Object.assign(
      { name: 'Asha Nair', email: email, phone: '+91 98450 00000', password: PASSWORD },
      extra || {}
    )
  );
}

/*
 * A signed-in member of staff.
 *
 * The account is ordinary in every way; ADMIN_EMAILS above is the whole of its
 * privilege, which is the property worth demonstrating. Whichever test gets here
 * first creates it and the rest sign in, and because a correct password clears
 * the per-account bucket, signing in repeatedly never trips the limiter.
 */
async function adminClient() {
  const api = client();
  const created = await signUp(api, 'chef@urbanflame.test', { name: 'Priya Menon' });
  if (created.status === 201) return api;

  assert.equal(created.status, 409);
  const back = await api.post('/api/auth/login', {
    email: 'chef@urbanflame.test',
    password: PASSWORD
  });
  assert.equal(back.status, 200);
  return api;
}

/* The availability payload as a time -> seats lookup, because the assertions
   are about particular times rather than the shape of the list. */
async function seatsByTime(api, date) {
  const res = await api.get('/api/availability?date=' + date);
  assert.equal(res.status, 200);
  const out = {};
  for (const slot of res.body.slots) out[slot.time] = slot.seats;
  return out;
}

function minutesOf(time) {
  const parts = String(time).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

test('health reports a live database, a live schema and the restaurant clock', async () => {
  const res = await client().get('/api/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  /* db and schema are the two the client acts on: false for either and main.js
     keeps using its localStorage implementation. */
  assert.equal(res.body.db, true);
  assert.equal(res.body.schema, true);
  assert.equal(res.body.reason, undefined);
  assert.equal(res.body.timezone, TZ_LABEL);
  assert.ok(Number.isFinite(Date.parse(res.body.time)));
});

test('every API response is uncacheable, typed, and never sniffable', async () => {
  const api = client();

  /* One of each kind: a public read, a public read with a query, a session
     read, and a route that will refuse this caller. All four are personal or
     live counts, and none of them may sit in a shared cache. */
  for (const path of ['/api/health', '/api/availability', '/api/auth/session', '/api/bookings']) {
    const res = await api.get(path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', path);
  }
});

test('a missing endpoint and a wrong method answer in JSON, not in HTML', async () => {
  const api = client();

  const missing = await api.get('/api/nothing-here');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');

  const wrong = await api.del('/api/health');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.error.code, 'method_not_allowed');
  /* Allow is not optional in a 405, and a client that reads it will not retry
     the same way. */
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD');

  /* An encoded traversal in a path segment is refused by the segment pattern
     rather than resolved and then rejected. */
  const sneaky = await api.get('/api/auth/..%2fsession');
  assert.equal(sneaky.status, 404);
  assert.equal(sneaky.body.error.code, 'not_found');
});

test('signup creates an account, returns only public columns, and signs it in', async () => {
  const api = client();
  const email = address('asha');

  const created = await signUp(api, email);
  assert.equal(created.status, 201);

  /* The exact set, sorted: a column added to users must not reach a response
     by accident, and password must never be on this list. */
  assert.deepEqual(Object.keys(created.body.user).sort(), [
    'createdAt',
    'email',
    'id',
    'isAdmin',
    'name',
    'phone'
  ]);
  assert.equal(created.body.user.email, email);
  assert.equal(created.body.user.name, 'Asha Nair');
  assert.equal(created.body.user.isAdmin, false);
  assert.equal(typeof created.body.user.id, 'number');

  const line = created.headers.getSetCookie()[0];
  assert.ok(line.startsWith(SESSION_COOKIE + '='));
  assert.match(line, /(^|; )Path=\/(;|$)/);
  assert.match(line, /(^|; )HttpOnly(;|$)/);
  assert.match(line, /(^|; )SameSite=Lax(;|$)/);
  /* Secure, because UF_INSECURE_COOKIES is '0' at the top of this file: this is
     the line a browser will actually be sent. */
  assert.match(line, /(^|; )Secure(;|$)/);
  assert.ok(line.includes('Max-Age=' + SESSION_DAYS * 24 * 60 * 60));

  const me = await api.get('/api/auth/session');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, email);
});

test('signup refuses a weak password and a malformed address, and creates nothing', async () => {
  const api = client();
  const email = address('weak');

  const refused = await signUp(api, 'not-an-address', { password: 'short' });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'invalid');
  assert.equal(refused.body.error.fields.email, 'Enter a valid email address.');
  assert.equal(refused.body.error.fields.password, 'Use at least 8 characters.');
  /* A refused signup is not a session. */
  assert.equal(refused.headers.getSetCookie().length, 0);

  const simple = await signUp(api, email, { password: 'alllowercase' });
  assert.equal(simple.status, 422);
  assert.equal(
    simple.body.error.fields.password,
    'Use upper- and lower-case letters, one number and one symbol.'
  );

  /* Nothing was written either time, so the address is still free. */
  assert.equal((await signUp(api, email)).status, 201);
});

test('an address can only have one account', async () => {
  const api = client();
  const email = address('twice');

  assert.equal((await signUp(api, email)).status, 201);

  const again = await signUp(api, email, { name: 'Someone Else' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'email_taken');
  /* Signup does confirm an address is taken, unlike login, and the message goes
     beside the email input with the next step in it. */
  assert.match(again.body.error.fields.email, /Sign in instead/);
});

test('case and padding do not make a second account', async () => {
  const api = client();
  const email = address('mixed');

  const created = await signUp(api, '  ' + email.toUpperCase() + '  ');
  assert.equal(created.status, 201);
  assert.equal(created.body.user.email, email);

  const back = client();
  const login = await back.post('/api/auth/login', {
    email: email.toUpperCase(),
    password: PASSWORD
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, email);
});

test('a wrong password and an unknown address are refused identically', async () => {
  const api = client();
  const email = address('known');
  assert.equal((await signUp(api, email)).status, 201);

  const wrongPassword = await api.post('/api/auth/login', {
    email: email,
    password: PASSWORD + 'x'
  });
  const noSuchAccount = await api.post('/api/auth/login', {
    email: address('ghost'),
    password: PASSWORD
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchAccount.status, 401);
  assert.equal(wrongPassword.body.error.code, 'bad_credentials');
  /* Byte-identical bodies, including the absence of a fields map: naming which
     half was wrong is the whole of the enumeration attack. */
  assert.deepEqual(noSuchAccount.body, wrongPassword.body);
  assert.equal(wrongPassword.body.error.fields, undefined);
  assert.equal(wrongPassword.headers.getSetCookie().length, 0);
  assert.equal(noSuchAccount.headers.getSetCookie().length, 0);
});

test('signing out deletes the session, and the old token cannot be replayed', async () => {
  const api = client();
  const email = address('bye');
  assert.equal((await signUp(api, email)).status, 201);

  const token = api.jar.get(SESSION_COOKIE);
  assert.ok(token);

  const out = await api.del('/api/auth/session');
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);

  const cleared = out.headers.getSetCookie()[0];
  assert.match(cleared, /(^|; )Max-Age=0(;|$)/);
  assert.match(cleared, /(^|; )Secure(;|$)/);
  /* The jar dropped it, so this is what the browser would now send. */
  assert.equal(api.jar.has(SESSION_COOKIE), false);
  assert.equal((await api.get('/api/auth/session')).body.user, null);

  /* And the row is gone, not merely forgotten by the client: a token kept from
     before the sign-out buys nothing. */
  const replay = await api.get('/api/auth/session', {
    cookies: false,
    headers: { Cookie: SESSION_COOKIE + '=' + token }
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.user, null);
});

test('a forged or malformed cookie is simply not a session', async () => {
  const api = client();

  const junk = [
    SESSION_COOKIE + '=',
    SESSION_COOKIE + '=not-a-token',
    SESSION_COOKIE + '=' + 'A'.repeat(4096),
    SESSION_COOKIE + '=%E0%A4%A8',
    'other=1; ' + SESSION_COOKIE + '=deadbeef; malformed',
    SESSION_COOKIE + "=' OR 1=1 --"
  ];

  for (const cookie of junk) {
    const res = await api.get('/api/auth/session', {
      cookies: false,
      headers: { Cookie: cookie }
    });
    assert.equal(res.status, 200, cookie.slice(0, 32));
    assert.equal(res.body.user, null, cookie.slice(0, 32));
  }
});

test('a state-changing request has to come from this origin', async () => {
  const routes = [
    ['POST', '/api/auth/signup'],
    ['POST', '/api/auth/login'],
    ['DELETE', '/api/auth/session'],
    ['POST', '/api/bookings'],
    ['POST', '/api/enquiries'],
    ['PATCH', '/api/enquiries']
  ];

  for (const route of routes) {
    const method = route[0];
    const path = route[1];
    const api = client();
    const where = method + ' ' + path;

    /* What a browser sends for a form posted from somebody else's page. */
    const crossSite = await api.raw(method, path, '{}', { site: 'cross-site' });
    assert.equal(crossSite.status, 403, where);
    assert.equal(crossSite.body.error.code, 'cross_origin', where);

    /* same-site is refused too: a subdomain someone else controls is not this
       site, and Lax would happily send the cookie. */
    const sameSite = await api.raw(method, path, '{}', { site: 'same-site' });
    assert.equal(sameSite.status, 403, where);

    /* No Sec-Fetch-Site at all, so the Origin host is the fallback - and a
       foreign one is still refused. */
    const foreign = await api.raw(method, path, '{}', {
      site: false,
      origin: 'https://urban-flame.evil.test'
    });
    assert.equal(foreign.status, 403, where);

    /* Neither header: not a browser, and so not carrying anybody's cookie. */
    const bare = await api.raw(method, path, '{}', { site: false });
    assert.equal(bare.status, 403, where);
  }

  /* The positive control. Same host in Origin and no Sec-Fetch-Site is accepted
     and then refused further down for a reason of its own - which is how we know
     the gate above is the thing being measured. */
  const allowed = await client().post('/api/enquiries', {}, { site: false, origin: origin });
  assert.equal(allowed.status, 422);
  assert.equal(allowed.body.error.code, 'invalid');
});

test('the request body has to be a JSON object, and not a large one', async () => {
  const api = client();

  const garbage = await api.raw('POST', '/api/auth/login', 'not json at all');
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.error.code, 'bad_json');

  /* An array is valid JSON and still not a request. */
  const array = await api.raw('POST', '/api/auth/login', '[1, 2, 3]');
  assert.equal(array.status, 400);
  assert.equal(array.body.error.code, 'bad_json');

  const scalar = await api.raw('POST', '/api/auth/login', '"just a string"');
  assert.equal(scalar.status, 400);

  /* An empty body is not an error: readJson returns {} and the validator
     produces the field messages, which is what a form posted blank deserves. */
  const empty = await api.raw('POST', '/api/auth/signup', '');
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.fields.name, 'Enter your full name.');

  const huge = await api.raw(
    'POST',
    '/api/enquiries',
    JSON.stringify({ message: 'x'.repeat(70 * 1024) })
  );
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'body_too_large');
});

test('signup is capped per address, and says how long to wait', async () => {
  const api = client();

  for (let i = 0; i < POLICY.signupIp.limit; i += 1) {
    assert.equal((await signUp(api, address('flood'))).status, 201, 'attempt ' + (i + 1));
  }

  const over = await signUp(api, address('flood'));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'rate_limited');

  /* Retry-After has to be a real number of seconds inside the window, or a
     client that honours it will either hammer us or give up for an hour. */
  const wait = Number(over.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait), 'Retry-After was ' + over.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= POLICY.signupIp.seconds, 'Retry-After was ' + wait);
});

test('login is capped per account, whatever address the guessing comes from', async () => {
  const email = address('guessed');
  assert.equal((await signUp(client(), email)).status, 201);

  /* A fresh address for every guess, so the per-address budget is untouched and
     the only thing that can stop this is the per-account one. */
  for (let i = 0; i < POLICY.loginEmail.limit; i += 1) {
    const guess = await client().post('/api/auth/login', {
      email: email,
      password: 'Wrong#' + i + 'aA'
    });
    assert.equal(guess.status, 401, 'guess ' + (i + 1));
  }

  const blocked = await client().post('/api/auth/login', { email: email, password: PASSWORD });
  assert.equal(blocked.status, 429);
  /* The right password, refused: the bucket is checked before the digest is,
     which is what stops a slow trickle of guesses from ever landing. */
  assert.equal(blocked.headers.getSetCookie().length, 0);
});

test('a correct password clears the account bucket', async () => {
  const api = client();
  const email = address('honest');
  assert.equal((await signUp(api, email)).status, 201);

  /* One short of the limit, so the next attempt is still allowed. */
  for (let i = 0; i < POLICY.loginEmail.limit - 1; i += 1) {
    const res = await api.post('/api/auth/login', { email: email, password: 'Wrong#' + i + 'aA' });
    assert.equal(res.status, 401, 'guess ' + (i + 1));
  }

  const right = await api.post('/api/auth/login', { email: email, password: PASSWORD });
  assert.equal(right.status, 200);

  /* The count restarted, so a run of typos after a good day of use is not a
     lockout for somebody who does know their password. */
  for (let i = 0; i < POLICY.loginEmail.limit - 1; i += 1) {
    const res = await api.post('/api/auth/login', { email: email, password: 'Wrong#' + i + 'aA' });
    assert.equal(res.status, 401, 'after the clear, guess ' + (i + 1));
  }
});

test('a table is taken, listed, released, and the covers come back', async () => {
  const api = client();
  const email = address('booker');
  assert.equal((await signUp(api, email)).status, 201);

  const date = freeDate();
  const made = await api.post('/api/bookings', {
    name: 'Asha Nair',
    email: email,
    phone: '+91 98450 12345',
    party: 4,
    date: date,
    time: '19:00',
    notes: 'Window table if there is one.'
  });

  assert.equal(made.status, 201);
  const booking = made.body.booking;
  /* No 0/O and no 1/I/L, because this gets read down a phone line. */
  assert.match(booking.reference, /^UF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(booking.date, date);
  assert.equal(booking.time, '19:00');
  assert.equal(booking.party, 4);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.afterMidnight, false);
  assert.equal(booking.turnMinutes, TURN_MINUTES);
  assert.equal(booking.notes, 'Window table if there is one.');

  const mine = await api.get('/api/bookings');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.bookings.map((row) => row.reference), [booking.reference]);

  /*
   * The overlap rule, seen from outside.
   *
   * A 19:00 table for ninety minutes holds 19:00, 19:30 and 20:00, so every
   * arrival slot whose own turn touches one of those is down four covers - 18:00
   * included, because those guests would still be sitting there at 19:00. 17:30
   * finishes at 19:00 exclusive and 20:30 starts after them, so both are clear.
   */
  const seats = await seatsByTime(api, date);
  assert.equal(seats['19:00'], COVERS_TOTAL - 4);
  assert.equal(seats['18:00'], COVERS_TOTAL - 4);
  assert.equal(seats['20:00'], COVERS_TOTAL - 4);
  assert.equal(seats['17:30'], COVERS_TOTAL);
  assert.equal(seats['20:30'], COVERS_TOTAL);

  const cancelled = await api.del('/api/bookings', { reference: booking.reference });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.booking.status, 'cancelled');
  assert.equal(cancelled.body.already, false);

  /* Idempotent: a guest who presses the button twice has not made a mistake
     worth an error page, and the covers must not be credited twice. */
  const again = await api.del('/api/bookings', { reference: booking.reference });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(again.body.booking.status, 'cancelled');

  const after = await seatsByTime(api, date);
  assert.equal(after['19:00'], COVERS_TOTAL);
  assert.equal(after['18:00'], COVERS_TOTAL);

  /* Still listed, as cancelled. A reservation is a record, not a row to
     delete. */
  const history = await api.get('/api/bookings');
  assert.equal(history.body.bookings.length, 1);
  assert.equal(history.body.bookings[0].status, 'cancelled');
});

test('the dining room cannot be oversold, and a refusal leaves nothing behind', async () => {
  const api = client();
  const date = freeDate();
  const made = [];

  /* Twelve is PARTY_MAX, so filling thirty-two covers takes three bookings. */
  for (const party of [12, 12, 8]) {
    const email = address('full');
    const res = await api.post('/api/bookings', {
      name: 'Party of ' + party,
      email: email,
      phone: '+91 98450 22222',
      party: party,
      date: date,
      time: '19:00'
    });
    assert.equal(res.status, 201, 'party of ' + party);
    made.push({ reference: res.body.booking.reference, email: email });
  }

  assert.equal((await seatsByTime(api, date))['19:00'], 0);

  /*
   * One cover more than the room has.
   *
   * Nothing in lib/bookings.mjs counts before inserting: the CHECK constraint on
   * slot_load is what refuses this, and the transaction it kills takes the
   * bookings row out with it. Both halves of that are asserted here.
   */
  const over = await api.post('/api/bookings', {
    name: 'One Too Many',
    email: address('over'),
    phone: '+91 98450 33333',
    party: 1,
    date: date,
    time: '19:00'
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'no_room');
  assert.equal(over.body.error.fields.time, 'No longer available - pick another time.');

  /* No half-written reservation: the pass for that service shows three tables,
     not four. */
  const staff = await adminClient();
  const service = await staff.get('/api/bookings?date=' + date);
  assert.equal(service.status, 200);
  assert.equal(service.body.date, date);
  assert.deepEqual(
    service.body.bookings.map((row) => row.reference).sort(),
    made.map((row) => row.reference).sort()
  );

  /* Giving twelve covers back makes room for exactly twelve again - which is
     also the proof that cancelling released the slots rather than the row. The
     address goes with the reference because the reference alone is not enough
     to cancel anything, as the authorisation test below insists. */
  const released = await api.del('/api/bookings', made[0]);
  assert.equal(released.status, 200);
  assert.equal((await seatsByTime(api, date))['19:00'], 12);

  const refill = await api.post('/api/bookings', {
    name: 'Twelve Again',
    email: address('refill'),
    phone: '+91 98450 44444',
    party: 12,
    date: date,
    time: '19:00'
  });
  assert.equal(refill.status, 201);
  assert.equal((await seatsByTime(api, date))['19:00'], 0);
});

test('a booking is refused field by field when the details are wrong', async () => {
  const api = client();
  const good = {
    name: 'Asha Nair',
    email: address('checks'),
    phone: '+91 98450 55555',
    party: 4,
    date: freeDate(),
    time: '19:00'
  };

  const cases = [
    [{ party: 13 }, 'party'],
    [{ party: 0 }, 'party'],
    [{ party: 2.5 }, 'party'],
    /* Required here, unlike signup: a restaurant with no way to reach a table
       that has not arrived holds it until closing. */
    [{ phone: '' }, 'phone'],
    [{ time: '19:15' }, 'time'],
    /* Long past the last seating on any day of the week. */
    [{ time: '03:00' }, 'time'],
    [{ date: '2026-02-30' }, 'date'],
    [{ date: soon(HORIZON_DAYS + 5) }, 'date'],
    [{ name: 'A' }, 'name'],
    [{ notes: 'x'.repeat(400) }, 'notes']
  ];

  for (const entry of cases) {
    const res = await api.post('/api/bookings', Object.assign({}, good, entry[0]));
    const where = entry[1] + ' ' + JSON.stringify(entry[0]).slice(0, 40);
    assert.equal(res.status, 422, where);
    assert.equal(res.body.error.code, 'invalid', where);
    assert.ok(res.body.error.fields[entry[1]], where);
  }
});

test('a reference is an identifier, not a credential', async () => {
  const guest = client();
  const email = address('walkin');

  /* Booked while signed out, which is the common case: user_id is null on this
     row and always will be. */
  const made = await guest.post('/api/bookings', {
    name: 'Ravi Kumar',
    email: email,
    phone: '+91 98450 66666',
    party: 2,
    date: freeDate(),
    time: '19:00'
  });
  assert.equal(made.status, 201);
  const reference = made.body.booking.reference;
  const query = '?reference=' + reference + '&email=' + encodeURIComponent(email);

  const found = await guest.get('/api/bookings' + query);
  assert.equal(found.status, 200);
  assert.equal(found.body.booking.reference, reference);

  /* Forgiving about how it was written down, because it was written down by
     hand: case and punctuation are normalised away. */
  const sloppy = reference.toLowerCase().replace('-', ' ');
  const still = await guest.get(
    '/api/bookings?reference=' + encodeURIComponent(sloppy) + '&email=' + encodeURIComponent(email)
  );
  assert.equal(still.status, 200);
  assert.equal(still.body.booking.reference, reference);

  /* Right reference, wrong address: indistinguishable from one that never
     existed, so a guessed reference cannot even be confirmed to exist. */
  const wrong = await guest.get(
    '/api/bookings?reference=' + reference + '&email=nobody@urbanflame.test'
  );
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error.code, 'not_found');

  const naked = await guest.get('/api/bookings?reference=' + reference);
  assert.equal(naked.status, 404);

  /* And it cannot be cancelled by somebody holding only the reference. */
  const stranger = client();
  const attempt = await stranger.del('/api/bookings', { reference: reference });
  assert.equal(attempt.status, 404);

  /* Which is not the same answer as asking for your own bookings signed out. */
  const bare = await stranger.get('/api/bookings');
  assert.equal(bare.status, 401);
  assert.equal(bare.body.error.code, 'not_signed_in');
});

test('staff views do not exist as far as anybody else is concerned', async () => {
  const date = freeDate();
  const closed = [
    ['GET', '/api/bookings?date=' + date],
    ['GET', '/api/enquiries'],
    ['PATCH', '/api/enquiries', { id: 1, handled: true }]
  ];

  /* The PATCH carries a body that would be perfectly valid coming from staff,
     so what is being refused is the caller and not the request. */
  function knock(api, route) {
    return route[0] === 'GET' ? api.get(route[1]) : api.patch(route[1], route[2]);
  }

  const guest = client();
  assert.equal((await signUp(guest, address('nosy'))).status, 201);

  for (const route of closed) {
    const res = await knock(guest, route);
    /* 404 rather than 403: the existence of the endpoint is not something a
       curious guest needs confirmed. */
    assert.equal(res.status, 404, route[0] + ' ' + route[1]);
    assert.equal(res.body.error.code, 'not_found', route[0] + ' ' + route[1]);
  }

  /* Signed out gets the same answer, so signing in does not confirm it
     either. */
  const anonymous = client();
  for (const route of closed) {
    const res = await knock(anonymous, route);
    assert.equal(res.status, 404, route[0] + ' ' + route[1]);
  }

  /* And the list in ADMIN_EMAILS is the whole of the difference. There is no
     column to promote, which is the point: a flag in the database is one SQL
     mistake away from being self-assignable. */
  const staff = await adminClient();
  const me = await staff.get('/api/auth/session');
  assert.equal(me.body.user.isAdmin, true);
  assert.equal((await staff.get('/api/bookings?date=' + date)).status, 200);
  assert.equal((await staff.get('/api/enquiries')).status, 200);
});

test('an enquiry is stored, read by staff, and marked handled once', async () => {
  const api = client();
  const email = address('asks');

  const sent = await api.post('/api/enquiries', {
    name: 'Meera Iyer',
    email: email,
    topic: 'Dietary requirement',
    message: 'Is the mushroom curry made without cream?'
  });
  assert.equal(sent.status, 201);
  assert.equal(typeof sent.body.enquiry.id, 'number');
  assert.ok(sent.body.enquiry.id >= 1);
  assert.ok(Number.isFinite(Date.parse(sent.body.enquiry.sentAt)));
  /* The message and the address are not echoed back: the form already has
     them, and a response is a place things leak from. */
  assert.deepEqual(Object.keys(sent.body.enquiry).sort(), ['id', 'sentAt']);

  /* A topic the form does not offer was not sent by the form, so it lands in
     the catch-all rather than being refused - the visitor could not act on a
     rejection anyway. */
  const odd = await api.post('/api/enquiries', {
    name: 'Meera Iyer',
    email: email,
    topic: 'Refund my table immediately',
    message: 'Sent with a topic our own form has never offered.'
  });
  assert.equal(odd.status, 201);

  const staff = await adminClient();
  const open = await staff.get('/api/enquiries?handled=false');
  assert.equal(open.status, 200);

  const mine = open.body.enquiries.filter((row) => row.email === email);
  assert.equal(mine.length, 2);
  for (const row of mine) {
    assert.equal(row.handled, false);
    assert.equal(row.fromAccount, false);
  }
  assert.equal(mine.find((row) => row.id === odd.body.enquiry.id).topic, 'Something else');

  const marked = await staff.patch('/api/enquiries', { id: sent.body.enquiry.id, handled: true });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.enquiry.handled, true);

  const stillOpen = await staff.get('/api/enquiries?handled=false');
  assert.equal(stillOpen.body.enquiries.some((row) => row.id === sent.body.enquiry.id), false);
  const everything = await staff.get('/api/enquiries');
  assert.equal(everything.body.enquiries.some((row) => row.id === sent.body.enquiry.id), true);

  assert.equal((await staff.patch('/api/enquiries', { id: 0 })).status, 422);
  assert.equal((await staff.patch('/api/enquiries', { id: 'nine' })).status, 422);
  const missing = await staff.patch('/api/enquiries', { id: 987654 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('an enquiry from a signed-in guest is linked but not rewritten', async () => {
  const api = client();
  assert.equal((await signUp(api, address('member'))).status, 201);

  const onBehalf = address('parent');
  const sent = await api.post('/api/enquiries', {
    name: 'Lakshmi Nair',
    email: onBehalf,
    topic: 'Large group or private dining',
    message: 'Booking the long table for my mother, whose details these are.'
  });
  assert.equal(sent.status, 201);

  const staff = await adminClient();
  const found = (await staff.get('/api/enquiries')).body.enquiries.find(
    (row) => row.id === sent.body.enquiry.id
  );

  /* The account is on the record, so staff can see it came from a member. The
     name and address are the ones typed: someone writing for a parent or from
     work should not have the form quietly overwrite them. */
  assert.equal(found.fromAccount, true);
  assert.equal(found.email, onBehalf);
  assert.equal(found.name, 'Lakshmi Nair');
});

test('SQL in a field is data, and stays data', async () => {
  const api = client();
  const email = address('bobby');
  const name = "Robert'); DROP TABLE enquiries;--";
  const message = "1' OR '1'='1; <script>alert(1)</script>; select * from users;";

  const sent = await api.post('/api/enquiries', {
    name: name,
    email: email,
    topic: 'Something else',
    message: message
  });
  assert.equal(sent.status, 201);

  /* A reference is normalised down to an alphabet that cannot express a
     statement, so this is a miss rather than a query. */
  const guessed = await api.get(
    '/api/bookings?reference=' + encodeURIComponent("' OR 1=1 --")
  );
  assert.equal(guessed.status, 404);

  /* Not a valid address, and findByEmail is parameterised regardless. */
  const login = await api.post('/api/auth/login', {
    email: "' OR 1=1 --",
    password: PASSWORD
  });
  assert.equal(login.status, 401);
  assert.equal(login.body.error.code, 'bad_credentials');

  const staff = await adminClient();
  const badDate = await staff.get(
    '/api/bookings?date=' + encodeURIComponent("2026-01-01'; DROP TABLE bookings;--")
  );
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.error.code, 'bad_date');

  /* Everything is still standing, and the name came back byte for byte. */
  const health = await api.get('/api/health');
  assert.equal(health.body.db, true);
  assert.equal(health.body.schema, true);

  const found = (await staff.get('/api/enquiries')).body.enquiries.find(
    (row) => row.id === sent.body.enquiry.id
  );
  assert.equal(found.name, name);
  assert.equal(found.message, message);
});

test('what the database holds is not what the browser holds', async () => {
  const api = client();
  const email = address('secrets');
  assert.equal((await signUp(api, email)).status, 201);

  const token = api.jar.get(SESSION_COOKIE);
  assert.ok(token);

  /* Read directly, because no route will ever tell you this - which is exactly
     the property being asserted. */
  const sessions = await db.query('SELECT token_hash FROM sessions');
  assert.ok(sessions.rows.length > 0);
  for (const row of sessions.rows) {
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    /* A stolen backup is a list of digests, not a list of live logins. */
    assert.notEqual(row.token_hash, token);
  }

  const users = await db.query('SELECT password FROM users WHERE email = $1', [email]);
  const stored = users.rows[0].password;
  assert.notEqual(stored, PASSWORD);
  assert.ok(!stored.includes(PASSWORD));
  /* Self-describing: scrypt$N$r$p$salt$hash, so the parameters can be raised
     later without invalidating everybody's password. */
  assert.equal(stored.split('$').length, 6);
  assert.ok(stored.startsWith('scrypt$'));
});

test('a session that has aged out is not a session', async () => {
  const api = client();
  const email = address('stale');
  assert.equal((await signUp(api, email)).status, 201);
  assert.equal((await api.get('/api/auth/session')).body.user.email, email);

  /* There is no endpoint for making time pass, and the expiry is enforced in
     the WHERE clause rather than in JavaScript, so this is the only way to test
     it without waiting a month. */
  await db.query(
    `UPDATE sessions SET expires_at = now() - interval '1 minute'
      WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
    [email]
  );

  assert.equal((await api.get('/api/auth/session')).body.user, null);
  const refused = await api.get('/api/bookings');
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, 'not_signed_in');

  /* Signing in again is all it takes, and the dead row is pruned on the way
     past - which is why there is no scheduled job to forget. */
  const back = await api.post('/api/auth/login', { email: email, password: PASSWORD });
  assert.equal(back.status, 200);
  const left = await db.query(
    'SELECT count(*)::int AS n FROM sessions WHERE expires_at <= now()'
  );
  assert.equal(left.rows[0].n, 0);
});

test('availability describes the service, not just the day', async () => {
  const api = client();
  const date = freeDate();
  const res = await api.get('/api/availability?date=' + date);

  assert.equal(res.status, 200);
  assert.equal(res.body.date, date);
  assert.equal(res.body.timezone, TZ_LABEL);
  assert.equal(res.body.covers, COVERS_TOTAL);
  assert.equal(res.body.slotMinutes, SLOT_MINUTES);
  assert.equal(res.body.turnMinutes, TURN_MINUTES);
  assert.equal(res.body.opens, '11:00');

  /* The page sets the date input's min and max from these rather than working
     the horizon out for itself and drifting from the server's idea of it. */
  assert.equal(res.body.horizon.first, localDateString(new Date()));
  assert.equal(
    res.body.horizon.last,
    localDateString(new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000))
  );

  const times = res.body.slots.map((slot) => slot.time);
  assert.ok(times.length > 0);
  assert.equal(times[0], res.body.opens);
  assert.equal(times[times.length - 1], res.body.lastSeating);
  for (const slot of res.body.slots) assert.equal(slot.seats, COVERS_TOTAL);

  /* Thirty minutes apart and in ascending order all the way through. The wrap
     arithmetic is here because closeMinutes may exceed 1440 and a future set of
     hours could put the last seating past midnight; with the published ones it
     cannot, since the last seating is a full turn before closing. */
  for (let i = 1; i < times.length; i += 1) {
    const step = minutesOf(times[i]) - minutesOf(times[i - 1]);
    const wrapped = ((step % 1440) + 1440) % 1440;
    assert.equal(wrapped, SLOT_MINUTES, times[i - 1] + ' -> ' + times[i]);
  }

  /* afterMidnight is set on exactly the slots whose clock time has wrapped -
     none of them today, and the equivalence still holds if the hours change. */
  for (const slot of res.body.slots) {
    assert.equal(slot.afterMidnight, minutesOf(slot.time) < minutesOf(res.body.opens), slot.time);
  }
});

test('availability refuses a date it cannot serve', async () => {
  const api = client();

  const nonsense = await api.get('/api/availability?date=not-a-date');
  assert.equal(nonsense.status, 400);
  assert.equal(nonsense.body.error.code, 'bad_date');
  assert.equal(nonsense.body.error.fields.date, 'Choose a date.');

  /* A day that does not exist, which Date.parse would happily roll forward
     into March. */
  assert.equal((await api.get('/api/availability?date=2026-02-30')).status, 400);

  const tooFar = await api.get('/api/availability?date=' + soon(HORIZON_DAYS + 5));
  assert.equal(tooFar.status, 422);
  assert.equal(tooFar.body.error.code, 'out_of_range');
  assert.ok(tooFar.body.error.fields.date.includes(String(HORIZON_DAYS)));

  const gone = await api.get('/api/availability?date=2020-01-01');
  assert.equal(gone.status, 422);
  assert.equal(gone.body.error.code, 'out_of_range');

  /* No date at all means today, which is what a page nobody has touched yet
     wants to show. */
  const today = await api.get('/api/availability');
  assert.equal(today.status, 200);
  assert.equal(today.body.date, localDateString(new Date()));
});

test('a slot that has already gone is never offered', async () => {
  const api = client();
  const today = localDateString(new Date());

  const res = await api.get('/api/availability?date=' + today);
  assert.equal(res.status, 200);

  /* Today's list shortens as the evening goes on, and is empty once the last
     seating has passed - which is why this asserts a property rather than a
     count. */
  const now = localMinutesOf(new Date());
  for (const slot of res.body.slots) {
    assert.ok(minutesOf(slot.time) > now, slot.time + ' is not after ' + now);
  }

  const early = await api.post('/api/bookings', {
    name: 'Too Late',
    email: address('late'),
    phone: '+91 98450 77777',
    party: 2,
    date: today,
    time: res.body.opens
  });

  /*
   * Opening time today is either behind the clock or ahead of it, depending on
   * the hour this suite runs, and both answers are correct. Which one it is is
   * deliberately not predicted - the test's own clock and the server's are
   * milliseconds apart, and a suite that fails once a day at 10:59:59 is worse
   * than one that checks both shapes properly.
   */
  assert.ok(early.status === 201 || early.status === 422, 'status ' + early.status);

  if (early.status === 422) {
    assert.equal(early.body.error.code, 'invalid');
    assert.equal(early.body.error.fields.time, 'Choose a later time.');
    return;
  }

  assert.equal(early.body.booking.time, res.body.opens);
  assert.equal(early.body.booking.date, today);
  /* Put the covers back: today is the one date this file cannot allocate
     exclusively. */
  const undo = await api.del('/api/bookings', {
    reference: early.body.booking.reference,
    email: early.body.booking.email
  });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.booking.status, 'cancelled');
});
