const { pollChannel } = require('./poll');
const { resolveChannelId } = require('./resolveChannel');

const MIGRATIONS = [{
  id: '001_create_tables',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS yt_videos (
        video_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        published_at TEXT,
        discovered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yt_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES yt_videos(video_id),
        dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id),
        matched_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE(video_id, dog_id)
      );
    `);
  }
}];

function register(app, ctx) {
  const { db, migrate, schedule, getConfig, requireStaff, enabledGuard, registerDogEnricher } = ctx;
  migrate(MIGRATIONS);

  function videosForDog(dogId) {
    return db.prepare(`
      SELECT v.video_id AS videoId, v.title, v.url, v.published_at AS publishedAt
      FROM yt_matches m JOIN yt_videos v ON v.video_id = m.video_id
      WHERE m.dog_id = ? AND m.status = 'confirmed'
      ORDER BY v.published_at DESC
    `).all(dogId);
  }
  // GET /api/dogs/:id picks this up automatically (src/server.js's
  // runDogEnrichers) -- no core route code needed for this module.
  registerDogEnricher((dogId) => {
    const videos = videosForDog(dogId);
    return videos.length ? { videos } : {};
  });

  // Every two hours is plenty for a feed that only ever shows the most
  // recent uploads; runOnBoot so a freshly-enabled module doesn't wait up to
  // two hours for its first look.
  schedule('poll-channel', '0 */2 * * *', () => pollChannel({ db, getConfig }), { runOnBoot: true, bootDelayMs: 8000 });

  app.get('/api/modules/youtube-channel/matches', requireStaff, enabledGuard, (req, res) => {
    const rows = db.prepare(`
      SELECT m.id, m.dog_id AS dogId, d.name AS dogName, m.matched_text AS matchedText,
             v.video_id AS videoId, v.title AS videoTitle, v.url AS videoUrl, v.published_at AS publishedAt
      FROM yt_matches m
      JOIN yt_videos v ON v.video_id = m.video_id
      JOIN dogs d ON d.shelter_buddy_id = m.dog_id
      WHERE m.status = 'pending'
      ORDER BY v.published_at DESC
    `).all();
    res.json({ matches: rows });
  });

  app.put('/api/modules/youtube-channel/matches/:id', requireStaff, enabledGuard, (req, res) => {
    const { action } = req.body || {};
    if (!['confirm', 'dismiss'].includes(action)) return res.status(400).json({ error: 'action must be confirm or dismiss' });
    const row = db.prepare("SELECT id FROM yt_matches WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'No pending match with that id.' });
    db.prepare('UPDATE yt_matches SET status = ?, reviewed_at = ? WHERE id = ?')
      .run(action === 'confirm' ? 'confirmed' : 'dismissed', new Date().toISOString(), req.params.id);
    res.json({ ok: true });
  });
}

// Called by src/modules.js's PUT /api/modules/:id, before saving, whenever
// config.channelId is part of the request -- resolves whatever link/handle/
// id was entered into the canonical channel id poll.js needs, or throws
// (caught there, turned into a 400) if it can't find a channel there at all.
// A blank value is left alone (clearing the field shouldn't require a
// network round-trip, and a blank channelId is what makes pollChannel() a
// no-op).
async function resolveConfig(config) {
  if (!config.channelId) return config;
  return { ...config, channelId: await resolveChannelId(config.channelId) };
}

module.exports = { register, resolveConfig };
