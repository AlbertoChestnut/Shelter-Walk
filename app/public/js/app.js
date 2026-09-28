(function () {
  'use strict';

  const appEl = document.getElementById('app');
  const topbarTitle = document.getElementById('topbarTitle');
  const tabButtons = document.querySelectorAll('.tab-btn');

  // Every redraw of the Available list (returning from a dog's confirm
  // screen, closing the profile sheet, even just typing in the search box)
  // replaces #app's innerHTML, which resets scrollTop to 0 by default.
  // Track it continuously and restore it after every redraw instead.
  appEl.addEventListener('scroll', () => {
    if (state.tab === 'available') state.availableScrollTop = appEl.scrollTop;
  }, { passive: true });

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
    needsShiftWalkOnly: false,
    locationFilter: new Set(), // kennel wing letters (A-E) to include; empty = all
    showMoreFilters: false,
    filtersTab: 'filters', // 'filters' | 'presets'
    presetMinDaysAtLeast: null, // set by the "Beginner" built-in preset
    ageMinYears: null, // adopter age range; null = no limit
    ageMaxYears: null,
    minShelterDays: null, // advanced filter: at least this many days in the shelter (this stay)
    openFilterSections: new Set(), // folding filter sections the user has opened ('breed', 'advanced')
    availableSort: 'shelterTime',
    availableSortDir: 'desc',
    availableSearch: '',
    availableDogsRaw: [],
    availableExperienceLevel: null,
    availableScrollTop: 0,
    savedFilters: [],
    statsView: 'summary',
    statsPresentOnly: true,
    selectedDateKey: null,
    selectedShiftIndex: null, // which of the 4 shift tiles is drilled into on the Stats day view, if any
    statsScope: 'mine', // 'mine' | 'together' (shelter-wide, anonymous)
    togetherDay: null, // dateKey of the Together day being viewed, if any
    statsRange: 'today', // 'today' | 'lifetime' -- which Stats tiles are shown
    audit: { location: '', dog: null, loading: false, pendingMarkers: null, recent: [], scanned: {}, scanError: '' }
  };

  // ---------- API helper ----------
  let sessionExpiredShown = false;
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
  async function api(path, opts = {}) {
    const { timeout = 30000, ...fetchOpts } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...fetchOpts,
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
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      if (res.status === 401 && body && body.sessionExpired) promptSessionExpired();
      const err = new Error((body && body.error) || `Request failed (${res.status})`);
      err.body = body;
      err.status = res.status;
      throw err;
    }
    return body;
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

  function fmtDuration(seconds) {
    if (seconds == null) return '-';
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }

  function fmtClock(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function dateKey(iso) {
    return new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD in the viewer's local timezone
  }

  function todayKey() {
    return new Date().toLocaleDateString('en-CA');
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
    (dog.blueMarkers || []).filter((m) => m !== 'blue').forEach((m) => {
      const cls = m === 'blue_evo' ? 'marker-dot blue rect' : 'marker-dot blue';
      html += `<span class="${cls}" title="${esc(BLUE_MARKER_NAMES[m] || 'Behavior marker')}">${BLUE_MARKER_LETTERS[m] || ''}</span>`;
    });
    // POO is a strict single-select: plain OR priority, never both shown —
    // no longer implies the other.
    if (dog.pooStatus === 'priority') {
      html += `<span class="marker-dot poo-priority" title="High priority POO dog - first out in the morning, last out in the evening">${ASTERISK_SVG}</span>`;
    } else if (dog.pooStatus === 'poo') {
      html += `<span class="marker-dot poo" title="POO dog - Potty Outside Only"></span>`;
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
    if (dog.pbFlag) html += `<span class="marker-dot pb" title="Potty Break OK - short walk only">PB</span>`;
    if (dog.isPendingAdoption) html += `<span class="marker-dot pending" title="Someone has started adopting this dog - Beginners can't walk them">Adopted</span>`;
    return html;
  }

  // Wraps the badges in a tappable span carrying just enough data to render
  // the breakdown popup without re-fetching — works from anywhere
  // markerBadges() is used (Available cards, Stats rows, Audit, profile)
  // since it's self-contained rather than needing a per-screen click wire-up.
  function markerBadges(dog, isHistorical) {
    const html = markerBadgesRaw(dog, isHistorical);
    if (!markerBreakdownRows(dog, isHistorical).length) return html;
    const payload = esc(JSON.stringify({
      name: dog.name,
      blueMarkers: dog.blueMarkers || [],
      pooStatus: dog.pooStatus || 'none',
      starFlag: !!dog.starFlag,
      pbFlag: !!dog.pbFlag,
      isPendingAdoption: !!dog.isPendingAdoption,
      isHistorical: !!isHistorical
    }));
    return `<span class="marker-badges-toggle" data-dog-info="${payload}">${html}</span>`;
  }

  // Full icon → meaning breakdown for a dog's active markers, shown on tap
  // since tooltips (title=) don't work on mobile. Each row shows the actual
  // badge (same markup as markerBadgesRaw) next to its meaning, not just its
  // letter, so it's obvious which icon on the dog is being explained.
  function markerBreakdownRows(dog, isHistorical) {
    const rows = [];
    withImpliedBlank(dog.blueMarkers || []).forEach((m) => {
      if (m === 'blue') return; // the blank general marker has nothing to spell out
      const cls = m === 'blue_evo' ? 'marker-dot blue rect' : 'marker-dot blue';
      rows.push({ icon: `<span class="${cls}">${BLUE_MARKER_LETTERS[m] || ''}</span>`, name: BLUE_MARKER_NAMES[m] || 'Behavior marker' });
    });
    if (dog.pooStatus === 'priority') rows.push({ icon: `<span class="marker-dot poo-priority">${ASTERISK_SVG}</span>`, name: 'High priority POO dog - first out in the morning, last out in the evening' });
    else if (dog.pooStatus === 'poo') rows.push({ icon: '<span class="marker-dot poo"></span>', name: 'POO dog - Potty Outside Only' });
    if (dog.starFlag) {
      const starPending = !isHistorical && dog.isPendingAdoption;
      rows.push({ icon: `<span class="marker-star${starPending ? ' pending' : ''}">★</span>`, name: starPending ? 'Good for beginners - but not right now, pending adoption' : 'Good for beginners' });
    }
    if (dog.pbFlag) rows.push({ icon: '<span class="marker-dot pb">PB</span>', name: 'Potty Break OK - short walk only, no play' });
    if (dog.isPendingAdoption) rows.push({ icon: '<span class="marker-dot pending">Adopted</span>', name: "Someone has started adopting this dog - Beginners can't walk them" });
    return rows;
  }

  function markerBreakdownHtml(dog) {
    const rows = markerBreakdownRows(dog, dog.isHistorical);
    if (!rows.length) return '<p class="small muted">No behavior markers set.</p>';
    return `<ul class="marker-breakdown-list">${rows.map((r) =>
      `<li>${r.icon}<span class="marker-breakdown-text">${esc(r.name)}</span></li>`
    ).join('')}</ul>`;
  }

  // A dog photo that fails to load (dead source URL, or a cache file that
  // never got created) falls back to the app's own pawprint icon instead of
  // the browser's broken-image glyph -- one delegated listener covers every
  // dog-photo/profile-photo image anywhere in the app, present or future,
  // since 'error' doesn't bubble but IS reachable in the capture phase.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.classList.contains('dog-photo') && !img.classList.contains('profile-photo')) return;
    if (img.dataset.fallbackApplied) return; // never loop if the fallback itself 404s
    img.dataset.fallbackApplied = '1';
    img.src = '/icons/icon-192.png';
  }, true);

  // Full-screen, uncropped photo viewer -- opt-in per image via the
  // .photo-lightbox-trigger class (NOT every .dog-photo everywhere; several
  // already have their own tap behavior, like the Available list's
  // tap-to-walk/edit shortcut, and this must never fight with that).
  function showImageLightbox(src, alt) {
    if (!src) return;
    const lightbox = document.getElementById('imageLightbox');
    const img = document.getElementById('imageLightboxImg');
    img.src = src;
    img.alt = alt || '';
    openOverlay(lightbox);
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.photo-lightbox-trigger');
    if (!trigger) return;
    e.stopPropagation();
    showImageLightbox(trigger.src, trigger.alt);
  });
  // Tapping a dog's photo (Scan/confirm screen, adopted entries in Updates)
  // opens their full bio; the big photo at the top of the bio then opens the
  // uncropped full-screen view.
  document.addEventListener('click', async (e) => {
    const trigger = e.target.closest('.photo-bio-trigger');
    if (!trigger || !trigger.dataset.dogId) return;
    e.stopPropagation();
    try {
      const { dog, walks } = await api(`/api/dogs/${trigger.dataset.dogId}?userId=${state.currentUser.id}`);
      showProfileSheet(dog, walks);
    } catch (err) { toast(err.message, 'error'); }
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
    content.innerHTML = '<h3 style="margin-top:0;">🕘 Walk history</h3><p class="muted small center">Loading…</p>';
    openOverlay(popup);
    try {
      const { name, walks } = await api(`/api/dogs/${dogId}/walk-history`);
      const mineCount = walks.filter((w) => w.mine).length;
      const days = new Map();
      for (const w of walks) {
        const key = dateKey(w.startedAt);
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(w);
      }
      const daysHtml = Array.from(days.entries()).map(([key, dayWalks]) => `
        <p class="small walk-history-day">${fmtDayHeading(key)}</p>
        ${dayWalks.map((w) => `
          <div class="walk-history-row${w.mine ? ' mine' : ''}">
            <span class="small"><span title="${activityInfo(w.activity).label}">${activityInfo(w.activity).emoji}</span> ${fmtClock(w.startedAt)} – ${fmtClock(w.endedAt)} · ${fmtDuration(w.durationSeconds)}</span>
            ${w.mine ? '<span class="badge eligible">You</span>' : '<span class="small muted">Another volunteer</span>'}
          </div>`).join('')}`).join('');
      content.innerHTML = `
        <h3 style="margin-top:0;">🕘 ${esc(name)}'s walks</h3>
        ${walks.length
    ? `<p class="small muted">${walks.length} walk${walks.length === 1 ? '' : 's'}${mineCount ? `, ${mineCount} with you` : ''}.</p><div class="walk-history-list">${daysHtml}</div>`
    : `<p class="small muted">No walks recorded for ${esc(name)}.</p>`}
      `;
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">🕘 Walk history</h3><p class="small muted">Couldn't load the walk history: ${esc(err.message)}</p>`;
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

  function showMarkerBreakdownPopup(dog) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = `<h3 style="margin-top:0;">${esc(dog.name)}'s markers</h3>${markerBreakdownHtml(dog)}
      <p class="small" style="margin:10px 0 0;"><a href="#" id="markerGuideLink">See what every sticker means in the Guide</a></p>`;
    document.getElementById('markerGuideLink').addEventListener('click', async (e) => {
      e.preventDefault();
      // Wait for the popup's history entry to actually pop before the Guide
      // pushes its own -- doing both back to back races, and the pending
      // "back" lands on the Guide's entry instead.
      popup.classList.add('hidden');
      if (overlayEntries.delete(popup.id)) await consumeHistoryEntry();
      openGuide('sticker');
    });
    openOverlay(popup);
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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Balloons + confetti floating up for a second when a newly-detected
  // adoption first appears — purely celebratory, no user action needed.
  function playCelebration() {
    const container = document.createElement('div');
    container.className = 'celebrate-overlay';
    const emojis = ['🎈', '🎉', '🎊', '🐕', '🐶', '🐩'];
    for (let i = 0; i < 18; i++) {
      const span = document.createElement('span');
      span.className = 'celebrate-piece';
      span.textContent = emojis[i % emojis.length];
      span.style.left = `${Math.random() * 100}%`;
      span.style.animationDelay = `${Math.random() * 0.5}s`;
      span.style.fontSize = `${1.2 + Math.random() * 1.3}rem`;
      container.appendChild(span);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 2000);
  }

  // Alumni dogs get bonus days toward eligibility on top of their actual
  // time in shelter — show both so it's clear why an "old" dog is eligible.
  // A dog with any return history (automatically tracked, or a staff-set
  // alumni flag) also gets a tappable "returned" icon that opens the full
  // breakdown of their stay(s) -- this app-only icon has no printed
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
        ? `<span title="${dog.daysInShelter} day${dog.daysInShelter === 1 ? '' : 's'} this stay, ${dog.daysInShelter + dog.previousDaysInShelter} total across all stays -- tap 🔄 for the full breakdown">${dog.daysInShelter}d/${dog.daysInShelter + dog.previousDaysInShelter}d</span>`
        : `${dog.daysInShelter}d`;
    const returned = (hasReturnHistory || dog.isAlumni)
      ? ` <button type="button" class="mini-icon-btn returned-icon-btn" data-dog-id="${dog.id}" data-dog-name="${esc(dog.name)}" title="Returned dog - tap to see their stay history" aria-label="${esc(dog.name)}'s stay history">🔄</button>`
      : '';
    return days + returned;
  }

  // Human-readable version of the server's notEligibleReason code, shown on
  // the confirm/scan screen's caution badge.
  function notEligibleReasonText(dog) {
    switch (dog.notEligibleReason) {
      case 'evo_restricted':
        return 'Experienced Volunteers Only - not cleared for your level';
      case 'blue_restricted':
        return 'Has a behavior marker not cleared for your level';
      case 'pb_restricted':
        return 'Potty-break-only dog - not cleared for your level';
      case 'pending_restricted':
        return "Someone has started adopting this dog - not cleared for Beginners";
      case 'stray_hold':
        return 'On stray hold - only walk if marked PB';
      case 'days': {
        const effective = dog.effectiveDaysInShelter != null ? dog.effectiveDaysInShelter : dog.daysInShelter;
        const remaining = dog.minDaysForLevel != null ? dog.minDaysForLevel - effective : null;
        return remaining != null && remaining > 0
          ? `Needs ${remaining} more day${remaining === 1 ? '' : 's'} in shelter for your level`
          : 'Not enough time in shelter yet for your level';
      }
      default:
        return 'Not eligible to walk right now';
    }
  }

  // What a volunteer can do with a dog. All of them are timed and count
  // exactly like a walk; they only look different.
  const ACTIVITIES = {
    walk: { emoji: '🚶', label: 'Walk', noun: 'walk', out: 'Currently being walked by' },
    cuddle: { emoji: '🤗', label: 'Cuddle', noun: 'cuddle', out: 'Currently cuddling with' },
    matchmaking: { emoji: '💞', label: 'Matchmaking', noun: 'matchmaking session', out: 'Currently at matchmaking with' },
    playgroup: { emoji: '🎾', label: 'Play Group', noun: 'play group', out: 'Currently at play group with' }
  };
  const usualActivity = () => (ACTIVITIES[state.currentUser.defaultActivity] ? state.currentUser.defaultActivity : 'walk');
  // "Make this my usual" link shown under an activity picker whenever the
  // picked activity isn't the walker's usual one (same setting as Settings).
  function syncMakeUsualBtn(btn, activity) {
    if (!btn) return;
    const a = activityInfo(activity);
    btn.dataset.activity = activity;
    btn.textContent = `Make ${a.emoji} ${a.label} my usual activity`;
    btn.classList.toggle('hidden', activity === usualActivity());
  }
  function wireMakeUsualBtn(btn) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const activity = btn.dataset.activity;
      btn.disabled = true;
      try {
        const updated = await api(`/api/users/${state.currentUser.id}/settings`, { method: 'PUT', body: JSON.stringify({ defaultActivity: activity }) });
        state.currentUser.defaultActivity = updated.defaultActivity;
        const a = activityInfo(updated.defaultActivity);
        toast(`${a.emoji} ${a.label} is now your usual activity`);
        syncMakeUsualBtn(btn, activity);
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });
  }
  function activityChipsHtml(selected) {
    return Object.entries(ACTIVITIES).map(([key, a]) =>
      `<button type="button" class="btn small-btn filter-chip ${key === selected ? 'active' : ''}" data-activity="${key}">${a.emoji} ${a.label}</button>`).join('');
  }
  const activityInfo = (key) => ACTIVITIES[key] || ACTIVITIES.walk;
  function activityOptionsHtml(selected) {
    return Object.entries(ACTIVITIES).map(([key, a]) =>
      `<option value="${key}" ${key === (selected || 'walk') ? 'selected' : ''}>${a.emoji} ${a.label}</option>`).join('');
  }

  // Shown wherever a dog card appears so it's obvious the dog isn't actually
  // available right now, even though its walk hasn't been recorded yet.
  function currentWalkBadge(dog) {
    if (!dog.currentWalk) return '';
    const a = activityInfo(dog.currentWalk.activity);
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
    // 'ending' counts too -- the walk is still open server-side (no
    // ended_at yet) for the whole notes-and-save screen, right up until
    // Save & Finish actually posts the end time. Only 'active'/'ending'
    // represent a real open walk; every other phase means nothing's running.
    const openPhases = state.walk.phase === 'active' || state.walk.phase === 'ending';
    return openPhases && state.walk.dog && state.walk.walkId ? String(state.walk.dog.id) : null;
  }

  // cannotWalk: this dog isn't cleared for the signed-in volunteer's current
  // level (or is a hard block like being too young), so the combined "Walk /
  // Edit" label would be misleading -- only the edit part actually applies
  // here. Only known for dogs whose full eligibility was already computed
  // (the Available list); other callers omit it and keep the combined label.
  function dogActionButtons(dogId, cannotWalk) {
    const activeId = activeWalkDogId();
    const blocked = activeId && activeId !== String(dogId);
    return `
      <div class="row" style="margin-top:6px;">
        <button class="btn small-btn view-profile-btn" data-id="${dogId}">View Info</button>
        <button class="btn small-btn walk-history-btn" data-dog-id="${dogId}" title="Walk history" aria-label="Walk history" style="flex:0 0 auto;width:auto;">🕘</button>
        <button class="btn small-btn primary walk-edit-btn" data-id="${dogId}" ${blocked ? 'disabled title="Finish or cancel your current walk first"' : ''}>${cannotWalk ? '✎ Edit' : '▶ Walk / Edit'}</button>
      </div>`;
  }

  function wireDogActionButtons(scope) {
    // Tapping the photo is a shortcut straight to Walk/Edit -- the more
    // common action of the two buttons below it. Greyed out (no handler at
    // all) for every dog except the one you're actually out walking right
    // now -- picking a different dog used to silently strand the walk
    // that's still running, with nothing left pointing back at it.
    const activeId = activeWalkDogId();
    (scope || document).querySelectorAll('.dog-photo').forEach((img) => {
      const card = img.closest('[data-id]');
      if (!card) return;
      if (activeId && activeId !== String(card.dataset.id)) {
        img.style.cursor = 'default';
        img.style.opacity = '0.5';
        return;
      }
      img.style.cursor = 'pointer';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        goToConfirmForDog(card.dataset.id);
      });
    });
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
    el.classList.add('hidden');
    if (overlayEntries.delete(el.id)) history.back();
  }
  // Like closeOverlay, but waits for its "back" to actually land before
  // returning -- needed whenever another overlay is about to open right
  // after this one closes; doing both back to back races, and the pending
  // "back" lands on the NEW overlay's history entry instead of this one's.
  async function closeOverlayAwait(el) {
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    if (overlayEntries.delete(el.id)) await consumeHistoryEntry();
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
          <button type="button" id="appDialogOk" class="btn primary">OK</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }
  // Resolves true/false for confirm-style dialogs and the typed string (or
  // null) for prompt-style ones. An alert-style dialog (showCancel:false)
  // resolves true whichever way it's dismissed.
  function appDialog({ title = '', message = '', confirmText = 'OK', cancelText = 'Cancel', showCancel = true, danger = false, input = null }) {
    if (dialogCancel) dialogCancel(); // never stack two
    const el = ensureDialogEl();
    const okBtn = el.querySelector('#appDialogOk');
    const cancelBtn = el.querySelector('#appDialogCancel');
    const inputEl = el.querySelector('#appDialogInput');
    el.querySelector('#appDialogTitle').textContent = title;
    el.querySelector('#appDialogTitle').classList.toggle('hidden', !title);
    el.querySelector('#appDialogMessage').textContent = message;
    okBtn.textContent = confirmText;
    okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    cancelBtn.textContent = cancelText;
    cancelBtn.classList.toggle('hidden', !showCancel);
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
        okBtn.onclick = cancelBtn.onclick = el.onclick = inputEl.onkeydown = null;
        if (alreadyPopped) resolve(value);
        else consumeHistoryEntry().then(() => resolve(value));
      };
      dialogCancel = () => finish(cancelValue, true);
      okBtn.onclick = () => finish(input != null ? inputEl.value : true, false);
      cancelBtn.onclick = () => finish(cancelValue, false);
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

  // A failed load gets a message and a retry button, not a dead end.
  function showLoadError(what, err, retry) {
    appEl.innerHTML = `
      <div class="empty-state">
        <p>Couldn't load ${esc(what)}.</p>
        <p class="small muted">${esc(err && err.message ? err.message : String(err))}</p>
        <button type="button" id="retryLoadBtn" class="btn primary" style="max-width:220px;margin:12px auto 0;">Try again</button>
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
    if (nameEl) nameEl.textContent = user.name;
    // Audit Mode is a per-user permission, not tied to being privileged —
    // most walkers never see this button, keeping their app simple.
    const auditBtn = document.getElementById('auditModeBtn');
    if (auditBtn) auditBtn.classList.toggle('hidden', !user.canAudit);
  }

  // "My Account" is a sheet with its own little pages (Profile, Privacy &
  // Data) rather than one long popup -- showAccountPage() just toggles
  // which page div is visible; nothing is destroyed/rebuilt, so every
  // element inside keeps the one-time listeners wired to it below.
  function showAccountPage(page) {
    document.getElementById('accountPageMenu').classList.toggle('hidden', page !== 'menu');
    document.getElementById('accountPageProfile').classList.toggle('hidden', page !== 'profile');
    document.getElementById('accountPagePrivacy').classList.toggle('hidden', page !== 'privacy');
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
    // Staff accounts are removed from the staff panel (so the coordinators can
    // never lock themselves out by accident) -- that's specific to deleting
    // the sign-in itself, so it's only this one button, not the data-only one.
    document.getElementById('deleteAccountBtn').classList.toggle('hidden', !!state.currentUser.isStaff);
    openSheet(document.getElementById('accountSheet'), 'account');
  }
  document.getElementById('userBtn').addEventListener('click', openAccountSheet);
  document.getElementById('closeAccountSheetBtn').addEventListener('click', () => {
    closeSheet(document.getElementById('accountSheet'));
  });

  // ---------- Danger-zone confirmation (checkboxes + typed DELETE) ----------
  // Shared by "delete my walk data" and "delete my account" -- every
  // checkbox has to be ticked AND the word typed before Confirm enables, so
  // the person has actively acknowledged each specific consequence rather
  // than clicking through a stack of yes/no dialogs.
  let dangerConfirmAction = null;
  function showDangerConfirm({ title, intro, checks, confirmLabel, action }) {
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
  document.getElementById('dangerConfirmCancelBtn').addEventListener('click', () => {
    closeOverlay(document.getElementById('dangerConfirmPopup'));
  });
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
        <p class="small muted">Last updated September 23, 2026</p>

        <h4>In plain language</h4>
        <ul>
          <li>There is no built-in way for anyone - another volunteer, staff, or an admin screen - to look up another member's data. This isn't a setting. It doesn't exist in the app.</li>
          <li>Your sign-in account and your walking-app profile are connected, so the app knows which profile is yours when you sign in and so staff can manage your account in one place. Staff can see your name, your role, and which extra features you have. They cannot see your email (nobody can - see below), and they have no screen that shows your walks. See "How your account and your data are connected" below for the specifics.</li>
          <li>That data will never intentionally be looked at, shared, or used to evaluate, compare, or blame a volunteer. It exists only so the app can show you your own stats and history.</li>
          <li>You can permanently delete your walking-app data yourself, at any time, without asking anyone's permission - see the buttons on this page.</li>
        </ul>

        <h4>What we collect</h4>
        <p>Your name and email address are the only personal information Shelter Walk collects. Your email signs you in; your name is shown next to your walks while they're in progress, unless you turn that off above. We don't collect payment information, addresses, phone numbers, or anything else about you.</p>

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
          <li>To show you your own stats and walk history.</li>
          <li>To show other volunteers which dog is currently out, and with whom, unless you've turned that off.</li>
          <li>To combine everyone's walks into shelter-wide totals, without ever exposing who contributed what.</li>
          <li>To send you a sign-in code by email.</li>
        </ul>
        <p>Nothing here is used to evaluate volunteers, and nothing is sold, shared for advertising, or shown to any third party - there is no advertising in this app.</p>

        <h4>Where your data lives</h4>
        <p>Shelter Walk runs on a server hosted by <strong>DigitalOcean</strong>. Sign-in emails are sent through <strong>Resend</strong>, our email delivery provider - it only ever sees the email address needed to send you a code, never your walk history, notes, or stats. Your name and email are never shared with any other third party, for any reason.</p>

        <h4>Backups</h4>
        <p>The site takes automatic backups every day, kept for 14 days and then permanently deleted. They exist for one reason: recovering the <em>entire</em> site if something goes badly wrong. They are not a tool for looking up or restoring one person's data - restoring one means restoring everyone's data to that point in time, all at once, not pulling one person's data back out on its own.</p>
        <p>Backups are encrypted, sent using encrypted connections, and stored on encrypted systems - one copy on Google's servers and one on the site owner's own private servers, for redundancy. Once a backup passes 14 days old, it's gone completely, everywhere.</p>

        <h4>Your choices</h4>
        <ul>
          <li><strong>Hide your name while walking.</strong> Other volunteers see "a Volunteer" instead of your name on the live "currently out" badge. This never affects anything after a walk ends - that's hidden from everyone, always, regardless of this setting.</li>
          <li><strong>Download your data.</strong> Get a copy of everything Shelter Walk has stored about you, any time.</li>
          <li><strong>Delete your walk data.</strong> Permanently disconnect every walk you've done from your account while keeping your account and sign-in.</li>
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
        "This permanently deletes your account: your name, email, passkeys, experience level, settings, saved filters, and private notes.",
        "The walks you did stay in the shelter's records and totals, but they will no longer be connected to you in any way, not even for the site owner. Tips you shared stay on the dogs' boards, without your name.",
        'The site keeps day-to-day backups for 14 days, but only to roll the whole site back after a major problem - restoring one means restoring everyone\'s data to that point in time, not pulling your data back out on its own. Those backups age out completely after 14 days either way.'
      ],
      checks: [
        'I understand this cannot be undone.',
        'I understand my sign-in, name, email, and all personal settings will be permanently deleted.',
        'I understand any past walks I did will be permanently disconnected from my account, and no one - including the site owner - has a way to look that connection up again afterward.',
        'I understand I will be signed out right away, and will need a brand-new invite to use Shelter Walk again.'
      ],
      confirmLabel: 'Delete my account forever',
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
      title: 'Delete your walk data',
      intro: [
        "This disconnects every walk you've done from your account. Your personal stats and per-dog history reset to zero, and any private notes you wrote are deleted. Shared tips you wrote stay on the dogs' boards, without your name (they never showed it anyway).",
        'Your account, sign-in, name, email, and settings are not affected - you can keep walking dogs normally afterward, starting from a blank history.',
        'The site keeps day-to-day backups for 14 days, but only to roll the whole site back after a major problem - restoring one means restoring everyone\'s data to that point in time, not pulling your data back out on its own. Those backups age out completely after 14 days either way.'
      ],
      checks: [
        'I understand this cannot be undone.',
        'I understand that data connecting my account to a walk will be permanently deleted, and no one - including the site owner - has a way to look that connection up again afterward.',
        'I understand my personal stats and dog history will reset to zero, even though the walks themselves stay in the shelter\'s overall totals.'
      ],
      confirmLabel: 'Delete my walk data',
      action: async () => {
        await api('/api/me/data', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }), timeout: 45000 });
        toast('Your walk data has been deleted.');
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
        <p>Thank you for everything you did for the dogs. Your walks stay in the shelter's records, but they are no longer connected to you.</p>
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
  const TAB_TITLES = { available: 'Dogs to Walk', walk: 'Scan a Dog', stats: 'Stats', updates: 'Updates', audit: 'Audit Mode', guide: 'Guide' };
  let syncingFromHistory = false;

  // settingsSheet/profileSheet are declared further down with `const`, but since
  // these functions are only ever called later (from event handlers), the
  // declarations have already run by call time — safe to reference here.
  function currentSheetName() {
    if (!settingsSheet.classList.contains('hidden')) return 'settings';
    if (!profileSheet.classList.contains('hidden')) return 'profile';
    if (!document.getElementById('accountSheet').classList.contains('hidden')) return 'account';
    return null;
  }

  function pushHistory(overrides) {
    if (syncingFromHistory) return;
    const entry = { tab: state.tab, sheet: currentSheetName(), ...overrides };
    history.pushState(entry, '');
  }

  window.addEventListener('popstate', (event) => {
    syncingFromHistory = true;
    const hs = event.state || { tab: 'available', sheet: null };
    const overlayId = hs.overlay || null;
    // Back pressed while a dialog was up: that's a cancel.
    if (dialogCancel && overlayId !== 'appDialog') dialogCancel();
    document.querySelectorAll('.popup-overlay, .image-lightbox').forEach((el) => {
      if (el.id === overlayId) return;
      el.classList.add('hidden');
      overlayEntries.delete(el.id);
    });
    if (hs.sheet !== 'settings') closeSheetOnly(settingsSheet);
    if (hs.sheet !== 'profile') closeSheetOnly(profileSheet);
    if (hs.sheet !== 'account') closeSheetOnly(document.getElementById('accountSheet'));
    if (hs.tab && hs.tab !== state.tab) {
      if ((state.tab === 'walk' || state.tab === 'audit') && hs.tab !== state.tab) stopQrScanner();
      state.tab = hs.tab;
      tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === hs.tab));
      topbarTitle.textContent = TAB_TITLES[hs.tab];
      render();
    }
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
  async function closeSheetAwait(el) {
    if (el.classList.contains('hidden')) return;
    await consumeHistoryEntry();
  }

  // ---------- Tabs ----------
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.getElementById('auditModeBtn').addEventListener('click', () => switchTab('audit'));

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
    state.tab = tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    topbarTitle.textContent = TAB_TITLES[tab];
    pushHistory();
    render();
    // Re-check for anything new since last time whenever landing anywhere
    // except Updates itself -- that tab zeroes the badge on its own once
    // it's actually rendered (see renderUpdates).
    if (tab !== 'updates') refreshUpdatesBadge();
  }

  function activateWalkTab() {
    if (state.tab === 'walk' || state.tab === 'audit') stopQrScanner();
    state.tab = 'walk';
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === 'walk'));
    topbarTitle.textContent = TAB_TITLES.walk;
    pushHistory();
  }

  // Jumps to the Walk tab's confirm/edit screen for a known dog (from the
  // Available list's "Walk / Edit" button) without ever opening the camera —
  // switchTab() would default an idle walk phase to 'scanning' first.
  //
  // If a walk is already in progress for a DIFFERENT dog, this deliberately
  // refuses to overwrite state.walk with the new dog's confirm screen --
  // doing that used to silently strand the active walk (still running
  // server-side, but with nothing in the UI pointing back at it) with no
  // way back to it short of a full page reload. Instead it just reopens the
  // walk already running.
  function goToConfirmForDog(id) {
    const activeId = activeWalkDogId();
    // Any open walk blocks re-entering the confirm screen, even for the
    // SAME dog -- selectDogById() below re-fetches the dog and resets
    // state.walk.phase to 'confirm', which used to stomp the running
    // active/ending screen for the dog you're already out with, not just
    // for a different one.
    if (activeId) {
      if (activeId !== String(id)) {
        appAlert(`You already have a walk in progress with ${state.walk.dog.name}. Finish or cancel that walk first.`, 'Walk in progress');
      }
      activateWalkTab();
      renderWalk();
      return;
    }
    activateWalkTab();
    selectDogById(id);
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
  const ONBOARDING_STEPS = ['name', 'level', 'activity', 'passkey', 'notifications', 'info', 'thanks'];
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
        <p class="muted small">Let's get you set up. It takes about a minute. First, what's your name? Other volunteers and staff will see it next to your walks.</p>
        <label for="onboardingNameInput" class="small">Name</label>
        <input type="text" id="onboardingNameInput" maxlength="60" autocomplete="name" value="${esc(looksReal ? existing : '')}" />
        <p id="onboardingNameStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingNameNext" class="btn primary" style="margin-top:6px;">Continue</button>`;
      const submit = async () => {
        const name = document.getElementById('onboardingNameInput').value.trim();
        const statusEl = document.getElementById('onboardingNameStatus');
        if (!name) { statusEl.textContent = 'Please enter your name.'; return; }
        const btn = document.getElementById('onboardingNameNext');
        btn.disabled = true;
        try {
          const updated = await api('/api/me', { method: 'PUT', body: JSON.stringify({ name }) });
          state.currentUser.name = updated.name;
          const nameEl = document.getElementById('userBtnName');
          if (nameEl) nameEl.textContent = updated.name;
          runOnboardingStep('level');
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
        <h2>What kind of volunteer are you?</h2>
        <p class="muted small">This decides which dogs the app shows you as ready to walk. Pick the one that fits you today. Not sure? Choose Beginner. You can change it any time in Settings.</p>
        <div id="onboardingLevelList" class="stack"></div>
        <p id="onboardingLevelStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingLevelNext" class="btn primary" ${selected ? '' : 'disabled'}>Continue</button>
        ${backBtn('name')}`;
      wireBack('name');
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
      let selected = usualActivity();
      inner.innerHTML = `
        ${onboardingProgressHtml(step)}
        <h2>What do you usually do with the dogs?</h2>
        <p class="muted small">When you scan a kennel, the start button will offer this first. You can still pick something else for any dog, and change your usual one in Settings.</p>
        <div id="onboardingActivityList" class="marker-row activity-chips">${activityChipsHtml(selected)}</div>
        <p id="onboardingActivityStatus" class="small" style="margin-top:6px;color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingActivityNext" class="btn primary">Continue</button>
        ${backBtn('level')}`;
      wireBack('level');
      const list = document.getElementById('onboardingActivityList');
      list.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-activity]');
        if (!chip) return;
        selected = chip.dataset.activity;
        list.querySelectorAll('[data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
      });
      document.getElementById('onboardingActivityNext').addEventListener('click', async () => {
        const nextBtn = document.getElementById('onboardingActivityNext');
        nextBtn.disabled = true;
        try {
          const updated = await api(`/api/users/${state.currentUser.id}/settings`, {
            method: 'PUT',
            body: JSON.stringify({ defaultActivity: selected })
          });
          state.currentUser.defaultActivity = updated.defaultActivity;
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
          <input type="checkbox" id="onboardingPrefAdopted" />
          <span>Tell me when a dog I've walked is adopted</span>
        </label>
        <label class="small checkbox-row">
          <input type="checkbox" id="onboardingPrefWalkStarted" />
          <span>When I start a walk, remind me which dog and where to return them</span>
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
        btn.disabled = true;
        await saveNotificationPref('adopted_walked_dog', wantsAdopted);
        await saveNotificationPref('walk_started', wantsWalkStarted);
        if ((wantsAdopted || wantsWalkStarted) && !(await ensurePushSubscribed())) {
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
          <li><strong>Book icon (top right):</strong> the <strong>Guide</strong>. What every sticker means, tips for walking, and how the app works.</li>
          <li><strong>Gear icon (top right):</strong> change your experience level, notifications, and light or dark mode.</li>
          <li><strong>Your name (top bar):</strong> change your name, email, and passkeys, or sign out.</li>
          <li><strong>Tap a dog's photo</strong> to see it full size.</li>
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
        <p>Thanks for volunteering and making a dog's day better.</p>
        <p id="onboardingFinishStatus" class="small" style="color:var(--red);min-height:1.2em;"></p>
        <button type="button" id="onboardingFinishBtn" class="btn primary">Let's go</button>`;
      document.getElementById('onboardingFinishBtn').addEventListener('click', async () => {
        const btn = document.getElementById('onboardingFinishBtn');
        btn.disabled = true;
        try {
          await api(`/api/users/${state.currentUser.id}/onboarding-complete`, { method: 'POST' });
        } catch (err) {
          // Not saving this means they'd be walked through setup again next
          // time, so don't pretend it worked.
          document.getElementById('onboardingFinishStatus').textContent = `Couldn't finish setup: ${err.message}`;
          btn.disabled = false;
          return;
        }
        state.currentUser.onboardingCompleted = true;
        localStorage.removeItem(ONBOARDING_STEP_KEY);
        document.getElementById('onboardingPicker').classList.add('hidden');
        await completeInit();
      });
      return;
    }
  }

  // ---------- Settings sheet ----------
  const settingsSheet = document.getElementById('settingsSheet');
  const WALK_ALERT_INPUTS = ['settingsWalkAlert1', 'settingsWalkAlert2', 'settingsWalkAlert3'];
  // The walk-length alerts typed in Settings, as whole minutes (empty boxes
  // skipped), or an error message.
  function readWalkAlerts() {
    const minutes = [];
    for (const inputId of WALK_ALERT_INPUTS) {
      const raw = document.getElementById(inputId).value.trim();
      if (!raw) continue;
      const m = Number(raw);
      if (!Number.isInteger(m) || m < 1 || m > 179) return { error: 'Walk alerts must be whole minutes from 1 to 179.' };
      minutes.push(m);
    }
    return { minutes };
  }
  const defaultActivityPicker = document.getElementById('defaultActivityPicker');
  defaultActivityPicker.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-activity]');
    if (!chip) return;
    defaultActivityPicker.dataset.selected = chip.dataset.activity;
    defaultActivityPicker.querySelectorAll('[data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
  });
  document.getElementById('settingsBtn').addEventListener('click', async () => {
    const levels = await loadExperienceLevels();
    document.getElementById('experienceLevelPicker').innerHTML = levelPickerHtml(levels, state.currentUser.experienceLevel);
    const usual = usualActivity();
    defaultActivityPicker.innerHTML = activityChipsHtml(usual);
    defaultActivityPicker.dataset.selected = usual;
    document.getElementById('experienceLevelPicker').querySelectorAll('.level-pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('experienceLevelPicker').querySelectorAll('.level-pick-btn').forEach((b) => {
          b.classList.toggle('primary', b === btn);
          b.querySelector('.small').classList.toggle('muted', b !== btn);
        });
        document.getElementById('experienceLevelPicker').dataset.selected = btn.dataset.level;
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
      buildEl.textContent = stamp ? `Shelter Walk, updated ${new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
    }
    document.getElementById('refreshStatus').textContent = '';
    document.getElementById('refreshDataSection').classList.toggle('hidden', !(state.currentUser.isStaff || state.currentUser.isPrivileged));
    try {
      const { prefs } = await api(`/api/users/${state.currentUser.id}/notification-prefs`);
      document.getElementById('settingsPrefAdopted').checked = !!prefs.adopted_walked_dog;
      document.getElementById('settingsPrefWalkStarted').checked = !!prefs.walk_started;
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
  // Book icon in the top bar. Already in the Guide? Just go back to its list.
  document.getElementById('guideBtn').addEventListener('click', () => {
    if (state.tab === 'guide') {
      state.guide.sectionId = null;
      state.guide.editing = null;
      state.guide.query = '';
      appEl.scrollTop = 0;
      render();
    } else {
      openGuide();
    }
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const key = document.getElementById('experienceLevelPicker').dataset.selected;
    if (!key) { toast('Pick an experience level first.', 'error'); return; }
    const walkAlerts = readWalkAlerts();
    if (walkAlerts.error) { toast(walkAlerts.error, 'error'); return; }
    const saveBtn = document.getElementById('saveSettingsBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await api(`/api/users/${state.currentUser.id}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ experienceLevel: key, defaultActivity: defaultActivityPicker.dataset.selected || 'walk' })
      });
      state.currentUser.experienceLevel = updated.experienceLevel;
      state.currentUser.defaultActivity = updated.defaultActivity;
      const wantsAdopted = document.getElementById('settingsPrefAdopted').checked;
      const wantsWalkStarted = document.getElementById('settingsPrefWalkStarted').checked;
      await saveNotificationPref('adopted_walked_dog', wantsAdopted, true);
      await saveNotificationPref('walk_started', wantsWalkStarted, true);
      await api(`/api/users/${state.currentUser.id}/walk-alerts`, { method: 'PUT', body: JSON.stringify({ minutes: walkAlerts.minutes }) });
      let pushProblem = false;
      if (wantsAdopted || wantsWalkStarted || walkAlerts.minutes.length) pushProblem = !(await ensurePushSubscribed());
      await saveNotificationPref('show_new_dog', document.getElementById('settingsShowNewDog').checked, true);
      await saveNotificationPref('show_adopted', document.getElementById('settingsShowAdopted').checked, true);
      await saveNotificationPref('show_returned', document.getElementById('settingsShowReturned').checked, true);
      closeSheet(settingsSheet);
      await refreshUpdatesTabVisibility();
      render();
      if (pushProblem) appAlert(`Your settings were saved, but notifications are not working on this device yet. ${pushProblemMessage()}`, 'Saved');
      else toast('Settings saved');
    } catch (err) {
      appAlert(`Your settings were not saved. ${err.message}`, 'Not saved');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  document.getElementById('refreshDataBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('refreshStatus');
    const btn = document.getElementById('refreshDataBtn');
    btn.disabled = true;
    statusEl.textContent = 'Refreshing from pets.wake.gov. This can take a minute.';
    try {
      const result = await api('/api/scrape/run', { method: 'POST', timeout: 180000 });
      statusEl.textContent = result.ok ? `Done. ${result.count} dogs currently listed.` : `Failed: ${result.error}`;
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

  // Tapping the dimmed backdrop closes without saving, same as the X/Cancel
  // button -- for Settings specifically, that means any changes made before
  // tapping outside are simply discarded (only the Save button persists
  // them). Guarded on e.target === the overlay itself so clicks inside the
  // actual panel never bubble into an accidental close.
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
  // Notes written at the end of past walks are listed too (read-only).
  function dogNotesShellHtml() {
    return `<div class="dog-notes"><p class="muted small center">Loading notes…</p></div>`;
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
    const items = [
      ...data.sharedTips.map((t) => ({ kind: 'tip', id: t.id, body: t.body, when: t.createdAt })),
      ...(walks || []).filter((w) => w.notes).map((w) => ({ kind: 'walk', body: w.notes, when: w.started_at }))
    ].sort((a, b) => (a.when < b.when ? 1 : -1));
    const tipRows = items.map((n) => n.kind === 'tip'
      ? `<li class="tip-item" data-tip="${n.id}">
           <span class="tip-bullet">•</span>
           <span class="tip-text">${esc(n.body)}</span>
           <span class="tip-item-actions">
             <button type="button" class="mini-icon-btn" data-act="edit" aria-label="Edit this tip">✎</button>
             <button type="button" class="mini-icon-btn" data-act="erase" aria-label="Delete this tip">✕</button>
           </span>
         </li>`
      : `<li class="tip-item tip-item-walk">
           <span class="tip-bullet">•</span>
           <span class="tip-text">${esc(n.body)} <span class="muted">(from a walk)</span></span>
         </li>`).join('');
    container.innerHTML = `
      <label class="small muted" style="display:block;margin-top:12px;">Tips <span class="badge neutral">Anyone can edit or delete</span></label>
      <ul class="tip-list">
        ${tipRows}
      </ul>
      <div class="tip-add-row">
        <input type="text" class="tip-input" maxlength="1000" placeholder="Add a tip about ${esc(dog.name)}…" />
        <button type="button" class="btn small-btn primary tip-add-btn">Add</button>
      </div>
      <p class="small muted" style="margin:4px 0 0;">Anonymous - can be edited or deleted by anyone.</p>
      <label class="small muted" style="display:block;margin-top:14px;">My private notes <span class="badge neutral">Only you can see this</span></label>
      <ul class="tip-list">
        ${data.privateNote ? `<li class="tip-item" data-private="1">
             <span class="tip-bullet">•</span>
             <span class="tip-text">${esc(data.privateNote.body)}</span>
             <span class="tip-item-actions">
               <button type="button" class="mini-icon-btn" data-act="edit" aria-label="Edit your private note">✎</button>
               <button type="button" class="mini-icon-btn" data-act="erase" aria-label="Delete your private note">✕</button>
             </span>
           </li>` : ''}
      </ul>
      <div class="tip-add-row private-note-add-row"${data.privateNote ? ' style="display:none;"' : ''}>
        <input type="text" class="tip-input private-note-input" maxlength="4000" placeholder="Reminders just for you (what works with ${esc(dog.name)}, where you left off…)" />
        <button type="button" class="btn small-btn primary private-note-add-btn">Add</button>
      </div>`;

    const input = container.querySelector('.tip-add-row:not(.private-note-add-row) .tip-input');
    const addTip = async () => {
      const body = input.value.trim();
      if (!body) { input.focus(); return; }
      try {
        await api(`/api/dogs/${dog.id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
        toast('Tip added');
        reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    container.querySelector('.tip-add-btn').addEventListener('click', addTip);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTip(); } });

    // Edit a tip in place: the bullet becomes a one-line textbox with Save/Cancel.
    container.querySelectorAll('.tip-item[data-tip]').forEach((li) => {
      const id = li.dataset.tip;
      const current = (data.sharedTips.find((t) => String(t.id) === id) || {}).body || '';
      li.querySelector('[data-act="edit"]').addEventListener('click', () => {
        li.classList.add('editing');
        li.innerHTML = `
          <input type="text" class="tip-edit-input" maxlength="1000" value="${esc(current)}" />
          <span class="tip-item-actions">
            <button type="button" class="mini-icon-btn" data-act="save" aria-label="Save">✓</button>
            <button type="button" class="mini-icon-btn" data-act="cancel" aria-label="Cancel">✕</button>
          </span>`;
        const inp = li.querySelector('.tip-edit-input');
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
        const save = async () => {
          const next = inp.value.trim();
          if (!next) { toast('Use the ✕ next to a tip to delete it.', 'error'); return; }
          if (next === current) { reload(); return; }
          try { await api(`/api/dogs/${dog.id}/notes/${id}`, { method: 'PUT', body: JSON.stringify({ body: next }) }); toast('Tip updated'); reload(); }
          catch (err) { toast(err.message, 'error'); }
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); reload(); }
        });
        li.querySelector('[data-act="save"]').addEventListener('click', save);
        li.querySelector('[data-act="cancel"]').addEventListener('click', reload);
      });
      li.querySelector('[data-act="erase"]').addEventListener('click', async () => {
        if (!(await appConfirm('Delete this tip? Every walker will stop seeing it.', { title: 'Delete tip', confirmText: 'Delete', danger: true }))) return;
        try { await api(`/api/dogs/${dog.id}/notes/${id}`, { method: 'DELETE' }); toast('Tip deleted'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });

    // Add: the empty-state input row.
    const savePrivate = async (body) => {
      try {
        await api(`/api/dogs/${dog.id}/private-note`, { method: 'PUT', body: JSON.stringify({ body }) });
        reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    const addBtn = container.querySelector('.private-note-add-btn');
    if (addBtn) {
      const addInput = container.querySelector('.private-note-add-row .private-note-input');
      const doAdd = () => { const body = addInput.value.trim(); if (!body) { addInput.focus(); return; } savePrivate(body); };
      addBtn.addEventListener('click', doAdd);
      addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    }

    // Edit/erase: same in-place pattern as the shared tips.
    const privateLi = container.querySelector('.tip-item[data-private]');
    if (privateLi) {
      const current = data.privateNote ? data.privateNote.body : '';
      privateLi.querySelector('[data-act="edit"]').addEventListener('click', () => {
        privateLi.classList.add('editing');
        privateLi.innerHTML = `
          <input type="text" class="tip-edit-input" maxlength="4000" value="${esc(current)}" />
          <span class="tip-item-actions">
            <button type="button" class="mini-icon-btn" data-act="save" aria-label="Save">✓</button>
            <button type="button" class="mini-icon-btn" data-act="cancel" aria-label="Cancel">✕</button>
          </span>`;
        const inp = privateLi.querySelector('.tip-edit-input');
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
        const save = () => {
          const next = inp.value.trim();
          if (!next) { toast('Use the ✕ next to your note to delete it.', 'error'); return; }
          if (next === current) { reload(); return; }
          savePrivate(next);
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); reload(); }
        });
        privateLi.querySelector('[data-act="save"]').addEventListener('click', save);
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
    const badgesToggle = document.getElementById('profileMarkerBadges');
    const breakdown = document.getElementById('profileMarkerBreakdown');
    if (badgesToggle && breakdown) {
      badgesToggle.addEventListener('click', () => breakdown.classList.toggle('hidden'));
    }
    const statsBtn = document.getElementById('profileStatsBtn');
    if (statsBtn) statsBtn.addEventListener('click', () => showDogStatsPopup(dog.id, dog.name));
    mountDogNotes(profileSheetInner.querySelector('.dog-notes-mount'), dog, walks);
  }

  // Personal history only: how often *this* user has walked the dog.
  function walksTogetherText(dog) {
    const n = dog.myWalkCount || 0;
    if (!n) return 'No walks together recorded';
    return `${n}× walk${n === 1 ? '' : 's'} together · last on ${fmtDate(dog.myLastWalkedAt)}`;
  }

  function renderDogProfile(dog, walks) {
    const tags = (dog.tags || []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(' ');
    const hasMarkers = markerBreakdownRows(dog).length > 0;
    return `
      <button id="closeProfileBtn" class="sheet-close-btn" aria-label="Close">✕</button>
      ${dog.photoUrl ? `<img class="profile-photo photo-lightbox-trigger" src="${esc(dog.photoUrl)}" alt="${esc(dog.name)}" />` : ''}
      <h2>${esc(dog.name)} ${sexIcon(dog.sex)}
        <span id="profileMarkerBadges" class="${hasMarkers ? 'marker-badges-toggle' : ''}">${markerBadges(dog)}</span>
      </h2>
      <div id="profileMarkerBreakdown" class="marker-breakdown hidden">${markerBreakdownHtml(dog)}</div>
      <p class="muted small nowrap" style="margin-top:-6px;">ID ${dog.id}</p>
      ${currentWalkBadge(dog)}
      ${dog.stillListed === false ? `<span class="badge neutral">Adopted/Removed${dog.removedAt ? ' on ' + fmtDate(dog.removedAt) : ''}</span>` : ''}
      <span class="badge neutral">${walksTogetherText(dog)}</span>
      <p class="muted">${esc(dog.breed || 'Unknown breed')} · ${esc(dog.sex || '?')} · ${esc(dog.age || '?')} · ${esc(dog.weight || '?')}</p>
      <p class="small">In shelter since ${fmtDate(dog.dateInShelter)} (${shelterDaysHtml(dog)}) · ${esc(dog.location || '')}</p>
      ${dog.stillListed === false ? '' : `<p class="small">Current kennel spot: <span class="nowrap">🏠 ${esc(dog.kennelLocation || 'Unknown')}</span></p>`}
      <div>${tags}</div>
      ${dog.summary ? `<div class="dog-summary">${sanitizeHtml(dog.summary)}</div>` : ''}
      <p class="small" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <a href="${esc(dog.adoptUrl)}" target="_blank" rel="noopener">View on pets.wake.gov →</a>
        <button type="button" class="link-btn dog-qr-btn" data-dog-id="${dog.id}" data-dog-name="${esc(dog.name)}">▦ Show QR code</button>
      </p>
      <div class="row" style="margin-top:4px;">
        <button type="button" id="profileStatsBtn" class="btn small-btn">📊 Our walks together</button>
        <button type="button" class="btn small-btn walk-history-btn" data-dog-id="${dog.id}">🕘 Walk history</button>
      </div>
      <div class="dog-notes-mount">${dogNotesShellHtml()}</div>
      <p class="small muted">Behavior markers are set on the Scan screen when checking a dog out.</p>
    `;
  }

  // Reuses the same generic info popup as the marker-meaning breakdown --
  // one modal, two different content builders.
  async function showDogStatsPopup(dogId, dogName) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    content.innerHTML = `<h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3><p class="muted small center">Loading…</p>`;
    openOverlay(popup);
    try {
      const stats = await api(`/api/dogs/${dogId}/walk-stats?userId=${state.currentUser.id}`);
      const mine = stats.mine;
      const everyone = stats.everyone;
      const happyLine = mine.count > 0
        ? `<p class="small">You've spent <strong>${fmtDuration(mine.totalSeconds)}</strong> making ${esc(dogName)}'s day better! 🐾</p>`
        : `<p class="small muted">No walks together recorded with ${esc(dogName)}.</p>`;
      content.innerHTML = `
        <h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3>
        <div class="stat-grid">
          <div class="stat-tile"><div class="value">${mine.count}</div><div class="label">Walks together</div></div>
          <div class="stat-tile"><div class="value">${fmtDuration(mine.totalSeconds)}</div><div class="label">Time together</div></div>
        </div>
        ${mine.count ? `
        <p class="small">First walked together ${fmtDate(mine.firstWalkedAt)} · most recently ${fmtDate(mine.lastWalkedAt)}</p>
        <p class="small">Longest walk together: ${fmtDuration(mine.longestSeconds)}</p>` : ''}
        ${happyLine}
        <hr />
        <p class="small muted">Everyone combined has walked ${esc(dogName)} ${everyone.count}× (${fmtDuration(everyone.totalSeconds)} total).</p>
      `;
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">🐾 You &amp; ${esc(dogName)}</h3><p class="small muted">Couldn't load stats: ${esc(err.message)}</p>`;
    }
  }

  // The "returned" icon's popup: this dog's current stay plus any earlier
  // one(s) reconstructed from the shelter's event log (see the server route
  // for why it's capped to the last several months).
  async function showStayHistoryPopup(dogId, dogName) {
    const popup = document.getElementById('markerInfoPopup');
    const content = document.getElementById('markerInfoPopupContent');
    if (!popup || !content) return;
    const title = `🔄 ${esc(dogName)}'s stay history`;
    content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="muted small center">Loading…</p>`;
    openOverlay(popup);
    try {
      const [{ dog }, history] = await Promise.all([
        api(`/api/dogs/${dogId}?userId=${state.currentUser.id}`),
        api(`/api/dogs/${dogId}/stay-history`)
      ]);
      const stayDays = (fromIso, toIso) => Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 86400000));
      const stayLine = (fromIso, toIso, current) => {
        const days = current ? dog.daysInShelter : stayDays(fromIso, toIso);
        const range = current ? `Since ${fmtDate(fromIso)}` : `${fmtDate(fromIso)} - ${fmtDate(toIso)}`;
        return `<li class="tip-item"><span class="tip-bullet">•</span><span class="tip-text">${range} (${days} day${days === 1 ? '' : 's'}${current ? ', current' : ''})</span></li>`;
      };
      const priorStays = history.priorStays.slice().reverse(); // most recent first
      const rows = [
        stayLine(dog.dateInShelter, dog.removedAt, dog.stillListed),
        ...priorStays.map((s) => stayLine(s.arrivedAt, s.leftAt, false))
      ].join('');
      const itemizedDays = history.priorStays.reduce((sum, s) => sum + stayDays(s.arrivedAt, s.leftAt), 0);
      const unaccountedDays = Math.max(0, history.previousDaysInShelter - itemizedDays);
      const totalDays = dog.daysInShelter + history.previousDaysInShelter;
      content.innerHTML = `
        <h3 style="margin-top:0;">${title}</h3>
        <p class="small muted">The ${dog.daysInShelter}d/${totalDays}d on their card is this stay, then every stay combined --
           the list below is most recent first.</p>
        <ul class="tip-list">${rows}</ul>
        ${unaccountedDays > 0 ? `<p class="small muted">Plus ${unaccountedDays} earlier day${unaccountedDays === 1 ? '' : 's'} from before this was tracked.</p>` : ''}
        <p class="small muted">Showing return history from the last ${history.months} months.</p>
      `;
    } catch (err) {
      content.innerHTML = `<h3 style="margin-top:0;">${title}</h3><p class="small muted">Couldn't load stay history: ${esc(err.message)}</p>`;
    }
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.returned-icon-btn');
    if (!trigger) return;
    e.stopPropagation();
    showStayHistoryPopup(trigger.dataset.dogId, trigger.dataset.dogName);
  });

  // ---------- Guide (wiki) ----------
  // Staff-editable reference sections (sticker meanings, tips, how-tos).
  // Reached from Settings and from the marker-meaning popup rather than a
  // bottom tab, so it never crowds the main navigation. Everyone can read;
  // staff / privileged walkers get add, edit, reorder, delete, image upload.
  state.guide = { sections: [], canEdit: false, sectionId: null, editing: null, query: '', hint: null };

  function openGuide(hint) {
    try { localStorage.setItem('sw_guide_notice_dismissed', '1'); } catch (e) { /* ignore */ }
    if (state.tab === 'walk' || state.tab === 'audit') stopQrScanner();
    state.guide.sectionId = null;
    state.guide.editing = null;
    state.guide.query = '';
    state.guide.hint = hint || null;
    state.tab = 'guide';
    tabButtons.forEach((b) => b.classList.remove('active'));
    topbarTitle.textContent = TAB_TITLES.guide;
    pushHistory();
    render();
  }

  function safeUrl(url, allowContact) {
    if (/^\/(?!\/)/.test(url) || /^https?:\/\//i.test(url)) return true;
    return !!allowContact && /^(mailto:|tel:)/i.test(url);
  }

  // Lightweight markdown, escaped FIRST so nothing typed into a section can
  // ever become live HTML. Supports: # / ## / ### headings, paragraphs,
  // - bullets, 1. numbered lists, > callouts, --- rules, **bold**, *italic*,
  // [links](url), and ![images](url). A bullet that starts with an image
  // becomes an image-plus-text row (used for the sticker list).
  function renderMarkdown(src) {
    const inline = (text) => {
      let t = esc(text);
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
        safeUrl(url) ? `<img class="guide-img photo-lightbox-trigger" src="${url}" alt="${alt}" loading="lazy" />` : m);
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
        safeUrl(url, true) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : m);
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
      return t;
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
    appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
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
        <input type="search" id="guideSearch" placeholder="Search the Guide…" value="${esc(g.query)}" autocomplete="off" />
        ${g.canEdit ? `<button type="button" id="guideNew" class="btn primary">＋ New section</button>` : ''}
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
        card.addEventListener('click', () => { g.sectionId = Number(card.dataset.id); appEl.scrollTop = 0; renderGuide(); });
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
          <p class="small muted" style="margin-bottom:0;">Updated ${fmtDate(section.updatedAt)}${section.updatedBy && section.updatedBy !== 'demo' ? ` by ${esc(section.updatedBy)}` : ''}</p>
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
    document.getElementById('guideAll').addEventListener('click', () => { g.sectionId = null; appEl.scrollTop = 0; renderGuide(); });
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
              <input type="text" id="guideIcon" maxlength="4" placeholder="📄" value="${esc(draft.icon)}" style="text-align:center;" />
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
        const res = await fetch('/api/wiki/images', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `Upload failed (${res.status})`);
        const md = `![description](${out.url})`;
        const { selectionStart: a, value } = body;
        body.value = value.slice(0, a) + (a && value[a - 1] !== '\n' ? '\n' : '') + md + '\n' + value.slice(a);
        toast('Picture added. Replace "description" with a short label.');
      } catch (err) { toast(err.message, 'error'); }
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
    if (state.tab === 'available') return renderAvailable();
    if (state.tab === 'walk') return renderWalk();
    if (state.tab === 'stats') return renderStats();
    if (state.tab === 'updates') return renderUpdates();
    if (state.tab === 'audit') return renderAudit();
    if (state.tab === 'guide') return renderGuide();
  }

  // ---------- Available tab ----------
  // Four fixed daily walk windows. The last one is internally 4pm-8pm (to
  // catch a walk that runs a bit long) but always labeled "4-7pm".
  const WALK_SLOTS = [
    { label: '7-10a', from: 7, to: 10 },
    { label: '10-1p', from: 10, to: 13 },
    { label: '1-4p', from: 13, to: 16 },
    { label: '4-7p', from: 16, to: 20 }
  ];
  function slotIndexForIso(iso) {
    const hour = new Date(iso).getHours();
    return WALK_SLOTS.findIndex((s) => hour >= s.from && hour < s.to);
  }

  function currentShiftSlotIndex() {
    return slotIndexForIso(new Date().toISOString());
  }

  async function fetchTodaySlots() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const map = new Map();
    const getEntry = (dogId) => {
      if (!map.has(dogId)) map.set(dogId, { slots: [false, false, false, false], totalSeconds: 0 });
      return map.get(dogId);
    };
    try {
      const data = await api(`/api/walks/for-day?fromUtc=${encodeURIComponent(startOfDay.toISOString())}&toUtc=${encodeURIComponent(endOfDay.toISOString())}&dateKey=${todayKey()}`);
      for (const w of data.walks) {
        const entry = getEntry(w.dog_id);
        entry.totalSeconds += w.duration_seconds || 0;
        const idx = slotIndexForIso(w.started_at);
        if (idx >= 0) entry.slots[idx] = true;
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

  function slotGridHtml(dogId) {
    const entry = (state.todaySlotsByDog || new Map()).get(dogId);
    const slots = entry ? entry.slots : [false, false, false, false];
    const boxes = slots.map((filled, i) => `<span class="slot-box ${filled ? 'filled' : ''}" title="${WALK_SLOTS[i].label}"></span>`).join('');
    const total = entry && entry.totalSeconds
      ? `<span class="small muted" style="margin-left:6px;">${fmtDuration(entry.totalSeconds)} today</span>` : '';
    return `<div class="slot-grid" title="Today's walks: 7-10a · 10-1p · 1-4p · 4-7p">${boxes}${total}</div>`;
  }

  async function renderAvailable() {
    appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
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
  function cycleFilterMode(mode) {
    if (mode === 'only') return 'hide';
    if (mode === 'hide') return 'none';
    return 'only';
  }

  // Blue letters OR together within each mode (a dog needs ANY 'only'
  // letter, and is dropped if it has ANY 'hide' letter) since requiring
  // every selected letter at once would almost never match anything. Every
  // other criterion here only ever has one chip, so it's just its own
  // independent AND'd condition.
  function applyMarkerFilters(dogs) {
    const filters = state.markerFilters;
    const blueValues = BLUE_MARKERS.map((m) => m.value);
    const blueOnly = blueValues.filter((v) => filters[v] === 'only');
    const blueHide = blueValues.filter((v) => filters[v] === 'hide');
    let result = dogs;
    if (blueOnly.length) {
      result = result.filter((d) => (d.blueMarkers || []).some((m) => blueOnly.includes(m)));
    }
    if (blueHide.length) {
      result = result.filter((d) => !(d.blueMarkers || []).some((m) => blueHide.includes(m)));
    }
    // poo/poo_priority are two values of the same underlying field, not two
    // independent flags — ANDing them (the old behavior) could never match
    // anything once both were set to 'only'. OR them like the blue letters.
    const pooTests = { poo: (d) => d.pooStatus === 'poo', poo_priority: (d) => d.pooStatus === 'priority' };
    const pooOnly = Object.keys(pooTests).filter((k) => filters[k] === 'only');
    const pooHide = Object.keys(pooTests).filter((k) => filters[k] === 'hide');
    if (pooOnly.length) result = result.filter((d) => pooOnly.some((k) => pooTests[k](d)));
    if (pooHide.length) result = result.filter((d) => !pooHide.some((k) => pooTests[k](d)));
    // Adopter filters. Male/female are two values of one field, so they OR
    // like the POO chips. Breeds OR within each mode like the blue letters,
    // and a breed also matches dogs with it in their shelter tags (mixes).
    const sexTests = { male: (d) => d.sex === 'Male', female: (d) => d.sex === 'Female' };
    const sexOnly = Object.keys(sexTests).filter((k) => filters[k] === 'only');
    const sexHide = Object.keys(sexTests).filter((k) => filters[k] === 'hide');
    if (sexOnly.length) result = result.filter((d) => sexOnly.some((k) => sexTests[k](d)));
    if (sexHide.length) result = result.filter((d) => !sexHide.some((k) => sexTests[k](d)));
    const breedKeys = Object.keys(filters).filter((k) => k.startsWith('breed:'));
    const breedOnly = breedKeys.filter((k) => filters[k] === 'only').map((k) => k.slice(6));
    const breedHide = breedKeys.filter((k) => filters[k] === 'hide').map((k) => k.slice(6));
    if (breedOnly.length) result = result.filter((d) => breedOnly.some((b) => dogHasBreed(d, b)));
    if (breedHide.length) result = result.filter((d) => !breedHide.some((b) => dogHasBreed(d, b)));
    // Advanced: shelter tags (compatibility, heartworm, stray hold, video)
    // are each their own AND'd criterion; sizes OR within each mode.
    Object.keys(filters).filter((k) => k.startsWith('tag:')).forEach((k) => {
      const tag = k.slice(4);
      if (filters[k] === 'only') result = result.filter((d) => (d.tags || []).includes(tag));
      else if (filters[k] === 'hide') result = result.filter((d) => !(d.tags || []).includes(tag));
    });
    const sizeOnly = SIZE_FILTERS.filter((z) => filters[z.key] === 'only');
    const sizeHide = SIZE_FILTERS.filter((z) => filters[z.key] === 'hide');
    if (sizeOnly.length) result = result.filter((d) => sizeOnly.some((z) => z.test(weightLbs(d))));
    if (sizeHide.length) result = result.filter((d) => !sizeHide.some((z) => z.test(weightLbs(d))));
    if (state.minShelterDays != null) result = result.filter((d) => (d.daysInShelter || 0) >= state.minShelterDays);
    if (state.ageMinYears != null || state.ageMaxYears != null) {
      // "Up to 3 years" includes 3 years and some months. Unknown ages drop out.
      const minMonths = state.ageMinYears != null ? state.ageMinYears * 12 : 0;
      const maxMonths = state.ageMaxYears != null ? (state.ageMaxYears + 1) * 12 : Infinity;
      result = result.filter((d) => d.ageMonths != null && d.ageMonths >= minMonths && d.ageMonths < maxMonths);
    }
    const singleTests = {
      desexed: (d) => d.desexed === 'Yes',
      star: (d) => !!d.starFlag,
      pb: (d) => !!d.pbFlag,
      pendingAdoption: (d) => !!d.isPendingAdoption,
      walkedByMe: (d) => !!d.walkedByMe
    };
    Object.entries(singleTests).forEach(([key, test]) => {
      const mode = filters[key];
      if (mode === 'only') result = result.filter(test);
      else if (mode === 'hide') result = result.filter((d) => !test(d));
    });
    if (state.locationFilter.size) {
      result = result.filter((d) => d.kennelLocation && state.locationFilter.has(d.kennelLocation.trim()[0]?.toUpperCase()));
    }
    if (state.presetMinDaysAtLeast != null) {
      const min = state.presetMinDaysAtLeast;
      result = result.filter((d) => (d.effectiveDaysInShelter != null ? d.effectiveDaysInShelter : d.daysInShelter) >= min);
    }
    return result;
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
  // Advanced filters. Tags come straight from the shelter's listing.
  const TAG_FILTERS = [
    { tag: 'Best in Home without Dogs', label: 'Best without other dogs' },
    { tag: 'Dog Selective', label: 'Dog selective' },
    { tag: 'No small dogs or little critters', label: 'No small dogs / critters' },
    { tag: 'Best in Home without Cats', label: 'Best without cats' },
    { tag: 'Best in Home without Children', label: 'Best without children' },
    { tag: 'Not compatible with Livestock', label: 'Not good with livestock' }
  ];
  const HEALTH_TAG_FILTERS = [
    { tag: 'Heartworm Positive', label: 'Heartworm positive' },
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
  const AVAILABLE_SORTS = {
    shelterTime: { label: 'Days in shelter (most first)', cmp: (a, b) => (b.daysInShelter || 0) - (a.daysInShelter || 0) },
    lastWalked: {
      label: 'Needs a walk (never / longest since)',
      cmp: (a, b) => {
        // A dog currently out counts as "just walked" — no need to walk
        // again right now, so it sorts to the bottom either way.
        const aLast = a.currentWalk ? a.currentWalk.startedAt : a.lastWalkedAt;
        const bLast = b.currentWalk ? b.currentWalk.startedAt : b.lastWalkedAt;
        if (!aLast && !bLast) return (b.daysInShelter || 0) - (a.daysInShelter || 0);
        if (!aLast) return -1;
        if (!bLast) return 1;
        return new Date(aLast) - new Date(bLast);
      }
    },
    alphabetical: { label: 'Name (A-Z)', cmp: (a, b) => a.name.localeCompare(b.name) },
    attention: {
      label: 'Needs attention (fewest walks this week)',
      cmp: (a, b) => (a.recentWalkCount || 0) - (b.recentWalkCount || 0) || (b.daysInShelter || 0) - (a.daysInShelter || 0)
    },
    location: {
      label: 'Location (A → E)',
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
  const BUILT_IN_PRESETS = [
    {
      key: '__beginner',
      name: 'Beginner',
      description: 'For anyone with less than 20 hours',
      filter: {
        markerFilters: { ...allBlueFilterObject('hide'), pb: 'hide' },
        locationFilter: [],
        minDaysAtLeast: 15
      }
    },
    {
      key: '__avoid_beginner',
      name: 'Avoid Beginner Dogs',
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
      minShelterDays: state.minShelterDays
    };
  }

  function clearAllFilters() {
    state.markerFilters = {};
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
        ${BUILT_IN_PRESETS.map((p) => `
          <div class="card compact" style="padding:8px;">
            <div class="row" style="justify-content:space-between;align-items:center;">
              <div>
                <strong class="small">${esc(p.name)}</strong>
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
    const allDogs = state.availableDogsRaw || [];
    if (!allDogs.length) {
      appEl.innerHTML = `<p class="empty-state">No dogs currently listed. Try refreshing shelter data from Settings.</p>`;
      appEl.scrollTop = state.availableScrollTop;
      return;
    }
    const fosterCount = allDogs.filter((d) => d.location === 'In Foster').length;
    let visibleDogs = state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster');
    visibleDogs = applyMarkerFilters(visibleDogs);
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
    if (search) visibleDogs = visibleDogs.filter((d) => d.name.toLowerCase().includes(search));
    // Each sort's cmp is written for its natural "primary" direction (e.g.
    // most-days-first, A-Z) — that's what 'desc' means here, the default;
    // 'asc' just reverses whichever sort is currently selected.
    const baseCmp = AVAILABLE_SORTS[state.availableSort || 'shelterTime'].cmp;
    const dirCmp = state.availableSortDir === 'asc' ? (a, b) => -baseCmp(a, b) : baseCmp;
    visibleDogs = [...visibleDogs].sort(dirCmp);

    // Blue letters (excl. EVO) share one "any" chip: clicking it sets every
    // letter to 'only' at once (or clears them if already all set), a
    // shortcut for "show me anything with a blue sticker" without tapping
    // each letter — EVO stays independent since it has its own meaning.
    const blueLetterValues = BLUE_MARKERS.filter((m) => m.value !== 'blue_evo').map((m) => m.value);
    const blueAnyActive = blueLetterValues.length > 0 && blueLetterValues.every((v) => state.markerFilters[v] === 'only');
    const starChip = `<button type="button" class="marker-shape star filter-chip ${filterChipClass(state.markerFilters.star)}" data-filter-key="star" title="Good for beginners">★</button>`;
    const blueChips = `
      <button type="button" class="marker-shape blue filter-chip ${blueAnyActive ? 'active' : ''}" data-filter-action="blue-any" title="Toggle all blue markers (except EVO)"></button>
      ${BLUE_MARKERS.map((m) => `<button type="button" class="marker-shape blue${m.rect ? ' rect' : ''} filter-chip ${filterChipClass(state.markerFilters[m.value])}" data-filter-key="${m.value}" title="${esc(m.name)}">${esc(m.letter)}</button>`).join('')}`;
    const otherChips = `
      <button type="button" class="marker-shape poo filter-chip ${filterChipClass(state.markerFilters.poo)}" data-filter-key="poo" title="POO dog"></button>
      <button type="button" class="marker-shape poo-priority filter-chip ${filterChipClass(state.markerFilters.poo_priority)}" data-filter-key="poo_priority" title="High priority POO dog">${ASTERISK_SVG}</button>
      <button type="button" class="marker-shape pb filter-chip ${filterChipClass(state.markerFilters.pb)}" data-filter-key="pb" title="Potty Break OK">PB</button>
      <button type="button" class="marker-shape rect pending filter-chip ${filterChipClass(state.markerFilters.pendingAdoption)}" data-filter-key="pendingAdoption" title="Someone has started adopting this dog">Adopted</button>`;
    const textChip = (key, label, title) => `<button type="button" class="btn small-btn filter-chip ${filterChipClass(state.markerFilters[key])}" data-filter-key="${esc(key)}" title="${esc(title || label)}" style="width:auto;flex:0 0 auto;">${label}</button>`;
    const adopterChips = `
      ${textChip('male', '♂ Male')}
      ${textChip('female', '♀ Female')}
      ${textChip('desexed', 'Spayed / neutered', 'Spayed or neutered (hide to see dogs that are not, or unknown)')}`;
    const ageSelect = (id, options, value, anyLabel, fmt) => `
      <select id="${id}" class="small" style="flex:1;">
        <option value="">${anyLabel}</option>
        ${options.map((y) => `<option value="${y}" ${value === y ? 'selected' : ''}>${fmt(y)}</option>`).join('')}
      </select>`;
    const ageRow = `
      <div class="row" style="align-items:center;gap:6px;">
        <label class="small muted" style="flex:0 0 auto;margin:0;">Age:</label>
        ${ageSelect('ageMinSelect', AGE_MIN_OPTIONS, state.ageMinYears, 'Any', (y) => `${y}+ yr${y === 1 ? '' : 's'}`)}
        <span class="muted small" style="flex:0 0 auto;">to</span>
        ${ageSelect('ageMaxSelect', AGE_MAX_OPTIONS, state.ageMaxYears, 'Any', (y) => (y === 0 ? 'Under 1 yr' : `${y} yr${y === 1 ? '' : 's'}`))}
      </div>`;
    const breedChips = breedCounts(state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster'))
      .map((b) => textChip(`breed:${b.name}`, `${esc(b.name)} <span class="chip-count">${b.count}</span>`, b.name)).join('');
    const listedDogs = state.showFoster ? allDogs : allDogs.filter((d) => d.location !== 'In Foster');
    const tagChips = (list) => list.map((t) => {
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
          <p class="small muted" style="margin:6px 0 2px;">Home compatibility (hide these to find dogs without the restriction):</p>
          <div class="marker-row" style="gap:6px;">${tagChips(TAG_FILTERS)}</div>
          <p class="small muted" style="margin:8px 0 2px;">Size (by listed weight):</p>
          <div class="marker-row" style="gap:6px;">${sizeChips}</div>
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
    const locationChips = KENNEL_LETTERS.map((letter) => `
      <button type="button" class="btn small-btn filter-chip ${state.locationFilter.has(letter) ? 'active' : ''}" data-location-key="${letter}" style="width:auto;flex:0 0 44px;">${letter}</button>`).join('');

    // Shown on the collapsed "Filters" toggle so it's obvious something is
    // narrowing the list even while the panel itself is tucked away. Blue
    // letters count as at most 1 "only" + 1 "hide" no matter how many are
    // selected (e.g. the blue-any bulk chip), since they're one conceptual
    // filter, not one per letter.
    const allBlueValues = BLUE_MARKERS.map((m) => m.value);
    const blueOnlyActive = allBlueValues.some((v) => state.markerFilters[v] === 'only') ? 1 : 0;
    const blueHideActive = allBlueValues.some((v) => state.markerFilters[v] === 'hide') ? 1 : 0;
    const otherFilterKeys = ['poo', 'poo_priority', 'star', 'pb', 'pendingAdoption', 'walkedByMe', 'male', 'female', 'desexed'];
    const otherActiveCount = otherFilterKeys.filter((k) => state.markerFilters[k]).length;
    const breedModes = Object.keys(state.markerFilters).filter((k) => k.startsWith('breed:')).map((k) => state.markerFilters[k]);
    const breedActive = (breedModes.includes('only') ? 1 : 0) + (breedModes.includes('hide') ? 1 : 0);
    const ageActive = state.ageMinYears != null || state.ageMaxYears != null ? 1 : 0;
    const tagActive = Object.keys(state.markerFilters).filter((k) => k.startsWith('tag:')).length;
    const sizeModes = SIZE_FILTERS.map((z) => state.markerFilters[z.key]);
    const sizeActive = (sizeModes.includes('only') ? 1 : 0) + (sizeModes.includes('hide') ? 1 : 0);
    const advancedActive = tagActive + sizeActive + (state.minShelterDays != null ? 1 : 0);
    const activeFilterCount = (state.showFoster ? 1 : 0) + (state.needsShiftWalkOnly ? 1 : 0)
      + blueOnlyActive + blueHideActive + otherActiveCount + breedActive + ageActive + advancedActive
      + state.locationFilter.size + (state.presetMinDaysAtLeast != null ? 1 : 0);

    // One-time pointer to the Guide for people who were using the app before
    // it existed (new volunteers are told about it during onboarding).
    let guideSeen = true;
    try { guideSeen = !!localStorage.getItem('sw_guide_notice_dismissed'); } catch (e) { /* storage blocked: skip the notice */ }
    const guideNotice = guideSeen ? '' : `
      <div class="card compact notice-card" id="guideNotice">
        <span class="notice-text">📖 <strong>New:</strong> tap the book icon in the top bar for the Guide. It explains every sticker and has tips for walking.</span>
        <div class="row" style="margin-top:8px;">
          <button type="button" id="guideNoticeOpen" class="btn primary small-btn">Open the Guide</button>
          <button type="button" id="guideNoticeDismiss" class="btn small-btn">Dismiss</button>
        </div>
      </div>`;
    const lastUpdatedLine = guideNotice + (state.lastScrapeAt
      ? `<p class="muted small" style="margin:0 0 6px;">Last updated ${fmtDate(state.lastScrapeAt)} · ${fmtClock(state.lastScrapeAt)}</p>`
      : '');
    const filterRow = `
      <div class="card compact stack" style="gap:6px;margin-bottom:8px;">
        <input type="text" id="availableSearchInput" placeholder="Search by name…" value="${esc(state.availableSearch || '')}" />
        <div class="row" style="align-items:center;gap:6px;">
          <label class="small muted" style="flex:0 0 auto;margin:0;">Sort:</label>
          <select id="availableSortSelect" class="small" style="flex:1;">
            ${Object.entries(AVAILABLE_SORTS).map(([key, s]) => `<option value="${key}" ${state.availableSort === key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
          </select>
          <button type="button" id="availableSortDirBtn" class="btn small-btn" style="flex:0 0 auto;width:auto;" title="${state.availableSortDir === 'asc' ? 'Ascending' : 'Descending'}">${state.availableSortDir === 'asc' ? '▲' : '▼'}</button>
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
          Show ${fosterCount} dog${fosterCount === 1 ? '' : 's'} in foster (can't be walked)
        </label>` : ''}
        <label class="small muted" style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="needsShiftWalkCheck" ${state.needsShiftWalkOnly ? 'checked' : ''} />
          Only dogs still needing a walk this shift
        </label>
        <button type="button" class="btn small-btn filter-chip ${filterChipClass(state.markerFilters.walkedByMe)}" data-filter-key="walkedByMe" style="margin-top:2px;">Dogs I've walked before</button>
        <label class="small muted" style="margin:6px 0 0;">Kennel wing:</label>
        <div class="marker-row" style="gap:6px;">${locationChips}</div>
        <label class="small muted" style="margin:6px 0 0;">Tap once for only, twice to hide, again to clear:</label>
        <div class="marker-row" style="gap:6px;">${adopterChips}</div>
        ${ageRow}
        <details class="breed-filter" data-section="breed" ${breedActive || state.openFilterSections.has('breed') ? 'open' : ''}>
          <summary class="small muted">Breed${breedActive ? ' (filtering)' : ''}</summary>
          <div class="marker-row" style="gap:6px;margin-top:6px;">${breedChips}</div>
        </details>
        <div class="marker-row" style="gap:6px;">${starChip}</div>
        <div class="marker-row" style="gap:6px;">${blueChips}</div>
        <div class="marker-row" style="gap:6px;">${otherChips}</div>
        ${advancedSectionHtml()}
        <button type="button" id="clearFiltersBtn" class="btn small-btn" style="margin-top:8px;">Clear Filters</button>
        `}
        ` : ''}
      </div>`;

    if (!visibleDogs.length) {
      appEl.innerHTML = lastUpdatedLine + filterRow + `<p class="empty-state">No dogs match this filter.</p>`;
      appEl.scrollTop = state.availableScrollTop;
      wireAvailableFilters();
      return;
    }
    const cards = visibleDogs.map((dog) => {
      const badge = dog.tooYoung
        ? `<span class="badge blocked">🚫 Too young</span>`
        : dog.eligible
        ? `<span class="badge eligible">Eligible ✓</span>`
        : `<span class="badge not-eligible">${esc(notEligibleReasonText(dog))}</span>`;
      return `
        <div class="card compact avail-card${(dog.blueMarkers || []).includes('blue_evo') ? ' evo-caution' : ''}" data-id="${dog.id}">
          <div class="dog-card ${dog.checkedOffToday ? 'checked-off' : ''}">
            <img loading="lazy" decoding="async" class="dog-photo small" src="${dog.photoUrl ? esc(dog.photoUrl) : '/icons/icon-192.png'}" alt="" />
            <div class="dog-info">
              <p class="dog-name">${esc(dog.name)} ${markerBadges(dog)}</p>
              <p class="dog-meta">${esc(dog.breed || 'Unknown breed')} · ${shelterDaysHtml(dog)} · Walked ${dog.walkCount}× · <span class="nowrap">🏠 ${esc(dog.kennelLocation || '?')}</span> · <span class="nowrap">ID ${dog.id}</span></p>
              <p class="dog-meta${!dog.recentWalkCount ? ' attention-low' : ''}">${dog.recentWalkCount || 0} walk${dog.recentWalkCount === 1 ? '' : 's'} this week</p>
              ${slotGridHtml(dog.id)}
              ${currentWalkBadge(dog)}
              ${badge}
            </div>
            <label class="checkoff-label" title="Someone else already walked this dog today">
              <input type="checkbox" class="checkoff-check" data-id="${dog.id}" ${dog.checkedOffToday ? 'checked' : ''} />
              <span class="small muted">Out</span>
            </label>
          </div>
          ${dogActionButtons(dog.id, dog.tooYoung || dog.eligible === false)}
        </div>`;
    }).join('');
    appEl.innerHTML = lastUpdatedLine + filterRow + `<div class="stack tight">${cards}</div>`;
    appEl.scrollTop = state.availableScrollTop;
    wireAvailableFilters();
    wireDogActionButtons(appEl);
    appEl.querySelectorAll('.checkoff-check').forEach((cb) => {
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
    const dismissGuideNotice = () => {
      try { localStorage.setItem('sw_guide_notice_dismissed', '1'); } catch (e) { /* ignore */ }
      const n = document.getElementById('guideNotice');
      if (n) n.remove();
    };
    const noticeOpen = document.getElementById('guideNoticeOpen');
    if (noticeOpen) noticeOpen.addEventListener('click', () => { dismissGuideNotice(); openGuide(); });
    const noticeDismiss = document.getElementById('guideNoticeDismiss');
    if (noticeDismiss) noticeDismiss.addEventListener('click', dismissGuideNotice);
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
        const letters = BLUE_MARKERS.filter((m) => m.value !== 'blue_evo').map((m) => m.value);
        const allOnly = letters.every((v) => state.markerFilters[v] === 'only');
        letters.forEach((v) => {
          if (allOnly) delete state.markerFilters[v];
          else state.markerFilters[v] = 'only';
        });
        redrawAvailableList();
      });
    }
    const clearBtn = document.getElementById('clearFiltersBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => clearAllFilters());

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
    api('/api/dogs?all=true').then((data) => data.dogs.forEach((d) => namesById.set(String(d.id), d.name))).catch(() => {});
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
      const matches = allDogs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 8);
      results.innerHTML = matches.length ? matches.map((d) => `
        <div class="card compact dog-card search-result" data-id="${d.id}">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${d.photoUrl ? esc(d.photoUrl) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges(d)}</p>
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
      resultEl.innerHTML = `<p class="muted small center">Loading…</p>`;
      return;
    }
    const dog = state.audit.dog;
    if (!dog) {
      resultEl.innerHTML = `<p class="empty-state">Pick a kennel letter and start scanning, or search for a dog by name.</p>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="card compact">
        <div class="dog-card">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${dog.photoUrl ? esc(dog.photoUrl) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(dog.name)} ${sexIcon(dog.sex)} ${markerBadges(dog)}</p>
            <p class="dog-meta">${esc(dog.breed || '')} · ${shelterDaysHtml(dog)} · <span class="nowrap">🏠 ${esc(dog.kennelLocation || '?')}</span> · ID ${dog.id}</p>
          </div>
        </div>
      </div>
      <div class="card compact">
        <label class="small">Behavior markers (tap to toggle)</label>
        <div class="marker-row">
          <button type="button" class="marker-shape star" data-group="star" title="Good for beginners">★</button>
          ${BLUE_MARKERS.map((m) => `<button type="button" class="marker-shape blue${m.rect ? ' rect' : ''}" data-group="blue" data-value="${m.value}" title="${esc(m.name)}">${esc(m.letter)}</button>`).join('')}
        </div>
        <label class="small" style="display:block;margin-top:14px;">POO status</label>
        <div class="marker-row">
          <button type="button" class="marker-shape poo" data-group="poo" data-value="poo" title="POO dog"></button>
          <button type="button" class="marker-shape poo-priority" data-group="poo" data-value="priority" title="High priority POO dog">${ASTERISK_SVG}</button>
          <button type="button" class="marker-shape pb" data-group="pb" title="Potty Break OK - short walk only">PB</button>
        </div>
        <div class="row" style="margin-top:10px;">
          <button id="auditSaveBtn" class="btn primary">${state.audit.location ? `Save markers &amp; location ${esc(state.audit.location)}` : 'Save markers'}</button>
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
        await api(`/api/dogs/${dog.id}/markers`, { method: 'PUT', body: JSON.stringify(state.audit.pendingMarkers) });
        if (letter) {
          const locRes = await api(`/api/dogs/${dog.id}/location`, { method: 'PUT', body: JSON.stringify({ location: letter }) });
          dog.kennelLocation = locRes.location;
        }
        statusEl.textContent = 'Saved ✓';
      } catch (err) {
        statusEl.textContent = `Failed: ${err.message}`;
      }
    });
  }

  // ---------- Stats tab ----------
  // Always refetches, even when returning to a previously-opened day view —
  // otherwise switching tabs away and back would keep showing stale data.
  // Two views live under the Stats tab: your own numbers, and "Together" --
  // everyone's walks combined, with no names or individual figures anywhere.
  function statsScopeSwitchHtml() {
    return `
      <div class="seg" role="tablist" aria-label="Stats view">
        <button type="button" class="seg-btn ${state.statsScope === 'mine' ? 'on' : ''}" data-scope="mine" role="tab" aria-selected="${state.statsScope === 'mine'}">My stats</button>
        <button type="button" class="seg-btn ${state.statsScope === 'together' ? 'on' : ''}" data-scope="together" role="tab" aria-selected="${state.statsScope === 'together'}">Together</button>
      </div>`;
  }
  function wireStatsScopeSwitch() {
    appEl.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.scope === state.statsScope) return;
      state.statsScope = b.dataset.scope;
      state.togetherDay = null;
      state.statsView = 'summary';
      renderStats();
    }));
  }

  async function renderTogether() {
    const myTab = state.tab;
    let data;
    try {
      data = await api('/api/impact?days=30');
    } catch (err) {
      if (state.tab === myTab) showLoadError('the shared stats', err, renderStats);
      return;
    }
    if (state.tab !== myTab) return;
    const hours = (sec) => {
      const h = sec / 3600;
      return h >= 10 ? String(Math.round(h)) : String(Math.round(h * 10) / 10);
    };
    const tile = (value, label, sub) => `<div class="stat-tile"><div class="value">${value}</div><div class="label">${label}</div>${sub ? `<div class="label sub">${sub}</div>` : ''}</div>`;
    // "Walks" and "dogs" are the same number on most days, so they're one tile;
    // the distinct-dog count only appears when a dog was walked more than once.
    const dogsNote = (walks, dogs) => (dogs && dogs !== walks ? `${dogs} different dog${dogs === 1 ? '' : 's'}` : '');
    const avg = (x) => fmtDuration(x.walks ? x.seconds / x.walks : 0);
    const t = data.today;
    const todayHtml = t
      ? `<div class="stat-grid three">${tile(t.walks, 'Walks today', dogsNote(t.walks, t.dogs))}${tile(hours(t.seconds) + ' h', 'Collective walk time')}${tile(avg(t), 'Average walk')}</div>
         ${t.sessions.length ? `<div class="stat-grid" style="margin-top:10px;">${t.sessions.map((s) => tile(s.walks, `${esc(s.label)} walks`, `avg ${avg(s)}`)).join('')}</div>` : ''}`
      : `<div class="card compact center"><p class="muted" style="margin:0;">Today's combined walks show up here as the day goes on. 🐾</p></div>`;
    const dayRows = data.days.filter((d) => d.dateKey !== (t && t.dateKey)).map((d) => `
      <div class="card compact together-day" data-date="${esc(d.dateKey)}" role="button" tabindex="0">
        <div class="together-day-head">
          <strong>${fmtDayHeading(d.dateKey)}</strong>
          <span class="muted small">${d.walks} walks${d.dogs !== d.walks ? ` (${d.dogs} dogs)` : ''} · ${hours(d.seconds)} h · avg ${avg(d)} · tap for details ›</span>
        </div>
        ${d.sessions.length ? `<div class="together-sessions">${d.sessions.map((s) => `<span class="badge neutral">${esc(s.label)}: ${s.walks} walks</span>`).join(' ')}</div>` : ''}
      </div>`).join('');
    const a = data.allTime;
    appEl.innerHTML = `
      ${statsScopeSwitchHtml()}
      <h2 class="section-heading" style="margin-top:0;">Together today</h2>
      ${todayHtml}
      ${t ? `<button type="button" class="btn together-open" data-date="${esc(t.dateKey)}" style="margin-top:10px;">See today's walks in order ›</button>` : ''}
      ${dayRows ? `<h2 class="section-heading">Recent days</h2><div class="stack tight">${dayRows}</div>` : ''}
      <h2 class="section-heading">Since we started tracking</h2>
      <div class="stat-grid three">${tile(a.walks, 'Walks', dogsNote(a.walks, a.dogs))}${tile(hours(a.seconds) + ' h', 'Collective walk time')}${tile(avg(a), 'Average walk')}</div>
      <p class="small muted center" style="margin-top:14px;">Everyone's walks, combined. No names or individual numbers are shown or stored here, ever. Days and sessions with fewer than ${data.minCell} walks are left out of the lists (they still count in the totals).</p>`;
    wireStatsScopeSwitch();
    appEl.querySelectorAll('[data-date]').forEach((el) => {
      const open = () => { state.togetherDay = el.dataset.date; renderTogetherDay(); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // Everyone's walks for one day, in order: which dog, when, how long. No
  // walker names anywhere; only your own walks are marked (as "You"), and
  // only to you. Notes and auto-stop/edit flags are deliberately not part of
  // this view (see impact.js).
  async function renderTogetherDay() {
    const myTab = state.tab;
    const date = state.togetherDay;
    appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
    let data;
    try {
      data = await api(`/api/impact/day?date=${encodeURIComponent(date)}`);
    } catch (err) {
      if (state.tab !== myTab) return;
      if (err.status === 404) { state.togetherDay = null; toast(err.message, 'error'); return renderStats(); }
      showLoadError("that day's walks", err, renderTogetherDay);
      return;
    }
    if (state.tab !== myTab) return;
    const totalSeconds = data.walks.reduce((sum, w) => sum + (w.durationSeconds || 0), 0);
    const dogs = new Set(data.walks.map((w) => w.dogId)).size;
    const rowsHtml = data.walks.map((w) => `
      <div class="card compact dog-card together-walk" data-dogid="${w.dogId}">
        <div class="together-order">${w.order}</div>
        <img loading="lazy" decoding="async" class="dog-photo small" src="${w.photoUrl ? esc(w.photoUrl) : '/icons/icon-192.png'}" alt="" />
        <div class="dog-info">
          <p class="dog-name">${esc(w.dogName)} ${markerBadges({ blueMarkers: w.blueMarkers ? JSON.parse(w.blueMarkers) : [], pooStatus: w.pooStatus || 'none', starFlag: w.starFlag, pbFlag: w.pbFlag, name: w.dogName })}${w.mine ? ' <span class="badge eligible">You</span>' : ''}</p>
          <p class="dog-meta">${fmtClock(w.startedAt)} – ${fmtClock(w.endedAt)} · ${fmtDuration(w.durationSeconds)}</p>
        </div>
      </div>`).join('');
    appEl.innerHTML = `
      <button id="togetherBack" class="btn back-btn">← Back to Together</button>
      <h2 class="section-heading">${fmtDayHeading(date)}</h2>
      <div class="stat-grid three">
        <div class="stat-tile"><div class="value">${data.walks.length}</div><div class="label">Walks</div>${dogs !== data.walks.length ? `<div class="label sub">${dogs} different dog${dogs === 1 ? '' : 's'}</div>` : ''}</div>
        <div class="stat-tile"><div class="value">${fmtDuration(totalSeconds)}</div><div class="label">Collective walk time</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(data.walks.length ? totalSeconds / data.walks.length : 0)}</div><div class="label">Average walk</div></div>
      </div>
      <h2 class="section-heading">In order</h2>
      <div class="stack tight">${rowsHtml}</div>
      <p class="small muted center" style="margin-top:14px;">Everyone's walks, combined. Names are never shown; only your own walks are marked "You", and only you see that.</p>`;
    document.getElementById('togetherBack').addEventListener('click', () => { state.togetherDay = null; renderStats(); });
    appEl.querySelectorAll('.together-walk').forEach((card) => card.addEventListener('click', async () => {
      try {
        const { dog, walks } = await api(`/api/dogs/${card.dataset.dogid}?userId=${state.currentUser.id}`);
        showProfileSheet(dog, walks);
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  async function renderStats() {
    if (state.statsScope === 'together') {
      if (state.togetherDay) return renderTogetherDay();
      appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
      return renderTogether();
    }
    appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
    const myTab = state.tab;
    let data;
    let walksData;
    try {
      [data, walksData] = await Promise.all([
        api(`/api/stats?userId=${state.currentUser.id}`),
        api(`/api/walks?limit=1000&userId=${state.currentUser.id}`)
      ]);
    } catch (err) {
      if (state.tab === myTab) showLoadError('your stats', err, renderStats);
      return;
    }
    if (state.tab !== myTab) return;
    state.statsDays = groupWalksByDay(walksData.walks);

    if (state.statsView === 'day') {
      return renderStatsDay();
    }

    if (state.statsRange !== 'lifetime') {
      return renderStatsToday(walksData.walks);
    }

    const t = data.totals;
    const heading = statsScopeSwitchHtml() + `<h2 class="section-heading" style="margin-top:0;">Lifetime Stats</h2>`;
    const rangeToggle = `<button type="button" id="statsRangeToggle" class="btn primary" style="margin-bottom:10px;">View today's stats</button>`;
    const tiles = `
      <div class="stat-grid">
        <div class="stat-tile"><div class="value">${t.totalWalks}</div><div class="label">Walks completed</div></div>
        <div class="stat-tile"><div class="value">${t.uniqueDogs}</div><div class="label">Dogs walked</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(t.totalSeconds)}</div><div class="label">Total time walking</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(t.avgSeconds)}</div><div class="label">Avg walk length</div></div>
      </div>`;
    if (!data.perDog.length) {
      appEl.innerHTML = heading + rangeToggle + tiles + `<p class="empty-state">No completed walks yet.</p>`;
      wireStatsRangeToggle();
      return;
    }

    const dayRows = state.statsDays.map((day) => `
      <div class="card dog-card" data-daykey="${esc(day.key)}">
        <div class="dog-info">
          <p class="dog-name">${fmtDayHeading(day.key)}</p>
          <p class="dog-meta">${day.dogCount} dog${day.dogCount === 1 ? '' : 's'} walked · ${day.walkCount} walk${day.walkCount === 1 ? '' : 's'}</p>
          <p class="dog-meta">${fmtClock(day.firstStart)} – ${fmtClock(day.lastEnd)}</p>
        </div>
        <span class="muted">›</span>
      </div>`).join('');

    state.statsPerDogRaw = data.perDog;
    const presentCount = data.perDog.filter((d) => d.stillListed).length;
    const byDogFilterRow = `
      <label class="small muted" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <input type="checkbox" id="statsPresentOnlyCheck" ${state.statsPresentOnly ? 'checked' : ''} />
        Only show dogs still at the shelter (${presentCount} of ${data.perDog.length})
      </label>`;
    const byDogRows = renderByDogRows(data.perDog);

    appEl.innerHTML = heading + rangeToggle + tiles +
      `<h2 class="section-heading">Shelter Visits</h2><div class="stack">${dayRows}</div>` +
      `<h2 class="section-heading">By Dog</h2>${byDogFilterRow}<div class="stack" id="byDogList">${byDogRows}</div>`;

    wireStatsRangeToggle();
    wireByDogList();
    document.getElementById('statsPresentOnlyCheck').addEventListener('change', (e) => {
      state.statsPresentOnly = e.target.checked;
      document.getElementById('byDogList').innerHTML = renderByDogRows(state.statsPerDogRaw);
      wireByDogList();
    });
    appEl.querySelectorAll('[data-daykey]').forEach((card) => {
      card.addEventListener('click', () => {
        state.selectedDateKey = card.dataset.daykey;
        state.selectedShiftIndex = null;
        state.statsView = 'day';
        renderStats();
      });
    });
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

  // One completed walk as an editable card (times, delete, original-times
  // badge). Shared by the Today view and the per-day view so editing works
  // the same from either -- no need to detour through lifetime stats.
  function statsWalkCardHtml(w, prefix) {
    return `
      <div class="card dog-card" data-dogid="${w.dog_id}">
        <img loading="lazy" decoding="async" class="dog-photo" src="${w.photo_url ? esc(w.photo_url) : '/icons/icon-192.png'}" alt="" />
        <div class="dog-info">
          <p class="dog-name">${prefix}<span title="${activityInfo(w.activity).label}">${activityInfo(w.activity).emoji}</span> ${esc(w.dog_name)} ${markerBadges({ blueMarkers: w.blue_markers ? JSON.parse(w.blue_markers) : [], pooStatus: w.poo_status || 'none', starFlag: !!w.star_flag, pbFlag: !!w.pb_flag, name: w.dog_name })} ${w.manual_entry ? '<span class="badge neutral">Manually added</span>' : ''}${w.auto_stopped ? '<span class="badge auto-stopped" title="This walk hit the time limit and was ended automatically. Edit the time if it ran longer.">Auto-stopped</span>' : ''}${!w.manual_entry && w.edited ? '<span class="badge neutral edited-badge" data-id="' + w.id + '" style="cursor:pointer;" title="Tap to see the original scanned times">Edited ✎</span>' : ''}</p>
          <p class="dog-meta walk-times-display" data-id="${w.id}">${fmtClock(w.started_at)} – ${fmtClock(w.ended_at)} · ${fmtDuration(w.duration_seconds)}</p>
          ${w.edited && (w.original_started_at || w.original_ended_at) ? `<p class="small muted original-times-display hidden" data-id="${w.id}">Originally scanned: ${fmtClock(w.original_started_at)} – ${w.original_ended_at ? fmtClock(w.original_ended_at) : '-'}</p>` : ''}
          <div class="edit-times-row hidden" data-id="${w.id}" style="margin:4px 0;">
            <select class="edit-activity" aria-label="Activity">${activityOptionsHtml(w.activity)}</select>
            <label class="small edit-time-line">Start <input type="time" class="edit-start-time" value="${toLocalTimeInput(w.started_at)}" /></label>
            <label class="small edit-time-line">End <input type="time" class="edit-end-time" value="${w.ended_at ? toLocalTimeInput(w.ended_at) : ''}" /></label>
            <button class="btn primary small-btn save-times-btn" data-id="${w.id}" style="margin-top:4px;">Save</button>
          </div>
          <p class="dog-meta nowrap">🏠 ${esc(w.location || '-')}</p>
          <p class="small">${w.notes ? esc(w.notes) : '<span class="muted">No notes</span>'}</p>
          <div class="row" style="margin-top:6px;align-items:center;justify-content:flex-end;">
            <button class="btn small-btn walk-action-btn edit-times-btn" data-id="${w.id}" title="Edit times" aria-label="Edit times">✎</button>
            <button class="btn danger walk-action-btn delete-walk-btn" data-id="${w.id}" data-name="${esc(w.dog_name)}" title="Delete walk" aria-label="Delete walk">🗑</button>
          </div>
        </div>
      </div>`;
  }

  function wireStatsWalkCards(dayKey, refresh) {
    appEl.querySelectorAll('.dog-card[data-dogid]').forEach((card) => {
      const openProfile = async () => {
        try {
          const { dog, walks } = await api(`/api/dogs/${card.dataset.dogid}?userId=${state.currentUser.id}`);
          showProfileSheet(dog, walks);
        } catch (err) { toast(err.message, 'error'); }
      };
      card.querySelector('.dog-photo').addEventListener('click', openProfile);
      card.querySelector('.dog-name').addEventListener('click', openProfile);
    });
    document.querySelectorAll('.delete-walk-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await appConfirm(`Delete this walk with ${btn.dataset.name}? This can't be undone.`, { title: 'Delete walk', confirmText: 'Delete', danger: true }))) return;
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
    document.querySelectorAll('.save-times-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.edit-times-row');
        const startInput = row.querySelector('.edit-start-time');
        const endInput = row.querySelector('.edit-end-time');
        const startTime = startInput.value;
        const endTime = endInput.value;
        const activity = row.querySelector('.edit-activity').value;
        // Untouched times aren't re-sent: the boxes only hold whole minutes,
        // so re-sending them would shift the times and mark the walk edited.
        const timesTouched = startTime !== startInput.defaultValue || endTime !== endInput.defaultValue;
        if (timesTouched) {
          if (!startTime) { appAlert('Start time is required.'); return; }
          if (endTime && endTime <= startTime) { appAlert('The end time has to be after the start time.'); return; }
        }
        try {
          await api(`/api/walks/${btn.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify(timesTouched ? {
              startedAt: localTimeToIso(dayKey, startTime),
              endedAt: endTime ? localTimeToIso(dayKey, endTime) : null,
              activity
            } : { activity })
          });
          await refresh();
        } catch (err) { appAlert(err.message); }
      });
    });
  }

  function addWalkSectionHtml() {
    return `
      <button id="showAddWalkFormBtn" class="btn" style="margin-bottom:10px;">＋ Add a walk that wasn't scanned in</button>
      <div id="addWalkForm" class="card compact hidden" style="margin-bottom:10px;">
        <label class="small">Dog</label>
        <input type="text" id="addWalkDogSearch" placeholder="Start typing a dog's name…" autocomplete="off" />
        <div id="addWalkDogResults" style="max-height:150px;overflow-y:auto;margin-bottom:8px;"></div>
        <p id="addWalkSelectedDog" class="small muted"></p>
        <label class="small" for="addWalkActivity">Activity</label>
        <select id="addWalkActivity">${activityOptionsHtml('walk')}</select>
        <div class="row" style="align-items:center;margin-top:8px;">
          <input type="time" id="addWalkStart" />
          <span class="muted">–</span>
          <input type="time" id="addWalkEnd" />
        </div>
        <label class="small" style="margin-top:8px;">Notes (optional)</label>
        <textarea id="addWalkNotes"></textarea>
        <div class="row" style="margin-top:8px;">
          <button id="saveAddWalkBtn" class="btn primary">Save Walk</button>
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
  // view (limit=1000 easily covers one day), so no extra round-trip.
  function renderStatsToday(allWalks) {
    const todaysWalks = allWalks.filter((w) => w.ended_at && dateKey(w.started_at) === todayKey());
    const uniqueDogs = new Set(todaysWalks.map((w) => w.dog_id)).size;
    const totalSeconds = todaysWalks.reduce((s, w) => s + (w.duration_seconds || 0), 0);
    const avgSeconds = todaysWalks.length ? totalSeconds / todaysWalks.length : 0;
    // This is the tab's default landing view -- make it unmistakable that
    // it's showing today only, not everything, before you even get to the
    // toggle button.
    const heading = statsScopeSwitchHtml() + `<h2 class="section-heading" style="margin-top:0;">Today's Stats</h2>`;
    const rangeToggle = `<button type="button" id="statsRangeToggle" class="btn primary" style="margin-bottom:10px;">View lifetime stats</button>`;
    const tiles = `
      <div class="stat-grid">
        <div class="stat-tile"><div class="value">${todaysWalks.length}</div><div class="label">Walks today</div></div>
        <div class="stat-tile"><div class="value">${uniqueDogs}</div><div class="label">Dogs walked</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(totalSeconds)}</div><div class="label">Total time walking</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(avgSeconds)}</div><div class="label">Avg walk length</div></div>
      </div>`;
    const items = todaysWalks
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .map((w) => statsWalkCardHtml(w, '')).join('');
    appEl.innerHTML = heading + rangeToggle + tiles +
      (todaysWalks.length
        ? `<h2 class="section-heading">Today's Walks</h2><div class="stack">${items}</div>`
        : `<p class="empty-state">No walks yet today.</p>`) +
      `<div style="margin-top:12px;">${addWalkSectionHtml()}</div>`;
    // Same edit / delete / add controls as the per-day view, right here, so
    // fixing a walk from today doesn't mean detouring through lifetime stats.
    wireStatsWalkCards(todayKey(), () => renderStats());
    wireAddWalkSection(todayKey(), () => renderStats());
    wireStatsRangeToggle();
  }

  function renderByDogRows(perDog) {
    const visible = state.statsPresentOnly ? perDog.filter((d) => d.stillListed) : perDog;
    if (!visible.length) return `<p class="empty-state">No dogs match this filter.</p>`;
    return visible.map((d) => {
      const markerDog = {
        blueMarkers: d.blue_markers ? JSON.parse(d.blue_markers) : [],
        pooStatus: d.poo_status || 'none',
        starFlag: !!d.star_flag,
        pbFlag: !!d.pb_flag
      };
      return `
      <div class="card compact" data-id="${d.id}">
        <div class="dog-card">
          <img loading="lazy" decoding="async" class="dog-photo" src="${d.photo_url ? esc(d.photo_url) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges({ ...markerDog, name: d.name })}${d.stillListed ? '' : ` <span class="badge neutral">Adopted/Removed${d.removedAt ? ' ' + fmtDate(d.removedAt) : ''}</span>`}</p>
            <p class="dog-meta">${d.walkCount} walk${d.walkCount === 1 ? '' : 's'} · ${fmtDuration(d.totalSeconds)} total</p>
            <p class="dog-meta">Last walked ${fmtDate(d.lastWalkedAt)}</p>
          </div>
        </div>
        ${dogActionButtons(d.id)}
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
  function eventIcon(kind, detail) {
    if (kind === 'adopted') return '🎉';
    if (kind === 'new_dog') return '🐶';
    // Two different reasons a dog can reappear: actually adopted and then
    // returned (↩️, same as before), or never really left shelter care at
    // all -- pulled for vet work, a hold, a data hiccup -- and is simply
    // back on the floor (🐾, new -- good news, not a medical-alarm icon).
    if (kind === 'returned') return detail === 'adopted_return' ? '↩️' : '🐾';
    return '📣'; // 'removed', or anything future/unrecognized
  }

  function eventDogLike(row) {
    return {
      name: row.dog_name,
      blueMarkers: row.blue_markers ? JSON.parse(row.blue_markers) : [],
      pooStatus: row.poo_status || 'none',
      starFlag: !!row.star_flag,
      pbFlag: !!row.pb_flag
    };
  }

  async function renderUpdates() {
    appEl.innerHTML = `<p class="muted small center">Loading…</p>`;
    const myTab = state.tab;
    let data;
    try {
      data = await api(`/api/updates?userId=${state.currentUser.id}&limit=150`);
    } catch (err) {
      if (state.tab === myTab) showLoadError('updates', err, renderUpdates);
      return;
    }
    if (state.tab !== myTab) return;
    const rows = data.updates || [];
    if (!rows.length) {
      appEl.innerHTML = `<p class="empty-state">No updates yet.</p>`;
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
      return `
      <div class="card compact${r.unread ? ' update-unread' : ''}"${r.dog_id && (r.kind === 'new_dog' || r.kind === 'returned') ? ` data-id="${r.dog_id}"` : ''}>
        <div class="dog-card">
          ${r.dog_id
            // Only the adopted-kind photo gets the lightbox trigger --
            // new_dog/returned photos already have their own tap-to-walk/edit
            // shortcut (wireDogActionButtons, wired via their [data-id]
            // ancestor below) and shouldn't have two competing behaviors.
            ? `<img loading="lazy" decoding="async" class="dog-photo small${r.kind === 'adopted' ? ' photo-bio-trigger' : ''}"${r.kind === 'adopted' ? ` data-dog-id="${r.dog_id}"` : ''} src="${r.photo_url ? esc(r.photo_url) : '/icons/icon-192.png'}" alt="" />`
            : `<div class="dog-photo small" style="display:flex;align-items:center;justify-content:center;font-size:1.3rem;">${eventIcon(r.kind, r.detail)}</div>`}
          <div class="dog-info">
            <p class="dog-name">${r.dog_id ? eventIcon(r.kind, r.detail) + ' ' : ''}${esc(r.title || r.dog_name || 'Update')} ${r.dog_id ? markerBadges(eventDogLike(r), true) : ''}</p>
            ${r.personalHighlight ? '<span class="badge eligible">You walked this dog</span>' : ''}
            <p class="dog-meta">${fmtDate(r.occurred_at)}</p>
          </div>
        </div>
        ${r.dog_id && (r.kind === 'new_dog' || r.kind === 'returned') ? dogActionButtons(r.dog_id) : ''}
        ${r.dog_id && r.kind === 'adopted' ? `
        <div class="row" style="margin-top:6px;">
          <button class="btn small-btn view-profile-btn" data-id="${r.dog_id}">View cached profile</button>
        </div>` : ''}
      </div>`;
    }
    const unreadRows = rows.filter((r) => r.unread);
    const readRows = rows.filter((r) => !r.unread);
    const unreadHtml = unreadRows.map(updateCardHtml).join('');
    const readHtml = readRows.map(updateCardHtml).join('');
    // The "Previous updates" divider only makes sense when there's an
    // actual new/old split to label -- an all-read (or all-unread) list
    // just renders as one plain stack.
    appEl.innerHTML = unreadRows.length && readRows.length
      ? `<div class="stack">${unreadHtml}</div><h2 class="section-heading" style="margin-top:18px;">Previous updates</h2><div class="stack">${readHtml}</div>`
      : `<div class="stack">${unreadHtml}${readHtml}</div>`;
    wireDogActionButtons(appEl);
    // Mark as seen only after actually rendering the list (not just on
    // fetch) -- the rows just shown keep their already-computed `unread`
    // green border for this viewing, and only lose it on the NEXT visit.
    try {
      await api(`/api/users/${state.currentUser.id}/updates-seen`, { method: 'PUT' });
    } catch (err) { /* non-critical; badge will just re-show next refresh */ }
    state.unreadUpdatesCount = 0;
    updateUpdatesBadge();
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

  // If someone has turned off every category the Updates feed can show,
  // there's nothing it will ever display -- the tab itself disappears from
  // the nav bar rather than sitting there as a permanently-empty dead end.
  // Re-checked after every Settings save, so turning any category back on
  // brings it straight back.
  async function refreshUpdatesTabVisibility() {
    const tabBtn = document.querySelector('.tab-btn[data-tab="updates"]');
    if (!tabBtn) return;
    let anyShown = true;
    try {
      const { prefs } = await api(`/api/users/${state.currentUser.id}/notification-prefs`);
      anyShown = prefs.show_new_dog !== false || prefs.show_adopted !== false || prefs.show_returned !== false;
    } catch (err) { /* leave the tab as it was on a failed check */ return; }
    tabBtn.classList.toggle('hidden', !anyShown);
  }


  function toLocalTimeInput(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function localTimeToIso(dateKey, timeStr) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const [hh, mm] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0).toISOString();
  }

  async function refreshStatsDay() {
    const walksData = await api(`/api/walks?limit=1000&userId=${state.currentUser.id}`);
    state.statsDays = groupWalksByDay(walksData.walks);
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
    const dayAvgSeconds = day.walks.length ? dayTotalSeconds / day.walks.length : 0;
    const dayTiles = `
      <div class="stat-grid">
        <div class="stat-tile"><div class="value">${day.walkCount}</div><div class="label">Walks that day</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(dayTotalSeconds)}</div><div class="label">Total time</div></div>
        <div class="stat-tile"><div class="value">${fmtDuration(dayAvgSeconds)}</div><div class="label">Avg walk length</div></div>
        <div class="stat-tile"><div class="value">${day.dogCount}</div><div class="label">Dogs walked</div></div>
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
        <div class="stat-tile shift-drilldown-tile ${state.selectedShiftIndex === i ? 'active' : ''}" data-shift-index="${i}" style="cursor:pointer;">
          <div class="value">${shiftTotals[i].count}</div>
          <div class="label">${esc(s.label)}${shiftTotals[i].count ? ' · ' + fmtDuration(shiftTotals[i].seconds) : ''}</div>
        </div>`).join('')}
      </div>
      ${state.selectedShiftIndex != null ? `
      <p class="small muted" style="margin:6px 0;">Showing only ${esc(WALK_SLOTS[state.selectedShiftIndex].label)} walks - <a href="#" id="clearShiftFilterLink">show all</a></p>` : ''}`;

    const shiftFilteredWalks = state.selectedShiftIndex != null
      ? day.walks.filter((w) => slotIndexForIso(w.started_at) === state.selectedShiftIndex)
      : day.walks;
    const items = shiftFilteredWalks.map((w, i) => statsWalkCardHtml(w, `${i + 1}. `)).join('');

    appEl.innerHTML = `
      <button id="backToStatsBtn" class="btn">← Back to Stats</button>
      <h2 class="section-heading">${fmtDayHeading(day.key)}</h2>
      ${dayTiles}
      <h2 class="section-heading">By Shift</h2>
      ${shiftTiles}
      ${addWalkSectionHtml()}
      <div class="stack">${items}</div>`;

    document.getElementById('backToStatsBtn').addEventListener('click', () => {
      state.statsView = 'summary';
      state.selectedShiftIndex = null;
      renderStats();
    });
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
      const matches = allDogs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 6);
      results.innerHTML = matches.map((d) => `
        <div class="card compact dog-card add-walk-dog-result" data-id="${d.id}" data-name="${esc(d.name)}">
          <img loading="lazy" decoding="async" class="dog-photo small" src="${d.photoUrl ? esc(d.photoUrl) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info"><p class="dog-name">${esc(d.name)} ${markerBadges(d)}</p></div>
        </div>`).join('');
      results.querySelectorAll('.add-walk-dog-result').forEach((row) => {
        row.addEventListener('click', () => {
          addWalkSelectedDogId = row.dataset.id;
          selectedLabel.textContent = `Selected: ${row.dataset.name}`;
          results.innerHTML = '';
          searchInput.value = row.dataset.name;
        });
      });
    });

    document.getElementById('saveAddWalkBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('addWalkStatus');
      const startTime = document.getElementById('addWalkStart').value;
      const endTime = document.getElementById('addWalkEnd').value;
      const notes = document.getElementById('addWalkNotes').value.trim();
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
    btn.innerHTML = inWalk ? `${activityInfo(state.walk.activity).emoji}<span class="tab-label">Walk</span>` : '📷<span class="tab-label">Scan</span>';
  }

  function renderWalk() {
    appEl.classList.remove('caution-stripes', 'age-block', 'pb-only-bg', 'evo-caution-bg');
    updateWalkTabLabel();
    const w = state.walk;
    // The header says what's actually going on: "Scan a Dog" while you're
    // picking one, but not while you're mid-walk (the tab already reads "Walk").
    if (state.tab === 'walk') {
      const label = activityInfo(w.activity).label;
      topbarTitle.textContent = w.phase === 'active' || w.phase === 'ending' ? `${label} in Progress`
        : w.phase === 'summary' ? `${label} Complete` : TAB_TITLES.walk;
    }
    if (w.phase === 'idle') return renderWalkIdle();
    if (w.phase === 'scanning') return renderWalkScanning();
    if (w.phase === 'confirm') return renderWalkConfirm();
    if (w.phase === 'active') return renderWalkActive();
    if (w.phase === 'ending') return renderWalkEnding();
    if (w.phase === 'summary') return renderWalkSummary();
  }

  function renderWalkIdle() {
    appEl.innerHTML = `
      <div class="stack">
        <div class="card center">
          <p>Scan the QR tag on a dog's kennel to check them out for a walk.</p>
          <button id="scanBtn" class="btn primary big">📷 Scan Dog QR Code</button>
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
          <button id="cancelScanBtn" class="btn">Cancel</button>
        </div>
        <div class="card compact">
          <label for="manualSearchInput" class="small">Code broken or missing? Search by name instead</label>
          <input type="text" id="manualSearchInput" placeholder="Start typing a dog's name…" autocomplete="off" />
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
      const matches = allDogs.filter((d) => d.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) {
        results.innerHTML = '<p class="muted small">No matching dogs.</p>';
        return;
      }
      results.innerHTML = matches.map((d) => `
        <div class="card compact dog-card search-result" data-id="${d.id}">
          <img loading="lazy" decoding="async" class="dog-photo" src="${d.photoUrl ? esc(d.photoUrl) : '/icons/icon-192.png'}" alt="" />
          <div class="dog-info">
            <p class="dog-name">${esc(d.name)} ${markerBadges(d)}</p>
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

  function cameraErrorMessage(err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return `
        <p class="center"><strong>Camera access is blocked for this app.</strong></p>
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
        <p class="small muted">You can always search for a dog by name below instead.</p>`;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return `<p class="center">No usable camera was found on this device.</p>`;
    }
    return `<p class="center">Could not access camera: ${esc(name || (err && err.message) || String(err))}</p>`;
  }

  // `readerId`/`errorId` let this be reused outside the Scan tab (e.g. Audit
  // Mode has its own camera container so it doesn't collide with the Scan
  // tab's). `onScanned` defaults to the Scan tab's own handler.
  function startQrScanner(readerId, errorId, onScanned) {
    readerId = readerId || 'qr-reader';
    errorId = errorId || 'scanError';
    onScanned = onScanned || onQrScanned;
    if (typeof Html5Qrcode === 'undefined') {
      document.getElementById(errorId).innerHTML = '<p class="center">Camera library failed to load.</p>';
      return;
    }
    const scanner = new Html5Qrcode(readerId);
    state.qrScanner = scanner;
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 240 },
      (decodedText) => onScanned(decodedText),
      () => {}
    ).catch((err) => {
      const el = document.getElementById(errorId);
      if (el) el.innerHTML = cameraErrorMessage(err);
    });
  }

  function stopQrScanner() {
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
      appAlert('Could not read a dog ID from that code.');
      state.walk.phase = 'idle';
      renderWalk();
      return;
    }
    selectDogById(animalId);
  }

  async function selectDogById(animalId) {
    appEl.innerHTML = `<p class="muted small center">Looking up dog…</p>`;
    try {
      const { dog, walks } = await api(`/api/dogs/${animalId}?userId=${state.currentUser.id}`);
      state.walk.phase = 'confirm';
      state.walk.dog = dog;
      state.walk.allWalks = walks;
      state.walk.pastWalks = walks.filter((w) => w.notes);
      state.walk.pendingMarkers = {
        blueMarkers: [...(dog.blueMarkers || [])],
        pooStatus: dog.pooStatus,
        starFlag: dog.starFlag,
        pbFlag: dog.pbFlag
      };
      renderWalk();
    } catch (err) {
      appEl.innerHTML = `
        <div class="card center">
          <p>${esc(err.message)}</p>
          <button id="backToScanBtn" class="btn primary">Try Again</button>
        </div>`;
      document.getElementById('backToScanBtn').addEventListener('click', () => {
        state.walk.phase = 'idle';
        renderWalk();
      });
    }
  }

  const startActivityLabel = (key) => `${activityInfo(key).emoji} Start ${activityInfo(key).label}`;

  function renderWalkConfirm() {
    const dog = state.walk.dog;
    const eligible = dog.eligible;
    const tooYoung = dog.tooYoung;
    const startActivity = usualActivity();
    const isEvo = (dog.blueMarkers || []).includes('blue_evo');
    // EVO (experienced volunteers only) overrides every other background —
    // it's the one caution that must never be missed, even over the hard
    // puppy block.
    appEl.classList.toggle('evo-caution-bg', isEvo);
    appEl.classList.toggle('age-block', !isEvo && tooYoung);
    appEl.classList.toggle('caution-stripes', !isEvo && !tooYoung && !eligible);
    // PB overrides the days-in-shelter caution (handled server-side via
    // `eligible`), but still needs its own "short walk only" reminder.
    appEl.classList.toggle('pb-only-bg', !isEvo && !tooYoung && dog.pbFlag);
    let eligibilityBadge;
    if (tooYoung) {
      eligibilityBadge = `<span class="badge blocked">🚫 Too young to walk (${esc(dog.age)})</span>`;
    } else if (eligible) {
      eligibilityBadge = `<span class="badge eligible">Eligible to walk ✓</span>`;
    } else {
      eligibilityBadge = `<span class="badge caution">⚠ ${esc(notEligibleReasonText(dog))}</span>`;
    }

    appEl.innerHTML = `
      <div class="stack tight walk-confirm">
        ${tooYoung ? `<div class="card compact hard-block-banner"><strong>🚫 Puppies 6 months or younger can't be walked - no exceptions.</strong></div>` : ''}
        ${!tooYoung && dog.pbFlag ? `<div class="pb-warning-banner">Potty Break Only: short, potty-focused walk only</div>` : ''}
        <div class="card compact" style="position:relative;">
          ${state.currentUser.isPrivileged ? `<button type="button" id="advancedSettingsBtn" class="icon-btn" style="position:absolute;top:8px;right:8px;" aria-label="Advanced settings" title="Advanced settings">
            <svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true">
              <path d="M19.14 12.94a7.14 7.14 0 0 0 .06-.94 7.14 7.14 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.03 7.03 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.14 7.14 0 0 0-.06.94 7.14 7.14 0 0 0 .06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>
            </svg>
          </button>` : ''}
          <div class="dog-card">
            <img loading="lazy" decoding="async" class="dog-photo photo-bio-trigger" data-dog-id="${dog.id}" src="${dog.photoUrl ? esc(dog.photoUrl) : '/icons/icon-192.png'}" alt="" />
            <div class="dog-info">
              <p class="dog-name">${esc(dog.name)} ${markerBadges(dog)}</p>
              <p class="dog-meta">${esc(dog.breed || '')} · ${esc(dog.sex || '')} · ${esc(dog.age || '')} · ID ${dog.id}</p>
              <p class="dog-meta">${shelterDaysHtml(dog)} days in shelter</p>
              ${dog.currentWalk && dog.currentWalk.userId !== state.currentUser.id ? currentWalkBadge(dog) : ''}
              ${eligibilityBadge}
            </div>
          </div>
        </div>
        ${state.currentUser.isPrivileged ? `
        <div id="advancedSettingsPopup" class="popup-overlay hidden">
          <div class="popup-card">
            <h3 style="margin-top:0;">Advanced settings</h3>
            <label class="small" style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" id="alumniCheck" ${dog.isAlumni ? 'checked' : ''} />
              Alumni (returned dog) - add bonus days toward eligibility
            </label>
            <div id="alumniBonusRow" class="${dog.isAlumni ? '' : 'hidden'}" style="margin-top:8px;">
              <label class="small" for="alumniBonusSelect">Bonus days</label>
              <select id="alumniBonusSelect" class="small">
                ${Array.from({ length: 15 }, (_, i) => i + 1).map((n) =>
                  `<option value="${n}" ${dog.alumniBonusDays === n ? 'selected' : ''}>${n}${n === 15 ? '+' : ''}</option>`
                ).join('')}
              </select>
            </div>
            <div class="row" style="margin-top:14px;">
              <button id="saveAlumniBtn" class="btn primary">Save</button>
              <button id="closeAdvancedPopupBtn" class="btn">Cancel</button>
            </div>
            <p id="alumniSaveStatus" class="small muted" style="margin:6px 0 0;"></p>
          </div>
        </div>` : ''}
        <div class="card compact">
          <p class="small" style="margin:0 0 4px;">${walksTogetherText(dog)}</p>
          <div class="dog-notes-mount">${dogNotesShellHtml()}</div>
        </div>
        <div class="card compact">
          <label class="small">Behavior markers (tap to toggle)</label>
          <div class="marker-row">
            <button type="button" class="marker-shape star" data-group="star" title="Good for beginners">★</button>
            ${BLUE_MARKERS.map((m) => `<button type="button" class="marker-shape blue${m.rect ? ' rect' : ''}" data-group="blue" data-value="${m.value}" title="${esc(m.name)}">${esc(m.letter)}</button>`).join('')}
          </div>
          <label class="small" style="display:block;margin-top:14px;">POO status</label>
          <div class="marker-row">
            <button type="button" class="marker-shape poo" data-group="poo" data-value="poo" title="POO dog"></button>
            <button type="button" class="marker-shape poo-priority" data-group="poo" data-value="priority" title="High priority POO dog">${ASTERISK_SVG}</button>
            <button type="button" class="marker-shape pb" data-group="pb" title="Potty Break OK - short walk only, clears the days-in-shelter wait">PB</button>
          </div>
          <label style="display:block;margin-top:14px;">Kennel location</label>
          ${kennelLetterPickerHtml('locationPicker', dog.kennelLocation || '', { disabled: tooYoung })}
          <div id="saveAllRow" class="row hidden" style="margin-top:10px;align-items:center;gap:10px;">
            <button id="saveAllBtn" class="btn">Save Changes</button>
            <span id="saveAllCheckmark" class="save-checkmark hidden" aria-hidden="true">✓</span>
          </div>
          <p id="saveAllStatus" class="small muted" style="margin:6px 0 0;"></p>
        </div>
        ${tooYoung ? `<button id="startWalkBtn" class="btn primary big" disabled>Cannot Walk This Dog</button>` : `
        <div class="row start-row">
          <button id="startWalkBtn" class="btn primary big" data-activity="${startActivity}">${startActivityLabel(startActivity)}</button>
          <button type="button" id="changeActivityBtn" class="btn" aria-expanded="false" aria-controls="activityPickRow">⇄ Change</button>
        </div>
        <div id="activityPickRow" class="marker-row activity-chips hidden">${activityChipsHtml(startActivity)}</div>
        <button type="button" id="makeUsualBtn" class="link-btn hidden"></button>`}
        <button id="backToScanBtn2" class="btn">Scan a different dog</button>
      </div>`;

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
    wireMarkerPicker(state.walk.pendingMarkers, checkDirty);
    mountDogNotes(appEl.querySelector('.dog-notes-mount'), dog, state.walk.allWalks);
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
        statusEl.textContent = 'Saving…';
        try {
          const updated = await api(`/api/dogs/${dog.id}/alumni`, {
            method: 'PUT',
            body: JSON.stringify({ alumni, bonusDays, userId: state.currentUser.id })
          });
          dog.isAlumni = updated.isAlumni;
          dog.alumniBonusDays = updated.alumniBonusDays;
          dog.effectiveDaysInShelter = dog.daysInShelter + (dog.isAlumni ? dog.alumniBonusDays : 0);
          if (updated.eligible != null) dog.eligible = updated.eligible;
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

    async function saveMarkers() {
      return api(`/api/dogs/${dog.id}/markers`, { method: 'PUT', body: JSON.stringify(state.walk.pendingMarkers) });
    }

    async function applyMarkerUpdate(updated) {
      dog.blueMarkers = updated.blueMarkers;
      dog.pooStatus = updated.pooStatus;
      dog.starFlag = updated.starFlag;
      dog.pbFlag = updated.pbFlag;
      // Eligibility can depend on several of these at once, which only the
      // server works out -- re-fetch rather than duplicating that logic
      // here, so this can't drift out of sync with server.js.
      try {
        const fresh = await api(`/api/dogs/${dog.id}?userId=${state.currentUser.id}`);
        dog.eligible = fresh.dog.eligible;
        dog.notEligibleReason = fresh.dog.notEligibleReason;
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
      pickRow.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-activity]');
        if (!chip) return;
        const btn = document.getElementById('startWalkBtn');
        btn.dataset.activity = chip.dataset.activity;
        btn.textContent = startActivityLabel(chip.dataset.activity);
        pickRow.querySelectorAll('[data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
        pickRow.classList.add('hidden');
        changeBtn.setAttribute('aria-expanded', 'false');
        syncMakeUsualBtn(document.getElementById('makeUsualBtn'), chip.dataset.activity);
      });
      wireMakeUsualBtn(document.getElementById('makeUsualBtn'));
    }
    const startBtn = document.getElementById('startWalkBtn');
    startBtn.addEventListener('click', async () => {
      const activity = startBtn.dataset.activity || 'walk';
      // Not a hard block (that's tooYoung, which already disables this
      // button) -- just make sure it's a deliberate choice, since the
      // caution background alone is easy to miss in the moment.
      if (!dog.tooYoung && dog.eligible === false) {
        const proceed = await appConfirm(
          `Based on your current experience level, you're not cleared to walk ${dog.name} right now (${notEligibleReasonText(dog)}). You can change your level any time from Settings (the gear icon, top right).`,
          { title: 'Not cleared for this dog', confirmText: 'Walk anyway', cancelText: 'Cancel', danger: true }
        );
        if (!proceed) return;
      }
      const location = kennelLetterPickerValue('locationPicker');
      startBtn.disabled = true;
      try {
        await saveMarkers();
        const res = await api('/api/walks/start', {
          method: 'POST',
          body: JSON.stringify({ dogId: dog.id, location, userId: state.currentUser.id, activity })
        });
        dog.kennelLocation = res.location;
        state.walk.walkId = res.walkId;
        state.walk.startedAt = res.startedAt;
        state.walk.stopsAt = res.stopsAt;
        state.walk.closesAt = res.closesAt;
        state.walk.autoStopped = false;
        state.walk.activity = activity;
        state.walk.location = res.location || location;
        state.walk.phase = 'active';
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

  // Kennel locations are just the wing letter, picked by tapping it -- the
  // same chips as the Available list's "Kennel wing" filter. Tapping the
  // selected letter again clears it, unless the picker is made with
  // required: true. The current value lives on the picker's data-value.
  const KENNEL_LETTERS = ['A', 'B', 'C', 'D', 'E'];
  function kennelLetterPickerHtml(pickerId, selected, { disabled = false } = {}) {
    const value = KENNEL_LETTERS.includes(selected) ? selected : '';
    return `<div id="${pickerId}" class="marker-row" style="gap:6px;" data-value="${value}">${KENNEL_LETTERS.map((letter) => `
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
  function applyPickerState(pending) {
    const effectiveBlue = withImpliedBlank(pending.blueMarkers);
    document.querySelectorAll('.marker-shape[data-group="blue"]').forEach((btn) => {
      btn.classList.toggle('active', effectiveBlue.includes(btn.dataset.value));
    });
    // POO is a strict single-select — plain and priority are unlinked, at
    // most one of them is ever active.
    document.querySelectorAll('.marker-shape[data-group="poo"]').forEach((btn) => {
      btn.classList.toggle('active', pending.pooStatus === btn.dataset.value);
    });
    const starBtn = document.querySelector('.marker-shape[data-group="star"]');
    if (starBtn) starBtn.classList.toggle('active', pending.starFlag);
    const pbBtn = document.querySelector('.marker-shape[data-group="pb"]');
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
  //   - pb (Potty Break OK): an independent boolean; clears the days-in-
  //     shelter wait for levels allowed PB dogs, since it authorizes a
  //     short walk regardless (see the eligibility rules in server.js).
  function wireMarkerPicker(pending, onChange) {
    applyPickerState(pending);
    document.querySelectorAll('.marker-shape').forEach((btn) => {
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
        applyPickerState(pending);
        if (onChange) onChange();
      });
    });
  }

  let timerInterval = null;
  function renderWalkActive() {
    const w = state.walk;
    appEl.innerHTML = `
      <div class="stack">
        ${w.dog.pbFlag ? `<div class="pb-warning-banner">Potty Break Only: short, potty-focused walk only</div>` : ''}
        <div class="card">
          <div class="timer-display">${fmtClock(w.startedAt)}</div>
          <p class="muted small center" style="margin-top:-8px;">⏰ Check-out time - write this on the kennel</p>
          <p class="walk-dog-name">${esc(w.dog.name)} ${sexIcon(w.dog.sex)} ${markerBadges(w.dog)}</p>
          <p class="muted small center" style="margin-top:-6px;">ID ${w.dog.id}</p>
          <p class="walk-location">Return to: <span class="nowrap">🏠 ${w.location ? esc(w.location) : 'location not recorded'}</span></p>
          <div class="timer-display" id="timerDisplay">00:00</div>
        </div>
        <div class="card compact">
          <label class="small">Doing something else?</label>
          <div id="activityChoice" class="marker-row activity-chips">${activityChipsHtml(w.activity || 'walk')}</div>
          <button type="button" id="makeUsualBtn" class="link-btn hidden"></button>
        </div>
        <div class="card compact autostop-card" id="autoStopCard">
          <span class="small" id="autoStopText"></span>
          <button type="button" id="extendWalkBtn" class="btn small-btn">＋10 min</button>
        </div>
        <div class="card compact">
          <button type="button" id="walkNotesToggle" class="notes-toggle" aria-expanded="false">
            <span>📝 Tips &amp; notes</span><span class="notes-toggle-chevron">▾</span>
          </button>
          <div class="dog-notes-mount hidden"></div>
        </div>
        <button id="viewProfileBtn" class="btn">View Full Profile</button>
        <button id="endWalkBtn" class="btn danger big">End ${activityInfo(w.activity).label}</button>
        <button id="cancelWalkBtn" class="btn">Cancel ${activityInfo(w.activity).label}</button>
      </div>`;
    // Switching activity mid-session keeps the same timer; it just changes
    // what gets recorded.
    const makeUsualBtn = document.getElementById('makeUsualBtn');
    wireMakeUsualBtn(makeUsualBtn);
    syncMakeUsualBtn(makeUsualBtn, w.activity || 'walk');
    document.querySelectorAll('#activityChoice [data-activity]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const activity = chip.dataset.activity;
        if (activity === (w.activity || 'walk')) return;
        try {
          await api(`/api/walks/${w.walkId}`, { method: 'PUT', body: JSON.stringify({ activity }) });
          state.walk.activity = activity;
          const a = activityInfo(activity);
          document.querySelectorAll('#activityChoice [data-activity]').forEach((c) => c.classList.toggle('active', c === chip));
          document.getElementById('endWalkBtn').textContent = `End ${a.label}`;
          document.getElementById('cancelWalkBtn').textContent = `Cancel ${a.label}`;
          topbarTitle.textContent = `${a.label} in Progress`;
          updateWalkTabLabel();
          syncMakeUsualBtn(makeUsualBtn, activity);
          toast(`Switched to ${a.emoji} ${a.label}`);
        } catch (err) { toast(err.message, 'error'); }
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
    document.getElementById('endWalkBtn').addEventListener('click', () => {
      clearInterval(timerInterval);
      // The walk ended now, not when the notes are saved.
      state.walk.endTappedAt = new Date().toISOString();
      state.walk.phase = 'ending';
      renderWalk();
    });
    document.getElementById('cancelWalkBtn').addEventListener('click', async () => {
      if (!(await appConfirm(`Cancel this walk with ${w.dog.name}? It won't be recorded.`, { title: 'Cancel walk', confirmText: 'Cancel walk', cancelText: 'Keep walking', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        clearInterval(timerInterval);
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        appAlert(err.message);
      }
    });

    document.getElementById('extendWalkBtn').addEventListener('click', async () => {
      const btn = document.getElementById('extendWalkBtn');
      btn.disabled = true;
      try {
        const res = await api(`/api/walks/${w.walkId}/extend`, { method: 'POST' });
        state.walk.stopsAt = res.stopsAt;
        toast(`Added ${res.addedMinutes} minutes`);
      } catch (err) {
        toast(err.message, 'error');
        if (err.body && err.body.autoStopped) handleAutoStopped();
      } finally { btn.disabled = false; }
    });

    if (timerInterval) clearInterval(timerInterval);
    const startedMs = new Date(w.startedAt).getTime();
    const stopsMs = () => (state.walk.stopsAt ? new Date(state.walk.stopsAt).getTime() : startedMs + 30 * 60000);
    const tick = () => {
      const el = document.getElementById('timerDisplay');
      if (!el) { clearInterval(timerInterval); return; }
      el.textContent = fmtElapsed((Date.now() - startedMs) / 1000);
      const left = (stopsMs() - Date.now()) / 1000;
      const text = document.getElementById('autoStopText');
      const card = document.getElementById('autoStopCard');
      if (text) text.textContent = `Stops automatically at ${fmtClock(new Date(stopsMs()).toISOString())} (${fmtElapsed(Math.max(0, left))} left)`;
      if (card) card.classList.toggle('warn', left <= 180);
      if (left <= 0) { clearInterval(timerInterval); handleAutoStopped(); }
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  // The time limit was reached. The server has (or is about to) end the walk
  // and flag it; ask it what happened rather than assuming, since the walk
  // may have been extended from another device.
  let handlingAutoStop = false;
  async function handleAutoStopped() {
    if (handlingAutoStop || state.walk.phase !== 'active') return;
    handlingAutoStop = true;
    try {
      const { walk, wrapUp } = await api(`/api/walks/active?userId=${state.currentUser.id}`);
      if (walk && walk.id === state.walk.walkId) {
        state.walk.stopsAt = walk.stopsAt; // still running (extended elsewhere): carry on
        renderWalk();
      } else if (wrapUp && wrapUp.id === state.walk.walkId && state.walk.phase === 'active') {
        // Same end screen as End Walk, asking when it really ended.
        state.walk.wrapUpEndedAt = wrapUp.ended_at;
        state.walk.closesAt = wrapUp.closesAt;
        state.walk.phase = 'ending';
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

  // Ending by hand: the walk ended when End Walk was tapped. If the time
  // limit stopped it instead (wrapUpEndedAt), the same screen asks when it
  // really ended: just now, at the limit, or a picked time -- after the
  // start, not in the future, and within the 3 hour maximum. A changed time
  // shows as Edited, with the time-limit end kept as the original.
  function renderWalkEnding() {
    const w = state.walk;
    const wrapUp = !!w.wrapUpEndedAt;
    const tappedAt = w.endTappedAt || new Date().toISOString();
    const startedMs = new Date(w.startedAt).getTime();
    // Walks end by closing time (7:15pm), so nothing later can be picked.
    const closesMs = w.closesAt ? new Date(w.closesAt).getTime() : Infinity;
    const latestMs = () => Math.min(Date.now(), startedMs + 3 * 3600000, closesMs);
    const stoppedAtClosing = wrapUp && new Date(w.wrapUpEndedAt).getTime() >= closesMs;
    appEl.innerHTML = `
      <div class="stack">
        <div class="card">
          <p class="walk-dog-name">${esc(w.dog.name)}</p>
          ${wrapUp ? `
          <p class="small autostop-note">⏱ ${stoppedAtClosing
    ? `Walks end at ${fmtClock(w.closesAt)}, so this one stopped automatically then.`
    : `This walk reached its time limit and stopped automatically at ${fmtClock(w.wrapUpEndedAt)}.`}</p>
          <label>When did the walk end?</label>
          <div id="endTimeChoice" class="marker-row" style="gap:6px;">
            ${stoppedAtClosing ? '' : '<button type="button" class="btn small-btn filter-chip active" data-end="now" style="width:auto;flex:1 1 0;">Just now</button>'}
            <button type="button" class="btn small-btn filter-chip ${stoppedAtClosing ? 'active' : ''}" data-end="limit" style="width:auto;flex:1 1 0;">At ${fmtClock(w.wrapUpEndedAt)}</button>
            <button type="button" class="btn small-btn filter-chip" data-end="pick" style="width:auto;flex:1 1 0;">Pick a time</button>
          </div>
          <input type="time" id="walkEndTime" class="hidden" value="${toLocalTimeInput(w.wrapUpEndedAt)}" style="margin-top:6px;" />
          <p class="small muted" id="walkEndSummary" style="margin:4px 0 10px;"></p>` : '<p class="center muted">Walk finished. Add any notes before saving.</p>'}
          <label for="walkNotes">Note for other walkers (optional)</label>
          <textarea id="walkNotes" placeholder="e.g. Pulls on leash, loves other dogs, needs a firmer walker"></textarea>
          <p class="small muted" style="margin:2px 0 10px;">Shared with every walker. Your name is not shown.</p>
          <label for="walkPrivateNote">Private note for yourself (optional)</label>
          <textarea id="walkPrivateNote" placeholder="Only you can see this"></textarea>
        </div>
        <button id="saveWalkBtn" class="btn primary big">Save &amp; Finish</button>
        <button id="cancelWalkBtn" class="btn">Cancel ${activityInfo(w.activity).label}</button>
      </div>`;

    // Wrap-up only: the chosen end time as an ISO time, or null to keep the
    // time-limit end. A picked time earlier in the day than the start means
    // the walk ran past midnight.
    let choice = stoppedAtClosing ? 'limit' : 'now';
    const endInput = document.getElementById('walkEndTime');
    const chosenEnd = () => {
      if (choice === 'now') return new Date(latestMs()).toISOString();
      if (choice === 'limit' || !endInput.value || endInput.value === toLocalTimeInput(w.wrapUpEndedAt)) return null;
      let ms = new Date(localTimeToIso(dateKey(w.startedAt), endInput.value)).getTime();
      if (ms <= startedMs) ms += 24 * 3600000;
      return new Date(ms).toISOString();
    };
    let summaryTimer = null;
    if (wrapUp) {
      const updateEndSummary = () => {
        const summary = document.getElementById('walkEndSummary');
        if (!summary) { clearInterval(summaryTimer); return; }
        const secs = (new Date(chosenEnd() || w.wrapUpEndedAt).getTime() - startedMs) / 1000;
        summary.textContent = `Walk time: ${fmtDuration(secs)}`;
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

    document.getElementById('saveWalkBtn').addEventListener('click', async () => {
      const notes = document.getElementById('walkNotes').value.trim();
      const privateNote = document.getElementById('walkPrivateNote').value.trim();
      const endedAt = wrapUp ? chosenEnd() : null;
      if (endedAt && choice === 'pick') {
        const ms = new Date(endedAt).getTime();
        if (ms > Date.now()) { appAlert("The end time can't be in the future."); return; }
        if (ms > startedMs + 3 * 3600000) { appAlert("Walks can't be longer than 3 hours."); return; }
        if (ms > closesMs) { appAlert(`Walks end by ${fmtClock(w.closesAt)}, so the end time can't be later than that.`); return; }
      }
      const body = wrapUp ? { notes, ...(endedAt ? { endedAt } : {}) } : { notes, endTappedAt: tappedAt };
      try {
        let res;
        try {
          res = await api(`/api/walks/${w.walkId}/end`, { method: 'PUT', body: JSON.stringify(body) });
        } catch (err) {
          // Already stopped by the time limit and no longer waiting for an
          // end time (e.g. saved from another device): just attach the notes.
          if (err.status === 409 && err.body && err.body.autoStopped) {
            if (notes) await api(`/api/walks/${w.walkId}`, { method: 'PUT', body: JSON.stringify({ notes }) }).catch(() => {});
            res = { durationSeconds: err.body.durationSeconds };
            state.walk.autoStopped = true;
          } else { throw err; }
        }
        clearInterval(summaryTimer);
        state.walk.durationSeconds = res.durationSeconds;
        if (privateNote) {
          // Never blocks saving the walk itself.
          api(`/api/dogs/${w.dog.id}/private-note`, { method: 'PUT', body: JSON.stringify({ body: privateNote, append: true }) })
            .catch(() => toast("Your private note couldn't be saved.", 'error'));
        }
        // You just walked them yourself — mark today's checkoff automatically
        // so they don't sit in the Available list looking like they still need it.
        try {
          await api('/api/checkoff', { method: 'POST', body: JSON.stringify({ dogId: w.dog.id, dateKey: todayKey() }) });
        } catch (e) { /* non-critical; the walk itself already saved fine */ }
        state.walk.phase = 'summary';
        renderWalk();
      } catch (err) {
        appAlert(err.message);
      }
    });
    document.getElementById('cancelWalkBtn').addEventListener('click', async () => {
      if (!(await appConfirm(`Cancel this walk with ${w.dog.name}? It won't be recorded.`, { title: 'Cancel walk', confirmText: 'Cancel walk', cancelText: 'Keep walking', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        appAlert(err.message);
      }
    });
  }

  function renderWalkSummary() {
    const w = state.walk;
    appEl.innerHTML = `
      <div class="card center">
        <p class="walk-dog-name">Great ${activityInfo(w.activity).noun} with ${esc(w.dog.name)}! ${activityInfo(w.activity).emoji}🎉</p>
        <p class="muted">Started at ${fmtClock(w.startedAt)} · Duration: ${fmtDuration(w.durationSeconds)}</p>
        ${w.autoStopped ? `<p class="small autostop-note">⏱ This walk was stopped automatically after ${fmtDuration(w.durationSeconds)}. If it ran longer, you can fix the time from Stats (tap the pencil on the walk).</p>` : ''}
        <button id="doneBtn" class="btn primary big">📷 Scan Next Dog</button>
        <button id="deleteWalkBtn" class="btn danger">Cancel / Delete This ${activityInfo(w.activity).label}</button>
      </div>`;
    document.getElementById('doneBtn').addEventListener('click', () => {
      state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
      renderWalk();
    });
    document.getElementById('deleteWalkBtn').addEventListener('click', async () => {
      if (!(await appConfirm(`Delete this walk with ${w.dog.name}? This can't be undone.`, { title: 'Delete walk', confirmText: 'Delete', danger: true }))) return;
      try {
        await api(`/api/walks/${w.walkId}`, { method: 'DELETE' });
        state.walk = { phase: 'scanning', dog: null, walkId: null, startedAt: null, location: null };
        renderWalk();
      } catch (err) {
        appAlert(err.message);
      }
    });
  }

  // ---------- Init ----------
  // Runs once a user is known (either restored from localStorage or just
  // picked) — resumes an in-progress walk of THEIRS if any, else honors the
  // /scan shortcut, else renders normally.
  async function completeInit() {
    refreshUpdatesBadge();
    refreshUpdatesTabVisibility();
    try {
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
          activity: walk.activity,
          location: walk.location
        };
        switchTab('walk');
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
          wrapUpEndedAt: wrapUp.ended_at,
          closesAt: wrapUp.closesAt,
          activity: wrapUp.activity,
          location: wrapUp.location
        };
        switchTab('walk');
        return;
      }
    } catch (e) { /* ignore */ }

    if (window.location.pathname === '/scan') {
      state.walk.phase = 'scanning';
      switchTab('walk');
      return;
    }

    render();
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
    // Only re-render read-only list screens, and never underneath an open
    // sheet/popup/dialog or in the middle of a walk.
    const busy = document.querySelector('.popup-overlay:not(.hidden), .sheet:not(.hidden), .image-lightbox:not(.hidden)');
    if (!busy && ['available', 'stats', 'updates'].includes(state.tab)) render();
  });
  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);

  async function init() {
    history.replaceState({ tab: state.tab, sheet: null }, '');
    updateOfflineBanner();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[sw] registration failed:', err.message));
    }

    let me;
    try {
      me = await api('/api/me');
    } catch (err) {
      showLoadError("your account", err, () => window.location.reload());
      return;
    }
    setCurrentUser(me);
    if (await maybeShowOnboarding()) return;
    await completeInit();
  }

  init();
})();
