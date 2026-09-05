/*
 * lib/config.mjs - every environment-derived value and service rule, in one
 * place so nothing else has to read process.env.
 *
 * Nothing here throws on a missing variable. The site is built to run with no
 * backend at all - main.js falls back to localStorage - so an unconfigured
 * deploy has to serve a working site rather than a stack trace. Callers ask
 * hasDatabase() before touching anything that needs one.
 */

/* Vercel's Neon and Supabase integrations both set POSTGRES_URL; a plain
   Postgres anywhere else sets DATABASE_URL. Accept either. */
export const DATABASE_URL =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

export function hasDatabase() {
  return DATABASE_URL !== '';
}

/* Bengaluru does not observe daylight saving and has not since 1945, so a
   fixed offset is not an approximation here - it is exactly right, and it
   keeps a whole timezone database out of the dependency list. Slot times are
   authored in restaurant-local time and stored as timestamptz. */
export const TZ_OFFSET = '+05:30';
export const TZ_LABEL = 'Asia/Kolkata';

/* From the site copy: "24 seated, 8 at the counter". The dining room is the
   constraint the kitchen cannot talk its way out of. */
export const COVERS_TOTAL = 32;

/* "Kitchen: From 11:00 daily", and the closing times published on
   contact.html. Friday and Saturday run past midnight, so those are minutes
   past that service day's own midnight rather than clock times - 1470 is
   00:30 the following morning, still the same service.

   Last seating is close minus one turn, so nobody is booked into a table that
   has to be cleared before they finish. Indexed by getDay(): Sunday first. */
export const SERVICE_OPEN_MINUTES = 11 * 60;
export const SERVICE_CLOSE_MINUTES = [1350, 1380, 1380, 1380, 1380, 1470, 1470];
export const SLOT_MINUTES = 30;
export const TURN_MINUTES = 90;

/* Larger parties need a conversation about the counter and the long table,
   so the form sends them to the phone instead of guessing. */
export const PARTY_MIN = 1;
export const PARTY_MAX = 12;

/* Two months is far enough ahead for a neighbourhood grill and near enough
   that the menu and the hours are still the ones the guest was shown. */
export const HORIZON_DAYS = 60;

/* Session cookie lifetime. Rotated on every login, revocable server-side
   because the token is stored hashed rather than signed. */
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'uf_sid';

/* Staff access is granted by environment variable and re-checked on the
   server for every admin request. It is deliberately not a column on the
   users table: a promoted flag that lives in the database is one SQL mistake
   away from being self-assignable, and this list cannot be edited by anyone
   who does not already hold the deploy credentials. */
export const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

/* Set to '1' by tools/dev-server.mjs and the test harness. Only ever relaxes
   the Secure cookie flag, which a plain-http localhost cannot honour. */
export const INSECURE_COOKIES = process.env.UF_INSECURE_COOKIES === '1';
