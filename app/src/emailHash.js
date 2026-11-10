// One-way, keyed lookup for sign-in emails.
//
// This app never sends mail and never needs to show an email back to
// anyone (the one place it looked like it might -- the data export --
// reads the live, trusted X-Auth-Email header instead, the same way
// account deletion already did). So there is no reason for its own
// database to hold a reversible copy of anyone's email address at all: a
// stolen or leaked copy of this database file, on its own, is useless for
// building a list of volunteers' emails, only for confirming a guess at
// one specific address someone already has.
//
// EMAIL_HASH_PEPPER must stay exactly the same forever, or every existing
// account stops resolving on its next sign-in. Treat it exactly like
// INTERNAL_API_TOKEN: generate it once (`openssl rand -hex 32`), put it in
// /etc/dogwalk/env, and never change or lose it.
const crypto = require('crypto');

const DEV_PEPPER = 'dev-only-insecure-pepper-do-not-use-in-production';
const PEPPER = process.env.EMAIL_HASH_PEPPER || DEV_PEPPER;
// In production a missing pepper is fatal, not a warning: starting with the
// dev pepper and setting the real one later would change every hash and
// orphan every account.
if (PEPPER === DEV_PEPPER && process.env.NODE_ENV === 'production') {
  throw new Error('[email-hash] EMAIL_HASH_PEPPER is not set. Refusing to start in production without it.');
}

function hashEmail(email) {
  return crypto.createHmac('sha256', PEPPER).update(String(email || '').trim().toLowerCase()).digest('hex');
}

module.exports = { hashEmail };
