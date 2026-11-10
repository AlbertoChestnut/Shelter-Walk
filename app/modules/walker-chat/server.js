// Walker chat: one shared room, realtime via SSE. The only part of the app
// that pushes instead of being polled -- everything else here still works
// the normal request/response way (GET /messages for the initial backlog,
// POST /messages to send), only the "a new message showed up" notice rides
// the stream, so the rest of the app's polling-based design doesn't change.
//
// SSE (not WebSockets) because it's one-directional and that's all this
// needs: the browser's EventSource reconnects on its own, and it's plain
// HTTP -- no new dependency, nothing for Caddy to special-case.
//
// Connected clients live in this module's own memory, same "single Node
// process is the whole deployment" assumption src/modules.js's jobsInFlight
// Set already makes. A message missed while disconnected (a phone asleep, a
// restart) is caught by the next GET /messages on reopen, not replayed.
const MAX_BODY = 1000;
const HISTORY_LIMIT = 50;
const HEARTBEAT_MS = 25000;
// Limits, per account: messages refill at one per 2 seconds with a burst of
// 5, typing notices at most one per 3 seconds, and at most 6 open streams
// (a phone, a computer, spare tabs, one reconnecting after a dropped
// connection) -- 200 streams across everyone.
const MESSAGE_BURST = 5;
const MESSAGE_REFILL_MS = 2000;
const TYPING_GAP_MS = 3000;
const MAX_STREAMS_PER_USER = 6;
const MAX_STREAMS_TOTAL = 200;
// How often open streams are checked against the module's on/off switch.
const ENABLED_CHECK_MS = 2000;

const MIGRATIONS = [{
  id: '001_create_table',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS walker_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
}];

