/*
 * lib/bookings.mjs - availability, taking a table, and giving it back.
 *
 * The interesting part is that capacity is enforced by a CHECK constraint on
 * slot_load rather than by anything in this file. A 90-minute turn over
 * 30-minute slots means one booking claims three consecutive rows, and two
 * requests that would each fit alone but not together end up serialised on the
 * same row lock: the second one adds to a total that already includes the
 * first, and the constraint rejects it. The rollback takes the booking row with
 * it, so there is no half-written reservation to clean up.
 *
 * That is why there is no advisory lock, no SELECT ... FOR UPDATE dance across
 * the whole day, and no retry loop hoping for a better outcome next time.
 */

import { randomInt } from 'node:crypto';
import {
  COVERS_TOTAL,
  SERVICE_OPEN_MINUTES,
  SLOT_MINUTES,
  TURN_MINUTES,
  TZ_LABEL
} from './config.mjs';
import { isDuplicate, isOverCapacity, one, rows, transaction } from './db.mjs';
import {
  closeMinutes,
  formatTime,
  instantAt,
  isAfterMidnight,
  isSeatable,
  lastSeatingMinutes,
  localTimeString,
  occupiedFrom,
  occupiedInstants,
  serviceDateOf,
  slotMinutesFor
} from './slots.mjs';

/* No 0/O and no 1/I/L: a reference gets read down a phone line and written on
   a paper pass, and those are the characters that come back wrong. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function makeReference() {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += REFERENCE_ALPHABET[randomInt(0, REFERENCE_ALPHABET.length)];
  }
  return 'UF-' + out;
}

export function normalizeReference(value) {
  const cleaned = String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  /* Two readings and only two: the eight-character form with its prefix, or
     the six-character body alone. Stripping a leading "UF" from anything of
     any length would mangle the one reference in a thousand whose body happens
     to begin with those two letters. */
  if (cleaned.length === 8 && cleaned.startsWith('UF')) return 'UF-' + cleaned.slice(2);
  if (cleaned.length === 6) return 'UF-' + cleaned;
  return '';
}

/* One query for the whole service, keyed by instant. Reading slot by slot
   would be twenty-three round trips to answer one page load. */
async function loadBetween(from, to) {
  const found = await rows(
    'SELECT slot_start, covers FROM slot_load WHERE slot_start >= $1 AND slot_start <= $2',
    [from, to]
  );
  const loads = new Map();
  for (const row of found) {
    loads.set(new Date(row.slot_start).getTime(), Number(row.covers));
  }
  return loads;
}

/*
 * Seats left for a party arriving at this slot.
 *
 * The peak across the three slots the turn would occupy, not the arrival slot
 * alone: a table free at 19:00 is no use to anyone if 20:00 is already full,
 * because the same guests are still sitting at it.
 */
function seatsLeft(loads, parsed, minutes) {
  let peak = 0;
  for (const instant of occupiedInstants(parsed, minutes)) {
    const used = loads.get(instant.getTime()) || 0;
    if (used > peak) peak = used;
  }
  const left = COVERS_TOTAL - peak;
  return left > 0 ? left : 0;
}

export async function availabilityFor(parsed, now) {
  const at = now || new Date();
  const loads = await loadBetween(
    instantAt(parsed, SERVICE_OPEN_MINUTES),
    instantAt(parsed, closeMinutes(parsed))
  );

  const slots = [];
  for (const minutes of slotMinutesFor(parsed)) {
    /* A slot in the past is not a slot. Today's list therefore shortens as the
       evening goes on, and is empty once the last seating has gone. */
    if (instantAt(parsed, minutes).getTime() <= at.getTime()) continue;
    slots.push({
      time: formatTime(minutes),
      seats: seatsLeft(loads, parsed, minutes),
      afterMidnight: minutes >= 1440
    });
  }

  return {
    date: parsed.date,
    timezone: TZ_LABEL,
    covers: COVERS_TOTAL,
    slotMinutes: SLOT_MINUTES,
    turnMinutes: TURN_MINUTES,
    opens: formatTime(SERVICE_OPEN_MINUTES),
    lastSeating: formatTime(lastSeatingMinutes(parsed)),
    slots: slots
  };
}

/*
 * A row as the client sees it.
 *
 * date is the service date, not the calendar date: a Friday table at 00:30 is
 * Friday's booking and Saturday's clock, and telling a guest "Saturday" for a
 * table they booked from Friday's list is how someone arrives a day late.
 * afterMidnight is the flag that lets the page say so out loud.
 */
export function publicBooking(row) {
  const slot = new Date(row.slot_start);
  return {
    reference: row.reference,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    party: Number(row.party_size),
    date: serviceDateOf(slot),
    time: localTimeString(slot),
    afterMidnight: isAfterMidnight(slot),
    notes: row.notes || '',
    status: row.status,
    createdAt: row.created_at,
    turnMinutes: TURN_MINUTES
  };
}

