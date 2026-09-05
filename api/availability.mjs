/*
 * api/availability.mjs - GET /api/availability?date=YYYY-MM-DD
 *
 * Public, read-only, and the only thing book.html needs to draw its slot grid.
 * The response carries the horizon as well as the day, so the page can set the
 * date input's min and max from the server's rules rather than guessing them.
 */

import { HORIZON_DAYS } from '../lib/config.mjs';
import { fail, handler, methodAllowed, searchParams, sendJson } from '../lib/http.mjs';
import { availabilityFor } from '../lib/bookings.mjs';
import { horizonDates, localDateString, parseDate, withinHorizon } from '../lib/slots.mjs';

export default handler(async function availability(req, res) {
  if (!methodAllowed(req, res, ['GET'])) return;

  const now = new Date();
  const asked = searchParams(req).get('date');
  /* No date means today, which is what a visitor who has just opened the page
     wants to see before touching anything. */
  const parsed = parseDate(asked || localDateString(now));

  if (!parsed) {
    fail(res, 400, 'bad_date', 'Ask for a date in YYYY-MM-DD form.', {
      date: 'Choose a date.'
    });
    return;
  }

  if (!withinHorizon(parsed, now)) {
    fail(
      res,
      422,
      'out_of_range',
      'We take bookings for today and the next ' + HORIZON_DAYS + ' days.',
      { date: 'Choose a date within the next ' + HORIZON_DAYS + ' days.' }
    );
    return;
  }

  const payload = await availabilityFor(parsed, now);
  payload.horizon = horizonDates(now);
  sendJson(res, 200, payload);
});
