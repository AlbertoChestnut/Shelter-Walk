// Shelter hours, closures and shelter alerts, all set by staff from the
// staff dashboard's "Hours & alerts" tab.
//
//   Usual hours   one open/close (or closed) per weekday. A weekday with no
//                 row uses walkHours.js's default window.
//   Special days  a single date that's closed, runs other hours, or just
//                 carries a note (renovations, no volunteers today...). The
//                 app tells volunteers about today's when it opens.
//   Alerts        urgent news from staff. Saved as a shelter_events row of
//                 kind 'alert' so it shows in the Updates feed, and pushed to
//                 everyone who hasn't turned off the shelter_alerts pref
//                 (on by default, unlike the other pushes).
//
// Every write here is staff-only (X-Auth-Staff, the same gate as the rest of
// the staff dashboard). Reading today's hours is open to every signed-in user.
const walkHours = require('./walkHours');
const asyncRoute = require('./asyncRoute');
const { realDateKey } = require('./validate');

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_NOTE = 200;
const MAX_DAY_MESSAGE = 500;
const MAX_ALERT_TITLE = 80;
const MAX_ALERT_BODY = 500;
// How long an alert with no date of its own stays in the Updates feed.
const ALERT_DEFAULT_DAYS = 7;

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 24 * 60 ? minutes : null;
}
const cleanText = (raw, max) => String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim().slice(0, max);

// Calendar arithmetic on YYYY-MM-DD keys (noon UTC dodges DST edges).
function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function dayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
}
function todayKey() {
  return walkHours.walkWindow(new Date()).dateKey;
}

