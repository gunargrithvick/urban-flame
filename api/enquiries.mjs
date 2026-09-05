/*
 * api/enquiries.mjs - the contact form's server side.
 *
 *   POST  /api/enquiries  public, saves an enquiry
 *   GET   /api/enquiries  staff, the last hundred
 *   PATCH /api/enquiries  staff, marks one handled
 *
 * A signed-in visitor's enquiry is linked to their account, but the name and
 * address on the record are the ones they typed: someone booking for a parent
 * or writing from work should not have the form silently overwrite them.
 */

import { one, rows } from '../lib/db.mjs';
import {
  clientIp,
  fail,
  handler,
  methodAllowed,
  readJson,
  requireSameOrigin,
  searchParams,
  sendJson
} from '../lib/http.mjs';
import { enforce } from '../lib/ratelimit.mjs';
import { readSession, requireAdmin } from '../lib/sessions.mjs';
import {
  checkEmail,
  checkMessage,
  checkName,
  checkTopic,
  collect
} from '../lib/validate.mjs';

function publicEnquiry(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    topic: row.topic,
    message: row.message,
    sentAt: row.sent_at,
    handled: row.handled === true,
    fromAccount: row.user_id != null
  };
}

async function create(req, res) {
  if (!requireSameOrigin(req, res)) return;

  const body = await readJson(req, res);
  if (!body) return;
  if (!(await enforce(res, [['enquiryIp', clientIp(req)]]))) return;

  const errors = collect();
  const name = checkName(body.name, errors);
  const email = checkEmail(body.email, errors);
  const message = checkMessage(body.message, errors);
  /* Not validated so much as corrected: a topic that is not one of the form's
     options was not sent by the form, and the catch-all is a better home for
     it than a rejection the visitor cannot act on. */
  const topic = checkTopic(body.topic);

  if (!errors.ok) {
    fail(res, 422, 'invalid', 'Please check the highlighted fields.', errors.fields);
    return;
  }

  const user = await readSession(req);
  const row = await one(
    `INSERT INTO enquiries (user_id, name, email, topic, message)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sent_at`,
    [user ? user.id : null, name, email, topic, message]
  );

  sendJson(res, 201, { enquiry: { id: Number(row.id), sentAt: row.sent_at } });
}

async function list(req, res) {
  if (!(await requireAdmin(req, res))) return;

  const onlyOpen = searchParams(req).get('handled') === 'false';
  const found = await rows(
    `SELECT * FROM enquiries
       WHERE ($1::boolean = false OR handled = false)
       ORDER BY sent_at DESC
       LIMIT 100`,
    [onlyOpen]
  );

  sendJson(res, 200, { enquiries: found.map(publicEnquiry) });
}

async function mark(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireAdmin(req, res))) return;

  const body = await readJson(req, res);
  if (!body) return;

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) {
    fail(res, 422, 'invalid', 'Which enquiry?', { id: 'Expected an enquiry id.' });
    return;
  }

  const row = await one(
    'UPDATE enquiries SET handled = $2 WHERE id = $1 RETURNING *',
    [id, body.handled !== false]
  );
  if (!row) {
    fail(res, 404, 'not_found', 'No enquiry with that id.');
    return;
  }

  sendJson(res, 200, { enquiry: publicEnquiry(row) });
}

export default handler(async function enquiries(req, res) {
  if (!methodAllowed(req, res, ['GET', 'POST', 'PATCH'])) return;
  if (req.method === 'POST') return create(req, res);
  if (req.method === 'PATCH') return mark(req, res);
  return list(req, res);
});
