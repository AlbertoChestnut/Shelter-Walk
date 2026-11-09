// A deliberately narrow, regex-based parser for YouTube's public per-channel
// Atom feed (https://www.youtube.com/feeds/videos.xml?channel_id=...) --
// not a general XML parser. Defensible specifically because the input is
// Google's own stable, machine-generated feed (verified against a real
// channel while designing this): each video is one flat <entry>...</entry>
// block containing <yt:videoId>/<title>/<media:description>/<published>
// text tags (media:description sits nested inside <media:group>, but a
// regex that searches the whole entry block finds it regardless of nesting
// depth -- it isn't tree-aware, so depth doesn't matter to it). Real
// channels do use entity-encoding (&amp;, &quot;) in titles; no CDATA was
// seen. If this ever proves too brittle against some edge case, swap for a
// small XML-parsing dependency rather than hardening the regex further.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) => {
    if (e in XML_ENTITIES) return XML_ENTITIES[e];
    return String.fromCodePoint(Number(e.slice(1)));
  });
}

function tagText(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

// Returns [{ videoId, title, description, publishedAt, url }], newest-first
// (the feed's own order), or [] for an empty/malformed feed.
function parseFeed(xml) {
  return [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, block]) => ({
      videoId: tagText(block, 'yt:videoId'),
      title: tagText(block, 'title'),
      description: tagText(block, 'media:description'),
      publishedAt: tagText(block, 'published')
    }))
    .filter((e) => e.videoId)
    .map((e) => ({ ...e, url: `https://www.youtube.com/watch?v=${e.videoId}` }));
}

module.exports = { parseFeed, decodeXmlEntities };
