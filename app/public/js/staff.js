// Staff dashboard: a standalone page, deliberately not part of app.js's
// closure/state (that file is a single large IIFE for the mobile volunteer
// app). This is its own small IIFE with its own tiny bit of state.
(function () {
  'use strict';

  // Same shape as app.js's api() helper (timeout + friendly network errors),
  // copied rather than shared since there's no module system to import from.
  async function api(path, opts = {}) {
    const { timeout = 20000, ...fetchOpts } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...fetchOpts, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err.name === 'AbortError' ? "That's taking too long." : "Couldn't reach the server.");
    }
    clearTimeout(timer);
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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
  function fitToScreen() {
    if (!zoomCapable || !isLiveTabVisible()) return;
    const scrollHeight = document.documentElement.scrollHeight;
    if (!scrollHeight) return;
    const naturalHeight = scrollHeight / currentZoom;
    const target = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, window.innerHeight / naturalHeight));
    if (Math.abs(target - currentZoom) < 0.01) return;
    currentZoom = target;
    document.documentElement.style.zoom = target;
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
      if (section === 'live') fitToScreen();
      else resetZoom();
    });
  });

  // ==================== Live board ====================
  let demoMode = false;
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

  function formatMinutes(seconds) {
    return `${Math.round(seconds / 60)}m`;
  }

  function entryHtml(entry, activityAverages) {
    const icon = ACTIVITY_ICONS[entry.activity] || '';
    const activityNote = entry.activity !== 'walk' ? ` <span class="meta">(${entry.activityLabel})</span>` : '';
    const avgSeconds = (activityAverages && activityAverages[entry.activity]) || 30 * 60;
    const prog = progressInfo(entry.startedAt, avgSeconds);
    return `
      <div class="walk-entry" data-avg-seconds="${avgSeconds}">
        <div class="entry-head">
          <img class="dog-avatar" src="${escapeHtml(entry.photoUrl || '')}" alt="" loading="lazy" />
          <div class="entry-head-text">
            <div class="dog-name"><span class="activity-icon" title="${escapeHtml(entry.activityLabel)}" aria-hidden="true">${icon}</span>${escapeHtml(entry.dogName)}${activityNote}</div>
            <div class="elapsed" data-started="${entry.startedAt}">${formatElapsed(entry.startedAt)}</div>
          </div>
        </div>
        <div class="progress-track" title="Average ${escapeHtml(entry.activityLabel)} duration: ${formatMinutes(avgSeconds)}">
          <div class="progress-fill ${prog.state !== 'good' ? prog.state : ''}" style="width:${prog.pct.toFixed(1)}%"></div>
        </div>
        ${prog.note ? `<div class="progress-note ${prog.state}">${prog.note}</div>` : ''}
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

  // The shelter only ever lets a walk/activity start from 7am to ~7:15pm
  // (walkHours.js), so hours outside that are always zero in practice --
  // showing all 24 just wastes most of the chart on a flat empty stretch.
  // Restricting the axis to the hours that can ever have data lets the real
  // bars actually fill the width.
  const DISPLAY_HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7am..7pm

  // Hand-rolled inline SVG bar chart (same house style as app.js's
  // trendChartHtml) -- a y-axis with clean round gridlines and x-axis hour
  // labels, so the shape of the day is actually readable, not just relative
  // bar heights. Single series, so no legend (the title already says what's
  // plotted); gridlines/axis text stay recessive (muted, never the bar's
  // green) per the dataviz skill's mark spec.
  function renderSparkline(hourlyToday) {
    const hourly = hourlyToday || new Array(24).fill(0);
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
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, barW - 2).toFixed(1)}" height="${height.toFixed(1)}" class="spark-bar"><title>${hourLabel(h)} - ${n} walk${n === 1 ? '' : 's'}</title></rect>`;
    }).join('');

    const xLabels = [7, 9, 11, 13, 15, 17, 19].map((h) => {
      const i = DISPLAY_HOURS.indexOf(h);
      const x = padL + i * barW + barW / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 2}" class="spark-x-label" text-anchor="middle">${hourLabel(h)}</text>`;
    }).join('');

    const baseline = `<line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${W}" y2="${(padT + plotH).toFixed(1)}" class="spark-axis-line" />`;

    document.getElementById('sparklineBars').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="spark-svg" role="img" aria-label="Walks started per hour today, 7am to 7pm">
        ${gridLines}${bars}${baseline}${xLabels}
      </svg>`;
  }

  function renderOutsToday(outsToday, dogsOutToday) {
    document.getElementById('dogsOutTodayTotal').textContent =
      dogsOutToday ? `— ${dogsOutToday} dog${dogsOutToday === 1 ? '' : 's'}` : '';
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

  const ACTIVITY_TITLES = { walk: 'Walk', cuddle: 'Cuddle', matchmaking: 'Matchmaking', playgroup: 'Play Group' };
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
        : '<p class="muted small" style="margin:0;">No dogs out</p>';
      return `
        <div class="location-card ${list.length ? '' : 'empty'}">
          <h2>${LOCATION_LABELS[key]} <span class="muted small">(${list.length})</span></h2>
          ${body}
        </div>`;
    }).join('');
  }

  document.querySelectorAll('.view-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (lastLiveData) renderGrid(lastLiveData);
      fitToScreen();
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
      arrowEl.textContent = delta === 0 ? '' : (delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`);
      arrowEl.title = `${data.walksYesterday} by this time yesterday`;
    } else {
      arrowEl.textContent = '';
    }

    document.getElementById('lastUpdated').innerHTML =
      `<span class="live-dot" aria-hidden="true"></span>Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;

    renderSparkline(data.hourlyToday);
    renderOutsToday(data.outsToday, data.dogsOutToday);
    renderDaycation(data.daycation, data.activityAverages);
    renderGrid(data);
    fitToScreen();
  }

  async function refreshLive() {
    if (demoMode) return;
    try {
      renderLive(await api('/api/staff/live'));
    } catch (err) {
      document.getElementById('lastUpdated').textContent = err.message;
    }
  }

  // ---- Demo mode: a fabricated, clearly-labeled roster for showing the
  // board off (e.g. to the county) without exposing real shelter data.
  // Entirely client-side -- never touches the server or the database. ----
  const DEMO_ACTIVITY_LABELS = { walk: 'walking', playgroup: 'at play group', matchmaking: 'at matchmaking', daycation: 'on a daycation' };
  // Made-up "running average" durations for the demo, in the same shape the
  // real /api/staff/live sends -- realistic, on the short side (most walks
  // and sessions are quick), not the old 30-min time-limit-ish numbers.
  const DEMO_AVERAGES = { walk: 18 * 60, cuddle: 15 * 60, matchmaking: 12 * 60, playgroup: 15 * 60, daycation: 360 * 60 };
  function buildDemoData() {
    const now = Date.now();
    // 3 walking, 2 playgroup, 1 matchmaking, 1 daycation = 7, as requested.
    // Only Rocky is above average (slightly); everyone else is either just
    // starting out or roughly halfway through, so the board reads as a
    // normal, calm moment rather than everyone being overdue at once.
    const roster = [
      { dogName: 'Buddy', activity: 'walk', location: 'A', minutesAgo: 3 },
      { dogName: 'Luna', activity: 'walk', location: 'B', minutesAgo: 9 },
      { dogName: 'Rocky', activity: 'walk', location: 'C', minutesAgo: 22 },
      { dogName: 'Bella', activity: 'playgroup', location: 'D', minutesAgo: 4 },
      { dogName: 'Max', activity: 'playgroup', location: 'A', minutesAgo: 8 },
      { dogName: 'Daisy', activity: 'matchmaking', location: 'E', minutesAgo: 2 },
      { dogName: 'Charlie', activity: 'daycation', location: 'B', minutesAgo: 150 }
    ];
    const locations = { A: [], B: [], C: [], D: [], E: [], unassigned: [] };
    const daycation = [];
    roster.forEach((r, i) => {
      const dogId = 9000 + i;
      const entry = {
        dogId,
        dogName: r.dogName,
        photoUrl: `/dog-silhouettes/${dogId}.svg`,
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
    const hourlyToday = Array.from({ length: 24 }, (_, h) =>
      (h >= 7 && h <= 19 ? Math.max(0, Math.round(6 + 5 * Math.sin(((h - 7) / 12) * Math.PI))) : 0));
    const walksToday = hourlyToday.reduce((s, n) => s + n, 0);
    return {
      generatedAt: new Date().toISOString(),
      activeWalkerCount: roster.length,
      walksToday,
      walksYesterday: Math.max(1, walksToday - 6),
      hourlyToday,
      dogsOutToday: 19,
      outsToday: { 1: 11, 2: 5, 3: 2, '4plus': 1 },
      daycation,
      activityAverages: DEMO_AVERAGES,
      locations
    };
  }

  function setDemoMode(on) {
    demoMode = on;
    document.getElementById('demoToggleBtn').classList.toggle('active', on);
    document.getElementById('demoBanner').classList.toggle('hidden', !on);
    if (on) renderLive(buildDemoData());
    else refreshLive();
  }
  document.getElementById('demoToggleBtn').addEventListener('click', () => setDemoMode(!demoMode));

  // Ticks every visible elapsed timer and progress bar from their cached
  // data attributes every second, so the display stays smooth between the
  // slower 5s server polls (and keeps demo mode "live" too, for free).
  setInterval(() => {
    document.querySelectorAll('.walk-entry').forEach((entryEl) => {
      const elapsedEl = entryEl.querySelector('.elapsed');
      const startedAt = elapsedEl && elapsedEl.dataset.started;
      const avgSeconds = Number(entryEl.dataset.avgSeconds);
      if (!startedAt || !avgSeconds) return;
      elapsedEl.textContent = formatElapsed(startedAt);
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

  // ==================== Reports ====================
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function daysAgoKey(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const fromInput = document.getElementById('reportFrom');
  const toInput = document.getElementById('reportTo');
  const granularitySelect = document.getElementById('reportGranularity');
  fromInput.value = daysAgoKey(29);
  toInput.value = todayKey();

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
        dogs.map((d) => `<option value="${escapeHtml(d.name)}" data-id="${d.id}"></option>`).join('');
    } catch (err) { /* non-fatal: picker just stays empty */ }
  }

  function renderDogChips() {
    document.getElementById('dogChips').innerHTML = selectedDogs.map((d) => `
      <span class="dog-chip">${escapeHtml(d.name)}<button type="button" data-remove="${d.id}" aria-label="Remove ${escapeHtml(d.name)}">×</button></span>
    `).join('');
  }

  function addDogFromInput() {
    const input = document.getElementById('dogPickerInput');
    const errEl = document.getElementById('dogPickerError');
    const name = input.value.trim();
    if (!name) return;
    const match = dogsIndex.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!match) { errEl.textContent = `No dog named "${name}" found.`; return; }
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
    selectedDogs = report.dogIds.map((dogId) => dogsIndex.find((d) => d.id === dogId) || { id: dogId, name: `Dog #${dogId}` });
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
        body: JSON.stringify({ name, sections: selectedSections(), granularity: granularitySelect.value, dogIds: selectedDogs.map((d) => d.id) })
      });
      nameInput.value = '';
      await loadSavedReportsList();
    } catch (err) { alert(err.message); }
  });

  document.getElementById('deleteSavedReportBtn').addEventListener('click', async () => {
    const id = document.getElementById('savedReportSelect').value;
    if (!id) return;
    try {
      await api(`/api/staff/saved-reports/${id}`, { method: 'DELETE' });
      await loadSavedReportsList();
      document.getElementById('deleteSavedReportBtn').classList.add('hidden');
    } catch (err) { alert(err.message); }
  });

  // ---- Fetching, trimming and rendering the report itself ----
  // The server always computes every section; checkbox toggles re-render
  // from the one cached full fetch instead of hitting the network again --
  // only a date/granularity/dog-pick change needs a fresh request.
  let lastFullReport = null;

  function baseParams() {
    const params = new URLSearchParams({ from: fromInput.value, to: toInput.value, granularity: granularitySelect.value });
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
    const header = columns.map((c) => `<th>${c}</th>`).join('');
    const body = rows.map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${columns.length}" class="muted">Nothing in range.</td></tr>`;
    return `<table><caption>${title}</caption><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function statsBlockHtml(totals, highlights) {
    let html = `<div class="stat-row">
      <div class="stat-tile"><span class="stat-value">${totals.walks}</span><span class="stat-label">Total walks</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.hours}</span><span class="stat-label">Volunteer hours</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.uniqueDogs}</span><span class="stat-label">Unique dogs</span></div>
      <div class="stat-tile"><span class="stat-value">${totals.volunteerHeadcount}</span><span class="stat-label">Volunteers active</span></div>
    </div>`;
    if (highlights) {
      html += `<div class="stat-row">
        <div class="stat-tile"><span class="stat-value" style="font-size:1.3rem;">${highlights.busiestDay ? highlights.busiestDay.dateKey : '—'}</span><span class="stat-label">Busiest day${highlights.busiestDay ? ` (${highlights.busiestDay.walks} walks)` : ''}</span></div>
        <div class="stat-tile"><span class="stat-value" style="font-size:1.3rem;">${highlights.quietestDay ? highlights.quietestDay.dateKey : '—'}</span><span class="stat-label">Quietest day${highlights.quietestDay ? ` (${highlights.quietestDay.walks} walks)` : ''}</span></div>
        <div class="stat-tile"><span class="stat-value">${highlights.avgWalksPerVolunteer ?? '—'}</span><span class="stat-label">Avg walks / volunteer</span></div>
        <div class="stat-tile"><span class="stat-value">${highlights.avgWalkMinutes ?? '—'}</span><span class="stat-label">Avg walk length (min)</span></div>
      </div>`;
    }
    return html;
  }

  function renderReport(report) {
    let html = statsBlockHtml(report.stats.totals, report.stats.highlights);
    const tables = Object.values(report.tables);
    if (tables.length) {
      html += `<div class="report-tables">${tables.map((t) => reportTableHtml(t.title, t.columns, t.rows)).join('')}</div>`;
    }
    if (report.dogDetail && report.dogDetail.length) {
      html += report.dogDetail.map((dog) => `
        <div class="dog-detail-card">
          <h4>${escapeHtml(dog.dogName)} — ${dog.totals.walks} walks, ${dog.totals.hours}h</h4>
          <div class="report-tables">${reportTableHtml(dog.table.title, dog.table.columns, dog.table.rows)}</div>
        </div>`).join('');
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
})();
