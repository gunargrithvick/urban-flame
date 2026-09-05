/*
 * lib/slots.mjs - service hours, slot arithmetic, and the overlap rule.
 *
 * No timezone database and no date library. Restaurant-local time is a fixed
 * +05:30 from UTC (see config.mjs), so a slot is midnight-local plus a number
 * of minutes, and adding minutes to an instant is exact. Minutes past 1440
 * are the same service running past midnight, which is how Friday closing at
 * 00:30 stays on Friday's books instead of turning into a Saturday lunch.
 */

import {
  HORIZON_DAYS,
  SERVICE_CLOSE_MINUTES,
  SERVICE_OPEN_MINUTES,
  SLOT_MINUTES,
  TURN_MINUTES,
  TZ_OFFSET
} from './config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/* How many 30-minute slots one 90-minute turn occupies. */
export const SLOTS_PER_TURN = Math.ceil(TURN_MINUTES / SLOT_MINUTES);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/*
 * Accepts only a real calendar date in YYYY-MM-DD.
 *
 * Date.parse is not enough on its own: it happily rolls 2026-02-30 forward to
 * 2 March, which would let a guest book a table on a day that does not exist
 * and then be unable to find it again. Round-tripping the parsed value back to
 * a string is what catches that.
 */
export function parseDate(value) {
  const match = DATE_RE.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const midnight = new Date(match[0] + 'T00:00:00' + TZ_OFFSET);
  if (Number.isNaN(midnight.getTime())) return null;
  if (localDateString(midnight) !== match[0]) return null;
  return { date: match[0], midnight: midnight };
}

/* The calendar date an instant falls on in restaurant-local time. Shifting by
   the offset and then reading the UTC fields is the whole trick. */
export function localDateString(instant) {
  const shifted = new Date(instant.getTime() + offsetMinutes() * 60000);
  return shifted.toISOString().slice(0, 10);
}

/* Minutes past local midnight, by the same shift. Always 0..1439: this is
   wall-clock time, not the past-midnight slot arithmetic above. */
export function localMinutesOf(instant) {
  const shifted = new Date(instant.getTime() + offsetMinutes() * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function localTimeString(instant) {
  return formatTime(localMinutesOf(instant));
}

/*
 * The service date a stored instant belongs to, which is not always its
 * calendar date.
 *
 * A Friday table at 00:30 is Saturday by the clock and Friday to the kitchen.
 * Anything before opening belongs to the night before, so a guest who booked
 * from Friday's list is shown Friday, and the pass for Friday service lists
 * everyone it will actually serve.
 */
export function serviceDateOf(instant) {
  if (localMinutesOf(instant) >= SERVICE_OPEN_MINUTES) return localDateString(instant);
  return localDateString(new Date(instant.getTime() - DAY_MS));
}

/* True when the clock time lands on the calendar day after its service date -
   the only case a confirmation has to spell out. */
export function isAfterMidnight(instant) {
  return localMinutesOf(instant) < SERVICE_OPEN_MINUTES;
}

function offsetMinutes() {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(TZ_OFFSET);
  if (!match) return 0;
  const size = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -size : size;
}

/* getDay() of the service date. Read at local noon so the answer cannot be
   pushed onto the neighbouring day by the offset. */
export function weekdayOf(parsed) {
  return new Date(parsed.midnight.getTime() + 12 * 60 * 60 * 1000).getUTCDay();
}

export function closeMinutes(parsed) {
  return SERVICE_CLOSE_MINUTES[weekdayOf(parsed)];
}

export function lastSeatingMinutes(parsed) {
  return closeMinutes(parsed) - TURN_MINUTES;
}

/* Minutes past local midnight -> the exact instant, rolling into the next day
   on its own when the service does. */
export function instantAt(parsed, minutes) {
  return new Date(parsed.midnight.getTime() + minutes * 60000);
}

export function formatTime(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return hh + ':' + mm;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/*
 * Parses a booking time against a specific date.
 *
 * A clock time is ambiguous for Friday and Saturday: 00:30 could be half an
 * hour after midnight on the way into the service, or the end of it. Anything
 * before opening is read as the late end of the same service, which is the
 * only reading that can actually be booked.
 */
export function parseTime(parsed, value) {
  const match = TIME_RE.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  let minutes = hours * 60 + mins;
  if (minutes < SERVICE_OPEN_MINUTES) minutes += 1440;
  if (minutes % SLOT_MINUTES !== 0) return null;
  return minutes;
}

export function slotMinutesFor(parsed) {
  const out = [];
  const last = lastSeatingMinutes(parsed);
  for (let minutes = SERVICE_OPEN_MINUTES; minutes <= last; minutes += SLOT_MINUTES) {
    out.push(minutes);
  }
  return out;
}

/*
 * Every slot a booking holds. A 19:00 table for a 90-minute turn takes 19:00,
 * 19:30 and 20:00, so all three have to have room - checking only the arrival
 * slot is how a dining room ends up triple-booked at 20:00.
 */
export function occupiedInstants(parsed, minutes) {
  return occupiedFrom(instantAt(parsed, minutes));
}

/* The same three slots, from a stored instant rather than a date and a minute
   count - which is what releasing a cancelled table has to work from. Adding
   minutes to an instant needs no calendar at all. */
export function occupiedFrom(instant) {
  const out = [];
  for (let step = 0; step < SLOTS_PER_TURN; step += 1) {
    out.push(new Date(instant.getTime() + step * SLOT_MINUTES * 60000));
  }
  return out;
}

export function withinHorizon(parsed, now) {
  const today = localDateString(now || new Date());
  if (parsed.date < today) return false;
  const limit = new Date((now || new Date()).getTime() + HORIZON_DAYS * DAY_MS);
  return parsed.date <= localDateString(limit);
}

export function isSeatable(parsed, minutes) {
  if (minutes < SERVICE_OPEN_MINUTES) return false;
  if (minutes > lastSeatingMinutes(parsed)) return false;
  return minutes % SLOT_MINUTES === 0;
}

export function horizonDates(now) {
  const start = now || new Date();
  return {
    first: localDateString(start),
    last: localDateString(new Date(start.getTime() + HORIZON_DAYS * DAY_MS))
  };
}
