// A dog silhouette drawn from a dog's Animal ID: the stand-in picture until
// the shelter's listing has a photo (a kennel card scanned before the dog
// was listed, or a listing with no photo yet). The same ID always draws the
// same dog, and different IDs mix build, ears, tail, pose and colors, so
// several dogs without photos still look different at a glance.

// Bump when the drawing changes, so cached copies (cache-first in sw.js) refresh.
const SILHOUETTE_VERSION = 1;

const BACKGROUNDS = ['#e8f1ec', '#f3ece2', '#e6eef6', '#f4e8ec', '#efeedf', '#e9e6f3', '#e3f0f0', '#f5efe0'];
const COATS = ['#2f4f3f', '#4a3b2f', '#3d4654', '#5a3d2b', '#2d3a4a', '#4b4b4b', '#6b4a2e', '#384a3a'];

// mulberry32: a small seeded PRNG, so a dog's drawing never changes.
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;

function dogSilhouetteSvg(id) {
  // Spread neighbouring IDs (262826, 262827...) far apart before seeding.
  const rand = rng(Math.imul(Number(id) || 0, 2654435761));
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const bg = pick(BACKGROUNDS);
  const coat = pick(COATS);
  const bodyLen = between(38, 58);
  const bodyH = between(15, 26);
  const legLen = between(13, 24);
  const legW = between(5, 8);
  const headR = between(8.5, 13.5);
  const snoutLen = between(5, 14);
  const neckLift = between(0, 9);
  const ears = pick(['pointy', 'floppy', 'round', 'folded']);
  const tail = pick(['curl', 'straight', 'down', 'stub', 'plume']);
  const tailW = between(3, 5);
  const walking = rand() < 0.5;
  const facingLeft = rand() < 0.5;

  // Drawn facing right around a body centre, then fitted into the frame.
  const rx = bodyLen / 2;
  const ry = bodyH / 2;
  const cx = 50;
  const cy = 50;
  const ground = cy + ry + legLen;
  const hx = cx + rx * 0.85 + headR * 0.5;
  const hy = cy - ry - headR * 0.55 - neckLift;
  const parts = [];

  parts.push(`<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}"/>`);
  // Neck, head, snout, and an eye cut out in the background colour.
  parts.push(`<line x1="${r1(cx + rx * 0.55)}" y1="${r1(cy - ry * 0.1)}" x2="${r1(hx - headR * 0.2)}" y2="${r1(hy + headR * 0.3)}" stroke-width="${r1(headR * 1.15)}"/>`);
  parts.push(`<circle cx="${r1(hx)}" cy="${r1(hy)}" r="${r1(headR)}"/>`);
  const snoutH = headR * 0.8;
  parts.push(`<rect x="${r1(hx)}" y="${r1(hy - snoutH * 0.15)}" width="${r1(headR * 0.55 + snoutLen)}" height="${r1(snoutH)}" rx="${r1(snoutH / 2)}"/>`);

  // Ears, from the back of the head.
  const ex = hx - headR * 0.25;
  const ey = hy - headR * 0.75;
  const earLen = headR * between(0.9, 1.4);
  if (ears === 'pointy') {
    parts.push(`<polygon points="${r1(ex - headR * 0.45)},${r1(ey + 3)} ${r1(ex)},${r1(ey - earLen)} ${r1(ex + headR * 0.4)},${r1(ey + 3)}"/>`);
  } else if (ears === 'floppy') {
    parts.push(`<ellipse cx="${r1(hx - headR * 0.6)}" cy="${r1(hy + headR * 0.15)}" rx="${r1(headR * 0.38)}" ry="${r1(headR * 0.8)}" transform="rotate(18 ${r1(hx - headR * 0.6)} ${r1(hy + headR * 0.15)})"/>`);
  } else if (ears === 'round') {
    parts.push(`<circle cx="${r1(ex)}" cy="${r1(ey)}" r="${r1(headR * 0.45)}"/>`);
  } else {
    parts.push(`<polygon points="${r1(ex - headR * 0.45)},${r1(ey + 3)} ${r1(ex + headR * 0.1)},${r1(ey - earLen * 0.7)} ${r1(ex + headR * 0.7)},${r1(ey - earLen * 0.25)}"/>`);
  }

  // Legs: a front pair and a back pair, one of each forward when walking.
  const stride = walking ? between(3, 6) : 0;
  const legs = [
    [cx + rx * 0.62, stride], [cx + rx * 0.38, -stride * 0.4],
    [cx - rx * 0.5, -stride], [cx - rx * 0.75, stride * 0.4]
  ];
  for (const [x, dx] of legs) {
    parts.push(`<line x1="${r1(x)}" y1="${r1(cy)}" x2="${r1(x + dx)}" y2="${r1(ground)}" stroke-width="${r1(legW)}"/>`);
  }

  // Tail, from the rump.
  const bx = cx - rx * 0.92;
  const by = cy - ry * 0.35;
  const tailPaths = {
    curl: `M${r1(bx)},${r1(by)} Q${r1(bx - 12)},${r1(by - 12)} ${r1(bx - 3)},${r1(by - 20)}`,
    straight: `M${r1(bx)},${r1(by)} L${r1(bx - 12)},${r1(by - 11)}`,
    down: `M${r1(bx)},${r1(by)} Q${r1(bx - 9)},${r1(by + 3)} ${r1(bx - 10)},${r1(by + 15)}`,
    stub: `M${r1(bx)},${r1(by)} L${r1(bx - 5)},${r1(by - 4)}`,
    plume: `M${r1(bx)},${r1(by)} Q${r1(bx - 14)},${r1(by - 4)} ${r1(bx - 9)},${r1(by - 17)}`
  };
  const tw = tail === 'plume' ? tailW + 2.5 : tail === 'stub' ? tailW + 1.5 : tailW;
  parts.push(`<path d="${tailPaths[tail]}" fill="none" stroke-width="${r1(tw)}"/>`);

  // Fit the whole dog into the 100x100 frame with a margin, standing on a
  // common ground line, then flip half of them to face left.
  const minX = Math.min(bx - 16, cx - rx - legW);
  const maxX = hx + headR * 0.55 + snoutLen + 1;
  const minY = Math.min(ey - earLen - 2, by - 22, hy - headR);
  const maxY = ground + legW / 2;
  const scale = Math.min(80 / (maxX - minX), 74 / (maxY - minY));
  const tx = 50 - ((minX + maxX) / 2) * scale;
  const ty = 88 - maxY * scale;
  const fit = `translate(${r1(tx)} ${r1(ty)}) scale(${Math.round(scale * 1000) / 1000})`;
  const flip = facingLeft ? 'translate(100 0) scale(-1 1) ' : '';
  const eye = `<circle cx="${r1(hx + headR * 0.3)}" cy="${r1(hy - headR * 0.2)}" r="${r1(headR * 0.13)}" fill="${bg}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200" role="img" aria-label="Dog silhouette">` +
    `<rect width="100" height="100" fill="${bg}"/>` +
    `<g transform="${flip}${fit}" fill="${coat}" stroke="${coat}" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}${eye}</g>` +
    '</svg>';
}

const silhouetteUrl = (id) => `/dog-silhouettes/${Number(id)}.svg?v=${SILHOUETTE_VERSION}`;

module.exports = { dogSilhouetteSvg, silhouetteUrl, SILHOUETTE_VERSION };
