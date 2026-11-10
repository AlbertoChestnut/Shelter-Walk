// The Guide's one-time fix for the first seed's fill-in-the-blank contact
// placeholders (wikiSeed.js replacedLines, applied in wiki.js): replaces only
// lines that still read exactly the old text, once per database, and never
// touches what staff wrote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolateEnv } = require('./_helpers');

isolateEnv('sw-docs-');
const express = require('express');
const db = require('../src/db');

// wikiSeed.js holds the shelter's own text and isn't in the public repo.
const hasSeed = fs.existsSync(path.join(__dirname, '..', 'src', 'wikiSeed.js'));

const PLACEHOLDERS = [
  '- **Volunteer coordinator**: (add name and number)',
  '- **Front desk**: (add number)',
  '- Add the shelter\'s closed days here.'
];

test('seed placeholders are replaced once, staff edits are kept', { skip: !hasSeed && 'wikiSeed.js not present' }, () => {
  const now = new Date().toISOString();
  // A database seeded before the fix: wiki already seeded, every added
  // section already inserted, so register() only runs the line fix.
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_seeded', '1')").run();
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_removed_using_app', '1')").run();
  for (const s of require('../src/wikiSeed').addedSections()) {
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, '1')").run(s.key);
  }
  const insert = db.prepare('INSERT INTO wiki_sections (title, icon, body, sort_order, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const untouched = insert.run('Contacts and shelter info', '☎️', ['## Who to ask', ...PLACEHOLDERS].join('\n'), 1, now, now, 'demo').lastInsertRowid;
  const staffBody = [
    '## Who to ask',
    '- **Volunteer coordinator**: Sam, 555-0100',
    '- **Front desk**: (add number) or just walk up',
    '- Add the shelter\'s closed days here.'
  ].join('\n');
  const edited = insert.run('Contacts (staff edited)', '☎️', staffBody, 2, now, now, 'Staff Person').lastInsertRowid;

  const register = () => require('../src/wiki').register(express(), { db, resolveAuthedUser: () => null });
  register();

  const body = (id) => db.prepare('SELECT body, updated_by AS by FROM wiki_sections WHERE id = ?').get(id);
  const fixed = body(untouched).body;
  for (const p of PLACEHOLDERS) assert.ok(!fixed.includes(p), `still has: ${p}`);
  assert.doesNotMatch(fixed, /\(add /);
  assert.match(fixed, /front desk/);

  const kept = body(edited);
  assert.match(kept.body, /Sam, 555-0100/);
  assert.match(kept.body, /\(add number\) or just walk up/, 'a changed line is left alone');
  assert.ok(!kept.body.includes('- Add the shelter\'s closed days here.'), 'an unchanged placeholder line in the same section is fixed');
  assert.strictEqual(kept.by, 'Staff Person', 'the fix is not credited to anyone');
  assert.ok(db.prepare("SELECT 1 FROM app_meta WHERE key = 'wiki_replaced_contact_placeholders'").get());

  // Once only: placeholder text staff type back in later stays.
  db.prepare('UPDATE wiki_sections SET body = ? WHERE id = ?').run(PLACEHOLDERS[0], untouched);
  register();
  assert.strictEqual(body(untouched).body, PLACEHOLDERS[0]);
});

test('a fresh seed has no placeholder text', { skip: !hasSeed && 'wikiSeed.js not present' }, () => {
  const { demoSections, addedSections } = require('../src/wikiSeed');
  for (const s of [...demoSections(), ...addedSections()]) {
    assert.doesNotMatch(s.body, /\(add |add name|add number|closed days here|Add what to do/, s.title);
    assert.doesNotMatch(s.body, /\bTODO\b|\bTBD\b|lorem/i, s.title);
  }
});
