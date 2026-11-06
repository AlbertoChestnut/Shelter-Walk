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

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTE = 200;
const MAX_ALERT_TITLE = 80;
const MAX_ALERT_BODY = 500;

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
  function sendAlert(title, body) {
    const occurredAt = new Date().toISOString();
    const info = db.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('alert', NULL, ?, ?, ?)")
      .run(title, body, occurredAt);
    const recipients = alertRecipientsStmt.all();
    for (const { id } of recipients) {
      push.sendPushToUser(id, {
        title: `📢 ${title}`,
        body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
        url: '/?open=updates',
        page: 'updates',
        tag: `alert-${info.lastInsertRowid}`
      }).catch(() => {});
    }
    return { id: info.lastInsertRowid, occurredAt, pushedTo: recipients.length };
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
      "SELECT id, title, detail AS body, occurred_at AS occurredAt FROM shelter_events WHERE kind = 'alert' ORDER BY occurred_at DESC LIMIT 20"
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
  app.put('/api/staff/schedule/days/:date', requireStaff, (req, res) => {
    const dateKey = DATE_KEY_RE.test(req.params.date) ? req.params.date : null;
    if (!dateKey) return res.status(400).json({ error: 'Pick a date.' });
    if (dateKey < todayKey()) return res.status(400).json({ error: "That date has already passed." });
    const body = req.body || {};
    const mode = ['closed', 'hours', 'note'].includes(body.mode) ? body.mode : null;
    if (!mode) return res.status(400).json({ error: 'Choose closed, different hours, or usual hours with a note.' });
    const note = cleanText(body.note, MAX_NOTE);
    let open = null;
    let close = null;
    if (mode === 'hours') {
      open = parseTime(body.open);
      close = parseTime(body.close);
      if (open == null || close == null) return res.status(400).json({ error: 'Enter the opening and closing times.' });
      if (open >= close) return res.status(400).json({ error: 'Closing time must be after opening time.' });
    }
    if (mode === 'note' && !note) return res.status(400).json({ error: 'Write the note for that day.' });
    db.prepare(`
      INSERT INTO shelter_special_days (date_key, closed, open_minutes, close_minutes, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_key) DO UPDATE SET closed = excluded.closed, open_minutes = excluded.open_minutes,
        close_minutes = excluded.close_minutes, note = excluded.note, updated_at = excluded.updated_at
    `).run(dateKey, mode === 'closed' ? 1 : 0, open, close, note, new Date().toISOString());
    const day = serializeSpecial(specialStmt.get(dateKey));
    let alert = null;
    if (body.notify) {
      const when = dateKey === todayKey() ? 'today' : `on ${day.label}`;
      const title = mode === 'closed' ? `Shelter closed ${when}` : mode === 'hours' ? `Different hours ${when}` : `Heads up for ${when === 'today' ? 'today' : day.label}`;
      const text = [mode === 'closed' ? `No walks ${when === 'today' ? 'today' : 'that day'}.` : mode === 'hours' ? `Walks ${day.hoursLabel}.` : '', note].filter(Boolean).join(' ');
      alert = sendAlert(title, text || title);
    }
    res.json({ day, alert });
  });

  app.delete('/api/staff/schedule/days/:date', requireStaff, (req, res) => {
    const info = db.prepare('DELETE FROM shelter_special_days WHERE date_key = ?').run(String(req.params.date));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---- Staff: shelter alerts ----
  app.post('/api/staff/alerts', requireStaff, (req, res) => {
    const title = cleanText(req.body && req.body.title, MAX_ALERT_TITLE).replace(/\n+/g, ' ');
    const body = cleanText(req.body && req.body.body, MAX_ALERT_BODY);
    if (!title) return res.status(400).json({ error: 'Give the alert a headline.' });
    res.json(sendAlert(title, body || title));
  });

  // Takes it out of the Updates feed. A push already sent can't be unsent.
  app.delete('/api/staff/alerts/:id', requireStaff, (req, res) => {
    const info = db.prepare("DELETE FROM shelter_events WHERE id = ? AND kind = 'alert'").run(parseInt(req.params.id, 10));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
}

module.exports = { register };
