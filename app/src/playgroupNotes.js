// Play group notes: what happened when a dog played with others, kept apart
// from the shared tips and private notes because they run longer (a few
// sentences a session) and only matter to the volunteers who run play group.
//
//   Entries    dated (the session's day, not the day it was typed, so a pasted
//              history keeps its real dates), newest first, readable by every
//              walker.
//   Authors    anonymous by default, like tips. A writer can choose to sign
//              an entry, and then their name shows on it. Anyone may edit or
//              delete an anonymous entry (whiteboard rules); a signed one only
//              its writer or staff can change, so nobody's words end up under
//              someone else's name.
//   Tags       "@[123]" in the body tags dog 123. The app shows it as the
//              dog's current name, so a rename never breaks a tag. Each dog's
//              notes end with every entry on other dogs that tagged it.
//
// Stored as plain text, always escaped when displayed; a light markdown
// (bold, italic, bullet/numbered lists -- see bodyHtml in pg-tags.js) is
// rendered on top of the escaped text, same as the Guide's but without
// links or images.
const ExcelJS = require('exceljs');

const MAX_BODY = 4000;
const MAX_NOTES_PER_DOG = 300;
const TAG_RE = /@\[(\d+)\]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shelterToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function register(app, { db, isStaffOrPrivileged, cachedPhotoUrl }) {
  const dogExists = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?');
  const dogInfo = db.prepare('SELECT shelter_buddy_id AS id, name, photo_url AS photoUrl, still_listed AS stillListed FROM dogs WHERE shelter_buddy_id = ?');
  const cleanText = (raw) => String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim().slice(0, MAX_BODY);

  // Tagged dog ids in a body, minus unknown dogs and the note's own dog.
  function taggedIds(body, ownDogId) {
    const ids = new Set();
    for (const m of body.matchAll(TAG_RE)) {
      const id = Number(m[1]);
      if (id !== ownDogId && dogExists.get(id)) ids.add(id);
    }
    return [...ids];
  }
  // Tags pointing at dogs we don't know turn back into plain text.
  const dropBadTags = (body, ownDogId) => {
    const ok = new Set(taggedIds(body, ownDogId));
    return body.replace(TAG_RE, (all, id) => (ok.has(Number(id)) ? all : `@${id}`));
  };
  const saveMentions = db.transaction((noteId, body, dogId) => {
    db.prepare('DELETE FROM playgroup_mentions WHERE note_id = ?').run(noteId);
    const ins = db.prepare('INSERT INTO playgroup_mentions (note_id, dog_id) VALUES (?, ?)');
    for (const id of taggedIds(body, dogId)) ins.run(noteId, id);
  });

  const noteDate = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return { value: shelterToday() };
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s + 'T12:00:00Z'))) return { error: 'That date is not a valid date.' };
    if (s > shelterToday()) return { error: "The date can't be in the future." };
    return { value: s };
  };

  const canChange = (req, note) => !note.signed || note.user_id === req.me.id || isStaffOrPrivileged(req, req.me);
  const shape = (req, n) => ({
    id: n.id,
    dogId: n.dog_id,
    body: n.body,
    noteDate: n.note_date,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    author: n.signed ? n.author || null : null,
    signed: !!n.signed,
    // Only ever true for the asker's own entries, so it says nothing about
    // who wrote anyone else's.
    mine: n.user_id === req.me.id,
    canEdit: canChange(req, n)
  });

  const SELECT_NOTE = `SELECT n.*, u.name AS author FROM playgroup_notes n LEFT JOIN users u ON u.id = n.user_id`;

  function playgroupFor(req, dogId) {
    const notes = db.prepare(`${SELECT_NOTE} WHERE n.dog_id = ? ORDER BY n.note_date DESC, n.id DESC`).all(dogId);
    const mentions = db.prepare(`${SELECT_NOTE} JOIN playgroup_mentions m ON m.note_id = n.id
      WHERE m.dog_id = ? ORDER BY n.note_date DESC, n.id DESC`).all(dogId);
    // Every dog these bodies tag or come from, so the app can show names.
    const ids = new Set([dogId]);
    for (const n of [...notes, ...mentions]) {
      ids.add(n.dog_id);
      for (const m of n.body.matchAll(TAG_RE)) ids.add(Number(m[1]));
    }
    const dogs = {};
    for (const id of ids) {
      const d = dogInfo.get(id);
      if (!d) continue;
      if (cachedPhotoUrl) d.photoUrl = cachedPhotoUrl(d.id, d.photoUrl);
      d.stillListed = !!d.stillListed;
      dogs[id] = d;
    }
    return { notes: notes.map((n) => shape(req, n)), mentions: mentions.map((n) => shape(req, n)), dogs };
  }

  // How many entries a dog has and how many times others tagged it, for the
  // button on its profile.
  const countNotes = db.prepare('SELECT COUNT(*) AS c FROM playgroup_notes WHERE dog_id = ?');
  const countMentions = db.prepare('SELECT COUNT(*) AS c FROM playgroup_mentions WHERE dog_id = ?');
  function counts(dogId) {
    return { notes: countNotes.get(dogId).c, mentions: countMentions.get(dogId).c };
  }

  app.get('/api/dogs/:id/playgroup-notes', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    res.json(playgroupFor(req, dogId));
  });

  app.post('/api/dogs/:id/playgroup-notes', (req, res) => {
    const dogId = parseInt(req.params.id, 10);
    if (!dogExists.get(dogId)) return res.status(404).json({ error: 'Dog not found' });
    const b = req.body || {};
    const body = dropBadTags(cleanText(b.body), dogId);
    if (!body) return res.status(400).json({ error: 'Write something first.' });
    const date = noteDate(b.noteDate);
    if (date.error) return res.status(400).json({ error: date.error });
    if (countNotes.get(dogId).c >= MAX_NOTES_PER_DOG) return res.status(409).json({ error: 'This dog already has a lot of play group notes. Ask staff to tidy them up.' });
    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(dogId, req.me.id, b.signed ? 1 : 0, date.value, body, now, now);
    saveMentions(info.lastInsertRowid, body, dogId);
    res.json({ id: info.lastInsertRowid });
  });

  const findNote = (req) => db.prepare('SELECT * FROM playgroup_notes WHERE id = ? AND dog_id = ?')
    .get(parseInt(req.params.noteId, 10), parseInt(req.params.id, 10));
  const signedError = "This note is signed by the volunteer who wrote it, so only they (or staff) can change it.";

  app.put('/api/dogs/:id/playgroup-notes/:noteId', (req, res) => {
    const note = findNote(req);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canChange(req, note)) return res.status(403).json({ error: signedError });
    const b = req.body || {};
    const body = dropBadTags(cleanText(b.body), note.dog_id);
    if (!body) return res.status(400).json({ error: "A note can't be empty. Delete it instead." });
    const date = b.noteDate === undefined ? { value: note.note_date } : noteDate(b.noteDate);
    if (date.error) return res.status(400).json({ error: date.error });
    // Only the writer can sign or unsign; anyone else's edit keeps it as it was.
    const signed = b.signed !== undefined && note.user_id === req.me.id ? (b.signed ? 1 : 0) : note.signed;
    db.prepare('UPDATE playgroup_notes SET body = ?, note_date = ?, signed = ?, updated_at = ? WHERE id = ?')
      .run(body, date.value, signed, new Date().toISOString(), note.id);
    saveMentions(note.id, body, note.dog_id);
    res.json({ id: note.id });
  });

  app.delete('/api/dogs/:id/playgroup-notes/:noteId', (req, res) => {
    const note = findNote(req);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canChange(req, note)) return res.status(403).json({ error: signedError });
    db.prepare('DELETE FROM playgroup_mentions WHERE note_id = ?').run(note.id);
    db.prepare('DELETE FROM playgroup_notes WHERE id = ?').run(note.id);
    res.json({ ok: true });
  });

  // ---- The play group desk (playgroup.html): every note in one list ----

  // Every note matching the filters, newest first, with
  // names for every dog involved. from/to are YYYY-MM-DD (inclusive); q
  // matches the dog's name, the note (tags read as names) or who signed it.
  const nameRow = db.prepare('SELECT shelter_buddy_id AS id, name, kennel_location AS kennelLocation, still_listed AS stillListed FROM dogs WHERE shelter_buddy_id = ?');
  function allNotes(req, { from, to, q, dog } = {}) {
    const where = [];
    const args = [];
    if (DATE_RE.test(from || '')) { where.push('n.note_date >= ?'); args.push(from); }
    if (DATE_RE.test(to || '')) { where.push('n.note_date <= ?'); args.push(to); }
    if (/^\d+$/.test(dog || '')) { where.push('(n.dog_id = ? OR n.id IN (SELECT note_id FROM playgroup_mentions WHERE dog_id = ?))'); args.push(Number(dog), Number(dog)); }
    const rows = db.prepare(`${SELECT_NOTE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY n.note_date DESC, n.id DESC LIMIT 10000`).all(...args);
    const dogs = {};
    const dogFor = (id) => {
      if (!(id in dogs)) {
        const d = nameRow.get(id);
        dogs[id] = d ? { ...d, stillListed: !!d.stillListed } : null;
      }
      return dogs[id];
    };
    const plain = (body) => body.replace(TAG_RE, (all, id) => `@${(dogFor(Number(id)) || { name: id }).name}`);
    // "@" is ignored either side, so "with bella" finds "with @Bella".
    const bare = (v) => v.toLowerCase().replace(/@/g, '');
    const needle = bare(String(q || '').trim());
    const notes = [];
    for (const n of rows) {
      const d = dogFor(n.dog_id);
      const text = plain(n.body);
      const tagged = [...new Set([...n.body.matchAll(TAG_RE)].map((m) => Number(m[1])))].filter((id) => id !== n.dog_id && dogFor(id));
      const author = n.signed ? n.author || null : null;
      if (needle && ![d && d.name, text, author].some((v) => v && bare(v).includes(needle))) continue;
      notes.push({ ...shape(req, n), dogName: d ? d.name : `#${n.dog_id}`, kennelLocation: d ? d.kennelLocation : null, text, tagged });
    }
    for (const k of Object.keys(dogs)) if (!dogs[k]) delete dogs[k];
    return { notes, dogs };
  }

  app.get('/api/playgroup-notes', (req, res) => {
    res.json(allNotes(req, req.query));
  });

  // How many notes each dog has and when the latest is from, for the desk's
  // dog list. Carries the dog's name too, so dogs who have left the shelter
  // (not in the listed-dogs feed) still show there with their notes.
  app.get('/api/playgroup-notes/counts', (req, res) => {
    const counts = {};
    for (const r of db.prepare(`SELECT p.dog_id, COUNT(*) AS c, MAX(p.note_date) AS last, d.name, d.kennel_location, d.still_listed
      FROM playgroup_notes p JOIN dogs d ON d.shelter_buddy_id = p.dog_id GROUP BY p.dog_id`).all()) {
      counts[r.dog_id] = { notes: r.c, last: r.last, name: r.name, kennelLocation: r.kennel_location, stillListed: !!r.still_listed };
    }
    res.json({ counts });
  });

  // The same list as an Excel workbook: every session on one sheet, and a
  // per-dog summary on a second.
  app.get('/api/playgroup-notes/export.xlsx', async (req, res) => {
    const { notes, dogs } = allNotes(req, req.query);
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();
    const sheet = wb.addWorksheet('Play group notes', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Dog', key: 'dog', width: 18 },
      { header: 'Animal ID', key: 'id', width: 11 },
      { header: 'Kennel', key: 'kennel', width: 8 },
      { header: 'Note', key: 'note', width: 80 },
      { header: 'Dogs tagged', key: 'tagged', width: 28 },
      { header: 'Signed by', key: 'author', width: 18 },
      { header: 'Still at the shelter', key: 'listed', width: 10 }
    ];
    sheet.getRow(1).font = { bold: true };
    for (const n of notes) {
      const [y, m, d] = n.noteDate.split('-').map(Number);
      const row = sheet.addRow({
        date: new Date(Date.UTC(y, m - 1, d)),
        dog: n.dogName,
        id: n.dogId,
        kennel: n.kennelLocation || '',
        note: n.text,
        tagged: n.tagged.map((id) => dogs[id].name).join(', '),
        author: n.author || '',
        listed: dogs[n.dogId] && dogs[n.dogId].stillListed ? 'Yes' : 'No'
      });
      row.getCell('date').numFmt = 'yyyy-mm-dd';
      row.getCell('note').alignment = { wrapText: true, vertical: 'top' };
      row.alignment = { vertical: 'top' };
    }
    sheet.autoFilter = { from: 'A1', to: 'H1' };

    const byDog = new Map();
    for (const n of notes) {
      const s = byDog.get(n.dogId) || { dog: n.dogName, id: n.dogId, kennel: n.kennelLocation || '', sessions: 0, first: n.noteDate, last: n.noteDate, mentioned: 0 };
      s.sessions += 1;
      if (n.noteDate < s.first) s.first = n.noteDate;
      if (n.noteDate > s.last) s.last = n.noteDate;
      byDog.set(n.dogId, s);
    }
    for (const n of notes) {
      for (const id of n.tagged) {
        const s = byDog.get(id) || { dog: dogs[id].name, id, kennel: dogs[id].kennelLocation || '', sessions: 0, first: '', last: '', mentioned: 0 };
        s.mentioned += 1;
        byDog.set(id, s);
      }
    }
    const summary = wb.addWorksheet('By dog', { views: [{ state: 'frozen', ySplit: 1 }] });
    summary.columns = [
      { header: 'Dog', key: 'dog', width: 18 },
      { header: 'Animal ID', key: 'id', width: 11 },
      { header: 'Kennel', key: 'kennel', width: 8 },
      { header: 'Notes', key: 'sessions', width: 8 },
      { header: 'Tagged in other dogs\' notes', key: 'mentioned', width: 14 },
      { header: 'First note', key: 'first', width: 12 },
      { header: 'Latest note', key: 'last', width: 12 }
    ];
    summary.getRow(1).font = { bold: true };
    [...byDog.values()].sort((a, b) => a.dog.localeCompare(b.dog)).forEach((s) => summary.addRow(s));
    summary.autoFilter = { from: 'A1', to: 'G1' };

    const range = [req.query.from, req.query.to].filter((v) => DATE_RE.test(v || '')).join('_to_') || shelterToday();
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="playgroup-notes-${range}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  return { counts };
}

module.exports = { register };
