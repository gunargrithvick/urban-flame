/*
 * test/unit.test.mjs - the pure functions, and the contracts between files
 * that nothing else would notice breaking.
 *
 *   node --test test/unit.test.mjs
 *
 * No database and no server: everything here is arithmetic, parsing or string
 * handling. The interesting cases are at the bottom, where a constant in one
 * file has to agree with a number in another - the capacity ceiling in SQL, and
 * the email pattern the browser validates with.
 */

import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeReference, normalizeReference } from '../lib/bookings.mjs';
import {
  ADMIN_EMAILS,
  COVERS_TOTAL,
  HORIZON_DAYS,
  INSECURE_COOKIES,
  PARTY_MAX,
  PARTY_MIN,
  SERVICE_CLOSE_MINUTES,
  SERVICE_OPEN_MINUTES,
  SESSION_COOKIE,
  SLOT_MINUTES,
  TURN_MINUTES,
  TZ_OFFSET,
  isAdminEmail
} from '../lib/config.mjs';
import {
  clearSessionCookie,
  clientIp,
  readCookies,
  sameOrigin,
  searchParams,
  setSessionCookie
} from '../lib/http.mjs';
import { burnPassword, hashPassword, verifyPassword } from '../lib/passwords.mjs';
import {
  SLOTS_PER_TURN,
  closeMinutes,
  formatTime,
  instantAt,
  isAfterMidnight,
  isSeatable,
  lastSeatingMinutes,
  localDateString,
  localTimeString,
  occupiedFrom,
  occupiedInstants,
  parseDate,
  parseTime,
  serviceDateOf,
  slotMinutesFor,
  weekdayOf,
  withinHorizon
} from '../lib/slots.mjs';
import {
  EMAIL_RE,
  LIMITS,
  TOPICS,
  checkEmail,
  checkMessage,
  checkName,
  checkParty,
  checkPassword,
  checkPhone,
  checkTopic,
  collect
} from '../lib/validate.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (name) => readFileSync(resolve(repo, name), 'utf8');

/* Runs one checker against a throwaway error bag and returns the sentence it
   set, or '' if it accepted the value. Every checker here touches one field. */
function firstError(run) {
  const errors = collect();
  run(errors);
  const keys = Object.keys(errors.fields);
  return keys.length ? errors.fields[keys[0]] : '';
}

/* A record in the stored format but made with weaker parameters than PARAMS -
   the digest an account created before the cost was raised would have. Built
   with scryptSync rather than hashPassword precisely because hashPassword can
   no longer produce one. */
function weakerRecord(password, N) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
}

/* Just enough of a ServerResponse for the cookie helpers, which only ever call
   getHeader and setHeader. */
function fakeResponse() {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), value),
    cookies: () => {
      const raw = headers.get('set-cookie');
      if (!raw) return [];
      return Array.isArray(raw) ? raw : [raw];
    }
  };
}

function fakeRequest(headers, url) {
  return { headers: headers || {}, url: url || '/', socket: { remoteAddress: '10.0.0.1' } };
}

/* ------------------------------------------------------------ passwords */

test('a password round-trips through scrypt', async () => {
  const stored = await hashPassword('Chilli-Oil-77');
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(await verifyPassword('Chilli-Oil-77', stored), { ok: true, stale: false });
});

test('the same password hashes differently every time', async () => {
  /* Salted, so two accounts with the same password do not look alike in a
     stolen table, and one cracked digest is one account. */
  assert.notEqual(await hashPassword('Chilli-Oil-77'), await hashPassword('Chilli-Oil-77'));
});

test('a wrong password is refused', async () => {
  const stored = await hashPassword('Chilli-Oil-77');
  assert.deepEqual(await verifyPassword('chilli-oil-77', stored), { ok: false, stale: false });
  assert.deepEqual(await verifyPassword('Chilli-Oil-7', stored), { ok: false, stale: false });
  assert.deepEqual(await verifyPassword('', stored), { ok: false, stale: false });
});

test('a digest made with weaker parameters verifies and reports itself stale', async () => {
  const stored = weakerRecord('Chilli-Oil-77', 16384);
  assert.deepEqual(await verifyPassword('Chilli-Oil-77', stored), { ok: true, stale: true });
  /* A wrong password against a weak record is wrong, not stale: nothing is
     re-hashed on a failed login. */
  assert.deepEqual(await verifyPassword('nope', stored), { ok: false, stale: false });
});

