// Loaded with --require (see package.json "test"): runs the tests, and every
// server they start, as if it were around noon at the shelter on today's
// date, with the clock still ticking normally. Many tests seed walks "a few
// minutes ago" and expect them to be today's; just after midnight Eastern
// that can't be true, and those tests failed for an hour every night.
// Tests that check midnight, DST or quiet hours use fixed timestamps (or
// testHooks.now), so they don't depend on this.
// TEST_CLOCK=real turns it off; TEST_CLOCK=<ISO time> pins a different start;
// TEST_CLOCK=+<N>d is noon at the shelter N days from today (npm run
// test:future uses +182d, so a test with a typed-out "future" date fails
// months before the calendar would make it fail in CI; audit3).
// Tests that need "today" or a walk window use times relative to the
// shelter's midnight or yesterday's noon, so both pass at any hour (audit2).
// Limit: a TEST_CLOCK date before the fixtures' own dates (dogs in since
// 2026-07-01) or on release-checks.test.js's fixed DST days (2026-03-08,
// 2026-10-31, 2026-11-01) collides with those fixtures; pick another day.
const RealDate = Date;
const setting = process.env.TEST_CLOCK || 'noon';
let offset = Number(process.env.TEST_CLOCK_OFFSET_MS);
if (setting !== 'real' && !Number.isFinite(offset)) {
  let start;
  const ahead = /^\+(\d+)d$/.exec(setting);
  if (setting === 'noon' || ahead) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: require('../src/constants').SHELTER_TZ }).format(new RealDate());
    // 17:00Z is noon EST, 1pm EDT: comfortably mid-day either way.
    const todayNoon = RealDate.parse(`${today}T17:00:00Z`);
    start = ahead ? todayNoon + Number(ahead[1]) * 86400000 : todayNoon;
  } else {
    start = RealDate.parse(setting);
  }
  offset = Number.isFinite(start) ? start - RealDate.now() : NaN;
  // Child processes (each test file, every server a test starts) inherit the
  // offset itself, so they all share one clock.
  if (Number.isFinite(offset)) process.env.TEST_CLOCK_OFFSET_MS = String(offset);
}
if (setting !== 'real' && Number.isFinite(offset)) {
  class TestDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = TestDate;
}
