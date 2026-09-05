/*
 * lib/http.mjs - request and response plumbing shared by every function in
 * api/. Written against the Node request/response signature that both Vercel
 * and tools/dev-server.mjs provide, so the same handler runs in both places
 * with nothing stubbed out.
 */

import { INSECURE_COOKIES, SESSION_COOKIE } from './config.mjs';
import { isMissingSchema } from './db.mjs';

/* Generous for an enquiry, nowhere near enough to be worth using as a way to
   spend the function's memory. */
const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* Every one of these responses is either personal or a live count. None of
     it may sit in a shared cache, and the site's own Cache-Control rules in
     vercel.json do not reach the functions. */
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload);
}

/* One error shape for the whole API: a machine-readable code, a sentence fit
   to show a guest, and optionally which fields were at fault so the client can
   put the message beside the right input. */
export function fail(res, status, code, message, fields) {
  const error = { code: code, message: message };
  if (fields && Object.keys(fields).length) error.fields = fields;
  sendJson(res, status, { error: error });
}

export function methodAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader('Allow', allowed.join(', '));
  fail(res, 405, 'method_not_allowed', 'That method is not allowed here.');
  return false;
}

function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
}

/*
 * CSRF defence without a token round trip.
 *
 * The session cookie is SameSite=Lax, so a cross-site POST never carries it in
 * a modern browser. This is the second lock: a state-changing request must
 * prove it came from this origin. fetch() always sends Origin on a POST, and
 * every browser that matters also sends Sec-Fetch-Site, so requiring one of
 * the two costs nothing and refuses anything forged from another page.
 */
export function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return false;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch (error) {
    return false;
  }
  return host === requestHost(req);
}

export function requireSameOrigin(req, res) {
  if (sameOrigin(req)) return true;
  fail(res, 403, 'cross_origin', 'This request did not come from the Urban Flame site.');
  return false;
}

export async function readJson(req, res) {
  /* Vercel parses application/json for us; the dev server does not. Accept
     either so neither path is special-cased at the call site. */
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  const chunks = [];
  let size = 0;
  let tooBig = false;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooBig = true;
      break;
    }
    chunks.push(chunk);
  }

  if (tooBig) {
    fail(res, 413, 'body_too_large', 'That request was too large.');
    return null;
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(res, 400, 'bad_json', 'Expected a JSON object.');
      return null;
    }
    return parsed;
  } catch (error) {
    fail(res, 400, 'bad_json', 'That request body was not valid JSON.');
    return null;
  }
}

export function readCookies(req) {
  const jar = Object.create(null);
  const header = req.headers.cookie;
  if (!header) return jar;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      jar[name] = decodeURIComponent(value);
    } catch (error) {
      jar[name] = value;
    }
  }
  return jar;
}

function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', (Array.isArray(existing) ? existing : [existing]).concat(value));
}

export function setSessionCookie(res, token, maxAgeSeconds) {
  const bits = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(maxAgeSeconds)
  ];
  /* Secure is unconditional in production. It is dropped only for a plain-http
     localhost, where the browser would otherwise discard the cookie and every
     signed-in path would look broken for the wrong reason. */
  if (!INSECURE_COOKIES) bits.push('Secure');
  appendCookie(res, bits.join('; '));
}

export function clearSessionCookie(res) {
  const bits = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (!INSECURE_COOKIES) bits.push('Secure');
  appendCookie(res, bits.join('; '));
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function searchParams(req) {
  const url = req.url || '/';
  const at = url.indexOf('?');
  return new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
}

/*
 * Wraps a route so no failure path has to be remembered twice.
 *
 * Three cases get a specific answer instead of a generic 500, because the
 * client acts on them: an unconfigured database and an unmigrated one both
 * mean "there is no backend here, use the local fallback", and everything else
 * is logged server-side and reported without internals. A stack trace in a
 * response body is how a database schema ends up in someone's notes.
 */
export function handler(route) {
  return async function wrapped(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (error && error.code === 'UF_NO_DATABASE') {
        fail(res, 503, 'database_unavailable', 'This deployment has no database configured.');
        return;
      }
      if (isMissingSchema(error)) {
        fail(res, 503, 'schema_missing', 'The database has not been initialised yet.');
        return;
      }
      console.error('[api] unhandled', error);
      if (!res.headersSent) {
        fail(res, 500, 'server_error', 'Something went wrong at our end. Please try again.');
      }
    }
  };
}
