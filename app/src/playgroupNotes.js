// Playgroup notes: what happened when a dog played with others, kept apart
// from the shared tips and private notes because they run longer (a few
// sentences a session) and only matter to the volunteers who run playgroup.
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
const { noteDay } = require('./noteTags');
const { opaqueIds, findByOpaqueId } = require('./notes');
const asyncRoute = require('./asyncRoute');
const { realDateKey } = require('./validate');
const { SHELTER_TZ } = require('./constants');

const MAX_BODY = 4000;
const MAX_NOTES_PER_DOG = 300;
const TAG_RE = /@\[(\d+)\]/g;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shelterToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: SHELTER_TZ });
}

// A note split into its points for the export: each bullet or numbered line
// ("- ", "* ", "•", "1. ") is one point, its marker dropped; other lines
// run together into one point until a blank line or a bullet. A bullet that
// starts with a short "Label:" ("Group play: Yes") carries that label, which
// becomes its column; anything else has none and goes under plain "Note".
function notePoints(text) {
  const out = [];
  let para = null;
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { para = null; continue; }
    const m = /^(?:[-*]\s+|•\s*|\d+[.)]\s+)(.*)$/.exec(line);
    if (m) {
      para = null;
      const body = m[1].trim();
      const l = /^([A-Za-z][^:@\n]{0,29}?)\s*:\s*(.*)$/.exec(body);
      if (l) out.push({ label: l[1], text: l[2] });
      else if (body) out.push({ label: null, text: body });
      continue;
    }
    if (para === null) { para = out.length; out.push({ label: null, text: line }); } else out[para].text += `\n${line}`;
  }
  return out;
}

