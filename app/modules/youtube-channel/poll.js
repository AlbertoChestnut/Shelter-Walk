// The actual job: fetch the channel's feed, record any video not already
// seen, and run it through dog-name matching. Pulled out as a standalone
// exported function (not a closure inside register()) specifically so a
// test can call it directly against a stubbed fetch, the same way
// src/scraper.js exports runScrape for test/scraper.test.js to drive.
const { parseFeed } = require('./feedParser');
const { findDogMatches } = require('./matcher');

const USER_AGENT = 'dogwalk-personal-tracker/1.0 (+personal use, youtube-channel module)';
// Overridable so a test can point at a fake feed server instead of the real
// internet, without needing to stub the global fetch.
const FEED_BASE = process.env.YOUTUBE_FEED_BASE_URL || 'https://www.youtube.com/feeds/videos.xml';

async function fetchFeedXml(channelId) {
  const res = await fetch(`${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Feed request failed: HTTP ${res.status}`);
  return res.text();
}

// { db, getConfig } -- getConfig() returns the module's live config object
// ({channelId}). Returns a small summary object, mostly for tests/logging.
async function pollChannel({ db, getConfig }) {
  const { channelId } = getConfig() || {};
  if (!channelId) return { skipped: true };

  const xml = await fetchFeedXml(channelId);
  const entries = parseFeed(xml);

  const dogs = db.prepare('SELECT shelter_buddy_id AS id, name, previous_names FROM dogs').all()
    .map((d) => ({ id: d.id, names: [d.name, ...JSON.parse(d.previous_names || '[]')] }));

  const seen = db.prepare('SELECT 1 FROM yt_videos WHERE video_id = ?');
  const insertVideo = db.prepare('INSERT INTO yt_videos (video_id, title, description, url, published_at, discovered_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertMatch = db.prepare("INSERT OR IGNORE INTO yt_matches (video_id, dog_id, matched_text, status, created_at) VALUES (?, ?, ?, 'pending', ?)");
  const now = new Date().toISOString();
  let newVideos = 0;
  let newMatches = 0;

  for (const e of entries) {
    // A video already on record is never re-matched, even against a dog
    // added to the system after it was first seen -- a known v1 limitation,
    // not a bug: re-scanning every historical video on every poll would
    // grow steadily more expensive, and the feed only ever gives the ~15
    // most recent uploads anyway, so the backlog it could even catch is
    // already small and shrinking.
    if (seen.get(e.videoId)) continue;
    db.transaction(() => {
      insertVideo.run(e.videoId, e.title, e.description, e.url, e.publishedAt || null, now);
      newVideos += 1;
      for (const m of findDogMatches(`${e.title}\n${e.description}`, dogs)) {
        const info = insertMatch.run(e.videoId, m.dogId, m.matchedText, now);
        if (info.changes) newMatches += 1;
      }
    })();
  }
  return { newVideos, newMatches, entriesSeen: entries.length };
}

module.exports = { pollChannel };
