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
// "@[id]" in any of them tags another animal (noteTags.js); unknown ones are
// turned back into plain text when saved.
const MAX_TIP = 1000;
const MAX_PRIVATE = 4000;
const MAX_TIPS_PER_DOG = 300;

function register(app, { db, isStaffOrPrivileged, cachedPhotoUrl, noteTags }) {
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
    // tagged: names for the tags in these notes (the app adds the dog's own
    // walk notes, which come with its walks). mentions: notes on other
    // animals that tag this one.
    const walkNotes = db.prepare("SELECT notes FROM walks WHERE dog_id = ? AND notes IS NOT NULL AND notes != ''").all(dogId).map((w) => w.notes);
    const mentions = noteTags.mentionsOf(dogId, userId);
    const tagged = noteTags.namesFor([...sharedTips.map((t) => t.body), priv ? priv.body : '', ...walkNotes, ...mentions.map((m) => m.body)]);
    return { sharedTips, privateNote: priv, tagged, mentions };
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
    // A note left at the end of a session is tagged by what the session
    // actually was -- play group gets its own kind instead of being folded
    // into "walk" (every other activity still reads as a walk here).
    const rows = mine ? db.prepare(`
      SELECT n.dog_id AS dogId, 'private' AS kind, n.id, n.body, n.updated_at AS at
      FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
      WHERE d.still_listed = 1 AND n.visibility = 'private' AND n.user_id = ?
      UNION ALL
      SELECT w.dog_id, CASE w.activity WHEN 'playgroup' THEN 'playgroup' ELSE 'walk' END, NULL, w.notes, w.started_at
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE d.still_listed = 1 AND w.user_id = ? AND w.notes IS NOT NULL AND w.notes != '' AND w.ended_at IS NOT NULL
      ORDER BY at DESC
    `).all(req.me.id, req.me.id) : db.prepare(`
      SELECT n.dog_id AS dogId, CASE n.visibility WHEN 'public' THEN 'tip' ELSE 'private' END AS kind,
             n.id, n.body, CASE n.visibility WHEN 'public' THEN n.created_at ELSE n.updated_at END AS at
      FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
      WHERE d.still_listed = 1 AND (n.visibility = 'public' OR n.user_id = ?)
      UNION ALL
      SELECT w.dog_id, CASE w.activity WHEN 'playgroup' THEN 'playgroup' ELSE 'walk' END, NULL, w.notes, w.started_at
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE d.still_listed = 1 AND w.notes IS NOT NULL AND w.notes != '' AND w.ended_at IS NOT NULL
      ORDER BY at DESC
    `).all(req.me.id);
    // species travels with the dog so the app can word a note by what that
    // dog actually is (a walk vs. a play session), never by the asker's
    // current Settings preference.
    const dogInfo = db.prepare('SELECT shelter_buddy_id AS id, name, species, photo_url AS photoUrl, kennel_location AS kennelLocation, previous_names AS previousNames FROM dogs WHERE shelter_buddy_id = ?');
    const byDog = new Map();
    for (const r of rows) {
      if (!byDog.has(r.dogId)) {
        const dog = dogInfo.get(r.dogId);
        if (cachedPhotoUrl) dog.photoUrl = cachedPhotoUrl(dog.id, dog.photoUrl);
        dog.previousNames = JSON.parse(dog.previousNames || '[]');
        byDog.set(r.dogId, { dog, notes: [] });
      }
      byDog.get(r.dogId).notes.push({ kind: r.kind, id: r.kind === 'tip' ? r.id : undefined, body: r.body, at: r.at });
    }
    res.json({ dogs: Array.from(byDog.values()), tagged: noteTags.namesFor(rows.map((r) => r.body)) });
  });

  app.post('/api/dogs/:id/notes', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    const body = noteTags.clean(cleanText(req.body && req.body.body, MAX_TIP), dogId);
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
    const body = noteTags.clean(cleanText(req.body && req.body.body, MAX_TIP), parseInt(req.params.id, 10));
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

  // The "note for other walkers" left when ending a walk lives on the walk
  // itself, but it's listed with the tips and follows the same whiteboard
  // rules: any walker can reword or clear it. Only the note text is touched;
  // the walk record stays as it was.
  const sharedWalkNote = db.prepare(
    "SELECT id FROM walks WHERE id = ? AND dog_id = ? AND ended_at IS NOT NULL AND notes IS NOT NULL AND notes != ''"
  );
  app.put('/api/dogs/:id/walk-notes/:walkId', (req, res) => {
    const walk = sharedWalkNote.get(parseInt(req.params.walkId, 10), parseInt(req.params.id, 10));
    if (!walk) return res.status(404).json({ error: 'Note not found' });
    const body = noteTags.clean(cleanText(req.body && req.body.body, MAX_TIP), parseInt(req.params.id, 10));
    if (!body) return res.status(400).json({ error: 'A note can\'t be empty. Delete it instead.' });
    db.prepare('UPDATE walks SET notes = ? WHERE id = ?').run(body, walk.id);
    res.json({ id: walk.id });
  });
  app.delete('/api/dogs/:id/walk-notes/:walkId', (req, res) => {
    const walk = sharedWalkNote.get(parseInt(req.params.walkId, 10), parseInt(req.params.id, 10));
    if (!walk) return res.status(404).json({ error: 'Note not found' });
    db.prepare('UPDATE walks SET notes = NULL WHERE id = ?').run(walk.id);
    res.json({ ok: true });
  });

  // Your private note for this dog: replace it, or append (used by the
  // end-of-walk screen). Empty text removes it.
  app.put('/api/dogs/:id/private-note', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    const incoming = noteTags.clean(cleanText(req.body && req.body.body, MAX_PRIVATE), dogId);
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
