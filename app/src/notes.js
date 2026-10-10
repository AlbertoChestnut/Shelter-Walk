// Per-dog notes between walkers.
//
//   Shared tips   a whiteboard: every walker can read, add, edit AND delete
//                 any tip, so the board stays useful and current without
//                 anyone owning it. The author's identity is NEVER returned
//                 (just text and dates), so tips can't be turned into a way
//                 to single someone out.
//   Private note  one per walker per dog, visible ONLY to that walker.
//                 No staff or admin override exists anywhere in this file.
//
// Note text is stored as plain text and always escaped when displayed.
const MAX_TIP = 1000;
const MAX_PRIVATE = 4000;
const MAX_TIPS_PER_DOG = 300;

function register(app, { db, isStaffOrPrivileged, cachedPhotoUrl }) {
  const dogExists = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?');

  // What one walker is allowed to see about one dog's notes.
  function notesFor(dogId, userId) {
    const sharedTips = db.prepare(
      `SELECT id, body, created_at AS createdAt, updated_at AS updatedAt
       FROM dog_notes WHERE dog_id = ? AND visibility = 'public' ORDER BY created_at DESC, id DESC`
    ).all(dogId);
    const priv = db.prepare(
      "SELECT body, updated_at AS updatedAt FROM dog_notes WHERE dog_id = ? AND user_id = ? AND visibility = 'private'"
    ).get(dogId, userId) || null;
    return { sharedTips, privateNote: priv };
  }

  const cleanText = (raw, max) => String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim().slice(0, max);

  app.get('/api/dogs/:id/notes', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    res.json(notesFor(dogId, req.me.id));
  });

  // Every note in one place, for dogs still at the shelter: the shared tips,
  // notes left at the end of walks (shown on each dog's profile already), and
  // the asker's own private notes. Same no-author rule as above. Grouped by
  // dog, the dog with the newest note first.
  //
  // ?scope=mine narrows it to what's the asker's own: their private notes and
  // the notes from their own walks. Shared tips are never in it: they're a
  // whiteboard with no owner, so not even their writer gets them marked.
  app.get('/api/notes', (req, res) => {
    const mine = req.query.scope === 'mine';
    const rows = mine ? db.prepare(`
      SELECT n.dog_id AS dogId, 'private' AS kind, n.id, n.body, n.updated_at AS at
      FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
      WHERE d.still_listed = 1 AND n.visibility = 'private' AND n.user_id = ?
      UNION ALL
      SELECT w.dog_id, 'walk', NULL, w.notes, w.started_at
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE d.still_listed = 1 AND w.user_id = ? AND w.notes IS NOT NULL AND w.notes != '' AND w.ended_at IS NOT NULL
      ORDER BY at DESC
    `).all(req.me.id, req.me.id) : db.prepare(`
      SELECT n.dog_id AS dogId, CASE n.visibility WHEN 'public' THEN 'tip' ELSE 'private' END AS kind,
             n.id, n.body, CASE n.visibility WHEN 'public' THEN n.created_at ELSE n.updated_at END AS at
      FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
      WHERE d.still_listed = 1 AND (n.visibility = 'public' OR n.user_id = ?)
      UNION ALL
      SELECT w.dog_id, 'walk', NULL, w.notes, w.started_at
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE d.still_listed = 1 AND w.notes IS NOT NULL AND w.notes != '' AND w.ended_at IS NOT NULL
      ORDER BY at DESC
    `).all(req.me.id);
    const dogInfo = db.prepare('SELECT shelter_buddy_id AS id, name, photo_url AS photoUrl, kennel_location AS kennelLocation FROM dogs WHERE shelter_buddy_id = ?');
    const byDog = new Map();
    for (const r of rows) {
      if (!byDog.has(r.dogId)) {
        const dog = dogInfo.get(r.dogId);
        if (cachedPhotoUrl) dog.photoUrl = cachedPhotoUrl(dog.id, dog.photoUrl);
        byDog.set(r.dogId, { dog, notes: [] });
      }
      byDog.get(r.dogId).notes.push({ kind: r.kind, id: r.kind === 'tip' ? r.id : undefined, body: r.body, at: r.at });
    }
    res.json({ dogs: Array.from(byDog.values()) });
  });

  app.post('/api/dogs/:id/notes', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    const body = cleanText(req.body && req.body.body, MAX_TIP);
    if (!body) return res.status(400).json({ error: 'Write something to share first.' });
    const count = db.prepare("SELECT COUNT(*) AS c FROM dog_notes WHERE dog_id = ? AND visibility = 'public'").get(dogId).c;
    if (count >= MAX_TIPS_PER_DOG) return res.status(409).json({ error: 'This dog already has a lot of tips. Ask staff to tidy them up.' });
    const now = new Date().toISOString();
    const info = db.prepare(
      "INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (?, ?, 'public', ?, ?, ?)"
    ).run(dogId, req.me.id, body, now, now);
    res.json({ id: info.lastInsertRowid });
  });

  // Whiteboard rules: any walker can edit any shared tip.
  app.put('/api/dogs/:id/notes/:noteId', (req, res) => {
    const note = db.prepare("SELECT id FROM dog_notes WHERE id = ? AND dog_id = ? AND visibility = 'public'")
      .get(parseInt(req.params.noteId, 10), parseInt(req.params.id, 10));
    if (!note) return res.status(404).json({ error: 'Tip not found' });
    const body = cleanText(req.body && req.body.body, MAX_TIP);
    if (!body) return res.status(400).json({ error: 'A tip can\'t be empty. Delete it instead.' });
    db.prepare('UPDATE dog_notes SET body = ?, updated_at = ? WHERE id = ?').run(body, new Date().toISOString(), note.id);
    res.json({ id: note.id });
  });

  // ...and any walker can erase any shared tip (private notes are never
  // reachable through this route: it only matches visibility = 'public').
  app.delete('/api/dogs/:id/notes/:noteId', (req, res) => {
    const note = db.prepare("SELECT id FROM dog_notes WHERE id = ? AND dog_id = ? AND visibility = 'public'")
      .get(parseInt(req.params.noteId, 10), parseInt(req.params.id, 10));
    if (!note) return res.status(404).json({ error: 'Tip not found' });
    db.prepare('DELETE FROM dog_notes WHERE id = ?').run(note.id);
    res.json({ ok: true });
  });

  // Your private note for this dog: replace it, or append (used by the
  // end-of-walk screen). Empty text removes it.
  app.put('/api/dogs/:id/private-note', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    const incoming = cleanText(req.body && req.body.body, MAX_PRIVATE);
    const existing = db.prepare("SELECT id, body FROM dog_notes WHERE dog_id = ? AND user_id = ? AND visibility = 'private'").get(dogId, req.me.id);
    let body = incoming;
    if (req.body && req.body.append && existing && incoming) {
      const stamp = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
      body = `${existing.body}\n\n${stamp}: ${incoming}`.slice(0, MAX_PRIVATE);
    }
    const now = new Date().toISOString();
    if (!body) {
      if (existing) db.prepare('DELETE FROM dog_notes WHERE id = ?').run(existing.id);
      return res.json({ privateNote: null });
    }
    if (existing) db.prepare('UPDATE dog_notes SET body = ?, updated_at = ? WHERE id = ?').run(body, now, existing.id);
    else db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (?, ?, 'private', ?, ?, ?)").run(dogId, req.me.id, body, now, now);
    res.json({ privateNote: { body, updatedAt: now } });
  });

  return { notesFor };
}

module.exports = { register };
