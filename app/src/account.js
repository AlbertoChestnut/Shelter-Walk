// Permanent account deletion, requested by the volunteer themselves.
//
// Order matters, and it is deliberately fail-safe:
//   1. Delete the sign-in account in the login system (Django). If that fails
//      for any reason, NOTHING here has been touched and the volunteer is told
//      the account was not deleted.
//   2. Only then, in one transaction, anonymize the app data:
//        - walks are KEPT (the shelter's records and totals stay accurate) but
//          lose their owner: user_id becomes NULL, so no one can ever be
//          matched to them again;
//        - shared tips they wrote stay on the dogs' boards, unattributed
//          (tips never stored a visible author anyway);
//        - everything personal is deleted: name, email, experience level,
//          notification settings and push subscriptions, saved filters,
//          private notes, an unfinished walk in progress.
// There is no undo, by design.
const http = require('http');

const DJANGO_URL = () => new URL(process.env.DJANGO_INTERNAL_URL || 'http://127.0.0.1:8001');
const TOKEN = () => process.env.INTERNAL_API_TOKEN || '';

// Plain http.request (not fetch) because the login app must be addressed with
// its public Host header even though we talk to it on localhost.
function deleteLoginAccount(email) {
  return new Promise((resolve, reject) => {
    const base = DJANGO_URL();
    const body = JSON.stringify({ email });
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: '/internal/delete-account/',
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN()}`,
        Host: process.env.DJANGO_INTERNAL_HOST || 'login.shelterwalk.com',
        'X-Forwarded-Proto': 'https'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function register(app, { db }) {
  // Shared by both "delete my data" and "delete my account": detach this
  // user's walk history so it can never be matched back to them again. Kept
  // as its own function since the full account deletion needs it as one step
  // among several, while "delete my data" is just this, on its own.
  const wipeWalkData = db.transaction((userId) => {
    // A walk still in progress can't be left behind un-owned: cancel it.
    db.prepare('DELETE FROM walks WHERE user_id = ? AND ended_at IS NULL').run(userId);
    // Completed walks stay -- the shelter's totals and every other
    // volunteer's history are unaffected -- only this user's ownership of
    // them is removed, irreversibly (nothing anywhere records which row
    // used to belong to which user).
    db.prepare('UPDATE walks SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('UPDATE manual_shift_checkoffs SET user_id = NULL WHERE user_id = ?').run(userId);
    // Notes: private ones are personal dog-history and go; shared tips stay
    // on the board, unattributed (0 = nobody) -- they never showed who wrote
    // them anyway.
    db.prepare("DELETE FROM dog_notes WHERE user_id = ? AND visibility = 'private'").run(userId);
    db.prepare('UPDATE dog_notes SET user_id = 0 WHERE user_id = ?').run(userId);
  });

  const anonymize = db.transaction((userId, name) => {
    wipeWalkData(userId);
    db.prepare('DELETE FROM notification_prefs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM saved_filters WHERE user_id = ?').run(userId);
    // Guide sections remember the last editor's name; forget it.
    db.prepare('UPDATE wiki_sections SET updated_by = NULL WHERE updated_by = ?').run(name);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  // "Delete my data, keep my account" (Privacy & Data): the account, sign-in,
  // name, email and settings are untouched -- only the link between this
  // person and any walk they've done is permanently removed. Their personal
  // stats and per-dog history reset to zero as a direct result (they're
  // computed from walks.user_id, which no longer points at them).
  app.delete('/api/me/data', (req, res) => {
    const me = req.me;
    if (!me) return res.status(401).json({ error: 'Not signed in.' });
    if (!req.body || req.body.confirm !== 'DELETE') {
      return res.status(400).json({ error: 'The confirmation was not received, so nothing was deleted.' });
    }
    try {
      wipeWalkData(me.id);
    } catch (err) {
      console.error(`[account] wipe-my-data failed for user ${me.id}:`, err);
      return res.status(500).json({ error: 'Something went wrong, so nothing was deleted. Please try again.' });
    }
    console.warn(`[account] user ${me.id} deleted their walk data; account kept`);
    res.json({ deleted: true });
  });

  app.delete('/api/me', async (req, res) => {
    const me = req.me;
    if (!me) return res.status(401).json({ error: 'Not signed in.' });
    if (!req.body || req.body.confirm !== 'DELETE') {
      return res.status(400).json({ error: 'The confirmation was not received, so nothing was deleted.' });
    }
    if (req.headers['x-auth-staff'] === '1') {
      return res.status(403).json({ error: 'Staff accounts are removed from the staff panel, not here.' });
    }
    const email = String(req.headers['x-auth-email'] || '').trim().toLowerCase();

    let result;
    try {
      result = await deleteLoginAccount(email);
    } catch (err) {
      console.error('[account] could not reach the login system:', err.message);
      return res.status(502).json({ error: "Couldn't reach the sign-in system, so your account was NOT deleted. Please try again in a moment." });
    }
    if (result.status === 403) {
      return res.status(403).json({ error: 'This account cannot be deleted here. Please ask a staff member.' });
    }
    // 404 = the login account is already gone; carry on and finish the cleanup.
    if (result.status !== 200 && result.status !== 404) {
      console.error('[account] login system refused deletion:', result.status);
      return res.status(502).json({ error: 'Your account was NOT deleted because the sign-in system did not confirm. Please try again later.' });
    }

    try {
      anonymize(me.id, me.name);
    } catch (err) {
      // The login is already gone, so the person can no longer get in; the
      // leftover is one orphaned row that a rerun of this same statement set
      // will clean up. Say so loudly so it gets noticed.
      console.error(`[account] login deleted but app cleanup FAILED for user ${me.id}:`, err);
      return res.status(500).json({ error: 'Your sign-in was removed, but finishing the cleanup hit a problem. Staff have been notified in the logs.' });
    }
    console.warn(`[account] user ${me.id} deleted their account; walks kept, unattributed`);
    res.json({ deleted: true });
  });
}

module.exports = { register };
