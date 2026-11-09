// The kinds of animal Shelter Walk knows, and what each one can do in the app.
// Everything species-specific reads this table, so giving cats (say) kennel
// card stickers later is a matter of flipping `stickers` here -- the sticker
// columns, editor, badges and filters all still exist, they're only switched
// off per species.
//
//   listing:    the `species` value pets.wake.gov's adoption API filters on
//   activities: what a volunteer can start with one (all timed the same way)
//   stickers:   blue behavior markers, POO, star and PB on the kennel card
//   levelRules: experience levels decide who may take one out (days in the
//               shelter, stickers, mid-adoption, too young). Without them,
//               any volunteer can do any listed animal, and time spent with
//               them doesn't count toward moving up a level.
//   kennels:    the room/wing letters on this species' kennel cards
//   kennelLabel: what those letters are called ("Room" for the cat rooms)
//   youngFirst: handling order for disease control: the young ones (the
//               shelter's tag for them, e.g. "Kitten") may come before the
//               adults but never after -- the app warns before an adult ->
//               young handoff. null = no such rule.
//   visitMinutes: [good, long]: the timer suggests about this long (cats:
//               5 to 10 minutes) and turns amber past `long`. null = no hint.
//   wrapUpChecks: reminders ticked off on the end screen (latch, locks,
//               hands). An animal mid-adoption also gets a "relock" one.
//   notePlaceholder: example text for the end screen's shared note
//   terms:      what the app calls time with one (owner, 2026-11-06: dogs are
//               walked, cats are played with). Where more than one species
//               is covered, the app says "engage" instead (app.js termsFor).
const SPECIES = {
  dog: {
    label: 'Dog', plural: 'Dogs', noun: 'dog', emoji: '🐕', listing: 'Dog',
    activities: ['walk', 'cuddle', 'matchmaking', 'playgroup', 'daycation'],
    stickers: true,
    levelRules: true,
    kennels: ['A', 'B', 'C', 'D', 'E'],
    kennelLabel: 'Kennel wing',
    youngFirst: null,
    visitMinutes: null,
    wrapUpChecks: [],
    notePlaceholder: 'e.g. Pulls on leash, loves other dogs, needs a firmer walker',
    terms: { verb: 'walk', verbWith: 'walk', past: 'walked', noun: 'walk', nouns: 'walks', ing: 'walking' }
  },
  // Added 2026-11: cats are only cuddled or matchmade, have no stickers (yet),
  // every level may visit any of them, and kittens come before adult cats
  // (an adult can pass disease on to a kitten, not the other way round).
  cat: {
    label: 'Cat', plural: 'Cats', noun: 'cat', emoji: '🐈', listing: 'Cat',
    activities: ['cuddle', 'matchmaking'],
    stickers: false,
    levelRules: false,
    kennels: ['A', 'B', 'C', 'D'],
    kennelLabel: 'Room',
    youngFirst: { tag: 'Kitten', young: 'kitten', adult: 'adult cat' },
    // From the shelter's cat cuddler training.
    visitMinutes: [5, 10],
    wrapUpChecks: [
      'Condo door closed and latched (give it a small tug)',
      'Any lock you took off is back on',
      'Hands sanitized before the next condo'
    ],
    notePlaceholder: 'e.g. Shy at first, loves the wand toy, purrs for chin scratches',
    terms: { verb: 'play', verbWith: 'play with', past: 'played with', noun: 'play session', nouns: 'play sessions', ing: 'playing' }
  }
};
const SPECIES_KEYS = Object.keys(SPECIES);
const DEFAULT_SPECIES = 'dog';

// Who a volunteer works with (Settings): one species, or 'both'.
const SPECIES_PREFS = [...SPECIES_KEYS, 'both'];
const DEFAULT_SPECIES_PREF = 'dog';

const speciesInfo = (key) => SPECIES[key] || SPECIES[DEFAULT_SPECIES];
const validSpecies = (key) => SPECIES_KEYS.includes(key);
const speciesForPref = (pref) => (pref === 'both' ? SPECIES_KEYS : [validSpecies(pref) ? pref : DEFAULT_SPECIES]);

// Whether this animal is one of its species' young ones (a kitten), from the
// shelter's own tag. Unknown (no listing yet) counts as not young.
function isYoung(row) {
  const rule = speciesInfo(row && row.species).youngFirst;
  if (!rule) return false;
  let tags = row.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (e) { tags = []; } }
  return Array.isArray(tags) && tags.includes(rule.tag);
}

// The shelter's detail tags start with the species ("Cat", "Dog") -- trusted
// over which list an animal came from, in case a list ever ignores its filter.
function speciesFromTags(tags, fallback) {
  const list = Array.isArray(tags) ? tags : [];
  const hit = SPECIES_KEYS.find((key) => list.includes(SPECIES[key].listing));
  return hit || fallback;
}

module.exports = {
  SPECIES, SPECIES_KEYS, DEFAULT_SPECIES, SPECIES_PREFS, DEFAULT_SPECIES_PREF,
  speciesInfo, validSpecies, speciesForPref, speciesFromTags, isYoung
};
