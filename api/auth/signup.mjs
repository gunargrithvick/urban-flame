/*
 * api/auth/signup.mjs - POST /api/auth/signup
 *
 * Creates an account and signs it straight in, which is what the form has
 * always done in its localStorage version. Body: { name, email, phone?,
 * password }.
 */

import { isDuplicate } from '../../lib/db.mjs';
import {
  clientIp,
  fail,
  handler,
  methodAllowed,
  readJson,
  requireSameOrigin,
  sendJson
} from '../../lib/http.mjs';
import { hashPassword } from '../../lib/passwords.mjs';
import { enforce } from '../../lib/ratelimit.mjs';
import { pruneExpiredSessions, startSession } from '../../lib/sessions.mjs';
import { createUser, publicUser } from '../../lib/users.mjs';
import { checkEmail, checkName, checkPassword, checkPhone, collect } from '../../lib/validate.mjs';

export default handler(async function signup(req, res) {
  if (!methodAllowed(req, res, ['POST'])) return;
  if (!requireSameOrigin(req, res)) return;

  const body = await readJson(req, res);
  if (!body) return;
  if (!(await enforce(res, [['signupIp', clientIp(req)]]))) return;

  const errors = collect();
  const name = checkName(body.name, errors);
  const email = checkEmail(body.email, errors);
  const phone = checkPhone(body.phone, errors, false);
  const password = checkPassword(body.password, errors);

  if (!errors.ok) {
    fail(res, 422, 'invalid', 'Please check the highlighted fields.', errors.fields);
    return;
  }

  let row;
  try {
    row = await createUser({ email, name, phone, password: await hashPassword(password) });
  } catch (error) {
    /*
     * Signup does tell you an address is taken, unlike login.
     *
     * The alternative - accepting the request and sending nothing - needs a
     * mail server this deployment does not have, and would leave a visitor
     * staring at a confirmation for an account they cannot use. The address is
     * therefore only confirmed to somebody who already typed it, six times an
     * hour per address, which is a far cheaper leak than a broken signup.
     */
    if (isDuplicate(error, 'users_email')) {
      fail(res, 409, 'email_taken', 'That email address already has an account.', {
        email: 'That email address already has an account. Sign in instead.'
      });
      return;
    }
    throw error;
  }

  await startSession(res, row.id);
  /* One cheap statement on the rarest write path, and the sessions table stops
     growing without a scheduled job to prune it. */
  await pruneExpiredSessions();

  sendJson(res, 201, { user: publicUser(row) });
});
