// Readability standard (owner, 2026-11-11): many volunteers are older, so no
// text in the app is smaller than 0.85rem (13.6px), or 13px in px units.
// That covers CSS files and inline style="" in the JS/HTML that builds
// pages. The only exceptions are one or two characters inside a fixed-size
// dot or count bubble, and those must say so on the same line:
//   font-size: 0.6rem; /* text-size-ok: <why> */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['public', 'modules'];
const TEXT = /\.(js|html|css)$/i;
const MIN = { rem: 0.85, em: 0.85, px: 13 };

function filesIn(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...filesIn(full)); } else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

test('readability: no text below the minimum size', () => {
  const hits = [];
  for (const file of DIRS.flatMap((d) => filesIn(path.join(ROOT, d)))) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/text-size-ok:/.test(line)) return;
      for (const m of line.matchAll(/font-size:\s*(\d*\.?\d+)(rem|em|px)\b/g)) {
        if (Number(m[1]) < MIN[m[2]]) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${m[0]} (minimum ${MIN[m[2]]}${m[2]})`);
      }
    });
  }
  assert.deepEqual(hits, [], `\n${hits.join('\n')}`);
});
