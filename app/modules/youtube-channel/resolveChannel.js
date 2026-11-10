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

// Only YouTube itself is ever fetched: an https link on www.youtube.com,
// youtube.com, m.youtube.com or youtu.be (no other port, no user:password@),
// or a bare @handle. Anything else is refused before any request is made,
// so this can't be pointed at another server (or one inside the network).
const YOUTUBE_HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'];
const NOT_YOUTUBE = 'Enter a YouTube channel link (https://www.youtube.com/...), an @handle or a channel ID.';
function toChannelPageUrl(raw) {
  if (/^@[\w.-]{1,100}$/.test(raw)) return `https://www.youtube.com/${raw}`;
  // "youtube.com/@name" pasted without the https:// in front.
  const withScheme = /^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//i.test(raw) ? `https://${raw}` : raw;
  let url;
  try { url = new URL(withScheme); } catch (err) { throw new Error(NOT_YOUTUBE); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password
      || !YOUTUBE_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error(NOT_YOUTUBE);
  }
  return url.href;
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

  const url = toChannelPageUrl(raw);
  // .../channel/UC... -- the id is right there in the link, no fetch needed.
  const direct = /^https:\/\/[^/]+\/channel\/(UC[\w-]+)/.exec(url);
  if (direct) return direct[1];

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