test('a malformed or absurd record is refused rather than attempted', async () => {
  const cases = [
    '',
    null,
    undefined,
    'plain text',
    'pbkdf2$32768$8$1$AAAA$AAAA',
    'scrypt$32768$8$1$AAAA',
    'scrypt$32768$8$1$AAAA$AAAA$extra',
    'scrypt$0$8$1$AAAA$AAAA',
    'scrypt$32768$0$1$AAAA$AAAA',
    'scrypt$32768$8$0$AAAA$AAAA',
    'scrypt$abc$8$1$AAAA$AAAA',
    /* 1 GiB of scratch memory: refused outright, not allocated and attempted,
       or one crafted row would take the whole function down with it. */
    'scrypt$1048576$8$1$AAAA$AAAA',
    'scrypt$32768$8$1$$AAAA',
    'scrypt$32768$8$1$AAAA$'
  ];
  for (const stored of cases) {
    const check = await verifyPassword('anything', stored);
    assert.deepEqual(check, { ok: false, stale: false }, String(stored));
  }
});

test('burnPassword costs what a real verification costs', async () => {
  const started = process.hrtime.bigint();
  assert.deepEqual(await burnPassword('Chilli-Oil-77'), { ok: false, stale: false });
  const spent = Number(process.hrtime.bigint() - started) / 1e6;
  /* Not a timing-attack measurement - a "did it derive anything at all" floor.
     The whole point of burning is that a login for an address with no account
     takes as long as one with a wrong password, and a stub that returned
     immediately would satisfy every other assertion in this file. */
  assert.ok(spent > 5, 'expected real scrypt work, spent ' + spent.toFixed(1) + 'ms');
});

/* ------------------------------------------------------------- validate */

test('collect keeps the first message per field and reports overall state', () => {
  const errors = collect();
  assert.equal(errors.ok, true);
  errors.set('email', 'first');
  errors.set('email', 'second');
  errors.set('name', 'also');
  assert.equal(errors.ok, false);
  assert.deepEqual(errors.fields, { email: 'first', name: 'also' });
});

test('checkName wants a real name and trims it', () => {
  const errors = collect();
  assert.equal(checkName('  Asha Nair  ', errors), 'Asha Nair');
  assert.equal(checkName('x'.repeat(LIMITS.name), errors), 'x'.repeat(LIMITS.name));
  assert.equal(errors.ok, true);

  assert.equal(firstError((e) => checkName('', e)), 'Enter your full name.');
  assert.equal(firstError((e) => checkName('  A  ', e)), 'Enter your full name.');
  assert.match(firstError((e) => checkName('x'.repeat(LIMITS.name + 1), e)), /too long/);
  /* A bell and a DEL, built from code points so this file stays plain ASCII -
     the same reason lib/validate.mjs scans code points instead of writing a
     character class. */
  assert.match(firstError((e) => checkName('Asha' + String.fromCharCode(7) + 'Nair', e)),
    /cannot store/);
  assert.match(firstError((e) => checkName('Asha' + String.fromCharCode(127) + 'Nair', e)),
    /cannot store/);

  /* The field key is the caller's, so one form can validate two names. */
  const both = collect();
  checkName('', both, 'guest');
  assert.deepEqual(Object.keys(both.fields), ['guest']);
});

test('checkEmail normalises and matches the same pattern the browser uses', () => {
  const errors = collect();
  assert.equal(checkEmail('  Asha.Nair+book@Example.CO.UK ', errors), 'asha.nair+book@example.co.uk');
  assert.equal(errors.ok, true);

  assert.equal(firstError((e) => checkEmail('', e)), 'Enter your email address.');
  for (const bad of ['asha', 'asha@example', 'asha@example.c', 'a sha@example.com',
                     'a@b.com b@c.com', '@example.com', 'asha@.com']) {
    assert.equal(firstError((e) => checkEmail(bad, e)), 'Enter a valid email address.', bad);
  }
  assert.match(firstError((e) => checkEmail('a'.repeat(250) + '@example.com', e)), /too long/);
});

test('checkPhone is optional unless the caller says otherwise', () => {
  const errors = collect();
  assert.equal(checkPhone('', errors), '');
  assert.equal(checkPhone('  +91 98450 12345  ', errors), '+91 98450 12345');
  assert.equal(errors.ok, true);

  assert.match(firstError((e) => checkPhone('', e, true)), /phone number we can reach/);
  assert.match(firstError((e) => checkPhone('12345', e, true)), /at least 7 digits/);
  assert.match(firstError((e) => checkPhone('9'.repeat(LIMITS.phone + 1), e)), /too long/);
});

test('checkPassword asks for length and four character classes', () => {
  const errors = collect();
  assert.equal(checkPassword('Chilli-Oil-77', errors), 'Chilli-Oil-77');
  assert.equal(errors.ok, true);

  assert.match(firstError((e) => checkPassword('Ch1lli!', e)), /at least 8/);
  for (const bad of ['chilli-oil-77', 'CHILLI-OIL-77', 'ChilliOilOil', 'ChilliOil77']) {
    assert.match(firstError((e) => checkPassword(bad, e)), /upper- and lower-case/, bad);
  }
  assert.match(
    firstError((e) => checkPassword('C1!' + 'x'.repeat(LIMITS.password), e)),
    /no more than 200/
  );
  /* Not trimmed, unlike every other field: a password is bytes, and a leading
     space in one is the guest's business. */
  assert.equal(checkPassword('  Chilli-Oil-77  ', collect()), '  Chilli-Oil-77  ');
});

