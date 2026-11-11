// Playgroup notes: dated entries, anonymous unless signed, @[id] tags that
// show up as mentions on the tagged dog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base; let dbFile; let server;
const ALICE = 'alice.pg@example.com';
const BOB = 'bob.pg@example.com';
const STAFF = 'staff.pg@example.com';

async function call(method, url, { user = ALICE, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-pg-' });
  ({ base, dbFile } = server);
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['staff', STAFF]]) ids[k] = (await call('GET', '/api/me', { user: e })).json;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  for (const [id, name] of [[1, 'Max'], [2, 'Bella'], [3, 'Maxine']]) {
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(id, name, now, now);
  }
  db.close();
});
test.after(async () => { if (server) { await server.stop(); fs.rmSync(server.dir, { recursive: true, force: true }); } });

test('a note tags another dog, and the tagged dog lists it as a mention', async () => {
  const added = await call('POST', '/api/dogs/1/playgroup-notes', { body: { body: 'Played great with @[2], ignored @[999] and @[1].', noteDate: '2026-10-01' } });
  assert.equal(added.status, 200);
  const max = (await call('GET', '/api/dogs/1/playgroup-notes', { user: BOB })).json;
  assert.equal(max.notes.length, 1);
  // Unknown dogs and the note's own dog aren't tags.
  assert.equal(max.notes[0].body, 'Played great with @[2], ignored @999 and @1.');
  assert.equal(max.notes[0].noteDate, '2026-10-01');
  assert.equal(max.notes[0].author, null);
  assert.equal(max.dogs[2].name, 'Bella');
  const bella = (await call('GET', '/api/dogs/2/playgroup-notes', { user: BOB })).json;
  assert.equal(bella.notes.length, 0);
  assert.equal(bella.mentions.length, 1);
  assert.equal(bella.mentions[0].dogId, 1);
  assert.equal(bella.dogs[1].name, 'Max');
  // Counts for the profile button.
  const profile = (await call('GET', '/api/dogs/2')).json;
  assert.deepEqual(profile.dog.playgroupCounts, { notes: 0, mentions: 1 });

  // Retagging moves the mention.
  await call('PUT', `/api/dogs/1/playgroup-notes/${added.json.id}`, { user: BOB, body: { body: 'Better with @[3].' } });
  assert.equal((await call('GET', '/api/dogs/2/playgroup-notes')).json.mentions.length, 0);
  assert.equal((await call('GET', '/api/dogs/3/playgroup-notes')).json.mentions.length, 1);
  // Deleting removes it.
  assert.equal((await call('DELETE', `/api/dogs/1/playgroup-notes/${added.json.id}`, { user: BOB })).status, 200);
  assert.equal((await call('GET', '/api/dogs/3/playgroup-notes')).json.mentions.length, 0);
});

test('anonymous notes are a whiteboard; signed ones only their writer or staff can change', async () => {
  const anon = (await call('POST', '/api/dogs/2/playgroup-notes', { body: { body: 'Anon note' } })).json.id;
  const signed = (await call('POST', '/api/dogs/2/playgroup-notes', { body: { body: 'Signed note', signed: true } })).json.id;
  const asBob = (await call('GET', '/api/dogs/2/playgroup-notes', { user: BOB })).json.notes;
  const s = asBob.find((n) => n.id === signed);
  const a = asBob.find((n) => n.id === anon);
  assert.equal(s.author, ids.alice.name);
  assert.equal(a.author, null);
  assert.equal(s.canEdit, false);
  assert.equal(a.canEdit, true);
  assert.equal(a.mine, false);
  assert.equal((await call('GET', '/api/dogs/2/playgroup-notes')).json.notes.find((n) => n.id === anon).mine, true);

  assert.equal((await call('PUT', `/api/dogs/2/playgroup-notes/${signed}`, { user: BOB, body: { body: 'hijack' } })).status, 403);
  assert.equal((await call('DELETE', `/api/dogs/2/playgroup-notes/${signed}`, { user: BOB })).status, 403);
  // Bob can edit Alice's anonymous note but can't sign it.
  assert.equal((await call('PUT', `/api/dogs/2/playgroup-notes/${anon}`, { user: BOB, body: { body: 'Anon note, edited', signed: true } })).status, 200);
  assert.equal((await call('GET', '/api/dogs/2/playgroup-notes')).json.notes.find((n) => n.id === anon).author, null);
  // Staff can tidy a signed note.
  assert.equal((await call('PUT', `/api/dogs/2/playgroup-notes/${signed}`, { user: STAFF, staff: true, body: { body: 'Signed note, typo fixed' } })).status, 200);
  // The writer can unsign.
  await call('PUT', `/api/dogs/2/playgroup-notes/${signed}`, { body: { body: 'Signed note', signed: false } });
  assert.equal((await call('GET', '/api/dogs/2/playgroup-notes', { user: BOB })).json.notes.find((n) => n.id === signed).author, null);
});

