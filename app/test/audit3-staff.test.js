// Audit 3 (2026-11-10), staff dashboard & Playgroup desk:
//   - "Each animal served" has ID and species columns, in the JSON, CSV, Excel
//     and PDF, so two Onyxes (or a dog and a cat both called Simba) differ.
//   - A Cats report has no dog-only items: no "Shelter context (dogs only)",
//     no avg walk length, no dog picked for the one-animal detail.
//   - Long PDF tables repeat their column headers on each new page.
//   - "Volunteers active" doesn't count a deleted account's walks (user_id NULL).
//   - The live board shows "2h 5m", not "125m".
//   - Fit-to-screen: measured from #app (so it can grow back), only at 1600+
//     or in TV mode, and a remembered TV mode is ignored under 600px.
//   - The Playgroup desk's header photo doesn't shrink.
// The browser behaviour of the zoom is in smoke/audit3-staff.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

const APP = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

let base, dbFile, server;
const STAFF = 'a3.staff@example.com';
const GONE = 'a3.gone@example.com';
const RANGE = 'from=2026-10-01&to=2026-10-31';

async function call(url, { raw = false } = {}) {
  const res = await fetch(base + url, { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

test.before(async () => {
  server = await startServer({ prefix: 'sw-audit3-staff-' });
  ({ base, dbFile } = server);
  const staffId = (await call('/api/me')).json.id;
  await fetch(base + '/api/me', { headers: { 'x-auth-email': GONE } });
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species)
    VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 'A', 1, ?, ?, ?)`);
  insDog.run(501, 'Onyx', now, now, 'dog');
  insDog.run(502, 'Onyx', now, now, 'dog');
  insDog.run(503, 'Simba', now, now, 'dog');
  insDog.run(504, 'Simba', now, now, 'cat');
  // Enough dogs for a long "Each animal served" table (two PDF pages and more).
  for (let i = 0; i < 90; i += 1) insDog.run(600 + i, `Pup ${String(i).padStart(2, '0')}`, now, now, 'dog');
  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const add = (dogId, userId, startIso, secs, activity = 'walk') => ins.run(dogId, userId, startIso, new Date(new Date(startIso).getTime() + secs * 1000).toISOString(), secs, activity, 'A');
  add(501, staffId, '2026-10-05T14:00:00.000Z', 1200);
  add(501, staffId, '2026-10-05T15:00:00.000Z', 1200);
  add(502, staffId, '2026-10-06T14:00:00.000Z', 900);
  add(503, staffId, '2026-10-06T15:00:00.000Z', 600);
  add(504, staffId, '2026-10-07T14:00:00.000Z', 600, 'cuddle');
  add(504, staffId, '2026-10-07T15:00:00.000Z', 600, 'cuddle');
  for (let i = 0; i < 90; i += 1) add(600 + i, staffId, `2026-10-${String(10 + (i % 15)).padStart(2, '0')}T14:00:00.000Z`, 600);
  // A deleted account: its walks keep counting, its user_id is NULL.
  add(502, null, '2026-10-08T14:00:00.000Z', 600);
  add(504, null, '2026-10-08T15:00:00.000Z', 600, 'cuddle');
  db.prepare("INSERT INTO shelter_events (dog_id, kind, occurred_at) VALUES (501, 'adopted', '2026-10-20T15:00:00.000Z')").run();
  db.close();
});
test.after(() => server && server.stop());

test('"Each animal served" has name, ID and species columns', async () => {
  const all = (await call(`/api/staff/reports?${RANGE}&species=all&sections=uniqueDogsServed`)).json;
  const t = all.tables.uniqueDogsServed;
  assert.deepEqual(t.columns, ['Animal', 'ID', 'Species', 'Engagements', 'Hours']);
  const byId = Object.fromEntries(t.rows.map((r) => [r[1], r]));
  assert.deepEqual(byId[501], ['Onyx', 501, 'Dog', 2, 0.7]);
  assert.deepEqual(byId[502], ['Onyx', 502, 'Dog', 2, 0.4]);
  assert.deepEqual(byId[503].slice(0, 3), ['Simba', 503, 'Dog']);
  assert.deepEqual(byId[504].slice(0, 3), ['Simba', 504, 'Cat']);
  const dogs = (await call(`/api/staff/reports?${RANGE}&sections=uniqueDogsServed`)).json;
  assert.deepEqual(dogs.tables.uniqueDogsServed.columns, ['Dog', 'ID', 'Species', 'Engagements', 'Hours']);
  assert.ok(!dogs.tables.uniqueDogsServed.rows.some((r) => r[1] === 504), 'no cat in a Dogs report');
});

test('every export carries the ID and species columns', async () => {
  const q = `${RANGE}&species=all&sections=uniqueDogsServed`;
  const csv = (await call(`/api/staff/reports/export.csv?${q}`)).text;
  assert.match(csv, /^Animal,ID,Species,Engagements,Hours$/m);
  assert.match(csv, /^Onyx,501,Dog,2,0\.7$/m);
  assert.match(csv, /^Onyx,502,Dog,2,0\.4$/m);
  assert.match(csv, /^Simba,504,Cat,3,0\.5$/m);

  const xlsx = await call(`/api/staff/reports/export.xlsx?${q}`, { raw: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.buf);
  const sheet = wb.worksheets.find((s) => /served/.test(s.name));
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Animal', 'ID', 'Species', 'Engagements', 'Hours']);
  const rows = [];
  sheet.eachRow((r, n) => { if (n > 1) rows.push(r.values.slice(1)); });
  assert.ok(rows.some((r) => r[0] === 'Simba' && r[1] === 504 && r[2] === 'Cat'));

  const pdf = await call(`/api/staff/reports/export.pdf?${q}`, { raw: true });
  const texts = pdfTexts(pdf.buf).map((t) => t.text);
  for (const h of ['Animal', 'ID', 'Species', 'Engagements', 'Hours']) assert.ok(texts.includes(h), `PDF header has "${h}"`);
  assert.ok(texts.includes('504') && texts.includes('Cat'), 'PDF rows have the ID and species');
});

// PDF text runs: [{ page, x, y, size, text }] (pdfkit's Helvetica, hex strings).
function pdfTexts(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m; let page = 0;
  while ((m = streamRe.exec(s))) {
    let t;
    try { t = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (e) { continue; }
    if (!/ Tm/.test(t)) continue;
    page += 1;
    const textRe = /1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\/F\d+ ([\d.]+) Tf\s*\[([^\]]*)\] TJ/g;
    let tm;
    while ((tm = textRe.exec(t))) {
      const text = [...tm[4].matchAll(/<([0-9a-f]*)>/gi)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join('');
      out.push({ page, x: Number(tm[1]), y: Number(tm[2]), size: Number(tm[3]), text });
    }
  }
  return out;
}

test('a long PDF table repeats its column headers on every page it runs onto', async () => {
  const pdf = await call(`/api/staff/reports/export.pdf?${RANGE}&sections=uniqueDogsServed`, { raw: true });
  assert.equal(pdf.status, 200);
  const texts = pdfTexts(pdf.buf);
  const pages = [...new Set(texts.map((t) => t.page))];
  assert.ok(pages.length >= 3, `the 94-row table runs over several pages (got ${pages.length})`);
  for (const p of pages.slice(1)) {
    const onPage = texts.filter((t) => t.page === p);
    const top = Math.max(...onPage.map((t) => t.y));
    for (const h of ['Dog', 'ID', 'Species', 'Engagements', 'Hours']) {
      assert.ok(onPage.some((t) => t.text === h && t.y === top), `page ${p} starts with the "${h}" header`);
    }
  }
});

test('a Cats report leaves out the dog-only items', async () => {
  const sections = 'byActivity,shelterContext,uniqueDogsServed,highlights';
  const cats = (await call(`/api/staff/reports?${RANGE}&species=cat&sections=${sections}&dogIds=501,504`)).json;
  assert.ok(!('shelterContext' in cats.tables), 'no "Shelter context (dogs only)" in a Cats report');
  assert.ok(!('avgWalkMinutes' in cats.stats.highlights), 'no avg walk length for cats');
  assert.deepEqual(cats.dogDetail.map((d) => d.dogId), [504], 'the picked dog is left out, the picked cat stays');
  const csv = (await call(`/api/staff/reports/export.csv?${RANGE}&species=cat&sections=${sections}&dogIds=501,504`)).text;
  assert.doesNotMatch(csv, /Shelter context|Avg walk length|Onyx/);
  // Dogs: shelter context and the walk average are still there; the cat isn't.
  const dogs = (await call(`/api/staff/reports?${RANGE}&species=dog&sections=${sections}&dogIds=501,504`)).json;
  assert.equal(dogs.tables.shelterContext.title, 'Shelter context');
  assert.equal(typeof dogs.stats.highlights.avgWalkMinutes, 'number');
  assert.deepEqual(dogs.dogDetail.map((d) => d.dogId), [501]);
  // Dogs and cats: both picked animals; shelter context marked dogs only.
  const all = (await call(`/api/staff/reports?${RANGE}&species=all&sections=${sections}&dogIds=501,504`)).json;
  assert.equal(all.tables.shelterContext.title, 'Shelter context (dogs only)');
  assert.deepEqual(all.dogDetail.map((d) => d.dogId), [501, 504]);
  // The page hides the tile when the key is absent, and marks out-of-report chips.
  const js = read('public/js/staff.js');
  assert.match(js, /'avgWalkMinutes' in highlights \?/);
  assert.match(js, /function chipOutOfReport\(d\)/);
});

test('"Volunteers active" leaves out deleted accounts (user_id NULL)', async () => {
  const r = (await call(`/api/staff/reports?${RANGE}&species=all&sections=highlights`)).json;
  assert.equal(r.stats.totals.volunteerHeadcount, 1, 'one real volunteer; the NULL walks are not a second one');
  assert.equal(r.stats.totals.walks, 98, 'the deleted account\'s walks still count');
  assert.equal(r.stats.highlights.avgWalksPerVolunteer, 98);
});

test('live board durations read "2h 5m", not "125m"', () => {
  const js = read('public/js/staff.js');
  const src = /function formatMinutes\(seconds\) \{[\s\S]*?\n {2}\}/.exec(js)[0];
  const formatMinutes = vm.runInNewContext(`(${src})`);
  assert.equal(formatMinutes(25 * 60), '25m');
  assert.equal(formatMinutes(125 * 60), '2h 5m');
  assert.equal(formatMinutes(120 * 60), '2h');
  assert.equal(formatMinutes(59.6 * 60), '1h');
});

test('fit-to-screen: measures #app, 1600+ or TV mode, TV mode ignored under 600', () => {
  const js = read('public/js/staff.js');
  assert.match(js, /const FIT_MIN_WIDTH = 1600;/);
  assert.match(js, /const TV_MIN_WIDTH = 600;/);
  assert.match(js, /app\.offsetTop \+ app\.offsetHeight/);
  const fit = /function fitToScreen\(\) \{[\s\S]*?\n {2}\}/.exec(js)[0];
  assert.doesNotMatch(fit, /scrollHeight/, 'the document scrollHeight never drops (body min-height: 100vh)');
});

// docs/TUTORIAL.md and public/tutorial.html carry the same text (the .md
// only adds a note about the demo dogs). Skipped where docs/ isn't there.
test('docs/TUTORIAL.md says the same as tutorial.html', (t) => {
  const mdFile = path.join(APP, '..', 'docs', 'TUTORIAL.md');
  if (!fs.existsSync(mdFile)) { t.skip('no docs/ here'); return; }
  const ent = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const words = (s) => s.replace(/\s+([.,;:)])/g, '$1').replace(/\(\s+/g, '(').split(/\s+/).filter(Boolean);
  const md = fs.readFileSync(mdFile, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/The scanning example is a real kennel card[\s\S]*?tutorial-shots\.js`\./, '')
    .replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*\d+\.\s/gm, ' ').replace(/^\s*(?:-|\d+\.)\s/gm, ' ')
    .replace(/[*#`|]/g, ' ').replace(/(?:^|\s)-{3}(?=\s)/g, ' ');
  const html = ent(read('public/tutorial.html')
    .replace(/[\s\S]*<main[^>]*>/, '').replace(/<\/main>[\s\S]*/, '')
    .replace(/(<h3[^>]*>)\d+\.\s/g, '$1')
    .replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, ' '));
  const a = words(md); const b = words(html);
  const at = a.findIndex((w, i) => w !== b[i]);
  assert.equal(at, -1, `first difference at word ${at}: md "${a.slice(at, at + 8).join(' ')}" vs html "${b.slice(at, at + 8).join(' ')}"`);
  assert.equal(a.length, b.length);
  for (const text of [md, html]) {
    assert.doesNotMatch(text, /usual activity|⚠ Warning|POO Dogs|Start\s+Walk\b/);
    assert.match(text, /default activity/);
    assert.match(text, /double tap/);
  }
});

test('the Playgroup desk header photo keeps its size on a phone', () => {
  assert.match(read('public/css/playgroup.css'), /\.dog-head img \{[^}]*flex-shrink: 0;/);
});