test('checkMessage has a floor and a ceiling, measured after trimming', () => {
  const errors = collect();
  assert.equal(checkMessage('  Four of us, Friday at eight.  ', errors), 'Four of us, Friday at eight.');
  assert.equal(errors.ok, true);

  assert.match(firstError((e) => checkMessage('too short', e)), /at least 10 characters/);
  assert.match(firstError((e) => checkMessage('   hi        ', e)), /at least 10 characters/);
  assert.match(firstError((e) => checkMessage('x'.repeat(LIMITS.message + 1), e)), /under 2000/);
});

test('checkTopic corrects anything the form could not have sent', () => {
  assert.equal(checkTopic('Dietary requirement'), 'Dietary requirement');
  assert.equal(checkTopic('  Dietary requirement  '), 'Dietary requirement');
  /* Not a lenient match: the value is stored and shown to staff, so it is one
     of the six or it is the catch-all. */
  assert.equal(checkTopic('dietary requirement'), 'Something else');
  assert.equal(checkTopic('<script>alert(1)</script>'), 'Something else');
  assert.equal(checkTopic(''), 'Something else');
  assert.equal(checkTopic(null), 'Something else');
  assert.equal(TOPICS[TOPICS.length - 1], 'Something else');
});

test('checkParty takes whole parties inside the published range', () => {
  const errors = collect();
  assert.equal(checkParty('4', errors), 4);
  assert.equal(checkParty(PARTY_MIN, errors), PARTY_MIN);
  assert.equal(checkParty(PARTY_MAX, errors), PARTY_MAX);
  assert.equal(errors.ok, true);
  /* Number() tolerates padding, which is harmless and worth writing down. */
  assert.equal(checkParty(' 4 ', collect()), 4);

  for (const bad of [0, -1, PARTY_MAX + 1, 99, 2.5, 'four', '', null, NaN, Infinity]) {
    assert.equal(checkParty(bad, collect()), 0, String(bad));
  }
  assert.match(firstError((e) => checkParty(99, e)), /call us for a larger group/);
});

/* ---------------------------------------------------------------- slots */

/* Fixed dates, so a weekday rule is tested against a known weekday instead of
   whatever today happens to be. 13 September 2026 is a Sunday. */
const SUNDAY = parseDate('2026-09-13');
const MONDAY = parseDate('2026-09-14');
const FRIDAY = parseDate('2026-09-11');

test('parseDate accepts only real calendar dates', () => {
  assert.equal(parseDate('2026-09-11').date, '2026-09-11');
  /* Local midnight, which at +05:30 is half past six the evening before. */
  assert.equal(parseDate('2026-09-11').midnight.toISOString(), '2026-09-10T18:30:00.000Z');
  assert.equal(parseDate('2028-02-29').date, '2028-02-29');

  /* Date.parse rolls an impossible day forward rather than refusing it, which
     would put a guest's table on a day that does not exist. */
  for (const bad of ['2026-02-29', '2026-02-30', '2026-09-31', '2026-13-01', '2026-00-10',
                     '2026-09-00', '2026-9-11', '26-09-11', '2026-09-11T19:00',
                     ' 2026-09-11', 'yesterday', '', null, undefined]) {
    assert.equal(parseDate(bad), null, String(bad));
  }
});

test('the weekday of a date is the index SERVICE_CLOSE_MINUTES is read with', () => {
  /* A whole week from a known Sunday: an off-by-one anywhere in the table
     fails here rather than at 22:45 on a Friday. */
  const week = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
                '2026-09-18', '2026-09-19'];
  week.forEach((date, index) => {
    const parsed = parseDate(date);
    assert.equal(weekdayOf(parsed), index, date);
    assert.equal(closeMinutes(parsed), SERVICE_CLOSE_MINUTES[index], date);
  });
  assert.equal(SERVICE_CLOSE_MINUTES.length, 7);
});

test('last seating is a full turn before closing, per the published hours', () => {
  assert.equal(formatTime(lastSeatingMinutes(SUNDAY)), '21:00');
  assert.equal(formatTime(lastSeatingMinutes(MONDAY)), '21:30');
  assert.equal(formatTime(lastSeatingMinutes(FRIDAY)), '23:00');
  assert.equal(closeMinutes(FRIDAY) - lastSeatingMinutes(FRIDAY), TURN_MINUTES);
  /* Friday closes after midnight, which is why closing times are minutes past
     the service day's own midnight and not clock times. */
  assert.ok(closeMinutes(FRIDAY) > 1440);
  assert.equal(formatTime(closeMinutes(FRIDAY)), '00:30');
});