async function attemptBooking(input) {
  const slot = instantAt(input.parsed, input.minutes);
  const reference = makeReference();

  return transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO bookings
              (reference, user_id, name, email, phone, party_size, slot_start, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
      [
        reference,
        input.userId || null,
        input.name,
        input.email,
        input.phone || '',
        input.party,
        slot,
        input.notes || ''
      ]
    );

    /* Ascending order matters: two bookings that share slots then take the row
       locks in the same sequence and cannot deadlock each other. */
    for (const instant of occupiedInstants(input.parsed, input.minutes)) {
      await tx.query(
        `INSERT INTO slot_load (slot_start, covers)
              VALUES ($1, $2)
         ON CONFLICT (slot_start)
         DO UPDATE SET covers = slot_load.covers + $2`,
        [instant, input.party]
      );
    }

    return inserted.rows[0];
  });
}

export async function createBooking(input) {
  const at = input.now || new Date();
  if (!isSeatable(input.parsed, input.minutes)) return { ok: false, code: 'closed' };
  if (instantAt(input.parsed, input.minutes).getTime() <= at.getTime()) {
    return { ok: false, code: 'past' };
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return { ok: true, booking: publicBooking(await attemptBooking(input)) };
    } catch (error) {
      /* The dining room filled up between rendering the page and pressing the
         button. Not an error at our end, and the client says so gently. */
      if (isOverCapacity(error)) return { ok: false, code: 'no_room' };
      /* The only unique index this transaction can touch is the reference, so
         a duplicate means the generator collided. Draw again. */
      if (isDuplicate(error) && attempt < 3) continue;
      throw error;
    }
  }

  return { ok: false, code: 'no_reference' };
}

/*
 * Who is allowed to cancel.
 *
 * A reference on its own is not authority: the address it was booked with has
 * to match, or the request has to come from the account that made it, or from
 * staff. Everything that fails this is reported as not_found, so a guessed
 * reference cannot even be confirmed to exist.
 */
function mayCancel(row, input) {
  if (input.isAdmin) return true;
  if (input.userId && String(row.user_id) === String(input.userId)) return true;
  const asked = String(input.email || '').trim().toLowerCase();
  return asked !== '' && asked === String(row.email || '').toLowerCase();
}

export async function cancelBooking(input) {
  const reference = normalizeReference(input.reference);
  if (!reference) return { ok: false, code: 'not_found' };

  return transaction(async (tx) => {
    /* FOR UPDATE so two cancels of the same booking cannot both pass the
       status check and release the covers twice. */
    const found = await tx.query('SELECT * FROM bookings WHERE reference = $1 FOR UPDATE', [
      reference
    ]);
    const row = found.rows[0];
    if (!row || !mayCancel(row, input)) return { ok: false, code: 'not_found' };
    if (row.status !== 'confirmed') {
      return { ok: true, booking: publicBooking(row), already: true };
    }

    const updated = await tx.query(
      `UPDATE bookings
          SET status = 'cancelled', cancelled_at = now()
        WHERE id = $1
    RETURNING *`,
      [row.id]
    );

    /* GREATEST rather than a bare subtraction: if a row were ever left lower
       than this booking's covers, the arithmetic would go negative and trip
       the same constraint on the way down, refusing a cancellation. */
    for (const instant of occupiedFrom(new Date(row.slot_start))) {
      await tx.query(
        'UPDATE slot_load SET covers = GREATEST(covers - $2, 0) WHERE slot_start = $1',
        [instant, row.party_size]
      );
    }

    return { ok: true, booking: publicBooking(updated.rows[0]) };
  });
}

/*
 * A guest's own bookings, matched on the account or on the address.
 *
 * The address clause is what lets somebody who booked as a guest and signed up
 * afterwards still find the table: the reservation was made before the account
 * existed, so user_id on that row is null and always will be.
 */
export async function bookingsForUser(user) {
  const found = await rows(
    `SELECT * FROM bookings
       WHERE user_id = $1 OR lower(email) = $2
       ORDER BY slot_start DESC
       LIMIT 50`,
    [user.id, String(user.email || '').toLowerCase()]
  );
  return found.map(publicBooking);
}

/*
 * A single booking, for the "find my reservation" form.
 *
 * Guarded by the same test as cancelling, for the same reason: the reference is
 * an identifier, not a credential. Without a matching address, an account or
 * staff access, this is indistinguishable from a reference that never existed.
 */
export async function findBooking(input) {
  const reference = normalizeReference(input.reference);
  if (!reference) return null;
  const row = await one('SELECT * FROM bookings WHERE reference = $1', [reference]);
  if (!row || !mayCancel(row, input)) return null;
  return publicBooking(row);
}

/*
 * One service, for the pass.
 *
 * The window is the service day's own open-to-close, so Friday's list includes
 * the 00:30 table that the calendar calls Saturday. That is the whole reason
 * closing times are stored as minutes that can exceed 1440.
 */
export async function bookingsOnDate(parsed) {
  const found = await rows(
    `SELECT * FROM bookings
       WHERE slot_start >= $1 AND slot_start <= $2
       ORDER BY slot_start ASC, created_at ASC`,
    [instantAt(parsed, SERVICE_OPEN_MINUTES), instantAt(parsed, closeMinutes(parsed))]
  );
  return found.map(publicBooking);
}
