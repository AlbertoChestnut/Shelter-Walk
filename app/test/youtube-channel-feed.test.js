// Pure-function tests for the youtube-channel module's feed parsing and
// name matching -- no server, no DB, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, decodeXmlEntities } = require('../modules/youtube-channel/feedParser');
const { findDogMatches } = require('../modules/youtube-channel/matcher');

const ENTRY = (videoId, title, description, published) => `<entry>
  <id>yt:video:${videoId}</id>
  <yt:videoId>${videoId}</yt:videoId>
  <title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
  <published>${published}</published>
  <media:group>
    <media:title>${title}</media:title>
    <media:description>${description}</media:description>
  </media:group>
</entry>`;

test('parseFeed: a normal feed', () => {
  const xml = `<feed>${ENTRY('abc12345678', 'Meet Biscuit', 'A playful pup looking for a home.', '2026-01-02T03:04:05+00:00')}</feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    videoId: 'abc12345678',
    title: 'Meet Biscuit',
    description: 'A playful pup looking for a home.',
    publishedAt: '2026-01-02T03:04:05+00:00',
    url: 'https://www.youtube.com/watch?v=abc12345678'
  });
});

test('parseFeed: entity-encoded title and description', () => {
  const xml = `<feed>${ENTRY('xyz98765432', 'Max &amp; Bella play', 'Quotes: &quot;good dog&quot; &amp; more', '2026-01-02T03:04:05+00:00')}</feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries[0].title, 'Max & Bella play');
  assert.equal(entries[0].description, 'Quotes: "good dog" & more');
});

test('parseFeed: an empty feed yields no entries', () => {
  assert.deepEqual(parseFeed('<feed></feed>'), []);
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed(null), []);
});

test('parseFeed: a video id is required (malformed entry dropped, not crashed on)', () => {
  const xml = `<feed><entry><title>No id here</title></entry>${ENTRY('realid12345', 'Has an id', 'desc', '2026-01-01T00:00:00+00:00')}</feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, 'realid12345');
});

test('decodeXmlEntities: numeric entities too', () => {
  assert.equal(decodeXmlEntities('A&#38;B'), 'A&B');
});

test('findDogMatches: exact name match', () => {
  const dogs = [{ id: 1, names: ['Max'] }];
  assert.deepEqual(findDogMatches('Max loves the park', dogs), [{ dogId: 1, matchedText: 'Max' }]);
});

test('findDogMatches: a previous name matches too', () => {
  const dogs = [{ id: 1, names: ['Biscuit', 'Cookie'] }];
  assert.deepEqual(findDogMatches('Cookie finds a new home', dogs), [{ dogId: 1, matchedText: 'Cookie' }]);
});

test('findDogMatches: a multi-word name beats a substring of it', () => {
  const dogs = [{ id: 1, names: ['Lucky Charm'] }];
  assert.deepEqual(findDogMatches('Lucky Charm visits the vet', dogs), [{ dogId: 1, matchedText: 'Lucky Charm' }]);
});

test('findDogMatches: no match for unrelated text', () => {
  const dogs = [{ id: 1, names: ['Max'] }];
  assert.deepEqual(findDogMatches('A totally unrelated video about cars', dogs), []);
});

test('findDogMatches: two dogs sharing a name are both returned for one mention', () => {
  const dogs = [{ id: 1, names: ['Max'] }, { id: 2, names: ['Max'] }];
  const found = findDogMatches('Max visits the vet today', dogs);
  assert.equal(found.length, 2);
  assert.deepEqual(new Set(found.map((f) => f.dogId)), new Set([1, 2]));
});