test('formatTime pads and wraps past midnight', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(SERVICE_OPEN_MINUTES), '11:00');
  assert.equal(formatTime(1439), '23:59');
  assert.equal(formatTime(1440), '00:00');
  assert.equal(formatTime(1470), '00:30');
  assert.equal(formatTime(-30), '23:30');
});

test('parseTime reads a pre-opening clock time as the late end of the service', () => {
  assert.equal(parseTime(FRIDAY, '19:00'), 1140);
  assert.equal(parseTime(FRIDAY, '  19:00  '), 1140);
  assert.equal(parseTime(FRIDAY, '11:00'), SERVICE_OPEN_MINUTES);
  assert.equal(parseTime(FRIDAY, '00:30'), 1470);
  assert.equal(parseTime(FRIDAY, '9:30'), 570 + 1440);

  for (const bad of ['19:15', '19:01', '25:00', '19:60', '7pm', '19', '19:', ':30', '', null]) {
    assert.equal(parseTime(FRIDAY, bad), null, String(bad));
  }

  /* Parsed, and still refused by the service: 09:30 reads as the small hours
     of the following morning, hours after last seating. */
  assert.equal(isSeatable(FRIDAY, parseTime(FRIDAY, '9:30')), false);
});

test('a booking holds every slot its turn overlaps, in ascending order', () => {
  const claimed = occupiedInstants(FRIDAY, 1140);
  assert.equal(SLOTS_PER_TURN, 3);
  assert.equal(claimed.length, SLOTS_PER_TURN);
  assert.equal(claimed[0].getTime(), instantAt(FRIDAY, 1140).getTime());
  for (let i = 1; i < claimed.length; i += 1) {
    /* Ascending, because two bookings that share slots then take the row locks
       in the same order and cannot deadlock each other. */
    assert.equal(claimed[i].getTime() - claimed[i - 1].getTime(), SLOT_MINUTES * 60000);
  }
  const spanned = claimed[claimed.length - 1].getTime() - claimed[0].getTime();
  assert.ok(spanned < TURN_MINUTES * 60000);
  assert.ok(spanned + SLOT_MINUTES * 60000 >= TURN_MINUTES * 60000);
});

test('cancelling releases exactly the slots booking claimed', () => {
  /* createBooking works from a date and a minute count; cancelBooking only has
     the stored instant to work from. If the two ever disagreed, a cancelled
     table would stay full for the rest of the evening. */
  const fromMinutes = occupiedInstants(FRIDAY, 1380).map((at) => at.toISOString());
  const fromInstant = occupiedFrom(instantAt(FRIDAY, 1380)).map((at) => at.toISOString());
  assert.deepEqual(fromInstant, fromMinutes);
});

test('slotMinutesFor runs opening to last seating, on the grid', () => {
  const friday = slotMinutesFor(FRIDAY);
  assert.equal(friday[0], SERVICE_OPEN_MINUTES);
  assert.equal(friday[friday.length - 1], lastSeatingMinutes(FRIDAY));
  assert.equal(
    friday.length,
    (lastSeatingMinutes(FRIDAY) - SERVICE_OPEN_MINUTES) / SLOT_MINUTES + 1
  );
  for (const minutes of friday) {
    assert.equal(isSeatable(FRIDAY, minutes), true, formatTime(minutes));
  }
  /* Sunday closes earliest, so it is the shortest list of the week. */
  assert.ok(slotMinutesFor(SUNDAY).length < friday.length);
});

test('isSeatable is the gate for anything a client sends', () => {
  assert.equal(isSeatable(FRIDAY, SERVICE_OPEN_MINUTES), true);
  assert.equal(isSeatable(FRIDAY, SERVICE_OPEN_MINUTES - SLOT_MINUTES), false);
  assert.equal(isSeatable(FRIDAY, lastSeatingMinutes(FRIDAY)), true);
  assert.equal(isSeatable(FRIDAY, lastSeatingMinutes(FRIDAY) + SLOT_MINUTES), false);
  assert.equal(isSeatable(FRIDAY, 1155), false);
  /* 22:00 is bookable on a Friday and closed on a Sunday. */
  assert.equal(isSeatable(FRIDAY, 1320), true);
  assert.equal(isSeatable(SUNDAY, 1320), false);
});

