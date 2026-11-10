// Guide / wiki: staff-editable sections (sticker meanings, tips for
// newcomers, how the app works, ...) shown in the app's Guide view.
// Everyone can read; staff and privileged walkers can add/edit/reorder/delete
// sections and upload images. Bodies are lightweight markdown, rendered
// (escaped-first) by renderMarkdown() in the frontend.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// WIKI_IMAGES_DIR lets tests and throwaway servers keep uploads out of the real folder.
const WIKI_IMAGES_DIR = process.env.WIKI_IMAGES_DIR || path.join(__dirname, '..', 'data', 'wiki-images');
fs.mkdirSync(WIKI_IMAGES_DIR, { recursive: true });

const MAX_TITLE = 120;
const MAX_BODY = 30000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// Magic-byte sniffing: never trust the client-declared content type for
// something we're going to serve back to other users.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

// Starter content, seeded once (never re-seeded after that, so deleting or
// rewriting a section sticks). The shelter's real starter text is in
// wikiSeed.js, which isn't in the public repo; without it the Guide starts
// with one generic section for staff to replace.
let seedContent;
try {
  seedContent = require('./wikiSeed');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  seedContent = {
    demoSections: () => [{
      icon: '📖',
      title: 'Welcome',
      body: 'Staff can add sections here: what the kennel stickers mean, tips for new volunteers, contacts, and shelter policies.'
    }],
    addedSections: () => []
  };
}
const { demoSections, addedSections } = seedContent;
const replacedLines = seedContent.replacedLines || (() => []);

