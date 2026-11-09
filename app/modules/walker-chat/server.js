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
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  app.get('/api/modules/walker-chat/messages', enabledGuard, (req, res) => {
    const rows = selectHistory.all(HISTORY_LIMIT).reverse();
    res.json({ messages: rows.map((r) => shape(req, r)) });
  });

  app.post('/api/modules/walker-chat/messages', enabledGuard, (req, res) => {
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
  // just means the indicator is a little late.
  app.post('/api/modules/walker-chat/typing', enabledGuard, (req, res) => {
    broadcast('typing', { userId: req.me.id, authorName: req.me.name });
    res.json({ ok: true });
  });

  app.get('/api/modules/walker-chat/stream', enabledGuard, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
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
