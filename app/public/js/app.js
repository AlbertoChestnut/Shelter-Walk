(function () {
  'use strict';

  // A module (app/modules/<id>/public/profile.js, injected via
  // <!-- MODULE_SCRIPTS -->) pushes a `dog => htmlString` function here to
  // add its own section to a dog's profile -- the one generic hook the
  // module system offers for the profile page, so a module needs no core
  // edit of its own for this. Declared before any module's <script> tag can
  // run (module scripts load at the very end of the page).
  window.ShelterWalkModules = window.ShelterWalkModules || { profileSections: [] };

  const appEl = document.getElementById('app');
  const topbarTitle = document.getElementById('topbarTitle');
  const tabButtons = document.querySelectorAll('.tab-btn');

  // Every redraw of the Available list (returning from a dog's confirm
  // screen, closing the profile sheet, even just typing in the search box)
  // replaces #app's innerHTML, which resets scrollTop to 0 by default.
  // Track it continuously and restore it after every redraw instead.
  appEl.addEventListener('scroll', () => {
    if (state.tab === 'available') state.availableScrollTop = appEl.scrollTop;
    if (state.tab === 'updates') state.updatesScrollTop = appEl.scrollTop;
  }, { passive: true });

  // Puts a list back at its remembered spot. Swiping Back while the screen
  // being left was still coasting from a flick can carry that momentum over
  // onto the restored list, scrolling it away from the spot just set (and
  // the listener above then remembers the wrong spot). Turning scrolling off
  // for a frame stops any coasting, then the spot is set again.
  function restoreScroll(top) {
    const tab = state.tab;
    appEl.style.overflowY = 'hidden';
    appEl.scrollTop = top;
    requestAnimationFrame(() => {
      appEl.style.overflowY = '';
      if (state.tab === tab) appEl.scrollTop = top;
    });
  }

  // ---------- Theme (light/dark/system) ----------
  const THEME_KEY = 'sw_theme';
  const THEME_OPTIONS = [
    { key: 'system', label: 'System' },
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' }
  ];
  const darkMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return darkMediaQuery && darkMediaQuery.matches ? 'dark' : 'light';
  }
  function applyTheme(pref) {
    document.documentElement.dataset.theme = resolveTheme(pref);
  }
  function setTheme(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* ignore, still applies for this load */ }
    applyTheme(pref);
  }
  // Keep following the OS setting live while the user hasn't overridden it.
  if (darkMediaQuery) {
    const onSystemChange = () => { if (getStoredTheme() === 'system') applyTheme('system'); };
    if (darkMediaQuery.addEventListener) darkMediaQuery.addEventListener('change', onSystemChange);
    else if (darkMediaQuery.addListener) darkMediaQuery.addListener(onSystemChange);
  }
  applyTheme(getStoredTheme());
  function themePickerHtml(selectedKey) {
    return `<div class="row" style="gap:8px;">` + THEME_OPTIONS.map((opt) => `
      <button type="button" class="btn theme-pick-btn ${selectedKey === opt.key ? 'primary' : ''}" data-theme-key="${esc(opt.key)}" style="flex:1;">${esc(opt.label)}</button>`).join('') + `</div>`;
  }

  const state = {
    tab: 'available',
    currentUser: null, // { id, name, experienceLevel } - set during init via the user picker
    allUsers: [],
    unreadUpdatesCount: 0,
    experienceLevels: [], // [{ key, label, description, minDays, allowBlue, allowEvo, allowPb }] - fetched once
    walk: { phase: 'idle', dog: null, walkId: null, startedAt: null, location: null },
    qrScanner: null,
    showFoster: false,
    // Per-criterion filter mode: key -> 'only' | 'hide'. Absent key = no
    // opinion. Keys: blue_c..blue_evo (from BLUE_MARKERS), poo, poo_priority,
    // star, pb, walkedByMe. Blue-letter keys OR together within 'only' and
    // within 'hide' (a dog needs ANY selected letter / must have NONE of the
    // hidden ones); every other key is its own independent AND'd criterion.
    markerFilters: {},
    filterMatch: 'all', // 'all' | 'any': whether a dog must pass every filter (And) or just one (Or)
    // For someone who works with both dogs and cats: 'all', 'dog' or 'cat' --
    // which ones the Available list and Updates show (kept on this device).
    speciesView: (() => { try { return localStorage.getItem('speciesView') || 'dog'; } catch (e) { return 'dog'; } })(),
    // Updates has its own switch, with All: news is only marked read when
    // nothing is filtered out.
    updatesSpeciesView: (() => { try { return localStorage.getItem('updatesSpeciesView') || 'all'; } catch (e) { return 'all'; } })(),
    needsShiftWalkOnly: false,
    locationFilter: new Set(), // kennel wing letters (A-E) to include; empty = all
    showMoreFilters: false,
    filtersTab: 'filters', // 'filters' | 'presets'
    presetMinDaysAtLeast: null, // set by the "Beginner" built-in preset
    ageMinYears: null, // adopter age range; null = no limit
    ageMaxYears: null,
    minShelterDays: null, // advanced filter: at least this many days in the shelter (this stay)
    openFilterSections: new Set(), // folding filter sections the user has opened ('breed', 'advanced')
    availableSort: 'lastWalked',
    availableSortDir: 'desc',
    availableSearch: '',
    availableDogsRaw: [],
    availableExperienceLevel: null,
    availableScrollTop: 0,
    updatesScrollTop: 0,
    updatesHtml: null, // last rendered Updates feed, redrawn as-is on Back from a dog
    updatesRange: 'all', // 'all' | 'today' | 'week' -- the feed's time filter
    updatesKinds: new Set(), // event kinds picked on the feed's type chips (empty = every kind)
    savedFilters: [],
    statsView: 'summary',
    statsSpecies: null, // 'dog' | 'cat' on My stats / Together / Shelter (null = the list's species)
    statsPresentOnly: true,
    statsOpenMonths: null, // 'YYYY-MM' keys expanded under Shelter Visits (null = just the newest)
    togetherOpenMonths: null, // same, for Together's past days
    selectedDateKey: null,
    selectedShiftIndex: null, // which of the 4 shift tiles is drilled into on the Stats day view, if any
    statsActivityFilter: null, // activity key drilled into from the "By Activity" breakdown (mine), if any
    statsBreakdownScope: 'lifetime', // 'lifetime' | 'today' | 'day' -- which stats view a By Activity / Avg chart / By Dog drill-down was opened from
    togetherByActivity: false, // whether Together is showing its "By Activity" breakdown screen
    togetherAvgChart: null, // dateKey of the day Together's "Average engagement" bar chart is showing, if any (today only)
    statsScope: 'mine', // 'mine' | 'together' (shelter-wide, anonymous) | 'notes' (every dog's notes) | 'playgroup' (playgroup notes) | 'shelter' (listing trends)
    shelterRange: 30, // days shown on the Shelter trend charts (0 = all)
    notesQuery: '', // search text on the all-notes view
    notesMine: false, // all-notes view narrowed to my private + my walk notes
    pgStatsQuery: '', // search text on the Stats playgroup notes view
    togetherDay: null, // dateKey of the Together day being viewed, if any
    statsRange: 'today', // 'today' | 'lifetime' -- which Stats tiles are shown
    audit: { location: '', dog: null, loading: false, pendingMarkers: null, recent: [], scanned: {}, scanError: '' }
  };

  // ---------- New version after a deploy ----------
  // This page's build: the ?v= this script was loaded with (server.js
  // ASSET_VERSION), else the page's <meta name="build">. Every /api answer
  // says which build the server runs (X-App-Build). A page left open from
  // before a deploy would keep talking to a server that has moved on, so
  // it reloads itself -- but never in the middle of something (a walk, its
  // finish screen, a note being typed, an open dialog): then a small
  // banner says a new version is ready, and it reloads once that's done.
  const PAGE_BUILD = (() => {
    try {
      const v = document.currentScript && new URL(document.currentScript.src, window.location.href).searchParams.get('v');
      if (v) return v;
    } catch (e) { /* fall back to the meta tag */ }
    const meta = document.querySelector('meta[name="build"]');
    const b = meta && meta.getAttribute('content');
    return b && b !== '__BUILD__' ? b : null;
  })();
  const BUILD_RELOAD_KEY = 'dogwalk_build_reload';
  let serverBuild = null;
  function noticeServerBuild(res) {
    const build = res.headers.get('X-App-Build');
    // A saved offline answer carries whatever build was running back then.
    if (!build || !PAGE_BUILD || build === PAGE_BUILD || res.headers.get('X-SW-Stale') === '1') return;
    serverBuild = build;
    // After the answer has been handled (it may start or end a walk).
    setTimeout(applyNewBuild, 0);
  }
  function busyForReload() {
    const phase = state.walk && state.walk.phase;
    // 'summary' too: the "Great walk" screen would vanish under the reload.
    if (phase && !['idle', 'scanning'].includes(phase)) return true;
    try { if (localStorage.getItem(END_DRAFT_KEY)) return true; } catch (e) { /* storage blocked */ }
    if (document.querySelector('.popup-overlay:not(.hidden), .sheet:not(.hidden), #appDialog:not(.hidden), .image-lightbox:not(.hidden)')) return true;
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
    return false;
  }
  function applyNewBuild() {
    if (!serverBuild) return;
    let reloadedFor = null;
    try { reloadedFor = sessionStorage.getItem(BUILD_RELOAD_KEY); } catch (e) { /* storage blocked */ }
    // Already reloaded once for this build and still old (a cached page):
    // don't go round in circles, just say so.
    if (!busyForReload() && reloadedFor !== serverBuild) {
      try { sessionStorage.setItem(BUILD_RELOAD_KEY, serverBuild); } catch (e) { /* storage blocked */ }
      window.location.reload();
      return;
    }
    showNewBuildBanner();
  }
  function showNewBuildBanner() {
    if (document.getElementById('newBuildBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'newBuildBanner';
    banner.className = 'new-build-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<span>A new version is ready. Reload when you\'re done.</span> <button type="button" class="btn">Reload</button>';
    banner.querySelector('button').addEventListener('click', () => window.location.reload());
    document.body.prepend(banner);
  }
  // Finished whatever was in the way: try again when the page comes back
  // into view or the walk tab settles (also on every /api answer, above).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyNewBuild(); });

  // ---------- API helper ----------
  let sessionExpiredShown = false;
  let staleNoticeShown = false;
  function promptSessionExpired() {
    if (sessionExpiredShown) return;
    sessionExpiredShown = true;
    appDialog({ title: 'Signed out', message: 'Your sign-in has expired. Reload to sign in again.', confirmText: 'Reload', showCancel: false })
      .then(() => window.location.reload());
  }

  // Every request gets a timeout (shelter wifi can stall a connection without
  // ever failing it, which used to leave a screen on "Loading..." forever)
  // and network failures come back as plain-English errors instead of the
  // browser's "Failed to fetch".
  // How far this phone's clock is off the server's (audit 3): + when the
  // phone is behind. From each live answer's X-Server-Now (never the service
  // worker's saved copy); under 15 s is network delay, so 0. The walk timer,
  // its countdown and the auto-stop check run on serverNow().
  let serverClockOffsetMs = 0;
  const serverNow = () => Date.now() + serverClockOffsetMs;
  function noteServerClock(res, sentAt) {
    if (res.headers.get('X-SW-Stale') === '1') return;
    const server = Number(res.headers.get('X-Server-Now'));
    if (!Number.isFinite(server) || server <= 0) return;
    const off = server - (sentAt + Date.now()) / 2;
    serverClockOffsetMs = Math.abs(off) >= 15000 && Math.abs(off) <= 24 * 3600000 ? Math.round(off) : 0;
  }
  async function api(path, opts = {}) {
    const { timeout = 30000, ...fetchOpts } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const sentAt = Date.now();
    let res;
    try {
      // X-Client-Now: this phone's clock, so the server can turn times this
      // phone recorded (an End tap) into its own clock (clientClockOffsetMs).
      res = await fetch(path, {
        ...fetchOpts,
        headers: { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}), 'X-Client-Now': String(Date.now()) },
        signal: controller.signal
      });
    } catch (err) {
      const e = new Error();
      e.networkError = true;
      if (err.name === 'AbortError') e.message = "That's taking too long. Check your connection and try again.";
      else if (!navigator.onLine) e.message = "You're offline. Check your connection and try again.";
      // Online but the request itself failed: the login gate redirecting an
      // expired session to another origin looks exactly like this to fetch().
      else { e.message = "Couldn't reach the server. If this keeps happening, your sign-in may have expired. Reload the page to sign in again."; e.maybeSessionExpired = true; }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    // The service worker answered from its offline copy (sw.js): say so once.
    if (res.headers.get('X-SW-Stale') === '1' && !staleNoticeShown) {
      staleNoticeShown = true;
      toast("Can't reach the server right now: showing saved data");
    }
    noticeServerBuild(res);
    noteServerClock(res, sentAt);
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      if (res.status === 401 && body && body.sessionExpired) promptSessionExpired();
      // A 4xx with a JSON error is the server explaining what to fix, written
      // for people. Anything else ("Internal Server Error", a proxy's HTML
      // page, "database is locked") is never shown as-is.
      const err = new Error(httpErrorMessage(res.status, body));
      err.serverMessage = (body && body.error) || null;
      err.fromApi = true;
      err.body = body;
      err.status = res.status;
      throw err;
    }
    return body;
  }
  function httpErrorMessage(status, body) {
    // A 5xx is shown as-is only when the server marks its message as written
    // for people (userFacing), e.g. "your account was NOT deleted".
    if ((status < 500 || (body && body.userFacing === true)) && body && typeof body.error === 'string' && body.error) return body.error;
    if (status === 404) return "That couldn't be found. It may have been removed.";
    if (status === 401 || status === 403) return "You don't have access to that. Reload the page to sign in again.";
    if (status === 429) return 'Too many tries in a row. Wait a moment and try again.';
    if (status >= 502 && status <= 504) return "The server isn't responding right now. Try again in a minute.";
    return 'Something went wrong on our end. Try again in a moment.';
  }
  // Text safe to show a volunteer for any error: what api() produced (already
  // friendly), else a plain fallback -- never a raw library/JS message.
  function friendlyError(err, action) {
    if (err && (err.fromApi || err.networkError) && err.message) return err.message;
    return `Couldn't ${action || 'do that'}. Try again in a moment.`;
  }

  // ---------- Formatting helpers ----------
  function fmtElapsed(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // The one duration format: "15 min" under an hour, "2h 54m" (or "3h")
  // from there on, however many hours -- never decimal hours.
  function fmtDuration(seconds) {
    if (seconds == null) return '-';
    if (seconds > 0 && seconds < 60) return 'under a minute';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // The shelter's listing writes ages as "4 Months", "2 Years": units read
  // lower-case in a sentence ("4 months").
  // A count of 1 takes the singular, whatever the listing wrote ("1 Years"
  // -> "1 year").
  const fmtAge = (age) => String(age || '')
    .replace(/\b(Years?|Months?|Weeks?|Days?)\b/gi, (u) => u.toLowerCase())
    .replace(/\b1\s+(year|month|week|day)s\b/g, '1 $1');

  // A time-of-day window's short key ("7-10a", "10-1p") as people read it:
  // "7–10 am", "10 am–1 pm".
  function fmtSlotLabel(label) {
    const m = /^(\d+)-(\d+)([ap])$/.exec(label || '');
    if (!m) return label || '';
    const from = Number(m[1]);
    const to = Number(m[2]);
    const toSfx = `${m[3]}m`;
    const fromSfx = from > to && from !== 12 ? (toSfx === 'pm' ? 'am' : 'pm') : toSfx;
    return fromSfx === toSfx ? `${from}–${to} ${toSfx}` : `${from} ${fromSfx}–${to} ${toSfx}`;
  }

  // Every date and clock time in the app is the shelter's, never the
  // device's: "today" has to agree with the server (which counts days in
  // America/New_York) even on a phone still set to another time zone.
  // ---- eng (audit2): numbers shared with the server ----
  // Fallback copies of GET /api/config (src/constants.js); init() replaces
  // them with the live values, so an app cached by the service worker can't
  // run on old limits. test/audit2-eng.test.js fails CI if they drift.
  const SHARED_CONFIG = {
    shelterTz: 'America/New_York',
    slots: [
      { label: '7-10a', from: 7, to: 10 },
      { label: '10-1p', from: 10, to: 13 },
      { label: '1-4p', from: 13, to: 16 },
      { label: '4-7p', from: 16, to: 19.25 }
    ],
    autoStopMinutes: 45,
    activityLimitMinutes: { matchmaking: 60 },
    extendMinutes: 10,
    maxTotalMinutes: 180,
    daycationMinutes: 720,
    minAvgSeconds: 60,
    roundSeconds: 300
  };
  // In place, so WALK_SLOTS (the same array) follows. The time zone stays:
  // formatters below are built from it once.
  function applySharedConfig(c) {
    if (!c || typeof c !== 'object') return;
    for (const k of ['autoStopMinutes', 'extendMinutes', 'maxTotalMinutes', 'daycationMinutes', 'minAvgSeconds', 'roundSeconds']) {
      if (Number.isFinite(c[k])) SHARED_CONFIG[k] = c[k];
    }
    if (c.activityLimitMinutes && typeof c.activityLimitMinutes === 'object') SHARED_CONFIG.activityLimitMinutes = { ...c.activityLimitMinutes };
    if (Array.isArray(c.slots) && c.slots.length) SHARED_CONFIG.slots.splice(0, SHARED_CONFIG.slots.length, ...c.slots);
  }
  // Default time limit of an activity, in minutes (server.js walkLimitMinutes).
  const activityLimitMinutes = (activity) => (activity === 'daycation' ? SHARED_CONFIG.daycationMinutes
    : (SHARED_CONFIG.activityLimitMinutes[activity] || SHARED_CONFIG.autoStopMinutes));
  const SHELTER_TZ = SHARED_CONFIG.shelterTz;
  const shelterPartsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SHELTER_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  // { y, m, d, hh, mm, ss } of a moment, as a wall clock at the shelter reads it.
  function shelterParts(when) {
    const out = {};
    for (const p of shelterPartsFmt.formatToParts(when ? new Date(when) : new Date())) {
      if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    return { y: out.year, m: out.month, d: out.day, hh: out.hour % 24, mm: out.minute, ss: out.second };
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  // The moment the shelter's clock reads hh:mm on the day dateKey (DST-safe:
  // guess with UTC, then correct by the zone's offset at that moment).
  function shelterTimeToDate(key, hh = 0, mm = 0) {
    const [y, m, d] = key.split('-').map(Number);
    const want = Date.UTC(y, m - 1, d, hh, mm);
    let t = want;
    for (let i = 0; i < 2; i += 1) {
      const p = shelterParts(t);
      t += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    }
    return new Date(t);
  }
  // A YYYY-MM-DD key moved by n calendar days.
  function addDaysToKey(key, n) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const shelterHour = (iso) => shelterParts(iso).hh;

  // One clock style everywhere, single times and ranges alike: "6:09 pm"
  // (audit 3; it used to be the phone's own "6:09 PM" next to "5:04–5:11 pm").
  function fmtClock(iso) {
    const p = shelterParts(iso ? new Date(iso) : new Date());
    return `${p.hh % 12 || 12}:${pad2(p.mm)} ${p.hh < 12 ? 'am' : 'pm'}`;
  }
  // A start–end range in the same style as the session labels ("4–7 pm"),
  // for lists that mix the two: "5:50–6:01 pm", "11:50 am–12:10 pm".
  function fmtClockRange(startIso, endIso) {
    const part = (iso) => {
      const p = shelterParts(iso);
      return { t: `${p.hh % 12 || 12}:${pad2(p.mm)}`, sfx: p.hh < 12 ? 'am' : 'pm' };
    };
    const a = part(startIso);
    if (!endIso) return `${a.t} ${a.sfx}`;
    const b = part(endIso);
    return a.sfx === b.sfx ? `${a.t}–${b.t} ${b.sfx}` : `${a.t} ${a.sfx}–${b.t} ${b.sfx}`;
  }

  function dateKey(iso) {
    const p = shelterParts(iso); // YYYY-MM-DD at the shelter
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  // A hand-drawn 6-point asterisk instead of a "*" glyph -- font asterisks
  // sit high with inconsistent metrics across platforms/browsers, which no
  // amount of manual translateY nudging ever centered reliably. Symmetric
  // around the 12,12 midpoint of its own viewBox, so it's centered by
  // construction wherever it's dropped in.
  const ASTERISK_SVG = '<svg viewBox="0 0 24 24" class="asterisk-icon" aria-hidden="true"><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="3.7" y1="7" x2="20.3" y2="17"/><line x1="20.3" y1="7" x2="3.7" y2="17"/></g></svg>';

  // Single source of truth for the blue behavior markers — alphabetical by
  // letter, EVO last (it's a rectangle, not a circle). Independently
  // multi-selectable; a lettered one implies the blank "general" one too.
  const BLUE_MARKERS = [
    { value: 'blue_c', letter: 'C', name: 'Difficult to collar' },
    { value: 'blue_d', letter: 'D', name: 'Door dasher' },
    { value: 'blue_e', letter: 'E', name: 'Energetic' },
    { value: 'blue_h', letter: 'H', name: 'Humpy' },
    { value: 'blue_j', letter: 'J', name: 'Jumpy' },
    { value: 'blue_m', letter: 'M', name: 'Mouthy' },
    { value: 'blue_p', letter: 'P', name: 'Puller' },
    { value: 'blue_q', letter: 'Q', name: 'Quirky' },
    { value: 'blue_r', letter: 'R', name: 'Reactive' },
    { value: 'blue_s', letter: 'S', name: 'Shy / shutdown' },
    { value: 'blue_evo', letter: 'EVO', name: 'Experienced volunteer only', rect: true }
  ];
  const BLUE_MARKER_LETTERS = Object.fromEntries(BLUE_MARKERS.map((m) => [m.value, m.letter]));
  const BLUE_MARKER_NAMES = Object.fromEntries(BLUE_MARKERS.map((m) => [m.value, m.name]));

  // A lettered blue marker is a specific case of the blank blue marker —
  // having one implies the blank one too (still true, unchanged for blue).
  function withImpliedBlank(blueMarkers) {
    const hasLetter = blueMarkers.some((m) => m !== 'blue');
    return hasLetter && !blueMarkers.includes('blue') ? ['blue', ...blueMarkers] : blueMarkers;
  }

  // Badges always read in a fixed order -- EVO first, then the rest of the
  // blues alphabetically by letter -- no matter what order they were toggled
  // on in (the order dog.blueMarkers actually stores them). BLUE_MARKERS is
  // already alphabetical with EVO last (see its own comment), so this is
  // just EVO pulled to the front.
  function orderedBlueMarkers(blueMarkers) {
    const present = new Set((blueMarkers || []).filter((m) => m !== 'blue'));
    const evo = present.has('blue_evo') ? ['blue_evo'] : [];
    const rest = BLUE_MARKERS.filter((m) => m.value !== 'blue_evo' && present.has(m.value)).map((m) => m.value);
    return [...evo, ...rest];
  }

  // `isHistorical` (Updates tab entries, past-walk records): a dog's
  // pending-adoption status at some point in the past doesn't mean
  // anything now -- most obviously, a dog who was fully adopted keeps
  // whatever tags they had at that final scrape frozen forever (they're
  // gone, nothing re-scrapes them), which would otherwise permanently grey
  // out their star. Live contexts (Available list, Scan/Walk-Edit, Audit,
  // Stats) show the real current state instead, since that's what actually
  // decides whether a beginner can walk them today.
  function markerBadgesRaw(dog, isHistorical) {
    let html = '';
    // No more blank/plain blue circle -- only the lettered markers (the
    // specific behavior calls) are shown; the old catch-all "blue" badge is
    // retired, whether it's client-implied or actually stored that way on a
    // dog from before the lettered system existed.
    orderedBlueMarkers(dog.blueMarkers).forEach((m) => {
      const cls = m === 'blue_evo' ? 'marker-dot blue rect' : 'marker-dot blue';
      html += `<span class="${cls}" title="${esc(BLUE_MARKER_NAMES[m] || 'Behavior sticker')}">${BLUE_MARKER_LETTERS[m] || ''}</span>`;
    });
    // POO is a strict single-select: plain OR priority, never both shown —
    // no longer implies the other.
    if (dog.pooStatus === 'priority') {
      html += `<span class="marker-dot poo-priority" title="High priority POO dog - first out in the morning, last out in the evening">${ASTERISK_SVG}</span>`;
    } else if (dog.pooStatus === 'poo') {
      html += `<span class="marker-dot poo" title="POO dog: Potty Outside Only"></span>`;
    }
    if (dog.starFlag) {
      // A dog pending adoption can't actually be walked by a beginner right
      // now, so the star (which means exactly that) shows greyed out to
      // avoid the contradiction — except in a historical view, where it's
      // just recording that they were a beginner-friendly dog.
      const starPending = !isHistorical && dog.isPendingAdoption;
      const starTitle = starPending
        ? 'Good for beginners - but not right now, this dog is pending adoption'
        : 'Good for beginners';
      html += `<span class="marker-star${starPending ? ' pending' : ''}" title="${starTitle}">★</span>`;
    }
    if (dog.pbFlag) html += `<span class="marker-dot pb" title="PB: Potty break only, a short potty walk">PB</span>`;
    if (dog.isPendingAdoption) html += `<span class="marker-dot pending" title="Someone has started adopting this dog - Beginners can't walk them">Adopted</span>`;
    return html;
  }

  // Wraps the badges in a tappable span carrying just enough data to render
  // the breakdown popup right away (current markers show without a fetch) --
  // works from anywhere markerBadges() is used (Available cards, Stats rows,
  // Audit, profile) since it's self-contained rather than needing a
  // per-screen click wire-up. `id`, when the caller has it, lets the popup
  // also fetch and show the dog's sticker-added dates and history; callers
  // that only have a partial dog-like object (a walk or event row) leave it
  // out and the popup just shows the current markers, as before.
  function markerBadges(dog, isHistorical) {
    const html = markerBadgesRaw(dog, isHistorical);
    if (!markerBreakdownRows(dog, isHistorical).length) return html;
    const payload = esc(JSON.stringify({
      id: dog.id || null,
      name: dog.name,
      blueMarkers: dog.blueMarkers || [],
      pooStatus: dog.pooStatus || 'none',
      starFlag: !!dog.starFlag,
      pbFlag: !!dog.pbFlag,
      isPendingAdoption: !!dog.isPendingAdoption,
      isHistorical: !!isHistorical
    }));
    return `<span class="marker-badges-toggle" data-dog-info="${payload}" role="button" tabindex="0" aria-label="${esc(dog.name ? `What ${dog.name}'s stickers mean` : 'What these stickers mean')}">${html}</span>`;
  }

  // Full icon → meaning breakdown for a dog's active markers, shown on tap
  // since tooltips (title=) don't work on mobile. Each row shows the actual
  // badge (same markup as markerBadgesRaw) next to its meaning, not just its
  // letter, so it's obvious which icon on the dog is being explained.
  function markerBreakdownRows(dog, isHistorical) {
    const rows = [];
    orderedBlueMarkers(dog.blueMarkers).forEach((m) => {
      const cls = m === 'blue_evo' ? 'marker-dot blue rect' : 'marker-dot blue';
      rows.push({ icon: `<span class="${cls}">${BLUE_MARKER_LETTERS[m] || ''}</span>`, name: BLUE_MARKER_NAMES[m] || 'Behavior sticker', key: m });
    });
    if (dog.pooStatus === 'priority') rows.push({ icon: `<span class="marker-dot poo-priority">${ASTERISK_SVG}</span>`, name: 'High priority POO dog - first out in the morning, last out in the evening', key: 'poo_priority' });
    else if (dog.pooStatus === 'poo') rows.push({ icon: '<span class="marker-dot poo"></span>', name: 'POO dog: Potty Outside Only', key: 'poo' });
    if (dog.starFlag) {
      const starPending = !isHistorical && dog.isPendingAdoption;
      rows.push({ icon: `<span class="marker-star${starPending ? ' pending' : ''}">★</span>`, name: starPending ? 'Good for beginners - but not right now, pending adoption' : 'Good for beginners', key: 'star' });
    }
    if (dog.pbFlag) rows.push({ icon: '<span class="marker-dot pb">PB</span>', name: 'PB: Potty break only. A short, potty-focused walk, no play', key: 'pb' });
    if (dog.isPendingAdoption) rows.push({ icon: '<span class="marker-dot pending">Adopted</span>', name: "Someone has started adopting this dog - Beginners can't walk them", key: null });
    return rows;
  }

  // "2 days ago" / "today" / "yesterday" for when a sticker was added.
  // Whole days gone by, the same rule as the server's daysInShelter (the
  // "60d" next to it), so the two never disagree by one.
  function daysAgoText(iso) {
    const days = Math.max(0, Math.floor((new Date() - new Date(iso)) / 86400000));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  // Same badge markup as markerBadgesRaw/markerBreakdownRows, but keyed by
  // the sticker's plain string key (star/pb/poo/poo_priority/blue_*) rather
  // than a dog object -- for places like the timeline that only have the key
  // itself (shelter_events.detail), not a full dog to read flags off of.
  function stickerIconByKey(key) {
    if (key in BLUE_MARKER_LETTERS) {
      const cls = key === 'blue_evo' ? 'marker-dot blue rect' : 'marker-dot blue';
      return `<span class="${cls}">${BLUE_MARKER_LETTERS[key]}</span>`;
    }
    switch (key) {
      case 'star': return '<span class="marker-star">★</span>';
      case 'pb': return '<span class="marker-dot pb">PB</span>';
      case 'poo': return '<span class="marker-dot poo"></span>';
      case 'poo_priority': return `<span class="marker-dot poo-priority">${ASTERISK_SVG}</span>`;
      default: return '';
    }
  }

  // "Added <date> (<n> days ago)" for each of a dog's currently-set stickers
  // that has a known add date (dog.stickerDates, from the single-dog fetch --
  // see /api/dogs/:id). Shown next to the marker picker when staff are
  // setting stickers, so it's clear how long each one has already been on,
  // not just whether it's on. Dogs loaded before stickerDates existed, or a
  // sticker set before that tracking began, simply have no date and are left
  // off the list rather than showing a wrong or blank one.
  function stickerAddedHtml(dog) {
    const dates = dog.stickerDates || {};
    const rows = markerBreakdownRows(dog, false).filter((r) => r.key && dates[r.key]);
    if (!rows.length) return '';
    return `<ul class="marker-breakdown-list sticker-added-list">${rows.map((r) =>
      `<li>${r.icon} <span class="small muted">${esc(r.name)} — added ${fmtNoteDate(dates[r.key])} (${daysAgoText(dates[r.key])})</span></li>`
    ).join('')}</ul>`;
  }

  // Same list as stickerAddedHtml's rows, but every current marker (not just
  // the ones with a known add date) so it doubles as the plain breakdown —
  // a row with no tracked date (set before that tracking began) just omits
  // the "added" suffix instead of being left off the list.
  function markerBreakdownHtml(dog) {
    const rows = markerBreakdownRows(dog, dog.isHistorical);
    if (!rows.length) return '<p class="small muted">No behavior stickers set.</p>';
    const dates = dog.stickerDates || {};
    return `<ul class="marker-breakdown-list">${rows.map((r) => {
      const addedAt = r.key && dates[r.key];
      const added = addedAt ? ` <span class="small muted">— added ${fmtNoteDate(addedAt)} (${daysAgoText(addedAt)})</span>` : '';
      return `<li>${r.icon}<span class="marker-breakdown-text">${esc(r.name)}${added}</span></li>`;
    }).join('')}</ul>`;
  }

  // A dog photo that fails to load (dead source URL, or a cache file that
  // never got created) falls back to the same drawn silhouette (SVG, so it
  // stays crisp) that a dog with no photo at all gets, shown at a fixed size
  // instead of stretched -- one delegated listener covers every
  // dog-photo/profile-photo image anywhere in the app, present or future,
  // since 'error' doesn't bubble but IS reachable in the capture phase.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.classList.contains('dog-photo') && !img.classList.contains('profile-photo')) return;
    if (img.dataset.fallbackApplied) return; // never loop if the fallback itself 404s
    img.dataset.fallbackApplied = '1';
    img.classList.add('photo-fallback');
    const holder = img.closest('[data-species]');
    const cat = (img.dataset.species || (holder && holder.dataset.species)) === 'cat';
    const id = Number(img.dataset.dogId || cardAnimalId(img) || (img.closest('[data-id]') || {}).dataset?.id) || 0;
    img.src = `/dog-silhouettes/${cat ? 'cat-' : ''}${id}.svg?v=1`;
  }, true);

  // Full-screen, uncropped photo viewer -- for any .photo-lightbox-trigger
  // image, and for an animal's photo on its card (see just below).
  function showImageLightbox(src, alt) {
    if (!src) return;
    const lightbox = document.getElementById('imageLightbox');
    const img = document.getElementById('imageLightboxImg');
    // A list card's picture is the small thumbnail; full screen shows the photo.
    img.src = String(src).replace(/\/cached-images\/thumbs\//, '/cached-images/');
    img.alt = alt || '';
    openOverlay(lightbox);
  }
  // Tapping an animal's card, wherever one is shown (Available, Updates,
  // Stats, the scan screen...): the photo opens full screen, and the name or
  // anything else in the info area opens their profile. One capture-phase
  // handler, so no card's own listeners compete with it. A stand-in picture
  // (no photo yet: the drawn silhouette or the app icon) opens the profile.
  // Pick lists (search results), the new-card screen and the walk edit
  // controls keep their own taps, as do buttons/inputs inside the info area.
  const CARD_TAP_SKIP = '.search-result, .add-walk-dog-result, .unlisted-card, .edit-times-row, .walk-confirm-skip';
  const isRealPhoto = (img) => img instanceof HTMLImageElement && !img.dataset.fallbackApplied
    && !/\/dog-silhouettes\/|\/icons\//.test(img.getAttribute('src') || '');
  function cardAnimalId(el) {
    const tagged = el.closest('[data-dog-id]') || el.closest('[data-dogid]');
    if (tagged) return tagged.dataset.dogId || tagged.dataset.dogid;
    const card = el.closest('.card[data-id]');
    return card ? card.dataset.id : null;
  }
  async function openAnimalProfile(id) {
    try {
      const { dog, walks } = await api(`/api/dogs/${id}?userId=${state.currentUser.id}`);
      showProfileSheet(dog, walks);
    } catch (err) { toast(err.message, 'error'); }
  }
  document.addEventListener('click', (e) => {
    const photo = e.target.closest('.dog-card .dog-photo');
    const info = !photo && e.target.closest('.dog-card .dog-info');
    const el = photo || info;
    if (!el || el.closest(CARD_TAP_SKIP) || (info && tapOnNameControl(e))) return;
    if (photo && isRealPhoto(photo)) {
      e.stopPropagation();
      showImageLightbox(photo.src, photo.closest('.dog-card').querySelector('.dog-name')?.textContent.trim() || '');
      return;
    }
    const id = cardAnimalId(el);
    if (!id) return;
    e.stopPropagation();
    openAnimalProfile(id);
  }, true);
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.photo-lightbox-trigger');
    if (!trigger) return;
    e.stopPropagation();
    showImageLightbox(trigger.src, trigger.alt);
  });
  // A dog's name holds its own tappable bits (marker badges, the returned-dog
  // and QR buttons); a tap on one of those is theirs, not the name's.
  function tapOnNameControl(e) {
    return !!e.target.closest('.marker-badges-toggle, button, a, .edited-badge, input, select, textarea, label');
  }

  // Names the shelter used before renaming a dog: shown under the
  // current name, and searching for one still finds the dog.
  function akaHtml(dog, extraClass) {
    const names = (dog && dog.previousNames) || [];
    return names.length ? `<p class="dog-aka${extraClass ? ' ' + extraClass : ''}">aka <span class="aka-names">${esc(names.join(', '))}</span></p>` : '';
  }
  // q is already trimmed and lowercased.
  function dogNameMatches(dog, q) {
    return [dog.name, ...(dog.previousNames || [])].some((n) => String(n).toLowerCase().includes(q));
  }

  // The heart next to a dog's name, wherever it's shown. One delegated
  // handler keeps every copy of a dog's heart (card and profile) in step.
  function favButtonHtml(dog) {
    const on = !!dog.isFavorite;
    return `<button type="button" class="fav-btn${on ? ' on' : ''}" data-dog-id="${dog.id}" aria-pressed="${on}" aria-label="${on ? 'Remove from favorites' : 'Add to favorites'}" title="${on ? 'Remove from favorites' : 'Add to favorites'}">${on ? '♥' : '♡'}</button>`;
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.fav-btn');
    if (!btn) return;
    e.stopPropagation();
    const dogId = btn.dataset.dogId;
    const favorite = !btn.classList.contains('on');
    const paint = (on) => {
      document.querySelectorAll(`.fav-btn[data-dog-id="${dogId}"]`).forEach((b) => {
        b.classList.toggle('on', on);
        b.textContent = on ? '♥' : '♡';
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
        b.title = on ? 'Remove from favorites' : 'Add to favorites';
      });
      (state.availableDogsRaw || []).forEach((d) => { if (String(d.id) === dogId) d.isFavorite = on; });
    };
    paint(favorite);
    try {
      await api(`/api/users/${state.currentUser.id}/favorites/${dogId}`, { method: 'PUT', body: JSON.stringify({ favorite }) });
      toast(favorite ? 'Added to your favorites' : 'Removed from your favorites');
    } catch (err) {
      paint(!favorite);
      toast(err.message, 'error');
    }
  });
  document.getElementById('closeImageLightboxBtn').addEventListener('click', () => {
    closeOverlay(document.getElementById('imageLightbox'));
  });
  document.getElementById('imageLightbox').addEventListener('click', (e) => {
    if (e.target.id === 'imageLightbox') closeOverlay(e.target);
  });

  // Full-screen QR code linking to a dog's public adoption page, so a walker
  // can show it to a member of the public who wants more information.
  function showDogQrLightbox(dogId, dogName) {
    const lightbox = document.getElementById('dogQrLightbox');
    document.getElementById('dogQrLightboxImg').src = `/api/dogs/${dogId}/qr.svg`;
    document.getElementById('dogQrLightboxImg').alt = `QR code linking to ${dogName}'s adoption page`;
    document.getElementById('dogQrLightboxName').textContent = dogName;
    openOverlay(lightbox);
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.dog-qr-btn');
    if (!trigger) return;
    e.stopPropagation();
    showDogQrLightbox(trigger.dataset.dogId, trigger.dataset.dogName);
  });
  // Every finished walk a dog has had, grouped by day. Yours are marked;
  // anyone else's just says "another volunteer" (the server never sends who).
  async function showDogWalkHistory(dogId) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = '<h3 style="margin-top:0;">🕘 History</h3><p class="muted small center loading-line" role="status">Loading…</p>';
    openOverlay(popup);
    try {
      const { name, species, walks, totals } = await api(`/api/dogs/${dogId}/walk-history`);
      const t = termsOf({ species });
      const mineCount = walks.filter((w) => w.mine).length;
      const days = new Map();
      for (const w of walks) {
        const key = w.date || dateKey(w.startedAt);
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(w);
      }
      // Your own show their times; anyone else's only the walk window and
      // a length to the nearest 5 minutes (the server sends no more).
      const whenText = (w) => (w.mine
        ? `${fmtClockRange(w.startedAt, w.endedAt)} · ${fmtDuration(w.durationSeconds)}`
        : `${WALK_SLOTS[w.slot] ? fmtSlotLabel(WALK_SLOTS[w.slot].label) : 'Outside walk hours'} · ${roundedLength(w.durationSeconds)}`);
      const daysHtml = Array.from(days.entries()).map(([key, dayWalks]) => `
        <p class="small walk-history-day">${fmtDayHeading(key)}</p>
        ${dayWalks.map((w) => `
          <div class="walk-history-row${w.mine ? ' mine' : ''}">
            <span class="small"><span title="${activityInfo(w.activity).label}">${activityInfo(w.activity).emoji}</span> ${whenText(w)}</span>
            ${w.mine ? '<span class="badge eligible">You</span>' : '<span class="small muted">Another volunteer</span>'}
          </div>`).join('')}`).join('');
      content.innerHTML = `
        <h3 style="margin-top:0;">🕘 ${esc(name)}'s ${t.nouns}</h3>
        ${walks.length
    ? `<p class="small muted">${walks.length} ${walks.length === 1 ? t.noun : t.nouns}${mineCount ? `, ${mineCount} with you` : ''}${totals && totals.totalSeconds ? ` · ${fmtDuration(totals.totalSeconds)} in all` : ''}.</p><div class="walk-history-list">${daysHtml}</div>`
    : `<p class="small muted">No ${t.nouns} recorded for ${esc(name)}.</p>`}
      `;
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">🕘 History</h3><p class="small muted">Couldn't load the history: ${esc(err.message)}</p>`;
    }
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.walk-history-btn');
    if (!trigger) return;
    e.stopPropagation();
    showDogWalkHistory(trigger.dataset.dogId);
  });
  document.getElementById('closeDogQrLightboxBtn').addEventListener('click', () => {
    closeOverlay(document.getElementById('dogQrLightbox'));
  });
  document.getElementById('dogQrLightbox').addEventListener('click', (e) => {
    if (e.target.id === 'dogQrLightbox') closeOverlay(e.target);
  });

  // Universal marker-meaning popup — one delegated listener covers every
  // place markerBadges() output ends up in the DOM, since the tappable span
  // it wraps things in already carries the data it needs.
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.marker-badges-toggle');
    if (!toggle) return;
    e.stopPropagation();
    let dog;
    try { dog = JSON.parse(toggle.dataset.dogInfo); } catch (err) { return; }
    showMarkerBreakdownPopup(dog);
  });

  // Opened by tapping a dog's letters/behavior-marker badges. Always shows
  // the sticker history, not just the current state: current markers (with
  // when each was added, from stickerDates) at the top, then a timeline of
  // every sticker on/off change below -- so "why does this dog have a J"
  // doesn't require a separate trip to the 📜 timeline.
  async function showMarkerBreakdownPopup(dog) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    const title = `${esc(dog.name)}'s stickers`;
    const guideLinkHtml = `<p class="small" style="margin:10px 0 0;"><a href="#" id="markerGuideLink">See what every sticker means in the Guide</a></p>`;
    const wireGuideLink = () => {
      document.getElementById('markerGuideLink').addEventListener('click', async (e) => {
        e.preventDefault();
        // Wait for the popup's history entry to actually pop before the Guide
        // pushes its own -- doing both back to back races, and the pending
        // "back" lands on the Guide's entry instead.
        popup.classList.add('hidden');
        if (overlayEntries.delete(popup.id)) await consumeHistoryEntry();
        openGuide('sticker');
      });
    };
    // A handful of callers only have a partial dog-like object (a walk or
    // event row, no id to look up) -- fall back to just the current markers,
    // same as before this popup grew a history.
    if (!dog.id) {
      content.innerHTML = `<h3 style="margin-top:0;">${title}</h3>${markerBreakdownHtml(dog)}${guideLinkHtml}`;
      wireGuideLink();
      openOverlay(popup);
      return;
    }
    content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="muted small center loading-line" role="status">Loading…</p>`;
    openOverlay(popup);
    try {
      const [{ dog: fullDog }, history] = await Promise.all([
        api(`/api/dogs/${dog.id}?userId=${state.currentUser.id}`),
        api(`/api/dogs/${dog.id}/stay-history`)
      ]);
      const stickerItems = history.stickerEvents.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).reverse()
        .map((e) => ({ occurredAt: e.occurredAt, label: timelineEventLabel(e) }));
      content.innerHTML = `
        <h3 style="margin-top:0;">${title}</h3>
        ${markerBreakdownHtml(fullDog)}
        <p class="small muted" style="margin:14px 0 2px;">Sticker history</p>
        ${stickerItems.length ? timelineHtml(stickerItems) : '<p class="small muted">No sticker changes yet.</p>'}
        <p class="small muted">Showing the last ${history.months} months.</p>
        ${guideLinkHtml}
      `;
      wireGuideLink();
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="small muted">Couldn't load ${esc(dog.name)}'s stickers: ${esc(err.message)}</p>`;
    }
  }
  document.getElementById('closeMarkerInfoPopupBtn')?.addEventListener('click', () => {
    closeOverlay(document.getElementById('markerInfoPopup'));
  });
  document.getElementById('markerInfoPopup')?.addEventListener('click', (e) => {
    if (e.target.id === 'markerInfoPopup') closeOverlay(e.target);
  });

  function fmtDayHeading(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function groupWalksByDay(walks) {
    const completed = walks.filter((w) => w.ended_at);
    const days = new Map();
    for (const w of completed) {
      const key = dateKey(w.started_at);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(w);
    }
    return Array.from(days.entries())
      .map(([key, dayWalks]) => {
        dayWalks.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
        return {
          key,
          walks: dayWalks,
          dogCount: new Set(dayWalks.map((w) => w.dog_id)).size,
          walkCount: dayWalks.length,
          firstStart: dayWalks[0].started_at,
          lastEnd: dayWalks[dayWalks.length - 1].ended_at
        };
      })
      .sort((a, b) => (a.key < b.key ? 1 : -1));
  }

  function fmtDate(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: SHELTER_TZ });
  }

  // The one short date format: "Nov 4", with the year only when it isn't
  // this year. Takes an ISO time or a YYYY-MM-DD shelter day key.
  function fmtShortDate(isoOrKey) {
    if (!isoOrKey) return '';
    const key = /^\d{4}-\d{2}-\d{2}$/.test(isoOrKey) ? isoOrKey : dateKey(isoOrKey);
    const [y, m, d] = key.split('-').map(Number);
    const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (y !== shelterParts().y) opts.year = 'numeric';
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, opts);
  }
  // Short date for a note: "Oct 9", with the year only when it isn't this year.
  const fmtNoteDate = fmtShortDate;

  // "Oct 9" plus "edited Oct 12" when it was changed on a later day.
  function noteDateHtml(createdAt, updatedAt) {
    const made = fmtNoteDate(createdAt);
    const edited = updatedAt && dateKey(updatedAt) !== dateKey(createdAt) ? ` · edited ${fmtNoteDate(updatedAt)}` : '';
    return `<span class="tip-date">${made}${edited}</span>`;
  }

  // Balloons + confetti floating up for a second when a newly-detected
  // adoption first appears — purely celebratory, no user action needed.
  // The 20-hour level-up offer uses a slower, bigger, balloon-heavy version.
  function playCelebration({ emojis = ['🎈', '🎉', '🎊', '🐕', '🐶', '🐩'], count = 18, seconds = 1.8 } = {}) {
    const container = document.createElement('div');
    container.className = 'celebrate-overlay';
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span');
      span.className = 'celebrate-piece';
      span.textContent = emojis[i % emojis.length];
      span.style.left = `${Math.random() * 100}%`;
      span.style.animationDelay = `${Math.random() * (seconds / 3.6)}s`;
      span.style.animationDuration = `${seconds}s`;
      span.style.fontSize = `${1.2 + Math.random() * 1.3}rem`;
      container.appendChild(span);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), seconds * 1000 + 200 + (seconds / 3.6) * 1000);
  }

  // A Beginner whose walks pass 20 hours: balloons, then one question about
  // moving up to Established. The server only offers it once (see
  // levelUpOffer in server.js); Settings can change the level any time.
  async function maybeOfferLevelUp(offered) {
    if (!offered) return;
    playCelebration({ emojis: ['🎈', '🎈', '🎈', '🎉', '🐶'], count: 32, seconds: 4 });
    const yes = await appConfirm(
      "You've spent 20 hours with the dogs on Shelter Walk (daycations aside). That's the Established level: dogs in the shelter 7+ days, plus behavior (blue) stickers, PB dogs and dogs pending adoption (EVO dogs still need Experienced). Update your level to Established? You can change it any time in Settings.",
      { title: '🎈 20 hours of volunteering! 🎈', confirmText: 'Yes, make me Established', cancelText: 'Stay Beginner' }
    );
    try {
      const updated = await api(`/api/users/${state.currentUser.id}/level-up-offer`, { method: 'POST', body: JSON.stringify({ accept: yes }) });
      state.currentUser.experienceLevel = updated.experienceLevel;
      if (yes) {
        toast("You're Established now. Thank you! 🐾");
        if (state.tab !== 'walk') render(); // the dog list depends on your level
      }
    } catch (err) {
      if (yes) appAlert(err.message);
    }
  }

  // Alumni dogs get bonus days toward eligibility on top of their actual
  // time in shelter — show both so it's clear why an "old" dog is eligible.
  // Every dog also gets a tappable "log" icon next to their stay length that
  // opens their full timeline (arrived, pending adoption, adopted, returned,
  // taken off the floor, etc.) -- this app-only icon has no printed
  // equivalent on the dog's physical kennel card.
  function shelterDaysHtml(dog) {
    const hasReturnHistory = dog.previousDaysInShelter > 0;
    // A dog on their second (or later) stay can show 0-ish days for the
    // current one right after coming back -- shown alone that reads as "just
    // arrived", which is wrong and confusing for a dog who's actually been
    // around, on and off, for a while. Showing both numbers makes clear the
    // first is just this stay.
    const days = dog.isAlumni
      ? `<span title="Alumni (returned dog) - ${dog.daysInShelter} actual days, ${dog.effectiveDaysInShelter} days for walking privileges (+${dog.alumniBonusDays} bonus)">${dog.daysInShelter}d*</span>`
      : hasReturnHistory
        ? `<span title="${dog.daysInShelter} day${dog.daysInShelter === 1 ? '' : 's'} this stay, ${dog.daysInShelter + dog.previousDaysInShelter} total across all stays. Tap ↩️ for the full timeline">${dog.daysInShelter}d/${dog.daysInShelter + dog.previousDaysInShelter}d</span>`
        : `${dog.daysInShelter}d`;
    // ↩️ is the app's one "returned" icon (same as the Updates filter); a
    // dog who has never left gets the plain timeline icon.
    const returned = hasReturnHistory || dog.isAlumni;
    const log = ` <button type="button" class="mini-icon-btn stay-log-btn" data-dog-id="${dog.id}" data-dog-name="${esc(dog.name)}" title="See ${esc(dog.name)}'s shelter timeline${returned ? ' (returned before)' : ''}" aria-label="${esc(dog.name)}'s shelter timeline${returned ? ', returned before' : ''}">${returned ? '↩️' : '📜'}</button>`;
    return days + log;
  }

  // Human-readable version of the server's notEligibleReason code, shown on
  // every "can't walk this dog" badge/alert (Available cards, the confirm
  // screen's badge, the Start Walk block). Always "Not eligible: <why>" so
  // the same reason reads the same way everywhere, including the hard
  // too-young block, which has its own badge styling but the same wording.
  function notEligibleReasonText(dog) {
    return `Not eligible: ${notEligibleWhy(dog)}`;
  }
  function notEligibleWhy(dog) {
    let why;
    switch (dog.notEligibleReason) {
      case 'too_young':
        why = `Too young to walk${dog.age ? ` (${fmtAge(dog.age)})` : ''}`;
        break;
      case 'evo_restricted':
        why = 'Experienced volunteers only (EVO)';
        break;
      case 'blue_restricted':
        why = 'Behavior sticker not cleared for your level';
        break;
      case 'pb_restricted':
        why = 'Potty break only (PB), not cleared for your level';
        break;
      case 'pending_restricted':
        why = 'Pending adoption, not cleared for Beginners';
        break;
      case 'stray_hold':
        why = 'Stray hold (PB only)';
        break;
      case 'in_foster':
        why = 'In foster care (not at the shelter)';
        break;
      case 'days': {
        const effective = dog.effectiveDaysInShelter != null ? dog.effectiveDaysInShelter : dog.daysInShelter;
        const remaining = dog.minDaysForLevel != null ? dog.minDaysForLevel - effective : null;
        why = remaining != null && remaining > 0
          ? `Needs ${remaining} more day${remaining === 1 ? '' : 's'} in shelter for your level`
          : 'Not enough time in shelter yet for your level';
        break;
      }
      default:
        why = 'cannot walk right now';
    }
    return why;
  }

  // The eligibility status row, on the Available card and the scan screen:
  // one solid strip that fits the card (no pill floating on a see-through
  // card over the stripes). Four looks:
  //   eligible  green pill, as before;
  //   block     red tint, "Not eligible" + why (Start is disabled);
  //   caution   amber tint, listed as in foster: not a block, Start only asks
  //             to check the kennel card, so it never says "Not eligible";
  //   hard      solid red, too young (no exceptions).
  // `eligibleText` is the green pill's wording (shorter on the cards).
  function eligibilityStatusHtml(dog, { eligibleText = 'Eligible ✓' } = {}) {
    if (!speciesOf(dog).levelRules) return ''; // any volunteer may visit any of them
    const row = (kind, icon, title, why) => `<div class="elig-status elig-${kind}"><span class="elig-icon" aria-hidden="true">${icon}</span><span class="elig-text"><strong>${esc(title)}</strong>${why ? `<span class="elig-why">${esc(why)}</span>` : ''}</span></div>`;
    if (dog.tooYoung) return row('hard', '🚫', 'Not eligible', notEligibleWhy(dog));
    if (dog.eligible) return `<span class="badge eligible">${esc(eligibleText)}</span>`;
    if (dog.notEligibleReason === 'in_foster') return row('caution', '⚠️', notEligibleWhy(dog), 'Start asks you to check the kennel card');
    return row('block', '⛔', 'Not eligible', notEligibleWhy(dog));
  }

  // What a volunteer can do with a dog. All of them are timed and count
  // exactly like a walk; they only look different -- except a daycation (the
  // dog out for the day), which runs up to 12 hours with no +10 min, no
  // length alerts and no closing-time stop (server.js walkLimitMinutes).
  const ACTIVITIES = {
    walk: { emoji: '🚶', label: 'Walk', noun: 'walk', out: 'Currently being walked by' },
    cuddle: { emoji: '🤗', label: 'Cuddle', noun: 'cuddle', out: 'Currently cuddling with' },
    matchmaking: { emoji: '💞', label: 'Matchmaking', noun: 'matchmaking session', out: 'Currently at matchmaking with' },
    // countNoun: the word when counting ("26 playgroup sessions", not "26 playgroups").
    playgroup: { emoji: '🥎', label: 'Playgroup', noun: 'playgroup', countNoun: 'playgroup session', out: 'Currently at playgroup with' },
    daycation: { emoji: '🚗', label: 'Daycation', noun: 'daycation', out: 'Currently on a daycation with' }
  };
  // Longest an activity can be recorded as, in hours, when saying when it ended.
  const maxActivityHours = (activity) => (activity === 'daycation' ? SHARED_CONFIG.daycationMinutes : SHARED_CONFIG.maxTotalMinutes) / 60;
  // One default per species (audit 3): defaultActivity is the dogs',
  // defaultActivityCat the cats' (null = the cats' first activity), so a
  // "both" volunteer's Matchmaking for cats never makes every dog matchmaking.
  // Any other species uses the dogs' when it can, else its own first one.
  const DEFAULT_KEY = { dog: 'defaultActivity', cat: 'defaultActivityCat' };
  const defaultKeyFor = (speciesKey) => DEFAULT_KEY[speciesKey] || 'defaultActivity';
  function usualActivity(speciesKey = 'dog') {
    const allowed = speciesInfo(speciesKey).activities || Object.keys(ACTIVITIES);
    const own = state.currentUser[defaultKeyFor(speciesKey)];
    if (ACTIVITIES[own] && allowed.includes(own)) return own;
    return allowed.includes('walk') ? 'walk' : allowed[0];
  }
  // Every picker of the CURRENT activity (the start screens, the one in
  // progress) works the same: tap a chip to switch just this one, tap the
  // chip that's already picked again (a double tap does both) to also make
  // it your usual -- the same setting as Settings. The chips say so: the
  // usual one is labelled "Default", and a picked one that isn't says
  // "Tap again to set as default" (plus a toast on the tap that picked it).
  const usualFor = (dog) => (dog ? usualActivityFor(dog) : usualActivity());
  function syncActivityChips(row, picked, dog) {
    if (!row) return;
    const usual = usualFor(dog);
    row.querySelectorAll('[data-activity]').forEach((chip) => {
      const a = activityInfo(chip.dataset.activity);
      const key = chip.dataset.activity;
      const sub = key === usual ? 'Default' : key === picked ? 'Tap again to set as default' : '';
      chip.classList.toggle('active', key === picked);
      chip.innerHTML = `<span class="chip-main">${a.emoji} ${a.label}</span>${sub ? `<span class="chip-sub">${sub}</span>` : ''}`;
    });
  }
  // The toast for a tap that picked an activity just for this one.
  function pickedActivityToast(activity, dog, lead) {
    const a = activityInfo(activity);
    toast(activity === usualFor(dog)
      ? `${lead} ${a.emoji} ${a.label}`
      : `${lead} ${a.emoji} ${a.label} for this one. Tap it again to set it as your default.`);
  }
  async function makeUsualActivity(activity, row, dog) {
    if (activity === usualFor(dog)) return;
    // Only this species' default: a cat's chip sets the cats' one.
    const speciesKey = (dog && dog.species) || 'dog';
    const field = defaultKeyFor(speciesKey);
    try {
      const updated = await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ [field]: activity }) });
      state.currentUser[field] = updated[field];
      const a = activityInfo(updated[field]);
      const both = prefSpeciesKeys().length > 1;
      toast(`${a.emoji} ${a.label} is now your default activity${both ? ` for ${speciesInfo(speciesKey).plural.toLowerCase()}` : ''}`);
      syncActivityChips(row, activity, dog);
    } catch (err) { toast(err.message, 'error'); }
  }
  // keys: which activities to offer (an animal's species allows only some).
  function activityChipsHtml(selected, keys = Object.keys(ACTIVITIES)) {
    return keys.filter((key) => ACTIVITIES[key]).map((key) => {
      const a = ACTIVITIES[key];
      return `<button type="button" class="btn small-btn filter-chip ${key === selected ? 'active' : ''}" data-activity="${key}"><span class="chip-main">${a.emoji} ${a.label}</span></button>`;
    }).join('');
  }
  // The default-activity chips (Settings, onboarding): one row per species
  // the volunteer works with, labelled when there's more than one.
  function defaultActivityRowsHtml(speciesKeys) {
    const many = speciesKeys.length > 1;
    return speciesKeys.map((k) => {
      const info = speciesInfo(k);
      const row = `<div class="marker-row activity-chips" data-species="${esc(k)}">${activityChipsHtml(usualActivity(k), info.activities)}</div>`;
      return many ? `<p class="small muted default-activity-label">${info.emoji || ''} For ${esc(info.plural.toLowerCase())}</p>${row}` : row;
    }).join('');
  }

  // ---------- Species (dogs, cats) ----------
  // What each species can do comes from the server (species.js, sent with
  // /api/me): its activities, whether it has kennel card stickers, and
  // whether experience levels decide who may take it out.
  const FALLBACK_SPECIES = {
    dog: { label: 'Dog', plural: 'Dogs', noun: 'dog', emoji: '🐕', activities: Object.keys(ACTIVITIES), stickers: true, levelRules: true }
  };
  const speciesTable = () => (state.currentUser && state.currentUser.species) || FALLBACK_SPECIES;
  const speciesInfo = (key) => speciesTable()[key] || speciesTable().dog;
  const speciesOf = (dog) => speciesInfo(dog && dog.species);
  // Where one lives, in its own words: dogs have a kennel (in a wing), cats a
  // condo (in a room). The picker label is the place you pick: "Kennel
  // location" for dogs, the cats' "Room".
  const kennelWordOf = (dog) => (speciesOf(dog).kennelLabel === 'Room' ? 'condo' : 'kennel');
  const kennelPickLabel = (kind) => (kind && kind.kennelLabel && kind.kennelLabel !== 'Kennel wing' ? kind.kennelLabel : 'Kennel location');
  // Who this volunteer works with (Settings): 'dog', 'cat' or 'both'.
  const speciesPref = () => (state.currentUser && state.currentUser.speciesPref) || 'dog';
  const prefSpeciesKeys = () => (speciesPref() === 'both' ? Object.keys(speciesTable()) : [speciesPref()]);
  const worksWithBoth = () => prefSpeciesKeys().length > 1;
  // "dog", "cat", or "animal" for wording that covers more than one.
  const nounFor = (keys, plural) => (keys.length === 1
    ? (plural ? speciesInfo(keys[0]).plural.toLowerCase() : speciesInfo(keys[0]).noun)
    : (plural ? 'animals' : 'animal'));
  // What time with an animal is called (species.js terms): dogs are walked,
  // cats are cuddled, and anything covering more than one species says
  // "engage". termsFor(keys) for a list or screen, termsOf(dog) for one
  // animal, myTerms() for the volunteer's own (their Settings choice).
  const ENGAGE_TERMS = { verb: 'engage', verbWith: 'engage with', past: 'engaged with', noun: 'engagement', nouns: 'engagements', ing: 'engaging' };
  const DOG_TERMS = { verb: 'walk', verbWith: 'walk', past: 'walked', noun: 'walk', nouns: 'walks', ing: 'walking' };
  function termsFor(keys) {
    const kinds = [...new Set(keys)];
    return kinds.length === 1 ? (speciesInfo(kinds[0]).terms || DOG_TERMS) : ENGAGE_TERMS;
  }
  // Labels for counts that cover EVERY activity (walks, cuddles,
  // playgroups...): dogs say "engagement", never "walked"/"walking", since a
  // cuddle isn't a walk. Cats keep their own wording (they're never walked).
  // `avg` is for walkOnlyAvgSeconds, which is walks-only whenever there are walks.
  // `n` (optional): { count, unique } -- the numbers the labels sit under,
  // so a 1 reads "1 / Engagement", "1 / Cat cuddled", never "1 Cats".
  function statWords(keys, n = {}) {
    const t = termsFor(keys);
    const nouns = capFirst(nounFor(keys, n.unique !== 1));
    if (t.verb !== 'walk') {
      return { t, count: n.count === 1 ? `Total ${t.noun}` : `Total ${t.nouns}`, unique: `${nouns} ${t.past}`, time: `Total time ${t.ing}`, avg: `Avg ${t.noun} length`, noun: t.noun, nounsWord: t.nouns };
    }
    return { t, count: n.count === 1 ? 'Engagement' : 'Engagements', unique: `${nouns} spent time with`, time: 'Total time together', avg: 'Avg walk length', noun: 'engagement', nounsWord: 'engagements' };
  }
  const termsOf = (dog) => termsFor([(dog && dog.species) || 'dog']);
  const myTerms = () => termsFor(state.currentUser ? prefSpeciesKeys() : ['dog']);
  // For a summary of PAST activity (lifetime/today/one-day stats): the
  // wording has to follow the species that history actually happened with,
  // never the volunteer's current Settings preference -- otherwise flipping
  // that preference (dog -> cat, say) instantly relabels old dog walks as
  // "play sessions" even though nothing about those walks changed. Only
  // falls back to the current preference when there's no history at all to
  // get wrong (an empty-state message, say).
  const historySpeciesKeys = (rows) => {
    const keys = [...new Set((rows || []).map((r) => r.species).filter(Boolean))];
    return keys.length ? keys : prefSpeciesKeys();
  };
  const historyTerms = (rows) => termsFor(historySpeciesKeys(rows));
  const capFirst = (str) => str.charAt(0).toUpperCase() + str.slice(1);
  const aNoun = (t) => `${/^[aeiou]/.test(t.noun) ? 'an' : 'a'} ${t.noun}`;
  // Fixed page text (Settings, Privacy) marked data-term="past" etc. follows
  // who the volunteer works with.
  function applyTermsToPage() {
    const t = myTerms();
    const animal = nounFor(prefSpeciesKeys());
    const words = { ...t, animal, animals: nounFor(prefSpeciesKeys(), true), aNoun: aNoun(t), aAnimal: `${/^[aeiou]/.test(animal) ? 'an' : 'a'} ${animal}` };
    document.querySelectorAll('[data-term]').forEach((el) => {
      const word = words[el.dataset.term];
      if (word) el.textContent = el.dataset.cap ? capFirst(word) : word;
    });
  }
  // Onboarding / Settings wording for who someone works with: the noun
  // ("dog", "cat", "dog or cat"), and what they do with them.
  function prefWords() {
    const keys = prefSpeciesKeys();
    const t = termsFor(keys);
    return {
      noun: keys.map((k) => speciesInfo(k).noun).join(' or '),
      nouns: keys.map((k) => speciesInfo(k).plural.toLowerCase()).join(' and '),
      did: t.past,
      start: aNoun(t)
    };
  }
  // The usual activity, or this animal's first one when it can't do that
  // (a dog walker scanning a cat gets a cuddle).
  function usualActivityFor(dog) {
    const allowed = speciesOf(dog).activities;
    const usual = usualActivity((dog && dog.species) || 'dog');
    return allowed.includes(usual) ? usual : allowed[0];
  }
  const kennelsOf = (dog) => speciesOf(dog).kennels || KENNEL_LETTERS;
  // A kitten (the shelter's tag, see species.js youngFirst), and a warning
  // when this volunteer has been with an adult cat this shift: adult -> kitten
  // can pass disease on, so kittens come first.
  function youngBadgeHtml(dog) {
    const rule = speciesOf(dog).youngFirst;
    if (!rule || !dog.isYoung) return '';
    return `<span class="badge young" title="${esc(rule.young)}">🍼 ${esc(rule.young.charAt(0).toUpperCase() + rule.young.slice(1))}</span>`
      + (dog.handlingWarning ? ` <span class="badge caution" title="You were with ${esc(dog.handlingWarning.name)} (an ${esc(dog.handlingWarning.adult)}) earlier">⚠ After an ${esc(dog.handlingWarning.adult)}</span>` : '');
  }
  // Mid-adoption cats (any species with wrap-up checks) live behind a lock.
  const relockNeeded = (dog) => !!(dog && dog.isPendingAdoption && (speciesOf(dog).wrapUpChecks || []).length);
  // End screen reminders (species.js wrapUpChecks). Ticking is just for the
  // volunteer: nothing is saved or required.
  function wrapUpChecklistHtml(dog) {
    const checks = [...(speciesOf(dog).wrapUpChecks || [])];
    if (!checks.length) return '';
    if (relockNeeded(dog)) checks.splice(1, 0, 'Being adopted: condo locked again');
    return `<fieldset class="wrap-up-checks"><legend class="small">Before you move on</legend>
      ${checks.map((c) => `<label class="small"><input type="checkbox" /> ${esc(c)}</label>`).join('')}</fieldset>`;
  }
  function handlingWarningText(dog) {
    const w = dog.handlingWarning;
    if (!w) return '';
    return `You were with ${w.name}, an ${w.adult}, at ${fmtClock(w.at)}. Going from an ${w.adult} to a ${w.young} can pass disease on to the ${w.young}: ${w.young}s first, then ${w.adult}s, never the other way round. Wash up and change your gown or gloves first, or pick another ${w.adult} instead.`;
  }
  // A small species tag on cards, only for someone who sees more than one.
  // The species the lists show right now: always exactly one. Someone who
  // works with both picks with the Dogs / Cats switch (dogs until they do);
  // everyone else just sees their own.
  function viewSpeciesKeys() {
    const keys = prefSpeciesKeys();
    return [keys.includes(state.speciesView) ? state.speciesView : keys[0]];
  }
  // The Updates feed's choice, which can also be all of them.
  function updatesSpeciesKeys() {
    const keys = prefSpeciesKeys();
    return keys.includes(state.updatesSpeciesView) ? [state.updatesSpeciesView] : keys;
  }
  const inSpeciesView = (dog, keys = viewSpeciesKeys()) => keys.includes((dog && dog.species) || 'dog');
  function setSpeciesView(view, forUpdates) {
    const key = forUpdates ? 'updatesSpeciesView' : 'speciesView';
    state[key] = view;
    try { localStorage.setItem(key, view); } catch (e) { /* this device only, best effort */ }
  }
  function speciesSwitchHtml(forUpdates) {
    if (!worksWithBoth()) return '';
    const keys = forUpdates ? updatesSpeciesKeys() : viewSpeciesKeys();
    const view = keys.length > 1 ? 'all' : keys[0];
    const btn = (key, label) => `<button type="button" class="seg-btn ${view === key ? 'on' : ''}" data-species-view="${key}" role="radio" aria-checked="${view === key}">${label}</button>`;
    return `<div class="seg seg-small species-switch" role="radiogroup" aria-label="${forUpdates ? 'Show dogs, cats or both' : 'Show dogs or cats'}" style="margin:0 0 8px;">
      ${prefSpeciesKeys().map((key) => btn(key, `${speciesInfo(key).emoji} ${esc(speciesInfo(key).plural)}`)).join('')}${forUpdates ? btn('all', 'All') : ''}</div>`;
  }
  // Dogs / Cats / Both chips (Settings and onboarding); the choice lives on
  // the container's data-selected.
  function speciesPrefPickerHtml(selected) {
    const opts = [...Object.entries(speciesTable()).map(([key, info]) => [key, `${info.emoji} ${info.plural}`]), ['both', 'Both']];
    return opts.map(([key, label]) => `<button type="button" class="btn small-btn filter-chip ${key === selected ? 'active' : ''}" data-species-pref="${key}" style="width:auto;flex:0 0 auto;">${esc(label)}</button>`).join('');
  }
  function wireSpeciesPrefPicker(el, onPick) {
    el.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-species-pref]');
      if (!chip) return;
      el.dataset.selected = chip.dataset.speciesPref;
      el.querySelectorAll('[data-species-pref]').forEach((c) => c.classList.toggle('active', c === chip));
      if (onPick) onPick(chip.dataset.speciesPref);
    });
  }
  function wireSpeciesSwitch(onChange, forUpdates) {
    document.querySelectorAll('[data-species-view]').forEach((b) => {
      b.addEventListener('click', () => {
        setSpeciesView(b.dataset.speciesView, forUpdates);
        // "Dogs to Walk" / "Cats to Visit" follows the switch.
        if (TAB_TITLES[state.tab]) topbarTitle.textContent = TAB_TITLES[state.tab];
        onChange();
      });
    });
  }
  const speciesTagHtml = (dog) => (worksWithBoth()
    ? `<span class="species-tag" title="${esc(speciesOf(dog).label)}">${speciesOf(dog).emoji}</span>`
    : '');
  const activityInfo = (key) => ACTIVITIES[key] || ACTIVITIES.walk;
  // [singular, plural] for counting an activity: "1 walk", "26 playgroup sessions".
  const activityCountNouns = (info) => { const c = info.countNoun || info.noun; return [c, `${c}s`]; };
  const activityCount = (info, n) => `${n} ${activityCountNouns(info)[n === 1 ? 0 : 1]}`;
  function activityOptionsHtml(selected, keys = Object.keys(ACTIVITIES)) {
    return keys.filter((key) => ACTIVITIES[key]).map((key) =>
      `<option value="${key}" ${key === (selected || 'walk') ? 'selected' : ''}>${ACTIVITIES[key].emoji} ${ACTIVITIES[key].label}</option>`).join('');
  }

  // Shown wherever a dog card appears so it's obvious the dog isn't actually
  // available right now, even though its walk hasn't been recorded yet.
  function currentWalkBadge(dog) {
    if (!dog.currentWalk) return '';
    const a = activityInfo(dog.currentWalk.activity);
    // Your own: never "being walked by a volunteer" (a hidden name) or your own name.
    if (dog.currentWalk.mine) return `<span class="badge out-now">${a.emoji} You're out with them</span>`;
    return `<span class="badge out-now">${a.emoji} ${a.out} ${esc(dog.currentWalk.userName)}</span>`;
  }

  function sexIcon(sex) {
    if (!sex) return '';
    const s = sex.toLowerCase();
    if (s.startsWith('m')) return '<span style="color:#2f6fdb;">♂</span>';
    if (s.startsWith('f')) return '<span style="color:#d0568c;">♀</span>';
    return '';
  }

  // Wherever a dog is shown as a card — Available, Stats "By Dog", Stats
  // day-detail, adoption alerts — the same pair of actions should be one
  // tap away: view their profile, or jump to walk/edit them.
  // The dog whose walk is actually running right now (server-confirmed, not
  // just mid-confirm-screen) -- null whenever there's no walk in progress.
  function activeWalkDogId() {
    // 'ending' counts too: the walk has ended on the server (End ends it at
    // once), but its notes screen is still this walker's open step until
    // Save & finish, and the app keeps them on it. Only 'active'/'ending'
    // count; every other phase means nothing's running.
    const openPhases = state.walk.phase === 'active' || state.walk.phase === 'ending';
    return openPhases && state.walk.dog && state.walk.walkId ? String(state.walk.dog.id) : null;
  }

  // cannotWalk: this dog isn't cleared for the signed-in volunteer's current
  // level (or is a hard block like being too young), so the combined "Walk /
  // Edit" label would be misleading -- only the edit part actually applies
  // here. Only known for dogs whose full eligibility was already computed
  // (the Available list); other callers omit it and keep the combined label.
  // While you're out with one dog, every other dog's button is edit-only
  // (markers, POO, kennel spot) -- see goToConfirmForDog().
  function dogActionButtons(dogId, cannotWalk, species) {
    const activeId = activeWalkDogId();
    const editOnly = cannotWalk || (activeId && activeId !== String(dogId));
    const t = termsOf({ species });
    return `
      <div class="row" style="margin-top:6px;">
        <button class="btn small-btn view-profile-btn" data-id="${dogId}">View info</button>
        <button class="btn small-btn walk-history-btn" data-dog-id="${dogId}" title="${capFirst(t.noun)} history" aria-label="${capFirst(t.noun)} history" style="flex:0 0 auto;width:auto;">🕘</button>
        <button class="btn small-btn primary walk-edit-btn" data-id="${dogId}">${editOnly ? '✎ Edit' : '▶ Start / Edit'}</button>
      </div>`;
  }

  function wireDogActionButtons(scope) {
    // Photo and name/info taps are handled app-wide (see "Tapping an
    // animal's card" near the top): photo full screen, info = profile.
    (scope || document).querySelectorAll('.view-profile-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const { dog, walks } = await api(`/api/dogs/${btn.dataset.id}?userId=${state.currentUser.id}`);
          showProfileSheet(dog, walks);
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    (scope || document).querySelectorAll('.walk-edit-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        goToConfirmForDog(btn.dataset.id);
      });
    });
  }

  // List-size copy of a cached dog photo (server.js makes it on first use);
  // anything else (silhouettes, the shelter's own URL) is used as is.
  // Someone else's engagement length, which the server rounds to 5 minutes:
  // "about 25 min", or "under 5 min" when it rounds to nothing.
  function roundedLength(seconds) {
    return seconds >= SHARED_CONFIG.roundSeconds ? `about ${fmtDuration(seconds)}` : `under ${SHARED_CONFIG.roundSeconds / 60} min`;
  }
  function thumbOf(url) {
    return typeof url === 'string' ? url.replace(/^\/cached-images\/(\d+\.jpg)/, '/cached-images/thumbs/$1') : url;
  }
  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }


  // ---------- Error reporting ----------
  // Uncaught frontend errors are sent to the server log (best effort, never
  // shown to the user) so problems on volunteers' phones get noticed.
  function reportClientError(message, source, stack) {
    try {
      const body = JSON.stringify({ message, source, stack });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
      else fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch (e) { /* reporting must never throw */ }
  }
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // resource load errors (images) are handled elsewhere
    reportClientError(e.message, `${e.filename}:${e.lineno}:${e.colno}`, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // The camera library's own video.play(), cut short because the scanner
    // was closed while it was starting (e.g. tapping the name search right
    // away). Harmless, and nothing of ours to fix: not worth a report.
    if (r && r.name === 'AbortError' && /play\(\) request was interrupted/.test(r.message || '')) { e.preventDefault(); return; }
    reportClientError(r && r.message ? r.message : String(r), 'unhandledrejection', r && r.stack);
  });

  // ---------- Toasts ----------
  // Brief, non-blocking confirmation/error messages (instead of native
  // appAlert() boxes, which look like a different app and block the page).
  let toastTimer = null;
  function toast(message, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    // Above the walk's End / Start dock when one is on screen, never on top
    // of it ("Added 10 minutes" used to cover End).
    const dock = document.querySelector('#app .action-dock');
    const dockTop = dock && dock.offsetParent ? dock.getBoundingClientRect().top : null;
    el.style.bottom = dockTop != null && dockTop < window.innerHeight ? `${Math.max(76, window.innerHeight - dockTop + 8)}px` : '';
    el.className = `toast show${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2600);
  }

  // ---------- Overlays and the Back button ----------
  // Popups/dialogs push a history entry when they open, so the phone's Back
  // gesture closes the popup instead of leaving the screen underneath it.
  // popWaiters lets code wait for the history entry it just consumed to
  // actually be popped before doing anything that pushes new history.
  let popWaiters = [];
  const overlayEntries = new Set();
  function consumeHistoryEntry() {
    return new Promise((resolve) => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 500);
      popWaiters.push(done);
      history.back();
    });
  }
  function openOverlay(el) {
    if (!el.classList.contains('hidden')) return; // already open (e.g. content swapped in place)
    el.classList.remove('hidden');
    overlayEntries.add(el.id);
    pushHistory({ overlay: el.id });
  }
  function closeOverlay(el) {
    if (el.classList.contains('hidden')) return;
    if (window.PgTags.unsavedNotes(el).length) {
      okToLeaveNotes(el).then((ok) => { if (ok) closeOverlay(el); });
      return;
    }
    el.classList.add('hidden');
    if (overlayEntries.delete(el.id)) history.back();
  }
  // Like closeOverlay, but waits for its "back" to actually land before
  // returning -- needed whenever another overlay is about to open right
  // after this one closes; doing both back to back races, and the pending
  // "back" lands on the NEW overlay's history entry instead of this one's.
  async function closeOverlayAwait(el) {
    if (el.classList.contains('hidden')) return true;
    if (!(await okToLeaveNotes(el))) return false;
    el.classList.add('hidden');
    if (overlayEntries.delete(el.id)) await consumeHistoryEntry();
    return true;
  }

  // ---------- App dialogs (replace native alert/confirm/prompt) ----------
  let dialogCancel = null; // set while a dialog is open; dismisses it as "cancel"
  function ensureDialogEl() {
    let el = document.getElementById('appDialog');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'appDialog';
    el.className = 'popup-overlay dialog-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="popup-card">
        <h3 id="appDialogTitle" style="margin-top:0;"></h3>
        <p id="appDialogMessage" class="dialog-message"></p>
        <input type="text" id="appDialogInput" class="hidden" maxlength="120" />
        <div class="row dialog-actions">
          <button type="button" id="appDialogCancel" class="btn">Cancel</button>
          <button type="button" id="appDialogAlt" class="btn hidden"></button>
          <button type="button" id="appDialogOk" class="btn primary">OK</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }
  // Resolves true/false for confirm-style dialogs and the typed string (or
  // null) for prompt-style ones. An alert-style dialog (showCancel:false)
  // resolves true whichever way it's dismissed. `altText` adds a third
  // button between the two, which resolves 'alt'.
  function appDialog({ title = '', message = '', confirmText = 'OK', cancelText = 'Cancel', showCancel = true, danger = false, input = null, altText = null }) {
    if (dialogCancel) dialogCancel(); // never stack two
    const el = ensureDialogEl();
    const okBtn = el.querySelector('#appDialogOk');
    const cancelBtn = el.querySelector('#appDialogCancel');
    const altBtn = el.querySelector('#appDialogAlt');
    const inputEl = el.querySelector('#appDialogInput');
    el.querySelector('#appDialogTitle').textContent = title;
    el.querySelector('#appDialogTitle').classList.toggle('hidden', !title);
    el.querySelector('#appDialogMessage').textContent = message;
    okBtn.textContent = confirmText;
    okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    cancelBtn.textContent = cancelText;
    cancelBtn.classList.toggle('hidden', !showCancel);
    altBtn.textContent = altText || '';
    altBtn.classList.toggle('hidden', !altText);
    inputEl.classList.toggle('hidden', input == null);
    if (input != null) inputEl.value = input;
    const cancelValue = input != null ? null : !showCancel;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value, alreadyPopped) => {
        if (done) return;
        done = true;
        el.classList.add('hidden');
        dialogCancel = null;
        okBtn.onclick = cancelBtn.onclick = altBtn.onclick = el.onclick = inputEl.onkeydown = null;
        if (alreadyPopped) resolve(value);
        else consumeHistoryEntry().then(() => resolve(value));
      };
      dialogCancel = () => finish(cancelValue, true);
      okBtn.onclick = () => finish(input != null ? inputEl.value : true, false);
      cancelBtn.onclick = () => finish(cancelValue, false);
      altBtn.onclick = () => finish('alt', false);
      el.onclick = (e) => { if (e.target === el && showCancel) finish(cancelValue, false); };
      inputEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(inputEl.value, false); } };
      el.classList.remove('hidden');
      pushHistory({ overlay: 'appDialog' });
      setTimeout(() => (input != null ? inputEl : okBtn).focus(), 30);
    });
  }
  const appAlert = (message, title) => appDialog({ title: title || '', message, showCancel: false });
  const appConfirm = (message, opts = {}) => appDialog({ message, ...opts });
  const appPrompt = (message, defaultValue, opts = {}) => appDialog({ message, input: defaultValue || '', confirmText: 'Save', ...opts });

  // Leaving a screen (`within`: what's about to close; the whole page when
  // left out) with a note typed but not saved asks first: Save, Discard or
  // Keep editing. Resolves true when it's fine to go on. A box with no save
  // of its own (part of a bigger form) only offers Discard.
  async function okToLeaveNotes(within) {
    const open = window.PgTags.unsavedNotes(within);
    if (!open.length) return true;
    const canSave = open.every((g) => g.save);
    const answer = await appDialog({
      title: open.length > 1 ? 'Unsaved notes' : 'Unsaved note',
      message: open.length > 1 ? "You haven't saved what you wrote in these notes." : "You haven't saved what you wrote in this note.",
      confirmText: canSave ? 'Save' : 'Discard',
      danger: !canSave,
      altText: canSave ? 'Discard' : null,
      cancelText: 'Keep editing'
    });
    if (!answer) { open[0].focus(); return false; }
    if (answer === 'alt' || !canSave) { open.forEach((g) => g.forget()); return true; }
    for (const g of open) await g.save();
    // A save that failed has said why (toast) and left its text in place.
    const left = window.PgTags.unsavedNotes(within);
    if (left.length) { left[0].focus(); return false; }
    return true;
  }

  // Escape closes the topmost layer.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dialogCancel) return dialogCancel();
    const lightbox = document.getElementById('imageLightbox');
    if (!lightbox.classList.contains('hidden')) return closeOverlay(lightbox);
    const popup = document.querySelector('.popup-overlay:not(.hidden)');
    if (popup) return closeOverlay(popup);
    if (!settingsSheet.classList.contains('hidden')) return closeSheet(settingsSheet);
    if (!profileSheet.classList.contains('hidden')) return closeSheet(profileSheet);
    const accountSheetEl = document.getElementById('accountSheet');
    if (!accountSheetEl.classList.contains('hidden')) return closeSheet(accountSheetEl);
  });

  // Tappable cards and tiles that aren't <button>s (role="button",
  // tabindex="0"): Enter or Space works them like a click, for keyboard
  // and screen-reader users. One that handles its own keys (and calls
  // preventDefault) is left alone. Space waits for keyup, like a button.
  const keyTarget = (e) => {
    const el = e.target;
    if (!el || !el.matches || !el.matches('[role="button"]') || /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) return null;
    return el.isContentEditable ? null : el;
  };
  let spaceDownOn = null;
  document.addEventListener('keydown', (e) => {
    const el = keyTarget(e);
    spaceDownOn = null;
    if (!el || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter') { e.preventDefault(); el.click(); }
    else if (e.key === ' ') { e.preventDefault(); spaceDownOn = el; } // no page scroll
  });
  document.addEventListener('keyup', (e) => {
    const el = keyTarget(e);
    if (!el || e.key !== ' ' || spaceDownOn !== el) return;
    spaceDownOn = null;
    el.click();
  });

  // A failed load gets a message and a retry button, not a dead end.
  function showLoadError(what, err, retry) {
    appEl.innerHTML = `
      <div class="card error-card" role="alert">
        <p class="error-card-title">Couldn't load ${esc(what)}.</p>
        <p class="small muted">${esc(navigator.onLine ? friendlyError(err, 'load it') : "You're offline, and this screen isn't saved on this phone. It loads once you're back online.")}</p>
        <button type="button" id="retryLoadBtn" class="btn primary">Try again</button>
      </div>`;
    document.getElementById('retryLoadBtn').addEventListener('click', retry);
  }

  // Dog summaries come straight from the shelter's website as HTML. Only a
  // small allowlist of harmless formatting tags survives; every attribute,
  // script, style, iframe, event handler etc. is stripped, so nothing the
  // shelter's site (or anyone who can edit it) publishes can run in this app.
  const SAFE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI']);
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    (function clean(node) {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 3) return; // text
        if (child.nodeType !== 1) { child.remove(); return; }
        clean(child);
        if (SAFE_TAGS.has(child.tagName)) {
          Array.from(child.attributes).forEach((a) => child.removeAttribute(a.name));
        } else if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE'].includes(child.tagName)) {
          child.remove();
        } else {
          child.replaceWith(...Array.from(child.childNodes)); // drop the tag, keep its text
        }
      });
    }(tpl.content));
    return tpl.innerHTML;
  }

  // ---------- Identity ----------
  // Who's using the app is decided by who's signed in at shelterwalk.com,
  // not a name picker — see the /api/me handler in server.js. Dog data
  // (markers, POO, location, walk history/notes shown to any walker) is
  // shared; only stats/threshold/notifications are scoped per user.
  function setCurrentUser(user) {
    state.currentUser = user;
    const nameEl = document.getElementById('userBtnName');
    // Before onboarding the name is only the sign-in placeholder (made from
    // the email); it shows once the volunteer has typed their own.
    if (nameEl) nameEl.textContent = user.onboardingCompleted ? user.name : '';
    // The playgroup desk is a computer page: phones only offer it to staff.
    const deskRow = document.getElementById('playgroupDeskRow');
    if (deskRow) deskRow.classList.toggle('hidden', onSmallDevice() && !user.isStaff);
    // Audit Mode is a per-user permission, not tied to being privileged —
    // most walkers never see this button, keeping their app simple.
    const auditBtn = document.getElementById('auditModeBtn');
    if (auditBtn) auditBtn.classList.toggle('hidden', !user.canAudit);
    // The page loads titled for dogs; the volunteer's own species (and the
    // Dogs / Cats switch) is known only now.
    if (state.tab === 'available') topbarTitle.textContent = TAB_TITLES.available;
    applyTermsToPage();
  }

  // "My Account" is a sheet with its own little pages (Profile, Privacy &
  // Data) rather than one long popup -- showAccountPage() just toggles
  // which page div is visible; nothing is destroyed/rebuilt, so every
  // element inside keeps the one-time listeners wired to it below.
  function showAccountPage(page) {
    document.getElementById('accountPageMenu').classList.toggle('hidden', page !== 'menu');
    document.getElementById('accountPageProfile').classList.toggle('hidden', page !== 'profile');
    document.getElementById('accountPagePrivacy').classList.toggle('hidden', page !== 'privacy');
    document.getElementById('accountPageFeedback').classList.toggle('hidden', page !== 'feedback');
    document.getElementById('accountPageFeedbackInbox').classList.toggle('hidden', page !== 'feedbackInbox');
    if (page === 'feedbackInbox') loadFeedbackInbox();
    const inner = document.querySelector('#accountSheet .sheet-inner');
    if (inner) inner.scrollTop = 0;
  }
  document.querySelectorAll('.account-menu-row[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => showAccountPage(btn.dataset.page));
  });
  document.querySelectorAll('.account-back-btn').forEach((btn) => {
    btn.addEventListener('click', () => showAccountPage(btn.dataset.backTo));
  });

  function openAccountSheet() {
    showAccountPage('menu');
    document.getElementById('accountNameInput').value = state.currentUser.name || '';
    document.getElementById('accountNameStatus').textContent = '';
    document.getElementById('accountHideNameCheck').checked = !!state.currentUser.hideNameWhileWalking;
    document.getElementById('adminPanelLink').classList.toggle('hidden', !state.currentUser.isStaff);
    document.getElementById('staffDashLink').classList.toggle('hidden', !state.currentUser.isStaff);
    document.getElementById('feedbackInboxRow').classList.toggle('hidden', !canReadFeedback());
    // Staff accounts are removed from the staff panel (so the coordinators can
    // never lock themselves out by accident) -- that's specific to deleting
    // the sign-in itself, so it's only this one button, not the data-only one.
    document.getElementById('deleteAccountBtn').classList.toggle('hidden', !!state.currentUser.isStaff);
    openSheet(document.getElementById('accountSheet'), 'account');
  }
  document.getElementById('userBtn').addEventListener('click', openAccountSheet);

  // ---------- Feedback & bug reports ----------
  // Sent anonymously (the server never stores who sent one). Staff and
  // privileged accounts read them in My Account → Feedback inbox.
  const FEEDBACK_KINDS = { bug: '🐞 Bug', idea: '💡 Idea', other: '💬 Other' };
  const canReadFeedback = () => !!(state.currentUser && (state.currentUser.isStaff || state.currentUser.isPrivileged));
  let feedbackKind = 'bug';
  document.querySelectorAll('#feedbackKindPicker [data-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      feedbackKind = btn.dataset.kind;
      document.querySelectorAll('#feedbackKindPicker [data-kind]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  document.getElementById('sendFeedbackBtn').addEventListener('click', async () => {
    const btn = document.getElementById('sendFeedbackBtn');
    const status = document.getElementById('feedbackStatus');
    const bodyEl = document.getElementById('feedbackBody');
    if (!bodyEl.value.trim()) { status.textContent = 'Write something first.'; return; }
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({
        kind: feedbackKind, body: bodyEl.value, includeDevice: document.getElementById('feedbackDeviceCheck').checked
      }) });
      bodyEl.value = '';
      status.textContent = 'Sent. Thank you!';
    } catch (err) {
      status.textContent = err.message || 'Couldn\'t send. Try again in a moment.';
    } finally {
      btn.disabled = false;
    }
  });

  async function loadFeedbackInbox() {
    const list = document.getElementById('feedbackInboxList');
    list.innerHTML = '<p class="small muted">Loading…</p>';
    let items;
    try {
      ({ items } = await api('/api/feedback'));
    } catch (err) {
      list.innerHTML = `<p class="small muted">Couldn't load feedback: ${esc(err.message)}</p>`;
      return;
    }
    if (!items.length) { list.innerHTML = '<p class="small muted">No feedback yet.</p>'; return; }
    list.innerHTML = items.map((f) => `
      <div class="card compact feedback-item${f.resolvedAt ? ' resolved' : ''}" data-id="${f.id}">
        <p class="small" style="margin:0 0 4px;"><strong>${FEEDBACK_KINDS[f.kind] || esc(f.kind)}</strong> <span class="muted">· ${fmtDate(f.createdAt)} · ${fmtClock(f.createdAt)}${f.resolvedAt ? ' · resolved' : ''}</span></p>
        <p class="feedback-body">${esc(f.body)}</p>
        ${f.device ? `<p class="small muted" style="margin:4px 0 0;word-break:break-word;">${esc(f.device)}</p>` : ''}
        <div class="row" style="margin-top:8px;gap:8px;">
          <button type="button" class="btn small-btn" data-action="resolve">${f.resolvedAt ? 'Reopen' : 'Mark resolved'}</button>
          <button type="button" class="btn small-btn" data-action="delete">Delete</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.feedback-item').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-action="resolve"]').addEventListener('click', async () => {
        try {
          await api(`/api/feedback/${id}`, { method: 'PUT', body: JSON.stringify({ resolved: !card.classList.contains('resolved') }) });
          loadFeedbackInbox();
        } catch (err) { appAlert(friendlyError(err)); }
      });
      card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!(await appConfirm('Delete this report for good?', { title: 'Delete report', confirmText: 'Delete', danger: true }))) return;
        try {
          await api(`/api/feedback/${id}`, { method: 'DELETE' });
          loadFeedbackInbox();
        } catch (err) { appAlert(friendlyError(err)); }
      });
    });
  }
  // From a "new feedback" notification.
  function openFeedbackInbox() {
    if (!canReadFeedback()) return;
    openAccountSheet();
    showAccountPage('feedbackInbox');
  }
  document.getElementById('closeAccountSheetBtn').addEventListener('click', () => {
    closeSheet(document.getElementById('accountSheet'));
  });

  // ---------- Danger-zone confirmation (checkboxes + typed DELETE) ----------
  // Shared by "delete my walk data" and "delete my account" -- every
  // checkbox has to be ticked AND the word typed before Confirm enables, so
  // the person has actively acknowledged each specific consequence rather
  // than clicking through a stack of yes/no dialogs.
  let dangerConfirmAction = null;
  let dangerConfirmCancel = null;
  function showDangerConfirm({ title, intro, checks, confirmLabel, action, onCancel = null }) {
    dangerConfirmCancel = onCancel;
    const popup = document.getElementById('dangerConfirmPopup');
    document.getElementById('dangerConfirmTitle').textContent = title;
    document.getElementById('dangerConfirmIntro').innerHTML = intro.map((p) => `<p class="small">${p}</p>`).join('');
    const checksEl = document.getElementById('dangerConfirmChecks');
    checksEl.innerHTML = checks.map((c, i) => `
      <label class="small" style="display:flex;align-items:flex-start;gap:8px;margin-top:8px;">
        <input type="checkbox" class="danger-check" data-i="${i}" style="margin-top:3px;flex:0 0 auto;" />
        <span>${c}</span>
      </label>`).join('');
    const input = document.getElementById('dangerConfirmInput');
    const btn = document.getElementById('dangerConfirmBtn');
    const status = document.getElementById('dangerConfirmStatus');
    input.value = '';
    status.textContent = '';
    btn.textContent = confirmLabel;
    btn.disabled = true;
    dangerConfirmAction = action;
    const checkEls = Array.from(checksEl.querySelectorAll('.danger-check'));
    const update = () => {
      btn.disabled = !(checkEls.every((c) => c.checked) && input.value.trim() === 'DELETE');
    };
    checkEls.forEach((c) => c.addEventListener('change', update));
    input.oninput = update;
    openOverlay(popup);
  }
  // Cancel goes back to where it was opened from (Privacy & data), not out
  // of My account altogether (audit 3).
  document.getElementById('dangerConfirmCancelBtn').addEventListener('click', async () => {
    const back = dangerConfirmCancel;
    dangerConfirmCancel = null;
    await closeOverlayAwait(document.getElementById('dangerConfirmPopup'));
    if (back) back();
  });
  const reopenPrivacyPage = () => { openAccountSheet(); showAccountPage('privacy'); };
  document.getElementById('dangerConfirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('dangerConfirmBtn');
    const status = document.getElementById('dangerConfirmStatus');
    if (btn.disabled || !dangerConfirmAction) return;
    btn.disabled = true;
    status.textContent = '';
    try {
      await dangerConfirmAction();
      closeOverlay(document.getElementById('dangerConfirmPopup'));
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
    }
  });

  // Privacy & Data's "Read our Privacy Policy": a static, plain-language
  // document, not something staff or anyone else can edit (unlike the
  // Guide) -- it describes rules this app enforces in code, not a promise
  // that depends on someone remembering to follow it.
  function privacyPolicyHtml() {
    return `
      <div class="policy-doc">
        <h3 style="margin-top:0;">Shelter Walk Privacy Policy</h3>
        <p class="small muted">Last updated October 10, 2026</p>

        <h4>In plain language</h4>
        <ul>
          <li>There is no built-in way for anyone - another volunteer, staff, or an admin screen - to look up another member's data. This isn't a setting. It doesn't exist in the app.</li>
          <li>Your sign-in account and your walking-app profile are connected, so the app knows which profile is yours when you sign in and so staff can manage your account in one place. Staff can see your name, your role, and which extra features you have. They cannot see your email (nobody can - see below), and they have no screen that shows your walks. See "How your account and your data are connected" below for the specifics.</li>
          <li>That data will never intentionally be looked at, shared, or used to evaluate, compare, or blame a volunteer. It exists only so the app can show you your own stats and history.</li>
          <li>You can permanently delete your walking-app data yourself, at any time, without asking anyone's permission - see the buttons on this page.</li>
        </ul>

        <h4>What we collect</h4>
        <p>Your name and email address are the only personal information Shelter Walk collects. Your email signs you in; your name is shown to other volunteers only while you're out with an animal, unless you turn that off above. Messages you send in walker chat (when the shelter has it on) always show your name. We don't collect payment information, addresses, phone numbers, or anything else about you.</p>

        <h4>Feedback and bug reports</h4>
        <p>Reports sent from My Account are saved without your name or account, so nobody can tell who sent one. If you tick "Include my phone and browser type", your browser's standard identification line is saved with the report (it names the kind of phone and browser, like iPhone and Safari, nothing about you) to help fix bugs. Only staff can read reports, and they can delete them.</p>

        <h4>How your email is actually stored</h4>
        <p>Neither this app nor the separate sign-in system ever stores a readable copy of your email, anywhere, at any point. Each keeps a one-way cryptographic fingerprint of it instead (the same idea as how a password is checked without the site ever keeping the password itself) - just enough to recognize you when you come back. Even a full copy of either database is useless for building a list of anyone's email address from it.</p>

        <h4>How your account and your data are connected</h4>
        <p>Signing in and using the app are handled by two separate systems, and they are linked on purpose:</p>
        <ul>
          <li>When you sign in, the sign-in system passes this app a stable placeholder that stands for your account - not your email. This app fingerprints that placeholder with a secret only it holds, and uses the fingerprint to find your profile.</li>
          <li>Because of that link, staff can manage everything about you from one line on the accounts page: your role, extra features like Alumni Access or Audit Mode, and whether the account is active. The accounts page shows the name you entered when you joined; it does not show your email, your walks, or your notes.</li>
          <li>The honest limit: someone who controlled both systems and this app's secret could work out which profile belongs to which account. What the design prevents is anyone getting your email out of either database, and anything in the app showing who walked which dog once a walk is over.</li>
        </ul>

        <h4>How your data is used</h4>
        <ul>
          <li>To show you your own stats and history with the animals.</li>
          <li>To show other volunteers which dog is currently out, and with whom, unless you've turned that off.</li>
          <li>To combine everyone's engagements with the animals into shelter-wide totals, without ever exposing who contributed what.</li>
          <li>To send you a sign-in code by email.</li>
        </ul>
        <p>Nothing here is used to evaluate volunteers, and nothing is sold, shared for advertising, or shown to any third party - there is no advertising in this app.</p>

        <h4>Where your data lives</h4>
        <p>Shelter Walk runs on a server hosted by <strong>DigitalOcean</strong>. Sign-in emails are sent through <strong>Resend</strong>, our email delivery provider - it only ever sees the email address needed to send you a code, never your history, notes, or stats. Your name and email are never shared with any other third party, for any reason.</p>

        <h4>Backups</h4>
        <p>The site takes automatic backups every day, kept for 14 days and then permanently deleted. They exist for one reason: recovering the <em>entire</em> site if something goes badly wrong. They are not a tool for looking up or restoring one person's data - restoring one means restoring everyone's data to that point in time, all at once, not pulling one person's data back out on its own.</p>
        <p>Backups are encrypted, sent using encrypted connections, and stored on encrypted systems - one copy on Google's servers and one on the site owner's own private servers, for redundancy. Once a backup passes 14 days old, it's gone completely, everywhere.</p>

        <h4>Your choices</h4>
        <ul>
          <li><strong>Hide your name while you're out with an animal.</strong> Other volunteers see "a volunteer" instead of your name on the live "currently out" badge. This never affects anything after an engagement ends - that's hidden from everyone, always, regardless of this setting.</li>
          <li><strong>Download your data.</strong> Get a copy of everything Shelter Walk has stored about you, any time.</li>
          <li><strong>Delete your engagement data.</strong> Permanently disconnect every walk, cuddle or other engagement you've done from your account while keeping your account and sign-in.</li>
          <li><strong>Delete your account entirely.</strong> Permanently remove your account, sign-in, and all personal data.</li>
        </ul>
        <p class="small muted">Questions about this policy can be directed to whoever coordinates volunteers for your shelter.</p>
      </div>
    `;
  }
  document.getElementById('openPrivacyPolicyBtn').addEventListener('click', () => {
    document.getElementById('privacyPolicyContent').innerHTML = privacyPolicyHtml();
    openOverlay(document.getElementById('privacyPolicyPopup'));
  });
  document.getElementById('closePrivacyPolicyBtn').addEventListener('click', () => {
    closeOverlay(document.getElementById('privacyPolicyPopup'));
  });
  document.getElementById('privacyPolicyPopup').addEventListener('click', (e) => {
    if (e.target.id === 'privacyPolicyPopup') closeOverlay(e.target);
  });

  // Privacy & Data's "Download my data": a plain JSON file with everything
  // this account has stored, saved straight to the device -- nothing here
  // hits a server other than the one request to fetch it.
  document.getElementById('downloadMyDataBtn').addEventListener('click', async () => {
    const btn = document.getElementById('downloadMyDataBtn');
    const status = document.getElementById('downloadMyDataStatus');
    btn.disabled = true;
    status.textContent = 'Preparing your data…';
    try {
      const data = await api('/api/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shelter-walk-my-data-${todayKey()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      status.textContent = 'Downloaded ✓';
    } catch (err) {
      status.textContent = `Couldn't download: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // Permanent account deletion. Walks stay in the shelter's records but are
  // disconnected from you.
  document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
    await closeSheetAwait(document.getElementById('accountSheet'));
    showDangerConfirm({
      title: 'Delete your account',
      intro: [
        "This permanently deletes your account: your name, email, passkeys, experience level, settings, saved filters, favorites, and private notes.",
        `The ${myTerms().nouns} you did stay in the shelter's records and totals, but they will no longer be connected to you in any way, not even for the site owner. Tips you shared stay on the animals' boards, without your name.`,
        'The site keeps day-to-day backups for 14 days, but only to roll the whole site back after a major problem - restoring one means restoring everyone\'s data to that point in time, not pulling your data back out on its own. Those backups age out completely after 14 days either way.'
      ],
      checks: [
        'I understand this cannot be undone.',
        'I understand my sign-in, name, email, and all personal settings will be permanently deleted.',
        `I understand any past ${myTerms().nouns} I did will be permanently disconnected from my account, and no one - including the site owner - has a way to look that connection up again afterward.`,
        'I understand I will be signed out right away, and will need a brand-new invite to use Shelter Walk again.'
      ],
      confirmLabel: 'Delete my account forever',
      onCancel: reopenPrivacyPage,
      action: async () => {
        await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }), timeout: 45000 });
        showAccountDeletedScreen();
      }
    });
  });

  // "Delete my data, keep my account" (Privacy & Data): everything about the
  // account itself is untouched; only the link to past walks is removed.
  document.getElementById('deleteMyDataBtn').addEventListener('click', async () => {
    await closeSheetAwait(document.getElementById('accountSheet'));
    showDangerConfirm({
      title: `Delete your ${myTerms().noun} data`,
      intro: [
        "This disconnects every " + myTerms().noun + " you've done from your account. Your personal stats and per-" + nounFor(prefSpeciesKeys()) + " history reset to zero, and any private notes you wrote are deleted. Shared tips you wrote stay on the animals' boards, without your name (they never showed it anyway).",
        `Your account, sign-in, name, email, and settings are not affected - you can keep volunteering normally afterward, starting from a blank history.`,
        'The site keeps day-to-day backups for 14 days, but only to roll the whole site back after a major problem - restoring one means restoring everyone\'s data to that point in time, not pulling your data back out on its own. Those backups age out completely after 14 days either way.'
      ],
      checks: [
        'I understand this cannot be undone.',
        `I understand that data connecting my account to ${aNoun(myTerms())} will be permanently deleted, and no one - including the site owner - has a way to look that connection up again afterward.`,
        `I understand my personal stats and ${nounFor(prefSpeciesKeys())} history will reset to zero, even though the ${myTerms().nouns} themselves stay in the shelter's overall totals.`
      ],
      confirmLabel: `Delete my ${myTerms().noun} data`,
      onCancel: reopenPrivacyPage,
      action: async () => {
        await api('/api/me/data', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }), timeout: 45000 });
        toast(`Your ${myTerms().noun} data has been deleted.`);
      }
    });
  });

  // Nothing about the person may linger on this device either.
  function showAccountDeletedScreen() {
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
    if ('caches' in window) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    const screen = document.createElement('div');
    screen.className = 'user-picker';
    screen.style.zIndex = '500';
    screen.innerHTML = `
      <div class="user-picker-inner center">
        <h2>Your account has been deleted 🐾</h2>
        <p>Thank you for everything you did for the animals. Your ${myTerms().nouns} stay in the shelter's records, but they are no longer connected to you.</p>
        <p class="muted small">You're welcome back any time with a new invite.</p>
        <a class="btn primary" href="https://login.shelterwalk.com/accounts/login/" style="text-decoration:none;">Done</a>
      </div>`;
    document.body.appendChild(screen);
    setTimeout(() => { window.location.href = 'https://login.shelterwalk.com/accounts/login/'; }, 15000);
  }

  document.getElementById('saveAccountNameBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('accountNameStatus');
    const name = document.getElementById('accountNameInput').value.trim();
    if (!name) { statusEl.textContent = 'Enter a name first.'; return; }
    try {
      const updated = await api('/api/me', { method: 'PUT', body: JSON.stringify({ name }) });
      setCurrentUser({ ...state.currentUser, name: updated.name });
      statusEl.textContent = 'Saved ✓';
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    }
  });

  // Privacy & Data: whether your name shows on the live "currently being
  // walked by" badge. Saves immediately on toggle, same as any other
  // checkbox-style preference in this app (no separate Save button to miss).
  document.getElementById('accountHideNameCheck').addEventListener('change', async (e) => {
    const checked = e.target.checked;
    try {
      await api('/api/me/privacy', { method: 'PUT', body: JSON.stringify({ hideNameWhileWalking: checked }) });
      state.currentUser.hideNameWhileWalking = checked;
    } catch (err) {
      e.target.checked = !checked; // revert on failure
      toast(err.message, 'error');
    }
  });

  // ---------- Browser back-button integration ----------
  // Every meaningful UI change (tab switch, sheet open) pushes a history
  // entry so the hardware/gesture back button navigates within the app
  // (closing overlays, stepping back a tab) instead of leaving the page.
  // The first two follow who the volunteer works with (Settings).
  const TAB_TITLES = {
    get available() {
      const keys = state.currentUser ? viewSpeciesKeys() : ['dog'];
      return `${speciesInfo(keys[0]).plural} to ${termsFor(keys).verbWith}`;
    },
    get walk() {
      const keys = state.currentUser ? prefSpeciesKeys() : ['dog'];
      return keys.length > 1 ? 'Scan a kennel card' : `Scan a ${speciesInfo(keys[0]).noun}`;
    },
    stats: 'Stats&Notes', updates: 'Updates', audit: 'Audit mode', guide: 'Guide'
  };
  let syncingFromHistory = false;
  // The scan screens (scanning, and the dog just scanned) drop the green bar
  // for more room (owner, 2026-11-06). Every screen change sets the title,
  // so watching it catches them all.
  const topbarEl = document.querySelector('.topbar');
  const syncTopbar = () => topbarEl.classList.toggle('hidden', state.tab === 'walk' && topbarTitle.textContent === TAB_TITLES.walk);
  new MutationObserver(syncTopbar).observe(topbarTitle, { childList: true, characterData: true, subtree: true });

  // settingsSheet/profileSheet are declared further down with `const`, but since
  // these functions are only ever called later (from event handlers), the
  // declarations have already run by call time — safe to reference here.
  function currentSheetName() {
    if (!settingsSheet.classList.contains('hidden')) return 'settings';
    if (!profileSheet.classList.contains('hidden')) return 'profile';
    if (!document.getElementById('accountSheet').classList.contains('hidden')) return 'account';
    return null;
  }

  // Each entry records how many steps it sits above the app's first entry
  // (depth 0, the Available tab). Tabs don't stack: switching between them
  // replaces the current step, so Back from any tab goes to Available, like a
  // phone app's bottom tab bar. Back from Available never leaves the app:
  // under depth 0 sits a guard entry, and landing on it puts the Available
  // entry straight back (see the popstate handler). Popups, sheets and the
  // Guide still push a step on top, so Back closes them first.
  const HOME_TAB = 'available';
  // True while the history step pushed for a scanned dog (see onQrScanned)
  // is still in place, so Back from it reopens the camera.
  let onScannedStep = false;
  // Same for a dog opened from another tab (see activateWalkTab): Back from
  // it returns to that tab.
  let onOpenedDogStep = false;
  function historyDepth() {
    return (history.state && history.state.depth) || 0;
  }

  function pushHistory(overrides) {
    if (syncingFromHistory) return;
    // On Stats, every step remembers the drill-down under it (statsNav), so
    // closing a popup opened there never resets that screen.
    const nav = state.tab === 'stats' ? { statsNav: statsNavState() } : {};
    // Every popup open at this step, not just the top one, so coming back to
    // it (e.g. from a dialog over the playgroup editor over the playgroup
    // notes) leaves the ones underneath open too.
    const overlays = [...document.querySelectorAll('.popup-overlay:not(.hidden)')].map((el) => el.id);
    const entry = { tab: state.tab, sheet: currentSheetName(), ...nav, overlays, ...overrides, depth: historyDepth() + 1 };
    history.pushState(entry, '');
  }

  // History for switching to a tab (state.tab is already set).
  function tabHistory(tab) {
    if (syncingFromHistory) return;
    onScannedStep = false;
    onOpenedDogStep = false;
    const depth = historyDepth();
    if (tab === HOME_TAB) {
      if (depth === 0) history.replaceState({ tab, sheet: null, depth: 0 }, '');
      else history.go(-depth); // straight back to the first entry, whatever is above it
      return;
    }
    if (depth === 0) pushHistory({ sheet: null });
    else history.replaceState({ tab, sheet: null, depth }, '');
  }

  // What a Back (or Forward) to history step `hs` would close: popups and
  // sheets that step doesn't have, and the main screen if the tab or the
  // dog on it changes. Only the parts with an unsaved note in them.
  function unsavedLeftBehind(hs) {
    const keep = (el) => el.id === hs.overlay || (hs.overlays || []).includes(el.id);
    const leaving = [...document.querySelectorAll('.popup-overlay:not(.hidden)')].filter((el) => !keep(el));
    [[settingsSheet, 'settings'], [profileSheet, 'profile'], [document.getElementById('accountSheet'), 'account']].forEach(([el, name]) => {
      if (!el.classList.contains('hidden') && hs.sheet !== name) leaving.push(el);
    });
    const guideStep = state.tab === 'guide' && hs.tab === 'guide' && (hs.guideSection || null) !== (state.guide.sectionId || null);
    if ((hs.tab && hs.tab !== state.tab) || guideStep || (onOpenedDogStep && hs.walkStep !== 'opened') || (onScannedStep && hs.walkStep !== 'scanned')) leaving.push(appEl);
    return leaving.filter((el) => window.PgTags.unsavedNotes(el).length);
  }
  // Set while Back is being undone (see below): the step that undo lands on
  // is the screen already showing, so there's nothing to redo for it.
  let undoingBack = null;

  window.addEventListener('popstate', (event) => {
    if (undoingBack) { const done = undoingBack; undoingBack = null; done(); return; }
    // Back with an unsaved note on what it would close: step forward again
    // (nothing on screen has changed yet), ask, and only then go back for
    // real -- by then the note is saved or dropped, so it goes through.
    if (!(event.state && event.state.guard)) {
      const leaving = unsavedLeftBehind(event.state || { tab: HOME_TAB, sheet: null });
      if (leaving.length) {
        new Promise((resolve) => { undoingBack = resolve; history.forward(); })
          .then(() => okToLeaveNotes(leaving))
          .then((ok) => { if (ok) history.back(); });
        return;
      }
    }
    syncingFromHistory = true;
    dogLookupSeq++;
    let hs = event.state || { tab: HOME_TAB, sheet: null };
    // Back past Available: stay in the app, on the Available tab.
    if (hs.guard) {
      hs = { tab: HOME_TAB, sheet: null, depth: 0 };
      history.pushState(hs, '');
    }
    const overlayId = hs.overlay || null;
    // Back pressed while a dialog was up: that's a cancel.
    if (dialogCancel && overlayId !== 'appDialog') dialogCancel();
    document.querySelectorAll('.popup-overlay, .image-lightbox').forEach((el) => {
      if (el.id === overlayId || (hs.overlays || []).includes(el.id)) return;
      el.classList.add('hidden');
      overlayEntries.delete(el.id);
    });
    if (hs.sheet !== 'settings') closeSheetOnly(settingsSheet);
    if (hs.sheet !== 'profile') closeSheetOnly(profileSheet);
    if (hs.sheet !== 'account') closeSheetOnly(document.getElementById('accountSheet'));
    // Back from a dog opened on another tab: drop it (unless out walking it),
    // so the Scan tab opens on the camera next time, not on this dog.
    let backFromDog = false;
    if (onOpenedDogStep && hs.walkStep !== 'opened') {
      onOpenedDogStep = false;
      backFromDog = true;
      if (!activeWalkDogId()) state.walk.phase = 'idle';
    }
    // Back (or forward) through Stats drill-downs: show the one this step
    // was (none: the top of Stats).
    let statsNavChanged = false;
    if (state.tab === 'stats' && hs.tab && hs.tab !== 'stats') applyStatsNav(null);
    if (hs.tab === 'stats' && !sameStatsNav(hs.statsNav || null)) {
      applyStatsNav(hs.statsNav || null);
      statsNavChanged = true;
    }
    if (hs.tab && hs.tab !== state.tab) {
      if ((state.tab === 'walk' || state.tab === 'audit') && hs.tab !== state.tab) stopQrScanner();
      state.tab = hs.tab;
      tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === hs.tab));
      topbarTitle.textContent = TAB_TITLES[hs.tab];
      if (backFromDog && hs.tab === 'updates') restoreUpdates();
      else render();
    } else if (statsNavChanged && state.tab === 'stats') {
      renderStats();
    } else if (hs.tab === 'guide' && state.tab === 'guide' && (hs.guideSection || null) !== (state.guide.sectionId || null)) {
      // Back (or forward) between a Guide section and the list.
      state.guide.sectionId = hs.guideSection || null;
      state.guide.editing = null;
      appEl.scrollTop = 0;
      renderGuide();
    } else if (onScannedStep && hs.walkStep !== 'scanned' && hs.tab === 'walk' && !activeWalkDogId()) {
      // Back from a scanned dog (not out walking): scan again.
      state.walk.phase = 'scanning';
      renderWalk();
    }
    if (hs.walkStep !== 'scanned') onScannedStep = false;
    syncingFromHistory = false;
    const waiters = popWaiters;
    popWaiters = [];
    waiters.forEach((w) => w());
  });

  // ---------- Sheet (modal) open/close ----------
  // Locks scrolling on the main content behind a sheet so touch-scrolling the
  // overlay never scrolls the page underneath it on mobile.
  let openSheetCount = 0;
  function closeSheetOnly(el) {
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    openSheetCount = Math.max(0, openSheetCount - 1);
    if (openSheetCount === 0) document.body.classList.remove('sheet-open');
  }
  function openSheet(el, name) {
    el.classList.remove('hidden');
    openSheetCount += 1;
    document.body.classList.add('sheet-open');
    pushHistory({ sheet: name });
  }
  function closeSheet(el) {
    // Programmatic close (X / Cancel buttons): step back in history so the
    // entry we pushed on open is consumed, keeping stack depth consistent
    // with what the hardware back button would do.
    history.back();
  }
  // Like closeSheet, but waits for its "back" to actually land before
  // returning -- needed whenever another overlay is about to open right
  // after this sheet closes (same reasoning as closeOverlayAwait).
  // Resolves false when it stayed open (a note left unsaved, kept).
  async function closeSheetAwait(el) {
    if (el.classList.contains('hidden')) return true;
    if (!(await okToLeaveNotes(el))) return false;
    await consumeHistoryEntry();
    return true;
  }

  // ---------- Tabs ----------
  // A note typed but not saved on the screen being left asks first.
  const switchTabWithNotes = async (tab) => { if (await okToLeaveNotes()) switchTab(tab); };
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTabWithNotes(btn.dataset.tab));
  });
  document.getElementById('auditModeBtn').addEventListener('click', () => switchTabWithNotes('audit'));

  function switchTab(tab) {
    if ((state.tab === 'walk' || state.tab === 'audit') && tab !== state.tab) {
      stopQrScanner();
    }
    if (tab === 'walk' && state.walk.phase === 'idle') {
      state.walk.phase = 'scanning';
    }
    // Tapping Scan while already on the scan tab with a dog up (picked but
    // not yet walking, or a finished walk's summary still showing) jumps
    // back to the camera, rather than just flashing the same screen. Never
    // while a walk is actually running -- that's still reachable this way.
    if (tab === 'walk' && state.tab === 'walk' && state.walk.phase !== 'scanning' && !activeWalkDogId()) {
      stopQrScanner();
      state.walk.phase = 'scanning';
    }
    // Leaving Stats drops its drill-down (its history steps are gone too), so
    // coming back shows the top of Stats, not a stale chart.
    if (state.tab === 'stats' && tab !== 'stats') applyStatsNav(null);
    state.tab = tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    topbarTitle.textContent = TAB_TITLES[tab];
    tabHistory(tab);
    render();
    // Re-check for anything new since last time whenever landing anywhere
    // except Updates itself -- that tab zeroes the badge on its own once
    // it's actually rendered (see renderUpdates).
    if (tab !== 'updates') refreshUpdatesBadge();
  }

  // Opening a dog from another tab (its photo or Start / Edit) is a step on
  // top of that tab, not a tab switch: Back returns to where it was opened
  // (Updates, Stats...), not to Available.
  function activateWalkTab() {
    const fromOtherTab = state.tab !== 'walk';
    if (state.tab === 'walk' || state.tab === 'audit') stopQrScanner();
    state.tab = 'walk';
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === 'walk'));
    topbarTitle.textContent = TAB_TITLES.walk;
    if (fromOtherTab && !syncingFromHistory) {
      pushHistory({ sheet: null, walkStep: 'opened' });
      onOpenedDogStep = true;
    } else {
      tabHistory('walk');
    }
  }

  // Jumps to the Walk tab's confirm/edit screen for a known dog (from the
  // Available list's "Start / Edit" button) without ever opening the camera —
  // switchTab() would default an idle walk phase to 'scanning' first.
  //
  // If a walk is already in progress for a DIFFERENT dog, this deliberately
  // refuses to overwrite state.walk with the new dog's confirm screen --
  // doing that used to silently strand the active walk (still running
  // server-side, but with nothing in the UI pointing back at it) with no
  // way back to it short of a full page reload. Instead that dog opens in an
  // edit-only popup (markers, POO, kennel spot) on top of whatever screen
  // you're on, so you can catch up on a dog you walked earlier while out
  // with the next one.
  function goToConfirmForDog(id) {
    const activeId = activeWalkDogId();
    // Any open walk blocks re-entering the confirm screen, even for the
    // SAME dog -- selectDogById() below re-fetches the dog and resets
    // state.walk.phase to 'confirm', which used to stomp the running
    // active/ending screen for the dog you're already out with, not just
    // for a different one.
    if (activeId && activeId !== String(id)) {
      showDogEditPopup(id);
      return;
    }
    if (activeId) {
      activateWalkTab();
      renderWalk();
      return;
    }
    activateWalkTab();
    selectDogById(id);
  }

  // Markers, POO status and kennel spot for one dog, without touching
  // state.walk -- the walk that's running stays exactly as it was. Uses the
  // same generic info popup as the marker breakdown and dog notes.
  async function showDogEditPopup(dogId) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = '<h3 style="margin-top:0;">✎ Edit dog</h3><p class="muted small center loading-line" role="status">Loading…</p>';
    openOverlay(popup);
    let dog;
    try {
      ({ dog } = await api(`/api/dogs/${dogId}?userId=${state.currentUser.id}`));
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">✎ Edit dog</h3><p class="small muted">Couldn't load this dog: ${esc(err.message)}</p>`;
      return;
    }
    const pending = {
      blueMarkers: [...(dog.blueMarkers || [])],
      pooStatus: dog.pooStatus || 'none',
      starFlag: !!dog.starFlag,
      pbFlag: !!dog.pbFlag
    };
    const stickers = speciesOf(dog).stickers;
    content.innerHTML = `
      <h3 style="margin-top:0;">✎ ${esc(dog.name)}</h3>
      ${state.walk.dog && String(state.walk.dog.id) !== String(dog.id) ? `<p class="small muted" style="margin-top:-6px;">You're still out with ${esc(state.walk.dog.name)} — this only edits ${esc(dog.name)}.</p>` : ''}
      ${stickers ? markerPickerHtml(dog) : ''}
      <label style="display:block;${stickers ? 'margin-top:14px;' : ''}">${esc(kennelPickLabel(speciesOf(dog)))}</label>
      ${kennelLetterPickerHtml('editPopupLocationPicker', dog.kennelLocation || '', { letters: kennelsOf(dog) })}
      <div class="row" style="margin-top:10px;">
        <button type="button" id="editPopupSaveBtn" class="btn primary">Save changes</button>
        <button type="button" id="editPopupNotesBtn" class="btn">📝 Notes</button>
      </div>
      <p id="editPopupStatus" class="small muted" style="margin:6px 0 0;"></p>`;
    wireMarkerPicker(pending, null, content);
    wireKennelLetterPicker('editPopupLocationPicker');
    document.getElementById('editPopupNotesBtn').addEventListener('click', () => showDogNotesPopup(dog.id));
    document.getElementById('editPopupSaveBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('editPopupStatus');
      const location = kennelLetterPickerValue('editPopupLocationPicker');
      statusEl.textContent = 'Saving…';
      try {
        if (stickers) await saveMarkerChanges(dog, pending);
        if (location && location !== dog.kennelLocation) {
          await api(`/api/dogs/${dog.id}/location`, { method: 'PUT', body: JSON.stringify({ location }) });
        }
        closeOverlay(popup);
        toast(`${dog.name} saved`);
        // The walk screen doesn't show other dogs; everywhere else might.
        if (state.tab !== 'walk') render();
      } catch (err) {
        if (err.staleMarkers) { await showDogEditPopup(dogId); appAlert(err.serverMessage || err.message, 'Stickers changed'); return; }
        statusEl.textContent = `Failed: ${err.message}`;
      }
    });
  }

  // ---------- Experience levels (tiers) ----------
  // Fetched once from the server (the rules live there) and cached — used to
  // build both the Settings picker and the first-run onboarding picker.
  async function loadExperienceLevels() {
    if (state.experienceLevels.length) return state.experienceLevels;
    const { levels } = await api('/api/experience-levels');
    state.experienceLevels = levels;
    return levels;
  }

  // Renders the shared level-picker markup (radio-like cards, one per tier)
  // into any container, used by both Settings and onboarding.
  function levelPickerHtml(levels, selectedKey) {
    return levels.map((lvl) => `
      <button type="button" class="btn level-pick-btn ${selectedKey === lvl.key ? 'primary' : ''}" data-level="${esc(lvl.key)}" style="text-align:left;display:block;width:100%;">
        <strong>${esc(lvl.label)}</strong>
        <div class="small ${selectedKey === lvl.key ? '' : 'muted'}">${esc(lvl.description)}</div>
      </button>`).join('');
  }

  // ---------- Web Push ----------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  // Requests notification permission and subscribes this device if needed.
  // Safe to call repeatedly (e.g. every time a pref checkbox is turned on) --
  // it reuses an existing subscription rather than making a new one.
  async function ensurePushSubscribed() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return false;
      } else if (Notification.permission === 'denied') {
        return false;
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const { publicKey } = await api('/api/push/vapid-public-key');
        if (!publicKey) return false;
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: state.currentUser.id, subscription: subscription.toJSON() })
      });
      return true;
    } catch (err) {
      console.warn('[push] subscribe failed:', err.message);
      return false;
    }
  }

  // ---------- Onboarding (first-run sequence) ----------
  // name -> experience level -> usual activity -> passkey offer (skippable) -> notification
  // prefs -> info -> thank you -> into the app. Gated on onboarding_completed
  // (backfilled to done for every account that existed before this sequence
  // did), not on experienceLevel, since an existing linked account might
  // already have a level but never seen the rest of this. Progress is kept
  // in localStorage (not the server) purely so the passkey step's redirect
  // to login.shelterwalk.com and back doesn't restart the whole sequence.
  const ONBOARDING_STEPS = ['name', 'species', 'level', 'activity', 'passkey', 'notifications', 'info', 'thanks'];
  const ONBOARDING_STEP_KEY = 'dogwalk_onboarding_step';

  function getOnboardingStep() {
    const stored = localStorage.getItem(ONBOARDING_STEP_KEY);
    return stored && ONBOARDING_STEPS.includes(stored) ? stored : ONBOARDING_STEPS[0];
  }

  async function maybeShowOnboarding() {
    if (state.currentUser.onboardingCompleted) return false;
    await runOnboardingStep(getOnboardingStep());
    return true;
  }

  // `strict` makes a failed save throw (Settings surfaces it); onboarding
  // stays best-effort so a hiccup here never traps someone on this step.
  async function saveNotificationPref(key, enabled, strict) {
    try {
      await api(`/api/users/${state.currentUser.id}/notification-prefs`, {
        method: 'PUT',
        body: JSON.stringify({ key, enabled })
      });
    } catch (err) { if (strict) throw err; }
  }

  // Why push couldn't be turned on, in words a volunteer can act on.
  function pushProblemMessage() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return "This browser can't show notifications. On iPhone, add Shelter Walk to your Home Screen first, then turn them on in Settings.";
    }
    if (window.Notification && Notification.permission === 'denied') {
      return 'Notifications are blocked for this app in your device settings. Allow them there, then turn them on again in Settings.';
    }
    return "Notifications couldn't be turned on for this device. You can try again from Settings.";
  }

  function onboardingProgressHtml(step) {
    const visible = ONBOARDING_STEPS.filter((st) => st !== 'thanks');
    const idx = visible.indexOf(step);
    if (idx < 0) return '';
    return `
      <div class="onboarding-progress" aria-label="Step ${idx + 1} of ${visible.length}">
        ${visible.map((_, i) => `<span class="dot${i <= idx ? ' on' : ''}"></span>`).join('')}
      </div>`;
  }

  async function runOnboardingStep(step) {
    localStorage.setItem(ONBOARDING_STEP_KEY, step);
    const picker = document.getElementById('onboardingPicker');
    const inner = document.getElementById('onboardingInner');
    picker.classList.remove('hidden');
    picker.scrollTop = 0;
    const backBtn = (prev) => prev ? `<button type="button" id="onboardingBack" class="btn" style="margin-top:8px;">Back</button>` : '';
    const wireBack = (prev) => {
      const b = document.getElementById('onboardingBack');
      if (b) b.addEventListener('click', () => runOnboardingStep(prev));
    };

    if (step === 'name') {
      // A name that came from splitting the email address ("Jsmith4943")
      // isn't worth pre-filling; only offer it if it already looks like a
      // real "First Last" someone typed themselves.
      const existing = (state.currentUser.name || '').trim();
      const looksReal = /^\S+\s+\S+/.test(existing) && !/\d/.test(existing);
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>Welcome to Shelter Walk 🐾</h2>
        <p class="muted small">Let's get you set up. It takes about a minute. First, what's your name? It's never shown on your past engagements with the animals, and you choose below whether other volunteers see it while you're out with an animal.</p>
        <label for="onboardingNameInput" class="small">Name</label>
        <input type="text" id="onboardingNameInput" maxlength="60" autocomplete="name" value="${esc(looksReal ? existing : '')}" />
        <label class="small" style="display:flex;align-items:center;gap:8px;margin-top:10px;">
          <input type="checkbox" id="onboardingHideName" ${state.currentUser.hideNameWhileWalking ? 'checked' : ''} />
          Keep my name private while I'm out with an animal
        </label>
        <p class="small muted" style="margin:10px 0 4px;">While you're with an animal (here, walking a dog), other volunteers see it on the Available list like this:</p>
        <div class="card compact name-preview" aria-hidden="true">
          <div class="dog-card">
            <img class="dog-photo small" src="/dog-silhouettes/7.svg?v=1" alt="" />
            <div class="dog-info">
              <p class="dog-name">Biscuit</p>
              <p class="dog-meta">Boxer Mix · 39d · 🏠 B</p>
              <span id="onboardingNamePreview" class="badge out-now"></span>
            </div>
          </div>
        </div>
        <p class="small muted" style="margin:4px 0 0;">You can change this any time in My Account.</p>
        <p id="onboardingNameStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingNameNext" class="btn primary" style="margin-top:6px;">Continue</button>`;
      // The example card: the same badge the Available list shows, with
      // "a volunteer" in place of the name when it's kept private.
      const walkInfo = activityInfo('walk');
      const updatePreview = () => {
        const typed = document.getElementById('onboardingNameInput').value.trim();
        const shown = document.getElementById('onboardingHideName').checked ? 'a volunteer' : (typed || 'your name');
        document.getElementById('onboardingNamePreview').textContent = `${walkInfo.emoji} ${walkInfo.out} ${shown}`;
      };
      document.getElementById('onboardingNameInput').addEventListener('input', updatePreview);
      document.getElementById('onboardingHideName').addEventListener('change', updatePreview);
      updatePreview();
      const submit = async () => {
        const name = document.getElementById('onboardingNameInput').value.trim();
        const statusEl = document.getElementById('onboardingNameStatus');
        if (!name) { statusEl.textContent = 'Please enter your name.'; return; }
        const btn = document.getElementById('onboardingNameNext');
        btn.disabled = true;
        try {
          const updated = await api('/api/me', { method: 'PUT', body: JSON.stringify({ name }) });
          state.currentUser.name = updated.name;
          const hide = document.getElementById('onboardingHideName').checked;
          if (hide !== !!state.currentUser.hideNameWhileWalking) {
            await api('/api/me/privacy', { method: 'PUT', body: JSON.stringify({ hideNameWhileWalking: hide }) });
            state.currentUser.hideNameWhileWalking = hide;
          }
          const nameEl = document.getElementById('userBtnName');
          if (nameEl) nameEl.textContent = updated.name;
          runOnboardingStep('species');
        } catch (err) {
          statusEl.textContent = err.status === 409
            ? 'Another volunteer already has that exact name. Add a middle initial or another detail to tell you apart.'
            : err.message;
          btn.disabled = false;
        }
      };
      document.getElementById('onboardingNameNext').addEventListener('click', submit);
      inner.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
      return;
    }

    if (step === 'species') {
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>Who do you volunteer with?</h2>
        <p class="muted small">Your lists and Updates will show these. Scanning works for any kennel card either way, and you can change this in Settings.</p>
        <div id="onboardingSpeciesList" class="marker-row" style="gap:6px;" data-selected="${esc(speciesPref())}">${speciesPrefPickerHtml(speciesPref())}</div>
        <p id="onboardingSpeciesStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingSpeciesNext" class="btn primary">Continue</button>
        ${backBtn('name')}`;
      wireBack('name');
      const list = document.getElementById('onboardingSpeciesList');
      wireSpeciesPrefPicker(list);
      document.getElementById('onboardingSpeciesNext').addEventListener('click', async () => {
        const nextBtn = document.getElementById('onboardingSpeciesNext');
        nextBtn.disabled = true;
        try {
          const pref = list.dataset.selected || 'dog';
          const levelsMatter = (pref === 'both' ? Object.keys(speciesTable()) : [pref]).some((k) => speciesInfo(k).levelRules);
          const updated = await api(`/api/users/${state.currentUser.id}/settings`, {
            method: 'PUT',
            // Levels only decide dogs: someone with cats only starts as a
            // Beginner (changeable in Settings) instead of being asked.
            body: JSON.stringify(levelsMatter ? { speciesPref: pref } : { speciesPref: pref, experienceLevel: state.currentUser.experienceLevel || 'beginner' })
          });
          state.currentUser.speciesPref = updated.speciesPref;
          applyTermsToPage();
          state.currentUser.experienceLevel = updated.experienceLevel;
          runOnboardingStep(levelsMatter ? 'level' : 'activity');
        } catch (err) {
          document.getElementById('onboardingSpeciesStatus').textContent = err.message;
          nextBtn.disabled = false;
        }
      });
      return;
    }

    if (step === 'level') {
      let levels;
      try { levels = await loadExperienceLevels(); } catch (err) {
        inner.innerHTML = `${onboardingProgressHtml(step)}<h2>Something went wrong</h2><p class="muted small">${esc(err.message)}</p><button type="button" id="onboardingRetry" class="btn primary">Try again</button>`;
        document.getElementById('onboardingRetry').addEventListener('click', () => runOnboardingStep('level'));
        return;
      }
      let selected = state.currentUser.experienceLevel || '';
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>What kind of ${worksWithBoth() ? 'dog ' : ''}volunteer are you?</h2>
        <p class="muted small">This decides which dogs the app shows you as ready to walk. Pick the one that fits you today. Not sure? Choose Beginner. You can change it any time in Settings.</p>
        ${worksWithBoth() ? '<p class="muted small">Levels are only for dogs. Any volunteer can cuddle any cat, with no hours needed.</p>' : ''}
        <div id="onboardingLevelList" class="stack"></div>
        <p id="onboardingLevelStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingLevelNext" class="btn primary" ${selected ? '' : 'disabled'}>Continue</button>
        ${backBtn('species')}`;
      wireBack('species');
      const list = document.getElementById('onboardingLevelList');
      list.innerHTML = levelPickerHtml(levels, selected);
      list.querySelectorAll('.level-pick-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          selected = btn.dataset.level;
          list.querySelectorAll('.level-pick-btn').forEach((b) => {
            b.classList.toggle('primary', b === btn);
            b.querySelector('.small').classList.toggle('muted', b !== btn);
          });
          document.getElementById('onboardingLevelNext').disabled = false;
        });
      });
      document.getElementById('onboardingLevelNext').addEventListener('click', async () => {
        const nextBtn = document.getElementById('onboardingLevelNext');
        nextBtn.disabled = true;
        try {
          const updated = await api(`/api/users/${state.currentUser.id}/settings`, {
            method: 'PUT',
            body: JSON.stringify({ experienceLevel: selected })
          });
          state.currentUser.experienceLevel = updated.experienceLevel;
          runOnboardingStep('activity');
        } catch (err) {
          document.getElementById('onboardingLevelStatus').textContent = err.message;
          nextBtn.disabled = false;
        }
      });
      return;
    }

    if (step === 'activity') {
      // One default per species: a "both" volunteer picks one for dogs and
      // one for cats (audit 3), each in its own labelled row.
      const speciesKeys = prefSpeciesKeys();
      const selected = {};
      speciesKeys.forEach((k) => { selected[k] = usualActivity(k); });
      const prevStep = speciesKeys.some((k) => speciesInfo(k).levelRules) ? 'level' : 'species';
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>What do you usually do with the ${esc(nounFor(speciesKeys, true))}?</h2>
        <p class="muted small">This is your default activity: when you scan an animal, the Start button offers it first. You can still change it each time, when you scan or while you're with the animal, and change your default in Settings.</p>
        <div id="onboardingActivityList">${defaultActivityRowsHtml(speciesKeys)}</div>
        <p id="onboardingActivityStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingActivityNext" class="btn primary">Continue</button>
        ${backBtn(prevStep)}`;
      wireBack(prevStep);
      const list = document.getElementById('onboardingActivityList');
      list.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-activity]');
        const row = chip && chip.closest('[data-species]');
        if (!row) return;
        selected[row.dataset.species] = chip.dataset.activity;
        row.querySelectorAll('[data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
      });
      document.getElementById('onboardingActivityNext').addEventListener('click', async () => {
        const nextBtn = document.getElementById('onboardingActivityNext');
        nextBtn.disabled = true;
        const body = {};
        speciesKeys.forEach((k) => { body[defaultKeyFor(k)] = selected[k]; });
        try {
          const updated = await api(`/api/users/${state.currentUser.id}/settings`, {
            method: 'PUT',
            body: JSON.stringify(body)
          });
          Object.keys(body).forEach((field) => { state.currentUser[field] = updated[field]; });
          runOnboardingStep('passkey');
        } catch (err) {
          document.getElementById('onboardingActivityStatus').textContent = err.message;
          nextBtn.disabled = false;
        }
      });
      return;
    }

    if (step === 'passkey') {
      // No point offering a passkey on a browser that can't make one.
      if (!window.PublicKeyCredential) { runOnboardingStep('notifications'); return; }
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>Want faster sign-in?</h2>
        <p class="muted small">Set up a passkey to sign in with your fingerprint, face, or device PIN instead of waiting for an email code. It only takes a few seconds, and email codes always still work as a backup.</p>
        <button type="button" id="onboardingPasskeySetup" class="btn primary">Set up a passkey</button>
        <button type="button" id="onboardingPasskeySkip" class="btn" style="margin-top:8px;">Skip for now</button>
        ${backBtn('activity')}`;
      wireBack('activity');
      document.getElementById('onboardingPasskeySetup').addEventListener('click', () => {
        localStorage.setItem(ONBOARDING_STEP_KEY, 'notifications');
        const returnUrl = encodeURIComponent(window.location.origin + '/');
        window.location.href = `https://login.shelterwalk.com/accounts/2fa/webauthn/add/?next=${returnUrl}`;
      });
      document.getElementById('onboardingPasskeySkip').addEventListener('click', () => runOnboardingStep('notifications'));
      return;
    }

    if (step === 'notifications') {
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>Stay in the loop?</h2>
        <p class="muted small">Optional. Get a notification on this device, even when the app is closed. You can change these any time in Settings.</p>
        <label class="small checkbox-row">
          <input type="checkbox" id="onboardingPrefAlerts" checked />
          <span>Urgent shelter alerts from staff, like the shelter closing unexpectedly</span>
        </label>
        <label class="small checkbox-row">
          <input type="checkbox" id="onboardingPrefAdopted" />
          <span>Tell me when a ${esc(prefWords().noun)} I've ${prefWords().did} is adopted</span>
        </label>
        <label class="small checkbox-row">
          <input type="checkbox" id="onboardingPrefWalkStarted" />
          <span>When I start ${prefWords().start}, remind me which ${esc(prefWords().noun)} and where to return them</span>
        </label>
        <p class="muted small" style="margin-top:8px;">On iPhone, notifications only work after you add this app to your Home Screen.</p>
        <p id="onboardingNotifStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingNotifNext" class="btn primary">Continue</button>
        ${backBtn('passkey')}`;
      wireBack('passkey');
      let warned = false;
      document.getElementById('onboardingNotifNext').addEventListener('click', async () => {
        const btn = document.getElementById('onboardingNotifNext');
        const statusEl = document.getElementById('onboardingNotifStatus');
        if (warned) { runOnboardingStep('info'); return; }
        const wantsAdopted = document.getElementById('onboardingPrefAdopted').checked;
        const wantsWalkStarted = document.getElementById('onboardingPrefWalkStarted').checked;
        const wantsAlerts = document.getElementById('onboardingPrefAlerts').checked;
        btn.disabled = true;
        await saveNotificationPref('shelter_alerts', wantsAlerts);
        await saveNotificationPref('adopted_walked_dog', wantsAdopted);
        await saveNotificationPref('walk_started', wantsWalkStarted);
        if ((wantsAlerts || wantsAdopted || wantsWalkStarted) && !(await ensurePushSubscribed())) {
          // Their choices are saved, but this device can't receive them yet:
          // say so instead of letting them believe it's working.
          warned = true;
          statusEl.textContent = pushProblemMessage();
          btn.textContent = 'Continue anyway';
          btn.disabled = false;
          return;
        }
        runOnboardingStep('info');
      });
      return;
    }

    if (step === 'info') {
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>Good to know</h2>
        <ul class="onboarding-tips">
          <li><strong>Book icon (top right):</strong> the <strong>Guide</strong>. ${prefSpeciesKeys().some((k) => speciesInfo(k).stickers) ? 'What every sticker means, tips for walking, and how' : 'How'} the app works.</li>
          <li><strong>Gear icon (top right):</strong> change ${prefSpeciesKeys().some((k) => speciesInfo(k).levelRules) ? 'your experience level, ' : ''}who you volunteer with, notifications, and light or dark mode.</li>
          <li><strong>Your name (top bar):</strong> change your name, email, and passkeys, or sign out.</li>
          <li><strong>Tap a ${esc(prefWords().noun)}'s photo</strong> to see it full size.</li>
          ${prefSpeciesKeys().some((k) => speciesInfo(k).youngFirst) ? '<li><strong>Kittens before adult cats:</strong> an adult cat can pass disease on to a kitten. The app warns you before a kitten if you were with an adult cat this shift.</li>' : ''}
        </ul>
        <button type="button" id="onboardingInfoNext" class="btn primary">Continue</button>
        ${backBtn('notifications')}`;
      wireBack('notifications');
      document.getElementById('onboardingInfoNext').addEventListener('click', () => runOnboardingStep('thanks'));
      return;
    }

    if (step === 'thanks') {
      inner.innerHTML = `
        <h2>Thank you! 🐾</h2>
        <p>Thanks for volunteering and making a ${esc(prefWords().noun)}'s day better.</p>
        <p>New here? The short tutorial shows how everything works, starting with how to scan a kennel card for ${prefWords().start}. It takes about 2 minutes.</p>
        <p id="onboardingFinishStatus" class="small" style="color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingTutorialBtn" class="btn primary">📘 Show me how it works</button>
        <button type="button" id="onboardingFinishBtn" class="btn" style="margin-top:8px;">Skip, go to the ${esc(nounFor(prefSpeciesKeys(), true))}</button>`;
      // Either button finishes setup; the main one then opens the tutorial,
      // which links back to the app when they're done.
      const finish = async (toTutorial) => {
        const buttons = [document.getElementById('onboardingTutorialBtn'), document.getElementById('onboardingFinishBtn')];
        buttons.forEach((b) => { b.disabled = true; });
        try {
          await api(`/api/users/${state.currentUser.id}/onboarding-complete`, { method: 'POST' });
        } catch (err) {
          // Not saving this means they'd be walked through setup again next
          // time, so don't pretend it worked.
          document.getElementById('onboardingFinishStatus').textContent = `Couldn't finish setup: ${err.message}`;
          buttons.forEach((b) => { b.disabled = false; });
          return;
        }
        state.currentUser.onboardingCompleted = true;
        document.getElementById('userBtnName').textContent = state.currentUser.name;
        localStorage.removeItem(ONBOARDING_STEP_KEY);
        if (toTutorial) {
          window.location.href = '/tutorial.html';
          return;
        }
        document.getElementById('onboardingPicker').classList.add('hidden');
        await completeInit();
      };
      document.getElementById('onboardingTutorialBtn').addEventListener('click', () => finish(true));
      document.getElementById('onboardingFinishBtn').addEventListener('click', () => finish(false));
      return;
    }
  }

  // ---------- Settings sheet ----------
  const settingsSheet = document.getElementById('settingsSheet');
  const WALK_ALERT_INPUTS = ['settingsWalkAlert1', 'settingsWalkAlert2', 'settingsWalkAlert3'];
  // Settings checkbox -> notification pref, for the hearted-dog notices.
  const FAVORITE_PREFS = [
    ['settingsPrefFavAdopted', 'favorite_adopted'],
    ['settingsPrefFavPending', 'favorite_pending'],
    ['settingsPrefFavReturned', 'favorite_returned']
  ];
  // The walk-length alerts typed in Settings, as whole minutes (empty boxes
  // skipped), or an error message.
  function readWalkAlerts() {
    const minutes = [];
    for (const inputId of WALK_ALERT_INPUTS) {
      const raw = document.getElementById(inputId).value.trim();
      if (!raw) continue;
      const m = Number(raw);
      if (!Number.isInteger(m) || m < 1 || m > 179) return { error: 'Length alerts must be whole minutes from 1 to 179.' };
      minutes.push(m);
    }
    return { minutes };
  }
  const speciesPrefPicker = document.getElementById('speciesPrefPicker');
  // The default-activity chips follow the species picked: one row per
  // species, each offering only what that species can do.
  function fillDefaultActivityPicker(pref) {
    defaultActivityPicker.innerHTML = defaultActivityRowsHtml(pref === 'both' ? Object.keys(speciesTable()) : [pref]);
  }
  // Levels only decide dogs: hidden for cats only, marked "(dogs)" for both.
  function syncLevelSection(pref) {
    const keys = pref === 'both' ? Object.keys(speciesTable()) : [pref];
    const levels = keys.some((k) => speciesInfo(k).levelRules);
    const mixed = levels && keys.some((k) => !speciesInfo(k).levelRules);
    document.getElementById('levelSection').classList.toggle('hidden', !levels);
    document.getElementById('levelDogsOnly').classList.toggle('hidden', !mixed);
    document.getElementById('levelBothNote').classList.toggle('hidden', !mixed);
  }
  // Every control in Settings saves itself the moment it's changed -- no
  // Save button to remember to tap, and switching species (the one people
  // change most, and expect to see reflected right away) takes effect on
  // the screen behind the sheet immediately too.
  wireSpeciesPrefPicker(speciesPrefPicker, async (pref) => {
    fillDefaultActivityPicker(pref);
    syncLevelSection(pref);
    try {
      const updated = await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ speciesPref: pref }) });
      state.currentUser.speciesPref = updated.speciesPref;
      applyTermsToPage();
      if (state.tab === 'available' || (state.tab === 'walk' && ['idle', 'scanning'].includes(state.walk.phase))) topbarTitle.textContent = TAB_TITLES[state.tab];
      render();
    } catch (err) { toast(err.message, 'error'); }
  });
  const defaultActivityPicker = document.getElementById('defaultActivityPicker');
  defaultActivityPicker.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-activity]');
    const row = chip && chip.closest('[data-species]');
    if (!row) return;
    row.querySelectorAll('[data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
    const field = defaultKeyFor(row.dataset.species);
    try {
      const updated = await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ [field]: chip.dataset.activity }) });
      state.currentUser[field] = updated[field];
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('desktopViewSelect').addEventListener('change', async (e) => {
    try {
      await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ desktopView: e.target.value }) });
      const desk = state.currentUser.desktop;
      if (desk) { desk.start = e.target.value; desk.chosen = e.target.value; }
    } catch (err) { toast(err.message, 'error'); }
  });
  // Notification + favorite + Updates-feed toggles: push-dependent ones
  // (isPush) also try to turn push on the moment they're switched on, same
  // as the old Save button did, just per-toggle instead of all at once.
  const PUSH_DEPENDENT_TOGGLES = [
    ['settingsPrefShelterAlerts', 'shelter_alerts'],
    ['settingsPrefNewSignups', 'new_signups'],
    ['settingsPrefAdopted', 'adopted_walked_dog'],
    ['settingsPrefWalkStarted', 'walk_started'],
    ...FAVORITE_PREFS
  ];
  const FEED_TOGGLES = [
    ['settingsShowNewDog', 'show_new_dog'],
    ['settingsShowAdopted', 'show_adopted'],
    ['settingsShowReturned', 'show_returned']
  ];
  function wireAutosaveToggle(inputId, key, isPush) {
    const el = document.getElementById(inputId);
    el.addEventListener('change', async () => {
      const enabled = el.checked;
      try {
        await saveNotificationPref(key, enabled, true);
        if (isPush && enabled) {
          const ok = await ensurePushSubscribed();
          if (!ok) toast(`Saved, but notifications aren't working on this device yet. ${pushProblemMessage()}`, 'error');
        } else if (!isPush) {
          await refreshUpdatesTabVisibility();
        }
      } catch (err) {
        el.checked = !enabled;
        toast(err.message, 'error');
      }
    });
  }
  PUSH_DEPENDENT_TOGGLES.forEach(([inputId, key]) => wireAutosaveToggle(inputId, key, true));
  FEED_TOGGLES.forEach(([inputId, key]) => wireAutosaveToggle(inputId, key, false));
  WALK_ALERT_INPUTS.forEach((inputId) => {
    document.getElementById(inputId).addEventListener('change', async () => {
      const result = readWalkAlerts();
      if (result.error) { toast(result.error, 'error'); return; }
      try {
        await api(`/api/users/${state.currentUser.id}/walk-alerts`, { method: 'PUT', body: JSON.stringify({ minutes: result.minutes }) });
        if (result.minutes.length) {
          const ok = await ensurePushSubscribed();
          if (!ok) toast(`Saved, but notifications aren't working on this device yet. ${pushProblemMessage()}`, 'error');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.getElementById('settingsBtn').addEventListener('click', async () => {
    const levels = await loadExperienceLevels();
    document.getElementById('experienceLevelPicker').innerHTML = levelPickerHtml(levels, state.currentUser.experienceLevel);
    speciesPrefPicker.innerHTML = speciesPrefPickerHtml(speciesPref());
    speciesPrefPicker.dataset.selected = speciesPref();
    syncLevelSection(speciesPref());
    fillDefaultActivityPicker(speciesPref());
    document.getElementById('experienceLevelPicker').querySelectorAll('.level-pick-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        document.getElementById('experienceLevelPicker').querySelectorAll('.level-pick-btn').forEach((b) => {
          b.classList.toggle('primary', b === btn);
          b.querySelector('.small').classList.toggle('muted', b !== btn);
        });
        document.getElementById('experienceLevelPicker').dataset.selected = btn.dataset.level;
        try {
          const updated = await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ experienceLevel: btn.dataset.level }) });
          state.currentUser.experienceLevel = updated.experienceLevel;
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    document.getElementById('experienceLevelPicker').dataset.selected = state.currentUser.experienceLevel || '';
    document.getElementById('themePicker').innerHTML = themePickerHtml(getStoredTheme());
    document.getElementById('themePicker').querySelectorAll('.theme-pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setTheme(btn.dataset.themeKey);
        document.getElementById('themePicker').querySelectorAll('.theme-pick-btn').forEach((b) => {
          b.classList.toggle('primary', b === btn);
        });
      });
    });
    const buildEl = document.getElementById('buildInfo');
    if (buildEl) {
      const stamp = Number((document.querySelector('meta[name="build"]') || {}).content);
      buildEl.textContent = stamp ? `Shelter Walk, updated ${new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: SHELTER_TZ })}, ${fmtClock(stamp)}` : '';
    }
    document.getElementById('refreshStatus').textContent = '';
    document.getElementById('refreshDataSection').classList.toggle('hidden', !(state.currentUser.isStaff || state.currentUser.isPrivileged));
    fillDesktopViewSetting();
    try {
      const { prefs } = await api(`/api/users/${state.currentUser.id}/notification-prefs`);
      document.getElementById('settingsPrefShelterAlerts').checked = prefs.shelter_alerts !== false;
      document.getElementById('settingsPrefNewSignups').checked = prefs.new_signups !== false;
      document.getElementById('settingsNewSignupsRow').classList.toggle('hidden', !state.currentUser.isPrivileged);
      document.getElementById('settingsPrefAdopted').checked = !!prefs.adopted_walked_dog;
      document.getElementById('settingsPrefWalkStarted').checked = !!prefs.walk_started;
      FAVORITE_PREFS.forEach(([inputId, key]) => { document.getElementById(inputId).checked = !!prefs[key]; });
      document.getElementById('settingsShowNewDog').checked = prefs.show_new_dog !== false;
      document.getElementById('settingsShowAdopted').checked = prefs.show_adopted !== false;
      document.getElementById('settingsShowReturned').checked = prefs.show_returned !== false;
    } catch (err) { /* leave defaults (checked) if this fails to load */ }
    try {
      const { minutes } = await api(`/api/users/${state.currentUser.id}/walk-alerts`);
      WALK_ALERT_INPUTS.forEach((inputId, i) => { document.getElementById(inputId).value = minutes[i] || ''; });
    } catch (err) { /* leave them empty if this fails to load */ }
    openSheet(settingsSheet, 'settings');
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => closeSheet(settingsSheet));

  // "On a computer, open": which page the site starts on at a computer
  // (desktopViews.js on the server). Only shown on a computer, or to staff,
  // who have more than one desktop page to choose from anyway.
  const onPhone = /Mobi|Android|iPhone|iPod|Windows Phone/i.test(navigator.userAgent);
  // A phone, or any screen too narrow to be a computer (a phone-sized window
  // whose browser doesn't say "Mobi").
  function onSmallDevice() { return onPhone || window.innerWidth < 768; }
  function fillDesktopViewSetting() {
    const desk = state.currentUser.desktop;
    const section = document.getElementById('desktopViewSection');
    const show = !!desk && desk.views.length > 1 && (!onSmallDevice() || state.currentUser.isStaff);
    section.classList.toggle('hidden', !show);
    if (!show) return;
    const select = document.getElementById('desktopViewSelect');
    select.innerHTML = desk.views.map((v) => `<option value="${esc(v.key)}"${v.key === desk.start ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
  }
  // Book icon in the top bar. Already in the Guide? Just go back to its list.
  document.getElementById('guideBtn').addEventListener('click', async () => {
    if (state.tab === 'guide') {
      // An edit not saved yet asks first (audit 3).
      if (!(await okToLeaveNotes(appEl))) return;
      state.guide.sectionId = null;
      state.guide.editing = null;
      state.guide.query = '';
      appEl.scrollTop = 0;
      render();
    } else {
      openGuide();
    }
  });
  document.getElementById('refreshDataBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('refreshStatus');
    const btn = document.getElementById('refreshDataBtn');
    btn.disabled = true;
    statusEl.textContent = 'Refreshing from pets.wake.gov. This can take a minute.';
    try {
      const result = await api('/api/scrape/run', { method: 'POST', timeout: 180000 });
      const counts = result.counts
        ? Object.entries(result.counts).map(([k, n]) => `${n} ${speciesInfo(k).plural.toLowerCase()}`).join(' and ')
        : `${result.count} dogs`;
      statusEl.textContent = result.counts
        ? `${result.ok ? 'Done' : `Partly done (${result.error})`}. ${counts} currently listed.`
        : `Failed: ${result.error}`;
      render();
    } catch (err) {
      statusEl.textContent = `Failed: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Profile sheet ----------
  const profileSheet = document.getElementById('profileSheet');
  const profileSheetInner = document.getElementById('profileSheetInner');
  // Once scrolled, the ✕ sits on a bar of its own (style.css
  // .sheet-close-bar.scrolled), so it never covers Start / Edit or a tip's
  // buttons scrolling under it.
  profileSheetInner.addEventListener('scroll', () => {
    const bar = profileSheetInner.querySelector('.sheet-close-bar');
    if (bar) bar.classList.toggle('scrolled', profileSheetInner.scrollTop > 8);
  }, { passive: true });

  // Tapping the dimmed backdrop closes the sheet, same as the X/Done button.
  // Settings has no discard-on-close behavior to worry about: every control
  // in it saves itself the moment it's changed. Guarded on e.target === the
  // overlay itself so clicks inside the actual panel never bubble into an
  // accidental close.
  [settingsSheet, profileSheet, document.getElementById('accountSheet')].forEach((el) => {
    el.addEventListener('click', (e) => { if (e.target === el) closeSheet(el); });
  });

  // ---------- Dog notes: shared tips + private note ----------
  // One component, mounted on the dog profile and the pre-walk screen.
  //  - Tips: a compact bullet list that EVERY walker can add, edit, or delete
  //    from (tap the pencil/x next to a line). No names are ever shown or
  //    stored with what is returned, so the list can't be used to single
  //    anyone out.
  //  - Private note: one per walker per dog, visible only to its writer.
  // Notes left for other walkers at the end of past walks are listed too,
  // with the same edit/delete (only the note changes, never the walk).

  // ---------- "@" tags in everyday notes ----------
  // Shared tips, private notes and the note left at the end of a walk or
  // play session can tag other animals, the same way playgroup notes do
  // (pg-tags.js): typed as "@Name", saved as "@[id]", shown as the animal's
  // current name and tappable to open them. Cats share condos and rooms far
  // more than dogs share kennels, so a note on one often matters to the
  // others (owner, 2026-11-09). The server drops tags to unknown animals.
  let taggablePromise = null;
  function taggableAnimals() {
    if (!taggablePromise) {
      taggablePromise = api('/api/dogs?all=true&fields=names')
        .then((d) => window.PgTags.taggableFrom(d.dogs))
        .catch(() => { taggablePromise = null; return []; });
    }
    return taggablePromise;
  }
  // Note text as HTML: escaped, YouTube links, and tags as the animal's name
  // (`tagged`: id -> { name }, sent by the server next to the notes).
  function noteBodyHtml(body, tagged) {
    return linkifyYouTube(esc(body)).replace(/@\[(\d+)\]/g, (all, id) => (tagged && tagged[id]
      ? `<button type="button" class="pg-tag note-tag" data-tag-animal="${id}">@${esc(tagged[id].name)}</button>`
      : `@${id}`));
  }
  // Tapping a tag opens that animal's profile, wherever the note is shown
  // (capture phase, so a card the note sits on doesn't open its own animal).
  document.addEventListener('click', async (e) => {
    const tag = e.target.closest && e.target.closest('.note-tag[data-tag-animal]');
    if (!tag) return;
    e.preventDefault();
    e.stopPropagation();
    const popup = tag.closest('.overlay, [id$="Popup"]');
    try {
      const { dog, walks } = await api(`/api/dogs/${tag.dataset.tagAnimal}?userId=${state.currentUser.id}`);
      if (popup && popup.id === 'markerInfoPopup') closeOverlay(popup);
      showProfileSheet(dog, walks);
    } catch (err) { toast(err.message, 'error'); }
  }, true);
  const tagHint = () => `Type @ (or just a name) to tag another ${nounFor(prefSpeciesKeys())}`;
  function noteTagBoxHtml({ text = '', placeholder = '', cls = '', id = '' } = {}) {
    return `<div class="pg-text-wrap note-tag-wrap">
      <div${id ? ` id="${id}"` : ''} class="pg-text note-tag-text ${cls}" data-placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">${esc(text)}</div>
      <div class="pg-suggest hidden" role="listbox" aria-label="Animals to tag"></div>
    </div>`;
  }
  // Wires the @ picker on one noteTagBoxHtml. `body` (stored text, tags as
  // @[id]) starts the box with that note in it; `tagged` names its tags.
  // Ctrl/Cmd+Enter calls onSubmit, Escape (with no suggestions open) onCancel.
  // Leaving with text in it that wasn't saved asks first (okToLeaveNotes),
  // offering onSubmit as the Save; `guard: false` for a box that keeps its
  // own draft.
  // Shared notes (tips, the note left at the end of a walk) are capped at
  // this many characters by the server.
  const NOTE_MAX_CHARS = 1000;
  const PRIVATE_NOTE_MAX_CHARS = 4000;
  function wireNoteTagBox(wrap, { ownId = null, body = '', tagged = {}, onSubmit, onCancel, maxLength = NOTE_MAX_CHARS, guard = true } = {}) {
    const el = wrap.querySelector('.pg-text');
    const start = body ? window.PgTags.toEditable(body, tagged) : { text: '', picks: new Map() };
    if (body) el.textContent = start.text;
    // A counter shows once the text gets near the limit, and turns red past it.
    if (maxLength) {
      const counter = document.createElement('span');
      counter.className = 'small muted note-char-count hidden';
      counter.setAttribute('aria-live', 'polite');
      counter.style.display = 'block';
      counter.style.textAlign = 'right';
      // Under the text box itself, not beside it in a row with the buttons.
      (wrap.querySelector('.note-tag-wrap') || wrap).appendChild(counter);
      const update = () => {
        const len = (el.textContent || '').trim().length;
        counter.textContent = `${len} / ${maxLength}`;
        counter.classList.toggle('hidden', len < maxLength * 0.8);
        counter.style.color = len > maxLength ? 'var(--danger, #b91c1c)' : '';
      };
      el.addEventListener('input', update);
      update();
    }
    const tags = window.PgTags.wireTagPicker(el, wrap.querySelector('.pg-suggest'), { getDogs: taggableAnimals, picks: start.picks, ownId });
    // A name typed without "@" gets the same tap-to-tag suggestion as in
    // playgroup notes.
    window.PgTags.wireAutoTagger(el, { getDogs: taggableAnimals, ownId, picks: start.picks, declineLabel: "Don't tag" });
    if (guard) window.PgTags.guardNote(el, { body: () => tags.body(), save: onSubmit ? async () => { await onSubmit(); } : null });
    el.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit) { e.preventDefault(); onSubmit(); }
      if (e.key === 'Escape' && onCancel) { e.preventDefault(); onCancel(); }
    });
    const focusEnd = () => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    return { el, body: () => tags.body(), focus: focusEnd, picks: start.picks };
  }

  function dogNotesShellHtml() {
    return `<div class="dog-notes"><p class="muted small center">Loading notes…</p></div>`;
  }

  // Notes on other animals that tag this one (shared ones, and your own
  // private notes), newest first, so a cat's roommates' notes show up on it.
  function mentionsHtml(mentions, tagged) {
    if (!mentions || !mentions.length) return '';
    const kindOf = (m) => {
      if (m.kind === 'tip') return 'tips';
      if (m.kind === 'private') return 'your private note';
      if (m.kind === 'playgroup') return 'playgroup';
      return `${termsOf(m.from).noun} notes`;
    };
    return `<label class="small muted notes-label">Tagged in other notes <span class="badge neutral">${mentions.length}</span></label>
      <ul class="tip-list">${mentions.map((m) => `<li class="tip-item tip-item-walk">
        <span class="tip-bullet">•</span>
        <span class="tip-text">${noteBodyHtml(m.body, { ...tagged, [m.from.id]: m.from })} <span class="tip-date">in <button type="button" class="pg-tag note-tag" data-tag-animal="${m.from.id}">${esc(m.from.name)}</button>'s ${kindOf(m)} · ${fmtNoteDate(m.at)}</span></span>
      </li>`).join('')}</ul>`;
  }

  async function mountDogNotes(container, dog, walks) {
    if (!container) return;
    let data;
    try {
      data = await api(`/api/dogs/${dog.id}/notes`);
    } catch (err) {
      container.innerHTML = `<p class="muted small">Couldn't load notes: ${esc(err.message)}</p>`;
      return;
    }
    const reload = () => mountDogNotes(container, dog, walks);
    const tagged = { ...(data.tagged || {}), [dog.id]: dog };
    // A note left at the end of a session is tagged by what the session
    // actually was -- playgroup gets its own label instead of being folded
    // into "walk", which was confusing next to the dog's separate playgroup
    // notes. Walk notes are their own list from the server (data.walkNotes):
    // an opaque id, the text, the shelter date and the activity, never tied
    // to a walk. Sorted by day only (then text), like the server sends them.
    const items = [
      ...data.sharedTips.map((t) => ({ kind: 'tip', id: t.id, body: t.body, when: t.createdAt, updatedAt: t.updatedAt })),
      ...(data.walkNotes || []).map((n) => ({ kind: n.activity === 'playgroup' ? 'playgroup' : 'walk', id: n.noteId, body: n.text, when: n.date }))
    ].sort((a, b) => {
      const da = String(a.when || '').slice(0, 10);
      const dbk = String(b.when || '').slice(0, 10);
      return da !== dbk ? (da < dbk ? 1 : -1) : 0;
    });
    const isWalkKind = (kind) => kind === 'walk' || kind === 'playgroup';
    const tipRows = items.map((n) => `<li class="tip-item${isWalkKind(n.kind) ? ' tip-item-walk' : ''}" ${isWalkKind(n.kind) ? 'data-walk' : 'data-tip'}="${n.id}">
           <span class="tip-bullet">•</span>
           <span class="tip-text">${noteBodyHtml(n.body, tagged)} ${noteDateHtml(n.when, n.updatedAt)}</span>
           <span class="tip-item-actions">
             <button type="button" class="mini-icon-btn" data-act="edit" aria-label="Edit this tip">✎</button>
             <button type="button" class="mini-icon-btn" data-act="erase" aria-label="Delete this tip">✕</button>
           </span>
         </li>`).join('');
    container.innerHTML = `
      <label class="small muted notes-label">Tips <span class="badge neutral">Anyone can edit or delete</span></label>
      <ul class="tip-list">
        ${tipRows}
      </ul>
      <div class="tip-add-row tip-add-main">
        ${noteTagBoxHtml({ placeholder: `Add a tip about ${dog.name}… ${tagHint()}`, cls: 'tip-input' })}
        <button type="button" class="btn small-btn primary tip-add-btn">Add</button>
      </div>
      <p class="small muted tip-help">Your name isn't shown with a tip.</p>
      <label class="small muted notes-label">My private notes <span class="badge neutral">Only you can see this</span></label>
      <ul class="tip-list">
        ${data.privateNote ? `<li class="tip-item" data-private="1">
             <span class="tip-bullet">•</span>
             <span class="tip-text">${noteBodyHtml(data.privateNote.body, tagged)} <span class="tip-date">updated ${fmtNoteDate(data.privateNote.updatedAt)}</span></span>
             <span class="tip-item-actions">
               <button type="button" class="mini-icon-btn" data-act="edit" aria-label="Edit your private note">✎</button>
               <button type="button" class="mini-icon-btn" data-act="erase" aria-label="Delete your private note">✕</button>
             </span>
           </li>` : ''}
      </ul>
      ${data.privateNote ? '' : `<div class="tip-add-row private-note-add-row">
        ${noteTagBoxHtml({ placeholder: `Reminders just for you (what works with ${dog.name}, where you left off…)`, cls: 'tip-input private-note-input' })}
        <button type="button" class="btn small-btn primary private-note-add-btn">Add</button>
      </div>`}
      ${mentionsHtml(data.mentions, tagged)}`;

    let addTip = null;
    const tipBox = wireNoteTagBox(container.querySelector('.tip-add-main'), { ownId: dog.id, onSubmit: () => addTip() });
    addTip = async () => {
      const body = tipBox.body();
      if (!body) { tipBox.focus(); return; }
      try {
        await api(`/api/dogs/${dog.id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
        toast('Tip added');
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    container.querySelector('.tip-add-btn').addEventListener('click', addTip);

    // Edit a tip in place: the bullet becomes a one-line textbox with Save/Cancel.
    // Notes from walks work the same way, through their own route.
    container.querySelectorAll('.tip-item[data-tip], .tip-item[data-walk]').forEach((li) => {
      const isWalk = li.dataset.walk !== undefined;
      const id = isWalk ? li.dataset.walk : li.dataset.tip;
      const url = `/api/dogs/${dog.id}/${isWalk ? 'walk-notes' : 'notes'}/${id}`;
      const current = (items.find((n) => (isWalk ? isWalkKind(n.kind) : n.kind === 'tip') && String(n.id) === id) || {}).body || '';
      li.querySelector('[data-act="edit"]').addEventListener('click', () => {
        li.classList.add('editing');
        li.innerHTML = `
          ${noteTagBoxHtml({ cls: 'tip-edit-input' })}
          <span class="tip-item-actions">
            <button type="button" class="mini-icon-btn" data-act="save" aria-label="Save">✓</button>
            <button type="button" class="mini-icon-btn" data-act="cancel" aria-label="Cancel">✕</button>
          </span>`;
        let save = null;
        const box = wireNoteTagBox(li, { ownId: dog.id, body: current, tagged, onSubmit: () => save(), onCancel: reload });
        box.focus();
        save = async () => {
          const next = box.body();
          if (!next) { toast('Use the ✕ next to a tip to delete it.', 'error'); return; }
          if (next === current) { reload(); return; }
          try { await api(url, { method: 'PUT', body: JSON.stringify({ body: next }) }); toast('Tip updated'); await reload(); }
          catch (err) { toast(err.message, 'error'); }
        };
        li.querySelector('[data-act="save"]').addEventListener('click', () => save());
        li.querySelector('[data-act="cancel"]').addEventListener('click', reload);
      });
      li.querySelector('[data-act="erase"]').addEventListener('click', async () => {
        if (!(await appConfirm('Delete this tip? Every volunteer will stop seeing it.', { title: 'Delete tip', confirmText: 'Delete', danger: true }))) return;
        try { await api(url, { method: 'DELETE' }); toast('Tip deleted'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });

    // Add: the empty-state input row.
    const savePrivate = async (body) => {
      try {
        await api(`/api/dogs/${dog.id}/private-note`, { method: 'PUT', body: JSON.stringify({ body }) });
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    const addBtn = container.querySelector('.private-note-add-btn');
    if (addBtn) {
      let doAdd = null;
      const addBox = wireNoteTagBox(container.querySelector('.private-note-add-row'), { ownId: dog.id, onSubmit: () => doAdd(), maxLength: PRIVATE_NOTE_MAX_CHARS });
      doAdd = () => { const body = addBox.body(); if (!body) { addBox.focus(); return null; } return savePrivate(body); };
      addBtn.addEventListener('click', doAdd);
    }

    // Edit/erase: same in-place pattern as the shared tips.
    const privateLi = container.querySelector('.tip-item[data-private]');
    if (privateLi) {
      const current = data.privateNote ? data.privateNote.body : '';
      privateLi.querySelector('[data-act="edit"]').addEventListener('click', () => {
        privateLi.classList.add('editing');
        privateLi.innerHTML = `
          ${noteTagBoxHtml({ cls: 'tip-edit-input' })}
          <span class="tip-item-actions">
            <button type="button" class="mini-icon-btn" data-act="save" aria-label="Save">✓</button>
            <button type="button" class="mini-icon-btn" data-act="cancel" aria-label="Cancel">✕</button>
          </span>`;
        let save = null;
        const box = wireNoteTagBox(privateLi, { ownId: dog.id, body: current, tagged, onSubmit: () => save(), onCancel: reload, maxLength: PRIVATE_NOTE_MAX_CHARS });
        box.focus();
        save = () => {
          const next = box.body();
          if (!next) { toast('Use the ✕ next to your note to delete it.', 'error'); return; }
          if (next === current) return reload();
          return savePrivate(next);
        };
        privateLi.querySelector('[data-act="save"]').addEventListener('click', () => save());
        privateLi.querySelector('[data-act="cancel"]').addEventListener('click', reload);
      });
      privateLi.querySelector('[data-act="erase"]').addEventListener('click', async () => {
        if (!(await appConfirm('Delete your private note for this dog?', { title: 'Delete note', confirmText: 'Delete', danger: true }))) return;
        try { await api(`/api/dogs/${dog.id}/private-note`, { method: 'PUT', body: JSON.stringify({ body: '' }) }); toast('Note deleted'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    }
  }

  function showProfileSheet(dog, walks) {
    profileSheetInner.innerHTML = renderDogProfile(dog, walks);
    openSheet(profileSheet, 'profile');
    const closeBtn = document.getElementById('closeProfileBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => closeSheet(profileSheet));
    const statsBtn = document.getElementById('profileStatsBtn');
    if (statsBtn) statsBtn.addEventListener('click', () => showDogStatsPopup(dog.id, dog.name, dog.species));
    const editBtn = document.getElementById('profileEditBtn');
    if (editBtn) {
      editBtn.addEventListener('click', async () => {
        if (!(await closeSheetAwait(profileSheet))) return;
        // Opened from this dog's own Walk/Edit screen: just go back to it,
        // keeping any markers already toggled there.
        if (onConfirmScreenFor(dog.id)) return;
        goToConfirmForDog(dog.id);
      });
    }
    mountDogNotes(profileSheetInner.querySelector('.dog-notes-mount'), dog, walks);
  }

  function onConfirmScreenFor(dogId) {
    return state.tab === 'walk' && state.walk.phase === 'confirm' && state.walk.dog && String(state.walk.dog.id) === String(dogId);
  }

  // Every way into a dog's profile (tapping its photo or name on any screen)
  // ends with the same Edit button, so editing a dog is always one tap away.
  // Same label rules as the cards' own Start / Edit button.
  function profileEditButtonHtml(dog) {
    const activeId = activeWalkDogId();
    let label = dog.tooYoung || dog.eligible === false ? '✎ Edit' : '▶ Start / Edit';
    let disabled = '';
    if (activeId === String(dog.id)) label = `↩ Back to your ${activityInfo(state.walk.activity).noun}`;
    else if (activeId) label = '✎ Edit';
    else if (onConfirmScreenFor(dog.id)) label = '✎ Edit';
    return `<button type="button" id="profileEditBtn" class="btn primary" style="margin:6px 0 10px;"${disabled}>${label}</button>`;
  }

  // Personal history only: how often *this* user has walked the dog.
  function walksTogetherText(dog) {
    const n = dog.myWalkCount || 0;
    if (!n) return `You haven't spent time together yet`;
    return `You've spent time together ${n === 1 ? 'once' : `${n} times`} · last on ${fmtDate(dog.myLastWalkedAt)}`;
  }

  function renderDogProfile(dog, walks) {
    const tags = (dog.tags || []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(' ');
    const hasMarkers = markerBreakdownRows(dog).length > 0;
    return `
      <div class="sheet-close-bar"><button id="closeProfileBtn" class="sheet-close-btn" aria-label="Close">✕</button></div>
      ${dog.photoUrl ? `<img class="profile-photo photo-lightbox-trigger${/\/dog-silhouettes\//.test(dog.photoUrl) ? ' photo-fallback' : ''}" src="${esc(dog.photoUrl)}" alt="${esc(dog.name)}" data-dog-id="${dog.id}" data-species="${esc(dog.species || 'dog')}" />` : ''}
      <h2>${esc(dog.name)} ${sexIcon(dog.sex)} ${favButtonHtml(dog)}
        <span id="profileMarkerBadges" class="${hasMarkers ? 'marker-badges-toggle' : ''}">${markerBadges(dog)}</span>
      </h2>
      ${akaHtml(dog, 'profile-aka')}
      ${hasMarkers ? `<div id="profileMarkerBreakdown" class="marker-breakdown">${markerBreakdownHtml(dog)}</div>` : ''}
      <p class="nowrap dog-id" style="margin-top:-6px;">ID ${dog.id}</p>
      ${profileEditButtonHtml(dog)}
      ${currentWalkBadge(dog)}
      ${dog.stillListed === false ? `<span class="badge neutral">Adopted/Removed${dog.removedAt ? ' on ' + fmtDate(dog.removedAt) : ''}</span>` : ''}
      <span class="badge neutral">${walksTogetherText(dog)}</span>
      <p class="muted">${esc(dog.breed || 'Unknown breed')} · ${esc(dog.sex || '?')} · ${esc(fmtAge(dog.age) || '?')} · ${esc(dog.weight || '?')}</p>
      <p class="small">In shelter since ${fmtDate(dog.dateInShelter)} (${shelterDaysHtml(dog)}) · ${esc(dog.location || '')}</p>
      ${dog.stillListed === false ? '' : `<p class="small">${kennelWordOf(dog) === 'condo' ? 'Room' : 'Current kennel spot'}: <span class="nowrap">🏠 ${esc(dog.kennelLocation || 'Unknown')}</span></p>`}
      <div>${tags}</div>
      ${dog.summary ? `<div class="dog-summary">${sanitizeHtml(dog.summary)}</div>` : ''}
      <p class="small" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <a href="${esc(dog.adoptUrl)}" target="_blank" rel="noopener">View on pets.wake.gov →</a>
        ${dog.videoUrl ? `<a href="${esc(dog.videoUrl)}" target="_blank" rel="noopener noreferrer">▶ Watch on YouTube</a>` : ''}
        <button type="button" class="link-btn dog-qr-btn" data-dog-id="${dog.id}" data-dog-name="${esc(dog.name)}">▦ Show QR code</button>
      </p>
      <div class="row" style="margin-top:4px;">
        <button type="button" id="profileStatsBtn" class="btn small-btn">📊 Our ${termsOf(dog).nouns} together</button>
        <button type="button" class="btn small-btn walk-history-btn" data-dog-id="${dog.id}">🕘 ${capFirst(termsOf(dog).noun)} history</button>
      </div>
      ${showsPlaygroup(dog) ? `<div class="row" style="margin-top:6px;">${playgroupButtonHtml(dog)}</div>` : ''}
      <div class="dog-notes-mount">${dogNotesShellHtml()}</div>
      ${speciesOf(dog).stickers ? '<p class="small muted">Behavior stickers are set on the Scan screen when checking a dog out.</p>' : ''}
      ${(window.ShelterWalkModules.profileSections || []).map((fn) => { try { return fn(dog) || ''; } catch (err) { console.error('[modules] profile section failed:', err); return ''; } }).join('')}
    `;
  }

  // A dog's shared tips and your private note, opened from a past walk so
  // they can be updated while looking back, without leaving the walk list.
  async function showDogNotesPopup(dogId) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = `<h3 style="margin-top:0;">📝 Dog notes</h3><p class="muted small center loading-line" role="status">Loading…</p>`;
    openOverlay(popup);
    try {
      const { dog, walks } = await api(`/api/dogs/${dogId}?userId=${state.currentUser.id}`);
      content.innerHTML = `<h3 style="margin-top:0;">📝 ${esc(dog.name)}'s notes</h3><div class="dog-notes-mount">${dogNotesShellHtml()}</div>`;
      mountDogNotes(content.querySelector('.dog-notes-mount'), dog, walks);
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">📝 Dog notes</h3><p class="small muted">Couldn't load the notes: ${esc(err.message)}</p>`;
    }
  }

  // ---------- Playgroup notes ----------
  // Dated entries on how a dog does in playgroup (playgroupNotes.js). They
  // run a few sentences each, so they get their own roomy popup instead of a
  // spot on the profile: walkers who don't run playgroup only ever see one
  // button. Typing "@" in the editor tags another dog; it's saved as @[id],
  // shown as the dog's current name, and the note also lists under
  // "Mentioned in other dogs' notes" on the tagged dog.

  // On every dog (owner, 2026-11-06), not just the ones who can join.
  const showsPlaygroup = (dog) => speciesOf(dog).activities.includes('playgroup');
  const playgroupButtonLabel = (n, short) => `🥎 ${short ? 'Playgroup' : 'Playgroup notes'}${n ? ` (${n})` : ''}`;
  // The prominent action on the live walk screen while a playgroup session
  // is running: not "browse notes" but "write one for what's happening right
  // now" -- same editor (showPlaygroupNotes), defaulting to today's date.
  const playgroupSessionButtonLabel = (n) => `📝 Take notes for this session${n ? ` (${n} already)` : ''}`;
  function playgroupButtonHtml(dog) {
    if (!showsPlaygroup(dog)) return '';
    return `<button type="button" class="btn small-btn playgroup-notes-btn" data-dog-id="${dog.id}">${playgroupButtonLabel((dog.playgroupCounts || {}).notes)}</button>`;
  }

  // Dogs that can be tagged: every dog that can go to playgroup, including
  // ones currently in foster -- even once the shelter's own listing drops
  // them, volunteers still write playgroup notes about a foster dog (an
  // earlier session, a meet-up). `all=true` is the only way to see those;
  // a delisted dog that's NOT in foster (adopted, transferred) is left out.
  let pgDogsPromise = null;
  function playgroupDogList() {
    const canPlay = (d) => speciesOf(d).activities.includes('playgroup');
    if (!pgDogsPromise) {
      pgDogsPromise = api('/api/dogs?all=true&fields=names').then((d) => window.PgTags.taggableFrom(d.dogs, canPlay))
        .catch(() => { pgDogsPromise = null; return []; });
    }
    return pgDogsPromise;
  }

  // Tagging, tag display and the date row are shared with the desk page
  // (pg-tags.js).
  const { pickLabel: pgPickLabel, toEditable: pgToEditable, bodyHtml: pgBodyHtml, bodySnippet: pgBodySnippet, fmtDate: fmtPgDate, linkifyYouTube } = window.PgTags;

  // Backfilling a run of notes from the same day: a new note starts on the
  // date last picked (for an hour), not on today.
  let pgLastDate = null;
  const pgDefaultDate = () => (pgLastDate && Date.now() - pgLastDate.at < 3600000 ? pgLastDate.key : todayKey());

  function pgEditorHtml({ text = '', date = pgDefaultDate(), signed = false, showDate = true, showSign = true, placeholder = 'How did playgroup go? Type @ to tag another dog.' } = {}) {
    return `<div class="pg-editor">
      ${showDate ? window.PgTags.dateRowHtml(date) : ''}
      ${window.PgTags.mdToolbarHtml()}
      <div class="pg-text-wrap">
        <div class="pg-text" data-placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">${esc(text)}</div>
        <div class="pg-suggest hidden" role="listbox" aria-label="Dogs to tag"></div>
      </div>
      <div class="pg-preview"></div>
      <p class="small muted pg-hint">Type @ and a name to tag a dog, or just type their name and tap the highlighted suggestion. The note shows on their playgroup notes too. Use the buttons above for bold, italic or a list.</p>
      ${showSign ? `<label class="pg-sign"><input type="checkbox" class="pg-signed"${signed ? ' checked' : ''} /> Sign with my name <span class="small muted">(otherwise anonymous)</span></label>` : ''}
    </div>`;
  }

  // Wires the @ picker, auto-tag suggestions, date row and markdown
  // toolbar/preview of one pgEditorHtml. The box grows with its content on
  // its own now (it's a contenteditable div, not a textarea).
  function wirePgEditor(root, { picks = new Map(), ownId = null } = {}) {
    const ta = root.querySelector('.pg-text');
    const tags = window.PgTags.wireTagPicker(ta, root.querySelector('.pg-suggest'), { getDogs: playgroupDogList, picks, ownId });
    window.PgTags.wireAutoTagger(ta, { getDogs: playgroupDogList, ownId, picks });
    window.PgTags.wireDateRow(root);
    window.PgTags.wireMarkdownTools(root, ta);
    return {
      body: tags.body,
      date: () => (root.querySelector('.pg-date') || {}).value || '',
      signed: () => { const c = root.querySelector('.pg-signed'); return c ? c.checked : undefined; },
      focus: () => ta.focus()
    };
  }

  // Writing or editing a note takes the whole screen: the box sits at the top
  // and fills the space above the keyboard (visualViewport shrinks when the
  // keyboard opens), with Save and Cancel up top where it can't cover them.
  const pgEditorOverlay = document.getElementById('pgEditorOverlay');
  const pgEditorInner = document.getElementById('pgEditorInner');
  let pgEditorUnfit = null;
  function openPgEditor({ title, text = '', picks, ownId, date, signed = false, showSign = true, placeholder, emptyError, save }) {
    pgEditorInner.innerHTML = `
      <div class="pg-fs-bar">
        <button type="button" class="btn small-btn" data-act="cancel">Cancel</button>
        <span class="pg-fs-title">${esc(title)}</span>
        <button type="button" class="btn small-btn primary" data-act="save">Save</button>
      </div>
      ${pgEditorHtml({ text, date, signed, showSign, placeholder })}`;
    const editor = wirePgEditor(pgEditorInner, { picks, ownId });
    const fit = () => {
      const vv = window.visualViewport;
      pgEditorInner.style.height = `${vv ? vv.height : window.innerHeight}px`;
      pgEditorInner.style.transform = vv && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    };
    if (pgEditorUnfit) pgEditorUnfit();
    fit();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
      pgEditorUnfit = () => {
        window.visualViewport.removeEventListener('resize', fit);
        window.visualViewport.removeEventListener('scroll', fit);
        pgEditorUnfit = null;
      };
    }
    openOverlay(pgEditorOverlay);
    editor.focus();
    // Cancel (or Back) with unsaved text asks first, offering this same Save.
    const saveBtn = pgEditorInner.querySelector('[data-act="save"]');
    const doSave = async () => {
      const body = editor.body();
      if (!body) {
        if (emptyError) toast(emptyError, 'error');
        editor.focus();
        return false;
      }
      saveBtn.disabled = true;
      try {
        const v = { body, noteDate: editor.date() };
        if (v.noteDate && v.noteDate !== todayKey()) pgLastDate = { key: v.noteDate, at: Date.now() };
        else pgLastDate = null;
        const sig = editor.signed();
        if (sig !== undefined) v.signed = sig;
        await save(v);
        guard.forget();
        return true;
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false;
        return false;
      }
    };
    const guard = window.PgTags.guardNote(pgEditorInner.querySelector('.pg-text'), { body: editor.body, save: doSave });
    const close = async () => { if (await closeOverlayAwait(pgEditorOverlay) && pgEditorUnfit) pgEditorUnfit(); };
    pgEditorInner.querySelector('[data-act="cancel"]').addEventListener('click', close);
    saveBtn.addEventListener('click', async () => { if (await doSave()) await close(); });
  }

  const pgPopup = document.getElementById('playgroupPopup');
  const pgContent = document.getElementById('playgroupPopupContent');
  // Dogs passed through by tapping tags, for the back link.
  let pgTrail = [];
  async function showPlaygroupNotes(dogId, { keepTrail = false } = {}) {
    if (!keepTrail) pgTrail = [];
    pgContent.innerHTML = '<h3 style="margin-top:0;">🥎 Playgroup notes</h3><p class="muted small center loading-line" role="status">Loading…</p>';
    openOverlay(pgPopup);
    pgPopup.querySelector('.popup-card').scrollTop = 0;
    try {
      renderPlaygroupNotes(String(dogId), await api(`/api/dogs/${dogId}/playgroup-notes`));
    } catch (err) {
      pgContent.innerHTML = `<h3 style="margin-top:0;">🥎 Playgroup notes</h3><p class="small muted">Couldn't load the notes: ${esc(err.message)}</p>`;
    }
  }

  function renderPlaygroupNotes(dogId, data) {
    const dog = data.dogs[dogId] || { id: dogId, name: 'This dog' };
    const reload = () => showPlaygroupNotes(dogId, { keepTrail: true });
    const back = pgTrail[pgTrail.length - 1];
    // Collapsed to a short preview, with "Read more" swapping in the full,
    // already-rendered note (nothing re-fetched): every mention under another
    // dog's notes (a dog tagged often would otherwise turn this list into a
    // wall of other dogs' full entries), and every one of THIS dog's own
    // notes but the most recent -- notes run long, and on a phone a dog with
    // a real history shouldn't turn into endless scrolling just to add one.
    const entryBodyHtml = (n, collapse) => {
      if (!collapse) return `<div class="pg-entry-body">${pgBodyHtml(n.body, data.dogs)}</div>`;
      const snippet = pgBodySnippet(n.body, data.dogs);
      if (!snippet.truncated) return `<div class="pg-entry-body">${pgBodyHtml(n.body, data.dogs)}</div>`;
      return `<div class="pg-entry-body pg-entry-snippet">${esc(snippet.text)}</div>
        <div class="pg-entry-body pg-entry-full hidden">${pgBodyHtml(n.body, data.dogs)}</div>
        <button type="button" class="link-btn pg-expand">Read more</button>`;
    };
    const entryHtml = (n, fromDog, collapse) => `<li class="pg-entry" data-note="${n.id}">
        <div class="pg-entry-head">
          ${!fromDog && n.canEdit
    ? `<label class="pg-entry-date pg-entry-date-edit" title="Change the date">${fmtPgDate(n.noteDate)} <span aria-hidden="true">📅</span><input type="date" class="pg-redate" value="${n.noteDate}" max="${todayKey()}" aria-label="Change this note's date" /></label>`
    : `<span class="pg-entry-date">${fmtPgDate(n.noteDate)}</span>`}
          ${fromDog ? `<span class="small muted">in <button type="button" class="pg-tag" data-pg-dog="${fromDog.id}">${esc(fromDog.name)}</button>'s notes</span>` : ''}
          ${!fromDog && n.canEdit ? `<span class="tip-item-actions">
            <button type="button" class="mini-icon-btn" data-act="edit" aria-label="Edit this note">✎</button>
            <button type="button" class="mini-icon-btn" data-act="erase" aria-label="Delete this note">✕</button>
          </span>` : ''}
        </div>
        ${entryBodyHtml(n, collapse)}
        ${n.author ? `<div class="pg-entry-author">${esc(n.author)}</div>` : ''}
      </li>`;
    pgContent.innerHTML = `
      ${back ? `<button type="button" class="link-btn pg-back">← Back to ${esc(back.name)}</button>` : ''}
      <div class="row" style="align-items:center;gap:8px;margin-top:0;">
        ${dog.photoUrl ? `<img loading="lazy" decoding="async" class="dog-photo small" src="${esc(thumbOf(dog.photoUrl))}" alt="" />` : ''}
        <h3 style="margin:0;">🥎 ${esc(dog.name)}'s playgroup notes</h3>
      </div>
      ${dog.stillListed === false ? '<p class="small muted" style="margin-top:-6px;">No longer listed at the shelter.</p>' : ''}
      <button type="button" class="btn primary pg-add-btn">＋ Add a note</button>
      ${data.notes.length ? `<ul class="pg-list">${data.notes.map((n, i) => entryHtml(n, null, i > 0)).join('')}</ul>`
        : '<p class="small muted">No playgroup notes yet. Paste in earlier notes or add one after playgroup.</p>'}
      <p class="small muted pg-desk-link">On a computer? <a href="/playgroup?dog=${dogId}" target="_blank" rel="noopener">Open the playgroup desk</a> to type up and export notes.</p>
      ${data.mentions.length ? `<h4 class="pg-section">Mentioned in other dogs' notes (${data.mentions.length})</h4>
        <ul class="pg-list">${data.mentions.map((n) => entryHtml(n, data.dogs[n.dogId] || { id: n.dogId, name: 'another dog' }, true)).join('')}</ul>` : ''}`;

    // Keep the button on the profile (and the live walk screen's own
    // "take notes" button, which keeps its session-specific wording) underneath in step.
    document.querySelectorAll(`.playgroup-notes-btn[data-dog-id="${dogId}"]`).forEach((b) => {
      b.textContent = 'session' in b.dataset ? playgroupSessionButtonLabel(data.notes.length) : playgroupButtonLabel(data.notes.length, 'short' in b.dataset);
    });

    if (back) {
      pgContent.querySelector('.pg-back').addEventListener('click', () => {
        pgTrail.pop();
        showPlaygroupNotes(back.id, { keepTrail: true });
      });
    }
    pgContent.querySelectorAll('[data-pg-dog]').forEach((t) => {
      t.addEventListener('click', () => {
        if (t.dataset.pgDog === dogId) return;
        pgTrail.push({ id: dogId, name: dog.name });
        showPlaygroupNotes(t.dataset.pgDog, { keepTrail: true });
      });
    });
    pgContent.querySelectorAll('.pg-expand').forEach((btn) => {
      btn.addEventListener('click', () => {
        const li = btn.closest('.pg-entry');
        const expanding = li.querySelector('.pg-entry-full').classList.toggle('hidden') === false;
        li.querySelector('.pg-entry-snippet').classList.toggle('hidden', expanding);
        btn.textContent = expanding ? 'Show less' : 'Read more';
      });
    });

    pgContent.querySelector('.pg-add-btn').addEventListener('click', () => openPgEditor({
      title: `${dog.name}: new note`,
      ownId: dogId,
      placeholder: `How did ${dog.name} do? Type @ to tag a dog they played with.`,
      save: async (v) => {
        await api(`/api/dogs/${dogId}/playgroup-notes`, { method: 'POST', body: JSON.stringify(v) });
        toast('Playgroup note saved');
        reload();
      }
    }));

    pgContent.querySelectorAll('.pg-list .pg-entry').forEach((li) => {
      const n = data.notes.find((x) => String(x.id) === li.dataset.note);
      if (!n) return; // a mention: read-only here, edited on its own dog
      const editBtn = li.querySelector('[data-act="edit"]');
      if (!editBtn) return;
      // Changing just the date: pick one and it's saved.
      li.querySelector('.pg-redate').addEventListener('click', (e) => { try { e.target.showPicker(); } catch (err) { /* the browser opens its own */ } });
      li.querySelector('.pg-redate').addEventListener('change', async (e) => {
        const noteDate = e.target.value;
        if (!noteDate || noteDate === n.noteDate) return;
        try {
          await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'PUT', body: JSON.stringify({ body: n.body, noteDate }) });
          toast(`Moved to ${fmtPgDate(noteDate)}`);
          reload();
        } catch (err) { toast(err.message, 'error'); e.target.value = n.noteDate; }
      });
      editBtn.addEventListener('click', () => {
        const { text, picks } = pgToEditable(n.body, data.dogs);
        openPgEditor({
          title: `${dog.name}: edit note`,
          // No "Sign with my name" once someone else has edited it (the
          // server refuses that, canSign false): it would only lead to a 409.
          text, picks, ownId: dogId, date: n.noteDate, signed: n.signed, showSign: n.mine && n.canSign !== false,
          emptyError: "A note can't be empty. Delete it instead.",
          save: async (v) => {
            await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'PUT', body: JSON.stringify(v) });
            toast('Note updated');
            reload();
          }
        });
      });
      li.querySelector('[data-act="erase"]').addEventListener('click', async () => {
        if (!(await appConfirm(`Delete this playgroup note from ${fmtPgDate(n.noteDate)}?`, { title: 'Delete note', confirmText: 'Delete', danger: true }))) return;
        try { await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'DELETE' }); toast('Note deleted'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.playgroup-notes-btn');
    if (btn) showPlaygroupNotes(btn.dataset.dogId);
  });
  document.getElementById('closePlaygroupPopupBtn').addEventListener('click', () => closeOverlay(pgPopup));
  pgPopup.addEventListener('click', (e) => { if (e.target === pgPopup) closeOverlay(pgPopup); });

  // Reuses the same generic info popup as the marker-meaning breakdown --
  // one modal, two different content builders.
  async function showDogStatsPopup(dogId, dogName, species) {
    const t = termsOf({ species });
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = `<h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3><p class="muted small center loading-line" role="status">Loading…</p>`;
    openOverlay(popup);
    try {
      const stats = await api(`/api/dogs/${dogId}/walk-stats?userId=${state.currentUser.id}`);
      const mine = stats.mine;
      const everyone = stats.everyone;
      const happyLine = mine.count > 0
        ? `<p class="small">You've spent <strong>${fmtDuration(mine.totalSeconds)}</strong> making ${esc(dogName)}'s day better! 🐾</p>`
        : `<p class="small muted">You and ${esc(dogName)} haven't spent time together in Shelter Walk yet.</p>`;
      content.innerHTML = `
        <h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3>
        <div class="stat-grid">
          ${mine.count ? `
          <div class="stat-tile stats-drilldown-tile" id="dogStatsVisitsTile" role="button" tabindex="0" style="cursor:pointer;"><div class="value">${mine.count}</div><div class="label">${capFirst(statWords([species || 'dog']).nounsWord)} together ›</div></div>
          <div class="stat-tile stats-drilldown-tile" id="dogStatsTimeTile" role="button" tabindex="0" style="cursor:pointer;"><div class="value">${fmtDuration(mine.totalSeconds)}</div><div class="label">Time together ›</div></div>`
    : `
          <div class="stat-tile"><div class="value">${mine.count}</div><div class="label">${capFirst(statWords([species || 'dog']).nounsWord)} together</div></div>
          <div class="stat-tile"><div class="value">${fmtDuration(mine.totalSeconds)}</div><div class="label">Time together</div></div>`}
        </div>
        ${mine.count ? `
        <p class="small">First together ${fmtDate(mine.firstWalkedAt)} · most recently ${fmtDate(mine.lastWalkedAt)}</p>
        <p class="small">Longest ${statWords([species || 'dog']).noun} together: ${fmtDuration(mine.longestSeconds)}</p>` : ''}
        ${happyLine}
        <hr />
        <p class="small muted">${capFirst(t.nouns)} logged in Shelter Walk by everyone: ${everyone.count} (${fmtDuration(everyone.totalSeconds)} total). ${esc(dogName)} also gets ${t.nouns} from people who don't use the app, so the real number is likely higher.</p>
      `;
      if (mine.count) {
        const openDrilldown = () => showDogStatsDrilldown(dogId, dogName, species);
        document.getElementById('dogStatsVisitsTile').addEventListener('click', openDrilldown);
        document.getElementById('dogStatsTimeTile').addEventListener('click', openDrilldown);
      }
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3><p class="small muted">Couldn't load stats: ${esc(err.message)}</p>`;
    }
  }

  // Drill-down behind "{N} together"/"Time together": every one of YOUR
  // visits with this dog, in order, as a duration bar chart (plus a by-
  // activity breakdown if more than one kind shows up) -- the same general-
  // number-then-detail pattern as the Stats tab, scaled to a popup.
  async function showDogStatsDrilldown(dogId, dogName, species) {
    const t = termsOf({ species });
    const content = document.getElementById('markerInfoPopupContent');
    if (!content) return;
    const backBtnHtml = `<button type="button" id="backToDogStatsBtn" class="btn back-btn">← Back</button>`;
    content.innerHTML = `${backBtnHtml}<h3 style="margin-top:0;">🐾 Your ${esc(statWords([species || 'dog']).nounsWord)} with ${esc(dogName)}</h3><p class="muted small center loading-line" role="status">Loading…</p>`;
    try {
      const history = await api(`/api/dogs/${dogId}/walk-history`);
      const mine = history.walks.filter((w) => w.mine)
        .map((w) => ({ activity: w.activity, duration_seconds: w.durationSeconds, started_at: w.startedAt, ended_at: w.endedAt || (w.durationSeconds != null ? w.startedAt : null), species }))
        .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
      // Same rule as every other average (avgPick): walks of a minute or
      // more when there are any, and the bars are exactly those rows.
      const pick = avgPick(mine);
      const avgSeconds = walkOnlyAvgSeconds(mine);
      const byActivity = byActivityOf(mine);
      const activityRows = byActivity.length > 1 ? `<div class="stack tight" style="margin-bottom:8px;">${byActivity.map((a) => {
        const info = activityInfo(a.activity);
        return `<div class="card compact"><div class="dog-info"><p class="dog-name">${info.emoji} ${info.label}</p><p class="dog-meta">${activityCount(info, a.count)} · ${fmtDuration(a.totalSeconds)} total</p></div></div>`;
      }).join('')}</div>` : '';
      const items = pick.rows.map((w) => ({ label: activityInfo(w.activity).label, seconds: w.duration_seconds || 0, sub: fmtDate(w.started_at) }));
      const sw = statWords([species || 'dog']);
      content.innerHTML = `
        ${backBtnHtml}
        <h3 style="margin-top:0;">🐾 Your ${esc(statWords([species || 'dog']).nounsWord)} with ${esc(dogName)}</h3>
        <p class="small muted" style="margin-top:-6px;">${plural(mine.length, sw.noun, sw.nounsWord)} · ${avgLabelFor(mine).replace('Average', 'avg')} ${fmtDuration(avgSeconds)}${skippedNote(pick.skipped)}, oldest to newest</p>
        ${activityRows}
        <div class="card compact">${durationBarChartHtml(items, avgSeconds)}</div>
      `;
      wireBarChart(content);
    } catch (err) {
      content.innerHTML = `${backBtnHtml}<h3 style="margin-top:0;">🐾 Your ${esc(statWords([species || 'dog']).nounsWord)} with ${esc(dogName)}</h3><p class="small muted">Couldn't load: ${esc(err.message)}</p>`;
    }
    document.getElementById('backToDogStatsBtn').addEventListener('click', () => showDogStatsPopup(dogId, dogName, species));
  }

  const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
  // The stay counts from the shelter's intake date, which can be before the
  // dog first showed on the floor (the timeline's dates): say which.
  const stayText = (dog) => `${dayWord(dog.daysInShelter)} in the shelter this stay${dog.dateInShelter ? `, since ${fmtShortDate(dog.dateInShelter)}` : ''}`;
  const dayKey = (iso) => dateKey(iso);
  // Lays out a most-recent-first list of {occurredAt, label} items as a
  // vertical timeline: same-day items grouped under one date, with the gap
  // between days labeled "↑ N days" since the list reads newest (top) to
  // oldest (bottom) -- "up" is toward the present. Shared by the stay-log
  // timeline and the marker-history popup.
  function timelineHtml(items) {
    const days = [];
    for (const item of items) {
      const key = dayKey(item.occurredAt);
      const current = days[days.length - 1];
      if (current && current.key === key) current.items.push(item);
      else days.push({ key, occurredAt: item.occurredAt, items: [item] });
    }
    const rows = days.map((day, i) => {
      const events = day.items.map((item) => `<li class="tip-item timeline-event"><span class="tip-bullet">•</span><span class="tip-text">${item.label}</span></li>`).join('');
      const dayHtml = `<li class="timeline-day"><div class="timeline-day-date">${fmtDate(day.occurredAt)}</div><ul class="tip-list timeline-day-events">${events}</ul></li>`;
      const older = days[i + 1];
      if (!older) return dayHtml;
      const gap = Math.max(1, Math.round((new Date(day.occurredAt) - new Date(older.occurredAt)) / 86400000));
      // The list is newest first (top) to oldest (bottom), so the gap
      // marker between two days points up -- from the older day below
      // to the newer one above it, old to new, not new to old.
      return dayHtml + `<li class="timeline-gap">↑ ${dayWord(gap)}</li>`;
    }).join('');
    return `<ul class="stay-timeline">${rows}</ul>`;
  }

  // The "log" icon's popup: every tracked status change for this dog --
  // arrived, pending adoption (and ones that fell through), adopted,
  // returned, taken off the floor -- most recent first, with the gap
  // between each one so a long gap or a fast turnaround both read clearly
  // (see the server route for why it's capped to the last several months).
  function timelineEventLabel(e) {
    switch (e.kind) {
      case 'new_dog': return '🟢 Arrived on the adoption floor';
      case 'returned': return e.detail === 'adopted_return' ? '↩️ Returned to the shelter after being adopted' : '↩️ Back on the adoption floor';
      case 'adopted': return '🏠 Adopted';
      case 'removed': return '⬇️ Taken off the floor';
      case 'pending_adoption': return '⏳ Adoption went pending';
      case 'pending_canceled': return '↪️ Pending adoption fell through';
      case 'sticker_on': return `${stickerIconByKey(e.detail) || '🏷️'} ${esc(e.title || e.detail)} turned on`;
      case 'sticker_off': return `${stickerIconByKey(e.detail) || '🏷️'} ${esc(e.title || e.detail)} turned off`;
      case 'sticker_auto_off': return `${stickerIconByKey(e.detail) || '🏷️'} ${esc(e.title || e.detail)} turned off automatically (left stray hold)`;
      default: return esc(e.title || e.kind);
    }
  }
  async function showStayLogPopup(dogId, dogName) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    const title = `📜 ${esc(dogName)}'s timeline`;
    content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="muted small center loading-line" role="status">Loading…</p>`;
    openOverlay(popup);
    let showStickers = false;
    try {
      const [{ dog }, history] = await Promise.all([
        api(`/api/dogs/${dogId}?userId=${state.currentUser.id}`),
        api(`/api/dogs/${dogId}/stay-history`)
      ]);
      const render = () => {
        const sourceEvents = showStickers ? [...history.events, ...history.stickerEvents] : history.events;
        const todayKey = dayKey(new Date().toISOString());
        const establishedToday = (kinds) => sourceEvents.some((e) => kinds.includes(e.kind) && dayKey(e.occurredAt) === todayKey);
        const items = [];
        // Pending implies still on the floor, so this shows one current-
        // status line rather than both -- two "right now" lines, in most-
        // recent-first order, could read as the dog having gone from
        // pending back to just-on-the-floor, i.e. the adoption falling
        // through, when it hasn't. Each line is also skipped when today's
        // actual history already states that status (e.g. a same-day
        // "Adoption went pending" event below), so it isn't said twice.
        // The live pending line still exists for the case where a dog is
        // pending the very first time the scraper ever sees them (the
        // shelter marks them pending at listing time, not after), so
        // there's no earlier non-pending state to transition from and a
        // 'pending_adoption' event never gets logged for them at all.
        if (dog.isPendingAdoption) {
          if (!establishedToday(['pending_adoption'])) {
            items.push({ occurredAt: new Date().toISOString(), label: `⏳ Currently pending adoption (${stayText(dog)})` });
          }
        } else if (dog.stillListed && !establishedToday(['new_dog', 'returned'])) {
          items.push({ occurredAt: new Date().toISOString(), label: `📍 On the floor now (${stayText(dog)})` });
        }
        items.push(...sourceEvents.slice().sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).reverse()
          .map((e) => ({ occurredAt: e.occurredAt, label: timelineEventLabel(e) })));
        content.innerHTML = `
          <h3 style="margin-top:0;">${title}</h3>
          <p class="small muted">Most recent first, with the time between each one.</p>
          <label class="small" style="display:flex;align-items:center;gap:6px;margin:-4px 0 10px;">
            <input type="checkbox" id="stayLogStickersToggle" ${showStickers ? 'checked' : ''}>
            Show sticker changes (star, blue, POO, PB)
          </label>
          ${timelineHtml(items)}
          <p class="small muted">Showing the last ${history.months} months.</p>
        `;
        document.getElementById('stayLogStickersToggle').addEventListener('change', (e) => {
          showStickers = e.target.checked;
          render();
        });
      };
      render();
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="small muted">Couldn't load ${esc(dogName)}'s timeline: ${esc(err.message)}</p>`;
    }
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.stay-log-btn');
    if (!trigger) return;
    e.stopPropagation();
    showStayLogPopup(trigger.dataset.dogId, trigger.dataset.dogName);
  });

  // ---------- Guide (wiki) ----------
  // Staff-editable reference sections (sticker meanings, tips, how-tos).
  // Reached from Settings and from the marker-meaning popup rather than a
  // bottom tab, so it never crowds the main navigation. Everyone can read;
  // staff / privileged walkers get add, edit, reorder, delete, image upload.
  state.guide = { sections: [], canEdit: false, sectionId: null, editing: null, query: '', hint: null };

  function openGuide(hint) {
    if (state.tab === 'walk' || state.tab === 'audit') stopQrScanner();
    state.guide.sectionId = null;
    state.guide.editing = null;
    state.guide.query = '';
    state.guide.hint = hint || null;
    // Already in the Guide (e.g. a link to another section): don't stack it.
    const alreadyInGuide = state.tab === 'guide';
    state.tab = 'guide';
    tabButtons.forEach((b) => b.classList.remove('active'));
    topbarTitle.textContent = TAB_TITLES.guide;
    if (alreadyInGuide) history.replaceState({ ...(history.state || {}), tab: 'guide', guideSection: null }, '');
    else pushHistory();
    render();
  }

  function safeUrl(url, allowContact) {
    // A site path, but never "//host" or "/\host": browsers read both as a
    // link to another site.
    if (/^\/(?![/\\])/.test(url) || /^https?:\/\//i.test(url)) return true;
    return !!allowContact && /^(mailto:|tel:)/i.test(url);
  }

  // Lightweight markdown, escaped FIRST so nothing typed into a section can
  // ever become live HTML. Supports: # / ## / ### headings, paragraphs,
  // - bullets, 1. numbered lists, > callouts, --- rules, **bold**, *italic*,
  // [links](url), and ![images](url). A bullet that starts with an image
  // becomes an image-plus-text row (used for the sticker list).
  function renderMarkdown(src) {
    // Images and links are swapped for placeholders as they're found, so no
    // later step (a link, bold/italic) ever runs over markup already made --
    // a link written inside an image's address or alt text can't break out
    // of the attribute. Attribute values are escaped once more on the way in
    // (the text is already escaped, so that only matters for a stray quote).
    const attr = (v) => String(v).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const emphasis = (t) => t
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    const inline = (text) => {
      const held = [];
      const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
      let t = esc(String(text).replace(/\u0000/g, ''));
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
        (safeUrl(url) ? hold(`<img class="guide-img photo-lightbox-trigger" src="${attr(url)}" alt="${attr(alt)}" loading="lazy" />`) : m));
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
        (safeUrl(url, true) ? hold(`<a href="${attr(url)}" target="_blank" rel="noopener">${emphasis(label)}</a>`) : m));
      t = emphasis(t);
      // A link's label can itself hold an image, so this runs to the bottom.
      const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (m, i) => restore(held[Number(i)]));
      return restore(t);
    };
    const listItem = (text) => {
      const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$/.exec(text);
      if (img && safeUrl(img[2])) {
        return `<li class="with-image"><img class="guide-thumb photo-lightbox-trigger" src="${esc(img[2])}" alt="${esc(img[1])}" loading="lazy" /><div>${inline(img[3])}</div></li>`;
      }
      return `<li>${inline(text)}</li>`;
    };
    let html = '';
    let listType = null;
    let para = [];
    const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    String(src || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); closeList(); return; }
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flushPara(); closeList();
        const level = m[1].length + 1; // # -> h2, ## -> h3, ### -> h4 (the page title is the h1)
        html += `<h${level}>${inline(m[2])}</h${level}>`;
      } else if (/^-{3,}$/.test(line.trim())) {
        flushPara(); closeList(); html += '<hr />';
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`;
      } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
        flushPara();
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += listItem(m[1]);
      } else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += listItem(m[1]);
      } else {
        closeList();
        para.push(line);
      }
    });
    flushPara(); closeList();
    return html;
  }

  function plainSnippet(md, maxLen) {
    // Callout lines ("> Demo content...") are notes about the section, not
    // its substance -- skip them so cards preview the real text.
    const body = String(md || '');
    const withoutCallouts = body.split('\n').filter((l) => !/^>/.test(l)).join('\n');
    const text = (withoutCallouts.trim() ? withoutCallouts : body)
      // A heading runs straight into the text under it once newlines go,
      // ("Who to ask Volunteering, shifts..."), so it gets a colon.
      .replace(/^#+\s*(.+?)\s*:?\s*$/gm, '$1:')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[#>\-*\d.)\s]+/gm, '')
      .replace(/\*\*?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text;
  }

  async function renderGuide() {
    const g = state.guide;
    if (g.editing) return renderGuideEditor();
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    const myTab = state.tab;
    try {
      const data = await api('/api/wiki');
      if (state.tab !== myTab) return;
      g.sections = data.sections;
      g.canEdit = data.canEdit;
    } catch (err) {
      if (state.tab === myTab) showLoadError('the Guide', err, renderGuide);
      return;
    }
    if (g.hint) {
      const hit = g.sections.find((sec) => new RegExp(g.hint, 'i').test(sec.title));
      if (hit) g.sectionId = hit.id;
      g.hint = null;
    }
    const section = g.sections.find((sec) => sec.id === g.sectionId);
    if (section) return renderGuideSection(section);
    g.sectionId = null;
    renderGuideList();
  }

  function guideBackButton(label, id) {
    return `<button type="button" id="${id}" class="btn back-btn">← ${esc(label)}</button>`;
  }

  function renderGuideList() {
    const g = state.guide;
    appEl.innerHTML = `
      <div class="stack">
        ${guideBackButton('Back', 'guideExit')}
        <input type="search" id="guideSearch" aria-label="Search the Guide" placeholder="Search the Guide…" value="${esc(g.query)}" autocomplete="off" />
        ${g.canEdit ? `<button type="button" id="guideNew" class="btn primary">＋ New section</button>` : ''}
        <a href="/tutorial.html" class="card compact guide-card guide-tutorial-link">
          <span class="guide-card-icon" aria-hidden="true">📘</span>
          <span class="guide-card-text">
            <strong>How to use Shelter Walk</strong>
            <span class="small muted">Step-by-step with screenshots, starting with how to scan a kennel card.</span>
          </span>
          <span class="muted" aria-hidden="true">›</span>
        </a>
        <div id="guideList" class="stack tight"></div>
        ${g.canEdit ? `<p class="small muted center">You can edit the Guide because you're staff. Open any section to edit, reorder, or delete it.</p>` : ''}
      </div>`;
    const drawList = () => {
      const q = g.query.trim().toLowerCase();
      const items = g.sections.filter((sec) => !q || sec.title.toLowerCase().includes(q) || sec.body.toLowerCase().includes(q));
      document.getElementById('guideList').innerHTML = items.length
        ? items.map((sec) => `
          <button type="button" class="card compact guide-card" data-id="${sec.id}">
            <span class="guide-card-icon" aria-hidden="true">${esc(sec.icon || '📄')}</span>
            <span class="guide-card-text">
              <strong>${esc(sec.title)}</strong>
              <span class="small muted">${esc(plainSnippet(sec.body, 90))}</span>
            </span>
            <span class="muted" aria-hidden="true">›</span>
          </button>`).join('')
        : `<p class="empty-state">${g.sections.length ? 'Nothing matches that search.' : 'No sections yet.'}</p>`;
      document.querySelectorAll('.guide-card').forEach((card) => {
        // A section is a history step of its own: the phone's Back returns
        // to the list, not out of the Guide (audit 3).
        card.addEventListener('click', () => { g.sectionId = Number(card.dataset.id); pushHistory({ guideSection: g.sectionId }); appEl.scrollTop = 0; renderGuide(); });
      });
    };
    drawList();
    document.getElementById('guideExit').addEventListener('click', () => history.back());
    document.getElementById('guideSearch').addEventListener('input', (e) => { g.query = e.target.value; drawList(); });
    const newBtn = document.getElementById('guideNew');
    if (newBtn) newBtn.addEventListener('click', () => { g.editing = { id: null, icon: '', title: '', body: '' }; renderGuide(); });
  }

  function renderGuideSection(section) {
    const g = state.guide;
    const idx = g.sections.findIndex((sec) => sec.id === section.id);
    appEl.innerHTML = `
      <div class="stack">
        ${guideBackButton('All sections', 'guideAll')}
        <article class="card guide-article">
          <h2>${esc(section.icon || '')} ${esc(section.title)}</h2>
          <div class="guide-body">${renderMarkdown(section.body)}</div>
          <p class="small muted" style="margin-bottom:0;">Updated ${fmtDate(section.updatedAt)}${section.updatedBy && !['demo', 'app update'].includes(section.updatedBy) ? ` by ${esc(section.updatedBy)}` : ''}</p>
        </article>
        ${g.canEdit ? `
        <div class="card compact stack tight">
          <label class="small muted">Staff tools</label>
          <div class="row">
            <button type="button" id="guideEdit" class="btn primary">Edit</button>
            <button type="button" id="guideUp" class="btn" ${idx <= 0 ? 'disabled' : ''} aria-label="Move up">↑ Up</button>
            <button type="button" id="guideDown" class="btn" ${idx >= g.sections.length - 1 ? 'disabled' : ''} aria-label="Move down">↓ Down</button>
          </div>
          <button type="button" id="guideDelete" class="btn danger">Delete section</button>
        </div>` : ''}
      </div>`;
    document.getElementById('guideAll').addEventListener('click', () => {
      // Opened from the list: step back through its history entry.
      if (history.state && history.state.guideSection === section.id) { history.back(); return; }
      g.sectionId = null; appEl.scrollTop = 0; renderGuide();
    });
    if (!g.canEdit) return;
    document.getElementById('guideEdit').addEventListener('click', () => {
      g.editing = { id: section.id, icon: section.icon || '', title: section.title, body: section.body };
      renderGuide();
    });
    const move = async (direction) => {
      try {
        await api(`/api/wiki/${section.id}/move`, { method: 'PUT', body: JSON.stringify({ direction }) });
        renderGuide();
      } catch (err) { toast(err.message, 'error'); }
    };
    document.getElementById('guideUp').addEventListener('click', () => move('up'));
    document.getElementById('guideDown').addEventListener('click', () => move('down'));
    document.getElementById('guideDelete').addEventListener('click', async () => {
      if (!(await appConfirm(`Delete "${section.title}"? This can't be undone.`, { title: 'Delete section', confirmText: 'Delete', danger: true }))) return;
      try {
        await api(`/api/wiki/${section.id}`, { method: 'DELETE' });
        g.sectionId = null;
        toast('Section deleted');
        renderGuide();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // Phone photos are huge; shrink before upload so it's quick on shelter
  // wifi and stays well under the server's size limit.
  function downscaleImage(file) {
    return new Promise((resolve) => {
      if (file.type === 'image/gif' || file.size < 300 * 1024) { resolve(file); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => resolve(blob && blob.size < file.size ? blob : file), 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function renderGuideEditor() {
    const g = state.guide;
    const draft = g.editing;
    const original = JSON.stringify(draft);
    appEl.innerHTML = `
      <div class="stack">
        <h2 class="section-heading" style="margin-top:0;">${draft.id ? 'Edit section' : 'New section'}</h2>
        <div class="card compact stack tight">
          <div class="row" style="gap:8px;align-items:flex-end;">
            <div style="flex:0 0 76px;">
              <label for="guideIcon" class="small muted">Icon</label>
              <input type="text" id="guideIcon" maxlength="32" placeholder="📄" value="${esc(draft.icon)}" style="text-align:center;" />
            </div>
            <div style="flex:1;">
              <label for="guideTitle" class="small muted">Title</label>
              <input type="text" id="guideTitle" maxlength="120" placeholder="e.g. Sticker meanings" value="${esc(draft.title)}" />
            </div>
          </div>
          <label for="guideBody" class="small muted" style="margin-top:6px;">Text</label>
          <div class="md-toolbar" role="toolbar" aria-label="Formatting">
            <button type="button" class="btn small-btn" data-md="bold" title="Bold"><strong>B</strong></button>
            <button type="button" class="btn small-btn" data-md="italic" title="Italic"><em>I</em></button>
            <button type="button" class="btn small-btn" data-md="heading" title="Heading">H</button>
            <button type="button" class="btn small-btn" data-md="bullet" title="Bulleted list">• List</button>
            <button type="button" class="btn small-btn" data-md="number" title="Numbered list">1. List</button>
            <button type="button" class="btn small-btn" data-md="callout" title="Callout box">Note</button>
            <button type="button" class="btn small-btn" data-md="link" title="Link">Link</button>
            <button type="button" class="btn small-btn" data-md="image" title="Add a picture">🖼 Picture</button>
            <input type="file" id="guideImageFile" accept="image/*" class="hidden" />
          </div>
          <textarea id="guideBody" rows="14" spellcheck="true">${esc(draft.body)}</textarea>
          <p class="small muted" style="margin:0;">Use the buttons above, or type: <code># Heading</code>, <code>- bullet</code>, <code>1. step</code>, <code>&gt; note</code>, <code>**bold**</code>, <code>[text](https://link)</code>. Start a bullet with a picture to make a picture-and-text row.</p>
          <div class="row">
            <button type="button" id="guidePreviewBtn" class="btn">Preview</button>
          </div>
          <div id="guidePreview" class="card guide-body hidden"></div>
        </div>
        <p id="guideEditStatus" class="small" style="color:var(--red);min-height:1.2em;margin:0;"></p>
        <div class="row">
          <button type="button" id="guideSave" class="btn primary">Save</button>
          <button type="button" id="guideCancel" class="btn">Cancel</button>
        </div>
      </div>`;
    const $ = (id) => document.getElementById(id);
    const body = $('guideBody');
    const current = () => ({ ...draft, icon: $('guideIcon').value.trim(), title: $('guideTitle').value.trim(), body: body.value });
    // Unsaved edits ask before a tab switch, Back out of the Guide or a
    // reload, like an unsaved note (audit 3): Discard or Keep editing.
    window.PgTags.guardNote(body, { body: () => JSON.stringify(current()) });

    const surround = (before, after, placeholder) => {
      const { selectionStart: a, selectionEnd: b, value } = body;
      const picked = value.slice(a, b) || placeholder;
      body.value = value.slice(0, a) + before + picked + after + value.slice(b);
      body.focus();
      body.setSelectionRange(a + before.length, a + before.length + picked.length);
    };
    const linePrefix = (prefix) => {
      const { selectionStart: a, value } = body;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      body.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
      body.focus();
      body.setSelectionRange(a + prefix.length, a + prefix.length);
    };
    const actions = {
      bold: () => surround('**', '**', 'bold text'),
      italic: () => surround('*', '*', 'italic text'),
      heading: () => linePrefix('## '),
      bullet: () => linePrefix('- '),
      number: () => linePrefix('1. '),
      callout: () => linePrefix('> '),
      link: () => surround('[', '](https://)', 'link text'),
      image: () => $('guideImageFile').click()
    };
    document.querySelectorAll('[data-md]').forEach((btn) => btn.addEventListener('click', () => actions[btn.dataset.md]()));

    $('guideImageFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      toast('Uploading picture…');
      try {
        const blob = await downscaleImage(file);
        // Same limit as the server (wiki.js MAX_IMAGE_BYTES), said up front.
        if (blob.size > 6 * 1024 * 1024) { toast('That picture is too large (max 6 MB).', 'error'); return; }
        const res = await fetch('/api/wiki/images', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(httpErrorMessage(res.status, out)), { fromApi: true });
        const md = `![description](${out.url})`;
        const { selectionStart: a, value } = body;
        body.value = value.slice(0, a) + (a && value[a - 1] !== '\n' ? '\n' : '') + md + '\n' + value.slice(a);
        toast('Picture added. Replace "description" with a short label.');
      } catch (err) { toast(friendlyError(err, 'add the picture'), 'error'); }
    });

    $('guidePreviewBtn').addEventListener('click', () => {
      const box = $('guidePreview');
      const showing = !box.classList.contains('hidden');
      box.classList.toggle('hidden', showing);
      $('guidePreviewBtn').textContent = showing ? 'Preview' : 'Hide preview';
      if (!showing) box.innerHTML = renderMarkdown(body.value) || '<p class="muted small">Nothing to preview yet.</p>';
    });

    $('guideCancel').addEventListener('click', async () => {
      if (JSON.stringify(current()) !== original &&
          !(await appConfirm('Discard your changes?', { title: 'Unsaved changes', confirmText: 'Discard', cancelText: 'Keep editing', danger: true }))) return;
      g.editing = null;
      renderGuide();
    });
    $('guideSave').addEventListener('click', async () => {
      const next = current();
      const statusEl = $('guideEditStatus');
      if (!next.title) { statusEl.textContent = 'Give the section a title.'; return; }
      const btn = $('guideSave');
      btn.disabled = true;
      statusEl.textContent = '';
      try {
        const payload = JSON.stringify({ title: next.title, icon: next.icon, body: next.body });
        let id = next.id;
        if (id) await api(`/api/wiki/${id}`, { method: 'PUT', body: payload });
        else id = (await api('/api/wiki', { method: 'POST', body: payload })).id;
        g.editing = null;
        g.sectionId = id;
        toast('Saved');
        renderGuide();
      } catch (err) {
        statusEl.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // ---------- Render dispatcher ----------
  async function render() {
    appEl.classList.remove('caution-stripes', 'age-block', 'pb-only-bg', 'evo-caution-bg');
    if (state.tab !== 'walk') lastWalkPhase = null; // back on Scan later: start at the top again
    if (state.tab === 'available') return renderAvailable();
    if (state.tab === 'walk') return renderWalk();
    if (state.tab === 'stats') return renderStats();
    if (state.tab === 'updates') return renderUpdates();
    if (state.tab === 'audit') return renderAudit();
    if (state.tab === 'guide') return renderGuide();
  }

  // ---------- Available tab ----------
  // Four fixed daily walk windows (constants.js WALK_SLOTS, via SHARED_CONFIG).
  // The last one is called 4-7 but counts anything started before the 7:15
  // stop time (to: 19.25); the label deliberately never says 7:15.
  const WALK_SLOTS = SHARED_CONFIG.slots;
  function slotIndexForIso(iso) {
    const p = shelterParts(iso);
    const hour = p.hh + p.mm / 60;
    return WALK_SLOTS.findIndex((s) => hour >= s.from && hour < s.to);
  }

  function currentShiftSlotIndex() {
    return slotIndexForIso(new Date().toISOString());
  }

  async function fetchTodaySlots() {
    // The shelter's day, midnight to midnight (23 or 25 hours on DST days).
    const startOfDay = shelterTimeToDate(todayKey());
    const endOfDay = shelterTimeToDate(addDaysToKey(todayKey(), 1));
    const map = new Map();
    const getEntry = (dogId) => {
      if (!map.has(dogId)) map.set(dogId, { slots: [false, false, false, false] });
      return map.get(dogId);
    };
    try {
      const data = await api(`/api/walks/for-day?fromUtc=${encodeURIComponent(startOfDay.toISOString())}&toUtc=${encodeURIComponent(endOfDay.toISOString())}&dateKey=${todayKey()}`);
      // The server sends only which window (slot) each dog was out in.
      for (const w of data.walks) {
        const entry = getEntry(w.dog_id);
        if (w.slotIndex >= 0 && w.slotIndex < entry.slots.length) entry.slots[w.slotIndex] = true;
      }
      // Manual checkoffs (walked but not scanned in) also fill a slot, so a
      // dog that was actually attended to never looks neglected.
      for (const c of data.manualCheckoffs || []) {
        const entry = getEntry(c.dog_id);
        if (c.slotIndex >= 0 && c.slotIndex < entry.slots.length) entry.slots[c.slotIndex] = true;
      }
    } catch (e) { /* grid just won't show anything filled */ }
    state.todaySlotsByDog = map;
  }

  function slotGridHtml(dogId, species) {
    const entry = (state.todaySlotsByDog || new Map()).get(dogId);
    const slots = entry ? entry.slots : [false, false, false, false];
    const boxes = slots.map((filled, i) => `<span class="slot-box ${filled ? 'filled' : ''}" title="${WALK_SLOTS[i].label}"></span>`).join('');
    return `<div class="slot-grid" title="${capFirst(termsOf({ species }).nouns)} logged in Shelter Walk today: ${WALK_SLOTS.map((s) => fmtSlotLabel(s.label)).join(' · ')}">${boxes}</div>`;
  }

  async function renderAvailable() {
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    const myTab = state.tab;
    try {
      const [data, , scrapeStatus] = await Promise.all([
        api(`/api/dogs?all=false&dateKey=${todayKey()}&userId=${state.currentUser.id}`),
        fetchTodaySlots(),
        api('/api/scrape/status').catch(() => null)
      ]);
      if (state.tab !== myTab) return; // navigated away while loading
      state.availableDogsRaw = data.dogs;
      state.availableExperienceLevel = data.experienceLevel;
      if (scrapeStatus && scrapeStatus.lastScrapeAt) state.lastScrapeAt = scrapeStatus.lastScrapeAt;
    } catch (err) {
      if (state.tab === myTab) showLoadError('the dog list', err, renderAvailable);
      return;
    }
    redrawAvailableList();
  }

  // Three-state filter chips: neutral -> only -> hide -> neutral.
  function filterChipClass(mode) {
    return mode === 'only' ? 'active' : mode === 'hide' ? 'excluding' : '';
  }
  // The blue "any" chip's state: 'only' when every letter but EVO is ✓,
  // 'hide' when every blue marker is ✕, otherwise off.
  function blueAnyFilterMode() {
    const letters = BLUE_MARKERS.filter((m) => m.value !== 'blue_evo');
    if (letters.length && letters.every((m) => state.markerFilters[m.value] === 'only')) return 'only';
    if (BLUE_MARKERS.length && BLUE_MARKERS.every((m) => state.markerFilters[m.value] === 'hide')) return 'hide';
    return null;
  }
  function cycleFilterMode(mode) {
    if (mode === 'only') return 'hide';
    if (mode === 'hide') return 'none';
    return 'only';
  }

  // Every filter in the panel becomes one condition a dog must pass: a ✓
  // criterion, a ✕ criterion, the kennel wing, age, days in the shelter.
  // The conditions AND together, or OR when state.filterMatch is 'any'.
  // Within one criterion the values still OR: blue letters need ANY ✓
  // letter (requiring every selected letter at once would almost never
  // match anything), and a ✕ on letters means having NONE of them.
  // skipKeys: filters left out this time (ones hidden because no animal in
  // the list could match them, e.g. stickers while showing only cats).
  function applyMarkerFilters(dogs, skipKeys = new Set()) {
    const filters = Object.fromEntries(Object.entries(state.markerFilters).filter(([k]) => !skipKeys.has(k)));
    const conditions = [];
    // One criterion whose values OR within each mode.
    const group = (tests) => {
      const keys = Object.keys(tests);
      const only = keys.filter((k) => filters[k] === 'only');
      const hide = keys.filter((k) => filters[k] === 'hide');
      if (only.length) conditions.push((d) => only.some((k) => tests[k](d)));
      if (hide.length) conditions.push((d) => !hide.some((k) => tests[k](d)));
    };
    const blueTests = {};
    BLUE_MARKERS.forEach((m) => { blueTests[m.value] = (d) => (d.blueMarkers || []).includes(m.value); });
    group(blueTests);
    // poo/poo_priority are two values of the same underlying field, not two
    // independent flags — ANDing them (the old behavior) could never match
    // anything once both were set to 'only'. OR them like the blue letters.
    group({ poo: (d) => d.pooStatus === 'poo', poo_priority: (d) => d.pooStatus === 'priority' });
    // Adopter filters. Male/female are two values of one field, so they OR
    // like the POO chips. Breeds OR within each mode like the blue letters,
    // and a breed also matches dogs with it in their shelter tags (mixes).
    group({ male: (d) => d.sex === 'Male', female: (d) => d.sex === 'Female' });
    const breedTests = {};
    Object.keys(filters).filter((k) => k.startsWith('breed:')).forEach((k) => { breedTests[k] = (d) => dogHasBreed(d, k.slice(6)); });
    group(breedTests);
    // Advanced: shelter tags (compatibility, heartworm, stray hold, video)
    // are each their own criterion; sizes OR within each mode.
    Object.keys(filters).filter((k) => k.startsWith('tag:')).forEach((k) => group({ [k]: (d) => (d.tags || []).includes(k.slice(4)) }));
    const sizeTests = {};
    SIZE_FILTERS.forEach((z) => { sizeTests[z.key] = (d) => z.test(weightLbs(d)); });
    group(sizeTests);
    const singleTests = {
      desexed: (d) => d.desexed === 'Yes',
      star: (d) => !!d.starFlag,
      pb: (d) => !!d.pbFlag,
      pendingAdoption: (d) => !!d.isPendingAdoption,
      young: (d) => !!d.isYoung,
      walkedByMe: (d) => !!d.walkedByMe,
      favorite: (d) => !!d.isFavorite,
      playgroup: playgroupEligible,
      walkable: (d) => d.eligible === true
    };
    Object.entries(singleTests).forEach(([key, test]) => group({ [key]: test }));
    if (state.minShelterDays != null) conditions.push((d) => (d.daysInShelter || 0) >= state.minShelterDays);
    if (state.ageMinYears != null || state.ageMaxYears != null) {
      // "Up to 3 years" includes 3 years and some months. Unknown ages drop out.
      const minMonths = state.ageMinYears != null ? state.ageMinYears * 12 : 0;
      const maxMonths = state.ageMaxYears != null ? (state.ageMaxYears + 1) * 12 : Infinity;
      conditions.push((d) => d.ageMonths != null && d.ageMonths >= minMonths && d.ageMonths < maxMonths);
    }
    if (state.locationFilter.size) {
      conditions.push((d) => d.kennelLocation && state.locationFilter.has(d.kennelLocation.trim()[0]?.toUpperCase()));
    }
    if (state.presetMinDaysAtLeast != null && !skipKeys.has('presetMinDays')) {
      const min = state.presetMinDaysAtLeast;
      conditions.push((d) => (d.effectiveDaysInShelter != null ? d.effectiveDaysInShelter : d.daysInShelter) >= min);
    }
    if (!conditions.length) return dogs;
    const any = state.filterMatch === 'any';
    return dogs.filter((d) => (any ? conditions.some((t) => t(d)) : conditions.every((t) => t(d))));
  }

  // PB-only dogs, dogs best without other dogs, and adopted dogs can't
  // join playgroup.
  function playgroupEligible(dog) {
    return !dog.pbFlag && !dog.isPendingAdoption && !(dog.tags || []).includes('Best in Home without Dogs');
  }

  function dogHasBreed(dog, breed) {
    return dog.breed === breed || (dog.tags || []).includes(breed);
  }
  // Every breed among the listed dogs (primary breed field), with how many
  // dogs match it (tags included), most common first.
  function breedCounts(dogs) {
    const names = [...new Set(dogs.map((d) => d.breed).filter(Boolean))];
    return names.map((name) => ({ name, count: dogs.filter((d) => dogHasBreed(d, name)).length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  // Advanced filters. Tags come straight from the shelter's listing;
  // dogOnly ones (and the sizes) are left out when looking at cats.
  const TAG_FILTERS = [
    { tag: 'Best in Home without Dogs', label: 'Best without dogs' },
    { tag: 'Dog Selective', label: 'Dog selective', dogOnly: true },
    { tag: 'No small dogs or little critters', label: 'No small dogs / critters', dogOnly: true },
    { tag: 'Best in Home without Cats', label: 'Best without cats' },
    { tag: 'Best in Home without Children', label: 'Best without children' },
    { tag: 'Not compatible with Livestock', label: 'Not good with livestock', dogOnly: true }
  ];
  const HEALTH_TAG_FILTERS = [
    { tag: 'Heartworm Positive', label: 'Heartworm positive', dogOnly: true },
    { tag: 'On Stray Hold', label: 'On stray hold (not adoptable yet)' },
    { tag: 'Video', label: '🎬 Has a video' }
  ];
  function weightLbs(dog) {
    const m = /([\d.]+)/.exec(dog.weight || '');
    return m ? Number(m[1]) : null;
  }
  const SIZE_FILTERS = [
    { key: 'size_small', label: 'Small (under 25 lbs)', test: (w) => w != null && w < 25 },
    { key: 'size_medium', label: 'Medium (25-49)', test: (w) => w != null && w >= 25 && w < 50 },
    { key: 'size_large', label: 'Large (50-79)', test: (w) => w != null && w >= 50 && w < 80 },
    { key: 'size_xl', label: 'Extra large (80+)', test: (w) => w != null && w >= 80 }
  ];
  const SHELTER_DAYS_OPTIONS = [7, 14, 30, 60, 90, 180];
  const AGE_MIN_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 10];
  const AGE_MAX_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10];

  // Redraws from already-fetched data — used for search/filter changes so
  // they don't need a network round-trip each time.
  // `hidden` sorts are kept but left out of the menu: they rank dogs by walks
  // logged in the app, which reads as "this dog needs a walk" when the dog
  // may well have been walked by someone not using the app. `lastWalked` used
  // to be one of these, but it's common enough (and useful enough as "who
  // hasn't been out today") that it's the default now, caveat and all.
  const AVAILABLE_SORTS = {
    shelterTime: { label: 'Days in shelter (most first)', cmp: (a, b) => (b.daysInShelter || 0) - (a.daysInShelter || 0) },
    // "Longest since a logged walk" (default): a dog/cat currently out counts
    // as "just walked" — current session time always sorts as most recent, to
    // the bottom either way. Nothing ever logged sorts as longest-since of
    // all (oldest-equivalent), tied with every other never-logged animal.
    // Ties of any kind (including "never") fall back to name, A-Z.
    lastWalked: {
      label: (terms) => `Longest since a logged ${terms.noun}`,
      cmp: (a, b) => {
        // Someone else's current walk has no start time (only your own
        // does), so any walk under way counts as "now".
        const lastOf = (d) => (d.currentWalk ? (d.currentWalk.startedAt || new Date().toISOString()) : d.lastWalkedAt);
        const aLast = lastOf(a);
        const bLast = lastOf(b);
        const aTime = aLast ? new Date(aLast).getTime() : -Infinity;
        const bTime = bLast ? new Date(bLast).getTime() : -Infinity;
        return aTime - bTime || a.name.localeCompare(b.name);
      }
    },
    alphabetical: { label: 'Name (A-Z)', cmp: (a, b) => a.name.localeCompare(b.name) },
    attention: {
      label: 'Fewest logged walks this week',
      hidden: true,
      cmp: (a, b) => (a.recentWalkCount || 0) - (b.recentWalkCount || 0) || (b.daysInShelter || 0) - (a.daysInShelter || 0)
    },
    location: {
      label: 'Location (A first)',
      // Dogs with no letter on file go last; within a wing, by name.
      cmp: (a, b) => (a.kennelLocation || '~').localeCompare(b.kennelLocation || '~') || a.name.localeCompare(b.name)
    }
  };

  // Built-in named filter combos, shown alongside a user's own saved
  // filters in the Presets tab. Built from BLUE_MARKERS dynamically so they
  // stay correct if markers are ever added/renamed.
  function allBlueFilterObject(mode) {
    const obj = {};
    BLUE_MARKERS.forEach((m) => { obj[m.value] = mode; });
    return obj;
  }
  // POO dogs go out first thing in the morning and last thing in the
  // evening; 11 to 4 is for the non-POO dogs.
  function nonPooHours() {
    const h = shelterHour();
    return h >= 11 && h < 16;
  }
  // Each preset is for one species (shown only while looking at it).
  const BUILT_IN_PRESETS = [
    {
      key: '__kittens',
      species: 'cat',
      name: 'Kittens',
      description: 'Kittens only. Visit one kitten condo a shift, and before any adult cats',
      filter: { markerFilters: { young: 'only' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__adult_cats',
      species: 'cat',
      name: 'Adult cats',
      description: 'No kittens: cuddle as many adult cats as you like',
      filter: { markerFilters: { young: 'hide' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__long_stay_cats',
      species: 'cat',
      name: 'Long-stay cats',
      description: 'In the shelter 30 days or more: they wait longest and need the company',
      filter: { markerFilters: {}, locationFilter: [], minDaysAtLeast: null, minShelterDays: 30 }
    },
    {
      key: '__beginner',
      species: 'dog',
      name: 'Beginner',
      description: 'For anyone with less than 20 hours',
      filter: {
        // Adopted (pending adoption) dogs aren't cleared for Beginners --
        // same rule as the server's allowPending.
        markerFilters: { ...allBlueFilterObject('hide'), pb: 'hide', pendingAdoption: 'hide' },
        locationFilter: [],
        minDaysAtLeast: 15
      }
    },
    {
      key: '__avoid_beginner',
      species: 'dog',
      name: 'Avoid beginner dogs',
      description: 'Targets dogs with behavior issues, so beginners aren’t drawn to them and easier dogs stay available',
      filter: {
        // Target (not exclude) blue-marker dogs, since those are exactly
        // the behavior-issue dogs an experienced volunteer should be
        // taking on -- except EVO, which stays excluded here the same as
        // everywhere else (it's a hard block, not something to route
        // people toward via a filter preset).
        markerFilters: {
          ...allBlueFilterObject('only'),
          blue_evo: 'hide'
        },
        locationFilter: [],
        minDaysAtLeast: null
      }
    },
    {
      key: '__walkable',
      species: 'dog',
      name: 'Eligible to walk',
      description: 'Only dogs cleared for your level right now',
      filter: { markerFilters: { walkable: 'only' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__poo',
      species: 'dog',
      name: 'POO dogs',
      description: 'For mornings and evenings (before 11 and after 4)',
      suggestedNow: () => !nonPooHours(),
      filter: { markerFilters: { poo: 'only', poo_priority: 'only' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__non_poo',
      species: 'dog',
      name: 'Non-POO dogs',
      description: 'For the middle of the day (11 to 4)',
      suggestedNow: () => nonPooHours(),
      filter: { markerFilters: { poo: 'hide', poo_priority: 'hide' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__playgroup',
      species: 'dog',
      name: 'Playgroup eligible',
      description: 'Hides dogs who are PB only, best without other dogs, or adopted',
      filter: { markerFilters: { playgroup: 'only' }, locationFilter: [], minDaysAtLeast: null }
    },
    {
      key: '__not_playgroup',
      species: 'dog',
      name: 'Not playgroup eligible',
      description: 'Only dogs who are PB only, best without other dogs, or adopted',
      filter: { markerFilters: { playgroup: 'hide' }, locationFilter: [], minDaysAtLeast: null }
    }
  ];

  // Applies a saved/built-in filter combo (as stored/exported — see
  // currentFilterObject()) to the live filter state and redraws.
  function applyFilterObject(filter) {
    state.markerFilters = { ...(filter.markerFilters || {}) };
    state.locationFilter = new Set(filter.locationFilter || []);
    state.presetMinDaysAtLeast = filter.minDaysAtLeast != null ? filter.minDaysAtLeast : null;
    state.ageMinYears = filter.ageMinYears != null ? filter.ageMinYears : null;
    state.ageMaxYears = filter.ageMaxYears != null ? filter.ageMaxYears : null;
    state.minShelterDays = filter.minShelterDays != null ? filter.minShelterDays : null;
    state.filterMatch = filter.matchAny ? 'any' : 'all';
    state.showMoreFilters = true;
    state.filtersTab = 'filters';
    redrawAvailableList();
  }

  function currentFilterObject() {
    return {
      markerFilters: { ...state.markerFilters },
      locationFilter: [...state.locationFilter],
      minDaysAtLeast: state.presetMinDaysAtLeast,
      ageMinYears: state.ageMinYears,
      ageMaxYears: state.ageMaxYears,
      minShelterDays: state.minShelterDays,
      matchAny: state.filterMatch === 'any'
    };
  }

  function clearAllFilters() {
    state.markerFilters = {};
    state.filterMatch = 'all';
    state.locationFilter = new Set();
    state.presetMinDaysAtLeast = null;
    state.ageMinYears = null;
    state.ageMaxYears = null;
    state.minShelterDays = null;
    state.needsShiftWalkOnly = false;
    state.showFoster = false;
    redrawAvailableList();
  }

  async function loadSavedFilters() {
    try {
      const { filters } = await api(`/api/users/${state.currentUser.id}/saved-filters`);
      state.savedFilters = filters;
    } catch (err) { /* leave whatever was cached */ }
  }

  function presetsTabHtml() {
    return `
      <div class="stack tight" style="margin-top:4px;">
        <label class="small muted">Built-in presets</label>
        ${BUILT_IN_PRESETS.filter((p) => viewSpeciesKeys().includes(p.species)).map((p) => `
          <div class="card compact" style="padding:8px;">
            <div class="row" style="justify-content:space-between;align-items:center;">
              <div>
                <strong class="small">${esc(p.name)}</strong>${p.suggestedNow && p.suggestedNow() ? ' <span class="badge eligible">Now</span>' : ''}
                <div class="small muted">${esc(p.description)}</div>
              </div>
              <button type="button" class="btn small-btn preset-apply-btn" data-preset-key="${p.key}">Apply</button>
            </div>
          </div>`).join('')}
        <label class="small muted" style="margin-top:10px;">Your saved filters</label>
        ${state.savedFilters.length ? state.savedFilters.map((f) => `
          <div class="card compact" style="padding:8px;">
            <div class="row" style="justify-content:space-between;align-items:center;">
              <strong class="small">${esc(f.name)}</strong>
              <div class="row" style="gap:4px;">
                <button type="button" class="btn small-btn saved-filter-apply-btn" data-filter-id="${f.id}">Apply</button>
                <button type="button" class="btn small-btn saved-filter-rename-btn" data-filter-id="${f.id}">Rename</button>
                <button type="button" class="btn small-btn saved-filter-delete-btn" data-filter-id="${f.id}">Delete</button>
              </div>
            </div>
          </div>`).join('') : `<p class="small muted">No saved filters yet.</p>`}
        <button type="button" id="saveCurrentFilterBtn" class="btn small-btn" style="margin-top:6px;">＋ Save current filter</button>
      </div>`;
  }

  function redrawAvailableList() {
    const allDogs = (state.availableDogsRaw || []).filter((d) => inSpeciesView(d));
    const viewKeys = viewSpeciesKeys();
    const noun = nounFor(viewKeys);
    const nouns = nounFor(viewKeys, true);
    // Filters that only mean something for some species (stickers, levels,
    // playgroup) show only when the list has one of those.
    const viewHasStickers = viewKeys.some((k) => speciesInfo(k).stickers);
    const viewHasLevels = viewKeys.some((k) => speciesInfo(k).levelRules);
    const viewHasPlaygroup = viewKeys.some((k) => speciesInfo(k).activities.includes('playgroup'));
    const viewHasDogs = viewKeys.includes('dog');
    const viewTerms = termsFor(viewKeys);
    const youngRule = viewKeys.map((k) => speciesInfo(k).youngFirst).find(Boolean) || null;
    const kennelLabel = viewKeys.length === 1 && speciesInfo(viewKeys[0]).kennelLabel || 'Kennel wing';
    if (!allDogs.length) {
      appEl.innerHTML = speciesSwitchHtml() + `<p class="empty-state">No ${nouns} currently listed. Try refreshing shelter data from Settings.</p>`;
      wireSpeciesSwitch(redrawAvailableList);
      restoreScroll(state.availableScrollTop);
      return;
    }
    // Hidden filters stay set (they come back with the Dogs view) but don't apply.
    const hiddenFilterKeys = new Set([
      ...(viewHasStickers ? [] : [...BLUE_MARKERS.map((m) => m.value), 'poo', 'poo_priority', 'star', 'pb']),
      ...(viewHasLevels ? [] : ['walkable']),
      ...(viewHasPlaygroup ? [] : ['playgroup']),
      // Beginner preset's day threshold is a level rule too.
      ...(viewHasLevels ? [] : ['presetMinDays']),
      ...(viewHasDogs ? [] : [...SIZE_FILTERS.map((z) => z.key), ...[...TAG_FILTERS, ...HEALTH_TAG_FILTERS].filter((t) => t.dogOnly).map((t) => `tag:${t.tag}`)]),
      ...(youngRule ? [] : ['young'])
    ]);
    const fosterCount = allDogs.filter((d) => d.location === 'In Foster').length;
    let visibleDogs = state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster');
    visibleDogs = applyMarkerFilters(visibleDogs, hiddenFilterKeys);
    if (state.needsShiftWalkOnly) {
      const idx = currentShiftSlotIndex();
      if (idx >= 0) {
        visibleDogs = visibleDogs.filter((d) => {
          const entry = state.todaySlotsByDog.get(d.id);
          return !entry || !entry.slots[idx];
        });
      }
    }
    const search = (state.availableSearch || '').trim().toLowerCase();
    if (search) visibleDogs = visibleDogs.filter((d) => dogNameMatches(d, search));
    // Each sort's cmp is written for its natural "primary" direction (e.g.
    // most-days-first, A-Z) — that's what 'desc' means here, the default;
    // 'asc' just reverses whichever sort is currently selected.
    const baseCmp = AVAILABLE_SORTS[state.availableSort || 'lastWalked'].cmp;
    const dirCmp = state.availableSortDir === 'asc' ? (a, b) => -baseCmp(a, b) : baseCmp;
    visibleDogs = [...visibleDogs].sort(dirCmp);

    // Blue letters share one "any" chip that cycles like every other chip:
    // tap once for only (every letter except EVO, which has its own
    // meaning), twice to hide every blue sticker (EVO included), again to
    // clear them all.
    const blueAnyMode = blueAnyFilterMode();
    const starChip = `<button type="button" class="marker-shape star filter-chip ${filterChipClass(state.markerFilters.star)}" data-filter-key="star" title="Good for beginners" aria-label="Good for beginners (star)">★</button>`;
    const blueChips = `
      <button type="button" class="marker-shape blue filter-chip ${filterChipClass(blueAnyMode)}" data-filter-action="blue-any" title="All blue markers: tap for only (except EVO), twice to hide all, again to clear" aria-label="All blue markers"></button>
      ${BLUE_MARKERS.map((m) => `<button type="button" class="marker-shape blue${m.rect ? ' rect' : ''} filter-chip ${filterChipClass(state.markerFilters[m.value])}" data-filter-key="${m.value}" title="${esc(m.name)}" aria-label="${esc(m.name)}">${esc(m.letter)}</button>`).join('')}`;
    const otherChips = `
      <button type="button" class="marker-shape poo filter-chip ${filterChipClass(state.markerFilters.poo)}" data-filter-key="poo" title="POO dog" aria-label="POO dog"></button>
      <button type="button" class="marker-shape poo-priority filter-chip ${filterChipClass(state.markerFilters.poo_priority)}" data-filter-key="poo_priority" title="High priority POO dog" aria-label="High priority POO dog">${ASTERISK_SVG}</button>
      <button type="button" class="marker-shape pb filter-chip ${filterChipClass(state.markerFilters.pb)}" data-filter-key="pb" title="PB: Potty break only">PB</button>
      <button type="button" class="marker-shape rect pending filter-chip ${filterChipClass(state.markerFilters.pendingAdoption)}" data-filter-key="pendingAdoption" title="Someone has started adopting this dog">Adopted</button>`;
    const textChip = (key, label, title) => `<button type="button" class="btn small-btn filter-chip ${filterChipClass(state.markerFilters[key])}" data-filter-key="${esc(key)}" title="${esc(title || label)}" style="width:auto;flex:0 0 auto;">${label}</button>`;
    const adopterChips = `
      ${textChip('male', '♂ Male')}
      ${textChip('female', '♀ Female')}
      ${textChip('desexed', 'Spayed / neutered', `Spayed or neutered (hide to see ${nouns} that are not, or unknown)`)}
      ${youngRule ? textChip('young', `🍼 ${youngRule.young.charAt(0).toUpperCase() + youngRule.young.slice(1)}s`, `${youngRule.young}s only (hide for ${youngRule.adult}s only)`) : ''}
      ${viewHasStickers ? '' : textChip('pendingAdoption', '💜 Being adopted', 'Someone has started adopting them (hide to see the rest)')}`;
    const ageSelect = (id, options, value, anyLabel, fmt, aria) => `
      <select id="${id}" class="small" style="flex:1;" aria-label="${aria}">
        <option value="">${anyLabel}</option>
        ${options.map((y) => `<option value="${y}" ${value === y ? 'selected' : ''}>${fmt(y)}</option>`).join('')}
      </select>`;
    const ageRow = `
      <div class="row" style="align-items:center;gap:6px;">
        <label class="small muted" style="flex:0 0 auto;margin:0;">Age:</label>
        ${ageSelect('ageMinSelect', AGE_MIN_OPTIONS, state.ageMinYears, 'Any', (y) => `${y}+ yr${y === 1 ? '' : 's'}`, 'Youngest age')}
        <span class="muted small" style="flex:0 0 auto;">to</span>
        ${ageSelect('ageMaxSelect', AGE_MAX_OPTIONS, state.ageMaxYears, 'Any', (y) => (y === 0 ? 'Under 1 yr' : `${y} yr${y === 1 ? '' : 's'}`), 'Oldest age')}
      </div>`;
    const breedChips = breedCounts(state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster'))
      .map((b) => textChip(`breed:${b.name}`, `${esc(b.name)} <span class="chip-count">${b.count}</span>`, b.name)).join('');
    const listedDogs = state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster');
    const tagChips = (list) => list.filter((t) => viewHasDogs || !t.dogOnly).map((t) => {
      const n = listedDogs.filter((d) => (d.tags || []).includes(t.tag)).length;
      return textChip(`tag:${t.tag}`, `${esc(t.label)} <span class="chip-count">${n}</span>`, t.tag);
    }).join('');
    const sizeChips = SIZE_FILTERS.map((z) => {
      const n = listedDogs.filter((d) => z.test(weightLbs(d))).length;
      return textChip(z.key, `${esc(z.label)} <span class="chip-count">${n}</span>`);
    }).join('');
    const advancedSectionHtml = () => `
        <details class="advanced-filters" data-section="advanced" ${advancedActive || state.openFilterSections.has('advanced') ? 'open' : ''}>
          <summary class="small muted">Advanced filters${advancedActive ? ` (${advancedActive} active)` : ''}</summary>
          <p class="small muted" style="margin:6px 0 2px;">Home compatibility (hide these to find ${nouns} without the restriction):</p>
          <div class="marker-row" style="gap:6px;">${tagChips(TAG_FILTERS)}</div>
          ${viewHasDogs ? `<p class="small muted" style="margin:8px 0 2px;">Size (by listed weight):</p>
          <div class="marker-row" style="gap:6px;">${sizeChips}</div>` : ''}
          <p class="small muted" style="margin:8px 0 2px;">Health and status:</p>
          <div class="marker-row" style="gap:6px;">${tagChips(HEALTH_TAG_FILTERS)}</div>
          <div class="row" style="align-items:center;gap:6px;margin-top:8px;">
            <label class="small muted" for="minShelterDaysSelect" style="flex:0 0 auto;margin:0;">In the shelter at least:</label>
            <select id="minShelterDaysSelect" class="small" style="flex:1;">
              <option value="">Any time</option>
              ${SHELTER_DAYS_OPTIONS.map((n) => `<option value="${n}" ${state.minShelterDays === n ? 'selected' : ''}>${n} days</option>`).join('')}
            </select>
          </div>
        </details>`;
    // Every letter any species in the list uses (cats' rooms are A-D).
    const viewKennels = [...new Set(viewKeys.flatMap((k) => speciesInfo(k).kennels || KENNEL_LETTERS))].sort();
    const locationChips = viewKennels.map((letter) => `
      <button type="button" class="btn small-btn filter-chip ${state.locationFilter.has(letter) ? 'active' : ''}" data-location-key="${letter}" style="width:auto;flex:0 0 auto;min-width:44px;">${letter}</button>`).join('');

    // Shown on the collapsed "Filters" toggle so it's obvious something is
    // narrowing the list even while the panel itself is tucked away. Blue
    // letters count as at most 1 "only" + 1 "hide" no matter how many are
    // selected (e.g. the blue-any bulk chip), since they're one conceptual
    // filter, not one per letter.
    const allBlueValues = BLUE_MARKERS.map((m) => m.value).filter((v) => !hiddenFilterKeys.has(v));
    const blueOnlyActive = allBlueValues.some((v) => state.markerFilters[v] === 'only') ? 1 : 0;
    const blueHideActive = allBlueValues.some((v) => state.markerFilters[v] === 'hide') ? 1 : 0;
    const otherFilterKeys = ['poo', 'poo_priority', 'star', 'pb', 'pendingAdoption', 'walkedByMe', 'favorite', 'playgroup', 'walkable', 'male', 'female', 'desexed', 'young']
      .filter((k) => !hiddenFilterKeys.has(k));
    const otherActiveCount = otherFilterKeys.filter((k) => state.markerFilters[k]).length;
    const breedModes = Object.keys(state.markerFilters).filter((k) => k.startsWith('breed:')).map((k) => state.markerFilters[k]);
    const breedActive = (breedModes.includes('only') ? 1 : 0) + (breedModes.includes('hide') ? 1 : 0);
    const ageActive = state.ageMinYears != null || state.ageMaxYears != null ? 1 : 0;
    const tagActive = Object.keys(state.markerFilters).filter((k) => k.startsWith('tag:') && !hiddenFilterKeys.has(k)).length;
    const sizeModes = viewHasDogs ? SIZE_FILTERS.map((z) => state.markerFilters[z.key]) : [];
    const sizeActive = (sizeModes.includes('only') ? 1 : 0) + (sizeModes.includes('hide') ? 1 : 0);
    const advancedActive = tagActive + sizeActive + (state.minShelterDays != null ? 1 : 0);
    const activeFilterCount = (state.showFoster ? 1 : 0) + (state.needsShiftWalkOnly ? 1 : 0)
      + blueOnlyActive + blueHideActive + otherActiveCount + breedActive + ageActive + advancedActive
      + state.locationFilter.size + (state.presetMinDaysAtLeast != null && viewHasLevels ? 1 : 0);

    // Dogs also get walked by people who aren't using the app, so the green
    // shift boxes only ever mean "a walk we know about", never "the whole day".
    const lastUpdatedLine = (state.lastScrapeAt
      ? `<p class="muted small" style="margin:0 0 6px;">Last updated ${fmtDate(state.lastScrapeAt)} · ${fmtClock(state.lastScrapeAt)}</p>`
      : '') + `<p class="muted small" style="margin:0 0 6px;"><span class="slot-box filled" style="display:inline-block;vertical-align:-2px;"></span> = ${aNoun(viewTerms)} logged here that shift. ${capFirst(nouns)} also get ${viewTerms.past} outside the app.</p>`;
    const filterRow = `
      ${speciesSwitchHtml()}
      <div class="card compact stack" style="gap:6px;margin-bottom:8px;">
        <label for="availableSearchInput" class="visually-hidden">Search by name</label>
        <input type="text" id="availableSearchInput" placeholder="Search by name…" value="${esc(state.availableSearch || '')}" />
        <div class="row" style="align-items:center;gap:6px;">
          <label for="availableSortSelect" class="small muted" style="flex:0 0 auto;margin:0;">Sort:</label>
          <select id="availableSortSelect" class="small" style="flex:1;">
            ${Object.entries(AVAILABLE_SORTS).filter(([, s]) => !s.hidden).map(([key, s]) => `<option value="${key}" ${state.availableSort === key ? 'selected' : ''}>${esc(typeof s.label === 'function' ? s.label(viewTerms) : s.label)}</option>`).join('')}
          </select>
          <button type="button" id="availableSortDirBtn" class="btn small-btn" style="flex:0 0 auto;width:auto;" title="${state.availableSortDir === 'asc' ? 'Ascending' : 'Descending'}" aria-label="Sort order: ${state.availableSortDir === 'asc' ? 'ascending' : 'descending'}. Tap to reverse">${state.availableSortDir === 'asc' ? '▲' : '▼'}</button>
        </div>
        <button type="button" id="toggleMoreFiltersBtn" class="btn small-btn">${state.showMoreFilters ? '▴ Hide filters' : '▾ Filters'}${activeFilterCount ? ` (${activeFilterCount} active)` : ''}</button>
        ${state.showMoreFilters ? `
        <div class="row" style="gap:6px;">
          <button type="button" class="btn small-btn filters-tab-btn ${state.filtersTab === 'filters' ? 'primary' : ''}" data-filters-tab="filters">Filters</button>
          <button type="button" class="btn small-btn filters-tab-btn ${state.filtersTab === 'presets' ? 'primary' : ''}" data-filters-tab="presets">Presets</button>
        </div>
        ${state.filtersTab === 'presets' ? presetsTabHtml() : `
        ${fosterCount ? `
        <label class="small muted" style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="showFosterCheck" ${state.showFoster ? 'checked' : ''} />
          Show ${fosterCount} ${fosterCount === 1 ? noun : nouns} in foster (can't be ${viewTerms.past})
        </label>` : ''}
        <label class="small muted" style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="needsShiftWalkCheck" ${state.needsShiftWalkOnly ? 'checked' : ''} />
          Hide ${nouns} with ${aNoun(viewTerms)} logged this shift
        </label>
        <label class="small muted" style="margin:6px 0 0;">Combine filters with:</label>
        <div class="seg seg-small" role="radiogroup" aria-label="Combine filters with" style="margin:0;">
          <button type="button" class="seg-btn ${state.filterMatch === 'any' ? '' : 'on'}" data-filter-match="all" role="radio" aria-checked="${state.filterMatch !== 'any'}">And (match all)</button>
          <button type="button" class="seg-btn ${state.filterMatch === 'any' ? 'on' : ''}" data-filter-match="any" role="radio" aria-checked="${state.filterMatch === 'any'}">Or (match any)</button>
        </div>
        <button type="button" class="btn small-btn filter-chip ${filterChipClass(state.markerFilters.walkedByMe)}" data-filter-key="walkedByMe" style="margin-top:2px;">${capFirst(nouns)} I've ${viewTerms.past} before</button>
        <button type="button" class="btn small-btn filter-chip ${filterChipClass(state.markerFilters.favorite)}" data-filter-key="favorite">♥ My favorites</button>
        <label class="small muted" style="margin:6px 0 0;">${esc(kennelLabel)}:</label>
        <div class="marker-row" style="gap:6px;">${locationChips}</div>
        <label class="small muted" style="margin:6px 0 0;">Tap once for only, twice to hide, again to clear:</label>
        <div class="marker-row" style="gap:6px;">${adopterChips}</div>
        ${ageRow}
        <details class="breed-filter" data-section="breed" ${breedActive || state.openFilterSections.has('breed') ? 'open' : ''}>
          <summary class="small muted">Breed${breedActive ? ' (filtering)' : ''}</summary>
          <div class="marker-row" style="gap:6px;margin-top:6px;">${breedChips}</div>
        </details>
        ${viewHasStickers ? `
        <div class="marker-row" style="gap:6px;">${starChip}</div>
        <div class="marker-row" style="gap:6px;">${blueChips}</div>
        <div class="marker-row" style="gap:6px;">${otherChips}</div>` : ''}
        ${viewHasLevels || viewHasPlaygroup ? `<div class="marker-row" style="gap:6px;">${viewHasLevels ? textChip('walkable', '🦮 Eligible to walk', 'Cleared for your level right now, the same as the Eligible ✓ badge (hide to see dogs who are not)') : ''}${viewHasPlaygroup ? textChip('playgroup', '🥎 Playgroup eligible', 'Not PB only, best without other dogs, or adopted (hide to see dogs who are)') : ''}</div>` : ''}
        ${advancedSectionHtml()}
        <button type="button" id="clearFiltersBtn" class="btn small-btn" style="margin-top:8px;">Clear filters</button>
        `}
        ` : ''}
      </div>`;

    // How many dogs this search/filter returns, against everyone listed.
    // A search the filters are hiding matches from: say how many, and offer
    // to clear the filters (they'd otherwise read as "nobody by that name").
    let searchHiddenNote = '';
    if (search) {
      const listedPool = state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster');
      const hiddenByFilters = listedPool.filter((d) => dogNameMatches(d, search)).length - visibleDogs.length;
      const inFoster = state.showFoster ? 0 : allDogs.filter((d) => d.location === 'In Foster' && dogNameMatches(d, search)).length;
      const parts = [];
      const more = visibleDogs.length ? 'more ' : '';
      if (hiddenByFilters > 0) parts.push(`${hiddenByFilters} ${hiddenByFilters === 1 ? `${more}${noun} matches` : `${more}${nouns} match`} "${esc(state.availableSearch.trim())}" but ${hiddenByFilters === 1 ? 'is' : 'are'} hidden by your filters.`);
      if (inFoster > 0) parts.push(`${inFoster} ${inFoster === 1 ? `${noun} matching it is` : `${nouns} matching it are`} in foster.`);
      if (parts.length) {
        searchHiddenNote = `<div class="card compact search-hidden-note" role="status" style="margin-bottom:8px;">
          <p class="small" style="margin:0;">${parts.join(' ')}</p>
          <div class="row" style="gap:6px;margin-top:6px;">
            ${hiddenByFilters > 0 ? '<button type="button" class="btn small-btn" id="searchClearFiltersBtn" style="width:auto;">Clear filters</button>' : ''}
            ${inFoster > 0 ? `<button type="button" class="btn small-btn" id="searchShowFosterBtn" style="width:auto;">Show ${nouns} in foster</button>` : ''}
          </div>
        </div>`;
      }
    }
    const resultCount = `<p class="muted small result-count" style="margin:0 0 6px;">Showing <strong>${visibleDogs.length}</strong> of ${allDogs.length} ${allDogs.length === 1 ? noun : nouns}</p>` + searchHiddenNote;
    if (!visibleDogs.length) {
      const searching = !!state.availableSearch.trim();
      appEl.innerHTML = lastUpdatedLine + filterRow + resultCount + `<p class="empty-state">${searching ? `No ${nouns}${searchHiddenNote ? ' in this list' : ''} match "${esc(state.availableSearch.trim())}".` : `No ${nouns} match these filters.`}</p>`;
      restoreScroll(state.availableScrollTop);
      wireAvailableFilters();
      return;
    }
    const cardHtml = (dog) => {
      const badge = eligibilityStatusHtml(dog);
      return `
        <div class="card compact avail-card${(dog.blueMarkers || []).includes('blue_evo') ? ' evo-caution' : ''}" data-id="${dog.id}">
          <div class="dog-card ${dog.checkedOffToday ? 'checked-off' : ''}">
            <img loading="lazy" decoding="async" class="dog-photo small" src="${dog.photoUrl ? esc(thumbOf(dog.photoUrl)) : '/icons/icon-192.png'}" alt="" />
            <div class="dog-info">
              <p class="dog-name">${esc(dog.name)} ${speciesTagHtml(dog)} ${favButtonHtml(dog)} ${markerBadges(dog)}</p>
              ${akaHtml(dog)}
              <div class="dog-meta meta-wrap"><p class="meta-list"><span class="meta-item">${esc(dog.breed || 'Unknown breed')}</span><span class="meta-item nowrap">${shelterDaysHtml(dog)}</span><span class="meta-item nowrap">🏠 ${esc(dog.kennelLocation || '?')}</span><span class="meta-item nowrap dog-id">ID ${dog.id}</span></p></div>
              ${slotGridHtml(dog.id, dog.species)}
              ${currentWalkBadge(dog)}
              ${badge}${youngBadgeHtml(dog)}
            </div>
            <label class="checkoff-label" title="Someone else already ${termsOf(dog).past} this ${esc(speciesOf(dog).noun)} today">
              <input type="checkbox" class="checkoff-check" data-id="${dog.id}" ${dog.checkedOffToday ? 'checked' : ''} aria-label="${esc(dog.name)} was already out today" />
              <span class="small muted">Out</span>
            </label>
          </div>
          ${dogActionButtons(dog.id, dog.tooYoung || dog.eligible === false, dog.species)}
        </div>`;
    };
    // eng (audit2): a long list draws its first AVAIL_FIRST_CARDS cards at
    // once and the rest in chunks after (300 cards took 0.5-1.6 s before the
    // first one showed). Coming back scrolled down draws them all at once,
    // so the scroll position can be restored.
    const AVAIL_FIRST_CARDS = 30;
    const AVAIL_CHUNK = 40;
    const chunked = !(state.availableScrollTop > 0) && visibleDogs.length > AVAIL_FIRST_CARDS;
    const firstDogs = chunked ? visibleDogs.slice(0, AVAIL_FIRST_CARDS) : visibleDogs;
    appEl.innerHTML = lastUpdatedLine + filterRow + resultCount + `<div class="stack tight" id="availCards">${firstDogs.map(cardHtml).join('')}</div>`;
    restoreScroll(state.availableScrollTop);
    wireAvailableFilters();
    wireAvailCards(appEl);
    const token = (availRenderToken += 1);
    const list = document.getElementById('availCards');
    let next = firstDogs.length;
    const drawMore = () => {
      // A redraw, another tab or another list since: this one is gone.
      if (token !== availRenderToken || !list.isConnected || next >= visibleDogs.length) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = visibleDogs.slice(next, next + AVAIL_CHUNK).map(cardHtml).join('');
      next += AVAIL_CHUNK;
      wireAvailCards(tmp);
      list.append(...tmp.children);
      setTimeout(drawMore, 0);
    };
    if (chunked) setTimeout(drawMore, 0);
  }
  let availRenderToken = 0;

  // The buttons and "Out" checkboxes on Available cards under scope.
  function wireAvailCards(scope) {
    wireDogActionButtons(scope);
    scope.querySelectorAll('.checkoff-check').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = cb.dataset.id;
        const card = cb.closest('.dog-card');
        try {
          if (cb.checked) {
            await api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: Number(id), dateKey: todayKey() }) });
          } else {
            await api(`/api/checkoff?dogId=${id}&dateKey=${todayKey()}`, { method: 'DELETE' });
          }
          card.classList.toggle('checked-off', cb.checked);
        } catch (err) {
          cb.checked = !cb.checked;
          appAlert(err.message);
        }
      });
    });
  }

  function wireAvailableFilters() {
    // Wired here (not just in the has-results branch) so search still works
    // once it narrows down to zero matches — otherwise the input above it
    // never gets its listener and typing/backspacing does nothing.
    const searchInput = document.getElementById('availableSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.availableSearch = searchInput.value;
        const caret = searchInput.selectionStart;
        redrawAvailableList();
        const restored = document.getElementById('availableSearchInput');
        restored.focus();
        restored.setSelectionRange(caret, caret);
      });
    }
    const fosterCb = document.getElementById('showFosterCheck');
    if (fosterCb) fosterCb.addEventListener('change', () => { state.showFoster = fosterCb.checked; redrawAvailableList(); });
    const sortSelect = document.getElementById('availableSortSelect');
    if (sortSelect) sortSelect.addEventListener('change', () => { state.availableSort = sortSelect.value; redrawAvailableList(); });
    const sortDirBtn = document.getElementById('availableSortDirBtn');
    if (sortDirBtn) sortDirBtn.addEventListener('click', () => {
      state.availableSortDir = state.availableSortDir === 'asc' ? 'desc' : 'asc';
      redrawAvailableList();
    });
    const moreBtn = document.getElementById('toggleMoreFiltersBtn');
    if (moreBtn) moreBtn.addEventListener('click', () => { state.showMoreFilters = !state.showMoreFilters; redrawAvailableList(); });
    document.querySelectorAll('.filters-tab-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        state.filtersTab = btn.dataset.filtersTab;
        if (state.filtersTab === 'presets') await loadSavedFilters();
        redrawAvailableList();
      });
    });
    const ageMin = document.getElementById('ageMinSelect');
    const ageMax = document.getElementById('ageMaxSelect');
    const readAge = (el) => (el.value === '' ? null : Number(el.value));
    if (ageMin) ageMin.addEventListener('change', () => { state.ageMinYears = readAge(ageMin); redrawAvailableList(); });
    if (ageMax) ageMax.addEventListener('change', () => { state.ageMaxYears = readAge(ageMax); redrawAvailableList(); });
    // Folding sections stay as the user left them across redraws.
    document.querySelectorAll('details[data-section]').forEach((el) => {
      el.addEventListener('toggle', () => {
        if (el.open) state.openFilterSections.add(el.dataset.section);
        else state.openFilterSections.delete(el.dataset.section);
      });
    });
    const minDaysSel = document.getElementById('minShelterDaysSelect');
    if (minDaysSel) minDaysSel.addEventListener('change', () => { state.minShelterDays = readAge(minDaysSel); redrawAvailableList(); });
    const shiftCb = document.getElementById('needsShiftWalkCheck');
    if (shiftCb) shiftCb.addEventListener('change', () => { state.needsShiftWalkOnly = shiftCb.checked; redrawAvailableList(); });
    document.querySelectorAll('.filter-chip[data-filter-key]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.filterKey;
        const next = cycleFilterMode(state.markerFilters[key]);
        if (next === 'none') delete state.markerFilters[key];
        else state.markerFilters[key] = next;
        redrawAvailableList();
      });
    });
    document.querySelectorAll('.filter-chip[data-location-key]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.locationKey;
        if (state.locationFilter.has(key)) state.locationFilter.delete(key);
        else state.locationFilter.add(key);
        redrawAvailableList();
      });
    });
    const blueAnyBtn = document.querySelector('.filter-chip[data-filter-action="blue-any"]');
    if (blueAnyBtn) {
      blueAnyBtn.addEventListener('click', () => {
        const next = cycleFilterMode(blueAnyFilterMode());
        BLUE_MARKERS.forEach((m) => {
          if (next === 'hide') state.markerFilters[m.value] = 'hide';
          else if (next === 'none') delete state.markerFilters[m.value];
          else if (m.value !== 'blue_evo') state.markerFilters[m.value] = 'only';
          else if (state.markerFilters[m.value] === 'hide') delete state.markerFilters[m.value];
        });
        redrawAvailableList();
      });
    }
    document.querySelectorAll('.seg-btn[data-filter-match]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterMatch = btn.dataset.filterMatch;
        redrawAvailableList();
      });
    });
    wireSpeciesSwitch(redrawAvailableList);
    const clearBtn = document.getElementById('clearFiltersBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => clearAllFilters());
    // From the "hidden by your filters" note under a search (the search stays).
    const searchClearBtn = document.getElementById('searchClearFiltersBtn');
    if (searchClearBtn) searchClearBtn.addEventListener('click', () => { const foster = state.showFoster; clearAllFilters(); if (foster) { state.showFoster = true; redrawAvailableList(); } });
    const searchFosterBtn = document.getElementById('searchShowFosterBtn');
    if (searchFosterBtn) searchFosterBtn.addEventListener('click', () => { state.showFoster = true; redrawAvailableList(); });

    // ---- Presets tab ----
    document.querySelectorAll('.preset-apply-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = BUILT_IN_PRESETS.find((p) => p.key === btn.dataset.presetKey);
        if (preset) applyFilterObject(preset.filter);
      });
    });
    document.querySelectorAll('.saved-filter-apply-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const saved = state.savedFilters.find((f) => String(f.id) === btn.dataset.filterId);
        if (saved) applyFilterObject(saved.filter);
      });
    });
    document.querySelectorAll('.saved-filter-rename-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const saved = state.savedFilters.find((f) => String(f.id) === btn.dataset.filterId);
        if (!saved) return;
        const name = await appPrompt('Rename saved filter', saved.name, { title: 'Rename filter' });
        if (!name || !name.trim()) return;
        await api(`/api/users/${state.currentUser.id}/saved-filters/${saved.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim() })
        });
        await loadSavedFilters();
        redrawAvailableList();
      });
    });
    document.querySelectorAll('.saved-filter-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await appConfirm('Delete this saved filter?', { title: 'Delete filter', confirmText: 'Delete', danger: true }))) return;
        await api(`/api/users/${state.currentUser.id}/saved-filters/${btn.dataset.filterId}`, { method: 'DELETE' });
        await loadSavedFilters();
        redrawAvailableList();
      });
    });
    const saveCurrentBtn = document.getElementById('saveCurrentFilterBtn');
    if (saveCurrentBtn) {
      saveCurrentBtn.addEventListener('click', async () => {
        const name = await appPrompt('Name this filter combination', '', { title: 'Save filter' });
        if (!name || !name.trim()) return;
        await api(`/api/users/${state.currentUser.id}/saved-filters`, {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), filter: currentFilterObject() })
        });
        await loadSavedFilters();
        redrawAvailableList();
      });
    }
  }

  // ---------- Audit tab ----------
  // Gated to users with canAudit (a separate permission from isPrivileged —
  // see the ⚙ gear on the confirm screen). Built for walking a wing kennel
  // to kennel: pick the letter, open the scanner, and scan card after card.
  // The scanner stays open, every scan saves that letter straight away
  // without waiting on the network, and the last 3 dogs scanned sit at the
  // top so it's obvious each scan landed. "Finish wing" then asks whether
  // every kennel was scanned -- if so, dogs still recorded in that wing
  // that weren't scanned get their letter cleared.
  async function renderAudit() {
    appEl.innerHTML = `
      <div class="stack tight">
        <div id="auditRecent"></div>
        <div class="card compact">
          <label class="small">Kennel location</label>
          ${kennelLetterPickerHtml('auditLetterPicker', state.audit.location)}
          <div class="row" style="margin-top:10px;">
            <button type="button" id="auditScanBtn" class="btn primary" ${state.audit.location ? '' : 'disabled'}>📷 Start scanning</button>
          </div>
          <div id="auditQrSection" class="hidden" style="margin-top:10px;">
            <div id="audit-qr-reader"></div>
            <div id="auditScanError" class="small"></div>
            <button type="button" id="auditCancelScanBtn" class="btn">Stop scanning</button>
          </div>
          <div id="auditFinish"></div>
        </div>
        <div class="card compact">
          <label for="auditNameSearch" class="small">Or find a dog by name</label>
          <input type="text" id="auditNameSearch" placeholder="Start typing a dog's name…" autocomplete="off" />
          <div id="auditNameSearchResults" class="stack tight" style="margin-top:8px;"></div>
        </div>
        <div id="auditResult"></div>
      </div>`;
    wireKennelLetterPicker('auditLetterPicker', (letter) => {
      state.audit.location = letter;
      document.getElementById('auditScanBtn').disabled = !letter;
      renderAuditFinish();
    }, { required: true });
    wireAuditScanner();
    wireAuditNameSearch();
    renderAuditRecent();
    renderAuditFinish();
    renderAuditResult();
  }

  function auditScannedSet(letter) {
    if (!state.audit.scanned[letter]) state.audit.scanned[letter] = new Set();
    return state.audit.scanned[letter];
  }

  // The last 3 dogs scanned, newest first. Scanning a dog already on the
  // list just moves it back to the top instead of adding it twice.
  function renderAuditRecent() {
    const el = document.getElementById('auditRecent');
    if (!el) return;
    const rows = state.audit.recent;
    const err = state.audit.scanError;
    if (!rows.length && !err) { el.innerHTML = ''; return; }
    const icon = (r) => (r.status === 'ok' ? '✓' : r.status === 'error' ? '⚠' : '…');
    el.innerHTML = `
      <div class="card compact">
        ${err ? `<p class="small" style="margin:0 0 4px;color:var(--red);">⚠ ${esc(err)}</p>` : ''}
        ${rows.map((r, i) => `
          <p class="${i === 0 ? '' : 'small muted'}" style="margin:0;${r.status === 'error' ? 'color:var(--red);' : ''}">
            <span style="display:inline-block;width:1.4em;">${icon(r)}</span>${i === 0 ? '<strong>' : ''}${esc(r.name)}${i === 0 ? '</strong>' : ''} → ${esc(r.letter)}${r.status === 'error' ? ` · ${esc(r.error)}` : ''}
          </p>`).join('')}
      </div>`;
  }

  function upsertAuditRecent(entry) {
    state.audit.recent = [entry, ...state.audit.recent.filter((r) => r.id !== entry.id)].slice(0, 3);
    state.audit.scanError = '';
    renderAuditRecent();
  }

  function renderAuditFinish() {
    const el = document.getElementById('auditFinish');
    if (!el) return;
    const letter = state.audit.location;
    const count = letter ? auditScannedSet(letter).size : 0;
    el.innerHTML = count ? `
      <div class="row" style="margin-top:10px;">
        <button type="button" id="auditFinishBtn" class="btn">Finish wing ${esc(letter)} (${count} scanned)</button>
      </div>` : '';
    const btn = document.getElementById('auditFinishBtn');
    if (btn) btn.addEventListener('click', () => finishAuditWing(letter));
  }

  async function finishAuditWing(letter) {
    const scannedIds = [...auditScannedSet(letter)];
    const allScanned = await appConfirm(
      `Did you scan every kennel in wing ${letter}? If you did, any dog still recorded in ${letter} that you didn't scan will have its location cleared.`,
      { title: `Finish wing ${letter}`, confirmText: 'Yes, every kennel', cancelText: 'No, only some' }
    );
    if (!allScanned) {
      auditScannedSet(letter).clear();
      renderAuditFinish();
      appAlert(`Done with ${letter}. Only the ${scannedIds.length} dog${scannedIds.length === 1 ? '' : 's'} you scanned were updated.`);
      return;
    }
    try {
      const preview = await api('/api/audit/clear-unscanned', { method: 'POST', body: JSON.stringify({ letter, scannedIds, dryRun: true }) });
      if (preview.cleared.length) {
        const names = preview.cleared.map((d) => d.name).join(', ');
        const ok = await appConfirm(
          `These ${preview.cleared.length} dog${preview.cleared.length === 1 ? ' is' : 's are'} recorded in ${letter} but weren't scanned: ${names}. Clear their location?`,
          { title: `Clear from ${letter}`, confirmText: 'Clear them', danger: true }
        );
        if (!ok) return;
        await api('/api/audit/clear-unscanned', { method: 'POST', body: JSON.stringify({ letter, scannedIds }) });
      }
      auditScannedSet(letter).clear();
      renderAuditFinish();
      appAlert(preview.cleared.length
        ? `Wing ${letter} done. Cleared ${preview.cleared.length} dog${preview.cleared.length === 1 ? '' : 's'} that weren't there.`
        : `Wing ${letter} done. Every dog on file was scanned.`);
    } catch (err) {
      appAlert(err.message);
    }
  }

  function wireAuditScanner() {
    const scanBtn = document.getElementById('auditScanBtn');
    const qrSection = document.getElementById('auditQrSection');
    const cancelBtn = document.getElementById('auditCancelScanBtn');
    // Names for the recent list without a network round trip per scan.
    const namesById = new Map();
    api('/api/dogs?all=true&fields=names').then((data) => data.dogs.forEach((d) => namesById.set(String(d.id), d.name))).catch(() => {});
    // The camera reports the same code many times a second while it's in
    // view, so the same card again within a couple of seconds is ignored.
    let lastId = null;
    let lastAt = 0;
    const onScanned = (decodedText) => {
      const animalId = parseAnimalIdFromScan(decodedText);
      const now = Date.now();
      if (animalId && String(animalId) === lastId && now - lastAt < 2500) return;
      lastId = animalId ? String(animalId) : null;
      lastAt = now;
      if (!animalId) { state.audit.scanError = "Couldn't read a dog ID from that code."; renderAuditRecent(); return; }
      const letter = state.audit.location;
      if (!letter) { state.audit.scanError = 'Pick a kennel letter first.'; renderAuditRecent(); return; }
      const id = String(animalId);
      const entry = { id, name: namesById.get(id) || `Dog ${id}`, letter, status: 'saving' };
      upsertAuditRecent(entry);
      // Not awaited: the next kennel can be scanned while this one saves.
      api(`/api/dogs/${id}/location`, { method: 'PUT', body: JSON.stringify({ location: letter }) })
        .then((res) => {
          entry.status = 'ok';
          if (res.name) entry.name = res.name;
          auditScannedSet(letter).add(id);
          if (navigator.vibrate) navigator.vibrate(40);
          renderAuditFinish();
          // Only refresh the markers card if nothing newer was scanned since.
          if (state.audit.recent[0] && state.audit.recent[0].id === id) loadAuditDog(id, { quiet: true });
        })
        .catch((err) => { entry.status = 'error'; entry.error = err.message; })
        .finally(renderAuditRecent);
    };
    scanBtn.addEventListener('click', () => {
      qrSection.classList.remove('hidden');
      scanBtn.classList.add('hidden');
      startQrScanner('audit-qr-reader', 'auditScanError', onScanned);
    });
    cancelBtn.addEventListener('click', () => {
      stopQrScanner();
      qrSection.classList.add('hidden');
      scanBtn.classList.remove('hidden');
    });
  }

  // Shows a dog below for a markers check. Returns the dog (or null).
  // quiet: from a scan -- no loading flicker and no pop-up on failure, so
  // nothing gets in the way of scanning the next kennel.
  async function loadAuditDog(animalId, { quiet = false } = {}) {
    if (!quiet) {
      state.audit.loading = true;
      renderAuditResult();
    }
    try {
      const { dog } = await api(`/api/dogs/${animalId}?userId=${state.currentUser.id}`);
      state.audit.dog = dog;
    } catch (err) {
      if (!quiet) appAlert(err.message);
      state.audit.dog = quiet ? state.audit.dog : null;
    }
    state.audit.loading = false;
    renderAuditResult();
    return state.audit.dog;
  }

  function wireAuditNameSearch() {
    const input = document.getElementById('auditNameSearch');
    const results = document.getElementById('auditNameSearchResults');
    // Fetched eagerly (not on focus) so the first keystroke always has data
    // to search, rather than racing a fetch that may not resolve before
    // someone finishes typing a short name.
    let allDogs = [];
    api('/api/dogs?all=false').then((data) => { allDogs = data.dogs; }).catch(() => {});
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.innerHTML = ''; return; }
      const matches = allDogs.filter((d) => dogNameMatches(d, q)).slice(0, 8);
      results.innerHTML = matches.length ? matches.map((d) => `
        <div class="card compact dog-card search-result" data-id="${d.id}">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${d.photoUrl ? esc(thumbOf(d.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges(d)}</p>
            ${akaHtml(d)}
            <p class="dog-meta">${esc(d.breed || '')} · <span class="nowrap">🏠 ${esc(d.kennelLocation || '?')}</span></p>
          </div>
        </div>`).join('') : '<p class="muted small">No matches.</p>';
      results.querySelectorAll('.search-result').forEach((row) => {
        row.addEventListener('click', () => {
          input.value = '';
          results.innerHTML = '';
          loadAuditDog(row.dataset.id);
        });
      });
    });
  }

  function renderAuditResult() {
    const resultEl = document.getElementById('auditResult');
    if (!resultEl) return;
    if (state.audit.loading) {
      resultEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      return;
    }
    const dog = state.audit.dog;
    if (!dog) {
      resultEl.innerHTML = `<p class="empty-state">Pick a kennel letter and start scanning, or search for a dog by name.</p>`;
      return;
    }
    const stickers = speciesOf(dog).stickers;
    resultEl.innerHTML = `
      <div class="card compact" data-dog-id="${dog.id}">
        <div class="dog-card">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${dog.photoUrl ? esc(thumbOf(dog.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(dog.name)} ${sexIcon(dog.sex)} ${markerBadges(dog)}</p>
            ${akaHtml(dog)}
            <p class="dog-meta">${esc(dog.breed || '')} · ${shelterDaysHtml(dog)} · <span class="nowrap">🏠 ${esc(dog.kennelLocation || '?')}</span> · <span class="nowrap dog-id">ID ${dog.id}</span></p>
          </div>
        </div>
      </div>
      <div class="card compact">
        ${stickers ? markerPickerHtml(dog) : `<p class="small muted" style="margin:0;">${esc(speciesOf(dog).plural)} don't have kennel card stickers.</p>`}
        <div class="row" style="margin-top:10px;">
          <button id="auditSaveBtn" class="btn primary" ${!stickers && !state.audit.location ? 'disabled' : ''}>${stickers
            ? (state.audit.location ? `Save stickers &amp; location ${esc(state.audit.location)}` : 'Save stickers')
            : `Save location ${esc(state.audit.location || '')}`}</button>
        </div>
        <p id="auditSaveStatus" class="small muted" style="margin:6px 0 0;"></p>
      </div>`;
    state.audit.pendingMarkers = {
      blueMarkers: [...(dog.blueMarkers || [])],
      pooStatus: dog.pooStatus || 'none',
      starFlag: !!dog.starFlag,
      pbFlag: !!dog.pbFlag
    };
    wireMarkerPicker(state.audit.pendingMarkers);
    document.getElementById('auditSaveBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('auditSaveStatus');
      const letter = state.audit.location;
      statusEl.textContent = 'Saving…';
      try {
        if (stickers) {
          const updated = await saveMarkerChanges(dog, state.audit.pendingMarkers);
          if (updated) Object.assign(dog, { ...markersOfDog(updated), markersVersion: updated.version });
        }
        if (letter) {
          const locRes = await api(`/api/dogs/${dog.id}/location`, { method: 'PUT', body: JSON.stringify({ location: letter }) });
          dog.kennelLocation = locRes.location;
        }
        statusEl.textContent = 'Saved ✓';
      } catch (err) {
        if (err.staleMarkers) { await loadAuditDog(dog.id, { quiet: true }); appAlert(err.serverMessage || err.message, 'Stickers changed'); return; }
        statusEl.textContent = `Failed: ${err.message}`;
      }
    });
  }

  // ---------- Stats tab ----------
  // A newest-first list of days as collapsible month rows (Lifetime stats'
  // Shelter Visits, and Together's past days). Only the newest month starts
  // open; which ones are open is kept in state[openKey] so it survives
  // stepping into a day and back.
  function visitMonthsHtml(days, keyOf, rowHtml, summary, openKey) {
    const months = [];
    for (const day of days) {
      const key = keyOf(day).slice(0, 7);
      if (!months.length || months[months.length - 1].key !== key) months.push({ key, days: [] });
      months[months.length - 1].days.push(day);
    }
    if (!state[openKey]) state[openKey] = new Set(months.length ? [months[0].key] : []);
    const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); };
    return months.map((mo) => `
      <details class="visit-month" data-month="${mo.key}"${state[openKey].has(mo.key) ? ' open' : ''}>
        <summary class="card compact visit-month-head">
          <span><strong>${monthLabel(mo.key)}</strong>
          <span class="muted small"> · ${summary(mo.days)}</span></span>
          <span class="visit-month-chevron muted">▾</span>
        </summary>
        <div class="stack">${mo.days.map(rowHtml).join('')}</div>
      </details>`).join('');
  }
  function wireVisitMonths(openKey) {
    appEl.querySelectorAll('.visit-month').forEach((el) => el.addEventListener('toggle', () => {
      if (el.open) state[openKey].add(el.dataset.month);
      else state[openKey].delete(el.dataset.month);
    }));
  }

  // Always refetches, even when returning to a previously-opened day view —
  // otherwise switching tabs away and back would keep showing stale data.
  // Two views live under the Stats tab: your own numbers, and "Together" --
  // everyone's walks combined, with no names or individual figures anywhere.
  // Playgroup is a dog activity: a cat-only volunteer gets no tab for it.
  const showsPlaygroupTab = () => prefSpeciesKeys().some((k) => (speciesInfo(k).activities || []).includes('playgroup'));
  function statsScopeSwitchHtml() {
    if (state.statsScope === 'playgroup' && !showsPlaygroupTab()) state.statsScope = 'mine';
    return `
      <div class="seg seg-scroll" role="tablist" aria-label="Stats view">
        <button type="button" class="seg-btn ${state.statsScope === 'mine' ? 'on' : ''}" data-scope="mine" role="tab" aria-selected="${state.statsScope === 'mine'}">My stats</button>
        <button type="button" class="seg-btn ${state.statsScope === 'together' ? 'on' : ''}" data-scope="together" role="tab" aria-selected="${state.statsScope === 'together'}">Together</button>
        <button type="button" class="seg-btn ${state.statsScope === 'shelter' ? 'on' : ''}" data-scope="shelter" role="tab" aria-selected="${state.statsScope === 'shelter'}">Shelter</button>
        <button type="button" class="seg-btn ${state.statsScope === 'notes' ? 'on' : ''}" data-scope="notes" role="tab" aria-selected="${state.statsScope === 'notes'}">Notes</button>
        ${showsPlaygroupTab() ? `<button type="button" class="seg-btn ${state.statsScope === 'playgroup' ? 'on' : ''}" data-scope="playgroup" role="tab" aria-selected="${state.statsScope === 'playgroup'}">Playgroup</button>` : ''}
      </div>${['mine', 'together', 'shelter', 'notes'].includes(state.statsScope) ? statsSpeciesSwitchHtml() : ''}`;
  }
  function wireStatsScopeSwitch() {
    wireStatsSpeciesSwitch();
    // On a narrow phone the bar scrolls sideways: keep the open tab in view.
    const bar = appEl.querySelector('.seg-scroll');
    const on = bar && bar.querySelector('.seg-btn.on');
    if (on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2);
    // Fade whichever edge still has tabs past it, so "Playgroup" off-screen
    // doesn't look like the bar simply ends at "Notes".
    if (bar) {
      const edges = () => {
        const max = bar.scrollWidth - bar.clientWidth;
        bar.classList.toggle('more-left', max > 1 && bar.scrollLeft > 1);
        bar.classList.toggle('more-right', max > 1 && bar.scrollLeft < max - 1);
      };
      edges();
      bar.addEventListener('scroll', edges, { passive: true });
    }
    appEl.querySelectorAll('.seg-btn[data-scope]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.scope === state.statsScope) return;
      state.statsScope = b.dataset.scope;
      state.togetherDay = null;
      state.togetherByActivity = false;
      state.togetherAvgChart = null;
      state.statsView = 'summary';
      state.statsActivityFilter = null;
      renderStats();
    }));
  }

  async function renderTogether() {
    const myTab = state.tab;
    let data;
    try {
      data = await api(`/api/impact?days=all&species=${statsSpecies()}`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('the shared stats', err, renderStats);
      return;
    }
    if (state.tab !== myTab) return;
    const hours = (sec) => fmtDuration(sec);
    // Named after what the average is actually of (impact.js avgActivity):
    // walks whenever there were any, else the one activity there was (a
    // matchmaking-only day is never an "average walk"), else engagements.
    const avgWordOf = (x) => averageWordFor(x && x.avgActivity, termsFor(statsSpeciesKeys()));
    const tile = (value, label, sub, id) => `<div class="stat-tile${id ? ' stats-drilldown-tile' : ''}"${id ? ` id="${id}" role="button" tabindex="0" style="cursor:pointer;"` : ''}><div class="value">${value}</div><div class="label">${label}</div>${sub ? `<div class="label sub">${sub}</div>` : ''}</div>`;
    // "Walks" and "dogs" are the same number on most days, so they're one tile;
    // the distinct-dog count only appears when a dog was walked more than once.
    const dogsNote = (walks, dogs) => (dogs && dogs !== walks ? `${dogs} different ${nounFor(statsSpeciesKeys(), dogs !== 1)}` : '');
    // Nothing a minute or longer to average: a dash and why, never "0 min".
    const allShort = (x) => x.walks > 0 && !x.avgSeconds;
    const avg = (x) => (allShort(x) ? '–' : fmtDuration(x.avgSeconds || 0));
    const avgSub = (x) => (allShort(x) ? 'All under a minute' : null);
    const engagementsLabel = (n) => (n === 1 ? 'Engagement' : 'Engagements');
    const t = data.today;
    const todayHtml = t
      ? `<div class="stat-grid three">${tile(t.walks, `${engagementsLabel(t.walks)} today ›`, dogsNote(t.walks, t.dogs), 'togetherTodayActivityTile')}${tile(hours(t.seconds), 'Collective time ›', null, 'togetherTodayTimeTile')}${tile(avg(t), `${avgWordOf(t)} ›`, avgSub(t), 'togetherAvgChartTile')}</div>
         ${t.sessions.length ? `<div class="stat-grid" style="margin-top:10px;">${t.sessions.map((s) => tile(s.walks, `Engagements ${esc(fmtSlotLabel(s.label))}`, `avg ${avg(s)}`)).join('')}</div>` : ''}`
      : `<div class="card compact center"><p class="muted" style="margin:0;">Today's combined engagements show up here as the day goes on. 🐾</p></div>`;
    const dayRow = (d) => `
      <div class="card compact together-day" data-date="${esc(d.dateKey)}" role="button" tabindex="0">
        <div class="together-day-head">
          <strong>${fmtDayHeading(d.dateKey)}</strong>
          <span class="muted small">${plural(d.walks, 'engagement', 'engagements')}${d.dogs !== d.walks ? ` (${d.dogs} ${nounFor(statsSpeciesKeys(), d.dogs !== 1)})` : ''} · ${hours(d.seconds)} · ${avgWordOf(d).toLowerCase()} ${avg(d)} · tap for details ›</span>
        </div>
        ${d.sessions.length ? `<div class="together-sessions">${d.sessions.map((s) => `<span class="badge neutral">${esc(fmtSlotLabel(s.label))}: ${s.walks}</span>`).join(' ')}</div>` : ''}
      </div>`;
    // Past days grouped by month, newest open, same as Lifetime stats.
    const dayRows = visitMonthsHtml(data.days.filter((d) => d.dateKey !== (t && t.dateKey)), (d) => d.dateKey, dayRow,
      (days) => { const walks = days.reduce((n, d) => n + d.walks, 0); return `${days.length} day${days.length === 1 ? '' : 's'} · ${plural(walks, 'engagement', 'engagements')} · ${hours(days.reduce((n, d) => n + d.seconds, 0))}`; },
      'togetherOpenMonths');
    const a = data.allTime;
    // Same breakdowns as My stats, minus any drill-down by dog (see
    // renderTogetherByActivity).
    const todayBreakdowns = t ? statsBreakdownsHtml({ byActivity: t.byActivity, byPoo: t.byPoo, byAge: t.byAge }, { mine: false }) : '';
    const allTimeBreakdowns = statsBreakdownsHtml({ byActivity: a.byActivity, byPoo: a.byPoo, byAge: a.byAge }, { mine: false });
    appEl.innerHTML = `
      ${statsScopeSwitchHtml()}
      <h2 class="section-heading" style="margin-top:0;">Together today</h2>
      ${todayHtml}
      ${todayBreakdowns ? `<div class="card compact bd-card" style="margin-top:10px;">${todayBreakdowns}</div>` : ''}
      ${t ? `<button type="button" class="btn together-open" data-date="${esc(t.dateKey)}" style="margin-top:10px;">See today's ${termsFor(statsSpeciesKeys([])).nouns} in order ›</button>` : ''}
      ${dayRows ? `<h2 class="section-heading">Past days</h2><div class="stack tight">${dayRows}</div>` : ''}
      <h2 class="section-heading">${a.since ? `Since ${fmtDate(a.since)}` : 'Since we started tracking'}</h2>
      <div class="stat-grid three">${tile(a.walks, `${engagementsLabel(a.walks)} ›`, dogsNote(a.walks, a.dogs), 'togetherAllTimeActivityTile')}${tile(hours(a.seconds), 'Collective time ›', null, 'togetherAllTimeTimeTile')}${tile(avg(a), avgWordOf(a), avgSub(a))}</div>
      ${allTimeBreakdowns ? `<div class="card compact bd-card" style="margin-top:10px;">${allTimeBreakdowns}</div>` : ''}
      <p class="small muted center" style="margin-top:14px;">Everyone's engagements with the animals, combined. No names or individual numbers are shown or stored here, ever. Days and sessions with fewer than ${data.minCell} engagements aren't listed on their own (they still count in the totals).</p>`;
    wireStatsScopeSwitch();
    wireStatsBreakdowns('together');
    wireVisitMonths('togetherOpenMonths');
    appEl.querySelectorAll('[data-date]').forEach((el) => {
      const open = () => statsDrill(() => { state.togetherDay = el.dataset.date; });
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    const todayActivityTile = document.getElementById('togetherTodayActivityTile');
    if (todayActivityTile) todayActivityTile.addEventListener('click', () => statsDrill(() => { state.togetherByActivity = 'today'; }));
    const allTimeActivityTile = document.getElementById('togetherAllTimeActivityTile');
    if (allTimeActivityTile) allTimeActivityTile.addEventListener('click', () => statsDrill(() => { state.togetherByActivity = 'allTime'; }));
    const todayTimeTile = document.getElementById('togetherTodayTimeTile');
    if (todayTimeTile) todayTimeTile.addEventListener('click', () => statsDrill(() => { state.togetherByActivity = 'today'; }));
    const allTimeTimeTile = document.getElementById('togetherAllTimeTimeTile');
    if (allTimeTimeTile) allTimeTimeTile.addEventListener('click', () => statsDrill(() => { state.togetherByActivity = 'allTime'; }));
    // Only today's average is charted (per-dog, anonymous) -- charting every
    // engagement ever would be hundreds of bars with no real use.
    const avgChartTile = document.getElementById('togetherAvgChartTile');
    if (avgChartTile && t) avgChartTile.addEventListener('click', () => statsDrill(() => { state.togetherAvgChart = t.dateKey; }));
  }

  // Someone else's engagement on a Together day: only its session (the
  // server sends no clock times for it).
  const togetherSlotText = (w) => (WALK_SLOTS[w.slot] ? fmtSlotLabel(WALK_SLOTS[w.slot].label) : 'Outside walk hours');

  // Today's "Average engagement" drill-down: a bar per engagement, oldest to
  // newest, with a dashed average line -- same shape as My Stats' chart, but
  // sourced from /api/impact/day so no walker identity ever enters this
  // (only dog name + duration, same as the "In order" list already shows).
  async function renderTogetherAvgChart() {
    const myTab = state.tab;
    const dateKey = state.togetherAvgChart;
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    let data;
    try {
      data = await api(`/api/impact/day?date=${encodeURIComponent(dateKey)}&species=${statsSpecies()}`);
    } catch (err) {
      if (state.tab !== myTab) return;
      if (err.status === 404) { state.togetherAvgChart = null; toast(err.message, 'error'); return renderStats(); }
      showLoadError("today's engagements", err, renderTogetherAvgChart);
      return;
    }
    if (state.tab !== myTab) return;
    // The average itself is walk-only with an all-activities fallback (see
    // impact.js's avgOf), so the chart matches: only walks when there are
    // any today, otherwise every engagement.
    // Misscans under a minute get no bar and aren't in the average (avgPick,
    // same rule as the tile); the caption says how many were left out.
    const pick = avgPick(data.walks);
    // Already in order (by session; only your own carry clock times).
    const ordered = [...pick.rows].sort((a, b) => a.order - b.order);
    // The day's exact average (others' bars are to the nearest 5 minutes).
    const avgSeconds = data.totals ? data.totals.avgSeconds
      : (ordered.length ? ordered.reduce((s, w) => s + (w.durationSeconds || 0), 0) / ordered.length : 0);
    const items = ordered.map((w) => ({ label: w.dogName, seconds: w.durationSeconds || 0, sub: w.mine ? `${fmtClock(w.startedAt)} · you` : togetherSlotText(w) }));
    // The server's own name for it (impact.js avgActivity, which won't name
    // a rare activity on its own); else what avgPick saw.
    const avgActivity = data.totals ? data.totals.avgActivity : pick.activity;
    const word = averageWordFor(avgActivity, termsFor(statsSpeciesKeys())).replace(/^Average /, '');
    appEl.innerHTML = `
      <button id="togetherAvgChartBack" class="btn back-btn">← Back to Together</button>
      <h2 class="section-heading" style="margin-top:0;">Today's ${esc(word)} length, oldest to newest</h2>
      <p class="small muted" style="margin-top:-6px;">${ordered.length ? `${plural(ordered.length, word, `${word}s`)} · avg ${fmtDuration(avgSeconds)}${skippedNote(pick.skipped)} · tap a bar for details` : 'avg –'}</p>
      <div class="card compact">${durationBarChartHtml(items, avgSeconds)}</div>
      <p class="small muted center" style="margin-top:14px;">Everyone's engagements, combined. Names are never shown; only your own are marked "you", and only you see that.</p>`;
    document.getElementById('togetherAvgChartBack').addEventListener('click', () => statsBack(() => { state.togetherAvgChart = null; }));
    wireBarChart();
  }

  // Together's own "By Activity": a shelter-wide breakdown of engagement
  // types for the scope (today or since we started tracking) the volunteer
  // tapped into. No per-dog drill-down here -- unlike "My stats", breaking
  // this down further by dog would start pointing at who did what.
  async function renderTogetherByActivity() {
    const myTab = state.tab;
    const scope = state.togetherByActivity;
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    let data;
    try {
      data = await api(`/api/impact?days=all&species=${statsSpecies()}`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('the shared stats', err, renderStats);
      return;
    }
    if (state.tab !== myTab) return;
    const source = scope === 'today' ? data.today : data.allTime;
    const byActivity = (source && source.byActivity) || [];
    const sinceLabel = data.allTime.since ? `Engagements since ${fmtDate(data.allTime.since)}` : 'Engagements since we started tracking';
    const heading = `<button id="togetherActivityBack" class="btn back-btn">← Back to Together</button>` +
      `<h2 class="section-heading" style="margin-top:0;">${scope === 'today' ? "Today's engagements" : sinceLabel}, by activity</h2>`;
    const rows = byActivity.map((a) => {
      const info = activityInfo(a.activity);
      return `
      <div class="card compact">
        <div class="dog-info">
          <p class="dog-name">${info.emoji} ${info.label}</p>
          <p class="dog-meta">${a.count} engagement${a.count === 1 ? '' : 's'} · ${fmtDuration(a.totalSeconds)} total · ${avgText(a)}</p>
        </div>
      </div>`;
    }).join('');
    appEl.innerHTML = heading +
      (byActivity.length ? `<div class="stack tight">${rows}</div>`
        : `<p class="empty-state">No engagements to break down yet.</p>`) +
      `<p class="small muted center" style="margin-top:14px;">Everyone's engagements, combined.</p>`;
    document.getElementById('togetherActivityBack').addEventListener('click', () => statsBack(() => { state.togetherByActivity = false; }));
  }

  // Everyone's walks for one day, in order: which dog, when, how long. No
  // walker names anywhere; only your own walks are marked (as "You"), and
  // only to you. Notes and auto-stop/edit flags are deliberately not part of
  // this view (see impact.js).
  async function renderTogetherDay() {
    const myTab = state.tab;
    const date = state.togetherDay;
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    let data;
    try {
      data = await api(`/api/impact/day?date=${encodeURIComponent(date)}&species=${statsSpecies()}`);
    } catch (err) {
      if (state.tab !== myTab) return;
      if (err.status === 404) { state.togetherDay = null; toast(err.message, 'error'); return renderStats(); }
      showLoadError("that day's engagements", err, renderTogetherDay);
      return;
    }
    if (state.tab !== myTab) return;
    // The day's exact totals come with it; summing the rows would add up
    // others' lengths, which are only to the nearest 5 minutes.
    const totalSeconds = data.totals ? data.totals.seconds : data.walks.reduce((sum, w) => sum + (w.durationSeconds || 0), 0);
    const dayAvgSeconds = data.totals ? data.totals.avgSeconds : walkOnlyAvgSeconds(data.walks);
    const dogs = new Set(data.walks.map((w) => w.dogId)).size;
    const dayPick = avgPick(data.walks);
    const rowsHtml = data.walks.map((w) => `
      <div class="card compact dog-card together-walk" data-dogid="${w.dogId}">
        <div class="together-order">${w.order}</div>
        <img loading="lazy" decoding="async" class="dog-photo small" src="${w.photoUrl ? esc(thumbOf(w.photoUrl)) : '/icons/icon-192.png'}" alt="" />
        <div class="dog-info">
          <p class="dog-name">${esc(w.dogName)} ${markerBadges({ id: w.dogId, blueMarkers: w.blueMarkers ? JSON.parse(w.blueMarkers) : [], pooStatus: w.pooStatus || 'none', starFlag: w.starFlag, pbFlag: w.pbFlag, name: w.dogName })}${w.mine ? ' <span class="badge eligible">You</span>' : ''}</p>
          <p class="dog-meta">${w.mine ? `${fmtClockRange(w.startedAt, w.endedAt)} · ${fmtDuration(w.durationSeconds)}` : `${togetherSlotText(w)} · ${roundedLength(w.durationSeconds)}`}</p>
        </div>
      </div>`).join('');
    appEl.innerHTML = `
      <button id="togetherBack" class="btn back-btn">← Back to Together</button>
      <h2 class="section-heading">${fmtDayHeading(date)}</h2>
      <div class="stat-grid three">
        <div class="stat-tile"><div class="value">${data.walks.length}</div><div class="label">${data.walks.length === 1 ? 'Engagement' : 'Engagements'}</div>${dogs !== data.walks.length ? `<div class="label sub">${dogs} different ${nounFor(statsSpeciesKeys(), dogs !== 1)}</div>` : ''}</div>
        <div class="stat-tile"><div class="value">${fmtDuration(totalSeconds)}</div><div class="label">Collective time</div></div>
        <div class="stat-tile"><div class="value">${dayPick.rows.length ? fmtDuration(dayAvgSeconds) : '–'}</div><div class="label">${data.totals ? averageWordFor(data.totals.avgActivity, termsFor(statsSpeciesKeys())) : avgLabelFor(data.walks.map((w) => ({ ...w, species: statsSpecies() })))}</div>${dayPick.skipped ? `<div class="label sub">${dayPick.rows.length ? `Not counting ${dayPick.skipped} under a minute` : 'All under a minute'}</div>` : ''}</div>
      </div>
      <h2 class="section-heading">In order</h2>
      <div class="stack tight">${rowsHtml}</div>
      <p class="small muted center" style="margin-top:14px;">Everyone's engagements with the animals, combined. Names are never shown; only your own are marked "You", and only you see that.</p>`;
    document.getElementById('togetherBack').addEventListener('click', () => statsBack(() => { state.togetherDay = null; }));
    appEl.querySelectorAll('.together-walk').forEach((card) => card.addEventListener('click', async () => {
      try {
        const { dog, walks } = await api(`/api/dogs/${card.dataset.dogid}?userId=${state.currentUser.id}`);
        showProfileSheet(dog, walks);
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // Shelter trends, one species at a time (the Dogs / Cats switch): how many
  // were at the shelter and in foster each day, and how many came in / went
  // out, rebuilt from the scraper's event log (see shelterTrends.js), plus
  // the makeup of "at the shelter now" from /api/impact's shelterNow (walkable
  // for your level, POO, kittens/adults). No volunteer data is involved, only
  // what's on the floor right now and its history -- "At the shelter" and "In
  // foster" used to also show on My stats and Together; this is their one
  // home now (owner, 2026-11-10). Foster has its own tile and chart; nothing
  // else counts the animals in foster (owner, 2026-11-09).
  const SHELTER_RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 0, label: 'All' }];
  // " Tracking starts Nov 7." -- the first day on record, else the server's
  // `since` (a species' first day, before it has a day to show); never a
  // bare "Tracking starts .".
  function trackingStartText(data) {
    const key = (data.days && data.days[0] && data.days[0].dateKey) || data.since;
    if (!key) return '';
    return key > todayKey() ? ` Tracking starts ${esc(fmtShortDate(key))}.` : ` Tracking started ${esc(fmtShortDate(key))}.`;
  }
  async function renderShelterTrends() {
    const myTab = state.tab;
    let data;
    let impactData;
    try {
      [data, impactData] = await Promise.all([
        api(`/api/shelter-trends?species=${statsSpecies()}`),
        api(`/api/impact?days=all&species=${statsSpecies()}`)
      ]);
    } catch (err) {
      if (state.tab === myTab) showLoadError('the shelter trends', err, renderStats);
      return;
    }
    if (state.tab !== myTab || state.statsScope !== 'shelter' || data.species !== statsSpecies() || impactData.species !== statsSpecies()) return;
    const info = speciesInfo(data.species);
    const nouns = info.plural.toLowerCase();
    const days = state.shelterRange ? data.days.slice(-state.shelterRange) : data.days;
    const sum = (k) => days.reduce((n, d) => n + d[k], 0);
    // A day with no scrape on record (no count, no events) is a gap, not a
    // day where nothing came in or went out: it's left out of the in/out
    // chart and the per-day averages.
    // Only once daily counts are being kept (the first day with one): from
    // then on a day without one had no good scrape.
    const firstCounted = (days.find((d) => d.floor != null) || {}).dateKey;
    const noData = (d) => !!firstCounted && d.dateKey > firstCounted && d.floor == null && d.foster == null
      && !d.newDogs && !d.returned && !d.adopted && !d.otherExits;
    const knownDays = days.filter((d) => !noData(d));
    const perDay = (k) => (knownDays.length ? Math.round((sum(k) / knownDays.length) * 10) / 10 : 0);
    const inoutDays = days.map((d) => (noData(d) ? { ...d, broughtIn: null, adopted: null } : d));
    // These tiles' "drill-down" is the chart (and table) already below them
    // -- a line over time is the right shape for a count that moves day to
    // day, not another per-interaction bar chart, so a tap jumps to and
    // opens that detail instead of building a second chart that says the
    // same thing. target: which chart answers this tile ('floor', 'foster' or 'inout').
    const tile = (value, label, sub, target) => `<div class="stat-tile${target ? ' stats-drilldown-tile' : ''}"${target ? ` data-trend-target="${target}" role="button" tabindex="0" style="cursor:pointer;"` : ''}><div class="value">${value}</div><div class="label">${label}${target ? ' ›' : ''}</div>${sub ? `<div class="label sub">${sub}</div>` : ''}</div>`;
    const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
    const shortDate = (key) => fmtShortDate(key);
    // Change since the first day in range that has a count on record.
    const changeSince = (key, now) => {
      const from = days.find((d) => d[key] != null);
      return from && now != null ? `${signed(now - from[key])} since ${esc(shortDate(from.dateKey))}` : '';
    };
    const dash = (v) => (v == null ? '–' : v);
    const tableRows = [...days].reverse().map((d) => `
      <tr><td>${esc(shortDate(d.dateKey))}</td><td>${dash(d.floor)}</td><td>${dash(d.foster)}</td><td>${d.newDogs}</td><td>${d.returned}</td><td>${d.adopted}</td><td>${d.otherExits}</td></tr>`).join('');
    appEl.innerHTML = `
      ${statsScopeSwitchHtml()}
      <div class="seg seg-small" role="radiogroup" aria-label="Time range">
        ${SHELTER_RANGES.map((r) => `<button type="button" class="seg-btn ${state.shelterRange === r.days ? 'on' : ''}" data-shelter-range="${r.days}" role="radio" aria-checked="${state.shelterRange === r.days}">${r.label}</button>`).join('')}
      </div>
      <div class="stat-grid">
        ${tile(dash(data.floorNow), 'At the shelter now', changeSince('floor', data.floorNow), 'floor')}
        ${tile(dash(data.fosterNow), 'In foster now', changeSince('foster', data.fosterNow), 'foster')}
        ${tile(sum('broughtIn'), 'Brought in', `${perDay('broughtIn')} a day`, 'inout')}
        ${tile(sum('adopted'), 'Adopted', `${perDay('adopted')} a day`, 'inout')}
      </div>
      ${shelterBreakdownHtml(impactData.shelterNow[data.species], data.species)}
      <h2 class="section-heading" id="trendFloorHeading">${esc(info.plural)} at the shelter</h2>
      <div class="card compact trend-card">${trendChartHtml(days, [{ key: 'floor', label: 'At the shelter', cls: 'floor' }], { zoom: true })}</div>
      <h2 class="section-heading" id="trendInoutHeading">In and out each day</h2>
      <div class="card compact trend-card">${trendChartHtml(inoutDays, [
        { key: 'broughtIn', label: 'Brought in', cls: 'in' },
        { key: 'adopted', label: 'Adopted', cls: 'out' }
      ])}</div>
      <h2 class="section-heading" id="trendFosterHeading">${esc(info.plural)} in foster</h2>
      <div class="card compact trend-card">${trendChartHtml(days, [{ key: 'foster', label: 'In foster', cls: 'listed' }], { zoom: true })}</div>
      <details class="trend-table-wrap" id="trendTableDetails">
        <summary class="small muted">Show as a table</summary>
        <div class="trend-table-scroll">
          <table class="trend-table">
            <thead><tr><th>Day</th><th>At shelter</th><th>In foster</th><th>New</th><th>Returned</th><th>Adopted</th><th>Other exits</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </details>
      <p class="small muted center" style="margin-top:14px;">From the shelter's public listing, checked through the day. "At the shelter" is the ${esc(nouns)} on the listing at day's end, leaving out the ones in foster, which are counted on their own. Gaps are days with nothing on record. "Brought in" is new ${esc(nouns)} plus ${esc(nouns)} returned. "Other exits" are ${esc(nouns)} that left the listing without showing as adopted (transfers, returned to owner and so on).${trackingStartText(data)}</p>`;
    wireStatsScopeSwitch();
    appEl.querySelectorAll('[data-shelter-range]').forEach((b) => b.addEventListener('click', () => {
      state.shelterRange = Number(b.dataset.shelterRange);
      renderShelterTrends();
    }));
    // inoutDays: the same days, with no-data days' in/out as gaps (tooltips).
    wireTrendCharts(inoutDays, shortDate);
    appEl.querySelectorAll('[data-trend-target]').forEach((t2) => {
      t2.addEventListener('click', () => {
        const heading = document.getElementById({ floor: 'trendFloorHeading', foster: 'trendFosterHeading' }[t2.dataset.trendTarget] || 'trendInoutHeading');
        document.getElementById('trendTableDetails').open = true;
        if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    wireShelterBreakdown(data.species);
  }

  // A small hand-drawn SVG line chart over days (one y-axis, starting at 0
  // for counts). series: [{ key, label, cls }]; cls picks the line color in
  // style.css. Hover/tap shows every series' value for that day.
  function trendChartHtml(days, series, { zoom = false } = {}) {
    const notEnough = `<p class="small muted" style="margin:0;">Not enough history yet. This chart fills in as more days are on record.</p>`;
    if (!days.length) return notEnough;
    // Drawn at the screen's real width so text stays its normal size.
    const W = Math.max(280, Math.round((appEl.clientWidth || 360) - 34)), H = 200, padL = 34, padR = 10, padT = 10, padB = 24;
    // null values (no data that day) leave a gap in their line.
    const values = days.flatMap((d) => series.map((s) => d[s.key])).filter((v) => v != null);
    if (!values.length) return `<p class="small muted" style="margin:0;">No counts on record for these days yet.</p>`;
    // A lone dot on an axis says nothing; wait for a second day on record
    // (two known days already show the gap between them -- owner's smoke).
    if (days.filter((d) => series.some((s) => d[s.key] != null)).length < 2) return notEnough;
    const max = Math.max(1, ...values);
    // Count charts start at zero; the dogs-at-the-shelter chart zooms to its
    // range so day to day changes are visible.
    const minRaw = zoom ? Math.min(...values) : 0;
    const step = niceStep((max - minRaw) / 4 || 1);
    const yMin = zoom ? Math.max(0, Math.floor((minRaw - step / 2) / step) * step) : 0;
    const yMax = Math.ceil(max / step) * step || step;
    const x = (i) => padL + (days.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (days.length - 1));
    const y = (v) => padT + (H - padT - padB) * (1 - (v - yMin) / ((yMax - yMin) || 1));
    const grid = [];
    for (let v = yMin; v <= yMax + 1e-9; v += step) {
      grid.push(`<line class="trend-grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" /><text class="trend-axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    }
    // About five date labels along the bottom, always including the ends.
    const labelEvery = Math.max(1, Math.ceil(days.length / 5));
    const xLabels = days.map((d, i) => ((i % labelEvery === 0 && x(days.length - 1) - x(i) >= 56) || i === days.length - 1)
      ? `<text class="trend-axis" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${esc(shortDayLabel(d.dateKey))}</text>` : '').join('');
    const lines = series.map((s) => {
      const runs = [[]];
      days.forEach((d, i) => {
        if (d[s.key] == null) { if (runs[runs.length - 1].length) runs.push([]); return; }
        runs[runs.length - 1].push([x(i), y(d[s.key])]);
      });
      return runs.filter((r) => r.length).map((r) => (r.length === 1
        ? `<circle class="trend-point ${s.cls}" r="2.5" cx="${r[0][0].toFixed(1)}" cy="${r[0][1].toFixed(1)}" />`
        : `<polyline class="trend-line ${s.cls}" points="${r.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}" />`)).join('');
    }).join('');
    const legend = series.length > 1
      ? `<div class="trend-legend">${series.map((s) => `<span><i class="trend-swatch ${s.cls}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
    const geom = { W, padL, padR, n: days.length, series, ys: days.map((d) => series.map((s) => (d[s.key] == null ? null : y(d[s.key])))), xs: days.map((d, i) => x(i)) };
    return `${legend}
      <div class="trend-chart" data-geom='${esc(JSON.stringify(geom))}'>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(' and '))} by day">
          ${grid.join('')}${xLabels}${lines}
          <line class="trend-cursor hidden" x1="0" x2="0" y1="${padT}" y2="${H - padB}" />
          ${series.map((s) => `<circle class="trend-dot ${s.cls} hidden" r="4" cx="0" cy="0" />`).join('')}
        </svg>
        <div class="trend-tip hidden"></div>
      </div>`;
  }
  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag);
  }
  function shortDayLabel(key) {
    return fmtShortDate(key);
  }
  function wireTrendCharts(days, fmtDay) {
    appEl.querySelectorAll('.trend-chart').forEach((box) => {
      const g = JSON.parse(box.dataset.geom);
      const svg = box.querySelector('svg');
      const cursor = box.querySelector('.trend-cursor');
      const dots = [...box.querySelectorAll('.trend-dot')];
      const tip = box.querySelector('.trend-tip');
      const show = (clientX) => {
        const r = svg.getBoundingClientRect();
        const vx = ((clientX - r.left) / r.width) * g.W;
        let i = 0;
        g.xs.forEach((xv, k) => { if (Math.abs(xv - vx) < Math.abs(g.xs[i] - vx)) i = k; });
        cursor.setAttribute('x1', g.xs[i]); cursor.setAttribute('x2', g.xs[i]);
        cursor.classList.remove('hidden');
        dots.forEach((dot, k) => { dot.setAttribute('cx', g.xs[i]); dot.setAttribute('cy', g.ys[i][k] ?? 0); dot.classList.toggle('hidden', g.ys[i][k] == null); });
        const d = days[i];
        tip.innerHTML = `<strong>${esc(fmtDay(d.dateKey))}</strong>${g.series.map((s) => `<div><i class="trend-swatch ${s.cls}"></i>${esc(s.label)}: <strong>${d[s.key] == null ? '–' : d[s.key]}</strong></div>`).join('')}`
          + (g.series.some((s) => s.key === 'broughtIn') && d.broughtIn != null ? `<div class="muted">${d.newDogs} new · ${d.returned} returned</div>` : '');
        tip.classList.remove('hidden');
        const px = (g.xs[i] / g.W) * r.width;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(0, px - tw / 2), r.width - tw)}px`;
      };
      const hide = () => { cursor.classList.add('hidden'); dots.forEach((dot) => dot.classList.add('hidden')); tip.classList.add('hidden'); };
      box.addEventListener('pointermove', (e) => show(e.clientX));
      box.addEventListener('pointerdown', (e) => show(e.clientX));
      box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    });
  }

  // The drill-down behind any "Avg length" tile: one bar per interaction, in
  // the order given (chronological), against a dashed average line. One
  // series (duration), so one hue and no legend -- identity (which dog, when)
  // lives in the tap tooltip, not in a label on every bar, so it stays
  // readable with a handful of bars or a few hundred. items: [{ label, sub,
  // seconds }], already in the order to display.
  function durationBarChartHtml(items, avgSeconds) {
    if (!items.length) return `<p class="small muted" style="margin:0;">Nothing to show yet.</p>`;
    // A long history gets thinner bars, so it isn't thousands of pixels wide.
    // (Up to about 1200px; past that every bar shares the space, down to 1px.)
    const barStep = Math.max(1.5, Math.min(24, 1200 / Math.max(1, items.length)));
    const BAR_W = barStep >= 24 ? 14 : Math.max(1, barStep * 0.7), GAP = barStep - BAR_W, padR = 10, padT = 10, padB = 10, H = 160;
    const plotH = H - padT - padB;
    const maxSeconds = Math.max(avgSeconds, ...items.map((it) => it.seconds), 60);
    const step = niceStep(maxSeconds / 4 || 1);
    const yMax = Math.ceil(maxSeconds / step) * step || step;
    // Room for the widest axis label ("2h 30m"), so none is clipped.
    let widest = 0;
    for (let v = 0; v <= yMax + 1e-9; v += step) widest = Math.max(widest, fmtDuration(v).length);
    const padL = Math.max(36, Math.ceil(widest * 7.8) + 10);
    const W = Math.max(padL + padR + items.length * (BAR_W + GAP) - GAP, 240);
    const y = (secs) => padT + plotH * (1 - secs / yMax);
    const grid = [];
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      grid.push(`<line class="trend-grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" /><text class="trend-axis" x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtDuration(v))}</text>`);
    }
    const bars = items.map((it, i) => {
      const bx = padL + i * (BAR_W + GAP);
      const bh = Math.max(2, plotH * (it.seconds / yMax));
      const by = padT + plotH - bh;
      return `<rect class="bar-chart-bar" data-i="${i}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${BAR_W}" height="${bh.toFixed(1)}" rx="3" />`;
    }).join('');
    const avgY = y(avgSeconds).toFixed(1);
    const geom = { items: items.map((it) => ({ label: it.label, sub: it.sub || '', seconds: it.seconds })) };
    return `
      <div class="bar-chart" data-geom='${esc(JSON.stringify(geom))}'>
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Duration per interaction, oldest to newest, with the average">
          ${grid.join('')}
          ${bars}
          <line class="bar-chart-avg" x1="${padL}" x2="${W - padR}" y1="${avgY}" y2="${avgY}" />
          <text class="bar-chart-avg-label" x="${(W - padR).toFixed(1)}" y="${(Number(avgY) - 4).toFixed(1)}" text-anchor="end">Avg ${esc(fmtDuration(avgSeconds))}</text>
        </svg>
        <div class="trend-tip hidden"></div>
      </div>`;
  }
  function wireBarChart(root) {
    (root || appEl).querySelectorAll('.bar-chart').forEach((box) => {
      const g = JSON.parse(box.dataset.geom);
      const tip = box.querySelector('.trend-tip');
      const bars = [...box.querySelectorAll('.bar-chart-bar')];
      const show = (bar) => {
        bars.forEach((b) => b.classList.toggle('active', b === bar));
        const it = g.items[Number(bar.dataset.i)];
        tip.innerHTML = `<strong>${esc(it.label)}</strong><div>${esc(fmtDuration(it.seconds))}${it.sub ? ` · ${esc(it.sub)}` : ''}</div>`;
        tip.classList.remove('hidden');
        // Positioned relative to the scrollport (`box`), not the (often much
        // wider) scrollable SVG inside it, so this stays correct however far
        // the chart has been scrolled.
        const boxRect = box.getBoundingClientRect();
        const barRect = bar.getBoundingClientRect();
        const left = barRect.left - boxRect.left + barRect.width / 2;
        tip.style.left = `${Math.min(Math.max(0, left - tip.offsetWidth / 2), box.clientWidth - tip.offsetWidth)}px`;
      };
      bars.forEach((bar) => bar.addEventListener('click', () => show(bar)));
    });
  }

  // Every dog's notes in one list (dogs still at the shelter): shared tips,
  // notes from walks, and your own private notes, newest first. Tapping a dog
  // opens its profile, where the tips and your note can be edited; the list
  // refreshes when that closes.
  async function renderAllNotes() {
    const myTab = state.tab;
    let data;
    try {
      data = await api(`/api/notes${state.notesMine ? '?scope=mine' : ''}`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('the notes', err, renderStats);
      return;
    }
    if (state.tab !== myTab || state.statsScope !== 'notes') return;
    // One species at a time, on the same Dogs / Cats switch as the stats.
    const species = statsSpecies();
    data = { ...data, dogs: data.dogs.filter((g) => (g.dog.species || 'dog') === species) };
    // A "walk" note is labeled by the dog it's actually about (walk vs. play
    // session), never by the asker's current Settings preference -- so a
    // dog's own species, not whoever's looking, decides the wording.
    const kindLabelFor = (dog, kind) => {
      if (kind === 'tip') return 'Tip';
      if (kind === 'playgroup') return state.notesMine ? 'From your playgroup' : 'From playgroup';
      if (kind === 'private') return 'Private · only you';
      const t = termsOf(dog);
      return state.notesMine ? `From your ${t.noun}` : `From ${aNoun(t)}`;
    };
    const groupHtml = (g) => `
      <div class="card compact all-notes-dog" data-dogid="${g.dog.id}">
        <div class="all-notes-head" role="button" tabindex="0">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${g.dog.photoUrl ? esc(thumbOf(g.dog.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(g.dog.name)}</p>
            ${akaHtml(g.dog)}
            <p class="dog-meta">${g.notes.length} note${g.notes.length === 1 ? '' : 's'}${g.dog.kennelLocation ? ` · 🏠 ${esc(g.dog.kennelLocation)}` : ''} · tap to open ›</p>
          </div>
        </div>
        <ul class="tip-list">
          ${g.notes.map((n) => `<li class="tip-item${(n.kind === 'walk' || n.kind === 'playgroup') ? ' tip-item-walk' : ''}">
            <span class="tip-bullet">•</span>
            <span class="tip-text">${noteBodyHtml(n.body, data.tagged)} <span class="tip-date">${kindLabelFor(g.dog, n.kind)} · ${fmtNoteDate(n.at)}</span></span>
          </li>`).join('')}
        </ul>
      </div>`;
    // A tag matches by the tagged animal's name, the way it reads.
    const matches = (g, q) => !q || dogNameMatches(g.dog, q) || g.notes.some((n) => window.PgTags.bodyText(n.body, data.tagged || {}).toLowerCase().includes(q));
    appEl.innerHTML = `
      ${statsScopeSwitchHtml()}
      <div class="seg seg-small" role="tablist" aria-label="Whose notes">
        <button type="button" class="seg-btn notes-scope-btn ${state.notesMine ? '' : 'on'}" data-mine="0" role="tab" aria-selected="${!state.notesMine}">All notes</button>
        <button type="button" class="seg-btn notes-scope-btn ${state.notesMine ? 'on' : ''}" data-mine="1" role="tab" aria-selected="${state.notesMine}">My notes</button>
      </div>
      <h2 class="section-heading" style="margin-top:0;">${state.notesMine ? 'My notes' : `All ${nounFor(statsSpeciesKeys())} notes`}</h2>
      ${data.dogs.length ? `<input type="search" id="allNotesSearch" class="all-notes-search" aria-label="Search notes by ${nounFor(statsSpeciesKeys())} or word" placeholder="Search by ${nounFor(statsSpeciesKeys())} or word…" value="${esc(state.notesQuery)}" />` : ''}
      <div class="stack tight" id="allNotesList"></div>
      <p class="small muted center" style="margin-top:14px;">${state.notesMine
    ? `${capFirst(nounFor(statsSpeciesKeys(), true))} still at the shelter. Your private notes and the notes from your ${termsFor(statsSpeciesKeys()).nouns}. Shared tips have no owner, so they're only under All notes.`
    : `${capFirst(nounFor(statsSpeciesKeys(), true))} still at the shelter. Tips and notes left at the end never show who wrote them; private notes are yours alone.`}</p>`;
    wireStatsScopeSwitch();
    appEl.querySelectorAll('.notes-scope-btn').forEach((b) => b.addEventListener('click', () => {
      const mine = b.dataset.mine === '1';
      if (mine === state.notesMine) return;
      state.notesMine = mine;
      renderAllNotes();
    }));
    const list = document.getElementById('allNotesList');
    const draw = () => {
      const q = state.notesQuery.trim().toLowerCase();
      const shown = data.dogs.filter((g) => matches(g, q));
      list.innerHTML = shown.length
        ? shown.map(groupHtml).join('')
        : `<div class="card compact center"><p class="muted" style="margin:0;">${data.dogs.length ? 'No notes match that search.'
          : state.notesMine ? `No notes of yours yet. Private notes and notes you leave at the end of ${aNoun(termsFor(statsSpeciesKeys()))} show up here. 🐾`
          : `No notes yet. Tips and notes for any ${nounFor(statsSpeciesKeys())} will show up here. 🐾`}</p></div>`;
      list.querySelectorAll('.all-notes-head').forEach((head) => {
        const open = async () => {
          try {
            const { dog, walks } = await api(`/api/dogs/${head.parentElement.dataset.dogid}?userId=${state.currentUser.id}`);
            showProfileSheet(dog, walks);
            const watch = new MutationObserver(() => {
              if (!profileSheet.classList.contains('hidden')) return;
              watch.disconnect();
              if (state.tab !== myTab || state.statsScope !== 'notes') return;
              const top = appEl.scrollTop;
              renderAllNotes().then(() => { appEl.scrollTop = top; });
            });
            watch.observe(profileSheet, { attributes: true, attributeFilter: ['class'] });
          } catch (err) { toast(err.message, 'error'); }
        };
        head.addEventListener('click', open);
        head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    };
    draw();
    const search = document.getElementById('allNotesSearch');
    if (search) search.addEventListener('input', () => { state.notesQuery = search.value; draw(); });
  }

  // Every dog's playgroup notes in one place, grouped by dog, newest
  // activity first. Reuses the desk's own /api/playgroup-notes -- unlike
  // /api/notes above, it isn't limited to dogs still at the shelter (the
  // desk already relies on seeing history for dogs who've since left), so a
  // dog here may show a "left" badge and still list its past sessions.
  // Tapping a dog opens the same playgroup popup the profile button does.
  async function renderPlaygroupStats() {
    const myTab = state.tab;
    let data;
    // eng (audit2): paged, PG_STATS_PAGE notes at a time (it was every note,
    // 672 KB); "Show older notes" and searching fetch the rest.
    const PG_STATS_PAGE = 150;
    try {
      data = await api(`/api/playgroup-notes?limit=${PG_STATS_PAGE}`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('the playgroup notes', err, renderStats);
      return;
    }
    if (state.tab !== myTab || state.statsScope !== 'playgroup') return;
    // One fetch at a time (a search typed fast asks on every key).
    let loadingMore = null;
    const loadMore = (all) => {
      if (!loadingMore) {
        loadingMore = api(`/api/playgroup-notes?offset=${data.nextOffset}&limit=${all ? 1000 : PG_STATS_PAGE}`).then((next) => {
          data = { ...next, notes: [...data.notes, ...next.notes], dogs: { ...data.dogs, ...next.dogs }, dogTotals: { ...data.dogTotals, ...next.dogTotals } };
          regroup();
        }).finally(() => { loadingMore = null; });
      }
      return loadingMore;
    };
    let groups = [];
    const regroup = () => {
      const byDog = new Map();
      for (const n of data.notes) {
        if (!byDog.has(n.dogId)) byDog.set(n.dogId, { dog: data.dogs[n.dogId] || { id: n.dogId, name: n.dogName, kennelLocation: n.kennelLocation }, notes: [] });
        byDog.get(n.dogId).notes.push(n);
      }
      // allNotes() already sorts each dog's own notes newest-first; sort the
      // dogs themselves by their most recent note.
      groups = [...byDog.values()].sort((a, b) => (b.notes[0].noteDate || '').localeCompare(a.notes[0].noteDate || ''));
    };
    regroup();
    // A dog's notes in all, even when older ones are on a later page.
    const noteCount = (g) => (data.dogTotals || {})[g.dog.id] || g.notes.length;
    const groupHtml = (g) => `
      <div class="card compact all-notes-dog" data-dogid="${g.dog.id}">
        <div class="all-notes-head" role="button" tabindex="0">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${g.dog.photoUrl ? esc(thumbOf(g.dog.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(g.dog.name)}${g.dog.stillListed === false ? ` <span class="badge neutral">${g.dog.adopted ? 'Adopted' : 'Left shelter'}</span>` : ''}</p>
            <p class="dog-meta">${noteCount(g)} note${noteCount(g) === 1 ? '' : 's'}${g.dog.kennelLocation ? ` · 🏠 ${esc(g.dog.kennelLocation)}` : ''} · tap to open ›</p>
          </div>
        </div>
        <ul class="pg-list">
          ${g.notes.map((n) => `<li class="pg-entry">
            <div class="pg-entry-head">
              <span class="pg-entry-date">${fmtPgDate(n.noteDate)}</span>
              ${n.author ? `<span class="small muted">— ${esc(n.author)}</span>` : ''}
            </div>
            <div class="pg-entry-body">${pgBodyHtml(n.body, data.dogs)}</div>
          </li>`).join('')}
        </ul>
      </div>`;
    const matches = (g, q) => !q || dogNameMatches(g.dog, q) || g.notes.some((n) => n.text.toLowerCase().includes(q) || (n.author || '').toLowerCase().includes(q));
    appEl.innerHTML = `
      ${statsScopeSwitchHtml()}
      <h2 class="section-heading" style="margin-top:0;">Playgroup notes</h2>
      ${data.notes.length ? `<input type="search" id="pgStatsSearch" class="all-notes-search" aria-label="Search playgroup notes by dog or word" placeholder="Search by dog or word…" value="${esc(state.pgStatsQuery)}" />` : ''}
      <div class="stack tight" id="pgStatsList"></div>
      <p class="small muted center" style="margin-top:14px;">Every playgroup note on record, including dogs who've since left the shelter. Tap a dog to open their notes and add one.</p>`;
    wireStatsScopeSwitch();
    const list = document.getElementById('pgStatsList');
    const draw = () => {
      const q = state.pgStatsQuery.trim().toLowerCase();
      // A search covers every note, so it fetches the pages not loaded yet.
      if (q && data.nextOffset != null) {
        loadMore(true).then(() => { if (state.tab === myTab && state.statsScope === 'playgroup') draw(); }).catch((err) => toast(err.message, 'error'));
        return;
      }
      const shown = groups.filter((g) => matches(g, q));
      list.innerHTML = (shown.length
        ? shown.map(groupHtml).join('')
        : `<div class="card compact center"><p class="muted" style="margin:0;">${groups.length ? 'No notes match that search.' : 'No playgroup notes yet. 🥎'}</p></div>`)
        + (data.nextOffset != null ? '<button type="button" class="btn" id="pgStatsMore" data-testid="pg-stats-more">Show older notes</button>' : '');
      list.querySelectorAll('.all-notes-head').forEach((head) => {
        const open = () => showPlaygroupNotes(head.parentElement.dataset.dogid);
        head.addEventListener('click', open);
        head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
      const more = document.getElementById('pgStatsMore');
      if (more) {
        more.addEventListener('click', async () => {
          more.disabled = true;
          try { await loadMore(false); draw(); } catch (err) { more.disabled = false; toast(err.message, 'error'); }
        });
      }
    };
    draw();
    const search = document.getElementById('pgStatsSearch');
    if (search) search.addEventListener('input', () => { state.pgStatsQuery = search.value; draw(); });
  }

  // ---------- Stats: dogs or cats, and the breakdowns ----------
  // Every number on My stats, Together and Shelter is for one species at a
  // time. Only someone who works with both (Settings) gets a Dogs / Cats
  // switch; it starts on the species the lists show, and switching it never
  // changes either. No combined "Both": it only showed the two side by side
  // (owner, 2026-11-09).
  const statsSpecies = () => {
    const keys = prefSpeciesKeys();
    return keys.includes(state.statsSpecies) ? state.statsSpecies : viewSpeciesKeys()[0];
  };
  const statsSpeciesKeys = () => [statsSpecies()];
  const inStatsSpecies = (w) => (w.species || 'dog') === statsSpecies();
  function statsSpeciesSwitchHtml() {
    if (!worksWithBoth()) return '';
    return `<div class="seg seg-small" role="tablist" aria-label="Which animals">${prefSpeciesKeys().map((k) => `<button type="button" class="seg-btn ${statsSpecies() === k ? 'on' : ''}" data-stats-species="${k}" role="tab" aria-selected="${statsSpecies() === k}">${speciesInfo(k).emoji} ${esc(speciesInfo(k).plural)}</button>`).join('')}</div>`;
  }
  function pickStatsSpecies(kind) {
    if (kind === statsSpecies()) return;
    state.statsSpecies = kind;
    state.statsView = 'summary';
    state.statsActivityFilter = null;
    state.togetherByActivity = false;
    renderStats();
  }
  function wireStatsSpeciesSwitch() {
    appEl.querySelectorAll('.seg-btn[data-stats-species]').forEach((b) => b.addEventListener('click', () => pickStatsSpecies(b.dataset.statsSpecies)));
  }

  // The same breakdowns /api/stats sends for Lifetime, worked out from a list
  // of walks (Today, one day): engagement type, POO as it was at the time
  // (poo_then), and kittens vs adults (is_young).
  function breakdownOfWalks(walks) {
    const group = (rows, keyName, keyOf, order) => {
      const map = new Map();
      for (const w of rows) {
        const key = keyOf(w);
        if (!map.has(key)) map.set(key, { [keyName]: key, count: 0, totalSeconds: 0, avgCount: 0, avgTotal: 0, ids: new Set() });
        const e = map.get(key);
        e.count += 1;
        e.totalSeconds += w.duration_seconds || 0;
        // The average leaves out mis-scans under a minute, like /api/stats
        // (avgCount); avgText() then says how many were left out.
        if ((w.duration_seconds || 0) >= SHARED_CONFIG.minAvgSeconds) { e.avgCount += 1; e.avgTotal += w.duration_seconds; }
        e.ids.add(w.dog_id);
      }
      const list = (order ? order.filter((k) => map.has(k)).map((k) => map.get(k)) : [...map.values()].sort((a, b) => b.count - a.count));
      return list.map(({ ids, avgTotal, ...e }) => ({ ...e, animals: ids.size, avgSeconds: e.avgCount ? avgTotal / e.avgCount : 0 }));
    };
    const done = walks.filter((w) => w.ended_at);
    return {
      byActivity: group(done, 'activity', (w) => w.activity || 'walk'),
      // Walks only: POO doesn't apply to a cuddle or playgroup.
      byPoo: group(done.filter((w) => w.poo_then && (w.activity || 'walk') === 'walk'), 'status', (w) => w.poo_then, ['priority', 'poo', 'none']),
      byAge: group(done.filter((w) => speciesOf(w).youngFirst), 'group', (w) => (w.is_young ? 'young' : 'adult'), ['young', 'adult'])
    };
  }

  const POO_GROUPS = {
    priority: { icon: `<span class="marker-dot poo-priority">${ASTERISK_SVG}</span>`, label: 'High priority POO' },
    poo: { icon: '<span class="marker-dot poo"></span>', label: 'POO (Potty Outside Only)' },
    none: { icon: '', label: 'Non-POO' }
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // A slice's share: a small one that rounds to nothing still reads as there.
  const pctLabel = (n, total) => {
    const pct = Math.round((n / total) * 100);
    if (pct === 0 && n > 0) return '<1%';
    // Next to other slices, never "100%" (99.6% rounds up): ">99%".
    if (pct === 100 && n < total) return '>99%';
    return `${pct}%`;
  };
  // "avg 26 min", and when engagements under a minute were left out of it
  // (avgCount, from the server), how many: the count and total cover them,
  // so without this the numbers don't add up.
  const avgText = (r) => {
    const skipped = r.avgCount != null ? r.count - r.avgCount : 0;
    // Nothing left to average: say so, never "avg 0 min".
    if (r.avgCount === 0 && r.count > 0) return 'all under a minute';
    return `avg ${fmtDuration(r.avgSeconds)}${skipped > 0 ? `, not counting ${skipped} under a minute` : ''}`;
  };
  // One breakdown as rows with a bar for each slice's share of the count.
  // `tap`: the data attribute that makes a row open something (or null).
  // `note`: a line under the title, given the slices' total. `sub`: drawn
  // indented under the breakdown before it, as a split of those same
  // engagements rather than a separate stat. `after(r)`: extra html right
  // under one row (the POO split under Walk).
  function breakdownRowsHtml(rows, { title, note, labelOf, nounOf, animalNoun, tap, sub, after }) {
    if (!rows || !rows.length) return '';
    const sum = rows.reduce((n, r) => n + r.count, 0);
    const total = sum || 1;
    const html = `<h3 class="bd-title">${title}</h3>${note ? `<p class="small muted bd-note">${note(sum)}</p>` : ''}
      <div class="bd-list">${rows.map((r) => {
        const pct = Math.round((r.count / total) * 100);
        const attr = tap ? ` ${tap(r)} role="button" tabindex="0"` : '';
        return `<div class="bd-row${tap ? ' bd-tap' : ''}"${attr}>
          <div class="bd-head"><span class="bd-label">${labelOf(r)}</span><span class="bd-pct">${pctLabel(r.count, total)}</span></div>
          <div class="bd-bar"><span style="width:${Math.max(pct, 2)}%"></span></div>
          <p class="bd-meta">${plural(r.count, ...nounOf(r))}${r.animals != null ? ` · ${plural(r.animals, ...animalNoun(r))}` : ''} · ${fmtDuration(r.totalSeconds)} total · ${avgText(r)}${tap ? ' ›' : ''}</p>
        </div>${after ? after(r) : ''}`;
      }).join('')}</div>`;
    return sub ? `<div class="bd-sub">${html}</div>` : html;
  }
  // Every breakdown that applies to what's on screen. `mine`: rows open the
  // personal drill-downs (Together has none, see renderTogetherByActivity).
  function statsBreakdownsHtml(b, { mine }) {
    const animalNoun = (kind) => () => [speciesInfo(kind).noun, speciesInfo(kind).plural.toLowerCase()];
    const anyNoun = animalNoun(statsSpecies());
    const engagements = () => ['engagement', 'engagements'];
    // POO only means something for a walk, so its split sits right under
    // the Walk row (and counts walks only), never after the whole list.
    const pooHtml = breakdownRowsHtml(b.byPoo, {
      title: '↳ POO vs non-POO dogs',
      note: (n) => `${n === 1 ? 'The 1 walk above' : `All ${n} walks above`}, split by the POO sticker the dog had at the time.`,
      labelOf: (r) => `${POO_GROUPS[r.status].icon} ${POO_GROUPS[r.status].label}`,
      nounOf: () => ['walk', 'walks'], animalNoun: animalNoun('dog'), sub: true
    });
    const walkRow = (b.byActivity || []).some((r) => r.activity === 'walk');
    return [
      breakdownRowsHtml(b.byActivity, {
        title: 'By activity',
        labelOf: (r) => `${activityInfo(r.activity).emoji} ${activityInfo(r.activity).label}`,
        nounOf: (r) => activityCountNouns(activityInfo(r.activity)), animalNoun: anyNoun,
        tap: mine ? (r) => `data-bd-activity="${esc(r.activity)}"` : null,
        after: (r) => (r.activity === 'walk' ? pooHtml : '')
      }),
      walkRow ? '' : pooHtml,
      breakdownRowsHtml(b.byAge, {
        title: '↳ Kittens vs adult cats',
        note: (n) => `${n === 1 ? 'The 1 cat engagement above' : `All ${n} cat engagements above`}, split by age.`,
        labelOf: (r) => (r.group === 'young' ? '🍼 Kittens' : '🐈 Adult cats'),
        nounOf: engagements, animalNoun: animalNoun('cat'), sub: true
      })
    ].join('');
  }
  function wireStatsBreakdowns(scope) {
    appEl.querySelectorAll('.bd-row[data-bd-activity]').forEach((row) => {
      const open = () => statsDrill(() => {
        state.statsBreakdownScope = scope;
        state.statsActivityFilter = row.dataset.bdActivity;
        state.statsActivityShowAll = false;
        state.statsView = 'byActivityDog';
      });
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // The makeup of "at the shelter now" (from /api/impact's shelterNow, one
  // species -- the Shelter tab's own switch -- at a time): dogs walkable for
  // your level, POO and non-POO; kittens and adult cats. The plain counts
  // are the tile row above this (and their trend over time, below); each of
  // these opens the matching filtered list on Available, since "how many"
  // is rarely as useful here as "which ones" (owner, 2026-11-10).
  function shelterBreakdownHtml(now, kind) {
    if (!now) return '';
    const { counts } = now;
    const info = speciesInfo(kind);
    const n = (key) => counts[key] || 0;
    const tile = (value, label, sub, markerFilters) => `<div class="stat-tile stats-drilldown-tile" data-shelter-drill="${esc(JSON.stringify(markerFilters))}" style="cursor:pointer;"><div class="value">${value}</div><div class="label">${label} ›</div>${sub ? `<div class="label sub">${sub}</div>` : ''}</div>`;
    const tiles = [];
    if (info.levelRules) tiles.push(tile(n('walkable'), `${capFirst(termsFor([kind]).verb)}able for your level`, '', { walkable: 'only' }));
    if (info.stickers) {
      const poo = n('poo') + n('priority');
      tiles.push(tile(poo, 'POO dogs', n('priority') ? `${n('priority')} high priority` : '', { poo: 'only', poo_priority: 'only' }));
      tiles.push(tile(n('nonPoo'), 'Non-POO dogs', '', { poo: 'hide', poo_priority: 'hide' }));
    }
    if (info.youngFirst) {
      tiles.push(tile(n('young'), 'Kittens', '', { young: 'only' }));
      tiles.push(tile(n('adult'), 'Adult cats', '', { young: 'hide' }));
    }
    if (!tiles.length) return '';
    return `<div class="stat-grid${tiles.length === 3 ? ' three' : ''}">${tiles.join('')}</div>`;
  }
  // Starts a tile's drill-down from a clean filter state -- a filter left
  // over from earlier browsing could otherwise narrow the result further
  // without it being obvious why the list looks wrong.
  function goToShelterDrilldown(markerFilters, kind) {
    state.markerFilters = { ...markerFilters };
    state.filterMatch = 'all';
    state.locationFilter = new Set();
    state.presetMinDaysAtLeast = null;
    state.ageMinYears = null;
    state.ageMaxYears = null;
    state.minShelterDays = null;
    state.needsShiftWalkOnly = false;
    state.showFoster = false;
    state.availableSearch = '';
    state.showMoreFilters = true;
    state.filtersTab = 'filters';
    setSpeciesView(kind);
    switchTab('available');
  }
  function wireShelterBreakdown(kind) {
    appEl.querySelectorAll('[data-shelter-drill]').forEach((el) => {
      el.addEventListener('click', () => goToShelterDrilldown(JSON.parse(el.dataset.shelterDrill), kind));
    });
  }

  // Every one of this volunteer's engagements, a page of 1000 at a time:
  // a long history (Lifetime's visits, the avg chart) must not stop at the
  // first page and disagree with the server's totals.
  const MY_WALKS_PAGE = 1000;
  async function fetchMyWalks() {
    const walks = [];
    const tagged = {};
    for (let offset = 0; ; offset += MY_WALKS_PAGE) {
      const page = await api(`/api/walks?limit=${MY_WALKS_PAGE}&offset=${offset}&userId=${state.currentUser.id}`);
      walks.push(...(page.walks || []));
      Object.assign(tagged, page.tagged || {});
      if (!page.walks || page.walks.length < MY_WALKS_PAGE || offset >= 50 * MY_WALKS_PAGE) break;
    }
    return { walks, tagged };
  }

  async function renderStats() {
    if (state.statsScope === 'playgroup' && !showsPlaygroupTab()) state.statsScope = 'mine';
    if (state.statsScope === 'notes') {
      appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      return renderAllNotes();
    }
    if (state.statsScope === 'playgroup') {
      appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      return renderPlaygroupStats();
    }
    if (state.statsScope === 'shelter') {
      appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      return renderShelterTrends();
    }
    if (state.statsScope === 'together') {
      if (state.togetherDay) return renderTogetherDay();
      if (state.togetherAvgChart) return renderTogetherAvgChart();
      if (state.togetherByActivity) return renderTogetherByActivity();
      appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      return renderTogether();
    }
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    const myTab = state.tab;
    let data;
    let walksData;
    try {
      [data, walksData] = await Promise.all([
        api(`/api/stats?userId=${state.currentUser.id}&species=${statsSpecies()}`),
        fetchMyWalks()
      ]);
    } catch (err) {
      if (state.tab === myTab) showLoadError('your stats', err, renderStats);
      return;
    }
    if (state.tab !== myTab) return;
    // Only the species picked on the Dogs / Cats switch.
    const myWalks = walksData.walks.filter(inStatsSpecies);
    state.statsTagged = walksData.tagged || {};
    state.statsDays = groupWalksByDay(myWalks);

    if (state.statsView === 'day') {
      return renderStatsDay();
    }
    if (state.statsView === 'byActivity') {
      return renderStatsByActivity(data, myWalks);
    }
    if (state.statsView === 'byActivityDog') {
      return renderStatsByActivityDog(data, myWalks);
    }
    if (state.statsView === 'avgChart') {
      return renderStatsAvgChart(myWalks);
    }
    if (state.statsView === 'byDogScope') {
      return renderStatsByDogScope(myWalks);
    }

    if (state.statsRange !== 'lifetime') {
      return renderStatsToday(myWalks, data);
    }

    const t = data.totals;
    // Lifetime wording follows the species actually walked/cuddled/etc,
    // never the volunteer's current Settings preference -- see
    // historySpeciesKeys above.
    const lifetimeKeys = statsSpeciesKeys(data.perDog);
    const lw = statWords(lifetimeKeys, { count: t.totalWalks, unique: t.uniqueDogs });
    const heading = statsScopeSwitchHtml() + `<h2 class="section-heading" style="margin-top:0;">Lifetime stats</h2>`;
    const rangeToggle = `<button type="button" id="statsRangeToggle" class="btn primary" style="margin-bottom:10px;">View today's stats</button>`;
    const tiles = `
      <div class="stat-grid">
        ${statDrillTile(t.totalWalks, lw.count, 'byActivity')}
        ${statDrillTile(t.uniqueDogs, lw.unique, 'byDogSection')}
        ${statDrillTile(fmtDuration(t.totalSeconds), lw.time, 'byActivity')}
        ${t.totalWalks && !t.avgSeconds
    ? statDrillTile('–', lifetimeAvgLabel(data.byActivity, lifetimeKeys), 'avgChart', 'All under a minute')
    : statDrillTile(fmtDuration(t.avgSeconds), lifetimeAvgLabel(data.byActivity, lifetimeKeys), 'avgChart')}
      </div>`;
    const lifetimeBreakdowns = statsBreakdownsHtml({ byActivity: data.byActivity, byPoo: data.byPoo, byAge: data.byAge }, { mine: true });
    if (!data.perDog.length) {
      appEl.innerHTML = heading + rangeToggle + tiles + `<p class="empty-state">No completed ${lw.nounsWord} yet.</p>`;
      wireStatsRangeToggle();
      wireStatDrillTiles('lifetime');
      wireStatsBreakdowns('lifetime');
      return;
    }

    const dayRow = (day) => {
      const dKeys = historySpeciesKeys(day.walks);
      const dw = statWords(dKeys);
      return `
      <div class="card dog-card" data-daykey="${esc(day.key)}" role="button" tabindex="0">
        <div class="dog-info">
          <p class="dog-name">${fmtDayHeading(day.key)}</p>
          <p class="dog-meta">${day.dogCount} ${nounFor(dKeys, day.dogCount !== 1)} · ${plural(day.walkCount, dw.noun, dw.nounsWord)}</p>
          <p class="dog-meta">${fmtClockRange(day.firstStart, day.lastEnd)}</p>
        </div>
        <span class="muted">›</span>
      </div>`;
    };
    // Visits grouped by month, collapsed except the newest, so a long history
    // doesn't push By Dog far down the page.
    const dayRows = visitMonthsHtml(state.statsDays, (day) => day.key, dayRow,
      (days) => {
        const walks = days.reduce((n, d) => n + d.walkCount, 0);
        const mw = statWords(historySpeciesKeys(days.flatMap((d) => d.walks)));
        return `${days.length} shelter visit${days.length === 1 ? '' : 's'} · ${plural(walks, mw.noun, mw.nounsWord)}`;
      },
      'statsOpenMonths');

    state.statsPerDogRaw = data.perDog;
    const presentCount = data.perDog.filter((d) => d.stillListed).length;
    const byDogFilterRow = `
      <label class="small muted" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <input type="checkbox" id="statsPresentOnlyCheck" ${state.statsPresentOnly ? 'checked' : ''} />
        Only show ${nounFor(lifetimeKeys, true)} still at the shelter (${presentCount} of ${data.perDog.length})
      </label>`;
    const byDogRows = renderByDogRows(data.perDog);

    appEl.innerHTML = heading + rangeToggle + tiles +
      `<div class="card compact bd-card">${lifetimeBreakdowns}</div>` +
      `<h2 class="section-heading">Shelter visits</h2><div class="stack tight">${dayRows}</div>` +
      `<h2 class="section-heading" id="statsByDogHeading">By ${capFirst(nounFor(lifetimeKeys))}</h2>${byDogFilterRow}<div class="stack" id="byDogList">${byDogRows}</div>`;

    wireStatsRangeToggle();
    wireStatDrillTiles('lifetime');
    wireStatsBreakdowns('lifetime');
    wireByDogList();
    wireVisitMonths('statsOpenMonths');
    document.getElementById('statsPresentOnlyCheck').addEventListener('change', (e) => {
      state.statsPresentOnly = e.target.checked;
      document.getElementById('byDogList').innerHTML = renderByDogRows(state.statsPerDogRaw);
      wireByDogList();
    });
    // Back from a visit day lands on the same spot in the list (audit 3).
    if (state.statsReturnScroll != null) { restoreScroll(state.statsReturnScroll); state.statsReturnScroll = null; }
    appEl.querySelectorAll('[data-daykey]').forEach((card) => {
      const open = () => statsDrill(() => {
        state.statsReturnScroll = appEl.scrollTop;
        state.selectedDateKey = card.dataset.daykey;
        state.selectedShiftIndex = null;
        state.statsView = 'day';
      });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // A stat tile that opens a drill-down instead of just displaying a number.
  // `drill` is the statsView to switch to -- 'byDogSection' is special: it
  // doesn't navigate, it scrolls the already-visible By Dog list into view
  // (only Lifetime has one on the same page; Today/Day get their own
  // 'byDogScope' screen instead, wired the normal way).
  function statDrillTile(value, label, drill, sub) {
    return `<div class="stat-tile stats-drilldown-tile" data-drill="${drill}" role="button" tabindex="0" style="cursor:pointer;"><div class="value">${value}</div><div class="label">${label} ›</div>${sub ? `<div class="label sub">${sub}</div>` : ''}</div>`;
  }
  // An average tile over these rows: "–" and "All under a minute" when every
  // one was a mis-scan, never "0 min".
  function avgDrillTile(walks, label) {
    const pick = avgPick(walks);
    if (!pick.rows.length && pick.skipped) return statDrillTile('–', label, 'avgChart', 'All under a minute');
    return statDrillTile(fmtDuration(walkOnlyAvgSeconds(walks)), label, 'avgChart');
  }

  // ---- Stats drill-downs and the Back button ----
  // Every drill-down (a day, a breakdown, a chart, a Together day...) is a
  // history step, like a scanned dog: the phone's Back closes it and lands
  // on the Stats screen it came from, never on Available. Each step carries
  // the drill state it shows (statsNav); the popstate handler puts it back.
  // (Function declarations, not consts: pushHistory, near the top, calls them.)
  function statsNavState() {
    const nav = {};
    for (const k of ['statsView', 'statsBreakdownScope', 'statsActivityFilter', 'selectedDateKey', 'selectedShiftIndex', 'togetherDay', 'togetherAvgChart', 'togetherByActivity']) {
      nav[k] = state[k] === undefined ? null : state[k];
    }
    return nav;
  }
  // nav null: the top of Stats (whichever scope tab is on).
  function applyStatsNav(nav) {
    Object.assign(state, { statsView: 'summary', statsActivityFilter: null, selectedShiftIndex: null, togetherDay: null, togetherAvgChart: null, togetherByActivity: false }, nav || {});
  }
  function sameStatsNav(nav) {
    const now = statsNavState();
    applyStatsNav(nav);
    const next = statsNavState();
    Object.assign(state, now);
    return JSON.stringify(now) === JSON.stringify(next);
  }
  // Open a drill-down: change the state, add the history step, show it.
  function statsDrill(change) {
    change();
    pushHistory({ statsNav: statsNavState(), statsDrill: true });
    renderStats();
  }
  // An on-screen "← Back": the same as the phone's Back when this screen is
  // a step of its own, else (an older entry) just go up a level.
  function statsBack(fallback) {
    if (history.state && history.state.statsDrill && state.tab === 'stats') { history.back(); return; }
    fallback();
    renderStats();
  }
  function wireStatDrillTiles(scope) {
    appEl.querySelectorAll('.stat-tile[data-drill]').forEach((tile) => {
      tile.addEventListener('click', () => {
        if (tile.dataset.drill === 'byDogSection') {
          const target = document.getElementById('statsByDogHeading');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        statsDrill(() => {
          state.statsBreakdownScope = scope;
          state.statsView = tile.dataset.drill;
        });
      });
    });
  }
  // Today/Day's breakdown, chart and by-dog screens are computed client-side
  // from the walks already on the page (no extra round-trip, and these
  // shared fetchMyWalks() has every one of them); Lifetime keeps using the server's
  // accurate, unbounded totals. Returns null for 'lifetime' so callers know
  // to fall back to the server data they already have.
  function statsBreakdownSourceWalks(allWalks) {
    if (state.statsBreakdownScope === 'today') return allWalks.filter((w) => w.ended_at && dateKey(w.started_at) === todayKey());
    if (state.statsBreakdownScope === 'day') {
      const day = state.statsDays.find((d) => d.key === state.selectedDateKey);
      return day ? day.walks : [];
    }
    return null;
  }
  function backFromStatsBreakdown() {
    statsBack(() => { state.statsView = state.statsBreakdownScope === 'day' ? 'day' : 'summary'; });
  }
  function byActivityOf(walks) {
    const map = new Map();
    for (const w of walks) {
      const key = w.activity || 'walk';
      if (!map.has(key)) map.set(key, { activity: key, count: 0, totalSeconds: 0, avgCount: 0, avgTotal: 0 });
      const e = map.get(key);
      e.count += 1;
      e.totalSeconds += w.duration_seconds || 0;
      // Mis-scans under a minute stay out of the average (avgText says so).
      if ((w.duration_seconds || 0) >= SHARED_CONFIG.minAvgSeconds) { e.avgCount += 1; e.avgTotal += w.duration_seconds; }
    }
    return [...map.values()].map(({ avgTotal, ...e }) => ({ ...e, avgSeconds: e.avgCount ? avgTotal / e.avgCount : 0 })).sort((a, b) => b.count - a.count);
  }
  // Shaped like /api/stats's perDog, for renderByDogRows -- still_listed
  // isn't on a walk row, so these always read as present (fine: Today/Day
  // dogs are virtually certain to still be listed; Lifetime's own By Dog
  // list, which does know, is a scroll away via 'byDogSection').
  function byDogOf(walks) {
    const map = new Map();
    for (const w of walks) {
      if (!map.has(w.dog_id)) {
        map.set(w.dog_id, {
          id: w.dog_id, name: w.dog_name, photo_url: w.photo_url, species: w.species,
          stillListed: true, removedAt: null,
          blue_markers: w.blue_markers, poo_status: w.poo_status, star_flag: w.star_flag, pb_flag: w.pb_flag,
          walkCount: 0, totalSeconds: 0, lastWalkedAt: null
        });
      }
      const e = map.get(w.dog_id);
      e.walkCount += 1;
      e.totalSeconds += w.duration_seconds || 0;
      if (!e.lastWalkedAt || w.started_at > e.lastWalkedAt) e.lastWalkedAt = w.started_at;
    }
    return [...map.values()].sort((a, b) => b.walkCount - a.walkCount || (b.lastWalkedAt || '').localeCompare(a.lastWalkedAt || ''));
  }

  // "By Activity": a breakdown of every kind of interaction in the current
  // scope (a dog person might see Walk, Cuddle, Playgroup, Daycation; a cat
  // person just Cuddle and Matchmaking). Tapping one drills into which dogs
  // it was with, reusing the By Dog list filtered down.
  function renderStatsByActivity(data, allWalks) {
    const scopeWalks = statsBreakdownSourceWalks(allWalks);
    const byActivity = scopeWalks ? byActivityOf(scopeWalks) : data.byActivity;
    const heading = `<button id="backToStatsBtn" class="btn back-btn">← Back to Stats</button><h2 class="section-heading" style="margin-top:0;">By activity</h2>`;
    const rows = byActivity.map((a) => {
      const info = activityInfo(a.activity);
      return `
      <div class="card dog-card" data-activity="${esc(a.activity)}" role="button" tabindex="0">
        <div class="dog-info">
          <p class="dog-name">${info.emoji} ${info.label}</p>
          <p class="dog-meta">${activityCount(info, a.count)} · ${fmtDuration(a.totalSeconds)} total · ${avgText(a)}</p>
        </div>
        <span class="muted">›</span>
      </div>`;
    }).join('');
    appEl.innerHTML = heading +
      (byActivity.length ? `<div class="stack tight">${rows}</div>` : `<p class="empty-state">No completed engagements yet.</p>`);
    document.getElementById('backToStatsBtn').addEventListener('click', backFromStatsBreakdown);
    appEl.querySelectorAll('[data-activity]').forEach((card) => {
      const open = () => statsDrill(() => {
        state.statsActivityFilter = card.dataset.activity;
        state.statsActivityShowAll = false;
        state.statsView = 'byActivityDog';
      });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // Which dogs one activity type was with, for the volunteer drilling in from
  // By Activity -- same By Dog card list, scoped to just that activity.
  // Lifetime fetches the server's accurate totals; Today/Day compute from
  // the walks already on the page.
  // How many of your sessions the activity drill-down lists before "Show all".
  const ACTIVITY_SESSIONS_SHOWN = 20;
  async function renderStatsByActivityDog(data, allWalks) {
    const myTab = state.tab;
    const activity = state.statsActivityFilter;
    const info = activityInfo(activity);
    const scopeWalks = statsBreakdownSourceWalks(allWalks);
    let perDog;
    let totals;
    if (scopeWalks) {
      const filtered = scopeWalks.filter((w) => (w.activity || 'walk') === activity);
      perDog = byDogOf(filtered);
      const totalSeconds = filtered.reduce((s, w) => s + (w.duration_seconds || 0), 0);
      // The average leaves out mis-scans under a minute, as everywhere else.
      const counted = filtered.filter((w) => (w.duration_seconds || 0) >= SHARED_CONFIG.minAvgSeconds);
      totals = {
        totalWalks: filtered.length, uniqueDogs: perDog.length, totalSeconds,
        avgSeconds: counted.length ? counted.reduce((s, w) => s + w.duration_seconds, 0) / counted.length : 0,
        avgCount: counted.length
      };
    } else {
      appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
      let apiData;
      try {
        apiData = await api(`/api/stats?userId=${state.currentUser.id}&activity=${encodeURIComponent(activity)}&species=${statsSpecies()}`);
      } catch (err) {
        if (state.tab === myTab) showLoadError('that breakdown', err, renderStats);
        return;
      }
      if (state.tab !== myTab) return;
      perDog = apiData.perDog;
      totals = apiData.totals;
    }
    const heading = `<button id="backToActivityBtn" class="btn back-btn">← Back to By activity</button><h2 class="section-heading" style="margin-top:0;">${info.emoji} ${info.label}</h2>`;
    const tiles = `
      <div class="stat-grid">
        <div class="stat-tile"><div class="value">${totals.totalWalks}</div><div class="label">${capFirst(activityCountNouns(info)[totals.totalWalks === 1 ? 0 : 1])}</div></div>
        <div class="stat-tile"><div class="value">${totals.uniqueDogs}</div><div class="label">${capFirst(nounFor(statsSpeciesKeys(perDog), totals.uniqueDogs !== 1))}</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(totals.totalSeconds)}</div><div class="label">Total time</div></div>
        <div class="stat-tile"><div class="value">${totals.avgCount === 0 && totals.totalWalks ? '–' : fmtDuration(totals.avgSeconds)}</div><div class="label">Avg ${esc(info.noun)} length</div>${totals.avgCount != null && totals.totalWalks > totals.avgCount ? `<div class="label sub">${totals.avgCount === 0 ? 'All under a minute' : `Not counting ${totals.totalWalks - totals.avgCount} under a minute`}</div>` : ''}</div>
      </div>`;
    state.statsPerDogRaw = perDog;
    // One list of your own sessions of this activity, grouped by animal or
    // by date (the switch shows only when there's more than one animal, as
    // otherwise both are the same list). Each session edits only itself --
    // activity, times, delete -- so one logged as the wrong activity (a
    // cuddle that was really a walk) can be fixed right here.
    const sessions = (scopeWalks || allWalks)
      .filter((w) => (w.activity || 'walk') === activity && w.ended_at)
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    const animalWord = nounFor(statsSpeciesKeys(perDog));
    const groupKey = perDog.length > 1 && state.statsActivityGroup === 'date' ? 'date' : 'dog';
    const limit = state.statsActivityShowAll ? Infinity : ACTIVITY_SESSIONS_SHOWN;
    const shown = sessions.slice(0, limit);
    const datePrefix = (w) => `<span class="small muted">${fmtDate(w.started_at)}</span> `;
    let listHtml;
    if (groupKey === 'date') {
      listHtml = shown.map((w) => statsWalkCardHtml(w, datePrefix(w), { sessionOnly: true })).join('');
    } else {
      // Animals in the same order as before (most engaged first); sessions
      // newest first under each, up to the same overall limit.
      let left = limit;
      listHtml = perDog.map((d) => {
        if (left <= 0) return '';
        const own = sessions.filter((w) => String(w.dog_id) === String(d.id)).slice(0, left);
        if (!own.length) return '';
        left -= own.length;
        return activityDogGroupHtml(d, info, own.map((w) => statsWalkCardHtml(w, datePrefix(w), { sessionOnly: true, underDog: true })).join(''));
      }).join('');
    }
    const groupSwitch = perDog.length > 1 ? `
      <div class="seg seg-small" role="radiogroup" aria-label="Group by" style="margin:0 0 8px;">
        <button type="button" class="seg-btn ${groupKey === 'dog' ? 'on' : ''}" data-activity-group="dog" role="radio" aria-checked="${groupKey === 'dog'}">By ${esc(animalWord)}</button>
        <button type="button" class="seg-btn ${groupKey === 'date' ? 'on' : ''}" data-activity-group="date" role="radio" aria-checked="${groupKey === 'date'}">By date</button>
      </div>` : '';
    appEl.innerHTML = heading + tiles +
      (sessions.length
        ? `<h2 class="section-heading">Your ${esc(activityCountNouns(info)[1])}</h2>
           <p class="small muted" style="margin-top:-6px;">Tap a ${esc(info.noun)}'s ✎ to fix its times or change the activity.</p>
           ${groupSwitch}
           <div class="stack" id="byDogList">${listHtml}</div>
           ${sessions.length > shown.length ? `<button id="showAllSessionsBtn" class="btn" style="margin-top:8px;">Show all ${sessions.length}</button>` : ''}`
        : `<p class="empty-state">No completed ${activityCountNouns(info)[1]} yet.</p>`);
    document.getElementById('backToActivityBtn').addEventListener('click', () => statsBack(() => { state.statsActivityShowAll = false; state.statsView = 'byActivity'; }));
    const rerender = () => renderStatsByActivityDog(data, allWalks);
    appEl.querySelectorAll('[data-activity-group]').forEach((btn) => btn.addEventListener('click', () => {
      state.statsActivityGroup = btn.dataset.activityGroup;
      rerender();
    }));
    const showAllBtn = document.getElementById('showAllSessionsBtn');
    if (showAllBtn) showAllBtn.addEventListener('click', () => { state.statsActivityShowAll = true; rerender(); });
    if (sessions.length) {
      wireStatsWalkCards(null, () => renderStats());
      wireByDogList();
      appEl.querySelectorAll('.animal-edit-btn').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showDogEditPopup(btn.dataset.id);
      }));
    }
  }

  // One animal's heading on the activity drill-down (photo, name, its
  // count and total) with its sessions under it. Editing the animal
  // (stickers, kennel) is its own button, apart from each session's ✎, and
  // never starts anything.
  function activityDogGroupHtml(d, info, sessionsHtml) {
    const markerDog = {
      id: d.id,
      blueMarkers: d.blue_markers ? JSON.parse(d.blue_markers) : [],
      pooStatus: d.poo_status || 'none',
      starFlag: !!d.star_flag,
      pbFlag: !!d.pb_flag
    };
    const nouns = activityCountNouns(info);
    const t = termsOf({ species: d.species });
    return `
      <div class="card compact" data-id="${d.id}">
        <div class="dog-card">
          <img loading="lazy" decoding="async" class="dog-photo" src="${d.photo_url ? esc(thumbOf(d.photo_url)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges({ ...markerDog, name: d.name })}${d.stillListed ? '' : ` <span class="badge neutral">Adopted/Removed${d.removedAt ? ' ' + fmtDate(d.removedAt) : ''}</span>`}</p>
            <p class="dog-meta">${d.walkCount} ${d.walkCount === 1 ? nouns[0] : nouns[1]} · ${fmtDuration(d.totalSeconds)} total</p>
            <div class="row" style="margin-top:6px;">
              <button class="btn small-btn view-profile-btn" data-id="${d.id}">View info</button>
              <button class="btn small-btn walk-history-btn" data-dog-id="${d.id}" title="${capFirst(t.noun)} history" aria-label="${capFirst(t.noun)} history" style="flex:0 0 auto;width:auto;">🕘</button>
              <button class="btn small-btn animal-edit-btn" data-id="${d.id}">${speciesOf(d).emoji} Edit ${esc(speciesOf(d).noun)}</button>
            </div>
          </div>
        </div>
        ${sessionsHtml}
      </div>`;
  }

  // The drill-down behind "Avg length": a bar per interaction, oldest to
  // newest, against a dashed average line. Only ever the activity the
  // average itself is based on (walk-only, with the same all-activities
  // fallback for a volunteer who's never logged a walk -- see
  // walkOnlyAvgSeconds), so the chart never shows a number the tile's own
  // average doesn't.
  function renderStatsAvgChart(allWalks) {
    // Finished ones only (a walk in progress has no length yet), and the
    // same rows as the tile's walkOnlyAvgSeconds: walks of a minute or more,
    // else every engagement.
    const scopeWalks = (statsBreakdownSourceWalks(allWalks) || allWalks).filter(rowEnded);
    // Exactly the rows the tile averaged (avgPick): mis-scans under a
    // minute get no bar, and the caption says how many were left out.
    const pick = avgPick(scopeWalks);
    const ordered = [...pick.rows].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    const avgSeconds = walkOnlyAvgSeconds(scopeWalks);
    const items = ordered.map((w) => ({ label: w.dog_name, seconds: w.duration_seconds || 0, sub: `${fmtDate(w.started_at)} · ${fmtClock(w.started_at)}` }));
    // Named after what it's of: "Walk length" only when it's walks.
    const word = avgLabelFor(scopeWalks).replace(/^Average /, '');
    const countWords = [word, `${word}s`];
    const heading = `<button id="backToStatsBtn" class="btn back-btn">← Back to Stats</button><h2 class="section-heading" style="margin-top:0;">${capFirst(word)} length, oldest to newest</h2>`;
    // Nothing averaged (no walks today, or only mis-scans): a dash, and no
    // "tap a bar" with no bars (audit 3).
    const caption = ordered.length
      ? `${ordered.length} ${ordered.length === 1 ? countWords[0] : countWords[1]} · avg ${fmtDuration(avgSeconds)}${skippedNote(pick.skipped)} · tap a bar for details`
      : (pick.skipped ? `All ${pick.skipped} under a minute, so there's no average` : `Nothing finished yet · avg –`);
    appEl.innerHTML = heading +
      `<p class="small muted" style="margin-top:-6px;">${caption}</p>` +
      `<div class="card compact">${durationBarChartHtml(items, avgSeconds)}</div>`;
    document.getElementById('backToStatsBtn').addEventListener('click', backFromStatsBreakdown);
    wireBarChart();
  }

  // The drill-down behind "Dogs/Cats walked" on Today's Stats and the day
  // view (Lifetime's own tile scrolls to its existing By Dog list instead).
  function renderStatsByDogScope(allWalks) {
    const scopeWalks = statsBreakdownSourceWalks(allWalks) || [];
    const perDog = byDogOf(scopeWalks);
    const keys = statsSpeciesKeys(scopeWalks);
    const sw = statWords(keys);
    const heading = `<button id="backToStatsBtn" class="btn back-btn">← Back to Stats</button><h2 class="section-heading" style="margin-top:0;">${sw.unique}</h2>`;
    appEl.innerHTML = heading +
      (perDog.length ? `<div class="stack" id="byDogList">${renderByDogRows(perDog)}</div>` : `<p class="empty-state">No completed ${sw.nounsWord} yet.</p>`);
    document.getElementById('backToStatsBtn').addEventListener('click', backFromStatsBreakdown);
    if (perDog.length) wireByDogList();
  }

  function wireStatsRangeToggle() {
    wireStatsScopeSwitch();
    const btn = document.getElementById('statsRangeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.statsRange = state.statsRange === 'lifetime' ? 'today' : 'lifetime';
      renderStats();
    });
  }

  // One completed walk as an editable card (times, activity, delete,
  // original-times badge, and a shortcut to the dog's tips/private note).
  // Works mid-walk too, so notes left for later can be caught up on while
  // out with the next dog.
  // Shared by the Today view and the per-day view so editing works the same
  // from either -- no need to detour through lifetime stats.
  // opts.sessionOnly: the session's own edits (activity, times, delete) plus
  // a separate "Edit dog" (stickers, kennel), instead of the notes shortcut. opts.underDog: listed under the
  // dog's own heading, so no photo or name again either.
  function statsWalkCardHtml(w, prefix, opts = {}) {
    const dogPart = opts.underDog ? '' : ` ${esc(w.dog_name)} ${markerBadges({ id: w.dog_id, blueMarkers: w.blue_markers ? JSON.parse(w.blue_markers) : [], pooStatus: w.poo_status || 'none', starFlag: !!w.star_flag, pbFlag: !!w.pb_flag, name: w.dog_name })}`;
    return `
      <div class="${opts.underDog ? 'session-row' : 'card dog-card'}" data-dogid="${w.dog_id}">
        ${opts.underDog ? '' : `<img loading="lazy" decoding="async" class="dog-photo" src="${w.photo_url ? esc(thumbOf(w.photo_url)) : '/icons/icon-192.png'}" alt="" />`}
        <div class="dog-info">
          <p class="dog-name">${prefix}<span title="${activityInfo(w.activity).label}">${activityInfo(w.activity).emoji}</span>${dogPart} ${w.manual_entry ? '<span class="badge neutral">Manually added</span>' : ''}${w.auto_stopped ? '<span class="badge auto-stopped" title="This walk hit the time limit and was ended automatically. Edit the time if it ran longer.">Auto-stopped</span>' : ''}${!w.manual_entry && w.edited ? '<span class="badge neutral edited-badge" data-id="' + w.id + '" style="cursor:pointer;" title="Tap to see the original scanned times">Edited ✎</span>' : ''}</p>
          <p class="dog-meta walk-times-display" data-id="${w.id}">${fmtClockRange(w.started_at, w.ended_at)} · ${fmtDuration(w.duration_seconds)}</p>
          ${w.edited && (w.original_started_at || w.original_ended_at) ? `<p class="small muted original-times-display hidden" data-id="${w.id}">Originally scanned: ${fmtClock(w.original_started_at)} – ${w.original_ended_at ? fmtClock(w.original_ended_at) : '-'}</p>` : ''}
          <div class="edit-times-row hidden" data-id="${w.id}" data-daykey="${dateKey(w.started_at)}" style="margin:4px 0;">
            <select class="edit-activity" aria-label="Activity">${activityOptionsHtml(w.activity, speciesOf(w).activities)}</select>
            <label class="small edit-time-line">Start <input type="time" class="edit-start-time" value="${toLocalTimeInput(w.started_at)}" /></label>
            <label class="small edit-time-line">End <input type="time" class="edit-end-time" value="${w.ended_at ? toLocalTimeInput(w.ended_at) : ''}" /></label>
            <button class="btn primary small-btn save-times-btn" data-id="${w.id}" style="margin-top:4px;">Save</button>
          </div>
          ${w.location ? `<p class="dog-meta nowrap">🏠 ${esc(w.location)}</p>` : ''}
          <p class="small">${w.notes ? noteBodyHtml(w.notes, state.statsTagged) : '<span class="muted">No notes</span>'}</p>
          <div class="row" style="margin-top:6px;align-items:center;justify-content:flex-end;">
            ${opts.sessionOnly ? (opts.underDog ? '' : `<button class="btn small-btn walk-action-btn animal-edit-btn" data-id="${w.dog_id}">${speciesOf(w).emoji} Edit ${esc(speciesOf(w).noun)}</button>`) : `<button class="btn small-btn walk-action-btn dog-notes-btn" data-dog-id="${w.dog_id}" title="${esc(w.dog_name)}'s tips and your private note" aria-label="${esc(w.dog_name)}'s notes">📝 ${esc(capFirst(speciesOf(w).noun))} notes</button>`}
            <button class="btn small-btn walk-action-btn edit-times-btn" data-id="${w.id}" title="Edit ${esc(activityInfo(w.activity).noun)} (times, activity)" aria-label="Edit ${esc(activityInfo(w.activity).noun)}">✎</button>
            <button class="btn danger walk-action-btn delete-walk-btn" data-id="${w.id}" data-name="${esc(w.dog_name)}" data-species="${esc(w.species || '')}" title="Delete ${esc(activityInfo(w.activity).noun)}" aria-label="Delete ${esc(activityInfo(w.activity).noun)}">🗑</button>
          </div>
        </div>
      </div>`;
  }

  // dayKey: the day the time boxes are on, or null when the cards span
  // several days (each card then uses its own walk's day).
  function wireStatsWalkCards(dayKey, refresh) {
    // Photo / name taps on these cards: the app-wide card handler.
    document.querySelectorAll('.delete-walk-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // This walk's own species, not the volunteer's current preference --
        // deleting a historical dog walk must never read as "delete this
        // play session" just because Settings was switched to cats since.
        const delTerms = termsFor([btn.dataset.species || 'dog']);
        if (!(await appConfirm(`Delete this ${delTerms.noun} with ${btn.dataset.name}? This can't be undone.`, { title: `Delete ${delTerms.noun}`, confirmText: 'Delete', danger: true }))) return;
        try {
          await api(`/api/walks/${btn.dataset.id}`, { method: 'DELETE' });
          await refresh();
        } catch (err) {
          appAlert(err.message);
        }
      });
    });
    document.querySelectorAll('.edited-badge').forEach((badge) => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const original = document.querySelector(`.original-times-display[data-id="${badge.dataset.id}"]`);
        if (original) original.classList.toggle('hidden');
      });
    });
    document.querySelectorAll('.edit-times-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelector(`.walk-times-display[data-id="${btn.dataset.id}"]`).classList.add('hidden');
        document.querySelector(`.edit-times-row[data-id="${btn.dataset.id}"]`).classList.remove('hidden');
      });
    });
    document.querySelectorAll('.dog-notes-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showDogNotesPopup(btn.dataset.dogId);
      });
    });
    document.querySelectorAll('.save-times-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.edit-times-row');
        const startInput = row.querySelector('.edit-start-time');
        const endInput = row.querySelector('.edit-end-time');
        const startTime = startInput.value;
        const endTime = endInput.value;
        const activity = row.querySelector('.edit-activity').value;
        const rowDayKey = dayKey || row.dataset.daykey;
        // Untouched times aren't re-sent: the boxes only hold whole minutes,
        // so re-sending them would shift the times and mark the walk edited.
        const timesTouched = startTime !== startInput.defaultValue || endTime !== endInput.defaultValue;
        // A daycation can run past midnight (6:30 pm to 1:30 am): an end
        // earlier than the start is the next morning, as on the wrap-up
        // screen (audit 3). Anything else still has to end after it starts.
        const overnight = activity === 'daycation' && endTime && endTime <= startTime;
        if (timesTouched) {
          if (!startTime) { appAlert('Start time is required.'); return; }
          if (endTime && endTime <= startTime && !overnight) { appAlert('The end time has to be after the start time.'); return; }
        }
        try {
          const body = timesTouched ? {
            startedAt: localTimeToIso(rowDayKey, startTime),
            endedAt: endTime ? localTimeToIso(overnight ? addDaysToKey(rowDayKey, 1) : rowDayKey, endTime) : null,
            activity
          } : { activity };
          await api(`/api/walks/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) });
          await refresh();
        } catch (err) { appAlert(err.message); }
      });
    });
  }

  function addWalkSectionHtml() {
    return `
      <button id="showAddWalkFormBtn" class="btn" style="margin-bottom:10px;">＋ Add ${esc(aNoun(myTerms()))} that wasn't scanned in</button>
      <div id="addWalkForm" class="card compact hidden" style="margin-bottom:10px;">
        <label class="small" for="addWalkDogSearch">${esc(capFirst(nounFor(prefSpeciesKeys())))}</label>
        <input type="text" id="addWalkDogSearch" placeholder="Start typing a name…" autocomplete="off" />
        <div id="addWalkDogResults" style="max-height:150px;overflow-y:auto;margin-bottom:8px;"></div>
        <p id="addWalkSelectedDog" class="small muted"></p>
        <label class="small" for="addWalkActivity">Activity</label>
        <select id="addWalkActivity">${activityOptionsHtml(speciesInfo(prefSpeciesKeys()[0]).activities ? speciesInfo(prefSpeciesKeys()[0]).activities[0] : 'walk')}</select>
        <div class="row add-walk-times" style="align-items:flex-end;margin-top:8px;">
          <label class="small add-walk-time">Started<input type="time" id="addWalkStart" /></label>
          <span class="muted" aria-hidden="true" style="padding-bottom:12px;">–</span>
          <label class="small add-walk-time">Ended<input type="time" id="addWalkEnd" /></label>
        </div>
        <label class="small" style="margin-top:8px;" id="addWalkNotesLabel">Notes (optional)</label>
        <div id="addWalkNotesBox">${noteTagBoxHtml({ placeholder: tagHint(), cls: 'end-note-text' })}</div>
        <div class="row" style="margin-top:8px;">
          <button id="saveAddWalkBtn" class="btn primary">Save</button>
          <button id="cancelAddWalkBtn" class="btn">Cancel</button>
        </div>
        <p id="addWalkStatus" class="small muted" style="margin:6px 0 0;"></p>
      </div>`;
  }

  function wireAddWalkSection(dayKey, refresh) {
    let addWalkWired = false;
    document.getElementById('showAddWalkFormBtn').addEventListener('click', () => {
      document.getElementById('addWalkForm').classList.remove('hidden');
      // Wire the form's handlers only the first time it's opened -- doing it
      // on every open stacked duplicate listeners, so Save could post the
      // same walk several times.
      if (!addWalkWired) { addWalkWired = true; wireAddWalkForm(dayKey, refresh); }
    });
    document.getElementById('cancelAddWalkBtn').addEventListener('click', () => {
      document.getElementById('addWalkForm').classList.add('hidden');
    });
  }

  // Today's stats are the default/header view -- people care far more about
  // "how'd today go" than lifetime totals most of the time. Computed
  // client-side from the same walks list already fetched for the lifetime
  // view (fetchMyWalks, every page), so no extra round-trip.
  // Averaging duration across every kind of interaction lumps a 10-minute
  // cuddle in with a 12-hour daycation, so this sticks to walk-only duration
  // whenever there are any walks in the set, falling back to the overall
  // average otherwise (a cat volunteer never has a 'walk' row).
  // Only finished ones count, and walks under a minute (a mis-scan) are
  // ignored. Takes both row shapes: /api/walks (duration_seconds) and
  // /api/impact/day (durationSeconds).
  const rowSeconds = (w) => (w.duration_seconds != null ? w.duration_seconds : w.durationSeconds) || 0;
  // A Together day's rows are all finished, though others' carry no times
  // (they have a slot instead).
  const rowEnded = (w) => !!(w.ended_at || w.endedAt || (w.slot !== undefined && w.order !== undefined));
  // The one rule every average (tiles, rows, charts) follows: which finished
  // rows it's over, which it left out as under a minute, and what it's of.
  // { rows, skipped, activity }: activity is 'walk', the one kind there was,
  // or null for a mix ("engagement").
  function avgPick(walks) {
    const done = walks.filter(rowEnded);
    const isWalk = (w) => (w.activity || 'walk') === 'walk';
    // A Together day (/api/impact/day) says per row whether the server's
    // average counted it: others' lengths arrive rounded to 5 minutes, so a
    // 1-2 minute walk shows as 0 and re-running the minute rule here would
    // call it a mis-scan (audit 3). Trust the flag whenever it's there.
    if (done.length && done.every((w) => typeof w.averaged === 'boolean')) {
      const rows = done.filter((w) => w.averaged);
      const walksOnly = rows.some(isWalk);
      const kinds = [...new Set(rows.map((w) => w.activity || 'walk'))];
      return {
        rows,
        skipped: done.filter((w) => !w.averaged && (!walksOnly || isWalk(w))).length,
        activity: walksOnly ? 'walk' : (kinds.length === 1 ? kinds[0] : null)
      };
    }
    const walkRows = done.filter((w) => isWalk(w) && rowSeconds(w) >= SHARED_CONFIG.minAvgSeconds);
    if (walkRows.length) {
      return { rows: walkRows, skipped: done.filter((w) => isWalk(w) && rowSeconds(w) < SHARED_CONFIG.minAvgSeconds).length, activity: 'walk' };
    }
    const rows = done.filter((w) => rowSeconds(w) >= SHARED_CONFIG.minAvgSeconds);
    const kinds = [...new Set(rows.map((w) => w.activity || 'walk'))];
    return { rows, skipped: done.length - rows.length, activity: kinds.length === 1 ? kinds[0] : null };
  }
  function walkOnlyAvgSeconds(walks) {
    const { rows } = avgPick(walks);
    return rows.length ? rows.reduce((s, w) => s + rowSeconds(w), 0) / rows.length : 0;
  }
  // ", not counting 2 under a minute" when the average left some out.
  const skippedNote = (n) => (n > 0 ? `, not counting ${n} under a minute` : '');
  // What that average is of: walks whenever there are any, else every engagement.
  // With no walks, the one activity everything averaged was (a matchmaking-
  // only day is an "Average matchmaking session", never an "Average walk").
  const avgLabelFor = (walks) => averageWordFor(avgPick(walks).activity, historyTerms(walks));
  // The tile label: "Avg walk length", "Avg matchmaking length", ...
  const avgTileLabel = (walks) => avgLabelFor(walks).replace('Average', 'Avg') + ' length';
  // The same for Lifetime, from /api/stats's per-activity breakdown (which
  // knows how many of each made it into an average).
  function lifetimeAvgLabel(byActivity, keys) {
    const counted = (byActivity || []).filter((a) => (a.avgCount != null ? a.avgCount : a.count) > 0);
    const activity = counted.some((a) => a.activity === 'walk') ? 'walk' : (counted.length === 1 ? counted[0].activity : null);
    return averageWordFor(activity, termsFor(keys)).replace('Average', 'Avg') + ' length';
  }
  // "Average <noun>" for an average with no walks in it. Dogs' own word is
  // "walk", which would be wrong here: the one activity it was, else
  // "engagement". Cats keep their word ("visit").
  function averageWordFor(activity, terms) {
    if (activity === 'walk') return 'Average walk';
    if (terms.noun !== 'walk') return `Average ${terms.noun}`;
    return activity ? `Average ${activityInfo(activity).noun}` : 'Average engagement';
  }

  function renderStatsToday(allWalks, data) {
    const todaysWalks = allWalks.filter((w) => w.ended_at && dateKey(w.started_at) === todayKey());
    const uniqueDogs = new Set(todaysWalks.map((w) => w.dog_id)).size;
    const totalSeconds = todaysWalks.reduce((s, w) => s + (w.duration_seconds || 0), 0);
    // Wording follows the species actually seen today, not the volunteer's
    // current Settings preference -- see historySpeciesKeys above.
    const todayKeys = statsSpeciesKeys(todaysWalks);
    const tw = statWords(todayKeys, { count: todaysWalks.length, unique: uniqueDogs });
    // This is the tab's default landing view -- make it unmistakable that
    // it's showing today only, not everything, before you even get to the
    // toggle button.
    const heading = statsScopeSwitchHtml() + `<h2 class="section-heading" style="margin-top:0;">Today's stats</h2>`;
    const rangeToggle = `<button type="button" id="statsRangeToggle" class="btn primary" style="margin-bottom:10px;">View lifetime stats</button>`;
    const tiles = `
      <div class="stat-grid">
        ${statDrillTile(todaysWalks.length, `${tw.count} today`, 'byActivity')}
        ${statDrillTile(uniqueDogs, tw.unique, 'byDogScope')}
        ${statDrillTile(fmtDuration(totalSeconds), tw.time, 'byActivity')}
        ${todaysWalks.length ? avgDrillTile(todaysWalks, avgTileLabel(todaysWalks)) : statDrillTile('–', tw.avg, 'avgChart')}
      </div>`;
    const items = todaysWalks
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .map((w) => statsWalkCardHtml(w, '')).join('');
    const todayBreakdowns = todaysWalks.length ? statsBreakdownsHtml(breakdownOfWalks(todaysWalks), { mine: true }) : '';
    appEl.innerHTML = heading + rangeToggle + tiles +
      (todayBreakdowns ? `<div class="card compact bd-card">${todayBreakdowns}</div>` : '') +
      (todaysWalks.length
        ? `<h2 class="section-heading">Today's ${tw.nounsWord}</h2><div class="stack">${items}</div>`
        : `<p class="empty-state">No ${tw.nounsWord} yet today.</p>`) +
      `<div style="margin-top:12px;">${addWalkSectionHtml()}</div>`;
    // Same edit / delete / add controls as the per-day view, right here, so
    // fixing a walk from today doesn't mean detouring through lifetime stats.
    wireStatsWalkCards(todayKey(), () => renderStats());
    wireAddWalkSection(todayKey(), () => renderStats());
    wireStatsRangeToggle();
    wireStatDrillTiles('today');
    wireStatsBreakdowns('today');
  }

  // activityOverride (an ACTIVITIES entry): when the list has been filtered
  // down to one activity (the By Activity drill-down), the dog-meta line
  // names that activity instead of guessing from species ("3 cuddles", not
  // "3 walks" for a cat that was never walked).
  function renderByDogRows(perDog, activityOverride) {
    const visible = state.statsPresentOnly ? perDog.filter((d) => d.stillListed) : perDog;
    if (!visible.length) return `<p class="empty-state">No ${nounFor(statsSpeciesKeys(perDog), true)} match this filter.</p>`;
    return visible.map((d) => {
      const markerDog = {
        id: d.id,
        blueMarkers: d.blue_markers ? JSON.parse(d.blue_markers) : [],
        pooStatus: d.poo_status || 'none',
        starFlag: !!d.star_flag,
        pbFlag: !!d.pb_flag
      };
      // Not every engagement with a dog is a walk (a daycation, a cuddle):
      // dogs count "engagements", cats keep their own word.
      const dw = statWords([d.species || 'dog']);
      const noun = activityOverride ? activityCountNouns(activityOverride)[0] : dw.noun;
      const nouns = activityOverride ? activityCountNouns(activityOverride)[1] : dw.nounsWord;
      return `
      <div class="card compact" data-id="${d.id}">
        <div class="dog-card">
          <img loading="lazy" decoding="async" class="dog-photo" src="${d.photo_url ? esc(thumbOf(d.photo_url)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges({ ...markerDog, name: d.name })}${d.stillListed ? '' : ` <span class="badge neutral">Adopted/Removed${d.removedAt ? ' ' + fmtDate(d.removedAt) : ''}</span>`}</p>
            <p class="dog-meta">${d.walkCount} ${d.walkCount === 1 ? noun : nouns} · ${fmtDuration(d.totalSeconds)} total</p>
            <p class="dog-meta">${activityOverride || dw.noun === 'engagement' ? `Last on ${fmtDate(d.lastWalkedAt)}` : `Last ${termsOf(d).past} ${fmtDate(d.lastWalkedAt)}`}</p>
          </div>
        </div>
        ${dogActionButtons(d.id, false, d.species)}
      </div>`;
    }).join('');
  }

  function wireByDogList() {
    wireDogActionButtons(document.getElementById('byDogList'));
  }

  // ---------- Updates tab (shared, global feed) ----------
  // Supersedes the old topbar notification bell entirely -- everyone sees
  // the same shelter-level event feed; `personalHighlight` (from the
  // server, based on this user's notification_prefs + walk history) is the
  // one bit of personalization, for "a dog I walked was adopted".
  function eventIcon(kind, detail, species) {
    if (kind === 'adopted') return '🎉';
    // A new cat gets the cat's emoji, not a dog's.
    if (kind === 'new_dog') return species && species !== 'dog' ? (speciesInfo(species).emoji || '✨') : '🐶';
    // A dog can reappear after an adoption, or after never really leaving
    // shelter care (vet work, a hold); the event's text tells them apart.
    // Both use ↩️, the app's one "returned" icon (the Updates filter chip,
    // dog cards and the timeline use it too).
    if (kind === 'returned') return '↩️';
    if (kind === 'alert') return '📢'; // a shelter alert from staff
    return '📣'; // 'removed', or anything future/unrecognized
  }

  function eventDogLike(row) {
    return {
      id: row.dog_id,
      name: row.dog_name,
      blueMarkers: row.blue_markers ? JSON.parse(row.blue_markers) : [],
      pooStatus: row.poo_status || 'none',
      starFlag: !!row.star_flag,
      pbFlag: !!row.pb_flag
    };
  }

  // The Updates filters: when (All / Today / This week, by the phone's own
  // clock, a week starting Sunday) and which kinds of event. Picking kinds is
  // a quick report, e.g. every dog returned this week.
  const UPDATES_RANGES = [['all', 'All'], ['today', 'Today'], ['week', 'This week']];
  const UPDATES_KINDS = [['alert', '📢 Alerts'], ['adopted', '🎉 Adopted'], ['new_dog', '✨ New'], ['returned', '↩️ Returned']];
  function updatesSince() {
    if (state.updatesRange === 'all') return null;
    // Midnight at the shelter today, or on this week's Sunday.
    let key = todayKey();
    if (state.updatesRange === 'week') key = addDaysToKey(key, -new Date(`${key}T12:00:00Z`).getUTCDay());
    return shelterTimeToDate(key);
  }
  // Showing only dogs or only cats counts as filtered too (the other's news stays unread).
  function updatesFiltered() { return state.updatesRange !== 'all' || state.updatesKinds.size > 0 || updatesSpeciesKeys().length < prefSpeciesKeys().length; }
  // capped: the server sent its whole page (UPDATES_LIMIT), so older ones exist.
  const UPDATES_LIMIT = 150;
  function updatesFilterHtml(rows, capped = false) {
    const since = updatesSince();
    const n = (kind) => rows.filter((r) => r.kind === kind).length;
    // The split by kind only when it adds something: never a single kind
    // repeating the total ("12 updates · 12 adopted").
    const counted = [[n('alert'), n('alert') === 1 ? 'alert' : 'alerts'], [n('adopted'), 'adopted'], [n('new_dog'), 'new'], [n('returned'), 'returned']].filter(([c]) => c);
    const parts = counted.length > 1 ? counted.map(([c, l]) => `${c} ${l}`) : [];
    const countText = capped
      ? `Newest <strong>${rows.length}</strong> update${rows.length === 1 ? '' : 's'}`
      : `<strong>${rows.length}</strong> update${rows.length === 1 ? '' : 's'}`;
    const sinceText = state.updatesRange === 'week'
      ? ` · since ${esc(since.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: SHELTER_TZ }))}` : '';
    return `
      ${speciesSwitchHtml(true)}
      <div class="card compact stack" style="gap:6px;margin-bottom:10px;">
        <div class="seg seg-small" role="radiogroup" aria-label="Show updates from" style="margin:0;">
          ${UPDATES_RANGES.map(([key, label]) => `<button type="button" class="seg-btn ${state.updatesRange === key ? 'on' : ''}" data-updates-range="${key}" style="white-space:nowrap;padding:7px 4px;" role="radio" aria-checked="${state.updatesRange === key}">${label}</button>`).join('')}
        </div>
        <div class="marker-row" role="group" aria-label="Show only these kinds of update" style="gap:6px;flex-wrap:wrap;">
          ${UPDATES_KINDS.map(([key, label]) => `<button type="button" class="btn small-btn filter-chip ${state.updatesKinds.has(key) ? 'active' : ''}" data-updates-kind="${key}" aria-pressed="${state.updatesKinds.has(key)}" style="width:auto;flex:1 1 auto;min-height:44px;padding:6px 6px;font-size:0.85rem;white-space:nowrap;">${label}</button>`).join('')}
        </div>
        <p class="muted small result-count" style="margin:0;">${countText}${parts.length ? ` · ${parts.join(' · ')}` : ''}${sinceText}</p>
      </div>`;
  }
  function wireUpdatesFilter() {
    wireSpeciesSwitch(() => { state.updatesScrollTop = 0; renderUpdates(); }, true);
    appEl.querySelectorAll('[data-updates-range]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.updatesRange === state.updatesRange) return;
      state.updatesRange = b.dataset.updatesRange;
      state.updatesScrollTop = 0;
      renderUpdates();
    }));
    appEl.querySelectorAll('[data-updates-kind]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.updatesKind;
      if (state.updatesKinds.has(kind)) state.updatesKinds.delete(kind); else state.updatesKinds.add(kind);
      state.updatesScrollTop = 0;
      renderUpdates();
    }));
  }

  async function renderUpdates() {
    appEl.innerHTML = `<p class="muted small center loading-line" role="status">Loading…</p>`;
    const myTab = state.tab;
    const since = updatesSince();
    const qs = (since ? `&since=${encodeURIComponent(since.toISOString())}` : '')
      + (state.updatesKinds.size ? `&kinds=${[...state.updatesKinds].join(',')}` : '');
    let data;
    try {
      data = await api(`/api/updates?userId=${state.currentUser.id}&limit=${UPDATES_LIMIT}${qs}`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('updates', err, renderUpdates);
      return;
    }
    if (state.tab !== myTab) return;
    // Shelter alerts concern everyone; animal news follows the Dogs / Cats switch.
    const rows = (data.updates || []).filter((r) => r.kind === 'alert' || !r.dog_id || inSpeciesView(r, updatesSpeciesKeys()));
    if (!rows.length) {
      appEl.innerHTML = updatesFiltered()
        ? updatesFilterHtml(rows) + `<p class="empty-state">No updates match these filters.</p>`
        : `<p class="empty-state">No updates yet.</p>`;
      wireUpdatesFilter();
      return;
    }
    // data-id is only present for kinds where the photo-tap-to-walk/edit
    // shortcut (wired below via wireDogActionButtons) makes sense -- an
    // adopted dog can't be walked, so its card deliberately omits it and
    // relies only on its own "View cached profile" button instead.
    //
    // The green border means exactly one thing: "hasn't been seen yet."
    // personalHighlight ("you walked this dog") gets its own text badge
    // instead of a border -- it used to share the same green outline as
    // unread, which made an old, already-seen adoption look indistinguishable
    // from something genuinely new.
    function updateCardHtml(r) {
      if (r.kind === 'alert') return alertCardHtml(r);
      return `
      <div class="card compact${r.unread ? ' update-unread' : ''}"${r.dog_id && (r.kind === 'new_dog' || r.kind === 'returned') ? ` data-id="${r.dog_id}"` : ''}${r.dog_id ? ` data-dog-id="${r.dog_id}"` : ''}>
        <div class="dog-card">
          ${r.dog_id
            // Photo: full screen; name/info: profile (the app-wide card taps).
            ? `<img loading="lazy" decoding="async" class="dog-photo small" src="${r.photo_url ? esc(thumbOf(r.photo_url)) : '/icons/icon-192.png'}" alt="" />`
            : `<div class="dog-photo small" style="display:flex;align-items:center;justify-content:center;font-size:1.3rem;">${eventIcon(r.kind, r.detail, r.species)}</div>`}
          <div class="dog-info">
            <p class="dog-name"${r.dog_id ? ' role="button" tabindex="0" style="cursor:pointer;"' : ''}>${r.dog_id ? eventIcon(r.kind, r.detail, r.species) + ' ' : ''}${esc(r.title || r.dog_name || 'Update')} ${r.dog_id ? speciesTagHtml(r) + ' ' + markerBadges(eventDogLike(r), true) : ''}</p>
            ${r.personalHighlight ? `<span class="badge eligible">You ${termsOf(r).past} this ${esc(speciesOf(r).noun)}</span>` : ''}
            ${r.favorite ? '<span class="badge fav">♥ Your favorite</span>' : ''}
            <p class="dog-meta">${fmtDate(r.occurred_at)}</p>
          </div>
        </div>
        ${r.dog_id && (r.kind === 'new_dog' || r.kind === 'returned') ? dogActionButtons(r.dog_id, false, r.species) : ''}
        ${r.dog_id && r.kind === 'adopted' ? `
        <div class="row" style="margin-top:6px;">
          <button class="btn small-btn view-profile-btn" data-id="${r.dog_id}">See their last profile</button>
        </div>` : ''}
      </div>`;
    }
    // A shelter alert from staff: no dog, a headline and the message itself.
    function alertCardHtml(r, pinned) {
      return `
      <div class="card compact update-alert${r.unread ? ' update-unread' : ''}${pinned ? ' update-pinned' : ''}">
        <p class="dog-name" style="margin:0;">📢 ${esc(r.title || 'Shelter alert')}</p>
        ${r.detail && r.detail !== r.title ? `<p class="small" style="margin:6px 0 0;white-space:pre-line;">${esc(r.detail)}</p>` : ''}
        <p class="dog-meta" style="margin:6px 0 0;">${pinned ? '📌 Pinned · ' : ''}Shelter alert · ${fmtDate(r.occurred_at)}</p>
      </div>`;
    }
    // A shelter alert (hours changes, closures) stays pinned above
    // everything else, read or not, so it isn't buried under a day's worth
    // of new animals. The server drops it once it expires.
    const isPinned = (r) => r.kind === 'alert';
    const pinnedRows = rows.filter(isPinned);
    const rest = rows.filter((r) => !isPinned(r));
    const unreadRows = rest.filter((r) => r.unread);
    const readRows = rest.filter((r) => !r.unread);
    const pinnedHtml = pinnedRows.map((r) => alertCardHtml(r, true)).join('');
    const unreadHtml = unreadRows.map(updateCardHtml).join('');
    const readHtml = readRows.map(updateCardHtml).join('');
    // The "Previous updates" divider only makes sense when there's an
    // actual new/old split to label -- an all-read (or all-unread) list
    // just renders as one plain stack.
    appEl.innerHTML = updatesFilterHtml(rows, (data.updates || []).length >= UPDATES_LIMIT) + (unreadRows.length && readRows.length
      ? `<div class="stack">${pinnedHtml}${unreadHtml}</div><h2 class="section-heading" style="margin-top:18px;">Previous updates</h2><div class="stack">${readHtml}</div>`
      : `<div class="stack">${pinnedHtml}${unreadHtml}${readHtml}</div>`);
    state.updatesHtml = appEl.innerHTML;
    wireDogActionButtons(appEl);
    wireUpdatesFilter();
    // A filtered view can leave unread updates out (older than today, or of
    // another kind), so only the full feed counts as having seen them.
    if (updatesFiltered()) return;
    // Mark as seen only after actually rendering the list (not just on
    // fetch) -- the rows just shown keep their already-computed `unread`
    // green border for this viewing, and only lose it on the NEXT visit.
    try {
      await api(`/api/users/${state.currentUser.id}/updates-seen`, { method: 'PUT' });
    } catch (err) { /* non-critical; badge will just re-show next refresh */ }
    state.unreadUpdatesCount = 0;
    updateUpdatesBadge();
  }

  // Back from a dog opened off the Updates feed: put back exactly the list
  // that was left, at the same scroll spot, instead of refetching. A fresh
  // fetch would start at the top, and the cards marked unread on that visit
  // would have lost their green border and "Previous updates" split, so the
  // list wouldn't line up with where the person was anyway.
  function restoreUpdates() {
    if (!state.updatesHtml) return render();
    appEl.classList.remove('caution-stripes', 'age-block', 'pb-only-bg', 'evo-caution-bg');
    lastWalkPhase = null;
    appEl.innerHTML = state.updatesHtml;
    wireDogActionButtons(appEl);
    wireUpdatesFilter();
    restoreScroll(state.updatesScrollTop);
  }

  function updateUpdatesBadge() {
    const badge = document.getElementById('updatesBadge');
    if (!badge) return;
    const count = state.unreadUpdatesCount || 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }

  async function refreshUpdatesBadge() {
    try {
      const { count } = await api(`/api/updates/unread-count?userId=${state.currentUser.id}`);
      state.unreadUpdatesCount = count;
    } catch (err) { /* leave whatever was last known */ }
    updateUpdatesBadge();
  }

  // The Updates tab used to disappear when every dog category was turned
  // off. Shelter alerts always show there now, so it always stays.
  function refreshUpdatesTabVisibility() {
    const tabBtn = document.querySelector('.tab-btn[data-tab="updates"]');
    if (tabBtn) tabBtn.classList.remove('hidden');
  }


  // Time pickers show and take the shelter's clock time.
  function toLocalTimeInput(iso) {
    const p = shelterParts(iso);
    return `${pad2(p.hh)}:${pad2(p.mm)}`;
  }

  function localTimeToIso(dateKey, timeStr) {
    const [hh, mm] = timeStr.split(':').map(Number);
    return shelterTimeToDate(dateKey, hh, mm).toISOString();
  }

  async function refreshStatsDay() {
    const walksData = await fetchMyWalks();
    state.statsDays = groupWalksByDay(walksData.walks.filter(inStatsSpecies));
    if (state.statsDays.find((d) => d.key === state.selectedDateKey)) {
      renderStatsDay();
    } else {
      state.statsView = 'summary';
      renderStats();
    }
  }

  function renderStatsDay() {
    const day = state.statsDays.find((d) => d.key === state.selectedDateKey);
    if (!day) {
      state.statsView = 'summary';
      return renderStats();
    }
    const dayTotalSeconds = day.walks.reduce((s, w) => s + (w.duration_seconds || 0), 0);
    const dayAvgSeconds = walkOnlyAvgSeconds(day.walks);
    // Wording follows the species actually seen that day, not the
    // volunteer's current Settings preference -- see historySpeciesKeys above.
    const dayKeys = statsSpeciesKeys(day.walks);
    const dw = statWords(dayKeys, { count: day.walkCount, unique: day.dogCount });
    const dayTiles = `
      <div class="stat-grid">
        ${statDrillTile(day.walkCount, `${dw.count} that day`, 'byActivity')}
        ${statDrillTile(fmtDuration(dayTotalSeconds), 'Total time', 'byActivity')}
        ${avgDrillTile(day.walks, avgTileLabel(day.walks))}
        ${statDrillTile(day.dogCount, dw.unique, 'byDogScope')}
      </div>`;

    // Same 4 fixed shift windows as the Available list's slot grid, so a
    // slow shift is obvious at a glance instead of buried in one day total.
    const shiftTotals = WALK_SLOTS.map(() => ({ count: 0, seconds: 0 }));
    day.walks.forEach((w) => {
      const idx = slotIndexForIso(w.started_at);
      if (idx >= 0) {
        shiftTotals[idx].count += 1;
        shiftTotals[idx].seconds += w.duration_seconds || 0;
      }
    });
    const shiftTiles = `
      <div class="stat-grid">
        ${WALK_SLOTS.map((s, i) => `
        <div class="stat-tile shift-drilldown-tile ${state.selectedShiftIndex === i ? 'active' : ''}" data-shift-index="${i}" role="button" tabindex="0" aria-pressed="${state.selectedShiftIndex === i}" style="cursor:pointer;">
          <div class="value">${shiftTotals[i].count}</div>
          <div class="label">${esc(fmtSlotLabel(s.label))}${shiftTotals[i].count ? ' · ' + fmtDuration(shiftTotals[i].seconds) : ''}</div>
        </div>`).join('')}
      </div>
      ${state.selectedShiftIndex != null ? `
      <p class="small muted" style="margin:6px 0;">Showing only ${dw.nounsWord} from ${esc(fmtSlotLabel(WALK_SLOTS[state.selectedShiftIndex].label))}. <a href="#" id="clearShiftFilterLink">Show all</a></p>` : ''}`;

    const shiftFilteredWalks = state.selectedShiftIndex != null
      ? day.walks.filter((w) => slotIndexForIso(w.started_at) === state.selectedShiftIndex)
      : day.walks;
    const items = shiftFilteredWalks.map((w, i) => statsWalkCardHtml(w, `${i + 1}. `)).join('');

    appEl.innerHTML = `
      <button id="backToStatsBtn" class="btn">← Back to Stats</button>
      <h2 class="section-heading">${fmtDayHeading(day.key)}</h2>
      ${dayTiles}
      <div class="card compact bd-card">${statsBreakdownsHtml(breakdownOfWalks(day.walks), { mine: true })}</div>
      <h2 class="section-heading">By shift</h2>
      ${shiftTiles}
      ${addWalkSectionHtml()}
      <div class="stack">${items}</div>`;

    // The same as the phone's Back: the visit day is a history step of its
    // own, so this steps back through it (no stale entry left behind).
    document.getElementById('backToStatsBtn').addEventListener('click', () => statsBack(() => {
      state.statsView = 'summary';
      state.selectedShiftIndex = null;
    }));
    wireStatDrillTiles('day');
    wireStatsBreakdowns('day');
    appEl.querySelectorAll('.shift-drilldown-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const idx = Number(tile.dataset.shiftIndex);
        state.selectedShiftIndex = state.selectedShiftIndex === idx ? null : idx;
        renderStatsDay();
      });
    });
    const clearShiftLink = document.getElementById('clearShiftFilterLink');
    if (clearShiftLink) clearShiftLink.addEventListener('click', (e) => {
      e.preventDefault();
      state.selectedShiftIndex = null;
      renderStatsDay();
    });
    wireStatsWalkCards(day.key, refreshStatsDay);
    wireAddWalkSection(day.key, refreshStatsDay);
  }

  let addWalkSelectedDogId = null;
  async function wireAddWalkForm(dateKey, refresh) {
    addWalkSelectedDogId = null;
    const notesBox = wireNoteTagBox(document.getElementById('addWalkNotesBox'));
    const searchInput = document.getElementById('addWalkDogSearch');
    const results = document.getElementById('addWalkDogResults');
    const selectedLabel = document.getElementById('addWalkSelectedDog');
    let allDogs = [];
    try {
      const data = await api('/api/dogs?all=false');
      allDogs = data.dogs;
    } catch (e) { /* search just won't return results */ }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      addWalkSelectedDogId = null;
      if (!q) { results.innerHTML = ''; return; }
      const matches = allDogs.filter((d) => dogNameMatches(d, q)).slice(0, 6);
      results.innerHTML = matches.map((d) => `
        <div class="card compact dog-card add-walk-dog-result" data-id="${d.id}" data-name="${esc(d.name)}" data-species="${esc(d.species || 'dog')}">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${d.photoUrl ? esc(thumbOf(d.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info"><p class="dog-name">${esc(d.name)} ${speciesTagHtml(d)} ${markerBadges(d)}</p>${akaHtml(d)}</div>
        </div>`).join('');
      results.querySelectorAll('.add-walk-dog-result').forEach((row) => {
        row.addEventListener('click', () => {
          addWalkSelectedDogId = row.dataset.id;
          selectedLabel.textContent = `Selected: ${row.dataset.name}`;
          // Only what this animal can do (a cat: cuddle or matchmaking).
          const activitySelect = document.getElementById('addWalkActivity');
          const keys = speciesInfo(row.dataset.species).activities;
          activitySelect.innerHTML = activityOptionsHtml(keys.includes(activitySelect.value) ? activitySelect.value : keys[0], keys);
          results.innerHTML = '';
          searchInput.value = row.dataset.name;
        });
      });
    });

    document.getElementById('saveAddWalkBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('addWalkStatus');
      const startTime = document.getElementById('addWalkStart').value;
      const endTime = document.getElementById('addWalkEnd').value;
      const notes = notesBox.body();
      if (!addWalkSelectedDogId) { statusEl.textContent = 'Pick a dog from the search results first.'; return; }
      if (!startTime || !endTime) { statusEl.textContent = 'Start and end time are both required.'; return; }
      if (endTime <= startTime) { statusEl.textContent = 'The end time has to be after the start time.'; return; }
      const saveBtn = document.getElementById('saveAddWalkBtn');
      saveBtn.disabled = true;
      try {
        await api('/api/walks/manual', {
          method: 'POST',
          body: JSON.stringify({
            dogId: Number(addWalkSelectedDogId),
            userId: state.currentUser.id,
            startedAt: localTimeToIso(dateKey, startTime),
            endedAt: localTimeToIso(dateKey, endTime),
            activity: document.getElementById('addWalkActivity').value,
            notes
          })
        });
        await refresh();
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
        saveBtn.disabled = false;
      }
    });
  }

  // ---------- Walk tab ----------
  // The bottom tab reads "Scan" normally, but "Walk" while a walk is
  // actually underway (active/ending/summary) — persists on the tab bar
  // even if you switch away to another tab mid-walk.
  function updateWalkTabLabel() {
    const btn = document.querySelector('.tab-btn[data-tab="walk"]');
    if (!btn) return;
    const inWalk = ['active', 'ending', 'summary'].includes(state.walk.phase);
    btn.innerHTML = inWalk ? `${activityInfo(state.walk.activity).emoji}<span class="tab-label">${capFirst(termsOf(state.walk.dog).verb)}</span>` : '📷<span class="tab-label">Scan</span>';
  }

  let lastWalkPhase = null;
  function renderWalk() {
    appEl.classList.remove('caution-stripes', 'age-block', 'pb-only-bg', 'evo-caution-bg');
    updateWalkTabLabel();
    saveLocalWalk(); // this device's copy follows the walk (kept, or cleared once ended)
    const w = state.walk;
    // The header says what's actually going on: "Scan a Dog" while you're
    // picking one, but not while you're mid-walk (the tab already reads "Walk").
    if (state.tab === 'walk') {
      const label = activityInfo(w.activity).label;
      topbarTitle.textContent = w.phase === 'active' ? `${label} in progress`
        : w.phase === 'ending' ? `Finish ${activityInfo(w.activity).noun}`
          : w.phase === 'summary' ? `${label} complete` : TAB_TITLES.walk;
    }
    // A new step (a dog just scanned, a walk just started...) opens at the
    // top, where the dog and the check-out time are -- not wherever the last
    // screen was scrolled to. Re-rendering the same step keeps its place.
    if (w.phase !== lastWalkPhase) {
      lastWalkPhase = w.phase;
      appEl.scrollTop = 0;
    }
    if (w.phase === 'idle') return renderWalkIdle();
    if (w.phase === 'scanning') return renderWalkScanning();
    if (w.phase === 'confirm') return renderWalkConfirm();
    if (w.phase === 'unlisted') return renderWalkUnlisted();
    if (w.phase === 'active') return renderWalkActive();
    if (w.phase === 'ending') return renderWalkEnding();
    if (w.phase === 'summary') return renderWalkSummary();
  }

  function renderWalkIdle() {
    appEl.innerHTML = `
      <div class="stack">
        <div class="card center">
          <p>Scan the QR tag on ${nounFor(prefSpeciesKeys()) === 'animal' ? 'an animal' : `a ${nounFor(prefSpeciesKeys())}`}'s kennel to check them out for ${aNoun(myTerms())}.</p>
          <button id="scanBtn" class="btn primary big">📷 Scan a kennel QR code</button>
        </div>
      </div>`;
    document.getElementById('scanBtn').addEventListener('click', () => {
      state.walk.phase = 'scanning';
      renderWalk();
    });
  }

  function renderWalkScanning() {
    appEl.innerHTML = `
      <div class="stack">
        <div id="qrSection">
          <div id="qr-reader"></div>
          <div id="scanError" class="small"></div>
          <button id="cancelScanBtn" class="btn">Close camera</button>
        </div>
        <div class="card compact">
          <label for="manualSearchInput" class="small">Code broken or missing? Search by name instead</label>
          <input type="search" id="manualSearchInput" placeholder="Start typing ${worksWithBoth() ? 'a name' : `a ${esc(nounFor(prefSpeciesKeys()))}'s name`}…" autocomplete="off" />
          <div id="manualSearchResults"></div>
        </div>
      </div>`;
    document.getElementById('cancelScanBtn').addEventListener('click', () => {
      stopQrScanner();
      state.walk.phase = 'idle';
      renderWalk();
    });
    startQrScanner();
    wireManualSearch();
  }

  async function wireManualSearch() {
    const input = document.getElementById('manualSearchInput');
    const results = document.getElementById('manualSearchResults');
    const qrSection = document.getElementById('qrSection');
    let allDogs = [];
    try {
      const data = await api('/api/dogs?all=false');
      allDogs = data.dogs;
    } catch (e) { /* search just won't return results if this fails */ }

    // The camera isn't needed while typing a manual search — close it to
    // free up screen space. Also force the input to the top of the scroll
    // area ourselves: once the keyboard opens, mobile browsers auto-scroll
    // to keep the focused input visible, which otherwise pushes content
    // above it (would-be results) off-screen — so results go below instead,
    // and get their own scroll region capped to fit above the keyboard.
    input.addEventListener('focus', () => {
      stopQrScanner();
      qrSection.hidden = true;
      setTimeout(() => input.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);
    }, { once: true });

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.innerHTML = ''; return; }
      const matches = allDogs.filter((d) => dogNameMatches(d, q)).slice(0, 8);
      if (!matches.length) {
        results.innerHTML = `<p class="muted small">No matching ${nounFor(prefSpeciesKeys(), true)}.</p>`;
        return;
      }
      results.innerHTML = matches.map((d) => `
        <div class="card compact dog-card search-result" data-id="${d.id}">
          <img loading="lazy" decoding="async" class="dog-photo" src="${d.photoUrl ? esc(thumbOf(d.photoUrl)) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges(d)}</p>
            ${akaHtml(d)}
            <p class="dog-meta">${esc(d.breed || '')} · ${d.daysInShelter} days in shelter</p>
          </div>
        </div>`).join('');
      results.querySelectorAll('.search-result').forEach((row) => {
        row.addEventListener('click', () => {
          stopQrScanner();
          selectDogById(row.dataset.id);
        });
      });
    });
  }

  // html5-qrcode rejects with a plain string ("Error getting userMedia,
  // error = NotAllowedError: Permission denied"), not an Error, so err.name
  // is usually missing: the browser's error name is looked for in the text.
  // Whatever it is, the raw library text is never shown.
  function cameraErrorKind(err) {
    const text = `${(err && err.name) || ''} ${typeof err === 'string' ? err : (err && err.message) || String(err)}`;
    if (/NotAllowedError|PermissionDenied|Permission denied|not allowed/i.test(text)) return 'blocked';
    if (/NotFoundError|DevicesNotFound|OverconstrainedError|Requested device not found/i.test(text)) return 'none';
    if (/NotReadableError|TrackStartError|Could not start video source/i.test(text)) return 'busy';
    if (/secure context|insecure|getUserMedia is not|not supported|NotSupportedError/i.test(text)) return 'unsupported';
    return 'other';
  }
  const cameraErrorCard = (title, body) => `<div class="card error-card" role="alert"><p class="error-card-title">${title}</p>${body}</div>`;
  function cameraErrorMessage(err) {
    const kind = cameraErrorKind(err);
    const searchHint = `<p class="small muted" style="margin-bottom:0;">You can search for the ${esc(nounFor(prefSpeciesKeys()))} by name instead.</p>`;
    if (kind === 'blocked') {
      return `<div class="card error-card" role="alert">
        <p class="error-card-title">Camera access is blocked for this app.</p>
        <p class="muted">Once camera access has been denied there's no prompt inside the app to ask again. It has to be turned back on in your device settings:</p>
        <p class="small"><strong>Android (Chrome):</strong></p>
        <ol class="muted small" style="padding-left:18px;">
          <li>Open Chrome (not this app)</li>
          <li>Menu, then Settings, then Site settings, then search "shelterwalk.com"</li>
          <li>Tap Camera, then Allow</li>
          <li>Close and reopen this app</li>
        </ol>
        <p class="small"><strong>iPhone:</strong></p>
        <ol class="muted small" style="padding-left:18px;">
          <li>Open the Settings app, then Safari, then Camera</li>
          <li>Set it to Ask or Allow, then reopen this app</li>
        </ol>
        ${searchHint}</div>`;
    }
    if (kind === 'none') return cameraErrorCard('No camera was found on this device.', searchHint);
    if (kind === 'busy') return cameraErrorCard('The camera is busy.', `<p class="small muted">Another app may be using it. Close that app, then tap Try again.</p><button type="button" class="btn camera-retry-btn">Try again</button>${searchHint}`);
    if (kind === 'unsupported') return cameraErrorCard("This browser can't open the camera here.", `<p class="small muted">Try opening Shelter Walk in Chrome or Safari.</p>${searchHint}`);
    return cameraErrorCard("Couldn't start the camera.", `<button type="button" class="btn camera-retry-btn">Try again</button>${searchHint}`);
  }

  // `readerId`/`errorId` let this be reused outside the Scan tab (e.g. Audit
  // Mode has its own camera container so it doesn't collide with the Scan
  // tab's). `onScanned` defaults to the Scan tab's own handler.
  // Loads /js/html5-qrcode.min.js once (a failed load can be retried).
  let scannerLibPromise = null;
  function loadScannerLib() {
    if (typeof Html5Qrcode !== 'undefined') return Promise.resolve();
    if (!scannerLibPromise) {
      scannerLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/js/html5-qrcode.min.js';
        s.onload = () => (typeof Html5Qrcode !== 'undefined' ? resolve() : reject(new Error('scanner missing')));
        s.onerror = () => reject(new Error('scanner failed to load'));
        document.head.appendChild(s);
      }).catch((err) => { scannerLibPromise = null; throw err; });
    }
    return scannerLibPromise;
  }
  function startQrScanner(readerId, errorId, onScanned) {
    readerId = readerId || 'qr-reader';
    errorId = errorId || 'scanError';
    onScanned = onScanned || onQrScanned;
    const showError = (html) => {
      const el = document.getElementById(errorId);
      if (!el) return;
      el.innerHTML = html;
      // Nothing to show where the camera would be.
      const reader = document.getElementById(readerId);
      if (reader) reader.classList.add('hidden');
      // Scan tab: with no camera, searching by name is the way forward.
      const closeBtn = errorId === 'scanError' && document.getElementById('cancelScanBtn');
      if (closeBtn) closeBtn.classList.add('hidden');
      const searchCard = closeBtn && document.getElementById('manualSearchInput')?.closest('.card');
      const qrSection = document.getElementById('qrSection');
      if (searchCard && qrSection) qrSection.before(searchCard);
      el.querySelectorAll('.camera-retry-btn').forEach((b) => b.addEventListener('click', () => {
        el.innerHTML = '';
        if (reader) reader.classList.remove('hidden');
        if (closeBtn) closeBtn.classList.remove('hidden');
        stopQrScanner();
        startQrScanner(readerId, errorId, onScanned);
      }));
    };
    if (typeof Html5Qrcode === 'undefined') {
      // eng (audit2): the scanner library (375 KB) loads the first time a
      // scan opens, not with every page. A scan closed meanwhile stays closed.
      const token = state.qrStartToken;
      loadScannerLib().then(() => {
        if (state.qrStartToken === token) startQrScanner(readerId, errorId, onScanned);
      }, () => {
        showError(cameraErrorCard("The camera couldn't load.", `<p class="small muted">Check your connection and reload the page, or search for the ${esc(nounFor(prefSpeciesKeys()))} by name instead.</p>`));
      });
      return;
    }
    const scanner = new Html5Qrcode(readerId);
    state.qrScanner = scanner;
    let started;
    try {
      started = scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 240 },
        (decodedText) => onScanned(decodedText),
        () => {}
      );
    } catch (err) { started = Promise.reject(err); }
    Promise.resolve(started).catch((err) => {
      console.warn('[camera]', err);
      showError(cameraErrorMessage(err));
    });
  }

  function stopQrScanner() {
    // A scan still waiting on the library (loadScannerLib) won't start now.
    state.qrStartToken = (state.qrStartToken || 0) + 1;
    const scanner = state.qrScanner;
    if (scanner) {
      state.qrScanner = null;
      // Hold our own reference: state.qrScanner is nulled above, so reading
      // it again inside the .then() threw and the camera view never got
      // cleared.
      // stop() throws right away (not a rejected promise) if the camera
      // never started, e.g. no camera or permission denied. That used to
      // abort switching tabs away from Scan.
      try {
        scanner.stop().then(() => scanner.clear()).catch(() => {});
      } catch (err) {
        try { scanner.clear(); } catch (e) { /* nothing to clear */ }
      }
    }
  }

  // The kennel QR encodes {"Url":..., "AnimalId":...}; the kennel card also
  // has a plain barcode that's just the bare numeric ID (valid JSON too,
  // since a bare number parses fine — so check it's actually an object
  // before trusting AnimalId, then fall back to pulling digits out directly).
  function parseAnimalIdFromScan(decodedText) {
    let animalId = null;
    try {
      const parsed = JSON.parse(decodedText);
      if (parsed && typeof parsed === 'object') {
        animalId = parsed.AnimalId || parsed.animalId;
      }
    } catch (e) { /* not JSON - handled by the digit fallback below */ }
    if (!animalId) {
      const match = String(decodedText).match(/(\d{4,})/);
      if (match) animalId = match[1];
    }
    return animalId;
  }

  async function onQrScanned(decodedText) {
    stopQrScanner();
    const animalId = parseAnimalIdFromScan(decodedText);
    if (!animalId) {
      appAlert(`Could not read ${worksWithBoth() ? 'an animal' : `a ${nounFor(prefSpeciesKeys())}`} ID from that code.`);
      state.walk.phase = 'idle';
      renderWalk();
      return;
    }
    // A step for the scanned dog, so Back returns to the camera to scan
    // again (see the popstate handler) instead of leaving the Scan tab.
    pushHistory({ walkStep: 'scanned' });
    onScannedStep = true;
    selectDogById(animalId);
  }

  // Bumped by every Back, so a lookup still loading when Back is pressed
  // doesn't then paint its dog over the list that was just gone back to
  // (and drag that list's remembered scroll spot to the top with it).
  let dogLookupSeq = 0;
  async function selectDogById(animalId) {
    appEl.innerHTML = `<p class="muted small center">Looking up ${esc(nounFor(prefSpeciesKeys()))}…</p>`;
    const lookup = ++dogLookupSeq;
    const stale = () => lookup !== dogLookupSeq || state.tab !== 'walk';
    try {
      const { dog, walks } = await api(`/api/dogs/${animalId}?userId=${state.currentUser.id}`);
      if (stale()) return;
      if (dog.awaitingListing) { // walked before from this card, still not listed
        state.walk.phase = 'unlisted';
        state.walk.unlistedId = dog.id;
        state.walk.dog = dog;
        renderWalk();
        return;
      }
      // Off the site (adopted, maybe returned before the listing caught up):
      // a stale record could be the wrong dog, so check the card first.
      if (dog.stillListed === false) {
        const goOn = await appConfirm(
          `${dog.name} (ID ${dog.id}) isn't on the shelter's site anymore. If they were adopted and returned, they may not have been added back to the site yet. Double check that the ${speciesOf(dog).noun} you're with matches the kennel card you scanned before you go on.`,
          { title: '⚠️ Not on the shelter\'s site', confirmText: 'It matches, continue', cancelText: 'Scan again' }
        );
        // Not stale(): closing the dialog is itself a Back, which bumps dogLookupSeq.
        if (state.tab !== 'walk') return;
        // Same as Back from a scanned dog: the popstate handler reopens the camera.
        if (!goOn) { history.back(); return; }
      }
      state.walk.phase = 'confirm';
      state.walk.dog = dog;
      state.walk.allWalks = walks;
      state.walk.pendingMarkers = {
        blueMarkers: [...(dog.blueMarkers || [])],
        pooStatus: dog.pooStatus,
        starFlag: dog.starFlag,
        pbFlag: dog.pbFlag
      };
      renderWalk();
    } catch (err) {
      if (stale()) return;
      if (err.status === 404 && err.body && err.body.notListedYet) {
        state.walk.phase = 'unlisted';
        state.walk.unlistedId = err.body.id;
        state.walk.unlistedSpecies = null; // a new card: ask again
        state.walk.dog = null;
        renderWalk();
        return;
      }
      appEl.innerHTML = `
        <div class="card center">
          <p>${esc(err.message)}</p>
          <button id="backToScanBtn" class="btn primary">Try again</button>
        </div>`;
      document.getElementById('backToScanBtn').addEventListener('click', () => {
        state.walk.phase = 'idle';
        renderWalk();
      });
    }
  }

  // A kennel card whose dog isn't in the shelter's online listing yet (the
  // card gets printed first, now and then). The walk still starts, filed
  // under the card's Animal ID; when the listing catches up (the scraper
  // runs every 30 minutes) the real details land on that same ID, walk and all.
  function renderWalkUnlisted() {
    const id = state.walk.unlistedId;
    const known = state.walk.dog; // a stand-in from an earlier walk on this card, if any
    // Which species the card is for: a stand-in already knows; otherwise the
    // volunteer's own (asked when they work with both, see the chips below).
    if (!state.walk.unlistedSpecies || known) state.walk.unlistedSpecies = known ? (known.species || 'dog') : prefSpeciesKeys()[0];
    const kindKey = state.walk.unlistedSpecies;
    const kind = speciesInfo(kindKey);
    const startActivity = usualActivityFor({ species: kindKey });
    const askSpecies = !known && worksWithBoth();
    appEl.innerHTML = `
      <div class="stack tight walk-confirm">
        <div class="card unlisted-card">
          <img class="dog-photo unlisted-photo" src="/dog-silhouettes/${encodeURIComponent(String(id))}.svg?v=1" alt="" />
          <p class="dog-name" style="margin:0 0 6px;">📋 New kennel card · ID ${esc(String(id))}</p>
          <p style="margin:0 0 8px;">We don't have this ${esc(kind.noun)}'s details yet. The shelter printed their kennel card before adding them to the online listing, which Shelter Walk checks every 30 minutes.</p>
          <p style="margin:0;"><strong>You can still ${(kind.terms || DOG_TERMS).verbWith} them.</strong> We'll keep this ${(kind.terms || DOG_TERMS).noun} under ID ${esc(String(id))} and add it to the ${esc(kind.noun)}'s record as soon as their details come in.</p>
        </div>
        ${askSpecies ? `
        <div class="card compact">
          <label class="small">This card is for a</label>
          <div id="unlistedSpeciesPick" class="marker-row" style="gap:6px;">${Object.entries(speciesTable()).map(([key, info]) => `
            <button type="button" class="btn small-btn filter-chip ${key === kindKey ? 'active' : ''}" data-species="${key}" style="width:auto;flex:0 0 auto;">${info.emoji} ${esc(info.label)}</button>`).join('')}</div>
        </div>` : ''}
        <div class="card compact">
          ${kind.levelRules ? `
          <label class="small">Check the kennel card yourself first</label>
          <ul class="small" style="margin:6px 0 10px;padding-left:20px;">
            <li><strong>Age:</strong> puppies under 6 months old can't be walked.</li>
            <li><strong>Stickers:</strong> make sure your level is cleared for any behavior or EVO stickers on the card.</li>
          </ul>` : ''}
          <label style="display:block;">${esc(kennelPickLabel(kind))}</label>
          ${kennelLetterPickerHtml('locationPicker', (known && known.kennelLocation) || '', { letters: kind.kennels || KENNEL_LETTERS })}
        </div>
        <div class="action-dock">
          <div id="activityPickRow" class="marker-row activity-chips hidden">${activityChipsHtml(startActivity, kind.activities)}</div>
          <div class="row start-row">
            <button id="startWalkBtn" class="btn primary big" data-activity="${startActivity}">${startActivityLabel(startActivity)}</button>
            <button type="button" id="changeActivityBtn" class="btn" aria-expanded="false" aria-controls="activityPickRow">⇄ Change</button>
          </div>
        </div>
        <button id="backToScanBtn2" class="btn">Scan a different ${esc(nounFor(prefSpeciesKeys()))}</button>
      </div>`;
    wireKennelLetterPicker('locationPicker');
    const speciesPick = document.getElementById('unlistedSpeciesPick');
    if (speciesPick) {
      speciesPick.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-species]');
        if (!chip || chip.dataset.species === state.walk.unlistedSpecies) return;
        state.walk.unlistedSpecies = chip.dataset.species;
        renderWalkUnlisted();
      });
    }
    const changeBtn = document.getElementById('changeActivityBtn');
    const pickRow = document.getElementById('activityPickRow');
    const startBtn = document.getElementById('startWalkBtn');
    changeBtn.addEventListener('click', () => {
      const open = pickRow.classList.toggle('hidden') === false;
      changeBtn.setAttribute('aria-expanded', String(open));
    });
    // Stays open after a tap, so the second tap of a double tap lands on
    // the same chip (making it the usual), never on Start below it.
    const unlistedKind = { species: kindKey };
    syncActivityChips(pickRow, startBtn.dataset.activity, unlistedKind);
    pickRow.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-activity]');
      if (!chip) return;
      if (chip.dataset.activity === startBtn.dataset.activity) {
        makeUsualActivity(chip.dataset.activity, pickRow, unlistedKind);
        return;
      }
      startBtn.dataset.activity = chip.dataset.activity;
      startBtn.textContent = startActivityLabel(chip.dataset.activity);
      syncActivityChips(pickRow, chip.dataset.activity, unlistedKind);
      pickedActivityToast(chip.dataset.activity, unlistedKind, 'Picked');
    });
    startBtn.addEventListener('click', async () => {
      const activity = startBtn.dataset.activity || 'walk';
      const location = kennelLetterPickerValue('locationPicker');
      startBtn.disabled = true;
      try {
        const res = await api('/api/walks/start', {
          method: 'POST',
          body: JSON.stringify({ dogId: id, location, userId: state.currentUser.id, activity, unlisted: true, species: kindKey })
        });
        const { dog, walks } = await api(`/api/dogs/${id}?userId=${state.currentUser.id}`);
        dog.kennelLocation = res.location;
        Object.assign(state.walk, {
          dog,
          allWalks: walks,
          walkId: res.walkId,
          startedAt: res.startedAt,
          stopsAt: res.stopsAt,
          closesAt: res.closesAt,
          endsBy: res.endsBy || null,
          endToken: res.endToken || null,
          autoStopped: false,
          activity,
          location: res.location || location,
          phase: 'active'
        });
        renderWalk();
      } catch (err) {
        appAlert(err.message);
        startBtn.disabled = false;
      }
    });
    document.getElementById('backToScanBtn2').addEventListener('click', () => {
      state.walk.phase = 'scanning';
      renderWalk();
    });
  }

  // Soft timing tip from the shelter's "Which dogs should I walk?" sign:
  // first walks in the morning, non-POO second walks mid-day, POO dogs'
  // last walks after 4pm, POO asterisk dogs last out (5:30-7pm). Never
  // blocks anything.
  function walkTimingHint(dog, walks) {
    const today = todayKey();
    const walksToday = (walks || []).filter((w) => w.started_at && dateKey(w.started_at) === today).length;
    const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: SHELTER_TZ })
      .formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour').value) + Number(parts.find((p) => p.type === 'minute').value) / 60;
    // All three yellow stickers (POO, POO asterisk, PB) get the same tips.
    const poo = dog.pooStatus === 'poo' || dog.pooStatus === 'priority' || !!dog.pbFlag;
    const star = dog.pooStatus === 'priority';

    // A POO asterisk dog is the last out at night (5:30-7pm), so a walk
    // from 4 to 5:30pm gets its own warning. Any other time it gets the
    // same yellow tips as any POO dog.
    if (star && hour >= 16 && hour < 17.5) {
      return 'POO* dogs should be walked between 5:30–7 pm so they\'re the last out at night.';
    }

    // A POO dog gets a last walk after 4pm either way, whether this is its
    // 1st or 2nd walk today -- so a mid-day slot spent on one is a non-POO
    // dog that may miss its only walk of the day. Unlike the other branches
    // below, this applies regardless of walksToday.
    if (poo && hour >= 11 && hour < 16) {
      return 'POOs will have a guaranteed walk from 4–7 pm. Since it is midday, focus on 2nd walks for non-POO dogs first.';
    }

    if (walksToday !== 1) return '';
    if (hour < 16) return ''; // non-POO 2nd walk mid-day is ideal; the POO case is handled above
    if (!poo) return 'Evenings are for POO dogs\' last walks. If any POO dogs still need theirs, consider walking them first.';
    return '';
  }

  // Buttons are sentence case: "Start walk", "End playgroup".
  const startActivityLabel = (key) => `${activityInfo(key).emoji} Start ${activityInfo(key).label.toLowerCase()}`;

  // Same rule serializeDog uses for `eligible`/`notEligibleReason`, mirrored
  // here ONLY so toggling a marker (PB, a blue sticker) updates the bar the
  // instant it's tapped, before anything is saved. The server stays the
  // source of truth: this preview is thrown away and re-checked for real
  // against the saved dog (see the Start Walk handler below), so it can
  // never be used to actually get a walk past the real rule.
  function previewEligibility(dog, pending, level) {
    const result = previewLevelEligibility(dog, pending, level);
    // Listed as in foster: checked last, as on the server.
    return dog.location === 'In Foster' && result.eligible !== false ? { eligible: false, reason: 'in_foster' } : result;
  }
  function previewLevelEligibility(dog, pending, level) {
    const hasEvo = (pending.blueMarkers || []).includes('blue_evo');
    const hasAnyBlue = (pending.blueMarkers || []).length > 0;
    if (hasEvo && !level.allowEvo) return { eligible: false, reason: 'evo_restricted' };
    if (hasAnyBlue && !level.allowBlue) return { eligible: false, reason: 'blue_restricted' };
    if (dog.isPendingAdoption && !level.allowPending) return { eligible: false, reason: 'pending_restricted' };
    if (dog.isStrayHold && !pending.pbFlag && !dog.alumniBypassStrayHold) return { eligible: false, reason: 'stray_hold' };
    if (pending.pbFlag) return level.allowPb ? { eligible: true, reason: null } : { eligible: false, reason: 'pb_restricted' };
    if (dog.effectiveDaysInShelter == null) return { eligible: null, reason: null };
    return dog.effectiveDaysInShelter >= level.minDays ? { eligible: true, reason: null } : { eligible: false, reason: 'days' };
  }

  function renderWalkConfirm() {
    const dog = state.walk.dog;
    const tooYoung = dog.tooYoung;
    const kind = speciesOf(dog);
    const startActivity = usualActivityFor(dog);
    // Set once loadExperienceLevels() resolves (cached after the first call
    // anywhere in the app, so usually already warm) -- lets marker taps
    // preview eligibility locally; see refreshEligibilityDisplay below.
    let previewLevel = null;

    function eligibilityBadgeHtml() {
      return eligibilityStatusHtml(dog, { eligibleText: 'Eligible to walk ✓' });
    }
    // Redraws everything that depends on eligibility/markers, called once
    // right after the initial render and again after every marker tap --
    // DOM patches rather than a full re-render, so an in-progress edit
    // elsewhere on the screen (e.g. the kennel-location picker) is never
    // disturbed. If a level is loaded, a pending marker change (not yet
    // saved) is previewed into `dog.eligible` first -- see previewEligibility
    // above. That's a local guess only: the real value is always re-fetched
    // from the server before a walk can actually start (see Start Walk).
    function refreshEligibilityDisplay() {
      const pending = state.walk.pendingMarkers;
      if (!tooYoung && previewLevel) {
        const { eligible, reason } = previewEligibility(dog, pending, previewLevel);
        if (eligible != null) { dog.eligible = eligible; dog.notEligibleReason = reason; }
      }
      const isEvo = (pending.blueMarkers || []).includes('blue_evo');
      // EVO (experienced volunteers only) overrides every other background —
      // it's the one caution that must never be missed, even over the hard
      // puppy block.
      appEl.classList.toggle('evo-caution-bg', isEvo);
      appEl.classList.toggle('age-block', !isEvo && tooYoung);
      // Listed as in foster isn't a block (Start only asks to check the
      // card), so no hazard stripes: its amber status row says it.
      appEl.classList.toggle('caution-stripes', !isEvo && !tooYoung && dog.eligible === false && dog.notEligibleReason !== 'in_foster');
      // PB overrides the days-in-shelter caution (handled server-side via
      // `eligible`), but still needs its own "short walk only" reminder.
      appEl.classList.toggle('pb-only-bg', !isEvo && !tooYoung && pending.pbFlag);
      const badgeEl = document.getElementById('eligibilityBadge');
      if (badgeEl) badgeEl.innerHTML = eligibilityBadgeHtml();
      const banner = document.getElementById('pbWarningBanner');
      if (banner) banner.classList.toggle('hidden', !pending.pbFlag);
      // A dog not cleared for this level can't be walked at all -- disabling
      // Start (rather than only catching it on click) means ticking PB back
      // off immediately blocks it again too, same as ticking it on unblocks it.
      const startBtnEl = document.getElementById('startWalkBtn');
      // Listed as in foster isn't a block: Start asks to check the kennel card.
      if (startBtnEl && !tooYoung) startBtnEl.disabled = dog.eligible === false && dog.notEligibleReason !== 'in_foster';
    }
    if (kind.levelRules) {
      loadExperienceLevels().then((levels) => {
        previewLevel = levels.find((l) => l.key === (state.currentUser.experienceLevel || 'beginner')) || levels[0] || null;
      }).catch(() => {});
    }

    // The timing tips are about POO dogs' walks: nothing to say without stickers.
    const timingHint = kind.stickers ? walkTimingHint(dog, state.walk.allWalks) : '';

    appEl.innerHTML = `
      <div class="stack tight walk-confirm">
        ${tooYoung ? `<div class="card compact hard-block-banner"><strong>🚫 Puppies under 6 months old can't be walked - no exceptions.</strong></div>` : ''}
        ${!tooYoung && kind.stickers ? `<div id="pbWarningBanner" class="pb-warning-banner hidden">Potty break only (PB): a short, potty-focused walk</div>` : ''}
        ${dog.handlingWarning ? `<div class="card compact hard-block-banner handling-warning" role="alert"><strong>⚠ You were with ${esc(dog.handlingWarning.name)} (an ${esc(dog.handlingWarning.adult)}) at ${esc(fmtClock(dog.handlingWarning.at))}.</strong> ${esc(dog.handlingWarning.young.charAt(0).toUpperCase() + dog.handlingWarning.young.slice(1))}s first, then ${esc(dog.handlingWarning.adult)}s: wash up and change before ${esc(dog.name)}.</div>` : ''}
        ${dog.stillListed === false ? `<div class="timing-hint" role="note">📋 ${esc(dog.name)} isn't on the shelter's site right now. You can still ${termsOf(dog).verbWith} them, and this ${termsOf(dog).noun} will be added to their record.</div>` : ''}
        ${!tooYoung && timingHint ? `<div class="timing-hint" role="note">ℹ️ ${esc(timingHint)} <button type="button" class="link-btn" id="timingHintGuideBtn">Which dogs should I walk?</button></div>` : ''}
        <div class="card compact${state.currentUser.isPrivileged ? ' has-corner-gear' : ''}" style="position:relative;">
          ${state.currentUser.isPrivileged ? `<button type="button" id="advancedSettingsBtn" class="icon-btn" style="position:absolute;top:8px;right:8px;" aria-label="Advanced settings" title="Advanced settings">
            <svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true">
              <path d="M19.14 12.94a7.14 7.14 0 0 0 .06-.94 7.14 7.14 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.14 7.14 0 0 0-.06.94 7.14 7.14 0 0 0 .06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>
            </svg>
          </button>` : ''}
          <div class="dog-card" data-dog-id="${dog.id}">
            <img loading="lazy" decoding="async" class="dog-photo" src="${dog.photoUrl ? esc(thumbOf(dog.photoUrl)) : '/icons/icon-192.png'}" alt="" />
            <div class="dog-info">
              <p class="dog-name" style="cursor:pointer;">${esc(dog.name)} ${speciesTagHtml(dog)} ${markerBadges(dog)}</p>
              ${akaHtml(dog)}
              <div class="dog-meta meta-wrap"><p class="meta-list">${[esc(dog.breed || ''), esc(dog.sex || ''), esc(fmtAge(dog.age)), `<span class="dog-id">ID ${dog.id}</span>`].filter(Boolean).map((s, i) => `<span class="meta-item${i ? ' nowrap' : ''}">${s}</span>`).join('')}</p></div>
              <p class="dog-meta">${shelterDaysHtml(dog)} in shelter</p>
              ${dog.currentWalk && !dog.currentWalk.mine ? currentWalkBadge(dog) : ''}
              <div id="eligibilityBadge">${eligibilityBadgeHtml()}</div>${youngBadgeHtml(dog)}
            </div>
          </div>
        </div>
        ${state.currentUser.isPrivileged ? `
        <div id="advancedSettingsPopup" class="popup-overlay hidden">
          <div class="popup-card">
            <h3 style="margin-top:0;">Advanced settings</h3>
            <p class="small muted" style="margin-top:0;">Alumni (returned dog) -- two independent options, use either, neither, or both.</p>
            <label class="small" style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" id="alumniCheck" ${dog.isAlumni ? 'checked' : ''} />
              Add bonus days toward eligibility
            </label>
            <div id="alumniBonusRow" class="${dog.isAlumni ? '' : 'hidden'}" style="margin-top:8px;">
              <label class="small" for="alumniBonusSelect">Bonus days</label>
              <select id="alumniBonusSelect" class="small">
                ${Array.from({ length: 15 }, (_, i) => i + 1).map((n) =>
                  `<option value="${n}" ${dog.alumniBonusDays === n ? 'selected' : ''}>${n}${n === 15 ? '+' : ''}</option>`
                ).join('')}
              </select>
            </div>
            <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:12px;">
              <input type="checkbox" id="strayHoldBypassCheck" ${dog.alumniBypassStrayHold ? 'checked' : ''} />
              Bypass stray hold (allow walking without PB)
            </label>
            <div class="row" style="margin-top:14px;">
              <button id="saveAlumniBtn" class="btn primary">Save</button>
              <button id="closeAdvancedPopupBtn" class="btn">Cancel</button>
            </div>
            <p id="alumniSaveStatus" class="small muted" style="margin:6px 0 0;"></p>
          </div>
        </div>` : ''}
        <div class="card compact">
          <div class="notes-card-head">
            <p class="small">${walksTogetherText(dog)}</p>
            ${showsPlaygroup(dog) ? `<button type="button" class="btn small-btn pg-mini-btn playgroup-notes-btn" data-dog-id="${dog.id}" data-short>${playgroupButtonLabel((dog.playgroupCounts || {}).notes, true)}</button>` : ''}
          </div>
          <div class="dog-notes-mount dog-notes-compact">${dogNotesShellHtml()}</div>
        </div>
        <div class="card compact">
          ${kind.stickers ? markerPickerHtml(dog) : ''}
          <label style="display:block;${kind.stickers ? 'margin-top:14px;' : ''}">${esc(kennelPickLabel(kind))}</label>
          ${kennelLetterPickerHtml('locationPicker', dog.kennelLocation || '', { disabled: tooYoung, letters: kennelsOf(dog) })}
          <div id="saveAllRow" class="row hidden" style="margin-top:10px;align-items:center;gap:10px;">
            <button id="saveAllBtn" class="btn">Save changes</button>
            <span id="saveAllCheckmark" class="save-checkmark hidden" aria-hidden="true">✓</span>
          </div>
          <p id="saveAllStatus" class="small muted" style="margin:6px 0 0;"></p>
        </div>
        ${tooYoung ? `<button id="startWalkBtn" class="btn primary big" disabled>Can't walk this dog</button>` : `
        <div class="action-dock">
          <div id="activityPickRow" class="marker-row activity-chips hidden">${activityChipsHtml(startActivity, kind.activities)}</div>
          <div class="row start-row">
            <button id="startWalkBtn" class="btn primary big" data-activity="${startActivity}">${startActivityLabel(startActivity)}</button>
            <button type="button" id="changeActivityBtn" class="btn" aria-expanded="false" aria-controls="activityPickRow">⇄ Change</button>
          </div>
        </div>`}
        <button id="backToScanBtn2" class="btn">Scan a different ${esc(nounFor(prefSpeciesKeys()))}</button>
      </div>`;

    // Paints the background/badge/banner/button-disabled state for what's
    // already on screen (the badge text itself was already right from the
    // template above; this adds the parts that need a live DOM node).
    refreshEligibilityDisplay();

    // Save Changes only appears once something on this screen actually
    // differs from what was loaded — nothing to save otherwise.
    const initialMarkersJson = JSON.stringify(state.walk.pendingMarkers);
    const initialLocation = dog.kennelLocation || '';
    function checkDirty() {
      const row = document.getElementById('saveAllRow');
      if (!row) return;
      const currentLocation = document.getElementById('locationPicker') ? kennelLetterPickerValue('locationPicker') : initialLocation;
      const dirty = JSON.stringify(state.walk.pendingMarkers) !== initialMarkersJson || currentLocation !== initialLocation;
      row.classList.toggle('hidden', !dirty);
    }
    wireMarkerPicker(state.walk.pendingMarkers, () => { checkDirty(); refreshEligibilityDisplay(); });
    mountDogNotes(appEl.querySelector('.dog-notes-mount'), dog, state.walk.allWalks);
    const timingGuideBtn = document.getElementById('timingHintGuideBtn');
    if (timingGuideBtn) timingGuideBtn.addEventListener('click', () => openGuide('which dogs'));
    wireKennelLetterPicker('locationPicker', checkDirty);

    if (state.currentUser.isPrivileged) {
      const gearBtn = document.getElementById('advancedSettingsBtn');
      const popup = document.getElementById('advancedSettingsPopup');
      const alumniCheck = document.getElementById('alumniCheck');
      const alumniBonusRow = document.getElementById('alumniBonusRow');
      gearBtn.addEventListener('click', () => openOverlay(popup));
      document.getElementById('closeAdvancedPopupBtn').addEventListener('click', () => closeOverlay(popup));
      popup.addEventListener('click', (e) => { if (e.target === popup) closeOverlay(popup); });
      alumniCheck.addEventListener('change', () => {
        alumniBonusRow.classList.toggle('hidden', !alumniCheck.checked);
      });
      document.getElementById('saveAlumniBtn').addEventListener('click', async () => {
        const statusEl = document.getElementById('alumniSaveStatus');
        const alumni = alumniCheck.checked;
        const bonusDays = parseInt(document.getElementById('alumniBonusSelect').value, 10);
        const bypassStrayHold = document.getElementById('strayHoldBypassCheck').checked;
        statusEl.textContent = 'Saving…';
        try {
          const updated = await api(`/api/dogs/${dog.id}/alumni`, {
            method: 'PUT',
            body: JSON.stringify({ alumni, bonusDays, bypassStrayHold, userId: state.currentUser.id })
          });
          dog.isAlumni = updated.isAlumni;
          dog.alumniBonusDays = updated.alumniBonusDays;
          dog.alumniBypassStrayHold = updated.alumniBypassStrayHold;
          // Same formula as effectiveDays in server.js's dogEligibility --
          // previousDaysInShelter (automatic, banked on a detected return)
          // stacks with the alumni bonus (manual), so both have to be
          // included here too or this recompute silently drops the former.
          dog.effectiveDaysInShelter = dog.daysInShelter + (dog.isAlumni ? dog.alumniBonusDays : 0) + (dog.previousDaysInShelter || 0);
          if (updated.eligible != null) dog.eligible = updated.eligible;
          dog.notEligibleReason = updated.notEligibleReason;
          // Close on save rather than reopening the popup after the
          // re-render — leaving it open made it easy to miss that anything
          // happened at all.
          closeOverlay(popup);
          renderWalkConfirm();
        } catch (err) {
          statusEl.textContent = `Failed: ${err.message}`;
        }
      });
    }

    // A species without stickers has nothing to save here. Sends only what
    // this person changed (saveMarkerChanges); only Save changes calls it.
    async function saveMarkers() {
      if (!kind.stickers) return null;
      return saveMarkerChanges(dog, state.walk.pendingMarkers);
    }
    function hasUnsavedMarkers() {
      return !!kind.stickers && !!markerPatch(markersOfDog(dog), state.walk.pendingMarkers);
    }
    // Someone changed this dog's stickers since it was opened (409): show
    // them as they are now and say so; this person's taps are dropped.
    async function reloadAfterStaleMarkers(err) {
      try {
        const fresh = await api(`/api/dogs/${dog.id}?userId=${state.currentUser.id}`);
        if (state.walk.dog === dog) {
          Object.assign(dog, fresh.dog);
          state.walk.pendingMarkers = markersOfDog(dog);
          renderWalkConfirm();
        }
      } catch (e) { /* the message below still says what happened */ }
      appAlert(err.serverMessage || err.message, 'Stickers changed');
    }

    async function applyMarkerUpdate(updated) {
      if (!updated) return;
      dog.blueMarkers = updated.blueMarkers;
      dog.pooStatus = updated.pooStatus;
      dog.starFlag = updated.starFlag;
      dog.pbFlag = updated.pbFlag;
      if (updated.version) dog.markersVersion = updated.version;
      // Eligibility can depend on several of these at once, which only the
      // server works out -- re-fetch rather than duplicating that logic
      // here, so this can't drift out of sync with server.js.
      try {
        const fresh = await api(`/api/dogs/${dog.id}?userId=${state.currentUser.id}`);
        dog.eligible = fresh.dog.eligible;
        dog.notEligibleReason = fresh.dog.notEligibleReason;
        dog.markersVersion = fresh.dog.markersVersion;
        dog.lockedMarkers = fresh.dog.lockedMarkers;
      } catch (err) { /* best effort -- badges just won't refresh instantly if this fails */ }
    }

    // One button saves everything on this screen — markers and kennel
    // location — so there's only one save tap and one status line to
    // scroll past on a phone. Alumni status is managed from the dog's
    // profile page instead (advanced settings, privileged users only).
    document.getElementById('saveAllBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('saveAllStatus');
      statusEl.textContent = 'Saving…';
      const location = kennelLetterPickerValue('locationPicker');
      try {
        const markerUpdate = await saveMarkers();
        await applyMarkerUpdate(markerUpdate);
        let msg = 'Saved ✓';
        if (location) {
          const locRes = await api(`/api/dogs/${dog.id}/location`, { method: 'PUT', body: JSON.stringify({ location }) });
          dog.kennelLocation = locRes.location;
        }
        statusEl.textContent = msg;
        renderWalkConfirm();
        // renderWalkConfirm() just rebuilt the DOM (needed so badges reflect
        // the new eligibility/alumni state), so grab the fresh checkmark
        // element rather than the one that existed before this handler ran.
        const check = document.getElementById('saveAllCheckmark');
        if (check) {
          check.classList.remove('hidden');
          setTimeout(() => check.classList.add('hidden'), 2000);
        }
      } catch (err) {
        if (err.staleMarkers) { await reloadAfterStaleMarkers(err); return; }
        statusEl.textContent = `Failed: ${err.message}`;
      }
    });

    // The start button offers the walker's usual activity (Settings);
    // "Change" swaps it for this dog. Every activity starts the same timed
    // session, only what's recorded differs.
    const changeBtn = document.getElementById('changeActivityBtn');
    const pickRow = document.getElementById('activityPickRow');
    if (changeBtn) {
      changeBtn.addEventListener('click', () => {
        const open = pickRow.classList.toggle('hidden') === false;
        changeBtn.setAttribute('aria-expanded', String(open));
      });
      // Stays open after a tap, so the second tap of a double tap lands on
      // the same chip (making it the usual), never on Start below it.
      syncActivityChips(pickRow, document.getElementById('startWalkBtn').dataset.activity, dog);
      pickRow.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-activity]');
        if (!chip) return;
        const btn = document.getElementById('startWalkBtn');
        if (chip.dataset.activity === btn.dataset.activity) {
          makeUsualActivity(chip.dataset.activity, pickRow, dog);
          return;
        }
        btn.dataset.activity = chip.dataset.activity;
        btn.textContent = startActivityLabel(chip.dataset.activity);
        syncActivityChips(pickRow, chip.dataset.activity, dog);
        pickedActivityToast(chip.dataset.activity, dog, 'Picked');
      });
    }
    const startBtn = document.getElementById('startWalkBtn');
    startBtn.addEventListener('click', async () => {
      const activity = startBtn.dataset.activity || 'walk';
      // Not a hard block -- just make sure it's a deliberate choice, since
      // the warning banner alone is easy to miss in the moment.
      if (dog.handlingWarning) {
        const proceed = await appConfirm(handlingWarningText(dog), {
          title: `⚠ ${dog.handlingWarning.adult.charAt(0).toUpperCase() + dog.handlingWarning.adult.slice(1)} before a ${dog.handlingWarning.young}`,
          confirmText: "I've washed up and changed", cancelText: 'Cancel', danger: true
        });
        if (!proceed) return;
      }
      const location = kennelLetterPickerValue('locationPicker');
      // Start never saves stickers by itself: a screen opened before staff
      // added one would quietly take it off again. Sticker taps not saved
      // yet are saved only when the walker says so here (and then only what
      // they changed); the server checks the result, not the local preview.
      if (hasUnsavedMarkers()) {
        const save = await appConfirm("You changed this dog's stickers but haven't saved them. Save them before you start?", {
          title: 'Unsaved stickers', confirmText: 'Save and start', cancelText: 'Cancel'
        });
        if (!save || state.walk.dog !== dog) return;
        startBtn.disabled = true;
        try {
          const markerUpdate = await saveMarkers();
          await applyMarkerUpdate(markerUpdate);
        } catch (err) {
          startBtn.disabled = false;
          if (err.staleMarkers) { await reloadAfterStaleMarkers(err); return; }
          appAlert(`Couldn't save: ${err.message}`);
          return;
        }
      }
      startBtn.disabled = true;
      if (!dog.tooYoung && dog.eligible === false && dog.notEligibleReason !== 'in_foster') {
        appAlert(`${dog.name} can't be walked right now at your experience level. ${notEligibleReasonText(dog)}. You can change your level any time from Settings (the gear icon, top right), or ask a privileged volunteer to adjust this dog's stickers.`);
        renderWalkConfirm();
        return;
      }
      // Listed as in foster, but here with their kennel card: the listing
      // may be behind, or it's the wrong card. Same check as a dog that's
      // off the site (selectDogById), not a block.
      if (dog.notEligibleReason === 'in_foster') {
        const goOn = await appConfirm(
          `${dog.name} (ID ${dog.id}) is listed as in foster care, not at the shelter. If they just came back, the listing may not have caught up yet. Check that the ${speciesOf(dog).noun} you're with matches the kennel card you scanned before you go on.`,
          { title: '⚠️ Listed as in foster', confirmText: 'It matches, continue', cancelText: 'Scan again' }
        );
        if (state.tab !== 'walk' || state.walk.dog !== dog) return;
        if (!goOn) { state.walk.phase = 'scanning'; renderWalk(); return; }
      }
      try {
        const res = await api('/api/walks/start', {
          method: 'POST',
          body: JSON.stringify({ dogId: dog.id, location, userId: state.currentUser.id, activity })
        });
        dog.kennelLocation = res.location;
        state.walk.walkId = res.walkId;
        state.walk.startedAt = res.startedAt;
        state.walk.stopsAt = res.stopsAt;
        state.walk.closesAt = res.closesAt;
        state.walk.endsBy = res.endsBy || null;
        state.walk.endToken = res.endToken || null;
        state.walk.autoStopped = false;
        state.walk.activity = activity;
        state.walk.location = res.location || location;
        state.walk.phase = 'active';
        renderWalk();
      } catch (err) {
        startBtn.disabled = false;
        // Refused (say staff added a sticker since this screen opened): show
        // the dog as it is now, not a stale "Eligible to walk ✓" with Start
        // still on (audit 3). A network failure keeps the screen as it is.
        if (err.status >= 400 && err.status < 500) {
          try {
            const fresh = await api(`/api/dogs/${dog.id}?userId=${state.currentUser.id}`);
            if (state.walk.dog === dog && state.walk.phase !== 'active') {
              Object.assign(dog, fresh.dog);
              state.walk.pendingMarkers = markersOfDog(dog);
              renderWalkConfirm();
            }
          } catch (e) { /* the message below still says what happened */ }
        }
        appAlert(err.message);
      }
    });
    document.getElementById('backToScanBtn2').addEventListener('click', () => {
      state.walk.phase = 'scanning';
      renderWalk();
    });
  }

  // Kennel locations are just the wing letter, picked by tapping it -- the
  // same chips as the Available list's "Kennel wing" filter. Tapping the
  // selected letter again clears it, unless the picker is made with
  // required: true. The current value lives on the picker's data-value.
  // letters: the species' own (dogs A-E, cats A-D); the default is the dog
  // wings, which Audit Mode walks.
  const KENNEL_LETTERS = ['A', 'B', 'C', 'D', 'E'];
  function kennelLetterPickerHtml(pickerId, selected, { disabled = false, letters = KENNEL_LETTERS } = {}) {
    const value = letters.includes(selected) ? selected : '';
    return `<div id="${pickerId}" class="marker-row" style="gap:6px;" data-value="${value}">${letters.map((letter) => `
      <button type="button" class="btn small-btn filter-chip ${value === letter ? 'active' : ''}" data-letter="${letter}" style="width:auto;flex:0 0 44px;" ${disabled ? 'disabled' : ''}>${letter}</button>`).join('')}</div>`;
  }
  function kennelLetterPickerValue(pickerId) {
    const picker = document.getElementById(pickerId);
    return picker ? picker.dataset.value : '';
  }
  function setKennelLetterPicker(pickerId, letter) {
    const picker = document.getElementById(pickerId);
    if (!picker) return;
    picker.dataset.value = letter || '';
    picker.querySelectorAll('[data-letter]').forEach((b) => b.classList.toggle('active', b.dataset.letter === letter));
  }
  function wireKennelLetterPicker(pickerId, onChange, { required = false } = {}) {
    const picker = document.getElementById(pickerId);
    if (!picker) return;
    picker.querySelectorAll('[data-letter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const letter = btn.dataset.letter;
        const next = picker.dataset.value === letter ? (required ? letter : '') : letter;
        setKennelLetterPicker(pickerId, next);
        if (onChange) onChange(next);
      });
    });
  }

  // A lettered blue marker or POO priority implies its blank/plain base
  // marker is also "on" — this recomputes every shape's active class from
  // `pending` from scratch, so that implication is always reflected however
  // `pending` got there (initial load or any click).
  function markerPickerHtml(dog) {
    // Stickers that keep this volunteer's level off the dog (server.js
    // lockedMarkersFor): only staff or a privileged volunteer can take them off.
    const locked = new Set((dog && dog.lockedMarkers) || []);
    const lockAttrs = (key, name) => (locked.has(key)
      ? ` disabled aria-disabled="true" title="${esc(name)}: only staff or a privileged volunteer can take this off"` : ` title="${esc(name)}"`);
    // A small 🔒 on each locked sticker, so the hint below can point at it.
    const lockIcon = (key) => (locked.has(key) ? '<span class="marker-lock" aria-hidden="true">🔒</span>' : '');
    return `
      <label class="small">Behavior stickers (tap to turn on or off)</label>
      <div class="marker-row">
        <button type="button" class="marker-shape star" data-group="star" title="Good for beginners" aria-label="Good for beginners (star)">★</button>
        ${BLUE_MARKERS.map((m) => `<button type="button" class="marker-shape blue${m.rect ? ' rect' : ''}" data-group="blue" data-value="${m.value}"${lockAttrs(m.value, m.name)} aria-label="${esc(m.name)}${locked.has(m.value) ? ' (locked)' : ''}">${esc(m.letter)}${lockIcon(m.value)}</button>`).join('')}
      </div>
      <label class="small" style="display:block;margin-top:14px;">POO status</label>
      <div class="marker-row">
        <button type="button" class="marker-shape poo" data-group="poo" data-value="poo" title="POO dog" aria-label="POO dog"></button>
        <button type="button" class="marker-shape poo-priority" data-group="poo" data-value="priority" title="High priority POO dog" aria-label="High priority POO dog">${ASTERISK_SVG}</button>
        <button type="button" class="marker-shape pb" data-group="pb"${lockAttrs('pb', 'PB: Potty break only, a short potty walk. Clears the days-in-shelter wait')} aria-label="PB: Potty break only${locked.has('pb') ? ' (locked)' : ''}">PB${lockIcon('pb')}</button>
      </div>
      ${locked.size ? '<p class="small muted marker-lock-hint">🔒 Stickers with a lock are there for volunteers at your level. Only staff or a privileged volunteer can take them off.</p>' : ''}
      ${dog ? stickerAddedHtml(dog) : ''}`;
  }

  // A dog's stickers as the server last sent them (dog.markersVersion is
  // their version).
  function markersOfDog(dog) {
    return { blueMarkers: [...(dog.blueMarkers || [])], pooStatus: dog.pooStatus || 'none', starFlag: !!dog.starFlag, pbFlag: !!dog.pbFlag };
  }
  // Only what this person changed, as a patch for PUT /api/dogs/:id/markers,
  // or null when nothing changed. A sticker someone else added or took off
  // meanwhile is never sent back.
  function markerPatch(before, after) {
    const was = new Set(before.blueMarkers);
    const now = new Set(after.blueMarkers);
    const add = [...now].filter((m) => !was.has(m));
    const remove = [...was].filter((m) => !now.has(m) && m !== 'blue');
    const patch = {};
    if (add.length || remove.length) patch.blueMarkers = { add, remove };
    if (before.pooStatus !== after.pooStatus) patch.pooStatus = after.pooStatus;
    if (!!before.starFlag !== !!after.starFlag) patch.starFlag = !!after.starFlag;
    if (!!before.pbFlag !== !!after.pbFlag) patch.pbFlag = !!after.pbFlag;
    return Object.keys(patch).length ? patch : null;
  }
  // Saves this person's sticker changes to `dog`. Answers null when there was
  // nothing to save. A 409 (someone changed the stickers since this dog was
  // loaded) comes back as an error with err.staleMarkers set.
  async function saveMarkerChanges(dog, pending) {
    const patch = markerPatch(markersOfDog(dog), pending);
    if (!patch) return null;
    try {
      return await api(`/api/dogs/${dog.id}/markers`, { method: 'PUT', body: JSON.stringify({ patch, version: dog.markersVersion || null }) });
    } catch (err) {
      if (err.status === 409 && err.body && err.body.staleMarkers) err.staleMarkers = true;
      throw err;
    }
  }

  // root: where the picker lives (the edit popup passes its own, so the
  // page behind it is never touched).
  function applyPickerState(pending, root = document) {
    const effectiveBlue = withImpliedBlank(pending.blueMarkers);
    root.querySelectorAll('.marker-shape[data-group="blue"]').forEach((btn) => {
      btn.classList.toggle('active', effectiveBlue.includes(btn.dataset.value));
    });
    // POO is a strict single-select — plain and priority are unlinked, at
    // most one of them is ever active.
    root.querySelectorAll('.marker-shape[data-group="poo"]').forEach((btn) => {
      btn.classList.toggle('active', pending.pooStatus === btn.dataset.value);
    });
    const starBtn = root.querySelector('.marker-shape[data-group="star"]');
    if (starBtn) starBtn.classList.toggle('active', pending.starFlag);
    const pbBtn = root.querySelector('.marker-shape[data-group="pb"]');
    if (pbBtn) pbBtn.classList.toggle('active', pending.pbFlag);
  }

  // Wires click-to-toggle behavior directly on the DOM (no re-render), so an
  // in-progress kennel-location edit in the same screen is never disturbed.
  // `pending` is mutated in place.
  //   - blue shapes: each independently toggleable, any combination allowed
  //     (a lettered one implies the blank one too — see applyPickerState).
  //   - poo shapes (plain / priority "*"): strict single-select, unlinked —
  //     you can have plain OR priority OR neither, never both.
  //   - star: an independent boolean, distinct from POO priority.
  //   - pb (Potty break only): an independent boolean; clears the days-in-
  //     shelter wait for levels allowed PB dogs, since it authorizes a
  //     short walk regardless (see the eligibility rules in server.js).
  function wireMarkerPicker(pending, onChange, root = document) {
    applyPickerState(pending, root);
    root.querySelectorAll('.marker-shape').forEach((btn) => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        const value = btn.dataset.value;
        if (group === 'blue') {
          if (pending.blueMarkers.includes(value)) {
            pending.blueMarkers = pending.blueMarkers.filter((m) => m !== value);
          } else {
            pending.blueMarkers.push(value);
          }
        } else if (group === 'poo') {
          pending.pooStatus = pending.pooStatus === value ? 'none' : value;
        } else if (group === 'star') {
          pending.starFlag = !pending.starFlag;
        } else if (group === 'pb') {
          pending.pbFlag = !pending.pbFlag;
        }
        applyPickerState(pending, root);
        if (onChange) onChange();
      });
    });
  }

  // The animal you're out with, at the top of the walk screen: its photo
  // (tap for full screen), or its drawn silhouette when it has none yet.
  function walkHeadPhotoHtml(dog) {
    const silhouette = `/dog-silhouettes/${dog.species === 'cat' ? 'cat-' : ''}${encodeURIComponent(String(dog.id))}.svg?v=1`;
    const src = dog.photoUrl || silhouette;
    const real = !/\/dog-silhouettes\//.test(src);
    return `<img class="dog-photo walk-head-photo${real ? ' photo-lightbox-trigger' : ' photo-fallback'}" src="${esc(real ? thumbOf(src) : src)}" alt="${esc(dog.name)}" data-dog-id="${esc(String(dog.id))}" data-species="${esc(dog.species || 'dog')}" />`;
  }

  let timerInterval = null;
  function renderWalkActive() {
    const w = state.walk;
    appEl.innerHTML = `
      <div class="stack">
        ${w.dog.pbFlag ? `<div class="pb-warning-banner">Potty break only (PB): a short, potty-focused walk</div>` : ''}
        <div class="card">
          <div class="timer-display">${fmtClock(w.startedAt)}</div>
          <p class="muted small center checkout-caption">⏰ Check-out time: write this on the ${kennelWordOf(w.dog)}${kennelWordOf(w.dog) === 'condo' ? ' card' : ''}</p>
          ${walkHeadPhotoHtml(w.dog)}
          <p class="walk-dog-name walk-head-name">${esc(w.dog.name)} ${sexIcon(w.dog.sex)} ${markerBadges(w.dog)}</p>
          ${akaHtml(w.dog, 'center')}
          <p class="center walk-head-id dog-id">ID ${w.dog.id}</p>
          ${w.dog.awaitingListing ? `<p class="small center unlisted-note">📋 Details not in yet. This ${activityInfo(w.activity).noun} will be added to their record once the shelter lists them.</p>`
            : w.dog.stillListed === false ? `<p class="small center unlisted-note">📋 Not on the shelter's site right now. This ${activityInfo(w.activity).noun} will still be added to their record.</p>` : ''}
          <p class="walk-location">Return to: <span class="nowrap">🏠 ${w.location ? esc(w.location) : 'location not recorded'}</span></p>
          ${offlineWalkNoteHtml(w)}
          <div class="timer-display" id="timerDisplay">00:00</div>
          ${speciesOf(w.dog).visitMinutes ? `<p class="small center muted visit-hint" id="visitHint">${speciesOf(w.dog).visitMinutes[0]} to ${speciesOf(w.dog).visitMinutes[1]} minutes is usually best</p>` : ''}
        </div>
        ${relockNeeded(w.dog) ? `<div class="card compact relock-banner" role="note">🔒 <strong>Being adopted:</strong> their condo stays locked. Lock it again when you're done.</div>` : ''}
        <div class="card compact">
          <label class="small">Doing something else?</label>
          <div id="activityChoice" class="marker-row activity-chips">${activityChipsHtml(w.activity || 'walk', speciesOf(w.dog).activities)}</div>
        </div>
        <button type="button" id="walkPlaygroupBtn" class="btn primary playgroup-notes-btn${w.activity === 'playgroup' ? '' : ' hidden'}" data-dog-id="${w.dog.id}" data-session>${playgroupSessionButtonLabel((w.dog.playgroupCounts || {}).notes)}</button>
        <div class="card compact autostop-card" id="autoStopCard">
          <span class="small" id="autoStopText"></span>
          <button type="button" id="extendWalkBtn" class="btn small-btn">＋${SHARED_CONFIG.extendMinutes} min</button>
        </div>
        <div class="card compact">
          <button type="button" id="walkNotesToggle" class="notes-toggle" aria-expanded="false">
            <span>📝 Tips &amp; notes</span><span class="notes-toggle-chevron">▾</span>
          </button>
          <div class="dog-notes-mount hidden"></div>
        </div>
        <button id="viewProfileBtn" class="btn">View full profile</button>
        <button id="earlierWalksBtn" class="btn">✎ Edit an earlier activity / notes</button>
        <div class="action-dock"><button id="endWalkBtn" class="btn danger big">End ${activityInfo(w.activity).label.toLowerCase()}</button></div>
        <button id="cancelWalkBtn" class="btn">Cancel ${activityInfo(w.activity).label.toLowerCase()}</button>
      </div>`;
    // Switching activity mid-session keeps the same timer; it just changes
    // what gets recorded.
    // Tap again (or double tap) to make it the usual, as on the start screen.
    // `picked` follows taps at once, so a double tap's second tap counts as
    // "again" even while the first one is still saving.
    const choiceRow = document.getElementById('activityChoice');
    syncActivityChips(choiceRow, w.activity || 'walk', w.dog);
    let picked = w.activity || 'walk';
    document.querySelectorAll('#activityChoice [data-activity]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const activity = chip.dataset.activity;
        if (activity === picked) { makeUsualActivity(activity, choiceRow, w.dog); return; }
        const before = picked;
        picked = activity;
        try {
          const res = await api(`/api/walks/${w.walkId}`, { method: 'PUT', body: JSON.stringify({ activity }) });
          state.walk.activity = activity;
          // A daycation has its own time limit, so switching moves the stop.
          if (res.stopsAt) state.walk.stopsAt = res.stopsAt;
          state.walk.closesAt = res.closesAt || null;
          state.walk.endsBy = res.endsBy || null;
          saveLocalWalk();
          const a = activityInfo(activity);
          document.getElementById('endWalkBtn').textContent = `End ${a.label.toLowerCase()}`;
          document.getElementById('cancelWalkBtn').textContent = `Cancel ${a.label.toLowerCase()}`;
          topbarTitle.textContent = `${a.label} in progress`;
          updateWalkTabLabel();
          syncActivityChips(choiceRow, activity, w.dog);
          document.getElementById('walkPlaygroupBtn').classList.toggle('hidden', activity !== 'playgroup');
          pickedActivityToast(activity, w.dog, 'Switched to');
        } catch (err) { picked = before; toast(err.message, 'error'); }
      });
    });
    // Collapsed by default -- kept out of the way while you're actually
    // with the dog -- and only fetched/mounted the first time it's opened,
    // so it's not a wasted request for a walk where no one ever taps it.
    const notesMount = appEl.querySelector('.dog-notes-mount');
    let notesLoaded = false;
    document.getElementById('walkNotesToggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const open = notesMount.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('open', open);
      if (open && !notesLoaded) {
        notesLoaded = true;
        notesMount.innerHTML = dogNotesShellHtml();
        mountDogNotes(notesMount, w.dog, state.walk.allWalks);
      }
    });
    document.getElementById('viewProfileBtn').addEventListener('click', () => showProfileSheet(w.dog, state.walk.allWalks));
    // Today's finished walks, each with its editor (times, activity) and
    // 📝 Dog notes -- this walk keeps running; the Walk tab comes back to it.
    document.getElementById('earlierWalksBtn').addEventListener('click', () => {
      state.statsScope = 'mine';
      state.statsRange = 'today';
      state.statsView = 'summary';
      // A step on top of the walk, not a tab switch: the phone's Back
      // returns to the walk in progress, not to Available (audit 3).
      state.tab = 'stats';
      tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === 'stats'));
      topbarTitle.textContent = TAB_TITLES.stats;
      pushHistory({ sheet: null });
      render();
    });
    // The walk ends now, on the server too (so the dog is free for everyone
    // right away), not when the notes are saved.
    document.getElementById('endWalkBtn').addEventListener('click', () => endWalkAt(new Date().toISOString()));
    document.getElementById('cancelWalkBtn').addEventListener('click', async () => {
      if (!(await appConfirm(`Cancel this ${activityInfo(state.walk.activity).noun} with ${w.dog.name}? It won't be recorded.`, { title: `Cancel ${activityInfo(state.walk.activity).noun}`, confirmText: `Cancel ${activityInfo(state.walk.activity).noun}`, cancelText: 'Keep going', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        clearInterval(timerInterval);
        forgetWalkOnDevice(w.walkId);
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        if (err.status === 404) { walkDeletedElsewhere(state.walk); return; }
        appAlert(err.message);
      }
    });

    document.getElementById('extendWalkBtn').addEventListener('click', async () => {
      const btn = document.getElementById('extendWalkBtn');
      btn.disabled = true;
      try {
        const res = await api(`/api/walks/${w.walkId}/extend`, { method: 'POST' });
        state.walk.stopsAt = res.stopsAt;
        saveLocalWalk();
        toast(`Added ${res.addedMinutes} minutes`);
      } catch (err) {
        if (err.body && err.body.autoStopped) { toast(err.message, 'error'); handleAutoStopped(); }
        // Ended on another device or tab: straight to its end screen, where
        // the note can still be saved.
        else if (err.status === 409 && /already ended/i.test(err.serverMessage || '')) recheckWalkElsewhere({ force: true });
        else if (err.status === 404) walkDeletedElsewhere(state.walk);
        else toast(err.message, 'error');
      } finally { btn.disabled = false; }
    });

    if (timerInterval) clearInterval(timerInterval);
    const startedMs = new Date(w.startedAt).getTime();
    // Fallback before the server says: the activity's own limit (matchmaking
    // runs 60 minutes, not the walk's 45; a daycation 12 hours).
    const stopsMs = () => (state.walk.stopsAt ? new Date(state.walk.stopsAt).getTime() : startedMs + activityLimitMinutes(state.walk.activity) * 60000);
    const tick = () => {
      const el = document.getElementById('timerDisplay');
      if (!el) { clearInterval(timerInterval); return; }
      // On the server's clock (serverNow), so a phone minutes fast or slow
      // still shows the real elapsed time and time left (audit 3).
      const now = serverNow();
      el.textContent = fmtElapsed((now - startedMs) / 1000);
      // Cats: a gentle "time to wrap up" once past the suggested length.
      const visit = speciesOf(state.walk.dog).visitMinutes;
      const hint = document.getElementById('visitHint');
      if (visit && hint) {
        const long = now - startedMs >= visit[1] * 60000;
        el.classList.toggle('visit-long', long);
        hint.classList.toggle('visit-long', long);
        hint.textContent = long ? `${visit[1]} minutes: a good time to say goodbye` : `${visit[0]} to ${visit[1]} minutes is usually best`;
      }
      const left = (stopsMs() - now) / 1000;
      const text = document.getElementById('autoStopText');
      const card = document.getElementById('autoStopCard');
      const daycation = state.walk.activity === 'daycation';
      // Held to closing: show the official closing time (audit 3), never
      // the server's quiet stop a little after it.
      const closesMs = !daycation && state.walk.closesAt ? new Date(state.walk.closesAt).getTime() : Infinity;
      const shownMs = Math.min(stopsMs(), closesMs);
      const shownLeft = (shownMs - now) / 1000;
      if (text) {
        text.textContent = daycation
          ? `🚗 Daycations can last up to ${SHARED_CONFIG.daycationMinutes / 60} hours. Stops automatically at ${fmtClock(new Date(stopsMs()).toISOString())}.`
          : shownLeft > 0 ? `Stops automatically at ${fmtClock(new Date(shownMs).toISOString())} (${fmtElapsed(shownLeft)} left)`
            : `Stops automatically at ${fmtClock(new Date(shownMs).toISOString())}`;
      }
      if (card) card.classList.toggle('warn', shownLeft <= 180);
      const extendBtn = document.getElementById('extendWalkBtn');
      if (extendBtn) extendBtn.classList.toggle('hidden', daycation);
      // At the limit, ask the server what happened -- but not every second
      // while it still says "running" (its stop runs a moment later, or a
      // clock is off): wait 3, 6, 12, then 30 s between asks (audit 3).
      if (left > 0) autoStopPoll.delay = 0;
      else if (now >= autoStopPoll.nextAt) {
        autoStopPoll.delay = autoStopPoll.walkId === state.walk.walkId ? Math.min(30000, (autoStopPoll.delay || 1500) * 2) : 3000;
        autoStopPoll.walkId = state.walk.walkId;
        autoStopPoll.nextAt = now + autoStopPoll.delay;
        clearInterval(timerInterval);
        handleAutoStopped();
      }
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  // The time limit was reached. The server has (or is about to) end the walk
  // and flag it; ask it what happened rather than assuming, since the walk
  // may have been extended from another device.
  let handlingAutoStop = false;
  // When the timer may next ask the server about a walk at its limit.
  const autoStopPoll = { walkId: null, nextAt: 0, delay: 0 };
  async function handleAutoStopped() {
    if (handlingAutoStop || state.walk.phase !== 'active') return;
    handlingAutoStop = true;
    try {
      const { walk, wrapUp } = await api(`/api/walks/active?userId=${state.currentUser.id}`);
      if (walk && walk.id === state.walk.walkId) {
        state.walk.stopsAt = walk.stopsAt; // still running (extended elsewhere): carry on
        renderWalk();
      } else if (wrapUp && wrapUp.id === state.walk.walkId && state.walk.phase === 'active') {
        // Same end screen as End Walk, asking when it really ended (or, if
        // End was tapped on another device, just for the notes).
        adoptWrapUp(state.walk, wrapUp);
        renderWalk();
      } else if (state.walk.phase === 'active') {
        const secs = Math.round((new Date(state.walk.stopsAt || Date.now()).getTime() - new Date(state.walk.startedAt).getTime()) / 1000);
        state.walk.durationSeconds = secs;
        state.walk.autoStopped = true;
        state.walk.phase = 'summary';
        try { await api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: state.walk.dog.id, dateKey: todayKey() }) }); } catch (e) { /* non-critical */ }
        renderWalk();
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally { handlingAutoStop = false; }
  }

  // Ending by hand: the walk ended when End Walk was tapped, and that end is
  // already on the server (endWalkAt); this screen only adds the notes, via
  // PUT /api/walks/:id. If the time limit stopped it instead
  // (wrapUpEndedAt), the same screen asks when it really ended: just now, at
  // the limit, or a picked time -- after the start, not in the future, and
  // within the 3 hour maximum. A changed time shows as Edited, with the
  // time-limit end kept as the original. Typed notes are kept on this device
  // as a draft until saved (endDraft), so Back, a reload or a closed tab
  // doesn't lose them.
  function renderWalkEnding() {
    const w = state.walk;
    const wrapUp = !!w.wrapUpEndedAt;
    const startedMs = new Date(w.startedAt).getTime();
    const draft = readEndDraft(w.walkId);
    // Walks end by closing time (7pm), so nothing later can be picked. The
    // server's endsBy is the real limit (a little past it); wording always
    // names the official closesAt.
    const closesMs = w.endsBy ? new Date(w.endsBy).getTime() : w.closesAt ? new Date(w.closesAt).getTime() : Infinity;
    const maxHours = maxActivityHours(w.activity);
    const latestMs = () => Math.min(Date.now(), startedMs + maxHours * 3600000, closesMs);
    const stoppedAtClosing = wrapUp && !!w.closesAt && new Date(w.wrapUpEndedAt).getTime() >= new Date(w.closesAt).getTime();
    // Stopped at closing: named by the official closing time.
    const limitLabel = stoppedAtClosing && w.closesAt ? w.closesAt : w.wrapUpEndedAt;
    // audit 3: "Just now" is the real now, offered only while it still is
    // (not past the longest allowed), and preselected only when the walker
    // is back within a few minutes of the stop; otherwise "At [limit]".
    const nowOffered = wrapUp && !stoppedAtClosing && Date.now() <= Math.min(startedMs + maxHours * 3600000, closesMs);
    const nowDefault = nowOffered && Date.now() - new Date(w.wrapUpEndedAt).getTime() <= 5 * 60000;
    appEl.innerHTML = `
      <div class="stack">
        <div class="card">
          <p class="walk-dog-name">${esc(w.dog.name)}</p>
          ${wrapUp ? `
          <p class="small autostop-note">⏱ ${stoppedAtClosing
    ? `${capFirst(termsOf(w.dog).nouns)} end at ${fmtClock(w.closesAt)}, so this one stopped automatically.`
    : `This ${activityInfo(w.activity).noun} reached its time limit and stopped automatically at ${fmtClock(w.wrapUpEndedAt)}.`}</p>
          <label>When did the ${activityInfo(w.activity).noun} end?</label>
          <div id="endTimeChoice" class="marker-row" style="gap:6px;">
            ${nowOffered ? `<button type="button" class="btn small-btn filter-chip ${nowDefault ? 'active' : ''}" data-end="now" style="width:auto;flex:1 1 0;">Just now</button>` : ''}
            <button type="button" class="btn small-btn filter-chip ${nowDefault ? '' : 'active'}" data-end="limit" style="width:auto;flex:1 1 0;">At ${fmtClock(limitLabel)}</button>
            <button type="button" class="btn small-btn filter-chip" data-end="pick" style="width:auto;flex:1 1 0;">Pick a time</button>
          </div>
          <input type="time" id="walkEndTime" class="hidden" aria-label="${esc(capFirst(activityInfo(w.activity).noun))} ended at" value="${toLocalTimeInput(limitLabel)}" style="margin-top:6px;" />
          <p class="small muted" id="walkEndSummary" style="margin:4px 0 10px;" aria-live="polite"></p>` : `<p class="center muted">${esc(activityInfo(w.activity).label)} finished${w.endTappedAt ? ` at ${fmtClock(w.endSynced ? w.endTappedAt : new Date(new Date(w.endTappedAt).getTime() + serverClockOffsetMs).toISOString())}` : ''}. Add any notes before saving.</p>`}
          ${offlineWalkNoteHtml(w)}
          ${wrapUpChecklistHtml(w.dog)}
          ${w.activity === 'playgroup' ? `<div id="walkPlaygroupNote">
            <label>Playgroup note (optional)</label>
            ${pgEditorHtml({ showDate: false, text: draft.pg ? draft.pg.text : '', placeholder: `How did ${w.dog.name} do? Type @ to tag a dog they played with.` })}
          </div>` : ''}
          <label>Note for other volunteers (optional)</label>
          <div id="walkNotesBox">${noteTagBoxHtml({ id: 'walkNotes', placeholder: speciesOf(w.dog).notePlaceholder || '', cls: 'end-note-text' })}</div>
          <p class="small muted" style="margin:2px 0 10px;">Shared with every volunteer. Your name is not shown. ${tagHint()}, and the note shows on theirs too.</p>
          <label>Private note for yourself (optional)</label>
          <div id="walkPrivateNoteBox">${noteTagBoxHtml({ id: 'walkPrivateNote', placeholder: 'Only you can see this', cls: 'end-note-text' })}</div>
        </div>
        <div class="action-dock"><button id="saveWalkBtn" class="btn primary big">Save &amp; finish</button></div>
        <div class="danger-zone">
          <button id="cancelWalkBtn" class="btn danger-outline">Delete this ${activityInfo(w.activity).noun}…</button>
        </div>
      </div>`;

    // Wrap-up only: the chosen end time as an ISO time, or null to keep the
    // time-limit end. A picked time earlier in the day than the start means
    // the walk ran past midnight.
    let choice = nowDefault ? 'now' : 'limit';
    const endInput = document.getElementById('walkEndTime');
    // The picked clock time on the walk's day -- or the next day, only when
    // that's still a possible end (a daycation running past midnight). A
    // time before the start is not taken as tomorrow ("23h 55m"): pickError
    // says it can't be before the start.
    const pickedMs = () => {
      const ms = new Date(localTimeToIso(dateKey(w.startedAt), endInput.value)).getTime();
      return ms < startedMs && ms + 24 * 3600000 <= latestMs() ? ms + 24 * 3600000 : ms;
    };
    const pickError = () => {
      if (!wrapUp || choice !== 'pick' || !endInput.value) return null;
      const ms = pickedMs();
      if (!Number.isFinite(ms)) return 'That end time is not a valid time.';
      if (ms < startedMs) return `The end can't be before the start (${fmtClock(w.startedAt)}).`;
      if (ms > Date.now()) return "The end time can't be in the future.";
      if (ms > startedMs + maxHours * 3600000) return `${w.activity === 'daycation' ? 'Daycations' : capFirst(termsOf(w.dog).nouns)} can't be longer than ${maxHours} hours.`;
      if (ms > closesMs) return `${capFirst(termsOf(w.dog).nouns)} end by ${fmtClock(w.closesAt)}, so the end time can't be later than that.`;
      return null;
    };
    const chosenEnd = () => {
      if (choice === 'now') return new Date(latestMs()).toISOString();
      if (choice === 'limit' || !endInput.value || endInput.value === toLocalTimeInput(limitLabel)) return null;
      return new Date(pickedMs()).toISOString();
    };
    let summaryTimer = null;
    if (wrapUp) {
      const updateEndSummary = () => {
        const summary = document.getElementById('walkEndSummary');
        if (!summary) { clearInterval(summaryTimer); return; }
        const error = pickError();
        summary.classList.toggle('field-error', !!error);
        summary.classList.toggle('muted', !error);
        const saveBtn = document.getElementById('saveWalkBtn');
        if (saveBtn) saveBtn.disabled = !!error;
        if (error) { summary.textContent = error; return; }
        const secs = (new Date(chosenEnd() || w.wrapUpEndedAt).getTime() - startedMs) / 1000;
        summary.textContent = `${activityInfo(w.activity).label} time: ${fmtDuration(secs)}`;
      };
      document.querySelectorAll('#endTimeChoice [data-end]').forEach((btn) => {
        btn.addEventListener('click', () => {
          choice = btn.dataset.end;
          document.querySelectorAll('#endTimeChoice [data-end]').forEach((b) => b.classList.toggle('active', b === btn));
          endInput.classList.toggle('hidden', choice !== 'pick');
          if (choice === 'pick') endInput.focus();
          updateEndSummary();
        });
      });
      endInput.addEventListener('input', updateEndSummary);
      updateEndSummary();
      summaryTimer = setInterval(updateEndSummary, 15000); // "Just now" keeps moving
    }

    const pgBox = document.getElementById('walkPlaygroupNote');
    const pgPicks = draftPicks(draft.pg);
    const pgEditor = pgBox ? wirePgEditor(pgBox, { ownId: w.dog.id, picks: pgPicks }) : null;
    const sharedNoteBox = wireNoteTagBox(document.getElementById('walkNotesBox'), { ownId: w.dog.id, guard: false, ...draftBoxStart(draft.notes) });
    const privateNoteBox = wireNoteTagBox(document.getElementById('walkPrivateNoteBox'), { ownId: w.dog.id, maxLength: PRIVATE_NOTE_MAX_CHARS, guard: false, ...draftBoxStart(draft.priv) });
    // Every change is kept as this walk's draft (see endDraft above).
    // Not once this walk is gone from the screen (saved, deleted here or
    // elsewhere): a late blur would otherwise bring its draft back.
    const keepDraft = () => state.walk === w && w.phase === 'ending' && writeEndDraft(w.walkId, {
      notes: draftOf(sharedNoteBox.el, sharedNoteBox.picks),
      priv: draftOf(privateNoteBox.el, privateNoteBox.picks),
      pg: pgBox ? draftOf(pgBox.querySelector('.pg-text'), pgPicks) : null
    });
    [sharedNoteBox.el, privateNoteBox.el, pgBox && pgBox.querySelector('.pg-text')].forEach((el) => {
      if (el) { el.addEventListener('input', keepDraft); el.addEventListener('blur', keepDraft); }
    });
    const saveBtn = document.getElementById('saveWalkBtn');
    let saving = false;
    saveBtn.addEventListener('click', async () => {
      // A second tap while the first is still saving does nothing.
      if (saving) return;
      if (pickError()) { document.getElementById('walkEndSummary').focus?.(); return; }
      saving = true;
      saveBtn.disabled = true;
      keepDraft();
      const notes = sharedNoteBox.body();
      const playgroupNote = pgEditor ? pgEditor.body() : '';
      const privateNote = privateNoteBox.body();
      const endedAt = wrapUp ? chosenEnd() : null;
      try {
        let res;
        if (wrapUp) {
          try {
            res = await api(`/api/walks/${w.walkId}/end`, { method: 'PUT', body: JSON.stringify({ notes, ...(endedAt ? { endedAt } : {}) }) });
          } catch (err) {
            // Already stopped by the time limit and no longer waiting for an
            // end time (e.g. saved from another device, or a second tap
            // that got past the first): it's this walk, so just attach the notes.
            if (err.status === 409 && err.body && err.body.alreadyEnded) {
              // Not swallowed: if the note can't be attached, the draft stays
              // and the alert below says to try again.
              if (notes) await api(`/api/walks/${w.walkId}`, { method: 'PUT', body: JSON.stringify({ notes }) });
              res = { durationSeconds: err.body.durationSeconds };
              state.walk.autoStopped = !!err.body.autoStopped;
            } else { throw err; }
          }
        } else {
          // Ended at the tap already (endWalkAt); if that didn't reach the
          // server yet (offline), it goes first.
          if (!w.endSynced) await syncWalkEnd(w);
          if (state.walk !== w || w.wrapUpEndedAt) return; // now on that walk's own end screen
          if (!w.endSynced) {
            appAlert(w.offline
              ? "You're offline, so this can't be saved yet. Your notes are kept on this phone; tap Save & finish again once you're back online."
              : "This couldn't be saved yet. Your notes are kept on this phone; try Save & finish again in a moment.");
            return;
          }
          // An empty box leaves any note already on it alone.
          res = await api(`/api/walks/${w.walkId}`, { method: 'PUT', body: JSON.stringify({ wrapUpDone: true, ...(notes ? { notes } : {}) }) });
          if (res.levelUpOffer === undefined) res.levelUpOffer = w.levelUpOffer;
        }
        state.walk.durationSeconds = res.durationSeconds;
        // The walk itself is saved by now. A private or Playgroup note that
        // can't be saved keeps the end screen and its draft, so Save & finish
        // can try again; one already saved (w.sentNotes) isn't sent twice.
        w.sentNotes = w.sentNotes || {};
        const notSaved = [];
        if (privateNote && w.sentNotes.priv !== privateNote) {
          try {
            await api(`/api/dogs/${w.dog.id}/private-note`, { method: 'PUT', body: JSON.stringify({ body: privateNote, append: true }) });
            w.sentNotes.priv = privateNote;
          } catch (e) { notSaved.push('private note'); }
        }
        if (playgroupNote && w.sentNotes.pg !== playgroupNote) {
          // Dated the day Playgroup started.
          try {
            await api(`/api/dogs/${w.dog.id}/playgroup-notes`, { method: 'POST', body: JSON.stringify({ body: playgroupNote, noteDate: dateKey(w.startedAt), signed: pgEditor.signed() }) });
            w.sentNotes.pg = playgroupNote;
          } catch (e) { notSaved.push('Playgroup note'); }
        }
        if (notSaved.length) {
          appAlert(`The ${activityInfo(w.activity).noun} is saved, but your ${notSaved.join(' and ')} couldn't be saved yet. It's kept on this phone; tap Save & finish again to try again.`);
          return;
        }
        clearInterval(summaryTimer);
        // You just walked them yourself — mark today's checkoff automatically
        // so they don't sit in the Available list looking like they still
        // need it. (Ended with End: already done when it ended.)
        if (wrapUp) {
          try {
            await api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: w.dog.id, dateKey: todayKey() }) });
          } catch (e) { /* non-critical; the walk itself already saved fine */ }
        }
        forgetWalkOnDevice(w.walkId);
        state.walk.phase = 'summary';
        renderWalk();
        maybeOfferLevelUp(res.levelUpOffer);
      } catch (err) {
        if (err.status === 404) { clearInterval(summaryTimer); walkDeletedElsewhere(w); return; }
        if (walkMovedError(err)) { clearInterval(summaryTimer); walkMovedElsewhere(w); return; }
        // The draft is kept (keepDraft above), so nothing typed is lost.
        appAlert(`${friendlyError(err, 'save this')} Your notes are kept on this phone; tap Save & finish to try again.`);
      } finally {
        saving = false;
        if (saveBtn.isConnected) saveBtn.disabled = !!pickError();
      }
    });
    document.getElementById('cancelWalkBtn').addEventListener('click', async () => {
      const noun = activityInfo(state.walk.activity).noun;
      if (!(await appConfirm(`Delete this ${noun} with ${w.dog.name}? It won't be recorded at all. To keep it without notes, tap Save & finish instead.`, { title: `Delete ${noun}`, confirmText: 'Delete', cancelText: 'Keep it', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        clearInterval(summaryTimer);
        forgetWalkOnDevice(w.walkId);
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        if (err.status === 404) { clearInterval(summaryTimer); walkDeletedElsewhere(w); return; }
        appAlert(friendlyError(err));
      }
    });
  }

  function renderWalkSummary() {
    const w = state.walk;
    const noun = activityInfo(w.activity).noun;
    appEl.innerHTML = `
      <div class="stack">
        <div class="card center">
          <p class="walk-dog-name">Great ${noun} with ${esc(w.dog.name)}! ${activityInfo(w.activity).emoji}🎉</p>
          <p class="muted">Started at ${fmtClock(w.startedAt)} · ${(w.durationSeconds || 0) < 60 ? 'under a minute' : fmtDuration(w.durationSeconds)}</p>
          ${w.autoStopped ? `<p class="small autostop-note">⏱ This ${noun} was stopped automatically after ${fmtDuration(w.durationSeconds)}. If it ran longer, you can fix the time from Stats&amp;Notes (tap the pencil on it).</p>` : ''}
          <div class="stack" style="margin-top:12px;">
            <button id="doneBtn" class="btn primary big">📷 Scan next ${worksWithBoth() ? 'kennel card' : esc(nounFor(prefSpeciesKeys()))}</button>
            <button id="summaryDoneBtn" class="btn">Done</button>
          </div>
        </div>
        <div class="danger-zone">
          <button id="deleteWalkBtn" class="btn danger-outline">Delete this ${noun}…</button>
        </div>
      </div>`;
    document.getElementById('doneBtn').addEventListener('click', () => {
      state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
      renderWalk();
    });
    document.getElementById('summaryDoneBtn').addEventListener('click', () => {
      state.walk = { phase: 'idle', dog: null, walkId: null, startedAt: null, location: null };
      updateWalkTabLabel();
      switchTab('available');
    });
    document.getElementById('deleteWalkBtn').addEventListener('click', async () => {
      if (!(await appConfirm(`Delete this ${noun} with ${w.dog.name}? This can't be undone.`, { title: `Delete ${noun}`, confirmText: 'Delete', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        appAlert(friendlyError(err));
      }
    });
  }

  // "End walk" on a walk alert (sw.js): the same as tapping End Walk, at the
  // moment the button was tapped. Anything odd about that time (clock skew,
  // before the walk began): now instead. Only for the walk still running here.
  function notificationEndTime(at, startedAt) {
    const ms = new Date(at).getTime();
    if (!Number.isFinite(ms) || ms > Date.now() || ms < new Date(startedAt).getTime()) return new Date().toISOString();
    return new Date(ms).toISOString();
  }
  function endWalkFromNotification(walkId, at) {
    if (state.walk.phase !== 'active' || String(state.walk.walkId) !== String(walkId)) return;
    endWalkAt(notificationEndTime(at, state.walk.startedAt));
  }

  // ---------- Ending a walk ----------
  // End (the button, or a walk alert's "End walk") ends the walk on the
  // server at once, at the tap time, so the dog shows as free to everyone
  // right away; the end screen then only adds notes (renderWalkEnding).
  // finishLater keeps that screen coming back (wrap_up_pending) until it's
  // saved, even after a reload. Offline, the tap time is kept on this phone
  // and sent once the connection is back.
  function endWalkAt(at) {
    const w = state.walk;
    clearInterval(timerInterval);
    w.endTappedAt = at;
    w.endSynced = false;
    w.phase = 'ending';
    saveLocalWalk();
    if (state.tab === 'walk') renderWalk();
    else switchTab('walk');
    syncWalkEnd(w);
  }
  let syncingEnd = null;
  async function syncWalkEnd(w) {
    if (w.phase !== 'ending' || w.endSynced || w.wrapUpEndedAt || !w.endTappedAt) return;
    if (syncingEnd) { await syncingEnd; return; }
    syncingEnd = (async () => {
      try {
        const res = await sendEndTap(w.walkId, w.endTappedAt, w.endToken);
        w.endSynced = true;
        w.offline = false;
        w.endTappedAt = res.endedAt;
        w.durationSeconds = res.durationSeconds;
        w.levelUpOffer = res.levelUpOffer;
        if (state.walk === w) saveLocalWalk();
        // You just walked them yourself — mark today's checkoff automatically
        // so they don't sit in the Available list looking like they still need it.
        api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: w.dog.id, dateKey: todayKey() }) }).catch(() => {});
      } catch (err) {
        if (err.networkError || (err.status >= 502 && err.status <= 504)) {
          // Kept (saveLocalWalk) and sent when back online.
          if (!w.offline) { w.offline = true; if (state.walk === w && state.tab === 'walk') renderWalk(); }
          return;
        }
        if (err.status === 404) { walkDeletedElsewhere(w); return; }
        if (walkMovedError(err)) { walkMovedElsewhere(w); return; }
        // Ended on another device, or the time limit got there first (a 400:
        // the tap was after it): show that walk's own end screen, where the
        // note can still be saved.
        if ((err.status === 409 && err.body && err.body.alreadyEnded) || err.status === 400) {
          await recheckWalkElsewhere({ force: true, walk: w });
        }
        if (!w.endSynced && !w.wrapUpEndedAt) toast(friendlyError(err, 'end this'), 'error');
      } finally { syncingEnd = null; }
    })();
    await syncingEnd;
  }

  // Sends an End tap (finishLater). One the server refuses as a time (400:
  // this phone's clock far off, say) still ends the walk, at the server's
  // own time, instead of leaving it running with the tap dropped.
  // endToken (from the walk's start) lets it through after someone else
  // signed in on this phone (audit 3, shared tablet).
  async function sendEndTap(walkId, endTappedAt, endToken) {
    const token = endToken ? { endToken } : {};
    try {
      return await api(`/api/walks/${walkId}/end`, { method: 'PUT', body: JSON.stringify({ endTappedAt, finishLater: true, ...token }) });
    } catch (err) {
      if (err.status !== 400) throw err;
      return api(`/api/walks/${walkId}/end`, { method: 'PUT', body: JSON.stringify({ finishLater: true, ...token }) });
    }
  }
  // Ends tapped offline by someone else on this (shared) phone, kept when
  // the next person's walk took the walk copy's place (saveLocalWalk). Sent
  // whoever is signed in; the server takes them on the walk's endToken.
  const QUEUED_ENDS_KEY = 'dogwalk_queued_ends';
  function readQueuedEnds() {
    try { const list = JSON.parse(localStorage.getItem(QUEUED_ENDS_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch (e) { return []; }
  }
  function writeQueuedEnds(list) {
    try { if (list.length) localStorage.setItem(QUEUED_ENDS_KEY, JSON.stringify(list)); else localStorage.removeItem(QUEUED_ENDS_KEY); } catch (e) { /* storage blocked */ }
  }
  async function sendQueuedEnds() {
    const left = [];
    for (const q of readQueuedEnds()) {
      try { await sendEndTap(q.walkId, q.endTappedAt, q.endToken); } catch (err) { if (unreachable(err)) left.push(q); }
    }
    writeQueuedEnds(left);
  }

  // A wrap-up the server is holding (GET /api/walks/active wrapUp) as this
  // walk's end screen: when it really ended for one the time limit stopped,
  // only notes for one ended with End.
  function adoptWrapUp(w, wrapUp) {
    if (wrapUp.autoStopped === false) {
      w.wrapUpEndedAt = null;
      w.endTappedAt = wrapUp.ended_at;
      w.endSynced = true;
    } else {
      w.wrapUpEndedAt = wrapUp.ended_at;
    }
    w.closesAt = wrapUp.closesAt;
    w.endsBy = wrapUp.endsBy || null;
    w.offline = false;
    w.phase = 'ending';
  }

  // Another tab or device may have ended this walk (or the time limit did):
  // checked when the app comes back into view, and when +10 or End is told
  // "already ended". Ended: straight to its end screen, where whatever was
  // typed is still there (the draft) and can be saved.
  async function recheckWalkElsewhere({ force = false, walk } = {}) {
    const w = walk || state.walk;
    if (!state.currentUser || !w.walkId || state.walk !== w) return;
    // On the finish screen (already ended on the server) only a deletion
    // elsewhere matters.
    const finishing = w.phase === 'ending' && (w.endSynced || !!w.wrapUpEndedAt) && !w.offline;
    if (w.phase !== 'active' && !finishing && !(force && w.phase === 'ending' && !w.endSynced)) return;
    let res;
    try { res = await api(`/api/walks/active?userId=${state.currentUser.id}&walkId=${encodeURIComponent(w.walkId)}`); } catch (err) { return; }
    if (state.walk !== w) return;
    if (res.walkMoved) { walkMovedElsewhere(w); return; }
    if (res.walkMissing) { walkDeletedElsewhere(w); return; }
    if (finishing && !force) return;
    if (res.walk && res.walk.id === w.walkId) {
      if (w.phase === 'active') {
        // Still going, maybe extended or switched elsewhere.
        w.stopsAt = res.walk.stopsAt;
        w.closesAt = res.walk.closesAt;
        w.endsBy = res.walk.endsBy || null;
        if (res.walk.activity !== w.activity) { w.activity = res.walk.activity; if (state.tab === 'walk') renderWalk(); }
        saveLocalWalk();
      }
      return;
    }
    clearInterval(timerInterval);
    if (res.wrapUp && res.wrapUp.id === w.walkId) {
      adoptWrapUp(w, res.wrapUp);
    } else {
      // Ended and its end screen already finished elsewhere: a note can
      // still be added to it here.
      w.wrapUpEndedAt = null;
      w.endSynced = true;
      w.phase = 'ending';
    }
    saveLocalWalk();
    toast(`This ${activityInfo(w.activity).noun} was already ended${w.wrapUpEndedAt ? ' by the time limit' : ' on another device'}.`);
    if (state.tab === 'walk') renderWalk();
    else switchTab('walk');
  }

  // The walk on screen no longer exists on the server (deleted or cancelled
  // on another device): nothing left to end or save, so back to normal.
  function walkDeletedElsewhere(w) {
    if (state.walk !== w) return;
    clearInterval(timerInterval);
    forgetWalkOnDevice(w.walkId);
    state.walk = { phase: 'idle', dog: null, walkId: null, startedAt: null, location: null };
    toast(`This ${activityInfo(w.activity).noun} was deleted on another device.`);
    updateWalkTabLabel();
    if (state.tab === 'walk') switchTab('available');
  }
  // Staff moved this walk to another volunteer (server: walkMoved, or a 403
  // with notYourWalk): not deleted, just not this person's any more. What
  // was typed on its end screen stays on this phone (the end draft) and can
  // be copied.
  async function walkMovedElsewhere(w) {
    if (state.walk !== w) return;
    clearInterval(timerInterval);
    clearLocalWalk(w.walkId);
    const draft = readEndDraft(w.walkId) || {};
    const typed = [draft.notes, draft.priv, draft.pg].map((p) => (p && p.text ? p.text.trim() : '')).filter(Boolean).join('\n\n');
    state.walk = { phase: 'idle', dog: null, walkId: null, startedAt: null, location: null };
    updateWalkTabLabel();
    if (state.tab === 'walk') switchTab('available');
    const msg = `This ${activityInfo(w.activity).noun} was moved to another volunteer, so it can't be saved from this phone.`;
    if (typed && navigator.clipboard) {
      const copy = await appConfirm(`${msg} What you typed is kept on this phone. Copy it?`, { title: 'Moved to another volunteer', confirmText: 'Copy my notes', cancelText: 'Close' });
      if (copy) navigator.clipboard.writeText(typed).then(() => toast('Copied'), () => toast("Couldn't copy your notes", 'error'));
    } else {
      appAlert(msg, 'Moved to another volunteer');
    }
  }
  const walkMovedError = (err) => err && err.status === 403 && err.body && err.body.notYourWalk;

  // ---------- This device's copy of the walk ----------
  // From the moment a walk starts until its end reaches the server, the walk
  // (id, animal, start, activity, time limit) is kept in localStorage, so
  // reopening the app without a connection still shows it -- the service
  // worker never answers /api/walks/active from a saved copy (sw.js). The
  // end screen's typed notes are kept the same way until saved.
  const LOCAL_WALK_KEY = 'dogwalk_current_walk';
  const END_DRAFT_KEY = 'dogwalk_end_draft';
  function saveLocalWalk() {
    const w = state.walk;
    if (!state.currentUser || !w.walkId || !w.dog) return;
    const keep = w.phase === 'active' || (w.phase === 'ending' && !w.endSynced && !w.wrapUpEndedAt);
    if (!keep) { clearLocalWalk(w.walkId); return; }
    const u = state.currentUser;
    const { summary, ...dog } = w.dog;
    const copy = {
      userId: u.id,
      // Just enough of the account to draw the walk screen offline.
      user: { id: u.id, name: u.name, onboardingCompleted: u.onboardingCompleted, experienceLevel: u.experienceLevel, defaultActivity: u.defaultActivity, defaultActivityCat: u.defaultActivityCat, speciesPref: u.speciesPref, species: u.species },
      walkId: w.walkId,
      dog,
      startedAt: w.startedAt,
      stopsAt: w.stopsAt || null,
      closesAt: w.closesAt || null,
      endsBy: w.endsBy || null,
      endToken: w.endToken || null,
      activity: w.activity,
      location: w.location || null,
      phase: w.phase,
      endTappedAt: w.phase === 'ending' ? w.endTappedAt : null
    };
    // Someone else's End still waiting to be sent (a shared phone): kept
    // aside rather than overwritten (sendQueuedEnds).
    try {
      const prev = JSON.parse(localStorage.getItem(LOCAL_WALK_KEY) || 'null');
      if (prev && String(prev.walkId) !== String(copy.walkId) && prev.phase === 'ending' && prev.endTappedAt && prev.endToken) {
        writeQueuedEnds([...readQueuedEnds(), { walkId: prev.walkId, endTappedAt: prev.endTappedAt, endToken: prev.endToken }]);
      }
    } catch (e) { /* storage blocked */ }
    try { localStorage.setItem(LOCAL_WALK_KEY, JSON.stringify(copy)); } catch (e) { /* storage full or blocked */ }
  }
  function readLocalWalk(userId) {
    try {
      const copy = JSON.parse(localStorage.getItem(LOCAL_WALK_KEY) || 'null');
      return copy && copy.walkId && copy.dog && String(copy.userId) === String(userId) ? copy : null;
    } catch (e) { return null; }
  }
  function clearLocalWalk(walkId) {
    try {
      const copy = JSON.parse(localStorage.getItem(LOCAL_WALK_KEY) || 'null');
      if (copy && (walkId == null || String(copy.walkId) === String(walkId))) localStorage.removeItem(LOCAL_WALK_KEY);
    } catch (e) { /* storage blocked */ }
  }
  function forgetWalkOnDevice(walkId) {
    clearLocalWalk(walkId);
    try { localStorage.removeItem(END_DRAFT_KEY); } catch (e) { /* storage blocked */ }
  }
  // The walk as state.walk, from this device's copy.
  function walkFromLocal(copy) {
    return {
      phase: copy.phase === 'ending' ? 'ending' : 'active',
      dog: copy.dog,
      allWalks: [],
      walkId: copy.walkId,
      startedAt: copy.startedAt,
      stopsAt: copy.stopsAt,
      closesAt: copy.closesAt,
      endsBy: copy.endsBy || null,
      endToken: copy.endToken || null,
      activity: copy.activity,
      location: copy.location,
      endTappedAt: copy.endTappedAt || null,
      endSynced: false,
      offline: true
    };
  }
  function offlineWalkNoteHtml(w) {
    if (!w.offline) return '';
    return `<p class="small center offline-walk-note" role="status">📴 Offline: showing this ${esc(activityInfo(w.activity).noun)} as saved on this phone.${w.phase === 'ending' && !w.endSynced ? ' Its end time is kept and sent when you\'re back online.' : ' Ending it still works; the end time is sent when you\'re back online.'}</p>`;
  }
  // Drafts: { walkId, notes, priv, pg }, each { text, picks: [[label, id]] }
  // as typed (tags as @Name with what they point to).
  function readEndDraft(walkId) {
    try {
      const d = JSON.parse(localStorage.getItem(END_DRAFT_KEY) || 'null');
      return d && String(d.walkId) === String(walkId) ? d : {};
    } catch (e) { return {}; }
  }
  function writeEndDraft(walkId, parts) {
    try { localStorage.setItem(END_DRAFT_KEY, JSON.stringify({ walkId, ...parts })); } catch (e) { /* storage full or blocked */ }
  }
  const draftOf = (el, picks) => (el ? { text: el.textContent || '', picks: picks ? [...picks.entries()] : [] } : null);
  const draftPicks = (part) => new Map(part && Array.isArray(part.picks) ? part.picks : []);
  // A note box's starting text from a draft, through wireNoteTagBox's
  // body/tagged (stored form, tags as @[id]).
  function draftBoxStart(part) {
    if (!part || !part.text) return {};
    const picks = draftPicks(part);
    return { body: window.PgTags.fromEditable(part.text, picks), tagged: Object.fromEntries([...picks].map(([label, id]) => [id, { name: label }])) };
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === 'end-walk') endWalkFromNotification(msg.walkId, msg.at);
      if (msg.type === 'open-feedback') openFeedbackInbox();
      if (msg.type === 'open-updates' && state.currentUser && !activeWalkDogId()) switchTab('updates');
      if (msg.type === 'walk-extended' && state.walk.phase === 'active' && String(state.walk.walkId) === String(msg.walkId)) {
        state.walk.stopsAt = msg.stopsAt;
      }
    });
  }
  // Opened by "End walk" with the app closed: /?endWalk=<id>&at=<time>.
  // Read once, before the URL is tidied away.
  const launchParams = new URLSearchParams(window.location.search);
  // Only honoured with the service worker's nonce for that tap (sw.js
  // stashEndTap), so a crafted /?endWalk link does nothing (audit 3).
  const pendingEnd = launchParams.get('endWalk') ? { walkId: launchParams.get('endWalk'), nonce: launchParams.get('nonce') } : null;
  // Offline start-up showing the walk from this phone's copy: an "End walk"
  // tapped on its notification is queued like the End button (endWalkAt
  // keeps the tap and sends it once back online).
  async function endFromNotificationOffline(copy) {
    if (!pendingEnd || copy.phase === 'ending') return;
    const tapAt = await takeEndTap(copy.walkId);
    if (tapAt && String(state.walk.walkId) === String(copy.walkId) && state.walk.phase === 'active') {
      endWalkAt(notificationEndTime(tapAt, copy.startedAt));
    }
  }
  // The tap time the service worker kept for this End, or null.
  async function takeEndTap(walkId) {
    if (!pendingEnd || !pendingEnd.nonce || String(pendingEnd.walkId) !== String(walkId) || !('caches' in window)) return null;
    try {
      const cache = await caches.open('shelter-walk-end-taps');
      const key = `/__end-tap/${encodeURIComponent(walkId)}`;
      const hit = await cache.match(key);
      const tap = hit ? await hit.json() : null;
      if (!tap || tap.nonce !== pendingEnd.nonce || String(tap.walkId) !== String(walkId)) return null;
      await cache.delete(key);
      return tap.at || null;
    } catch (e) { return null; }
  }
  const pendingFeedbackInbox = launchParams.get('open') === 'feedback';
  const pendingUpdates = launchParams.get('open') === 'updates';
  if (window.location.search) history.replaceState(history.state, '', window.location.pathname);

  // ---------- Init ----------
  // Runs once a user is known (either restored from localStorage or just
  // picked) — resumes an in-progress walk of THEIRS if any, else honors the
  // /scan shortcut, else renders normally.
  let dayNotice = Promise.resolve(false);
  async function completeInit() {
    // Fetched now, but shown only once the right tab is up: a dialog opened
    // before switchTab('walk') would have its history step replaced by the
    // tab's, and its OK (a Back) would then leave the walk screen.
    const todayInfo = api('/api/shelter/today');
    todayInfo.catch(() => {});
    refreshUpdatesBadge();
    refreshUpdatesTabVisibility();
    const local = readLocalWalk(state.currentUser.id);
    // Someone else's End tapped offline on this phone: queued and sent now.
    try {
      const other = JSON.parse(localStorage.getItem(LOCAL_WALK_KEY) || 'null');
      if (other && !local && other.phase === 'ending' && other.endTappedAt && other.endToken) {
        writeQueuedEnds([...readQueuedEnds(), { walkId: other.walkId, endTappedAt: other.endTappedAt, endToken: other.endToken }]);
        localStorage.removeItem(LOCAL_WALK_KEY);
      }
    } catch (e) { /* storage blocked */ }
    sendQueuedEnds().catch(() => {});
    try {
      // End tapped while offline (kept on this phone) goes first, so the
      // answer below already has that walk ended, at the tap.
      if (local && local.phase === 'ending' && local.endTappedAt) {
        try {
          await sendEndTap(local.walkId, local.endTappedAt, local.endToken);
          api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: local.dog.id, dateKey: todayKey() }) }).catch(() => {});
        } catch (err) {
          if (unreachable(err)) throw err;
          // Anything else (ended elsewhere, deleted): the server's answer below wins.
        }
        clearLocalWalk(local.walkId);
      }
      const { walk, wrapUp } = await api(`/api/walks/active?userId=${state.currentUser.id}`);
      if (walk) {
        const { dog, walks } = await api(`/api/dogs/${walk.dog_id}?userId=${state.currentUser.id}`);
        state.walk = {
          phase: 'active',
          dog,
          allWalks: walks,
          walkId: walk.id,
          startedAt: walk.started_at,
          stopsAt: walk.stopsAt,
          closesAt: walk.closesAt,
          endsBy: walk.endsBy || null,
          endToken: walk.endToken || null,
          activity: walk.activity,
          location: walk.location
        };
        switchTab('walk');
        const tapAt = await takeEndTap(walk.id);
        if (tapAt && state.walk.walkId === walk.id && state.walk.phase === 'active') {
          endWalkAt(notificationEndTime(tapAt, walk.started_at));
        }
        dayNotice = showShelterDayNotice(todayInfo);
        return;
      }
      if (wrapUp) {
        const { dog, walks } = await api(`/api/dogs/${wrapUp.dog_id}?userId=${state.currentUser.id}`);
        state.walk = {
          phase: 'ending',
          dog,
          allWalks: walks,
          walkId: wrapUp.id,
          startedAt: wrapUp.started_at,
          activity: wrapUp.activity,
          location: wrapUp.location
        };
        adoptWrapUp(state.walk, wrapUp);
        switchTab('walk');
        dayNotice = showShelterDayNotice(todayInfo);
        return;
      }
      // Nothing under way on the server: this phone's copy is out of date.
      if (local) clearLocalWalk(local.walkId);
    } catch (err) {
      // No connection (the service worker never answers /api/walks/active
      // from a saved copy): the walk as kept on this phone.
      const copy = readLocalWalk(state.currentUser.id);
      if (copy && unreachable(err)) {
        state.walk = walkFromLocal(copy);
        switchTab('walk');
        endFromNotificationOffline(copy);
        return;
      }
    }

    if (window.location.pathname === '/scan') {
      state.walk.phase = 'scanning';
      switchTab('walk');
      dayNotice = showShelterDayNotice(todayInfo);
      return;
    }

    if (pendingUpdates) switchTab('updates');
    else {
      // The title was set before we knew who this is (a cat volunteer just
      // out of onboarding would keep "Dogs to walk" until a reload).
      if (TAB_TITLES[state.tab]) topbarTitle.textContent = TAB_TITLES[state.tab];
      render();
    }
    dayNotice = showShelterDayNotice(todayInfo);
    if (pendingFeedbackInbox) { openFeedbackInbox(); return; }
    // One popup at a time: the day's hours notice first, then the shelter
    // alerts offer, then a level-up offer.
    if (await dayNotice) return;
    if (await offerShelterAlerts()) return;
    maybeOfferLevelUp(state.currentUser.levelUpOffer);
  }

  // ---------- Today's hours ----------
  // Staff can close the shelter for a day or change its hours (staff
  // dashboard, Hours & alerts). Opening the app on such a day says so right
  // away, once per day per change on this device (the same notice again
  // after it's been seen would just be in the way). Resolves true if it
  // showed something.
  const DAY_NOTICE_KEY = 'dogwalk_day_notice';
  async function showShelterDayNotice(pending) {
    let data;
    try { data = await (pending || api('/api/shelter/today')); } catch (err) { return false; }
    const t = data.today;
    state.shelterToday = t;
    if (!t || !t.special) return false;
    const seenKey = `${t.dateKey}|${t.closed}|${t.hoursLabel}|${t.note}|${t.message || ''}`;
    try { if (localStorage.getItem(DAY_NOTICE_KEY) === seenKey) return false; } catch (err) { /* show it */ }
    const title = t.closed ? '🚫 The shelter is closed today' : '🕒 Today is different';
    const lines = [];
    if (t.closed) lines.push(`There are no ${myTerms().nouns} today.`);
    else lines.push(`${capFirst(myTerms().nouns)} today: ${t.hoursLabel}.`);
    if (t.note) lines.push(t.note);
    if (t.message) lines.push(t.message);
    await appAlert(lines.join('\n\n'), title);
    try { localStorage.setItem(DAY_NOTICE_KEY, seenKey); } catch (err) { /* fine */ }
    return true;
  }

  // ---------- Shelter alerts on by default ----------
  // shelter_alerts is on for everyone unless they turn it off, but a phone
  // only gets pushes once it allows notifications. Already allowed: quietly
  // make sure this device is subscribed. Not asked yet: ask once per device,
  // and leave it to Settings after that. Resolves true if it asked.
  const ALERTS_ASKED_KEY = 'dogwalk_alerts_asked';
  async function offerShelterAlerts() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.Notification) return false;
    if (Notification.permission === 'denied') return false;
    let prefs;
    try { ({ prefs } = await api(`/api/users/${state.currentUser.id}/notification-prefs`)); } catch (err) { return false; }
    if (prefs.shelter_alerts === false) return false;
    if (Notification.permission === 'granted') { ensurePushSubscribed(); return false; }
    try { if (localStorage.getItem(ALERTS_ASKED_KEY)) return false; localStorage.setItem(ALERTS_ASKED_KEY, '1'); } catch (err) { return false; }
    const yes = await appConfirm('Staff use shelter alerts for urgent news, like the shelter closing unexpectedly. You can turn them off any time in Settings.', {
      title: '📢 Get shelter alerts?', confirmText: 'Turn on', cancelText: 'Not now'
    });
    if (yes && !(await ensurePushSubscribed())) appAlert(pushProblemMessage(), 'Alerts not on yet');
    return true;
  }

  // ---------- Offline banner ----------
  // network-first-with-cache-fallback (see sw.js) means the app still shows
  // something on a dropped connection instead of going blank -- this banner
  // is just the visible signal that what's on screen might be stale.
  function updateOfflineBanner() {
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.toggle('hidden', navigator.onLine);
  }
  // Coming back to the app after a while (phone was locked, another app was
  // open) should show current dogs, not whatever was on screen hours ago.
  let lastBackgroundedAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { lastBackgroundedAt = Date.now(); return; }
    if (!state.currentUser || !lastBackgroundedAt || Date.now() - lastBackgroundedAt < 3 * 60 * 1000) return;
    lastBackgroundedAt = 0;
    refreshUpdatesBadge();
    // The app can stay open across days, or staff can close today while it's open.
    if (!document.querySelector('#appDialog:not(.hidden)')) showShelterDayNotice();
    // Only re-render read-only list screens, and never underneath an open
    // sheet/popup/dialog or in the middle of a walk.
    const busy = document.querySelector('.popup-overlay:not(.hidden), .sheet:not(.hidden), .image-lightbox:not(.hidden)');
    if (!busy && ['available', 'stats', 'updates'].includes(state.tab)) render();
  });
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);
  // Back online with a walk shown from this phone's copy: send an End tapped
  // meanwhile, or check the walk with the server again.
  window.addEventListener('online', () => {
    const w = state.walk;
    if (state.currentUser && readQueuedEnds().length) sendQueuedEnds().catch(() => {});
    if (!state.currentUser || !w.offline) return;
    if (w.phase === 'ending' && !w.endSynced) { syncWalkEnd(w).then(() => { if (state.walk === w && state.tab === 'walk' && !w.offline) renderWalk(); }); return; }
    w.offline = false;
    if (state.tab === 'walk') renderWalk();
    recheckWalkElsewhere();
  });
  // Can't reach the server at all (as opposed to it saying no).
  function unreachable(err) {
    return !!err && (err.networkError || (err.status >= 502 && err.status <= 504) || !navigator.onLine);
  }
  // Another tab or device may have ended or changed the walk while this one
  // was in the background: check whenever it comes back into view.
  let recheckAt = 0;
  function recheckOnReturn() {
    if (document.visibilityState === 'hidden' || Date.now() - recheckAt < 2000) return;
    recheckAt = Date.now();
    recheckWalkElsewhere();
  }
  document.addEventListener('visibilitychange', recheckOnReturn);
  window.addEventListener('focus', recheckOnReturn);

  // A shared shelter phone: when someone else signs in on it, the service
  // worker's saved API answers (sw.js, the "shelter-walk-v*" cache) belong to
  // the last person, so they're thrown away. Personal answers are never saved
  // there anyway (no-store); this also clears the shared ones that carry
  // "yours" marks. Only the /api/ answers go: the app page, manifest and
  // icons in the same cache stay, so the walk screen still opens offline.
  function forgetOtherAccountsCache(userId) {
    let last = null;
    try { last = localStorage.getItem('sw-last-user-id'); } catch (e) { /* storage blocked */ }
    if (last === String(userId)) return;
    if (last !== null) forgetApiCache();
    try { localStorage.setItem('sw-last-user-id', String(userId)); } catch (e) { /* storage blocked */ }
  }
  function forgetApiCache() {
    if (!('caches' in window)) return Promise.resolve();
    return caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => /^shelter-walk-v\d+$/.test(k)).map((k) => caches.open(k)
        .then((cache) => cache.keys().then((reqs) => Promise.all(reqs
          .filter((r) => new URL(r.url).pathname.startsWith('/api/'))
          .map((r) => cache.delete(r))))))))
      .catch(() => {});
  }

  // Signing out on a shared phone: nothing of this person's stays behind
  // for the next one -- the walk copy, the end-of-walk draft, the "last
  // signed in here" id and the saved API answers. Device settings (theme,
  // species view) aren't personal and stay.
  const PER_USER_LOCAL_KEYS = [LOCAL_WALK_KEY, END_DRAFT_KEY, 'sw-last-user-id', ONBOARDING_STEP_KEY, DAY_NOTICE_KEY, ALERTS_ASKED_KEY];
  function forgetUserOnDevice() {
    // This phone's push subscription goes too (server first, while still
    // signed in), so the next person here doesn't get this one's alerts.
    const pushGone = unsubscribePushOnDevice();
    try { PER_USER_LOCAL_KEYS.forEach((k) => localStorage.removeItem(k)); } catch (e) { /* storage blocked */ }
    try { sessionStorage.clear(); } catch (e) { /* storage blocked */ }
    return Promise.all([pushGone, forgetApiCache()]);
  }
  async function unsubscribePushOnDevice() {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      if (!sub) return;
      // The browser's subscription goes first (it never reaches this phone
      // again, whatever the server says), then the server's copy (audit 3).
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }), timeout: 3000 }).catch(() => {});
    } catch (e) { /* best effort */ }
  }
  // Before signing out: an End tapped offline is sent first (signing out
  // would otherwise leave the walk running, for the next person to find).
  // If it can't be sent, sign-out waits. Unsaved end-screen notes ask first.
  async function readyToSignOut() {
    const u = state.currentUser;
    if (!u) return true;
    const local = readLocalWalk(u.id);
    if (local && local.phase === 'ending' && local.endTappedAt) {
      try {
        await sendEndTap(local.walkId, local.endTappedAt, local.endToken);
        clearLocalWalk(local.walkId);
        if (state.walk.walkId === local.walkId) state.walk.endSynced = true;
      } catch (err) {
        if (unreachable(err)) {
          await appAlert(`The end of your ${activityInfo(local.activity).noun} with ${local.dog.name} hasn't reached the server yet, so you're still signed in. Sign out once you're back online, and the ${activityInfo(local.activity).noun} is ended at the time you tapped End.`, 'Not signed out yet');
          return false;
        }
        // Ended or deleted elsewhere already: nothing left to send.
        clearLocalWalk(local.walkId);
      }
    }
    const w = state.walk;
    const draft = w && w.phase === 'ending' && w.walkId ? readEndDraft(w.walkId) : {};
    const typed = [draft.notes, draft.priv, draft.pg].some((p) => p && p.text && p.text.trim());
    if (typed) {
      return appConfirm(`Your notes for ${w.dog ? w.dog.name : 'this animal'} aren't saved yet. Sign out anyway? They'll be lost.`, {
        title: 'Unsaved notes', confirmText: 'Sign out anyway', cancelText: 'Stay', danger: true
      });
    }
    return true;
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('#signOutLink, [data-sign-out], a[href*="logout"], a[href*="sign-out"], a[href*="signout"]');
    if (!link) return;
    // Let the navigation go ahead; the cache clean-up is best effort and
    // quick, but the link waits briefly so it can finish.
    const href = link.getAttribute('href');
    if (href && !e.defaultPrevented && !(e.metaKey || e.ctrlKey || e.shiftKey) && link.target !== '_blank') {
      e.preventDefault();
      (async () => {
        if (!(await readyToSignOut())) return;
        const go = () => { window.location.href = href; };
        // Waits for the push unsubscribe (browser and server, up to its 3 s
        // timeout); the longer cap only guards against a hung browser call.
        Promise.race([forgetUserOnDevice(), new Promise((r) => setTimeout(r, 6000))]).then(go, go);
      })();
    } else {
      forgetUserOnDevice();
    }
  }, true);

  async function init() {
    history.replaceState({ guard: true }, '');
    history.pushState({ tab: state.tab, sheet: null, depth: 0 }, '');
    updateOfflineBanner();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[sw] registration failed:', err.message));
      // The scanner library, fetched once the page is idle so the service
      // worker has it for Scan offline (audit 3; sw.js also keeps it at install).
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 4000));
      idle(() => { fetch('/js/html5-qrcode.min.js', { credentials: 'same-origin' }).catch(() => {}); });
    }

    // The live shared numbers (eng, audit2); the fallback copies stand in
    // until they arrive, or if they can't.
    fetch('/api/config').then((r) => (r.ok ? r.json() : null)).then(applySharedConfig).catch(() => {});
    let me;
    try {
      me = await api('/api/me');
    } catch (err) {
      // No connection, mid-walk: the walk as kept on this phone, for whoever
      // last signed in here (it's their copy). Back online, a reload picks
      // everything up properly (and sends an End tapped meanwhile).
      let lastUser = null;
      try { lastUser = localStorage.getItem('sw-last-user-id'); } catch (e) { /* storage blocked */ }
      const copy = unreachable(err) && lastUser ? readLocalWalk(lastUser) : null;
      if (copy && copy.user) {
        setCurrentUser(copy.user);
        state.walk = walkFromLocal(copy);
        switchTab('walk');
        endFromNotificationOffline(copy);
        window.addEventListener('online', () => window.location.reload(), { once: true });
        return;
      }
      showLoadError("your account", err, () => window.location.reload());
      return;
    }
    forgetOtherAccountsCache(me.id);
    setCurrentUser(me);
    if (await maybeShowOnboarding()) return;
    await completeInit();
  }

  init();
})();
