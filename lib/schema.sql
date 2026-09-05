--  lib/schema.sql - the whole database, idempotent so it can be re-applied.
--
--  Applied by `npm run db:init`, never automatically. Serverless functions
--  cold-start concurrently, and half a dozen instances racing to run DDL is a
--  good way to deadlock a fresh deploy; if a table is missing the API says so
--  with a 503 rather than trying to fix it mid-request.

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  name          text        NOT NULL,
  phone         text        NOT NULL DEFAULT '',
  --  Encoded scrypt digest, self-describing: scrypt$N$r$p$salt$hash. Keeping
  --  the parameters beside the hash is what lets them be raised later without
  --  locking out every existing account.
  password      text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  --  Addresses are normalised before every insert and lookup. Asserting it
  --  here means a future code path that forgets fails loudly instead of
  --  quietly creating a second account for the same person.
  CONSTRAINT users_email_lowercased CHECK (email = lower(email)),
  CONSTRAINT users_email_shaped     CHECK (email LIKE '%_@_%._%')
);

--  Opaque random tokens, stored as a SHA-256 digest. A leaked database backup
--  therefore cannot be replayed as a set of live sessions, and revoking one is
--  a DELETE rather than a signing-key rotation that logs everybody out.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    text        PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS enquiries (
  id            bigserial PRIMARY KEY,
  --  Null for a signed-out visitor, and ON DELETE SET NULL rather than CASCADE:
  --  closing an account should not silently delete a question the restaurant
  --  has already answered.
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  name          text        NOT NULL,
  email         text        NOT NULL,
  topic         text        NOT NULL,
  message       text        NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  handled       boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS enquiries_sent_idx ON enquiries (sent_at DESC);

CREATE TABLE IF NOT EXISTS bookings (
  id            bigserial PRIMARY KEY,
  --  Short, unambiguous, and what a guest quotes to find or cancel a booking -
  --  together with the address it was made with, because a reference is an
  --  identifier and not a password. See mayCancel in lib/bookings.mjs.
  reference     text        NOT NULL UNIQUE,
  user_id       bigint      REFERENCES users(id) ON DELETE SET NULL,
  name          text        NOT NULL,
  email         text        NOT NULL,
  phone         text        NOT NULL DEFAULT '',
  party_size    int         NOT NULL CHECK (party_size BETWEEN 1 AND 12),
  slot_start    timestamptz NOT NULL,
  notes         text        NOT NULL DEFAULT '',
  status        text        NOT NULL DEFAULT 'confirmed'
                            CHECK (status IN ('confirmed', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz
);

CREATE INDEX IF NOT EXISTS bookings_slot_idx  ON bookings (slot_start);
CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (lower(email));

--  Occupancy per 30-minute slot, and the reason a double-booking is not
--  possible rather than merely unlikely.
--
--  A 90-minute turn means one booking occupies three consecutive slots, so
--  taking a table is an upsert against three rows. The CHECK is the actual
--  guarantee: two requests that would each fit alone but not together take
--  row locks on the same slot, the second one sees the first one's total, and
--  the constraint rejects it. No advisory lock, no SERIALIZABLE retry loop,
--  and nothing that depends on application code remembering to be careful.
--
--  The ceiling is COVERS_TOTAL in lib/config.mjs. SQL cannot read that
--  constant, so test/unit.test.mjs asserts the two still agree.
CREATE TABLE IF NOT EXISTS slot_load (
  slot_start    timestamptz PRIMARY KEY,
  covers        int         NOT NULL DEFAULT 0
                            CONSTRAINT slot_load_within_capacity
                            CHECK (covers >= 0 AND covers <= 32)
);

--  Windowed counters for login and signup throttling. In-process counters are
--  useless on a serverless host: every cold start gets its own memory, so the
--  limit is only as real as the store behind it.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        text        PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  hits          int         NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);
