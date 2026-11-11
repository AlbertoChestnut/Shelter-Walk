// House wording, checked over every file people's screens are built from
// (src/, public/, modules/), comments included so a copied line can't carry
// the old spelling back in.
//   - "Playgroup" is one word (owner, 2026-11-10): never "play group" or
//     "play-group", in any case, even split over two lines of a comment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The repo's docs (../docs, ../README.md) too (audit 3): people read them as
// much as the screens. They sit outside app/, so a copy of app/ alone (a
// deploy) just skips them.
const DIRS = ['src', 'public', 'modules', '../docs'];
const FILES = ['../README.md'];
const TEXT = /\.(js|html|css|json|md|txt|svg)$/i;

function filesIn(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...filesIn(full)); } else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

const RULES = [
  { pattern: /play(?:[\s-]|\n\s*(?:\/\/|\*|<!--)?)+group/gi, fix: 'Playgroup is one word' }
];

test('house wording: no banned spellings in the app source', () => {
  const hits = [];
  const files = [
    ...DIRS.map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d)).flatMap(filesIn),
    ...FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))
  ];
  assert.ok(files.some((f) => /README\.md$/.test(f)) || !fs.existsSync(path.join(ROOT, '..', 'docs')), 'README.md is scanned');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { pattern, fix } of RULES) {
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${path.relative(ROOT, file)}:${line}: "${m[0].replace(/\s+/g, ' ')}" (${fix})`);
      }
    }
  }
  assert.deepEqual(hits, [], `\n${hits.join('\n')}`);
});
