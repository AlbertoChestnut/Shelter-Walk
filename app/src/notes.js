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
// Same cap for the note left at the end of a walk (server.js checks it on save).
const MAX_WALK_NOTE = MAX_TIP;
const crypto = require('crypto');
const { noteDay } = require('./noteTags');
const { SHELTER_TZ } = require('./constants');

const shelterDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SHELTER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const shelterDate = (iso) => shelterDateFmt.format(new Date(iso));

// Opaque ids for notes: an HMAC of the row id under a secret kept in the
// database (the same across restarts, but it can't be turned back into the
// row id or compared with another). opaqueIds(db)(kind) -> (rowId) -> id.
// findByOpaqueId picks the row whose id matches, in constant time.
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
function opaqueIds(db) {
  let secret = db.prepare("SELECT value FROM app_meta WHERE key = 'walk_note_secret'").get();
  if (!secret) {
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('walk_note_secret', ?)").run(crypto.randomBytes(32).toString('hex'));
    secret = db.prepare("SELECT value FROM app_meta WHERE key = 'walk_note_secret'").get();
  }
  return (kind) => (rowId) => crypto.createHmac('sha256', secret.value).update(`${kind}:${rowId}`).digest('base64url').slice(0, 22);
}
function findByOpaqueId(rows, idOf, raw) {
  const want = String(raw || '');
  if (!OPAQUE_ID_RE.test(want)) return null;
  const wantBuf = Buffer.from(want);
  return rows.find((r) => crypto.timingSafeEqual(Buffer.from(idOf(r.id)), wantBuf)) || null;
}

