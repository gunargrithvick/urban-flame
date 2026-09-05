/*
 * api/health.mjs - GET /api/health
 *
 * The one endpoint the client calls before it trusts any of the others. Its
 * whole job is to answer "is there a working backend here", because this site
 * is built to run without one: main.js keeps a localStorage implementation of
 * every feature and uses it whenever this says no.
 *
 * It therefore must not fail. An unreachable database is a 200 with db:false,
 * not a 503 - the caller is asking a question, and "no" is an answer.
 */

import { TZ_LABEL, hasDatabase } from '../lib/config.mjs';
import { isMissingSchema, one } from '../lib/db.mjs';
import { handler, methodAllowed, sendJson } from '../lib/http.mjs';

export default handler(async function health(req, res) {
  if (!methodAllowed(req, res, ['GET', 'HEAD'])) return;

  const state = {
    ok: true,
    db: false,
    schema: false,
    timezone: TZ_LABEL,
    time: new Date().toISOString()
  };

  if (hasDatabase()) {
    try {
      /* Cheapest statement that proves both halves at once: it reaches the
         server and it finds the schema. LIMIT 1 with no predicate touches one
         page at most, and never returns a row's contents. */
      await one('SELECT 1 FROM users LIMIT 1');
      state.db = true;
      state.schema = true;
    } catch (error) {
      /* Connected but not migrated is worth distinguishing: the deploy is
         nearly right and `npm run db:init` finishes it. */
      if (isMissingSchema(error)) state.db = true;
      else state.reason = 'unreachable';
    }
  }

  sendJson(res, 200, state);
});
