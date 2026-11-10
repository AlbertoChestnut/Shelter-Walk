// List thumbnails (2026-11-10): /cached-images/thumbs/<id>.jpg is made from the
// cached photo with sharp on first use, remade when the photo changes, and the
// app's list cards ask for it instead of the ~1024px original.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startServer } = require('./_helpers');

let server;
const auth = { headers: { 'x-auth-email': 'thumbs@example.com' } };
test.before(async () => { server = await startServer({ prefix: 'sw-thumbs-' }); });
test.after(async () => { if (server) await server.stop(); });

const imagesDir = () => path.join(server.dir, 'images');
const photo = (color) => sharp({ create: { width: 1024, height: 768, channels: 3, background: color } }).jpeg().toBuffer();

test('a thumbnail is a small JPEG made from the cached photo, and follows a replaced photo', async () => {
  const src = path.join(imagesDir(), '4242.jpg');
  fs.mkdirSync(imagesDir(), { recursive: true });
  fs.writeFileSync(src, await photo('#c00'));
  const res = await fetch(`${server.base}/cached-images/thumbs/4242.jpg`, auth);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  assert.deepEqual([meta.width, meta.height], [160, 160]);
  assert.ok(buf.length < fs.statSync(src).size, 'smaller than the original');

  // The scraper replaces the photo: the next request makes a new thumbnail.
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(src, await photo('#00c'));
  const again = Buffer.from(await (await fetch(`${server.base}/cached-images/thumbs/4242.jpg`, auth)).arrayBuffer());
  const { dominant } = await sharp(again).stats();
  assert.ok(dominant.b > dominant.r, 'made from the new photo');
});

test('no photo, no thumbnail; odd paths are refused', async () => {
  assert.equal((await fetch(`${server.base}/cached-images/thumbs/999999.jpg`, auth)).status, 404);
  for (const p of ['/cached-images/thumbs/..%2F4242.jpg', '/cached-images/thumbs/4242.jpg.lastmod', '/cached-images/thumbs/abc.jpg']) {
    assert.equal((await fetch(server.base + p, auth)).status, 404, p);
  }
});

test('list cards ask for the thumbnail; the profile keeps the full photo', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const listImgs = app.match(/class="dog-photo(?: small)?" src="\$\{[^"]*(?:photoUrl|photo_url)[^"]*\}"/g) || [];
  assert.ok(listImgs.length >= 10);
  for (const img of listImgs) assert.match(img, /thumbOf\(/, img);
  assert.match(app, /class="profile-photo[^`]*src="\$\{esc\(dog\.photoUrl\)\}"/);
});