function register(app, { db, push }) {
  const weeklyStmt = db.prepare('SELECT dow, open_minutes, close_minutes, closed FROM shelter_weekly_hours ORDER BY dow');
  const weeklyOneStmt = db.prepare('SELECT open_minutes, close_minutes, closed FROM shelter_weekly_hours WHERE dow = ?');
  const specialStmt = db.prepare('SELECT * FROM shelter_special_days WHERE date_key = ?');
  const specialFromStmt = db.prepare('SELECT * FROM shelter_special_days WHERE date_key >= ? ORDER BY date_key LIMIT ?');

  // What walkHours.js asks for every day: a special day wins over the usual
  // week, and a special day without its own times keeps the weekday's.
  function scheduleFor(dateKey, dow) {
    const week = weeklyOneStmt.get(dow);
    const special = specialStmt.get(dateKey);
    const out = week ? { open: week.open_minutes, close: week.close_minutes, closed: !!week.closed } : {};
    if (special) {
      if (special.closed) out.closed = true;
      else {
        out.closed = false;
        if (special.open_minutes != null) out.open = special.open_minutes;
        if (special.close_minutes != null) out.close = special.close_minutes;
      }
      out.note = special.note;
    }
    return out;
  }
  walkHours.setScheduleSource(scheduleFor);

  // Alerts sent before alerts had an expiry: a day alert's headline names
  // its day ("Shelter closed on Wednesday, Nov 11", "... today"), so read
  // the date back out of it; anything else gets the usual week.
  const DAY_TITLE_RE = /^(?:Shelter closed|Different hours|Heads up for) (?:on )?(.+)$/;
  for (const a of db.prepare("SELECT id, title, occurred_at FROM shelter_events WHERE kind = 'alert' AND expires_at IS NULL").all()) {
    const sentDay = walkHours.walkWindow(new Date(a.occurred_at)).dateKey;
    const m = DAY_TITLE_RE.exec(a.title || '');
    let aboutDate = null;
    if (m && m[1] === 'today') aboutDate = sentDay;
    else if (m) {
      for (let i = 0; i < 400 && !aboutDate; i++) {
        if (dayLabel(addDays(sentDay, i)) === m[1]) aboutDate = addDays(sentDay, i);
      }
    }
    const expiresAt = aboutDate
      ? closingTime(aboutDate)
      : new Date(new Date(a.occurred_at).getTime() + ALERT_DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE shelter_events SET expires_at = ?, about_date = ? WHERE id = ?').run(expiresAt, aboutDate, a.id);
  }

  // One shelter day as the app shows it. `special` means staff set something
  // for this date (closed, other hours, or a note), which is what the app's
  // "heads up" popup keys on.
  function dayInfo(dateKey) {
    const w = walkHours.walkWindow(new Date(`${dateKey}T17:00:00Z`)); // midday Eastern, any season
    const special = specialStmt.get(dateKey);
    return {
      dateKey,
      label: dayLabel(dateKey),
      closed: w.closed,
      opensAt: w.opensAt.toISOString(),
      closesAt: w.closesAt.toISOString(),
      hoursLabel: w.hoursLabel,
      note: w.note,
      message: special ? special.message || '' : '',
      special: !!special
    };
  }

  function weeklyView() {
    const rows = Object.fromEntries(weeklyStmt.all().map((r) => [r.dow, r]));
    return DOW_LABELS.map((label, dow) => {
      const r = rows[dow];
      return {
        dow, label,
        open: hhmm(r ? r.open_minutes : walkHours.OPEN_MINUTES),
        // A time box can't hold 24:00 (the no-limit test window).
        close: hhmm(Math.min(r ? r.close_minutes : walkHours.CLOSE_MINUTES, 24 * 60 - 1)),
        closed: !!(r && r.closed)
      };
    });
  }

  function serializeSpecial(r) {
    return {
      dateKey: r.date_key,
      label: dayLabel(r.date_key),
      closed: !!r.closed,
      open: r.open_minutes == null ? null : hhmm(r.open_minutes),
      close: r.close_minutes == null ? null : hhmm(r.close_minutes),
      note: r.note,
      message: r.message || '',
      hoursLabel: r.closed ? 'Closed' : dayInfo(r.date_key).hoursLabel
    };
  }

  function requireStaff(req, res, next) {
    if (req.headers['x-auth-staff'] !== '1') return res.status(403).json({ error: 'Staff only.' });
    next();
  }

  // Everyone with push on and shelter_alerts not turned off.
  const alertRecipientsStmt = db.prepare(`
    SELECT DISTINCT s.user_id AS id FROM push_subscriptions s
    WHERE NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = s.user_id AND p.pref_key = 'shelter_alerts' AND p.enabled = 0)
  `);
  // When an alert stops being news: a day's alert at that day's closing time
  // (a closed day still uses the hours it would have had), anything else
  // ALERT_DEFAULT_DAYS after it went out, or at the end of the day staff
  // picked to show it until.
  function closingTime(dateKey) {
    const closesAt = walkHours.walkWindow(new Date(`${dateKey}T17:00:00Z`)).closesAt;
    // No walk-hour limit set: "closing" is the end of that day.
    if (closesAt.getUTCFullYear() > 9999) {
      const [y, m, d] = dateKey.split('-').map(Number);
      return walkHours.shelterTimeToDate(y, m, d, 24 * 60 - 1).toISOString();
    }
    return closesAt.toISOString();
  }
  // A day alert sent earlier is retired when its day changes or goes away.
  const retireDayAlertsStmt = db.prepare("UPDATE shelter_events SET expires_at = ? WHERE kind = 'alert' AND about_date = ? AND (expires_at IS NULL OR expires_at > ?)");
  function retireDayAlerts(dateKey) {
    const now = new Date().toISOString();
    retireDayAlertsStmt.run(now, dateKey, now);
  }

  // The end of a shelter day (23:59 shelter time).
  function endOfDay(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return walkHours.shelterTimeToDate(y, m, d, 24 * 60 - 1).toISOString();
  }
  // When an alert sent now expires: a day's alert (or one shown until a
  // date) at that day's closing time -- but never before the end of the
  // shelter day it's sent on, so one sent after closing (hours changed to
  // close early, "show until today" in the evening) still shows (audit 3).
  function alertExpiry(dayKey, nowMs = Date.now()) {
    if (!dayKey) return new Date(nowMs + ALERT_DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const closing = closingTime(dayKey);
    const minimum = endOfDay(walkHours.walkWindow(new Date(nowMs)).dateKey);
    return closing > minimum ? closing : minimum;
  }

  // pushedTo is how many volunteers' phones actually took the push (0 when
  // push is off on this server), not how many have a subscription.
  async function sendAlert(title, body, { aboutDate = null, untilDate = null } = {}) {
    const occurredAt = new Date().toISOString();
    const expiresAt = alertExpiry(aboutDate || untilDate);
    // The push service keeps trying an offline phone only until the alert
    // expires: "Shelter closed today" must not land the next day.
    const ttlSeconds = Math.max(60, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
    const info = db.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at, expires_at, about_date) VALUES ('alert', NULL, ?, ?, ?, ?, ?)")
      .run(title, body, occurredAt, expiresAt, aboutDate);
    const recipients = alertRecipientsStmt.all();
    const sends = await Promise.all(recipients.map(({ id }) => Promise.resolve(push.sendPushToUser(id, {
      title: `📢 ${title}`,
      body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
      url: '/?open=updates',
      page: 'updates',
      tag: `alert-${info.lastInsertRowid}`
    }, { TTL: ttlSeconds })).catch(() => 0)));
    const pushedTo = sends.filter((n) => Number(n) > 0).length;
    return { id: info.lastInsertRowid, occurredAt, expiresAt, pushedTo };
  }

  // ---- Volunteers: today's hours (and anything coming up) ----
  app.get('/api/shelter/today', (req, res) => {
    const today = todayKey();
    const upcoming = specialFromStmt.all(addDays(today, 1), 10)
      .filter((r) => r.date_key <= addDays(today, 7))
      .map((r) => dayInfo(r.date_key));
    res.json({ today: dayInfo(today), upcoming });
  });

  // ---- Staff: the whole schedule ----
  app.get('/api/staff/schedule', requireStaff, (req, res) => {
    const today = todayKey();
    const alerts = db.prepare(
      "SELECT id, title, detail AS body, occurred_at AS occurredAt, expires_at AS expiresAt FROM shelter_events WHERE kind = 'alert' ORDER BY occurred_at DESC LIMIT 20"
    ).all();
    res.json({
      today: dayInfo(today),
      weekly: weeklyView(),
      defaults: { open: hhmm(walkHours.OPEN_MINUTES), close: hhmm(walkHours.CLOSE_MINUTES) },
      specialDays: specialFromStmt.all(today, 200).map(serializeSpecial),
      alerts
    });
  });

  app.put('/api/staff/schedule/weekly', requireStaff, (req, res) => {
    const days = Array.isArray(req.body && req.body.days) ? req.body.days : null;
    if (!days || days.length !== 7) return res.status(400).json({ error: 'Send all 7 days.' });
    const rows = [];
    for (const d of days) {
      const dow = Number(d.dow);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Unknown day of the week.' });
      const open = parseTime(d.open);
      const close = parseTime(d.close);
      if (open == null || close == null) return res.status(400).json({ error: `${DOW_LABELS[dow]}: enter both times.` });
      if (!d.closed && open >= close) return res.status(400).json({ error: `${DOW_LABELS[dow]}: closing time must be after opening time.` });
      rows.push([dow, open, close, d.closed ? 1 : 0]);
    }
    const upsert = db.prepare(`
      INSERT INTO shelter_weekly_hours (dow, open_minutes, close_minutes, closed) VALUES (?, ?, ?, ?)
      ON CONFLICT(dow) DO UPDATE SET open_minutes = excluded.open_minutes, close_minutes = excluded.close_minutes, closed = excluded.closed
    `);
    db.transaction(() => rows.forEach((r) => upsert.run(...r)))();
    res.json({ weekly: weeklyView() });
  });

  // mode: 'closed' | 'hours' (other hours) | 'note' (usual hours + a note)
  app.put('/api/staff/schedule/days/:date', requireStaff, asyncRoute(async (req, res) => {
    // A real calendar date (2026-02-30 and 2026-13-45 aren't), see validate.js.
    const dateKey = realDateKey(req.params.date);
    if (!dateKey) return res.status(400).json({ error: 'Pick a date.' });
    if (dateKey < todayKey()) return res.status(400).json({ error: "That date has already passed." });
    const body = req.body || {};
    const mode = ['closed', 'hours', 'note'].includes(body.mode) ? body.mode : null;
    if (!mode) return res.status(400).json({ error: 'Choose closed, different hours, or usual hours with a note.' });
    const note = cleanText(body.note, MAX_NOTE).replace(/\n+/g, ' ');
    const message = cleanText(body.message, MAX_DAY_MESSAGE);
    let open = null;
    let close = null;
    if (mode === 'hours') {
      open = parseTime(body.open);
      close = parseTime(body.close);
      if (open == null || close == null) return res.status(400).json({ error: 'Enter the opening and closing times.' });
      if (open >= close) return res.status(400).json({ error: 'Closing time must be after opening time.' });
    }
    if (mode === 'note' && !note && !message) return res.status(400).json({ error: 'Write the note for that day.' });
    // What the day was before this save (closed? which hours?), to tell a
    // real change from a fixed typo in the note or message.
    const before = dayInfo(dateKey);
    const beforeRow = specialStmt.get(dateKey) || {};
    db.prepare(`
      INSERT INTO shelter_special_days (date_key, closed, open_minutes, close_minutes, note, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_key) DO UPDATE SET closed = excluded.closed, open_minutes = excluded.open_minutes,
        close_minutes = excluded.close_minutes, note = excluded.note, message = excluded.message, updated_at = excluded.updated_at
    `).run(dateKey, mode === 'closed' ? 1 : 0, open, close, note, message, new Date().toISOString());
    const day = serializeSpecial(specialStmt.get(dateKey));
    let alert = null;
    // An earlier alert about this day is retired when what it said may no
    // longer be true (closed, or the hours, changed) or a new one replaces
    // it -- not for a reworded note or message (audit 3).
    const after = dayInfo(dateKey);
    const rowChanged = !!beforeRow.closed !== (mode === 'closed') || (beforeRow.open_minutes ?? null) !== open || (beforeRow.close_minutes ?? null) !== close;
    if (body.notify || rowChanged || before.closed !== after.closed || before.opensAt !== after.opensAt || before.closesAt !== after.closesAt) {
      retireDayAlerts(dateKey);
    }
    if (body.notify) {
      const when = dateKey === todayKey() ? 'today' : `on ${day.label}`;
      const title = mode === 'closed' ? `Shelter closed ${when}` : mode === 'hours' ? `Different hours ${when}` : `Heads up for ${when === 'today' ? 'today' : day.label}`;
      const text = [mode === 'closed' ? `No walks ${when === 'today' ? 'today' : 'that day'}.` : mode === 'hours' ? `Walks ${day.hoursLabel}.` : '', note].filter(Boolean).join(' ');
      alert = await sendAlert(title, [text, message].filter(Boolean).join('\n\n') || title, { aboutDate: dateKey });
    }
    res.json({ day, alert });
  }));

  app.delete('/api/staff/schedule/days/:date', requireStaff, (req, res) => {
    const dateKey = String(req.params.date);
    const info = db.prepare('DELETE FROM shelter_special_days WHERE date_key = ?').run(dateKey);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    retireDayAlerts(String(req.params.date));
    res.json({ ok: true });
  });

  // ---- Staff: shelter alerts ----
  app.post('/api/staff/alerts', requireStaff, asyncRoute(async (req, res) => {
    const title = cleanText(req.body && req.body.title, MAX_ALERT_TITLE).replace(/\n+/g, ' ');
    const body = cleanText(req.body && req.body.body, MAX_ALERT_BODY);
    if (!title) return res.status(400).json({ error: 'Give the alert a headline.' });
    const until = req.body && req.body.until ? String(req.body.until) : null;
    if (until && (!realDateKey(until) || until < todayKey())) return res.status(400).json({ error: 'Pick a "show until" date from today on.' });
    res.json(await sendAlert(title, body || title, { untilDate: until }));
  }));

  // Takes it out of the Updates feed. A push already sent can't be unsent.
  app.delete('/api/staff/alerts/:id', requireStaff, (req, res) => {
    const info = db.prepare("DELETE FROM shelter_events WHERE id = ? AND kind = 'alert'").run(parseInt(req.params.id, 10));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
}

module.exports = { register };