function register(app, ctx) {
  const { db, migrate, requireStaff, enabledGuard } = ctx;
  migrate(MIGRATIONS);
  // Deleting an account deletes its messages too (whether or not the module
  // is switched on right now).
  if (ctx.onAccountDeleted) {
    const forget = db.prepare('DELETE FROM walker_chat_messages WHERE user_id = ?');
    ctx.onAccountDeleted((userId) => forget.run(userId));
  }

  const insert = db.prepare('INSERT INTO walker_chat_messages (user_id, body, created_at) VALUES (?, ?, ?)');
  const selectHistory = db.prepare(`
    SELECT m.id, m.user_id AS userId, u.name AS authorName, m.body, m.created_at AS createdAt
    FROM walker_chat_messages m JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC LIMIT ?
  `);
  const shape = (req, row) => ({
    id: row.id, body: row.body, authorName: row.authorName, createdAt: row.createdAt,
    mine: row.userId === req.me.id
  });

  // Every open EventSource response, so a new message can be pushed to each
  // without them polling. Cleared on disconnect; never persisted.
  const clients = new Set();
  const streamsByUser = new Map(); // user id -> open stream count
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of [...clients]) {
      try { res.write(payload); } catch (err) { res.destroy(); }
    }
  }
  // Switching the module off closes every open stream right away (the
  // browser's reconnect then gets the guard's 404 and stops).
  const isEnabled = ctx.isEnabled || (() => true);
  const enabledCheck = setInterval(() => {
    if (clients.size && !isEnabled()) for (const res of [...clients]) res.end();
  }, ENABLED_CHECK_MS);
  if (enabledCheck.unref) enabledCheck.unref();

  // Token bucket per account for messages; last typing notice per account.
  const buckets = new Map();
  const lastTyping = new Map();
  function takeMessageToken(userId) {
    const now = Date.now();
    const b = buckets.get(userId) || { tokens: MESSAGE_BURST, at: now };
    b.tokens = Math.min(MESSAGE_BURST, b.tokens + (now - b.at) / MESSAGE_REFILL_MS);
    b.at = now;
    buckets.set(userId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  app.get('/api/modules/walker-chat/messages', enabledGuard, (req, res) => {
    const rows = selectHistory.all(HISTORY_LIMIT).reverse();
    res.json({ messages: rows.map((r) => shape(req, r)) });
  });

  app.post('/api/modules/walker-chat/messages', enabledGuard, (req, res) => {
    if (!takeMessageToken(req.me.id)) {
      res.set('Retry-After', String(Math.ceil(MESSAGE_REFILL_MS / 1000)));
      return res.status(429).json({ error: 'Slow down a little: wait a couple of seconds before sending another message.' });
    }
    const body = String((req.body || {}).body || '').trim().slice(0, MAX_BODY);
    if (!body) return res.status(400).json({ error: 'Write something first.' });
    const createdAt = new Date().toISOString();
    const info = insert.run(req.me.id, body, createdAt);
    const row = { id: info.lastInsertRowid, userId: req.me.id, authorName: req.me.name, body, createdAt };
    // Broadcast the same row to every connection, including the sender's own
    // -- the UI has one source of truth for "a message appeared" instead of
    // also optimistically rendering the POST response.
    broadcast('message', { id: row.id, body: row.body, authorName: row.authorName, createdAt: row.createdAt, userId: row.userId });
    res.json({ message: shape(req, row) });
  });

  // Not persisted -- a transient "someone is at the keyboard" signal, just
  // rebroadcast to every other open connection. The client throttles how
  // often it calls this; nothing here needs to, since a dropped/delayed one
  // just means the indicator is a little late. Still capped server-side
  // (TYPING_GAP_MS), so a script can't flood every open stream.
  app.post('/api/modules/walker-chat/typing', enabledGuard, (req, res) => {
    const now = Date.now();
    if (now - (lastTyping.get(req.me.id) || 0) < TYPING_GAP_MS) {
      return res.status(429).json({ error: 'Typing notices are limited to one every 3 seconds.' });
    }
    lastTyping.set(req.me.id, now);
    broadcast('typing', { userId: req.me.id, authorName: req.me.name });
    res.json({ ok: true });
  });

  app.get('/api/modules/walker-chat/stream', enabledGuard, (req, res) => {
    const userId = req.me.id;
    if ((streamsByUser.get(userId) || 0) >= MAX_STREAMS_PER_USER) {
      return res.status(429).json({ error: 'Walker chat is already open in too many tabs. Close one and try again.' });
    }
    if (clients.size >= MAX_STREAMS_TOTAL) {
      return res.status(429).json({ error: 'Walker chat is full right now. Try again in a little while.' });
    }
    streamsByUser.set(userId, (streamsByUser.get(userId) || 0) + 1);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.add(res);
    if (req.socket && req.socket.setKeepAlive) req.socket.setKeepAlive(true, HEARTBEAT_MS);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clients.delete(res);
      const left = (streamsByUser.get(userId) || 1) - 1;
      if (left > 0) streamsByUser.set(userId, left); else streamsByUser.delete(userId);
    };
    // A phone that vanished without closing (wifi dropped, app killed)
    // leaves a half-open stream that would hold one of the per-user slots
    // for many minutes. The heartbeat finds it: a write that errors, or one
    // still stuck in the buffer a whole heartbeat later, drops the stream.
    let stuck = false;
    const drop = () => { done(); if (!res.destroyed) res.destroy(); };
    res.on('drain', () => { stuck = false; });
    const heartbeat = setInterval(() => {
      if (stuck || res.writableEnded || res.destroyed) { drop(); return; }
      try {
        if (!res.write(': ping\n\n', (err) => { if (err) drop(); })) stuck = true;
      } catch (err) { drop(); }
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();
    req.on('close', done);
    res.on('close', done);
    res.on('error', drop);
  });

  // Staff moderation: delete a message for everyone, including anyone
  // already looking at it -- a 'deleted' event removes it from the DOM
  // rather than waiting for a refresh.
  app.delete('/api/modules/walker-chat/messages/:id', requireStaff, enabledGuard, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const info = db.prepare('DELETE FROM walker_chat_messages WHERE id = ?').run(id);
    if (!info.changes) return res.status(404).json({ error: 'No such message.' });
    broadcast('deleted', { id });
    res.json({ ok: true });
  });
}

module.exports = { register };
