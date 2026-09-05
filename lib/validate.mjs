/*
 * lib/validate.mjs - the real gate.
 *
 * main.js validates the same fields in the browser, which is there to give
 * quick, specific feedback. It is not a check: anything can post to these
 * endpoints. So the rules are restated here, deliberately as the same rules -
 * a server that quietly accepts a one-character name the form refused is a
 * form that lies about what it wants.
 *
 * The one place the two differ is upper bounds. The browser has no reason to
 * cap a field it is about to hand to a person; the server caps everything,
 * because a two-megabyte name is not a typo.
 */

import { PARTY_MAX, PARTY_MIN } from './config.mjs';

/* Byte-for-byte the expression in public/assets/js/main.js. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/* The options in contact.html. An enquiry arriving with anything else was not
   sent by the form, so it is corrected to the catch-all rather than trusted. */
export const TOPICS = [
  'Table reservation',
  'Large group or private dining',
  'Dietary requirement',
  'Feedback about a visit',
  'Press or collaboration',
  'Something else'
];

export const LIMITS = {
  name: 80,
  email: 254,
  phone: 32,
  /* Long enough for any real passphrase; short enough that scrypt cannot be
     turned into a way to spend the whole function on one request. */
  password: 200,
  message: 2000,
  notes: 300
};

function text(value) {
  return String(value == null ? '' : value).trim();
}

export function normalizeEmail(value) {
  return text(value).toLowerCase();
}

/* Control characters in a name serve no purpose and make an admin table
   unreadable at best. Written as a code-point scan rather than a character
   class so this file stays plain ASCII, like the rest of the repo. Newlines
   remain legal in the message body, which does not come through here. */
function hasControlChars(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function collect() {
  const fields = {};
  return {
    fields: fields,
    set: function (name, message) {
      if (!fields[name]) fields[name] = message;
    },
    get ok() {
      return Object.keys(fields).length === 0;
    }
  };
}

export function checkName(value, errors, field) {
  const key = field || 'name';
  const name = text(value);
  if (name.length < 2) errors.set(key, 'Enter your full name.');
  else if (name.length > LIMITS.name) errors.set(key, 'That name is too long.');
  else if (hasControlChars(name)) errors.set(key, 'That name contains characters we cannot store.');
  return name;
}

export function checkEmail(value, errors) {
  const email = normalizeEmail(value);
  if (!email) errors.set('email', 'Enter your email address.');
  else if (email.length > LIMITS.email) errors.set('email', 'That email address is too long.');
  else if (!EMAIL_RE.test(email)) errors.set('email', 'Enter a valid email address.');
  return email;
}

export function checkPhone(value, errors, required) {
  const phone = text(value);
  if (!phone) {
    if (required) errors.set('phone', 'Enter a phone number we can reach you on.');
    return '';
  }
  if (phone.length > LIMITS.phone) errors.set('phone', 'That phone number is too long.');
  else if (phone.replace(/\D/g, '').length < 7) {
    /* Offering the empty option back would be a lie where the field is
       required, and a reservation has to have a number on it. */
    errors.set('phone', required
      ? 'Enter at least 7 digits.'
      : 'Enter at least 7 digits, or leave this blank.');
  }
  return phone;
}

export function checkPassword(value, errors) {
  const password = String(value == null ? '' : value);
  if (password.length < 8) {
    errors.set('password', 'Use at least 8 characters.');
  } else if (password.length > LIMITS.password) {
    errors.set('password', 'Use no more than ' + LIMITS.password + ' characters.');
  } else if (
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^\w\s]/.test(password)
  ) {
    errors.set('password', 'Use upper- and lower-case letters, one number and one symbol.');
  }
  return password;
}

export function checkMessage(value, errors) {
  const message = text(value);
  if (message.length < 10) {
    errors.set('message', 'Tell us a little more \u2014 at least 10 characters.');
  } else if (message.length > LIMITS.message) {
    errors.set('message', 'Please keep it under ' + LIMITS.message + ' characters.');
  }
  return message;
}

export function checkTopic(value) {
  const topic = text(value);
  return TOPICS.includes(topic) ? topic : TOPICS[TOPICS.length - 1];
}

export function checkParty(value, errors) {
  const party = Number(value);
  if (!Number.isInteger(party) || party < PARTY_MIN || party > PARTY_MAX) {
    errors.set(
      'party',
      'Choose between ' + PARTY_MIN + ' and ' + PARTY_MAX +
        ' guests, or call us for a larger group.'
    );
    return 0;
  }
  return party;
}

export function checkNotes(value, errors) {
  const notes = text(value);
  if (notes.length > LIMITS.notes) {
    errors.set('notes', 'Please keep the note under ' + LIMITS.notes + ' characters.');
  }
  return notes;
}