test('dates: defaults to today, no future dates, bad input rejected', async () => {
  assert.equal((await call('POST', '/api/dogs/3/playgroup-notes', { body: { body: 'x', noteDate: '2999-01-01' } })).status, 400);
  assert.equal((await call('POST', '/api/dogs/3/playgroup-notes', { body: { body: 'x', noteDate: 'yesterday' } })).status, 400);
  assert.equal((await call('POST', '/api/dogs/3/playgroup-notes', { body: { body: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/dogs/99/playgroup-notes', { body: { body: 'x' } })).status, 404);
  const ok = await call('POST', '/api/dogs/3/playgroup-notes', { body: { body: 'Today' } });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  assert.equal((await call('GET', '/api/dogs/3/playgroup-notes')).json.notes.find((n) => n.id === ok.json.id).noteDate, today);
});

test('deleting your data keeps the notes but drops your name', async () => {
  await call('POST', '/api/dogs/3/playgroup-notes', { user: BOB, body: { body: 'Bob signed', signed: true } });
  const db = new Database(dbFile);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM playgroup_notes WHERE user_id = ? AND signed = 1').get(ids.bob.id).c, 1);
  db.close();
  assert.equal((await call('DELETE', '/api/me/data', { user: BOB, body: { confirm: 'DELETE' } })).status, 200);
  const n = (await call('GET', '/api/dogs/3/playgroup-notes')).json.notes.find((x) => x.body === 'Bob signed');
  assert.ok(n);
  assert.equal(n.author, null);
});

test('the desk: every note with filters, counts, and the Excel export', async () => {
  const ExcelJS = require('exceljs');
  await call('POST', '/api/dogs/1/playgroup-notes', { body: { body: 'Desk: zoomies with @[2]', noteDate: '2026-09-15', signed: true } });
  await call('POST', '/api/dogs/2/playgroup-notes', { body: { body: 'Desk: calm', noteDate: '2026-09-20' } });

  const all = (await call('GET', '/api/playgroup-notes?from=2026-09-01&to=2026-09-30')).json;
  assert.deepEqual(all.notes.map((n) => n.noteDate), ['2026-09-20', '2026-09-15']);
  const zoom = all.notes.find((n) => n.noteDate === '2026-09-15');
  assert.equal(zoom.text, 'Desk: zoomies with @Bella');
  assert.deepEqual(zoom.tagged, [2]);
  assert.equal(zoom.dogName, 'Max');
  // Search covers the note with tags as names, and the dog's name.
  assert.equal((await call('GET', '/api/playgroup-notes?q=zoomies%20with%20bella')).json.notes.length, 1);
  assert.equal((await call('GET', '/api/playgroup-notes?from=2026-09-01&to=2026-09-30&q=bella')).json.notes.length, 2);
  // dog= takes that dog's notes plus the ones tagging it.
  assert.equal((await call('GET', '/api/playgroup-notes?dog=2&from=2026-09-01&to=2026-09-30')).json.notes.length, 2);

  const counts = (await call('GET', '/api/playgroup-notes/counts')).json.counts;
  assert.ok(counts[1].notes >= 1 && counts[1].name === 'Max');

  const res = await fetch(`${base}/api/playgroup-notes/export.xlsx?from=2026-09-01&to=2026-09-30`, { headers: { 'x-auth-email': ALICE } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /playgroup-notes-2026-09-01_to_2026-09-30\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = wb.getWorksheet('Playgroup notes');
  assert.equal(sheet.rowCount, 3);
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header, ['Date', 'Dog', 'Animal ID', 'Still at the shelter', 'Note', 'Dogs tagged']);
  assert.ok(!header.includes('Signed by'), 'who signed stays out of the export');
  const row = [2, 3].map((i) => sheet.getRow(i)).find((r) => r.getCell(2).value === 'Max');
  assert.equal(row.getCell(5).value, 'Desk: zoomies with @Bella');
  assert.equal(row.getCell(6).value, 'Bella (2)');
  assert.ok(!row.values.includes(ids.alice.name));
  const byDog = wb.getWorksheet('By dog');
  const bella = [2, 3].map((i) => byDog.getRow(i)).find((r) => r.getCell(1).value === 'Bella');
  assert.ok(!byDog.getRow(1).values.includes('Kennel'));
  assert.equal(bella.getCell(3).value, 1); // her own note
  assert.equal(bella.getCell(4).value, 1); // tagged in Max's
});

test('Excel export: each labelled bullet is a column named by its label, tagged dogs last', async () => {
  const ExcelJS = require('exceljs');
  await call('POST', '/api/dogs/2/playgroup-notes', { body: { body: '\u2022\tFemales: No\n\u2022\tGroup Play: No\n\u2022\tSession notes: with @[1] and @[3]', noteDate: '2026-08-03' } });
  await call('POST', '/api/dogs/3/playgroup-notes', { body: { body: '\u2022\tFemales: Yes\n\u2022\tMales: No\n\u2022\tGroup play: Yes\n\u2022\tSession notes: chased @[2]', noteDate: '2026-08-02', signed: true } });
  await call('POST', '/api/dogs/1/playgroup-notes', { body: { body: 'Good day.\nTired after.\n\n- **mouthy** at first\n1. settled', noteDate: '2026-08-01' } });
  const res = await fetch(`${base}/api/playgroup-notes/export.xlsx?from=2026-08-01&to=2026-08-31`, { headers: { 'x-auth-email': ALICE } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = wb.getWorksheet('Playgroup notes');
  const cols = (r) => sheet.getRow(r).values.slice(5).map((v) => v ?? '');
  assert.deepEqual(cols(1), ['Females', 'Group Play', 'Session notes', 'Males', 'Note', 'Dogs tagged']);
  assert.deepEqual(cols(2), ['No', 'No', 'with @Max and @Maxine', '', '', 'Max (1), Maxine (3)']);
  assert.deepEqual(cols(3), ['Yes', 'Yes', 'chased @Bella', 'No', '', 'Bella (2)']);
  assert.deepEqual(cols(4), ['', '', '', '', 'Good day.\nTired after.\n**mouthy** at first\nsettled', '']);
  assert.ok(!JSON.stringify(sheet.getSheetValues()).includes(ids.alice.name));
});
