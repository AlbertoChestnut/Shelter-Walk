// @ tagging offers dogs that left in the last 3 months, marked and listed
// after the dogs still here, the longest gone last (owner, 2026-11-11).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PG_TAGS_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pg-tags.js'), 'utf8');
const window = { matchMedia: () => ({ matches: false }) };
vm.runInNewContext(PG_TAGS_JS, { window, document: { addEventListener() {} }, Intl, Date });
const { taggableFrom } = window.PgTags;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const DOGS = [
  { id: 1, name: 'Rex', stillListed: true, leftAt: null },
  { id: 2, name: 'Bella', stillListed: false, location: 'In Foster', leftAt: daysAgo(200) },
  { id: 3, name: 'Remy', stillListed: false, leftAt: daysAgo(10) },
  { id: 4, name: 'Rocky', stillListed: false, leftAt: daysAgo(60) },
  { id: 5, name: 'Rusty', stillListed: false, leftAt: daysAgo(120) },
  { id: 6, name: 'Ash', stillListed: false, leftAt: null }
];

test('dogs still here, in foster, or gone under 3 months; the gone ones marked', () => {
  const list = taggableFrom(DOGS);
  assert.deepEqual(list.map((d) => d.id).sort(), [1, 2, 3, 4]);
  assert.deepEqual(list.filter((d) => d.gone).map((d) => d.id).sort(), [3, 4]);
  assert.deepEqual(taggableFrom(DOGS, (d) => d.id !== 3).map((d) => d.id).sort(), [1, 2, 4], 'keep narrows the list');
});

test('the picker lists dogs still here first, then the gone ones, most recently left first', () => {
  const src = PG_TAGS_JS;
  assert.match(src, /\.sort\(tagOrder\(q\)\)/, 'the @ picker sorts with tagOrder');
  assert.match(src, /d\.name\.toLowerCase\(\) === needle\)\.sort\(tagOrder\(\)\)/, 'so does the auto-tagger');
  const tagOrder = vm.runInNewContext(`${src.slice(src.indexOf('function tagOrder'), src.indexOf('// The small line next to a name'))}; tagOrder`);
  const list = taggableFrom(DOGS).filter((d) => d.name.toLowerCase().includes('r') || d.id === 2).sort(tagOrder('r'));
  assert.deepEqual(list.map((d) => d.name), ['Rex', 'Bella', 'Remy', 'Rocky'], 'here (name match first), then left 10 days ago, then 60');
});

test('a gone dog reads "Left <date>" in the pick list', () => {
  assert.match(PG_TAGS_JS, /pg-suggest-gone">Left \$\{/);
  assert.match(PG_TAGS_JS, /pg-suggest-item\$\{i === sel \? ' active' : ''\}\$\{d\.gone \? ' gone' : ''\}/);
});
