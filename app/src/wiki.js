// Guide / wiki: staff-editable sections (sticker meanings, tips for
// newcomers, how the app works, ...) shown in the app's Guide view.
// Everyone can read; staff and privileged walkers can add/edit/reorder/delete
// sections and upload images. Bodies are lightweight markdown, rendered
// (escaped-first) by renderMarkdown() in the frontend.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const WIKI_IMAGES_DIR = path.join(__dirname, '..', 'data', 'wiki-images');
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

const STICKER = (name) => `/wiki/stickers/${name}.svg`;

// Demo content, seeded once (never re-seeded after that, so deleting or
// rewriting a section sticks). Staff should edit these to match real
// shelter policy -- the sticker meanings mirror the app's own marker names.
function demoSections() {
  const sticker = (file, title, text) => `- ![${title}](${STICKER(file)}) **${title}**: ${text}`;
  return [
    {
      icon: '🏷️',
      title: 'Sticker meanings',
      body: [
        '> Demo content. Staff can edit this section (tap Edit) to match shelter policy.',
        '',
        'Kennel cards and the app show small stickers for each dog. Tap any dog\'s stickers in the app to see what they mean.',
        '',
        '## Behavior stickers (blue)',
        'A blue sticker is a heads-up about something to plan for. It is not a reason to skip a dog, just a reason to be prepared.',
        '',
        sticker('blue_c', 'C: Difficult to collar', 'may dodge or resist having a collar or leash put on. Go slowly, stay calm, and ask staff if you need a hand.'),
        sticker('blue_d', 'D: Door dasher', 'tends to bolt through doors and gates. Keep the dog controlled at every doorway.'),
        sticker('blue_e', 'E: Energetic', 'lots of energy. Expect a strong, fast walk and plenty of enthusiasm.'),
        sticker('blue_h', 'H: Humpy', 'may try to mount people or other dogs when excited. Redirect calmly.'),
        sticker('blue_j', 'J: Jumpy', 'jumps up on people. Turn away and reward four paws on the floor.'),
        sticker('blue_m', 'M: Mouthy', 'uses their mouth a lot when excited or playing. Keep treats and toys handy to redirect.'),
        sticker('blue_p', 'P: Puller', 'pulls hard on the leash. A firm grip and steady pace help. Newer volunteers should ask about equipment.'),
        sticker('blue_q', 'Q: Quirky', 'has a quirk worth knowing about. Check the notes from past walks for specifics.'),
        sticker('blue_r', 'R: Reactive', 'may react to other dogs, people, or sounds. Give other dogs plenty of space.'),
        sticker('blue_s', 'S: Shy / shutdown', 'can be shy or freeze up. Move gently, let them set the pace, and do not force interaction.'),
        sticker('blue_evo', 'EVO: Experienced volunteers only', 'only walked by volunteers at the Experienced level. The app blocks everyone else from starting a walk with these dogs.'),
        '',
        '## Yellow stickers',
        sticker('poo', 'POO', 'Potty Outside Only. This dog should go outside to eliminate rather than in the play yards.'),
        sticker('poo_priority', 'POO priority (asterisk)', 'high priority potty dog. First one out in the morning and last one out in the evening.'),
        sticker('pb', 'PB: Potty break OK', 'a short, potty-focused walk only. Get them out, let them go, bring them back.'),
        '',
        '## Other indicators',
        sticker('star', 'Gold star', 'good for beginners. A great first choice if you are new.'),
        sticker('star_pending', 'Grey star', 'normally a beginner-friendly dog, but greyed out because someone has started adopting them, so beginners cannot walk them right now.'),
        sticker('adopted', 'Adopted (purple)', 'someone has started the adoption process ("I\'m getting adopted!" on the shelter website). Beginners cannot walk these dogs; Established and Experienced volunteers can.')
      ].join('\n')
    },
    {
      icon: '🌱',
      title: 'Tips for new volunteers',
      body: [
        '> Demo content. Staff can edit this section.',
        '',
        '## Picking your first dogs',
        '- Look for the **gold star**. Those dogs are the best fit for new walkers.',
        '- Use the **Beginner** preset in the Filters panel to hide anything with behavior stickers.',
        '- The Available list shows a green **Eligible** badge when a dog is cleared for your level.',
        '',
        '## Before you leave the kennel',
        '1. Read the sticker meanings for that dog (tap their stickers).',
        '2. Skim the notes from past walks. Other volunteers leave useful tips.',
        '3. Write the check-out time on the kennel card.',
        '',
        '## During the walk',
        '- Keep a firm grip on the leash and stay aware of your surroundings.',
        '- Give other dogs space, especially dogs with an **R** sticker.',
        '- Keep the walk to the amount of time the dog needs, not the amount of time you have.',
        '',
        '## After the walk',
        '- Return the dog to the **same kennel** you took them from.',
        '- Add a short note about how it went. It helps the next volunteer.',
        '- Wash your hands and thank the dog.'
      ].join('\n')
    },
    {
      icon: '🐕',
      title: 'Experience levels',
      body: [
        '> Demo content. Staff can edit this section.',
        '',
        'Your level controls which dogs the app lets you walk. Change it any time from the gear icon (Settings).',
        '',
        '## Beginner',
        'Less than 20 hours of volunteering.',
        '- Dogs must have been in the shelter at least 15 days.',
        '- No behavior (blue) stickers, no PB dogs, no dogs that are pending adoption.',
        '',
        '## Established',
        '20 hours or more.',
        '- Dogs must have been in the shelter at least 7 days.',
        '- Behavior stickers, PB dogs, and pending-adoption dogs are OK. EVO dogs are not.',
        '',
        '## Experienced Volunteer',
        '1 year and 100 hours of service.',
        '- Everything above, including EVO dogs.',
        '',
        'Puppies 6 months or younger can never be walked, at any level.'
      ].join('\n')
    },
    {
      icon: '📱',
      title: 'Using Shelter Walk',
      body: [
        '> Demo content. Staff can edit this section.',
        '',
        '## Starting a walk',
        '1. Open the **Available** tab, or tap **Scan** and scan the QR code on the kennel.',
        '2. Tap **Walk / Edit** on the dog, check the details, then tap **Start Walk**.',
        '3. The timer screen shows the check-out time and where to return the dog.',
        '',
        '## Finishing a walk',
        '1. Tap **End Walk**, add a note if you like, then **Save & Finish**.',
        '2. Started by mistake? Tap **Cancel Walk** and nothing is recorded.',
        '',
        '## Time limit',
        'Walks **stop automatically after 20 minutes** so a forgotten End Walk never ties up a dog. Still walking? Tap **+10 min** on the walk screen. If it ran long anyway, fix the time in Stats: an "Auto-stopped" badge marks these walks.',
        '',
        '## The tabs',
        '- **Available**: every dog you can walk, with filters and sorting.',
        '- **Scan**: scan a kennel QR code, or see your walk in progress.',
        '- **Stats**: how today went, and your lifetime totals.',
        '- **Updates**: new dogs, returned dogs, and adoptions.',
        '',
        '## Good to know',
        '- Tap a dog\'s photo for a full-size view.',
        '- Install the app to your Home Screen for the best experience (and for notifications on iPhone).',
        '- Turn on notifications in Settings to get a reminder of where to return your dog.'
      ].join('\n')
    },
    {
      icon: '☎️',
      title: 'Contacts and shelter info',
      body: [
        '> Demo content. Replace with your real contacts, hours, and policies.',
        '',
        '## Who to ask',
        '- **Volunteer coordinator**: (add name and number)',
        '- **Front desk**: (add number)',
        '',
        '## Hours',
        '- Add walking hours and any closed days here.',
        '',
        '## Emergencies',
        '- Add what to do if a dog is hurt, gets loose, or a volunteer needs help.'
      ].join('\n')
    }
  ];
}

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
  app.post('/api/wiki/images', requireEditor,
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
