/*
 * api/bookings.mjs - one resource, three methods.
 *
 *   POST   /api/bookings                      takes a table
 *   GET    /api/bookings                      the signed-in guest's own
 *   GET    /api/bookings?reference=&email=    one booking, for the lookup form
 *   GET    /api/bookings?date=                staff, one service
 *   DELETE /api/bookings                      cancels, by reference
 *
 * Guests do not have to have an account. A reservation made while signed out
 * carries a null user_id and is found afterwards by reference and address, or
 * by signing up with the same address later - see bookingsForUser.
 */

import { HORIZON_DAYS } from '../lib/config.mjs';
import {
  bookingsForUser,
  bookingsOnDate,
  cancelBooking,
  createBooking,
  findBooking
} from '../lib/bookings.mjs';
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
import { isSeatable, parseDate, parseTime, withinHorizon } from '../lib/slots.mjs';
import {
  checkEmail,
  checkName,
  checkNotes,
  checkParty,
  checkPhone,
  collect
} from '../lib/validate.mjs';

/*
 * Why a booking refused is not always a 422.
 *
 * no_room is the one case where nothing the guest typed was wrong: the last
 * covers went while the page was open. It gets a 409 and a message that says
 * so, because "please check the highlighted fields" would be a lie.
 */
function refuse(res, code) {
  if (code === 'no_room') {
    fail(res, 409, 'no_room', 'That time has just filled up. Please choose another.', {
      time: 'No longer available - pick another time.'
    });
    return;
  }
  if (code === 'past') {
    fail(res, 422, 'invalid', 'That time has already passed.', {
      time: 'Choose a later time.'
    });
    return;
  }
  if (code === 'closed') {
    fail(res, 422, 'invalid', 'We are not seating at that time.', {
      time: 'Choose a time from the list.'
    });
    return;
  }
  /* Six random characters collided four times running. Not impossible, just
     absurd - and a retry from the client is the right answer. */
  fail(res, 503, 'try_again', 'Something went wrong taking that booking. Please try again.');
}

async function create(req, res) {
  if (!requireSameOrigin(req, res)) return;

  const body = await readJson(req, res);
  if (!body) return;
  if (!(await enforce(res, [['bookingIp', clientIp(req)]]))) return;

  const errors = collect();
  const name = checkName(body.name, errors);
  const email = checkEmail(body.email, errors);
  /* Required here, unlike signup: a restaurant with no way to reach a table
     that has not arrived holds it until closing. */
  const phone = checkPhone(body.phone, errors, true);
  const party = checkParty(body.party, errors);
  const notes = checkNotes(body.notes, errors);

  const parsed = parseDate(body.date);
  if (!parsed) errors.set('date', 'Choose a date.');
  else if (!withinHorizon(parsed)) {
    errors.set('date', 'Choose a date within the next ' + HORIZON_DAYS + ' days.');
  }

  const minutes = parsed ? parseTime(parsed, body.time) : null;
  if (parsed && minutes === null) errors.set('time', 'Choose a time from the list.');
  else if (parsed && !isSeatable(parsed, minutes)) {
    errors.set('time', 'We are not seating at that time.');
  }

  if (!errors.ok) {
    fail(res, 422, 'invalid', 'Please check the highlighted fields.', errors.fields);
    return;
  }

  const user = await readSession(req);
  const result = await createBooking({
    parsed: parsed,
    minutes: minutes,
    name: name,
    email: email,
    phone: phone,
    party: party,
    notes: notes,
    userId: user ? user.id : null
  });

  if (!result.ok) {
    refuse(res, result.code);
    return;
  }

  sendJson(res, 201, { booking: result.booking });
}

async function lookup(req, res) {
  const params = searchParams(req);
  const reference = params.get('reference');
  const date = params.get('date');
  const user = await readSession(req);

  if (reference) {
    /* Throttled even though it is a read: a reference is six characters, and
       thirty guesses an hour makes working through them pointless. */
    if (!(await enforce(res, [['lookupIp', clientIp(req)]]))) return;
    const booking = await findBooking({
      reference: reference,
      email: params.get('email'),
      userId: user ? user.id : null,
      isAdmin: user ? user.isAdmin : false
    });
    if (!booking) {
      fail(res, 404, 'not_found', 'We could not find a booking with those details.');
      return;
    }
    sendJson(res, 200, { booking: booking });
    return;
  }

  if (date) {
    /* A whole service is a list of names, addresses and phone numbers. Staff
       only, and a signed-in guest is told it does not exist. */
    if (!(await requireAdmin(req, res))) return;
    const parsed = parseDate(date);
    if (!parsed) {
      fail(res, 400, 'bad_date', 'Ask for a date in YYYY-MM-DD form.');
      return;
    }
    sendJson(res, 200, { date: parsed.date, bookings: await bookingsOnDate(parsed) });
    return;
  }

  if (!user) {
    fail(res, 401, 'not_signed_in', 'Sign in to see your bookings.');
    return;
  }

  sendJson(res, 200, { bookings: await bookingsForUser(user) });
}

async function cancel(req, res) {
  if (!requireSameOrigin(req, res)) return;

  const body = await readJson(req, res);
  if (!body) return;
  if (!(await enforce(res, [['cancelIp', clientIp(req)]]))) return;

  /* A DELETE body is legal and fetch sends it, but a proxy somewhere between
     here and the guest may not forward it. The query string is the fallback,
     not the primary, so a normal client never puts a reference in a URL. */
  const params = searchParams(req);
  const user = await readSession(req);

  const result = await cancelBooking({
    reference: body.reference || params.get('reference'),
    email: body.email || params.get('email'),
    userId: user ? user.id : null,
    isAdmin: user ? user.isAdmin : false
  });

  if (!result.ok) {
    fail(res, 404, 'not_found', 'We could not find a booking with those details.');
    return;
  }

  sendJson(res, 200, { booking: result.booking, already: result.already === true });
}

export default handler(async function bookings(req, res) {
  if (!methodAllowed(req, res, ['GET', 'POST', 'DELETE'])) return;
  if (req.method === 'POST') return create(req, res);
  if (req.method === 'DELETE') return cancel(req, res);
  return lookup(req, res);
});
