/*
 * api/auth/login.mjs - POST /api/auth/login
 *
 * Body: { email, password }. Every failure answers with the same status, the
 * same code and the same sentence, and takes roughly the same time, so this
 * endpoint cannot be used to find out which addresses are registered.
 */

import {
  clientIp,
  fail,
  handler,
  methodAllowed,
  readJson,
  requireSameOrigin,
  sendJson
} from '../../lib/http.mjs';
import { burnPassword, hashPassword, verifyPassword } from '../../lib/passwords.mjs';
import { clear, enforce, pruneRateLimits } from '../../lib/ratelimit.mjs';
import { pruneExpiredSessions, startSession } from '../../lib/sessions.mjs';
import { findByEmail, publicUser, setPassword } from '../../lib/users.mjs';
import { normalizeEmail } from '../../lib/validate.mjs';

/* One sentence for a wrong address, a wrong password and a malformed record
   alike. Naming which half was wrong is the entire enumeration attack. */
const REFUSAL = 'That email address and password do not match an account.';

export default handler(async function login(req, res) {
  if (!methodAllowed(req, res, ['POST'])) return;
  if (!requireSameOrigin(req, res)) return;

  const body = await readJson(req, res);
  if (!body) return;

  const email = normalizeEmail(body.email);
  const password = String(body.password == null ? '' : body.password);

  /*
   * Throttled before the password is touched, and on both keys.
   *
   * Per address is generous, because an office or a household shares one. Per
   * account is tight, and cleared on success below, so it is only ever felt by
   * somebody who is guessing.
   */
  if (!(await enforce(res, [['loginIp', clientIp(req)], ['loginEmail', email]]))) return;

  const row = email ? await findByEmail(email) : null;

  if (!row) {
    /* Spend the same tenth of a second scrypt would have spent. Without this,
       response time alone answers "is this address registered". */
    await burnPassword(password);
    fail(res, 401, 'bad_credentials', REFUSAL);
    return;
  }

  const check = await verifyPassword(password, row.password);
  if (!check.ok) {
    fail(res, 401, 'bad_credentials', REFUSAL);
    return;
  }

  /* The plaintext is in hand exactly once per login. If the stored digest was
     made with weaker parameters, this is the only moment it can be upgraded. */
  if (check.stale) await setPassword(row.id, await hashPassword(password));

  await clear('loginEmail', email);
  await startSession(res, row.id);
  await pruneExpiredSessions();
  await pruneRateLimits();

  sendJson(res, 200, { user: publicUser(row) });
});
