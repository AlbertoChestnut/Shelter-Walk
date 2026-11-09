// resolveChannelId: turning whatever someone pastes (a channel link, a
// "@handle", the raw id) into the canonical channel id -- in-process with a
// stubbed fetch, same style as test/scraper.test.js, since this is the one
// piece of the youtube-channel module that makes a real network call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChannelId } = require('../modules/youtube-channel/resolveChannel');
const { resolveConfig } = require('../modules/youtube-channel/server');

let fetchedUrls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  fetchedUrls.push(String(url));
  if (String(url).includes('/@wcacplaygroups')) {
    return new Response(
      '<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCeRhWtc06twg9Lk9WPeZCMQ"></head></html>',
      { status: 200 }
    );
  }
  if (String(url).includes('/@embeddedonly')) {
    // No canonical tag this time -- only the id embedded in the page's own data.
    return new Response('<html><script>var x={"channelId":"UCembedded0000000000000"};</script></html>', { status: 200 });
  }
  if (String(url).includes('/@nowhere')) {
    return new Response('<html><body>Not a channel page.</body></html>', { status: 200 });
  }
  if (String(url).includes('/@missing')) {
    return new Response('Not found', { status: 404 });
  }
  return realFetch(url, opts);
};

test.afterEach(() => { fetchedUrls = []; });

test('a bare channel id passes through untouched, no fetch', async () => {
  const id = await resolveChannelId('UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(id, 'UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(fetchedUrls.length, 0);
});

test('a /channel/UC... link is read directly, no fetch', async () => {
  const id = await resolveChannelId('https://www.youtube.com/channel/UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(id, 'UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(fetchedUrls.length, 0);
});

test('a full /@handle/videos link is fetched and resolved via the canonical tag', async () => {
  const id = await resolveChannelId('https://www.youtube.com/@wcacplaygroups/videos');
  assert.equal(id, 'UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(fetchedUrls.length, 1);
});

test('a bare "@handle" (no URL at all) is expanded to a youtube.com link', async () => {
  const id = await resolveChannelId('@wcacplaygroups');
  assert.equal(id, 'UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(fetchedUrls[0], 'https://www.youtube.com/@wcacplaygroups');
});

test('falls back to the id embedded in the page data when there is no canonical tag', async () => {
  const id = await resolveChannelId('@embeddedonly');
  assert.equal(id, 'UCembedded0000000000000');
});

test('a page with no channel info throws a clear error', async () => {
  await assert.rejects(() => resolveChannelId('@nowhere'), /couldn't find a channel/i);
});

test('a failed request throws a clear error', async () => {
  await assert.rejects(() => resolveChannelId('@missing'), /couldn't look up that channel/i);
});

test('an empty value throws instead of resolving to nothing', async () => {
  await assert.rejects(() => resolveChannelId(''), /enter a channel link/i);
  await assert.rejects(() => resolveChannelId('   '), /enter a channel link/i);
});

// server.js's resolveConfig() is the thin wrapper src/modules.js's PUT
// /api/modules/:id route actually calls -- these confirm its two extra
// behaviors on top of resolveChannelId itself: a blank channelId is left
// alone (clearing the field shouldn't require a network round-trip, and is
// what makes pollChannel() a no-op), and other config keys pass through
// untouched.
test('resolveConfig: a blank channelId is left alone, no fetch', async () => {
  const config = await resolveConfig({ channelId: '' });
  assert.deepEqual(config, { channelId: '' });
  assert.equal(fetchedUrls.length, 0);
});

test('resolveConfig: resolves channelId and leaves other keys untouched', async () => {
  const config = await resolveConfig({ channelId: '@wcacplaygroups', someOtherKey: 'kept' });
  assert.equal(config.channelId, 'UCeRhWtc06twg9Lk9WPeZCMQ');
  assert.equal(config.someOtherKey, 'kept');
});
