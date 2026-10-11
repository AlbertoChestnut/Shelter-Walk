// Feedback and bug reports from My Account.
//
//   Anonymous     the feedback table has no user column and nothing here
//                 ever records who sent a report, so the inbox can't single
//                 anyone out (same rule as shared tips in notes.js).
//   Device info   the browser's user agent, saved only when the sender ticks
//                 the box (useful for bug reports, never required).
//   Inbox         staff and privileged accounts can read, resolve and delete.
//                 Privileged accounts also get a push for each new report.
//
// Report text is stored as plain text and always escaped when displayed.
const MAX_BODY = 2000;
const MAX_DEVICE = 300;
const KINDS = ['bug', 'idea', 'other'];
const KIND_LABELS = { bug: '🐞 Bug report', idea: '💡 Idea', other: '💬 Feedback' };
// Per sender, kept in memory only (so it never becomes a stored link
// between a person and a report): enough for real use, not for spam.
const MAX_PER_HOUR = 5;

function register(app, { db, isStaffOrPrivileged, push }) {
  const recentSends = new Map(); // user id -> send timestamps in the last hour

  const cleanText = (raw, max) => String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim().slice(0, max);

  app.post('/api/feedback', (req, res) => {
    const body = req.body || {};
    const kind = KINDS.includes(body.kind) ? body.kind : null;
    if (!kind) return res.status(400).json({ error: 'Pick bug, idea or other.' });
    const text = cleanText(body.body, MAX_BODY);
    if (!text) return res.status(400).json({ error: 'Write something first.' });

    const now = Date.now();
    const sends = (recentSends.get(req.me.id) || []).filter((t) => now - t < 3600 * 1000);
    if (sends.length >= MAX_PER_HOUR) return res.status(429).json({ error: 'Thanks! That\'s a lot of reports for one hour. Try again a bit later.' });
    sends.push(now);
    recentSends.set(req.me.id, sends);

    const device = body.includeDevice ? cleanText(req.headers['user-agent'], MAX_DEVICE) || null : null;
    db.prepare('INSERT INTO feedback (kind, body, device, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, text, device, new Date(now).toISOString());

    for (const { id } of db.prepare('SELECT id FROM users WHERE is_privileged = 1').all()) {
      push.sendPushToUser(id, {
        title: KIND_LABELS[kind],
        body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
        url: '/?open=feedback',
        page: 'feedback',
        tag: 'feedback'
      }).catch(() => {});
    }
    res.json({ ok: true });
  });

  const requireInbox = (req, res) => {
    if (isStaffOrPrivileged(req, req.me)) return true;
    res.status(403).json({ error: 'Only staff can read feedback.' });
    return false;
  };

  app.get('/api/feedback', (req, res) => {
    if (!requireInbox(req, res)) return;
    const items = db.prepare(
      `SELECT id, kind, body, device, created_at AS createdAt, resolved_at AS resolvedAt
       FROM feedback ORDER BY resolved_at IS NOT NULL, created_at DESC LIMIT 300`
    ).all();
    res.json({ items });
  });

  app.put('/api/feedback/:id', (req, res) => {
    if (!requireInbox(req, res)) return;
    const resolved = !!(req.body && req.body.resolved);
    const info = db.prepare('UPDATE feedback SET resolved_at = ? WHERE id = ?')
      .run(resolved ? new Date().toISOString() : null, parseInt(req.params.id, 10));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  app.delete('/api/feedback/:id', (req, res) => {
    if (!requireInbox(req, res)) return;
    const info = db.prepare('DELETE FROM feedback WHERE id = ?').run(parseInt(req.params.id, 10));
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
}

module.exports = { register };
