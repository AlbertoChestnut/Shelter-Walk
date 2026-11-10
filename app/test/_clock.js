// Loaded with --require (see package.json "test"): runs the tests, and every
// server they start, as if it were around noon at the shelter on today's
// date, with the clock still ticking normally. Many tests seed walks "a few
// minutes ago" and expect them to be today's; just after midnight Eastern
// that can't be true, and those tests failed for an hour every night.
// Tests that check midnight, DST or quiet hours use fixed timestamps (or
// testHooks.now), so they don't depend on this.
// TEST_CLOCK=real turns it off; TEST_CLOCK=<ISO time> pins a different start.
const RealDate = Date;
const setting = process.env.TEST_CLOCK || 'noon';
let offset = Number(process.env.TEST_CLOCK_OFFSET_MS);
if (setting !== 'real' && !Number.isFinite(offset)) {
  let start;
  if (setting === 'noon') {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new RealDate());
    // 17:00Z is noon EST, 1pm EDT: comfortably mid-day either way.
    start = RealDate.parse(`${today}T17:00:00Z`);
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