function register(app, { db, resolveAuthedUser }) {
  const seeded = db.prepare("SELECT value FROM app_meta WHERE key = 'wiki_seeded'").get();
  if (!seeded) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO wiki_sections (title, icon, body, sort_order, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.transaction(() => {
      demoSections().forEach((s, i) => insert.run(s.title, s.icon, s.body, i + 1, now, now, 'demo'));
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_seeded', '1')").run();
    })();
  }
  // "Using Shelter Walk" was folded into the tutorial page (/tutorial.html),
  // which the Guide shows first as "How to use Shelter Walk". Removed once,
  // so staff can still add a section with that title later.
  if (!db.prepare("SELECT value FROM app_meta WHERE key = 'wiki_removed_using_app'").get()) {
    db.transaction(() => {
      db.prepare("DELETE FROM wiki_sections WHERE title = 'Using Shelter Walk'").run();
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_removed_using_app', '1')").run();
    })();
  }
  for (const s of addedSections()) {
    if (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(s.key)) continue;
    const now = new Date().toISOString();
    db.transaction(() => {
      const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM wiki_sections').get().m;
      db.prepare(
        'INSERT INTO wiki_sections (title, icon, body, sort_order, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(s.title, s.icon, s.body, max + 1, now, now, 'demo');
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, '1')").run(s.key);
    })();
  }
  // Seed lines fixed after the first seed (e.g. fill-in-the-blank
  // placeholders), once per database. Only a line that still reads exactly
  // the old text is replaced, so staff edits are never overwritten.
  for (const r of replacedLines()) {
    if (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(r.key)) continue;
    const swap = new Map(r.lines);
    db.transaction(() => {
      for (const row of db.prepare('SELECT id, body FROM wiki_sections').all()) {
        const body = row.body.split('\n').map((line) => (swap.has(line) ? swap.get(line) : line)).join('\n');
        if (body !== row.body) {
          // updated_at/updated_by are left alone: nobody edited the section,
          // so "last edited by" shouldn't name someone for this.
          db.prepare('UPDATE wiki_sections SET body = ? WHERE id = ?').run(body, row.id);
        }
      }
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, '1')").run(r.key);
    })();
  }

  // Everyone signed in can read; staff (Django flag) or privileged walkers
  // can change anything. Enforced server-side, not just hidden in the UI.
  function canEdit(req) {
    if (req.headers['x-auth-staff'] === '1') return true;
    const user = resolveAuthedUser(req);
    return !!(user && user.isPrivileged);
  }
  function requireEditor(req, res, next) {
    if (!canEdit(req)) return res.status(403).json({ error: 'Only staff can edit the Guide.' });
    next();
  }
  function editorName(req) {
    const user = resolveAuthedUser(req);
    return user ? user.name : 'staff';
  }
  function cleanFields(body) {
    const title = String((body && body.title) || '').trim().slice(0, MAX_TITLE);
    const icon = String((body && body.icon) || '').trim().slice(0, 8);
    const text = String((body && body.body) || '');
    if (!title) return { error: 'A title is required.' };
    if (text.length > MAX_BODY) return { error: `Text is too long (max ${MAX_BODY} characters).` };
    return { title, icon: icon || null, body: text };
  }

  app.get('/api/wiki', (req, res) => {
    const sections = db.prepare(
      'SELECT id, title, icon, body, sort_order AS sortOrder, updated_at AS updatedAt, updated_by AS updatedBy FROM wiki_sections ORDER BY sort_order, id'
    ).all();
    res.json({ sections, canEdit: canEdit(req) });
  });

  app.post('/api/wiki', requireEditor, (req, res) => {
    const f = cleanFields(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    const now = new Date().toISOString();
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM wiki_sections').get().m;
    const info = db.prepare(
      'INSERT INTO wiki_sections (title, icon, body, sort_order, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(f.title, f.icon, f.body, max + 1, now, now, editorName(req));
    res.json({ id: info.lastInsertRowid });
  });

  app.put('/api/wiki/:id', requireEditor, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const f = cleanFields(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    const info = db.prepare(
      'UPDATE wiki_sections SET title = ?, icon = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?'
    ).run(f.title, f.icon, f.body, new Date().toISOString(), editorName(req), id);
    if (info.changes === 0) return res.status(404).json({ error: 'Section not found' });
    res.json({ id });
  });

  app.put('/api/wiki/:id/move', requireEditor, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const dir = req.body && req.body.direction === 'up' ? -1 : 1;
    const rows = db.prepare('SELECT id FROM wiki_sections ORDER BY sort_order, id').all().map((r) => r.id);
    const i = rows.indexOf(id);
    if (i < 0) return res.status(404).json({ error: 'Section not found' });
    const j = i + dir;
    if (j >= 0 && j < rows.length) {
      [rows[i], rows[j]] = [rows[j], rows[i]];
      const set = db.prepare('UPDATE wiki_sections SET sort_order = ? WHERE id = ?');
      db.transaction(() => rows.forEach((sid, idx) => set.run(idx + 1, sid)))();
    }
    res.json({ ok: true });
  });

  app.delete('/api/wiki/:id', requireEditor, (req, res) => {
    const info = db.prepare('DELETE FROM wiki_sections WHERE id = ?').run(parseInt(req.params.id, 10));
    if (info.changes === 0) return res.status(404).json({ error: 'Section not found' });
    res.json({ ok: true });
  });

  // Raw image upload (the request body IS the file). Stored under a
  // content-hash name, so re-uploading the same picture is free and names
  // can't be guessed/overwritten.
  // Only an image Content-Type is taken (server.js lets this route skip its
  // JSON-only rule for that): a cross-site form can't send one.
  app.post('/api/wiki/images', requireEditor,
    (req, res, next) => (/^image\//i.test(String(req.headers['content-type'] || '').trim())
      ? next() : res.status(415).json({ error: 'Upload an image file (JPEG, PNG, WebP or GIF).' })),
    express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'No image received.' });
      const ext = sniffImage(buf);
      if (!ext) return res.status(400).json({ error: 'That file is not a JPEG, PNG, WebP, or GIF image.' });
      const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
      const file = path.join(WIKI_IMAGES_DIR, name);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(`${file}.tmp`, buf);
        fs.renameSync(`${file}.tmp`, file);
      }
      res.json({ url: `/wiki-images/${name}` });
    });

  // Uploaded images are content-addressed, so they can be cached hard.
  app.use('/wiki-images', express.static(WIKI_IMAGES_DIR, { maxAge: '365d', immutable: true }));
}

module.exports = { register, WIKI_IMAGES_DIR };
