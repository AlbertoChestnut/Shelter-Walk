// Turns whatever someone actually copies out of their browser's address bar
// -- a bare channel ID, a /channel/UC... link, a /@handle link (or just
// "@handle" on its own), a /c/CustomName link, even a link to one specific
// video on the channel -- into the canonical UCxxxxxxxxxxxxxxxxxxxxxx
// channel ID the feed endpoint (poll.js) actually needs. Most people can
// find their channel's /videos page; almost nobody knows their raw channel
// ID, so making them paste the ID directly was never going to work for
// "someone who isn't me" setting this up.
const USER_AGENT = 'dogwalk-personal-tracker/1.0 (+personal use, youtube-channel module)';

function looksLikeChannelId(s) {
  return /^UC[\w-]+$/.test(s);
}

function toChannelPageUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('@')) return `https://www.youtube.com/${raw}`;
  return `https://www.youtube.com/${raw.replace(/^\/+/, '')}`;
}

// Looks for the channel id in order of how trustworthy the source is: the
// page's own canonical link (exactly what we saw on a real channel page
// while building this), the channel id embedded in the page's data, then
// any bare /channel/UC... occurrence as a last resort.
function extractChannelId(html) {
  const canonical = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)"/.exec(html);
  if (canonical) return canonical[1];
  const embedded = /"channelId":"(UC[\w-]+)"/.exec(html);
  if (embedded) return embedded[1];
  const generic = /youtube\.com\/channel\/(UC[\w-]+)/.exec(html);
  if (generic) return generic[1];
  return null;
}

async function resolveChannelId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a channel link or ID.');
  if (looksLikeChannelId(raw)) return raw;

  // .../channel/UC... -- the id is right there in the link, no fetch needed.
  const direct = /youtube\.com\/channel\/(UC[\w-]+)/.exec(raw);
  if (direct) return direct[1];

  const url = toChannelPageUrl(raw);
  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new Error(`Couldn't look up that channel (${err.message}). Double-check the link.`);
  }
  const channelId = extractChannelId(html);
  if (!channelId) throw new Error("That doesn't look like a YouTube channel page -- couldn't find a channel there.");
  return channelId;
}

module.exports = { resolveChannelId, looksLikeChannelId };
