// pollChannel() against a stubbed fetch -- same in-process style as
// test/scraper.test.js (same process, monkey-patched global.fetch),
// needed because this exercises real network-call code, which a
// child-process/HTTP test can't reach into to mock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolateEnv } = require('./_helpers');

isolateEnv('sw-ytpoll-');
const db = require('../src/db');
const { pollChannel } = require('../modules/youtube-channel/poll');

const ENTRY = (videoId, title, description) => `<entry>
  <id>yt:video:${videoId}</id>
  <yt:videoId>${videoId}</yt:videoId>
  <title>${title}</title>
  <published>2026-01-01T00:00:00+00:00</published>
  <media:group><media:description>${description}</media:description></media:group>
</entry>`;

let feedXml = '<feed></feed>';
const realFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('/feeds/videos.xml')) return new Response(feedXml, { status: 200, headers: { 'content-type': 'application/xml' } });
  return realFetch(url);
};

const now = new Date().toISOString();
db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Biscuit', 'Female', '2 Years', '2026-01-01T00:00:00', 1, ?, ?)").run(now, now);
db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (2, 'Juniper', 'Male', '1 Year', '2026-01-01T00:00:00', 1, ?, ?)").run(now, now);

// pollChannel() itself never creates its tables -- that's the module's
// migration, run through ctx.migrate() in server.js's register() call. This
// test bypasses the module system entirely (there's no HTTP server here at
// all), so it sets up the same schema directly.
db.exec(`
  CREATE TABLE IF NOT EXISTS yt_videos (
    video_id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL, published_at TEXT, discovered_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS yt_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES yt_videos(video_id),
    dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id), matched_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT,
    UNIQUE(video_id, dog_id)
  );
`);

const videoCount = () => db.prepare('SELECT COUNT(*) c FROM yt_videos').get().c;
const matchCount = () => db.prepare('SELECT COUNT(*) c FROM yt_matches').get().c;

test('no channelId configured -> no-op, nothing touched', async () => {
  const result = await pollChannel({ db, getConfig: () => ({}) });
  assert.deepEqual(result, { skipped: true });
  assert.equal(videoCount(), 0);
});

test('a new video with a dog mention is recorded with a pending match', async () => {
  feedXml = `<feed>${ENTRY('vid00000001', 'Meet Biscuit!', 'Biscuit loves belly rubs.')}</feed>`;
  const result = await pollChannel({ db, getConfig: () => ({ channelId: 'UCfake' }) });
  assert.equal(result.newVideos, 1);
  assert.equal(result.newMatches, 1);
  assert.equal(videoCount(), 1);
  const match = db.prepare('SELECT * FROM yt_matches').get();
  assert.equal(match.dog_id, 1);
  assert.equal(match.status, 'pending');
  assert.equal(match.matched_text, 'Biscuit');
});

test('polling the same feed again inserts nothing new', async () => {
  const before = { videos: videoCount(), matches: matchCount() };
  const result = await pollChannel({ db, getConfig: () => ({ channelId: 'UCfake' }) });
  assert.equal(result.newVideos, 0);
  assert.equal(result.newMatches, 0);
  assert.equal(videoCount(), before.videos);
  assert.equal(matchCount(), before.matches);
});

test('a video with no dog mention is recorded with no match', async () => {
  feedXml = `<feed>${ENTRY('vid00000002', 'Shelter open house this weekend', 'Come visit us!')}</feed>`;
  const result = await pollChannel({ db, getConfig: () => ({ channelId: 'UCfake' }) });
  assert.equal(result.newVideos, 1);
  assert.equal(result.newMatches, 0);
});

test('a video mentioning two dogs gets a match for each', async () => {
  feedXml = `<feed>${ENTRY('vid00000003', 'Biscuit and Juniper play together', 'A fun afternoon.')}</feed>`;
  const result = await pollChannel({ db, getConfig: () => ({ channelId: 'UCfake' }) });
  assert.equal(result.newVideos, 1);
  assert.equal(result.newMatches, 2);
  const dogIds = db.prepare('SELECT dog_id FROM yt_matches WHERE video_id = ?').all('vid00000003').map((r) => r.dog_id).sort();
  assert.deepEqual(dogIds, [1, 2]);
});