function register(app, { db, isStaffOrPrivileged, cachedPhotoUrl, noteTags }) {
  const dogExists = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?');

  // A walk note is named by an opaque id, never its walk's id: walk ids are
  // global and only go up, so a volunteer's own walk ids would box in when
  // (and so by whom) a note was written. The id is an HMAC of the walk id
  // with a secret kept in the database, so it stays the same across restarts
  // but can't be turned back into the walk id or compared with another.
  const noteIdOf = opaqueIds(db)('walk-note');
  // Shared tips get the same kind of id: theirs go up too, so your own tips
  // would bracket everyone else's and undo their date-only times.
  const tipIdOf = opaqueIds(db)('tip');

  // One dog's end-of-walk notes as their own list: opaque id, text, shelter
  // date and what kind of session it was. Never joined to a walk row, a time
  // or a walker, and ordered by date then text, not by when they happened.
  const notedWalks = db.prepare("SELECT id, started_at, activity, notes FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL AND notes IS NOT NULL AND notes != ''");
  const byDateThenText = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.text.localeCompare(b.text));
  function walkNotesFor(dogId) {
    return notedWalks.all(dogId)
      .map((w) => ({ noteId: noteIdOf(w.id), text: w.notes, date: shelterDate(w.started_at), activity: w.activity }))
      .sort(byDateThenText);
  }

  // What one walker is allowed to see about one dog's notes.
  function notesFor(dogId, userId) {
    // Newest day first, then by text: within a day, the order they were
    // written in would say whose came first.
    const sharedTips = db.prepare(
      `SELECT id, body, created_at AS createdAt, updated_at AS updatedAt
       FROM dog_notes WHERE dog_id = ? AND visibility = 'public'`
    ).all(dogId).map((t) => ({ ...t, id: tipIdOf(t.id), createdAt: noteDay(t.createdAt), updatedAt: noteDay(t.updatedAt) }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.body.localeCompare(b.body)));
    const priv = db.prepare(
      "SELECT body, updated_at AS updatedAt FROM dog_notes WHERE dog_id = ? AND user_id = ? AND visibility = 'private'"
    ).get(dogId, userId) || null;
    // tagged: names for the tags in these notes. mentions: notes on other
    // animals that tag this one.
    const walkNotes = walkNotesFor(dogId);
    const mentions = noteTags.mentionsOf(dogId, userId);
    const tagged = noteTags.namesFor([...sharedTips.map((t) => t.body), priv ? priv.body : '', ...walkNotes.map((n) => n.text), ...mentions.map((m) => m.body)]);
    return { sharedTips, privateNote: priv, walkNotes, tagged, mentions };
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
    // actually was -- playgroup gets its own kind instead of being folded
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
      // Shared notes (tips, walk notes) carry their date only; your own
      // private note keeps its time.
      byDog.get(r.dogId).notes.push({ kind: r.kind, id: r.kind === 'tip' ? tipIdOf(r.id) : undefined, body: r.body, at: r.kind === 'private' ? r.at : noteDay(r.at) });
    }
    // Within a dog, and between dogs, order by date and then text: the rows
    // above came sorted by exact time, which would line a walk note up
    // against the walks around it.
    const day = (n) => (n.kind === 'private' && n.at ? shelterDate(n.at) : String(n.at || '').slice(0, 10));
    const groups = Array.from(byDog.values());
    for (const g of groups) g.notes.sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : String(a.body).localeCompare(String(b.body))));
    // Same day: a dog with your own private note from that day (whose exact
    // time is yours to know) first, newest first, then by name.
    const ownAt = (g) => { const p = g.notes.find((n) => n.kind === 'private' && day(n) === day(g.notes[0])); return p ? p.at : ''; };
    groups.sort((a, b) => (day(a.notes[0]) < day(b.notes[0]) ? 1 : day(a.notes[0]) > day(b.notes[0]) ? -1
      : ownAt(b).localeCompare(ownAt(a)) || String(a.dog.name).localeCompare(String(b.dog.name))));
    res.json({ dogs: groups, tagged: noteTags.namesFor(rows.map((r) => r.body)) });
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
    res.json({ id: tipIdOf(info.lastInsertRowid) });
  });

  // A shared tip by its opaque id (private notes are never reachable this
  // way: only visibility = 'public' rows are looked at).
  const dogTips = db.prepare("SELECT id FROM dog_notes WHERE dog_id = ? AND visibility = 'public'");
  const findTip = (req) => findByOpaqueId(dogTips.all(parseInt(req.params.id, 10)), tipIdOf, req.params.noteId);

  // Whiteboard rules: any walker can edit any shared tip.
  app.put('/api/dogs/:id/notes/:noteId', (req, res) => {
    const note = findTip(req);
    if (!note) return res.status(404).json({ error: 'Tip not found' });
    const body = noteTags.clean(cleanText(req.body && req.body.body, MAX_TIP), parseInt(req.params.id, 10));
    if (!body) return res.status(400).json({ error: 'A tip can\'t be empty. Delete it instead.' });
    db.prepare('UPDATE dog_notes SET body = ?, updated_at = ? WHERE id = ?').run(body, new Date().toISOString(), note.id);
    res.json({ id: req.params.noteId });
  });

  // ...and any walker can erase any shared tip.
  app.delete('/api/dogs/:id/notes/:noteId', (req, res) => {
    const note = findTip(req);
    if (!note) return res.status(404).json({ error: 'Tip not found' });
    db.prepare('DELETE FROM dog_notes WHERE id = ?').run(note.id);
    res.json({ ok: true });
  });

  // The "note for other walkers" left when ending a walk lives on the walk
  // itself, but it's listed with the tips and follows the same whiteboard
  // rules: any walker can reword or clear it. Only the note text is touched;
  // the walk record stays as it was. Named by the opaque note id from
  // walkNotesFor (a walk id is not accepted).
  function sharedWalkNote(req) {
    return findByOpaqueId(notedWalks.all(parseInt(req.params.id, 10)), noteIdOf, req.params.noteId);
  }
  app.put('/api/dogs/:id/walk-notes/:noteId', (req, res) => {
    const walk = sharedWalkNote(req);
    if (!walk) return res.status(404).json({ error: 'Note not found' });
    const raw = String((req.body && req.body.body) == null ? '' : req.body.body).trim();
    if (raw.length > MAX_WALK_NOTE) return res.status(400).json({ error: `A note can be up to ${MAX_WALK_NOTE} characters.` });
    const body = noteTags.clean(cleanText(raw, MAX_WALK_NOTE), parseInt(req.params.id, 10));
    if (!body) return res.status(400).json({ error: 'A note can\'t be empty. Delete it instead.' });
    db.prepare('UPDATE walks SET notes = ? WHERE id = ?').run(body, walk.id);
    res.json({ noteId: req.params.noteId });
  });
  app.delete('/api/dogs/:id/walk-notes/:noteId', (req, res) => {
    const walk = sharedWalkNote(req);
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
      const stamp = new Date().toLocaleDateString('en-US', { timeZone: SHELTER_TZ, month: 'short', day: 'numeric' });
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

  return { notesFor, walkNotesFor, MAX_WALK_NOTE };
}

module.exports = { register, opaqueIds, findByOpaqueId };