test('a service date is not always the calendar date', () => {
  const late = instantAt(FRIDAY, 1470);
  assert.equal(localDateString(late), '2026-09-12');
  assert.equal(serviceDateOf(late), '2026-09-11');
  assert.equal(isAfterMidnight(late), true);
  assert.equal(localTimeString(late), '00:30');
  /* What the confirmation shows a guest has to parse back to the slot it came
     from, or a booking cannot be found by the details it was made with. */
  assert.equal(parseTime(FRIDAY, localTimeString(late)), 1470);

  const dinner = instantAt(FRIDAY, 1140);
  assert.equal(localDateString(dinner), '2026-09-11');
  assert.equal(serviceDateOf(dinner), '2026-09-11');
  assert.equal(isAfterMidnight(dinner), false);
  assert.equal(localTimeString(dinner), '19:00');
});

test('local time is read at the fixed +05:30, either side of midnight', () => {
  assert.equal(localDateString(new Date('2026-09-10T18:30:00.000Z')), '2026-09-11');
  assert.equal(localDateString(new Date('2026-09-10T18:29:59.999Z')), '2026-09-10');
  assert.equal(localTimeString(new Date('2026-09-10T18:30:00.000Z')), '00:00');
  assert.equal(localTimeString(new Date('2026-09-11T13:30:00.000Z')), '19:00');
});

test('the horizon is inclusive at both ends', () => {
  const now = new Date('2026-09-11T09:00:00.000Z'); /* 14:30 in Bengaluru */
  assert.equal(HORIZON_DAYS, 60);
  assert.equal(withinHorizon(parseDate('2026-09-10'), now), false);
  assert.equal(withinHorizon(parseDate('2026-09-11'), now), true);
  assert.equal(withinHorizon(parseDate('2026-11-10'), now), true);
  assert.equal(withinHorizon(parseDate('2026-11-11'), now), false);
});

/* ----------------------------------------------------------------- http */

test('readCookies parses a jar and ignores what is not a pair', () => {
  const jar = readCookies(fakeRequest({ cookie: 'uf_sid=abc123; theme=dark' }));
  assert.equal(jar.uf_sid, 'abc123');
  assert.equal(jar.theme, 'dark');
  assert.deepEqual({ ...readCookies(fakeRequest({})) }, {});
  assert.deepEqual({ ...readCookies(fakeRequest({ cookie: '' })) }, {});
  assert.deepEqual({ ...readCookies(fakeRequest({ cookie: 'novalue; =orphan; a=1' })) }, { a: '1' });
  /* Values go out percent-encoded, so they come back decoded - and a value
     that is not valid encoding is kept verbatim rather than throwing on a
     request the guest cannot do anything about. */
  assert.equal(readCookies(fakeRequest({ cookie: 'uf_sid=a%20b' })).uf_sid, 'a b');
  assert.equal(readCookies(fakeRequest({ cookie: 'uf_sid=%E0%A4' })).uf_sid, '%E0%A4');
});

test('the session cookie carries the flags that make it worth having', () => {
  assert.match(SESSION_COOKIE, /^[A-Za-z0-9_-]+$/);

  const res = fakeResponse();
  setSessionCookie(res, 'tok en/+', 60);
  const line = res.cookies()[0];

  assert.ok(line.startsWith(SESSION_COOKIE + '='));
  /* Encoded, because the token is base64url today and need not stay that way. */
  assert.ok(line.includes(encodeURIComponent('tok en/+')), line);
  assert.ok(/(^|; )HttpOnly(;|$)/.test(line), line);
  assert.ok(/(^|; )SameSite=Lax(;|$)/.test(line), line);
  assert.ok(/(^|; )Path=\/(;|$)/.test(line), line);
  assert.ok(/(^|; )Max-Age=60(;|$)/.test(line), line);
  /* Secure is unconditional except where it cannot work: a plain-http
     localhost, where the browser would drop the cookie and every signed-in
     path would look broken for the wrong reason. */
  assert.equal(/(^|; )Secure(;|$)/.test(line), !INSECURE_COOKIES);
});

test('clearing the session expires the cookie rather than trusting the client', () => {
  const res = fakeResponse();
  clearSessionCookie(res);
  const line = res.cookies()[0];
  assert.ok(line.startsWith(SESSION_COOKIE + '='));
  assert.ok(/(^|; )Max-Age=0(;|$)/.test(line), line);
  assert.ok(/(^|; )HttpOnly(;|$)/.test(line), line);
  assert.equal(/(^|; )Secure(;|$)/.test(line), !INSECURE_COOKIES);
});

test('two Set-Cookie lines do not overwrite each other', () => {
  const res = fakeResponse();
  setSessionCookie(res, 'first', 60);
  clearSessionCookie(res);
  assert.equal(res.cookies().length, 2);
});

