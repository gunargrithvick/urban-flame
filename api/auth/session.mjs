/*
 * api/auth/session.mjs - the session as a resource.
 *
 *   GET    /api/auth/session  -> { user } or { user: null }
 *   DELETE /api/auth/session  -> { ok: true }, and the cookie is gone
 *
 * One file rather than /me and /logout: reading and ending the same thing are
 * two methods on it, and a serverless deployment counts functions.
 */

import { handler, methodAllowed, requireSameOrigin, sendJson } from '../../lib/http.mjs';
import { endSession, readSession } from '../../lib/sessions.mjs';

export default handler(async function session(req, res) {
  if (!methodAllowed(req, res, ['GET', 'DELETE'])) return;

  if (req.method === 'DELETE') {
    /* Signing out changes state, so it is held to the same origin check as
       every other write. A forged sign-out is only a nuisance, but it is a
       nuisance with no upside. */
    if (!requireSameOrigin(req, res)) return;
    await endSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  /* An expired or unknown cookie is answered with user:null rather than a 401.
     The client asks this on every page load to decide what to draw in the
     header; not being signed in is a normal answer, not an error. */
  sendJson(res, 200, { user: await readSession(req) });
});
