/*
 * lib/ratelimit.mjs - windowed throttling for the endpoints worth guessing at.
 *
 * The counters live in Postgres rather than in a module-level Map. On a
 * serverless host every cold start gets its own memory, so an in-process limit
 * of eight is really a limit of eight per instance, which is to say no limit at
 * all to anyone willing to open connections in parallel.
 *
 * One statement does the whole thing: the upsert either increments a live
 * window or replaces a stale one, and returns the resulting count. There is no
 * read-then-write gap for two simultaneous attempts to slip through.
 */

import { one, query } from './db.mjs';
import { fail } from './http.mjs';

/*
 * Per-endpoint policy.
 *
 * Login is generous per address and tight per account, which is the useful
 * pairing: a household or an office behind one address should not lock each
 * other out, while eight wrong guesses at one account is already well past
 * anything a person does by accident. A correct password clears the account
 * bucket, so the tight limit is only ever felt by somebody guessing.
 */
export const POLICY = {
  loginIp: { limit: 30, seconds: 600 },
  loginEmail: { limit: 8, seconds: 900 },
  signupIp: { limit: 6, seconds: 3600 },
  enquiryIp: { limit: 10, seconds: 3600 },
  bookingIp: { limit: 12, seconds: 3600 },
  /* A reference is six characters from an alphabet of 31. Thirty lookups an
     hour is plenty for a guest who mistyped theirs and useless to anyone
     working through the keyspace. */
  lookupIp: { limit: 30, seconds: 3600 },
  cancelIp: { limit: 20, seconds: 3600 }
};

/* The key is a primary key in a text column, and part of it comes from a
   request body. Bounded here rather than trusting every caller to have
   validated first, because some of these run before validation does. */
function bucketKey(name, subject) {
  return name + ':' + String(subject == null ? '' : subject).slice(0, 160).toLowerCase();
}

function retryAfterFor(windowStart, seconds) {
  const endsAt = new Date(windowStart).getTime() + seconds * 1000;
  const left = Math.ceil((endsAt - Date.now()) / 1000);
  return left > 0 ? left : 1;
}

/*
 * Counts one attempt and reports whether it was over the line.
 *
 * The CASE arms are what make the window sliding-by-reset rather than a
 * permanent tally: a window older than its length is not extended, it is
 * started again at one.
 */
export async function bump(name, subject) {
  const policy = POLICY[name];
  if (!policy) throw new Error('unknown rate limit policy: ' + name);
  const key = bucketKey(name, subject);

  const row = await one(
    `INSERT INTO rate_limits AS r (bucket, window_start, hits)
          VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE
            SET hits = CASE
                         WHEN r.window_start > now() - make_interval(secs => $2::double precision)
                         THEN r.hits + 1
                         ELSE 1
                       END,
                window_start = CASE
                         WHEN r.window_start > now() - make_interval(secs => $2::double precision)
                         THEN r.window_start
                         ELSE now()
                       END
       RETURNING hits, window_start`,
    [key, policy.seconds]
  );

  const hits = row ? Number(row.hits) : 1;
  return {
    allowed: hits <= policy.limit,
    hits: hits,
    retryAfter: row ? retryAfterFor(row.window_start, policy.seconds) : policy.seconds
  };
}

/* Called after a correct password, so an honest visitor never accumulates a
   lockout. Nothing else clears a bucket early. */
export async function clear(name, subject) {
  await query('DELETE FROM rate_limits WHERE bucket = $1', [bucketKey(name, subject)]);
}

/*
 * Bumps several buckets and answers 429 if any of them tripped.
 *
 * Every bucket is counted even when an earlier one already failed: the
 * alternative lets an attacker keep one budget alive by deliberately
 * exhausting another.
 */
export async function enforce(res, checks) {
  let worst = null;

  for (const check of checks) {
    const result = await bump(check[0], check[1]);
    if (!result.allowed && (!worst || result.retryAfter > worst.retryAfter)) worst = result;
  }

  if (!worst) return true;

  res.setHeader('Retry-After', String(worst.retryAfter));
  fail(
    res,
    429,
    'rate_limited',
    'Too many attempts. Please wait a few minutes and try again.'
  );
  return false;
}

/* Housekeeping, called from the same places that prune sessions. A bucket
   whose window closed an hour ago is not evidence of anything. */
export async function pruneRateLimits() {
  await query(
    "DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'"
  );
}
