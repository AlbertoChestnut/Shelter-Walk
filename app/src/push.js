// Web Push sending, shared by server.js (walk-started notices) and
// scraper.js (adoption notices) so both go through one place that knows how
// to look up a user's subscriptions and prune dead ones.
const webpush = require('web-push');
const db = require('./db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@shelterwalk.com';

const enabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set -- push notifications are disabled');
}

const getSubscriptionsForUser = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
const deleteSubscription = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
const getPref = db.prepare('SELECT enabled FROM notification_prefs WHERE user_id = ? AND pref_key = ?');

// Sends to every device this user has subscribed on. A subscription the
// push service reports as gone (404/410 -- the user uninstalled, cleared
// site data, etc) is deleted rather than retried forever.
async function sendPushToUser(userId, payload) {
  if (!enabled) return;
  const subs = getSubscriptionsForUser.all(userId);
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        deleteSubscription.run(sub.id);
      } else {
        console.warn(`[push] failed to send to user ${userId}:`, err.message);
      }
    }
  }
}

function hasPref(userId, prefKey) {
  const row = getPref.get(userId, prefKey);
  return !!(row && row.enabled);
}

module.exports = { sendPushToUser, hasPref, isPushEnabled: () => enabled, VAPID_PUBLIC_KEY };
