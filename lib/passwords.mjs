/*
 * lib/passwords.mjs - scrypt from node:crypto, no dependency.
 *
 * scrypt is memory-hard (RFC 7914), which is the property that matters: an
 * attacker with a stolen users table cannot trade cheap parallel silicon for
 * speed the way they can against a plain SHA-256, however many times you
 * iterate it. The browser-side PBKDF2 in main.js was the best a static site
 * could do; this is what a server can do instead.
 *
 * Every digest carries its own parameters, so raising them later re-hashes
 * accounts on their next successful login instead of locking anybody out.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/* N=2^15, r=8, p=1 costs 128*N*r = 32 MiB and about a tenth of a second.
   Node's default maxmem is exactly 32 MiB, which this sits precisely on top
   of, so it is raised rather than left to round the wrong way. */
export const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
const MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;

function encode(params, salt, hash) {
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64')
  ].join('$');
}

function decode(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  /* A record claiming absurd parameters would otherwise let one login request
     allocate the whole function. Refuse rather than attempt it. */
  if (128 * N * r > MAXMEM) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[4], 'base64');
    hash = Buffer.from(parts[5], 'base64');
  } catch (error) {
    return null;
  }
  if (!salt.length || !hash.length) return null;
  return { N, r, p, keylen: hash.length, salt, hash };
}

async function derive(password, salt, params) {
  return scryptAsync(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  return encode(PARAMS, salt, hash);
}

/* Returns { ok, stale }. `stale` means the record verified but was made with
   weaker parameters than PARAMS, so the caller should store a fresh hash. */
export async function verifyPassword(password, stored) {
  const record = decode(stored);
  if (!record) return { ok: false, stale: false };

  const candidate = await derive(password, record.salt, record);
  if (candidate.length !== record.hash.length) return { ok: false, stale: false };
  const ok = timingSafeEqual(candidate, record.hash);
  const stale =
    ok &&
    (record.N < PARAMS.N ||
      record.r < PARAMS.r ||
      record.p < PARAMS.p ||
      record.keylen < PARAMS.keylen);
  return { ok, stale };
}

/* Burned when no account matches, so a wrong address and a wrong password
   take the same time to reject. Without this the login endpoint is a fast,
   accurate test for whether an address is registered. */
export async function burnPassword(password) {
  await derive(password, Buffer.alloc(SALT_BYTES), PARAMS);
  return { ok: false, stale: false };
}