function register(app, { db, isStaffOrPrivileged, cachedPhotoUrl }) {
  const dogExists = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?');
  // Notes are named by an opaque id (notes.js opaqueIds), never their row
  // id: row ids only go up, so your own notes would bracket everyone else's.
  const pgIdOf = opaqueIds(db)('playgroup-note');
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
    // realDateKey: Date.parse alone lets 2026-02-30 through (as March 2).
    if (!realDateKey(s)) return { error: 'That date is not a valid date.' };
    if (s > shelterToday()) return { error: "The date can't be in the future." };
    return { value: s };
  };

  const canChange = (req, note) => !note.signed || note.user_id === req.me.id || isStaffOrPrivileged(req, req.me);
  // When an entry was typed and edited: the exact time only on a signed
  // entry, to its own writer. Everyone else (and anyone at all for an
  // unsigned one) gets the shelter date, so the time can't be matched to who
  // was at the shelter then.
  const whenFor = (req, n, iso) => (n.signed && n.user_id === req.me.id ? iso : noteDay(iso));
  const shape = (req, n) => ({
    id: pgIdOf(n.id),
    dogId: n.dog_id,
    body: n.body,
    noteDate: n.note_date,
    createdAt: whenFor(req, n, n.created_at),
    updatedAt: whenFor(req, n, n.updated_at),
    author: n.signed ? n.author || null : null,
    signed: !!n.signed,
    // Only ever true for the asker's own entries, so it says nothing about
    // who wrote anyone else's.
    mine: n.user_id === req.me.id,
    // The writer can sign it, unless someone else has changed the words.
    canSign: n.user_id === req.me.id && (!!n.signed || !n.edited_by_other),
    canEdit: canChange(req, n)
  });

  const SELECT_NOTE = `SELECT n.*, u.name AS author FROM playgroup_notes n LEFT JOIN users u ON u.id = n.user_id`;

  function playgroupFor(req, dogId) {
    const notes = db.prepare(`${SELECT_NOTE} WHERE n.dog_id = ? ORDER BY n.note_date DESC, n.body ASC`).all(dogId);
    const mentions = db.prepare(`${SELECT_NOTE} JOIN playgroup_mentions m ON m.note_id = n.id
      WHERE m.dog_id = ? ORDER BY n.note_date DESC, n.body ASC`).all(dogId);
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
    if (countNotes.get(dogId).c >= MAX_NOTES_PER_DOG) return res.status(409).json({ error: 'This dog already has a lot of playgroup notes. Ask staff to tidy them up.' });
    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(dogId, req.me.id, b.signed ? 1 : 0, date.value, body, now, now);
    saveMentions(info.lastInsertRowid, body, dogId);
    res.json({ id: pgIdOf(info.lastInsertRowid) });
  });

  const dogNoteIds = db.prepare('SELECT id FROM playgroup_notes WHERE dog_id = ?');
  const findNote = (req) => {
    const hit = findByOpaqueId(dogNoteIds.all(parseInt(req.params.id, 10)), pgIdOf, req.params.noteId);
    return hit ? db.prepare('SELECT * FROM playgroup_notes WHERE id = ?').get(hit.id) : null;
  };
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
    // Only the writer can sign or unsign; anyone else's edit keeps it as it
    // was -- except that staff changing the words of a signed entry unsign
    // it, so the volunteer's name never stands under words they didn't
    // write (audit 3). editedByOther below then keeps it from being re-signed.
    const rewordedByOther = !!note.signed && note.user_id !== req.me.id && body !== note.body;
    const signed = rewordedByOther ? 0 : b.signed !== undefined && note.user_id === req.me.id ? (b.signed ? 1 : 0) : note.signed;
    // Once someone else has changed the words, the writer can't put their
    // name on them (unsigning is always fine).
    const editedByOther = note.edited_by_other || (note.user_id !== req.me.id && body !== note.body) ? 1 : 0;
    if (signed && !note.signed && editedByOther) {
      return res.status(409).json({ error: "Someone else has edited this note, so it can't be signed now. Write a new note to sign your own words." });
    }
    db.prepare('UPDATE playgroup_notes SET body = ?, note_date = ?, signed = ?, edited_by_other = ?, updated_at = ? WHERE id = ?')
      .run(body, date.value, signed, editedByOther, new Date().toISOString(), note.id);
    saveMentions(note.id, body, note.dog_id);
    res.json({ id: req.params.noteId });
  });

  app.delete('/api/dogs/:id/playgroup-notes/:noteId', (req, res) => {
    const note = findNote(req);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!canChange(req, note)) return res.status(403).json({ error: signedError });
    db.prepare('DELETE FROM playgroup_mentions WHERE note_id = ?').run(note.id);
    db.prepare('DELETE FROM playgroup_notes WHERE id = ?').run(note.id);
    res.json({ ok: true });
  });

  // ---- The playgroup desk (playgroup.html): every note in one list ----

  // Every note matching the filters, newest first, with
  // names for every dog involved. from/to are YYYY-MM-DD (inclusive); q
  // matches the dog's name, the note (tags read as names) or who signed it.
  // lastEvent: same rule as /counts below, so the volunteer app can say
  // "Adopted" / "Left shelter" exactly like the desk does.
  // Every dog in the list (each note's own dog and every dog it tags) in one
  // query, rather than one per dog (720 queries for 741 notes).
  const namesFor = db.prepare(`SELECT shelter_buddy_id AS id, name, photo_url AS photoUrl, kennel_location AS kennelLocation, still_listed AS stillListed,
      (SELECT e.kind FROM shelter_events e WHERE e.dog_id = dogs.shelter_buddy_id AND e.kind IN ('adopted', 'returned')
        ORDER BY e.occurred_at DESC LIMIT 1) AS lastEvent
    FROM dogs WHERE shelter_buddy_id IN (SELECT value FROM json_each(?))`);
  // limit/offset (optional) page the matching notes, newest first; the
  // answer then says how many match in all (total) and where the next page
  // starts (nextOffset, null on the last). dogs only covers the page's notes.
  // Without them it's every matching note, as the desk and export want.
  function allNotes(req, { from, to, q, dog, limit, offset } = {}) {
    const where = [];
    const args = [];
    if (DATE_RE.test(from || '')) { where.push('n.note_date >= ?'); args.push(from); }
    if (DATE_RE.test(to || '')) { where.push('n.note_date <= ?'); args.push(to); }
    if (/^\d+$/.test(dog || '')) { where.push('(n.dog_id = ? OR n.id IN (SELECT note_id FROM playgroup_mentions WHERE dog_id = ?))'); args.push(Number(dog), Number(dog)); }
    const rows = db.prepare(`${SELECT_NOTE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY n.note_date DESC, n.body ASC LIMIT 10000`).all(...args);
    const ids = new Set();
    for (const n of rows) {
      ids.add(n.dog_id);
      for (const m of n.body.matchAll(TAG_RE)) ids.add(Number(m[1]));
    }
    const known = new Map();
    for (const d of ids.size ? namesFor.all(JSON.stringify([...ids])) : []) {
      if (cachedPhotoUrl) d.photoUrl = cachedPhotoUrl(d.id, d.photoUrl);
      d.stillListed = !!d.stillListed;
      d.adopted = !d.stillListed && d.lastEvent === 'adopted';
      delete d.lastEvent;
      known.set(d.id, d);
    }
    const dogs = {};
    const dogFor = (id) => {
      const d = known.get(id) || null;
      if (d) dogs[id] = d;
      return d;
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
    const size = parseInt(limit, 10);
    if (!(size > 0)) return { notes, dogs };
    const start = Math.max(parseInt(offset, 10) || 0, 0);
    const page = notes.slice(start, start + Math.min(size, 1000));
    // Notes per dog across every match, so a page can say "12 notes" for a
    // dog whose older ones are on later pages.
    const dogTotals = {};
    for (const n of notes) dogTotals[n.dogId] = (dogTotals[n.dogId] || 0) + 1;
    const pageDogs = {};
    const pageTotals = {};
    for (const n of page) {
      pageTotals[n.dogId] = dogTotals[n.dogId];
      for (const id of [n.dogId, ...n.tagged]) if (dogs[id]) pageDogs[id] = dogs[id];
    }
    const end = start + page.length;
    return { notes: page, dogs: pageDogs, dogTotals: pageTotals, total: notes.length, nextOffset: end < notes.length ? end : null };
  }

  app.get('/api/playgroup-notes', (req, res) => {
    res.json(allNotes(req, req.query));
  });

  // How many notes each dog has and when the latest is from, for the desk's
  // dog list. Carries the dog's name too, so dogs who have left the shelter
  // (not in the listed-dogs feed) still show there with their notes.
  app.get('/api/playgroup-notes/counts', (req, res) => {
    const counts = {};
    // adopted: the dog's latest adopted/returned event is an adoption, so the
    // desk can say "Adopted" rather than a vague "left".
    for (const r of db.prepare(`SELECT p.dog_id, COUNT(*) AS c, MAX(p.note_date) AS last, d.name, d.kennel_location, d.still_listed, d.photo_url,
        (SELECT e.kind FROM shelter_events e WHERE e.dog_id = p.dog_id AND e.kind IN ('adopted', 'returned')
          ORDER BY e.occurred_at DESC LIMIT 1) AS last_event
      FROM playgroup_notes p JOIN dogs d ON d.shelter_buddy_id = p.dog_id GROUP BY p.dog_id`).all()) {
      counts[r.dog_id] = {
        notes: r.c, last: r.last, name: r.name, kennelLocation: r.kennel_location, stillListed: !!r.still_listed,
        adopted: !r.still_listed && r.last_event === 'adopted',
        photoUrl: cachedPhotoUrl ? cachedPhotoUrl(r.dog_id, r.photo_url) : r.photo_url
      };
    }
    res.json({ counts });
  });

  // The same list as an Excel workbook: every session on one sheet, and a
  // per-dog summary on a second. Each labelled bullet of a note gets its own
  // column under that label (the Playgroup team's Females / Males / Group
  // play / Session notes), and the tagged dogs last, as "Max (123), Bella (345)".
  // Who signed it and the kennel stay out of the file.
  app.get('/api/playgroup-notes/export.xlsx', asyncRoute(async (req, res) => {
    const { notes, dogs } = allNotes(req, { ...req.query, limit: undefined });
    // Labels match whatever their case ("Group play" / "Group Play"); the
    // first spelling met names the column, in the order they first appear.
    const labels = new Map();
    const cells = new Map(notes.map((n) => {
      const byKey = {};
      for (const p of notePoints(n.text)) {
        const key = p.label ? p.label.toLowerCase() : '';
        if (!labels.has(key)) labels.set(key, p.label || 'Note');
        byKey[key] = byKey[key] ? `${byKey[key]}\n${p.text}` : p.text;
      }
      return [n, byKey];
    }));
    const keys = [...labels.keys()];
    const wb = new ExcelJS.Workbook();
    wb.created = new Date();
    const sheet = wb.addWorksheet('Playgroup notes', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Dog', key: 'dog', width: 18 },
      { header: 'Animal ID', key: 'id', width: 11 },
      { header: 'Still at the shelter', key: 'listed', width: 10 },
      ...keys.map((k, i) => ({ header: labels.get(k), key: `p${i}`, width: 30 })),
      { header: 'Dogs tagged', key: 'tagged', width: 30 }
    ];
    sheet.getRow(1).font = { bold: true };
    for (const n of notes) {
      const [y, m, d] = n.noteDate.split('-').map(Number);
      const byKey = cells.get(n);
      const row = sheet.addRow({
        date: new Date(Date.UTC(y, m - 1, d)),
        dog: n.dogName,
        id: n.dogId,
        listed: dogs[n.dogId] && dogs[n.dogId].stillListed ? 'Yes' : 'No',
        ...Object.fromEntries(keys.map((k, i) => [`p${i}`, byKey[k] ?? ''])),
        tagged: n.tagged.map((id) => `${dogs[id].name} (${id})`).join(', ')
      });
      row.getCell('date').numFmt = 'yyyy-mm-dd';
      row.alignment = { vertical: 'top', wrapText: true };
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

    const byDog = new Map();
    for (const n of notes) {
      const s = byDog.get(n.dogId) || { dog: n.dogName, id: n.dogId, sessions: 0, first: n.noteDate, last: n.noteDate, mentioned: 0 };
      s.sessions += 1;
      if (n.noteDate < s.first) s.first = n.noteDate;
      if (n.noteDate > s.last) s.last = n.noteDate;
      byDog.set(n.dogId, s);
    }
    for (const n of notes) {
      for (const id of n.tagged) {
        const s = byDog.get(id) || { dog: dogs[id].name, id, sessions: 0, first: '', last: '', mentioned: 0 };
        s.mentioned += 1;
        byDog.set(id, s);
      }
    }
    const summary = wb.addWorksheet('By dog', { views: [{ state: 'frozen', ySplit: 1 }] });
    summary.columns = [
      { header: 'Dog', key: 'dog', width: 18 },
      { header: 'Animal ID', key: 'id', width: 11 },
      { header: 'Notes', key: 'sessions', width: 8 },
      { header: 'Tagged in other dogs\' notes', key: 'mentioned', width: 14 },
      { header: 'First note', key: 'first', width: 12 },
      { header: 'Latest note', key: 'last', width: 12 }
    ];
    summary.getRow(1).font = { bold: true };
    [...byDog.values()].sort((a, b) => a.dog.localeCompare(b.dog)).forEach((s) => summary.addRow(s));
    summary.autoFilter = { from: 'A1', to: 'F1' };

    const range = [req.query.from, req.query.to].filter((v) => DATE_RE.test(v || '')).join('_to_') || shelterToday();
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="playgroup-notes-${range}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }));

  return { counts };
}

module.exports = { register };
