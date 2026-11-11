// A server-side port of the playgroup note editor's auto-tag matcher
// (public/js/pg-tags.js's findMatches, added this session) for free text
// that isn't being typed into a live editor: given a video's title +
// description and the current dog roster, finds every (1-3 word) phrase
// that's an exact match for a dog's current or previous name. Dropped from
// the editor version: the caret-exclusion (nothing is "still being typed"
// here) and the session-scoped declined set (there's no session -- that's
// what the staff review queue's dismiss status is for instead).
//
// Common one-word names (Max, Bailey, Luna...) WILL false-positive against
// free video titles -- that's expected, and exactly why a match lands in a
// review queue (yt_matches.status = 'pending') rather than linking straight
// to the profile.
function findDogMatches(text, dogs /* [{ id, names: [string, ...] }] */) {
  const words = [];
  const wordRe = /\S+/g;
  let wm;
  while ((wm = wordRe.exec(text))) words.push({ start: wm.index, end: wm.index + wm[0].length });

  const found = [];
  for (let i = 0; i < words.length; i += 1) {
    for (let n = Math.min(3, words.length - i); n >= 1; n -= 1) {
      const start = words[i].start, end = words[i + n - 1].end;
      const raw = text.slice(start, end);
      const trimmed = raw.replace(/^[.,!?;:()"']+|[.,!?;:()"']+$/g, '');
      if (!trimmed || trimmed.length < 3) continue;
      const needle = trimmed.toLowerCase();
      const matches = dogs.filter((d) => d.names.some((nm) => String(nm).toLowerCase() === needle));
      if (matches.length) {
        found.push({ start, end, text: trimmed, dogs: matches });
        break; // longest phrase wins at this starting word
      }
    }
  }
  // Non-overlapping, earliest-first (two matches could only overlap if they
  // started at different outer-loop words but one's phrase ran into the
  // other's -- rare, but kept as a safety net).
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => f.start < k.end && f.end > k.start)) continue;
    kept.push(f);
  }
  return kept.flatMap((f) => f.dogs.map((d) => ({ dogId: d.id, matchedText: f.text })));
}

module.exports = { findDogMatches };
