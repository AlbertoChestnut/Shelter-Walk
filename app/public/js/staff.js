// Staff dashboard: a standalone page, deliberately not part of app.js's
// closure/state (that file is a single large IIFE for the mobile volunteer
// app). This is its own small IIFE with its own tiny bit of state.
(function () {
  'use strict';

  // Timeout, friendly errors and the signed-out bar all come from the shared
  // helper (js/http-errors.js), the same one staff-settings.js and the
  // Playgroup desk use.
  const api = (path, opts) => window.ShelterHttp.request(path, opts);

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
  }
  window.staffToast = toast; // staff-settings.js uses it too

  // "Today" is always the shelter's date (America/New_York), never this
  // computer's own time zone or UTC -- the server counts days the same way.
  const SHELTER_TZ = 'America/New_York';
  const shelterKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SHELTER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  function shelterTodayKey() { return shelterKeyFmt.format(new Date()); }
  function addDaysKey(key, n) {
    const d = new Date(`${key}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // "Mon, Oct 12" (with the year when it isn't this year).
  function friendlyDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const opts = { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' };
    if (String(y) !== shelterTodayKey().slice(0, 4)) opts.year = 'numeric';
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', opts);
  }
  const NOUNS = { dog: 'Dogs', cat: 'Cats', all: 'Animals' };

  // ---- Fit-to-screen: shrinks (or modestly grows) the whole page via CSS
  // zoom so it fits one screen's height without scrolling -- meant for an
  // unattended TV/lobby display, not just a browser window. `zoom` (not
  // `transform: scale`) is used because it actually reflows layout at the
  // new size instead of just stretching a fixed-size box, which is what
  // "shrink everything to fit" needs. It's non-standard CSS but has wide
  // Chromium/Safari support; unsupported browsers just keep scrolling
  // normally -- this is a progressive enhancement, never required.
  //
  // Avoids the obvious "reset zoom to 1, remeasure, reapply" approach
  // because that flashes to full size every time it runs. Instead the
  // natural (zoom=1) height is back-calculated from the current zoom, so
  // it can be called cheaply and often (every poll, every resize) without
  // ever visibly resetting.
  // Only the live board is meant to run unattended on a TV -- Reports has
  // working tables (county reports can run long) that should scroll
  // normally, not get shrunk to fit. Applied narrowly: only while the live
  // board is the visible tab.
  const FIT_MIN_ZOOM = 0.6;
  const FIT_MAX_ZOOM = 1.3;
  const zoomCapable = 'zoom' in document.documentElement.style;
  let currentZoom = 1;
  function isLiveTabVisible() {
    return !document.getElementById('liveSection').classList.contains('hidden');
  }
  function resetZoom() {
    if (!zoomCapable || currentZoom === 1) return;
    currentZoom = 1;
    document.documentElement.style.zoom = 1;
  }
  // Only on a big screen (1600px and up) or with TV mode switched on: on a
  // phone or a laptop (1280x720, 1440x900), shrinking to fit made 13px text
  // read like 8px. TV mode is ignored under 600px wide, where its button is
  // hidden: a remembered TV mode must not shrink a phone with no way back.
  const FIT_MIN_WIDTH = 1600;
  const TV_MIN_WIDTH = 600;
  let tvMode = false;
  try { tvMode = localStorage.getItem('staffTvMode') === '1'; } catch (e) { /* private mode */ }
  function fitAllowed() {
    if (window.innerWidth >= FIT_MIN_WIDTH) return true;
    return tvMode && window.innerWidth >= TV_MIN_WIDTH;
  }
  // The page's layout height at the current zoom: the bottom of #app, in
  // CSS px (shown on screen at that times the zoom). The document's
  // scrollHeight can't be used: body's min-height: 100vh keeps it from ever
  // dropping, so the zoom only ever shrank and never grew back.
  function pageLayoutHeight() {
    const app = document.getElementById('app');
    return app ? app.offsetTop + app.offsetHeight : 0;
  }
  const clampZoom = (z) => Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, z));
  function fitToScreen() {
    if (!zoomCapable) return;
    if (!isLiveTabVisible() || !fitAllowed()) { resetZoom(); return; }
    if (!pageLayoutHeight()) return;
    // Zooming changes the layout width, so text rewraps and the height moves
    // with it: settle in a few synchronous steps (no paint in between, so no
    // flash), keeping the largest zoom tried that fits.
    const screenH = window.innerHeight;
    const apply = (zoom) => {
      document.documentElement.style.zoom = zoom;
      // The hourly chart is drawn to its container's width, which the zoom
      // just changed: redraw it before measuring (it sets the chart's height).
      if (lastLiveData) renderSparkline(lastLiveData.hourlyToday);
    };
    let z = clampZoom(screenH / pageLayoutHeight());
    let best = null;
    for (let i = 0; i < 5; i += 1) {
      apply(z);
      const shown = pageLayoutHeight() * z;
      let next;
      if (shown <= screenH + 1) {
        best = best == null ? z : Math.max(best, z);
        next = clampZoom(screenH / pageLayoutHeight());
        if (next - z < 0.01) break;
      } else {
        next = clampZoom(z * (screenH / shown) * 0.995);
        if (best != null && next <= best) break;
        if (z <= FIT_MIN_ZOOM) break;
      }
      z = next;
    }
    const final = best == null ? z : best;
    if (final !== z) apply(final);
    currentZoom = final;
  }
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // The sparkline's internal width tracks its container's actual
      // rendered width, so a resize (e.g. the window growing/shrinking, or
      // rotating a tablet) needs a redraw, not just a re-fit.
      if (lastLiveData) renderSparkline(lastLiveData.hourlyToday);
      fitToScreen();
    }, 100);
  });

  const LOCATION_ORDER = ['A', 'B', 'C', 'D', 'E', 'unassigned'];
  const LOCATION_LABELS = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', unassigned: 'Unassigned' };
  // Same emoji set as the volunteer app's ACTIVITIES map (app.js), for
  // visual consistency across the two.
  const ACTIVITY_ICONS = { walk: '🚶', cuddle: '🤗', matchmaking: '💞', playgroup: '🥎', daycation: '🚗' };
  // Activities shown on the main (non-daycation) grid, in display order.
  const GRID_ACTIVITIES = ['walk', 'cuddle', 'matchmaking', 'playgroup'];

  // ---- Section tabs (Live board / Reports) ----
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const section = btn.dataset.section;
      document.getElementById('liveSection').classList.toggle('hidden', section !== 'live');
      document.getElementById('reportsSection').classList.toggle('hidden', section !== 'reports');
      document.getElementById('hoursSection').classList.toggle('hidden', section !== 'hours');
      document.getElementById('settingsSection').classList.toggle('hidden', section !== 'settings');
      if (section === 'hours') { loadSchedule(); syncWeeklyScrollHint(); }
      if (section === 'settings' && window.loadModuleSettings) window.loadModuleSettings();
      if (section === 'live') fitToScreen();
      else resetZoom();
    });
  });

  // ==================== Live board ====================
  let demoMode = false;
  let liveSpecies = 'dog'; // the Show: Dogs / Cats / Dogs and cats switch
  const previousStatValues = {};

  function formatElapsed(startedAtIso) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  // There's no time limit here, and no concept of overtime -- just a plain
  // running average of every completed walk for this activity (computed
  // server-side, recomputed on every poll). A walk currently running longer
  // than that average is flagged "above average" so it's visible at a
  // glance, nothing more; the bar caps at 100% once it gets there instead
  // of trying to represent how far over. Color is never the only signal
  // (a label/note comes with it), per the dataviz skill's status-color rule.
  function progressInfo(startedAt, averageSeconds) {
    const elapsedSeconds = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
    const pct = Math.min(100, (elapsedSeconds / averageSeconds) * 100);
    if (elapsedSeconds >= averageSeconds) return { pct: 100, state: 'warning', note: '📈 above average' };
    return { pct, state: 'good', note: '' };
  }

  // "25m", or "2h 5m" (not "125m") past an hour; "2h" on the hour.
  function formatMinutes(seconds) {
    const total = Math.round(seconds / 60);
    if (total < 60) return `${total}m`;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function entryHtml(entry, activityAverages) {
    const icon = ACTIVITY_ICONS[entry.activity] || '';
    const activityNote = entry.activity !== 'walk' ? ` <span class="meta">(${escapeHtml(entry.activityLabel)})</span>` : '';
    // A daycation is a day out, not a walk that's running long: no average
    // bar or "above average" badge for it.
    const compare = entry.activity !== 'daycation';
    const avgSeconds = compare ? ((activityAverages && activityAverages[entry.activity]) || 30 * 60) : 0;
    const prog = compare ? progressInfo(entry.startedAt, avgSeconds) : null;
    return `
      <div class="walk-entry" data-avg-seconds="${avgSeconds}">
        <div class="entry-head">
          <img class="dog-avatar" src="${escapeHtml(String(entry.photoUrl || '').replace(/^\/cached-images\/(\d+\.jpg)/, '/cached-images/thumbs/$1'))}" alt="" loading="lazy" />
          <div class="entry-head-text">
            <div class="dog-name"><span class="activity-icon" title="${escapeHtml(entry.activityLabel)}" aria-hidden="true">${icon}</span>${escapeHtml(entry.dogName)}${activityNote}</div>
            <div class="elapsed" data-started="${entry.startedAt}">${formatElapsed(entry.startedAt)}</div>
          </div>
        </div>
        ${prog ? `<div class="progress-track" title="Average ${escapeHtml(entry.activityLabel.toLowerCase())} length: ${formatMinutes(avgSeconds)}">
          <div class="progress-fill ${prog.state !== 'good' ? prog.state : ''}" style="width:${prog.pct.toFixed(1)}%"></div>
        </div>
        ${prog.note ? `<div class="progress-note ${prog.state}">${prog.note}</div>` : ''}` : ''}
        <div class="meta">with ${escapeHtml(entry.walkerName)}</div>
      </div>`;
  }

  // Flags a stat tile with a brief highlight when its value actually
  // changes between polls, so the board visibly feels alive, not static.
  function setStatValue(id, value) {
    const el = document.getElementById(id);
    const tile = el.closest('.stat-tile');
    if (previousStatValues[id] !== undefined && previousStatValues[id] !== value && tile) {
      tile.classList.remove('flash');
      void tile.offsetWidth; // restart the CSS animation
      tile.classList.add('flash');
    }
    previousStatValues[id] = value;
    el.textContent = value;
  }

  function hourLabel(h) {
    if (h === 0) return '12a';
    if (h < 12) return `${h}a`;
    if (h === 12) return '12p';
    return `${h - 12}p`;
  }

  // The x axis runs over today's walking hours (staff set them on Hours &
  // alerts; 7am to 7pm by default), widened to take in any hour that has
  // engagements, so a 6:30am walk always gets its bar. Showing all 24 hours
  // would waste most of the chart on a flat empty stretch.
  const DEFAULT_AXIS = { first: 7, last: 19 };
  let dayAxis = null; // today's { first, last } hour, from /api/shelter/today
  const shelterHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: SHELTER_TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  function shelterHourOf(iso) {
    const parts = Object.fromEntries(shelterHourFmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
  }
  async function loadDayAxis() {
    try {
      const { today } = await api('/api/shelter/today');
      if (!today || today.closed) { dayAxis = null; return; }
      const open = shelterHourOf(today.opensAt);
      const close = shelterHourOf(today.closesAt);
      const span = (new Date(today.closesAt) - new Date(today.opensAt)) / 3600000;
      // "All day" (or a window that wraps) tells us nothing useful: keep the default.
      dayAxis = span > 0 && span < 20 ? { first: open.hour, last: close.minute ? close.hour : Math.max(open.hour, close.hour - 1) } : null;
    } catch (err) { dayAxis = null; }
    if (lastLiveData) renderSparkline(lastLiveData.hourlyToday);
  }
  function displayHours(hourly) {
    const base = dayAxis || DEFAULT_AXIS;
    let first = base.first;
    let last = Math.max(base.last, base.first);
    hourly.forEach((n, h) => {
      if (!n) return;
      first = Math.min(first, h);
      last = Math.max(last, h);
    });
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }

  // Hand-rolled inline SVG bar chart (same house style as app.js's
  // trendChartHtml) -- a y-axis with clean round gridlines and x-axis hour
  // labels, so the shape of the day is actually readable, not just relative
  // bar heights. Single series, so no legend (the title already says what's
  // plotted); gridlines/axis text stay recessive (muted, never the bar's
  // green) per the dataviz skill's mark spec.
  function renderSparkline(hourlyToday) {
    const hourly = hourlyToday || new Array(24).fill(0);
    const DISPLAY_HOURS = displayHours(hourly);
    const values = DISPLAY_HOURS.map((h) => hourly[h] || 0);
    const dataMax = Math.max(0, ...values);
    const niceMax = dataMax === 0 ? 2 : Math.ceil(dataMax / 2) * 2;
    // The viewBox width must track the container's actual rendered width
    // (same pattern as app.js's trendChartHtml) -- a hardcoded W with the
    // SVG's default preserveAspectRatio scales the whole chart down to fit
    // *inside* a wide card, leaving it pinned at a small fixed pixel size
    // with blank space on both sides instead of filling the card.
    const containerWidth = document.getElementById('sparklineBars').clientWidth;
    const W = Math.max(280, Math.round(containerWidth || 480));
    // padL is wider than the y-axis text alone needs so the bigger labels
    // (see .spark-y-label) have comfortable room, not a cramped fit.
    const H = 130, padL = 32, padB = 18, padT = 8;
    const plotW = W - padL, plotH = H - padB - padT;
    const barW = plotW / DISPLAY_HOURS.length;
    const yFor = (v) => padT + plotH - (v / niceMax) * plotH;

    const gridLines = [0, niceMax / 2, niceMax].map((v) => {
      const y = yFor(v);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" class="spark-grid" />
        <text x="${padL - 6}" y="${(y + 4).toFixed(1)}" class="spark-y-label" text-anchor="end">${Math.round(v)}</text>`;
    }).join('');

    const bars = values.map((n, i) => {
      const h = DISPLAY_HOURS[i];
      const x = padL + i * barW + 1;
      const y = yFor(n);
      const height = Math.max(1, (padT + plotH) - y);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, barW - 2).toFixed(1)}" height="${height.toFixed(1)}" class="spark-bar"><title>${hourLabel(h)} - ${n} engagement${n === 1 ? '' : 's'}</title></rect>`;
    }).join('');

    // A label every other hour (every third on a long day), from the first.
    const step = DISPLAY_HOURS.length > 16 ? 3 : 2;
    const xLabels = DISPLAY_HOURS.filter((h, i) => i % step === 0).map((h) => {
      const i = DISPLAY_HOURS.indexOf(h);
      const x = padL + i * barW + barW / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 2}" class="spark-x-label" text-anchor="middle">${hourLabel(h)}</text>`;
    }).join('');

    const baseline = `<line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${W}" y2="${(padT + plotH).toFixed(1)}" class="spark-axis-line" />`;

    document.getElementById('sparklineBars').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="spark-svg" role="img" aria-label="Finished engagements per hour they started, today, ${hourLabel(DISPLAY_HOURS[0])}m to ${hourLabel(DISPLAY_HOURS[DISPLAY_HOURS.length - 1])}m">
        ${gridLines}${bars}${baseline}${xLabels}
      </svg>`;
  }

  function renderOutsToday(outsToday, dogsOutToday) {
    const noun = (NOUNS[liveSpecies] || 'Dogs').toLowerCase();
    document.getElementById('dogsOutTodayTotal').textContent =
      dogsOutToday ? `— ${dogsOutToday} ${dogsOutToday === 1 ? noun.replace(/s$/, '') : noun}` : '';
    const boxes = document.getElementById('outsTodayBuckets');
    if (!outsToday) { boxes.innerHTML = ''; return; }
    boxes.innerHTML = [['1', '1 time'], ['2', '2 times'], ['3', '3 times'], ['4plus', '4+ times']]
      .map(([key, label]) => `
        <div class="mini-stat">
          <span class="mini-value">${outsToday[key] || 0}</span>
          <span class="mini-label">${label}</span>
        </div>`).join('');
  }

  // Daycations are off-site, so they always get their own area, separate
  // from whichever grid view (location or activity) is currently selected.
  function renderDaycation(entries, activityAverages) {
    const list = entries || [];
    document.getElementById('daycationCard').classList.toggle('hidden', list.length === 0);
    document.getElementById('daycationEntries').innerHTML = list.map((e) => entryHtml(e, activityAverages)).join('');
  }

  const ACTIVITY_TITLES = { walk: 'Walk', cuddle: 'Cuddle', matchmaking: 'Matchmaking', playgroup: 'Playgroup' };
  let viewMode = 'location';

  function renderGrid(data) {
    const grid = document.getElementById('locationGrid');
    if (viewMode === 'activity') {
      const allEntries = Object.values(data.locations).flat();
      grid.innerHTML = GRID_ACTIVITIES.map((activity) => {
        const list = allEntries.filter((e) => e.activity === activity);
        const body = list.length
          ? list.map((entry) => entryHtml(entry, data.activityAverages)).join('')
          : '<p class="muted small" style="margin:0;">None out</p>';
        return `
          <div class="location-card ${list.length ? '' : 'empty'}">
            <h2>${ACTIVITY_ICONS[activity]} ${ACTIVITY_TITLES[activity]} <span class="muted small">(${list.length})</span></h2>
            ${body}
          </div>`;
      }).join('');
      return;
    }
    grid.innerHTML = LOCATION_ORDER.map((key) => {
      const list = data.locations[key] || [];
      const body = list.length
        ? list.map((entry) => entryHtml(entry, data.activityAverages)).join('')
        : `<p class="muted small" style="margin:0;">No ${(NOUNS[liveSpecies] || 'Dogs').toLowerCase()} out</p>`;
      return `
        <div class="location-card ${list.length ? '' : 'empty'}">
          <h2>${LOCATION_LABELS[key]} <span class="muted small">(${list.length})</span></h2>
          ${body}
        </div>`;
    }).join('');
  }

  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (lastLiveData) renderGrid(lastLiveData);
      fitToScreen();
    });
  });
  // Every number on the board follows this switch: "Dogs out now" really is
  // dogs only unless Cats or Dogs and cats is picked.
  document.querySelectorAll('.species-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      liveSpecies = btn.dataset.species;
      document.querySelectorAll('.species-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('#liveSection .noun-many').forEach((el) => { el.textContent = NOUNS[liveSpecies]; });
      if (demoMode) renderLive(buildDemoData());
      else refreshLive();
    });
  });

  let lastLiveData = null;

  function renderLive(data) {
    lastLiveData = data;
    setStatValue('statActiveWalkers', data.activeWalkerCount);
    const activeCount = Object.values(data.locations).flat().length + (data.daycation || []).length;
    setStatValue('statActiveCount', activeCount);
    setStatValue('statWalksToday', data.walksToday);

    const arrowEl = document.getElementById('walksTrendArrow');
    if (typeof data.walksYesterday === 'number') {
      const delta = data.walksToday - data.walksYesterday;
      arrowEl.textContent = delta === 0 ? 'same as yesterday' : `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)} vs yesterday`;
      arrowEl.title = `${data.walksYesterday} by this time yesterday`;
    } else {
      arrowEl.textContent = '';
    }

    document.getElementById('lastUpdated').innerHTML =
      `<span class="live-dot" aria-hidden="true"></span>Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

    renderSparkline(data.hourlyToday);
    renderOutsToday(data.outsToday, data.dogsOutToday);
    renderDaycation(data.daycation, data.activityAverages);
    renderGrid(data);
    fitToScreen();
  }

  // A failed poll leaves the last good numbers up (and their timers ticking),
  // so a banner on the board itself says they're stale, at every width (the
  // "Updated" line in the tab bar is hidden on smaller screens).
  let lastGoodAt = null;
  function showLiveError(message) {
    const el = document.getElementById('liveError');
    if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }
    const head = lastGoodAt
      ? `Not updating: this is the board as of ${lastGoodAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, so times and counts may be out of date.`
      : "Couldn't load the board.";
    el.innerHTML = `<strong>${escapeHtml(head)}</strong> <span>${escapeHtml(message)} It keeps trying every few seconds.</span>`;
    el.classList.remove('hidden');
    fitToScreen();
  }

  async function refreshLive() {
    if (demoMode) return;
    // A tab nobody is looking at doesn't poll (it catches up the moment it's
    // shown again, see visibilitychange below).
    if (document.hidden) return;
    try {
      const species = liveSpecies;
      const data = await api(`/api/staff/live?species=${encodeURIComponent(species)}`);
      if (species === liveSpecies && !demoMode) {
        lastGoodAt = new Date();
        showLiveError(null);
        renderLive(data);
      }
    } catch (err) {
      if (demoMode) return;
      document.getElementById('lastUpdated').textContent = "Couldn't update";
      showLiveError(err.message);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLive();
  });

  // ---- Demo mode: a fabricated, clearly-labeled roster for showing the
  // board off (e.g. to the county) without exposing real shelter data.
  // Entirely client-side -- never touches the server or the database. ----
  const DEMO_ACTIVITY_LABELS = { walk: 'Walk', cuddle: 'Cuddle', playgroup: 'Playgroup', matchmaking: 'Matchmaking', daycation: 'Daycation' };
  // Made-up "running average" durations for the demo, in the same shape the
  // real /api/staff/live sends -- realistic, on the short side (most walks
  // and sessions are quick), not the old 30-min time-limit-ish numbers.
  const DEMO_AVERAGES = { walk: 18 * 60, cuddle: 15 * 60, matchmaking: 12 * 60, playgroup: 15 * 60, daycation: 360 * 60 };
  // One made-up roster per species, so the Show switch works in demo mode
  // too: dogs walk, go to Playgroup and on daycations; cats get cuddles and
  // matchmaking. "Dogs and cats" shows both.
  // Dogs: 3 walking, 2 Playgroup, 1 matchmaking, 1 daycation = 7. Only Rocky
  // is above average (slightly), so the board reads as a normal, calm moment.
  const DEMO_ROSTERS = {
    dog: [
      { dogName: 'Buddy', activity: 'walk', location: 'A', minutesAgo: 3 },
      { dogName: 'Luna', activity: 'walk', location: 'B', minutesAgo: 9 },
      { dogName: 'Rocky', activity: 'walk', location: 'C', minutesAgo: 22 },
      { dogName: 'Bella', activity: 'playgroup', location: 'D', minutesAgo: 4 },
      { dogName: 'Max', activity: 'playgroup', location: 'A', minutesAgo: 8 },
      { dogName: 'Daisy', activity: 'matchmaking', location: 'E', minutesAgo: 2 },
      { dogName: 'Charlie', activity: 'daycation', location: 'B', minutesAgo: 150 }
    ],
    cat: [
      { dogName: 'Mittens', activity: 'cuddle', location: 'C', minutesAgo: 5, cat: true },
      { dogName: 'Oliver', activity: 'cuddle', location: 'C', minutesAgo: 11, cat: true },
      { dogName: 'Cleo', activity: 'matchmaking', location: 'unassigned', minutesAgo: 3, cat: true }
    ]
  };
  // Per-species "today" numbers, so the tiles add up for each switch position.
  const DEMO_TODAY = {
    dog: { peak: 6, dogsOut: 19, outs: { 1: 11, 2: 5, 3: 2, '4plus': 1 } },
    cat: { peak: 2, dogsOut: 6, outs: { 1: 5, 2: 1, 3: 0, '4plus': 0 } }
  };
  function buildDemoData(species = liveSpecies) {
    const now = Date.now();
    const kinds = species === 'all' ? ['dog', 'cat'] : [species === 'cat' ? 'cat' : 'dog'];
    const roster = kinds.flatMap((k) => DEMO_ROSTERS[k]);
    const locations = { A: [], B: [], C: [], D: [], E: [], unassigned: [] };
    const daycation = [];
    roster.forEach((r, i) => {
      const dogId = 9000 + i;
      const entry = {
        dogId,
        dogName: r.dogName,
        photoUrl: `/dog-silhouettes/${r.cat ? 'cat-' : ''}${dogId}.svg`,
        activity: r.activity,
        activityLabel: DEMO_ACTIVITY_LABELS[r.activity],
        startedAt: new Date(now - r.minutesAgo * 60000).toISOString(),
        location: r.location,
        walkerName: `Demo Volunteer ${i + 1}`
      };
      if (r.activity === 'daycation') daycation.push(entry);
      else locations[r.location].push(entry);
    });
    // A plausible bell-ish curve across the walking day (7am-7pm).
    const hourlyToday = Array.from({ length: 24 }, (_, h) => kinds.reduce((sum, k) => sum
      + (h >= 7 && h <= 19 ? Math.max(0, Math.round(DEMO_TODAY[k].peak * (0.5 + 0.5 * Math.sin(((h - 7) / 12) * Math.PI)))) : 0), 0));
    const walksToday = hourlyToday.reduce((s, n) => s + n, 0);
    const outsToday = {};
    for (const key of ['1', '2', '3', '4plus']) outsToday[key] = kinds.reduce((s, k) => s + DEMO_TODAY[k].outs[key], 0);
    return {
      generatedAt: new Date().toISOString(),
      activeWalkerCount: roster.length,
      walksToday,
      walksYesterday: Math.max(1, walksToday - 6),
      hourlyToday,
      dogsOutToday: kinds.reduce((s, k) => s + DEMO_TODAY[k].dogsOut, 0),
      outsToday,
      daycation,
      activityAverages: DEMO_AVERAGES,
      locations
    };
  }

  function setDemoMode(on) {
    demoMode = on;
    document.getElementById('demoToggleBtn').classList.toggle('active', on);
    document.getElementById('demoBanner').classList.toggle('hidden', !on);
    if (on) { showLiveError(null); renderLive(buildDemoData()); } else refreshLive();
  }
  document.getElementById('demoToggleBtn').addEventListener('click', () => setDemoMode(!demoMode));

  // TV mode: fit the live board to one screen at any width (a TV that
  // reports itself as 1024 wide, say). Remembered on this browser only.
  const tvBtn = document.getElementById('tvModeBtn');
  function syncTvButton() {
    tvBtn.classList.toggle('active', tvMode);
    tvBtn.setAttribute('aria-pressed', tvMode ? 'true' : 'false');
  }
  tvBtn.addEventListener('click', () => {
    tvMode = !tvMode;
    try { localStorage.setItem('staffTvMode', tvMode ? '1' : '0'); } catch (e) { /* private mode */ }
    syncTvButton();
    fitToScreen();
  });
  syncTvButton();

  // Ticks every visible elapsed timer and progress bar from their cached
  // data attributes every second, so the display stays smooth between the
  // slower 5s server polls (and keeps demo mode "live" too, for free).
  setInterval(() => {
    document.querySelectorAll('.walk-entry').forEach((entryEl) => {
      const elapsedEl = entryEl.querySelector('.elapsed');
      const startedAt = elapsedEl && elapsedEl.dataset.started;
      const avgSeconds = Number(entryEl.dataset.avgSeconds);
      if (!startedAt) return;
      elapsedEl.textContent = formatElapsed(startedAt);
      if (!avgSeconds) return; // daycations: no average to compare with
      const prog = progressInfo(startedAt, avgSeconds);
      const fill = entryEl.querySelector('.progress-fill');
      if (fill) {
        fill.style.width = `${prog.pct.toFixed(1)}%`;
        fill.classList.remove('warning');
        if (prog.state !== 'good') fill.classList.add(prog.state);
      }
      let note = entryEl.querySelector('.progress-note');
      if (prog.note) {
        if (!note) {
          note = document.createElement('div');
          entryEl.querySelector('.progress-track').insertAdjacentElement('afterend', note);
        }
        note.className = `progress-note ${prog.state}`;
        note.textContent = prog.note;
      } else if (note) {
        note.remove();
      }
    });
  }, 1000);

  refreshLive();
  setInterval(refreshLive, 5000);
  loadDayAxis();
  setInterval(() => { if (!document.hidden) loadDayAxis(); }, 30 * 60 * 1000); // a new day, new hours

  // ==================== Reports ====================
  const fromInput = document.getElementById('reportFrom');
  const toInput = document.getElementById('reportTo');
  const granularitySelect = document.getElementById('reportGranularity');
  const speciesSelect = document.getElementById('reportSpecies');
  toInput.value = shelterTodayKey();
  fromInput.value = addDaysKey(toInput.value, -29);
  toInput.max = shelterTodayKey();

  // From must not be after To. Returns false (and says so) when it is.
  function rangeIsValid() {
    const errEl = document.getElementById('reportRangeError');
    const bad = fromInput.value && toInput.value && fromInput.value > toInput.value;
    errEl.textContent = bad ? '"From" is after "To". Pick a From date on or before the To date.' : '';
    fromInput.setAttribute('aria-invalid', bad ? 'true' : 'false');
    document.querySelector('.export-links').classList.toggle('disabled', !!bad);
    return !bad;
  }
  [fromInput, toInput].forEach((el) => el.addEventListener('change', rangeIsValid));
  speciesSelect.addEventListener('change', () => { renderDogChips(); refreshReport(); });

  function allSectionKeys() {
    return [...document.querySelectorAll('#sectionsGrid input[type=checkbox]')].map((cb) => cb.value);
  }
  function selectedSections() {
    return [...document.querySelectorAll('#sectionsGrid input[type=checkbox]:checked')].map((cb) => cb.value);
  }
  function setSelectedSections(sections) {
    document.querySelectorAll('#sectionsGrid input[type=checkbox]').forEach((cb) => { cb.checked = sections.includes(cb.value); });
  }

  // ---- Individual dog picker ----
  let dogsIndex = [];
  let selectedDogs = [];

  async function loadDogsList() {
    try {
      const { dogs } = await api('/api/staff/dogs');
      dogsIndex = dogs;
      document.getElementById('dogPickerList').innerHTML =
        dogs.map((d) => `<option value="${escapeHtml(pickerLabel(d))}"></option>`).join('');
    } catch (err) { /* non-fatal: picker just stays empty */ }
  }

  // Many names repeat (two Dukes, one adopted long ago), so every option
  // carries the shelter ID and kennel, and the pick is matched on the ID:
  // "Duke · ID 272583 · kennel E", "Duke · ID 270585 · no longer listed".
  function pickerLabel(d) {
    const where = !d.listed ? 'no longer listed' : d.kennel ? `kennel ${d.kennel}` : 'kennel unknown';
    return `${d.name} · ID ${d.id} · ${where}${d.species === 'cat' ? ' · cat' : ''}`;
  }
  // The typed or picked text -> one animal, or an error message.
  function findPickedDog(text) {
    const idMatch = /\bID\s*#?(\d+)\b/i.exec(text) || /^#?(\d+)$/.exec(text);
    if (idMatch) {
      const byId = dogsIndex.find((d) => String(d.id) === idMatch[1]);
      return byId ? { dog: byId } : { error: `No animal with ID ${idMatch[1]} found.` };
    }
    const same = dogsIndex.filter((d) => d.name.toLowerCase() === text.toLowerCase());
    if (same.length === 1) return { dog: same[0] };
    if (same.length > 1) return { error: `${same.length} animals are named "${same[0].name}". Pick one from the list (it shows each one's ID and kennel).` };
    return { error: `No animal named "${text}" found.` };
  }

  // A dog picked for a Cats report (or a cat for a Dogs one) is left out
  // of the report by the server; its chip says so instead of vanishing.
  function chipOutOfReport(d) {
    const sp = speciesSelect.value;
    return sp !== 'all' && (d.species || 'dog') !== sp;
  }
  function renderDogChips() {
    document.getElementById('dogChips').innerHTML = selectedDogs.map((d) => `
      <span class="dog-chip${chipOutOfReport(d) ? ' dog-chip-off' : ''}">${escapeHtml(d.name)} <span class="dog-chip-id">ID ${d.id}</span>${chipOutOfReport(d) ? ` <span class="dog-chip-note">(not in a ${speciesSelect.value === 'cat' ? 'Cats' : 'Dogs'} report)</span>` : ''}<button type="button" data-remove="${d.id}" aria-label="Remove ${escapeHtml(d.name)} (ID ${d.id})">×</button></span>
    `).join('');
  }

  function addDogFromInput() {
    const input = document.getElementById('dogPickerInput');
    const errEl = document.getElementById('dogPickerError');
    const text = input.value.trim();
    if (!text) return;
    const { dog: match, error } = findPickedDog(text);
    if (!match) { errEl.textContent = error; return; }
    errEl.textContent = '';
    if (!selectedDogs.some((d) => d.id === match.id)) selectedDogs.push(match);
    input.value = '';
    renderDogChips();
    refreshReport();
  }
  document.getElementById('addDogBtn').addEventListener('click', addDogFromInput);
  document.getElementById('dogPickerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addDogFromInput(); }
  });
  document.getElementById('dogChips').addEventListener('click', (e) => {
    const id = e.target.dataset.remove;
    if (id == null) return;
    selectedDogs = selectedDogs.filter((d) => String(d.id) !== id);
    renderDogChips();
    refreshReport();
  });

  // ---- Saved report formats (shared across all staff) ----
  let savedReports = [];

  async function loadSavedReportsList() {
    try {
      const { reports } = await api('/api/staff/saved-reports');
      savedReports = reports;
      const select = document.getElementById('savedReportSelect');
      const current = select.value;
      select.innerHTML = '<option value="">— choose one to load —</option>' +
        reports.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
      select.value = reports.some((r) => String(r.id) === current) ? current : '';
    } catch (err) { /* non-fatal: the builder still works without saved formats */ }
  }

  document.getElementById('savedReportSelect').addEventListener('change', () => {
    document.getElementById('deleteSavedReportBtn').classList.toggle('hidden', !document.getElementById('savedReportSelect').value);
  });

  document.getElementById('loadSavedReportBtn').addEventListener('click', () => {
    const id = document.getElementById('savedReportSelect').value;
    const report = savedReports.find((r) => String(r.id) === id);
    if (!report) return;
    setSelectedSections(report.sections);
    granularitySelect.value = report.granularity;
    // A format saved before species were stored is a dog report.
    speciesSelect.value = ['dog', 'cat', 'all'].includes(report.species) ? report.species : 'dog';
    selectedDogs = report.dogIds.map((dogId) => dogsIndex.find((d) => d.id === dogId) || { id: dogId, name: `Animal #${dogId}` });
    renderDogChips();
    document.getElementById('deleteSavedReportBtn').classList.remove('hidden');
    refreshReport();
  });

  document.getElementById('saveReportBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('saveReportName');
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      await api('/api/staff/saved-reports', {
        method: 'POST',
        body: JSON.stringify({ name, sections: selectedSections(), granularity: granularitySelect.value, species: speciesSelect.value, dogIds: selectedDogs.map((d) => d.id) })
      });
      nameInput.value = '';
      await loadSavedReportsList();
      toast(`Saved "${name}".`);
    } catch (err) { toast(`Couldn't save. ${err.message}`, 'error'); }
  });

  document.getElementById('deleteSavedReportBtn').addEventListener('click', async () => {
    const id = document.getElementById('savedReportSelect').value;
    if (!id) return;
    // Formats are shared by every staff account, so deleting one is for everyone.
    const report = savedReports.find((r) => String(r.id) === id);
    if (!window.confirm(`Delete the saved format "${report ? report.name : 'this format'}"? It's shared, so it goes away for every staff member.`)) return;
    try {
      await api(`/api/staff/saved-reports/${id}`, { method: 'DELETE' });
      await loadSavedReportsList();
      document.getElementById('deleteSavedReportBtn').classList.add('hidden');
    } catch (err) { toast(`Couldn't delete. ${err.message}`, 'error'); }
  });

  // ---- Fetching, trimming and rendering the report itself ----
  // The server always computes every section; checkbox toggles re-render
  // from the one cached full fetch instead of hitting the network again --
  // only a date/granularity/dog-pick change needs a fresh request.
  let lastFullReport = null;

  function baseParams() {
    const params = new URLSearchParams({ from: fromInput.value, to: toInput.value, granularity: granularitySelect.value, species: speciesSelect.value });
    if (selectedDogs.length) params.set('dogIds', selectedDogs.map((d) => d.id).join(','));
    return params;
  }

  function pickSectionsClient(report, sections) {
    const tables = {};
    for (const key of sections) if (report.tables[key]) tables[key] = report.tables[key];
    const stats = { totals: report.stats.totals };
    if (sections.includes('highlights')) stats.highlights = report.stats.highlights;
    return { ...report, stats, tables };
  }

  function updateExportLinks() {
    const params = baseParams();
    params.set('sections', selectedSections().join(','));
    const query = params.toString();
    document.getElementById('exportCsv').href = `/api/staff/reports/export.csv?${query}`;
    document.getElementById('exportXlsx').href = `/api/staff/reports/export.xlsx?${query}`;
    document.getElementById('exportPdf').href = `/api/staff/reports/export.pdf?${query}`;
  }

  function reportTableHtml(title, columns, rows) {
    const header = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const body = rows.map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${columns.length}" class="muted">Nothing to show in this range.</td></tr>`;
    return `<table><caption>${escapeHtml(title)}</caption><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function statsBlockHtml(totals, highlights, species) {
    const noun = (NOUNS[species] || 'Dogs').toLowerCase();
    let html = `<div class="stat-row">
      <div class="stat-tile"><span class="stat-value">${totals.walks}</span><span class="stat-label">Engagements</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.hours}</span><span class="stat-label">Volunteer hours</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.uniqueDogs}</span><span class="stat-label">Unique ${noun}</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.volunteerHeadcount}</span><span class="stat-label">Volunteers active</span></div>
    </div>`;
    if (highlights) {
      // Busiest/quietest are left out by the server when they'd tie (or a
      // day has too few engagements to show); the tiles go with them.
      const dayTile = (d, label) => (d ? `<div class="stat-tile"><span class="stat-value stat-value-date">${escapeHtml(friendlyDate(d.dateKey))}</span><span class="stat-label">${label} (${d.walks} engagements)</span></div>` : '');
      html += `<div class="stat-row">
        ${dayTile(highlights.busiestDay, 'Busiest day')}
        ${dayTile(highlights.quietestDay, 'Quietest day')}
        <div class="stat-tile"><span class="stat-value">${highlights.avgWalksPerVolunteer ?? '—'}</span><span class="stat-label">Avg engagements per volunteer</span></div>
        ${'avgWalkMinutes' in highlights ? `<div class="stat-tile" title="Walks only (not cuddles, playgroup or daycations), finished, a minute or longer"><span class="stat-value">${highlights.avgWalkMinutes ?? '—'}</span><span class="stat-label">Avg walk length (min)</span></div>` : ''}
      </div>`;
    }
    return html;
  }

  function renderReport(report) {
    let html = statsBlockHtml(report.stats.totals, report.stats.highlights, report.species);
    const tables = Object.values(report.tables);
    if (tables.length) {
      html += `<div class="report-tables">${tables.map((t) => reportTableHtml(t.title, t.columns, t.rows)).join('')}</div>`;
    }
    if (report.dogDetail && report.dogDetail.length) {
      html += report.dogDetail.map((dog) => `
        <div class="dog-detail-card">
          <h4>${escapeHtml(dog.dogName)} — ${dog.totals.walks} engagement${dog.totals.walks === 1 ? '' : 's'}, ${dog.totals.hours}h</h4>
          <div class="report-tables">${reportTableHtml(dog.table.title, dog.table.columns, dog.table.rows)}</div>
        </div>`).join('');
    }
    if (report.notes && report.notes.length) {
      html += `<ul class="report-notes muted small">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
    }
    document.getElementById('reportOutput').innerHTML = html;
  }

  function applySectionFilter() {
    updateExportLinks();
    if (lastFullReport) renderReport(pickSectionsClient(lastFullReport, selectedSections()));
  }
  document.getElementById('sectionsGrid').addEventListener('change', applySectionFilter);

  async function refreshReport() {
    const out = document.getElementById('reportOutput');
    if (!rangeIsValid()) {
      lastFullReport = null;
      out.innerHTML = '';
      return;
    }
    try {
      const params = baseParams();
      params.set('sections', allSectionKeys().join(','));
      lastFullReport = await api(`/api/staff/reports?${params.toString()}`);
      applySectionFilter();
    } catch (err) {
      out.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
    }
  }

  document.getElementById('reportForm').addEventListener('submit', (e) => {
    e.preventDefault();
    refreshReport();
  });

  loadDogsList();
  loadSavedReportsList();
  refreshReport();

  // ==================== Hours & alerts ====================
  // Usual weekly hours, special days (closed / other hours / a note) and
  // shelter alerts. The server side is src/shelterSchedule.js.
  const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: SHELTER_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function setStatus(id, text, isError) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.style.color = isError ? 'var(--red)' : '';
  }

  // Midnight to midnight (the server's "12am to 12am"), or to 11:59pm (what
  // the weekly table's time boxes can hold), reads as "all day" in both the
  // summary and the table, so the two never look like they disagree.
  const ALL_DAY_LABELS = ['12am to 12am', '12am to 11:59pm'];
  const hoursText = (label) => (ALL_DAY_LABELS.includes(label) ? 'all day' : label);
  const isAllDay = (open, close) => open === '00:00' && (close === '23:59' || close === '24:00');

  function renderSchedule(data) {
    const t = data.today;
    document.getElementById('hoursToday').innerHTML = `<strong>Today (${escapeHtml(t.label)}):</strong> `
      + (t.closed ? 'Closed' : `walks ${escapeHtml(hoursText(t.hoursLabel))}`)
      + (t.note ? ` · ${escapeHtml(t.note)}` : '');

    document.getElementById('alertList').innerHTML = data.alerts.length
      ? data.alerts.map((a) => `
        <li>
          <div><strong>${escapeHtml(a.title)}</strong>${a.body && a.body !== a.title ? `<div class="small alert-body">${escapeHtml(a.body)}</div>` : ''}
          <div class="small muted">${escapeHtml(fmtWhen(a.occurredAt))}${a.expiresAt ? ` · ${new Date(a.expiresAt) > new Date() ? 'showing until' : 'expired'} ${escapeHtml(fmtWhen(a.expiresAt))}` : ''}</div></div>
          <button type="button" class="link-btn" data-delete-alert="${a.id}" title="Remove it from the Updates tab (a push already sent stays sent)">Remove</button>
        </li>`).join('')
      : '<li class="muted small">None yet.</li>';

    document.getElementById('specialList').innerHTML = data.specialDays.length
      ? data.specialDays.map((d) => `
        <li>
          <div><strong>${escapeHtml(d.label)}</strong> · ${d.closed ? '<span class="closed-tag">Closed</span>' : escapeHtml(hoursText(d.hoursLabel))}
          ${d.note ? `<div class="small">${escapeHtml(d.note)}</div>` : ''}
          ${d.message ? `<div class="small muted alert-body">${escapeHtml(d.message)}</div>` : ''}</div>
          <span class="row-actions">
            <button type="button" class="link-btn" data-edit-day="${d.dateKey}">Edit</button>
            <button type="button" class="link-btn" data-delete-day="${d.dateKey}">Remove</button>
          </span>
        </li>`).join('')
      : '<li class="muted small">Nothing coming up. Every day uses the usual weekly hours.</li>';
    hoursState.specialDays = data.specialDays;

    document.getElementById('weeklyRows').innerHTML = data.weekly.map((d) => `
      <tr data-dow="${d.dow}">
        <td>${escapeHtml(d.label)}${!d.closed && isAllDay(d.open, d.close) ? ' <span class="small muted">(all day)</span>' : ''}</td>
        <td><input type="time" class="wk-open" value="${d.open}" ${d.closed ? 'disabled' : ''} aria-label="${escapeHtml(d.label)} walks start" /></td>
        <td><input type="time" class="wk-close" value="${d.close}" ${d.closed ? 'disabled' : ''} aria-label="${escapeHtml(d.label)} walks end" /></td>
        <td><input type="checkbox" class="wk-closed" ${d.closed ? 'checked' : ''} aria-label="${escapeHtml(d.label)} closed" /></td>
      </tr>`).join('');
    document.querySelectorAll('#weeklyRows .wk-closed').forEach((box) => box.addEventListener('change', () => {
      box.closest('tr').querySelectorAll('input[type="time"]').forEach((i) => { i.disabled = box.checked; });
    }));
    syncWeeklyScrollHint();
  }
  // On a phone the weekly table is wider than its card and the Closed column
  // starts off-screen: say so, until it's been scrolled into view.
  function syncWeeklyScrollHint() {
    const box = document.querySelector('.weekly-scroll');
    const hint = document.getElementById('weeklyScrollHint');
    if (!box || !hint) return;
    const hiddenPart = box.scrollWidth - box.clientWidth - box.scrollLeft;
    hint.classList.toggle('hidden', hiddenPart <= 4);
  }
  document.querySelector('.weekly-scroll').addEventListener('scroll', syncWeeklyScrollHint, { passive: true });
  window.addEventListener('resize', syncWeeklyScrollHint);
  const hoursState = { specialDays: [] };

  async function loadSchedule() {
    loadDayAxis(); // today's hours may have just changed
    try {
      renderSchedule(await api('/api/staff/schedule'));
    } catch (err) {
      document.getElementById('hoursToday').textContent = `Couldn't load hours. ${err.message}`;
    }
  }

  function specialMode() { return document.querySelector('input[name="specialMode"]:checked').value; }
  function syncSpecialMode() {
    document.getElementById('specialTimes').classList.toggle('hidden', specialMode() !== 'hours');
  }
  document.querySelectorAll('input[name="specialMode"]').forEach((r) => r.addEventListener('change', syncSpecialMode));
  document.getElementById('specialDate').min = shelterTodayKey();
  document.getElementById('specialDate').value = shelterTodayKey();

  // Edit mode for a special day: the button says what it will do ("Update
  // Thu, Nov 26") and Cancel puts the form back to adding a new day.
  let editingDay = null;
  function setSpecialEditMode(dateKey) {
    editingDay = dateKey;
    const saveBtn = document.getElementById('specialSaveBtn');
    saveBtn.textContent = dateKey ? `Update ${friendlyDate(dateKey)}` : 'Save day';
    document.getElementById('specialCancelBtn').classList.toggle('hidden', !dateKey);
    document.getElementById('specialForm').classList.toggle('editing', !!dateKey);
  }
  function resetSpecialForm() {
    document.getElementById('specialDate').value = shelterTodayKey();
    document.querySelector('input[name="specialMode"][value="closed"]').checked = true;
    document.getElementById('specialOpen').value = '07:00';
    document.getElementById('specialClose').value = '19:00';
    document.getElementById('specialNote').value = '';
    document.getElementById('specialMessage').value = '';
    document.getElementById('specialNotify').checked = false;
    syncSpecialMode();
    setSpecialEditMode(null);
  }
  document.getElementById('specialCancelBtn').addEventListener('click', () => {
    resetSpecialForm();
    setStatus('specialStatus', '');
  });
  document.getElementById('specialDate').addEventListener('change', () => {
    if (editingDay && document.getElementById('specialDate').value !== editingDay) setSpecialEditMode(null);
  });

  // One wording for both places an alert goes out (the alert form and a
  // special day's "also send an alert"). pushedTo counts phones that really
  // got it, not everyone who once turned notifications on.
  function alertSentText(alert) {
    const n = Number(alert && alert.pushedTo) || 0;
    return n > 0
      ? `Alert sent. It's in Updates and went to ${n} volunteer${n === 1 ? "'s phone" : "s' phones"}.`
      : "Alert sent. It's in Updates, but no phones got a notification.";
  }

  document.getElementById('alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('alertTitle').value.trim();
    const body = document.getElementById('alertBody').value.trim();
    const until = document.getElementById('alertUntil').value || null;
    if (!title) return;
    if (!window.confirm(`Send "${title}" to every volunteer's phone now?`)) return;
    setStatus('alertStatus', 'Sending…');
    try {
      const r = await api('/api/staff/alerts', { method: 'POST', body: JSON.stringify({ title, body, until }) });
      document.getElementById('alertForm').reset();
      setStatus('alertStatus', alertSentText(r));
      loadSchedule();
    } catch (err) { setStatus('alertStatus', err.message, true); }
  });

  document.getElementById('specialForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('specialDate').value;
    const payload = {
      mode: specialMode(),
      open: document.getElementById('specialOpen').value,
      close: document.getElementById('specialClose').value,
      note: document.getElementById('specialNote').value.trim(),
      message: document.getElementById('specialMessage').value.trim(),
      notify: document.getElementById('specialNotify').checked
    };
    if (payload.notify && !window.confirm('Also send a shelter alert about this day to every volunteer now?')) return;
    setStatus('specialStatus', 'Saving…');
    try {
      const r = await api(`/api/staff/schedule/days/${encodeURIComponent(date)}`, { method: 'PUT', body: JSON.stringify(payload) });
      const wasEditing = !!editingDay;
      resetSpecialForm();
      setStatus('specialStatus', `${wasEditing ? 'Updated' : 'Saved'} ${r.day.label}.${r.alert ? ` ${alertSentText(r.alert)}` : ''}`);
      loadSchedule();
    } catch (err) { setStatus('specialStatus', err.message, true); }
  });

  document.getElementById('weeklyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = [...document.querySelectorAll('#weeklyRows tr')].map((tr) => ({
      dow: Number(tr.dataset.dow),
      open: tr.querySelector('.wk-open').value,
      close: tr.querySelector('.wk-close').value,
      closed: tr.querySelector('.wk-closed').checked
    }));
    setStatus('weeklyStatus', 'Saving…');
    try {
      await api('/api/staff/schedule/weekly', { method: 'PUT', body: JSON.stringify({ days }) });
      setStatus('weeklyStatus', 'Saved.');
      loadSchedule();
    } catch (err) { setStatus('weeklyStatus', err.message, true); }
  });

  document.getElementById('hoursSection').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-delete-alert], button[data-delete-day], button[data-edit-day]');
    if (!btn) return;
    if (btn.dataset.editDay) {
      const d = hoursState.specialDays.find((x) => x.dateKey === btn.dataset.editDay);
      if (!d) return;
      document.getElementById('specialDate').value = d.dateKey;
      const mode = d.closed ? 'closed' : d.open ? 'hours' : 'note';
      document.querySelector(`input[name="specialMode"][value="${mode}"]`).checked = true;
      if (d.open) document.getElementById('specialOpen').value = d.open;
      if (d.close) document.getElementById('specialClose').value = d.close;
      document.getElementById('specialNote').value = d.note || '';
      document.getElementById('specialMessage').value = d.message || '';
      syncSpecialMode();
      setSpecialEditMode(d.dateKey);
      setStatus('specialStatus', '');
      document.getElementById('specialForm').scrollIntoView({ block: 'nearest' });
      document.getElementById('specialDate').focus();
      return;
    }
    const isAlert = !!btn.dataset.deleteAlert;
    if (!window.confirm(isAlert ? 'Remove this alert from the Updates tab? (Phones that already got it keep the notification.)' : 'Remove this special day? It goes back to the usual hours.')) return;
    try {
      await api(isAlert ? `/api/staff/alerts/${btn.dataset.deleteAlert}` : `/api/staff/schedule/days/${btn.dataset.deleteDay}`, { method: 'DELETE' });
      if (!isAlert && btn.dataset.deleteDay === editingDay) resetSpecialForm();
      loadSchedule();
    } catch (err) { toast(`Couldn't remove it. ${err.message}`, 'error'); }
  });
})();