test('sameOrigin trusts Sec-Fetch-Site first', () => {
  assert.equal(sameOrigin(fakeRequest({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(sameOrigin(fakeRequest({ 'sec-fetch-site': 'Same-Origin' })), true);
  /* 'none' is a typed URL or a bookmark: the guest themselves. */
  assert.equal(sameOrigin(fakeRequest({ 'sec-fetch-site': 'none' })), true);
  assert.equal(sameOrigin(fakeRequest({ 'sec-fetch-site': 'cross-site' })), false);
  /* 'same-site' is a sibling subdomain, which is not this site. */
  assert.equal(sameOrigin(fakeRequest({ 'sec-fetch-site': 'same-site' })), false);
  /* The header decides even when a matching Origin is also present, so a
     forged Origin cannot talk its way past a browser that told the truth. */
  const both = { 'sec-fetch-site': 'cross-site', origin: 'https://a.test', host: 'a.test' };
  assert.equal(sameOrigin(fakeRequest(both)), false);
});

test('sameOrigin falls back to matching the Origin host', () => {
  const ok = (headers) => sameOrigin(fakeRequest(headers));
  assert.equal(ok({ origin: 'https://urbanflame.test', host: 'urbanflame.test' }), true);
  assert.equal(ok({ origin: 'HTTPS://UrbanFlame.Test', host: 'urbanflame.test' }), true);
  assert.equal(ok({ origin: 'http://localhost:8080', host: 'localhost:8080' }), true);
  /* The port is part of the host, so another server on the same machine is
     still another origin. */
  assert.equal(ok({ origin: 'http://localhost:8080', host: 'localhost:3000' }), false);
  assert.equal(ok({ origin: 'https://evil.test', host: 'urbanflame.test' }), false);
  /* A sandboxed iframe or a file:// page sends the string "null". */
  assert.equal(ok({ origin: 'null', host: 'urbanflame.test' }), false);
  assert.equal(ok({ origin: 'not a url', host: 'urbanflame.test' }), false);
  assert.equal(ok({ host: 'urbanflame.test' }), false);
  assert.equal(ok({}), false);
  /* Behind a proxy the host the browser saw is the forwarded one. */
  const proxied = {
    origin: 'https://urbanflame.test',
    host: 'internal:3000',
    'x-forwarded-host': 'urbanflame.test'
  };
  assert.equal(ok(proxied), true);
});

test('clientIp prefers the forwarded chain and falls back to the socket', () => {
  const chain = { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' };
  assert.equal(clientIp(fakeRequest(chain)), '203.0.113.7');
  assert.equal(clientIp(fakeRequest({ 'x-forwarded-for': '  203.0.113.7  ' })), '203.0.113.7');
  assert.equal(clientIp(fakeRequest({})), '10.0.0.1');
  /* No socket either: a bucket key is still needed, and one shared key throttles
     harder rather than not at all. */
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('searchParams reads the query off a raw request URL', () => {
  const params = searchParams(fakeRequest({}, '/api/bookings?date=2026-09-11&reference=UF-ABC234'));
  assert.equal(params.get('date'), '2026-09-11');
  assert.equal(params.get('reference'), 'UF-ABC234');
  assert.equal(searchParams(fakeRequest({}, '/api/bookings')).get('date'), null);
  assert.equal(searchParams(fakeRequest({}, '/api/bookings?')).get('date'), null);
  assert.equal(searchParams({ headers: {} }).get('date'), null);
  /* Decoded, which is what every handler assumes of an address in a query. */
  assert.equal(searchParams(fakeRequest({}, '/x?email=a%40b.com')).get('email'), 'a@b.com');
});

/* ----------------------------------------------------------- references */

test('a reference is short, unambiguous and hard to guess', () => {
  const draws = [];
  for (let i = 0; i < 200; i += 1) draws.push(makeReference());

  for (const reference of draws) {
    assert.match(reference, /^UF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    /* The characters that come back wrong off a paper pass or a phone call. */
    assert.equal(/[01ILO]/.test(reference), false, reference);
  }

  /* Not "all distinct": 200 draws from 31^6 collide about once in forty
     thousand runs, and a test that fails that rarely is worse than no test.
     No generator with real bias can clear this bar. */
  assert.ok(new Set(draws).size > 100);
});

test('normalizeReference accepts the two forms a guest might type', () => {
  assert.equal(normalizeReference('UF-ABC234'), 'UF-ABC234');
  assert.equal(normalizeReference('uf-abc234'), 'UF-ABC234');
  assert.equal(normalizeReference('ABC234'), 'UF-ABC234');
  assert.equal(normalizeReference('abc234'), 'UF-ABC234');
  assert.equal(normalizeReference('  uf abc 234  '), 'UF-ABC234');
  assert.equal(normalizeReference('UFABC234'), 'UF-ABC234');

  for (const bad of ['', null, undefined, 'UF', 'UF-', 'ABC23', 'ABC2345', 'UF-ABC2345']) {
    assert.equal(normalizeReference(bad), '', String(bad));
  }
});

test('a reference whose body starts with UF is not mangled', () => {
  /* One body in 961 begins with those two letters. Stripping a leading "UF"
     from a string of any length turned this one into four characters and then
     rejected a reference the restaurant had already given out. */
  assert.equal(normalizeReference('UF-UFXYZ2'), 'UF-UFXYZ2');
  assert.equal(normalizeReference('UFUFXYZ2'), 'UF-UFXYZ2');
  assert.equal(normalizeReference('UFXYZ2'), 'UF-UFXYZ2');
});

test('every reference the generator draws survives normalising', () => {
  for (let i = 0; i < 500; i += 1) {
    const reference = makeReference();
    assert.equal(normalizeReference(reference), reference);
    assert.equal(normalizeReference(reference.slice(3)), reference);
    assert.equal(normalizeReference(reference.toLowerCase()), reference);
  }
});

/* --------------------------------------------------------------- config */

test('admin is a list from the environment, and empty by default', () => {
  if (ADMIN_EMAILS.length === 0) {
    /* The state a fresh deploy is in. If this ever passes for an address, the
       staff pages are open to whoever typed it. */
    assert.equal(isAdminEmail('asha@example.com'), false);
  } else {
    /* Someone's shell has ADMIN_EMAILS set; check the matching instead. */
    assert.equal(isAdminEmail(ADMIN_EMAILS[0].toUpperCase()), true);
    assert.equal(isAdminEmail('  ' + ADMIN_EMAILS[0] + '  '), true);
  }
  assert.equal(isAdminEmail(''), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
});

/*
 * Contracts between files.
 *
 * Everything above tests one function. These test agreements that no compiler,
 * linter or type checker can see: a constant in JavaScript and a number in SQL,
 * a pattern written twice because the browser copy cannot import the server
 * one, and sentences that have to read the same whichever side refused the
 * form. Each of them breaks silently, in production, months later.
 */

test('the covers ceiling in SQL is the one in lib/config.mjs', () => {
  /* lib/schema.sql asks for this test by name: SQL cannot read a JavaScript
     constant, so this is the only thing keeping the CHECK that actually
     prevents an oversell in step with the arithmetic that reports capacity. */
  const schema = read('lib/schema.sql');
  const ceiling = /covers\s*<=\s*(\d+)/.exec(schema);
  assert.ok(ceiling, 'expected a CHECK capping covers in lib/schema.sql');
  assert.equal(Number(ceiling[1]), COVERS_TOTAL);
});

test('the party range in SQL is the one the validator enforces', () => {
  const schema = read('lib/schema.sql');
  const range = /party_size\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)/i.exec(schema);
  assert.ok(range, 'expected a CHECK on party_size in lib/schema.sql');
  assert.equal(Number(range[1]), PARTY_MIN);
  assert.equal(Number(range[2]), PARTY_MAX);
});

test('the email pattern is byte-identical to the browser one', () => {
  /* main.js cannot import from lib/: it is a plain script served to the page,
     and the site has to work with no server at all. So the expression is
     written twice, and this is what stops the two from drifting into a form
     that accepts an address the API then refuses. */
  const declared = /^\s*var EMAIL_RE = (\/.*\/i);\s*$/m.exec(read('public/assets/js/main.js'));
  assert.ok(declared, 'expected a one-line EMAIL_RE in public/assets/js/main.js');
  assert.equal(declared[1], String(EMAIL_RE));
});

test('every topic the form offers is a topic the API keeps', () => {
  /* checkTopic rewrites anything it does not recognise to the catch-all, so an
     option added to the form and not to TOPICS would look like it worked and
     arrive filed as "Something else". */
  const select = /<select[^>]*id="contact-topic"[\s\S]*?<\/select>/.exec(read('public/contact.html'));
  assert.ok(select, 'expected the topic select in public/contact.html');
  /* No value attributes: the option text is what the browser submits. */
  assert.equal(/<option[^>]+value=/.test(select[0]), false);
  const offered = [...select[0].matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1].trim());
  assert.deepEqual(offered, TOPICS);
});

test('a field refused in the browser and refused by the API reads the same', () => {
  /* Same field, same reason, same sentence, whether main.js caught it before
     sending or the API caught it on the way in. Two wordings for one rule is
     how a guest ends up thinking the site changed its mind. */
  const main = read('public/assets/js/main.js');
  const sentences = [
    firstError((e) => checkName('', e)),
    firstError((e) => checkEmail('asha', e)),
    firstError((e) => checkPhone('12345', e, true)),
    firstError((e) => checkPassword('Ch1lli!', e)),
    firstError((e) => checkPassword('chilli-oil-77', e))
  ];
  for (const sentence of sentences) {
    assert.ok(sentence, 'expected a message from the checker');
    assert.ok(main.includes(sentence), 'main.js should also say: ' + sentence);
  }

  /* The one message with an em dash in it. Every source file in this repo
     writes that character as an escape, so compare the escaped form - built
     from code points here for exactly the same reason. */
  const escaped = firstError((e) => checkMessage('short', e))
    .replace(String.fromCharCode(8212), String.fromCharCode(92) + 'u2014');
  assert.ok(main.includes(escaped), 'main.js should also say: ' + escaped);
});

/* Reads the SERVICE mirror out of main.js as data. A regex per field would
   pass on a field that had been deleted, so the whole object literal is parsed
   once and every key is compared - including any key lib/config.mjs does not
   know about, which is how a stale number survives a rename. */
function serviceMirror() {
  const block = /\bvar SERVICE = (\{[\s\S]*?\});/.exec(read('public/assets/js/main.js'));
  assert.ok(block, 'expected a var SERVICE = { ... } literal in public/assets/js/main.js');
  /* The literal is plain JSON once the keys are quoted. Function(...) would
     also evaluate it, and would also run anything else that got in there. */
  const json = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/([{,]\s*)([a-zA-Z][a-zA-Z0-9]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

test('the service rules main.js draws with are the ones the API books with', () => {
  /* main.js needs these numbers before it has spoken to anything: it draws the
     slot grid with no server at all, and the date field's own min/max come from
     the horizon. Every one of them is also the number the API enforces, so a
     change on one side and not the other is a form that offers a table the
     server will refuse - or worse, refuses one it would have given. */
  assert.deepEqual(serviceMirror(), {
    coversTotal: COVERS_TOTAL,
    openMinutes: SERVICE_OPEN_MINUTES,
    closeMinutes: SERVICE_CLOSE_MINUTES,
    slotMinutes: SLOT_MINUTES,
    turnMinutes: TURN_MINUTES,
    partyMin: PARTY_MIN,
    partyMax: PARTY_MAX,
    horizonDays: HORIZON_DAYS,
    tzOffset: TZ_OFFSET
  });
});

test('the party select offers exactly the range the API accepts', () => {
  /* checkParty refuses anything outside it with a sentence about calling us,
     so an option beyond PARTY_MAX is a dead end the guest only finds after
     filling the form in. The select carries value attributes, unlike the topic
     one, because "2 people" is not a number. */
  const select = /<select[^>]*id="book-party"[\s\S]*?<\/select>/.exec(read('public/book.html'));
  assert.ok(select, 'expected the party select in public/book.html');
  const offered = [...select[0].matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
  const expected = [];
  for (let size = PARTY_MIN; size <= PARTY_MAX; size += 1) expected.push(size);
  assert.deepEqual(offered, expected);

  /* And every one of them is a value checkParty keeps. */
  for (const size of offered) assert.equal(checkParty(String(size), collect()), size);
});

test('the reference alphabet in the browser is the one the server generates', () => {
  /* main.js mints its own references in local mode, and tidyReference has to
     accept anything the server minted. A character in one alphabet and not the
     other is a reference that cannot be looked up on the site that issued it. */
  const server = /const REFERENCE_ALPHABET = '([^']+)';/.exec(read('lib/bookings.mjs'));
  const browser = /var REFERENCE_ALPHABET = '([^']+)';/.exec(read('public/assets/js/main.js'));
  assert.ok(server, 'expected REFERENCE_ALPHABET in lib/bookings.mjs');
  assert.ok(browser, 'expected REFERENCE_ALPHABET in public/assets/js/main.js');
  assert.equal(browser[1], server[1]);

  /* Both sides drop the five characters that get misread aloud or in
     handwriting. A reference is quoted over a counter, so this is not
     cosmetic - and it is the reason the alphabet is 31 characters, not 36. */
  for (const confusable of ['0', '1', 'I', 'L', 'O']) {
    assert.equal(server[1].includes(confusable), false, confusable + ' is too easy to misread');
  }
  assert.equal(server[1].length, 31);

  /* And the server's own generator stays inside it. */
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const reference = makeReference();
    assert.match(reference, /^UF-[0-9A-Z]{6}$/);
    for (const character of reference.slice(3)) assert.ok(server[1].includes(character));
  }
});

test('every page the client and the hosts name is a page that exists', () => {
  /* tools/check.mjs resolves links inside public/. This is the other direction:
     a page name written into a JavaScript string or a redirect. */
  const main = read('public/assets/js/main.js');
  for (const [, page] of main.matchAll(/'([a-z0-9-]+\.html)(?:#[a-z0-9-]+)?'/g)) {
    assert.ok(
      existsSync(resolve(repo, 'public', page)),
      'main.js points at public/' + page + ', which does not exist'
    );
  }
});
