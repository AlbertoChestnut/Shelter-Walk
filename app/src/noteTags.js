// "@" tags in the everyday notes: shared tips, private notes, and the note
// left at the end of a walk or play session. Same format as playgroup notes
// (playgroupNotes.js): "@[123]" in the body tags animal 123, and the app
// shows it as that animal's current name, so a rename never breaks a tag.
// Cats share condos and rooms far more often than dogs share kennels, so
// a note on one often matters to the others housed with them.
//
// No mentions table: tags are found with a LIKE on the stored text, which is
// plenty for one shelter's notes and can never drift out of step with them.
// Who can see a tag is simply who can see the note it's in (a private note's
// tags only ever show to its writer).
const TAG_RE = /@\[(\d+)\]/g;
const MAX_MENTIONS = 60;

// Shared notes never carry their exact time: a note next to a time could give
// away who wrote it (whoever was out with that dog then). noteDay() keeps
// only the shelter date, as a timestamp at 16:00 UTC on that date (late
// morning in New York), which reads as the same calendar day on any US
// phone, so the app's date formatting keeps working unchanged.
const { SHELTER_TZ } = require('./constants');
const shelterDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SHELTER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function noteDay(iso) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${shelterDayFmt.format(d)}T16:00:00.000Z`;
}

function create(db, { cachedPhotoUrl } = {}) {
  const animalExists = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?');
  const animalInfo = db.prepare('SELECT shelter_buddy_id AS id, name, species, photo_url AS photoUrl, still_listed AS stillListed FROM dogs WHERE shelter_buddy_id = ?');

  const idsIn = (body) => [...String(body || '').matchAll(TAG_RE)].map((m) => Number(m[1]));

  // Tags pointing at animals we don't know (or at the note's own animal)
  // turn back into plain text, so a stored tag always resolves to a name.
  function clean(body, ownId) {
    if (body == null) return body;
    return String(body).replace(TAG_RE, (all, id) => (Number(id) !== Number(ownId) && animalExists.get(Number(id)) ? all : `@${id}`));
  }

  // { id: { id, name, species, photoUrl, stillListed } } for every animal
  // tagged in these bodies -- sent next to notes so the app can show names.
  function namesFor(bodies) {
    const out = {};
    for (const body of bodies) {
      for (const id of idsIn(body)) {
        if (out[id]) continue;
        const a = animalInfo.get(id);
        if (!a) continue;
        if (cachedPhotoUrl) a.photoUrl = cachedPhotoUrl(a.id, a.photoUrl);
        a.stillListed = !!a.stillListed;
        out[id] = a;
      }
    }
    return out;
  }

  // Plain text with tags read as "@Name", for exports.
  function toText(body) {
    if (body == null) return body;
    return String(body).replace(TAG_RE, (all, id) => {
      const a = animalInfo.get(Number(id));
      return `@${a ? a.name : id}`;
    });
  }

  // Notes on OTHER animals that tag this one, newest first: every shared tip
  // and end-of-walk note, plus the asker's own private notes (never anyone
  // else's). No author is ever returned, same as the tips themselves.
  const mentionRows = db.prepare(`
    SELECT n.dog_id AS fromId, CASE n.visibility WHEN 'public' THEN 'tip' ELSE 'private' END AS kind,
           n.body, CASE n.visibility WHEN 'public' THEN n.created_at ELSE n.updated_at END AS at
    FROM dog_notes n
    WHERE n.dog_id != @id AND n.body LIKE @needle AND (n.visibility = 'public' OR n.user_id = @me)
    UNION ALL
    SELECT w.dog_id, CASE w.activity WHEN 'playgroup' THEN 'playgroup' ELSE 'walk' END, w.notes, w.started_at
    FROM walks w
    WHERE w.dog_id != @id AND w.ended_at IS NOT NULL AND w.notes LIKE @needle
    ORDER BY at DESC LIMIT ${MAX_MENTIONS}
  `);
  function mentionsOf(animalId, userId) {
    const rows = mentionRows.all({ id: animalId, me: userId, needle: `%@[${Number(animalId)}]%` });
    const from = namesFor(rows.map((r) => `@[${r.fromId}]`));
    // Date only, except on the asker's own private note.
    // Then ordered by date and text, not exact time, so a walk note can't be
    // placed against the walks around it.
    const day = (m) => String(m.at || '').slice(0, 10);
    return rows.filter((r) => from[r.fromId]).map((r) => ({ from: from[r.fromId], kind: r.kind, body: r.body, at: r.kind === 'private' ? r.at : noteDay(r.at) }))
      .sort((a, b) => (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : String(a.body).localeCompare(String(b.body))));
  }

  return { clean, namesFor, toText, mentionsOf };
}

module.exports = { create, TAG_RE, noteDay };
