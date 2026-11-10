// The play group desk (/playgroup): a computer-sized page for play group
// volunteers to type up notes dog by dog, and to look over and export every
// session. Same notes and rules as the phone app (playgroupNotes.js); tagging
// and the date row come from pg-tags.js.
(function () {
  const { esc, toEditable, bodyHtml, fmtDate, today, daysAgo, dateRowHtml, wireDateRow, wireTagPicker, mdToolbarHtml, wireMarkdownTools } = window.PgTags;
  // Keyboard tips only where there's a keyboard-and-mouse (not on a phone or tablet).
  const hasKeyboard = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (hasKeyboard) document.getElementById('dogSearch').placeholder = 'Find a dog  ( / )';

  const state = {
    me: null,
    dogs: [],          // listed dogs that can go to play group (the sidebar list)
    tagDogs: null,     // dogs offered by @ tagging -- also includes delisted foster dogs
    counts: {},        // dogId -> { notes, last, name, ... }
    dogId: null,       // the dog open on the Write tab
    lastDate: null,    // the date last saved with, kept for the next note
    view: 'write'
  };

  async function api(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts });
    } catch (err) {
      throw new Error("Couldn't reach the server. Check the connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(httpErrorMessage(res.status, data));
    return data;
  }
  // Same wording as app.js's httpErrorMessage(): a 4xx's own `error` (written
  // for people), else a plain line -- never "Request failed (500)".
  function httpErrorMessage(status, body) {
    if (status < 500 && body && typeof body.error === 'string' && body.error) return body.error;
    if (status === 404) return "That couldn't be found. It may have been removed.";
    if (status === 401 || status === 403) return "You don't have access to that. Reload the page to sign in again.";
    if (status === 429) return 'Too many tries in a row. Wait a moment and try again.';
    if (status >= 502 && status <= 504) return "The server isn't responding right now. Try again in a minute.";
    return 'Something went wrong on our end. Try again in a moment.';
  }
  // Same as app.js's fmtAge(): the listing's "2 Years" reads "2 years".
  const fmtAge = (age) => String(age || '').replace(/\b(Years?|Months?|Weeks?|Days?)\b/g, (u) => u.toLowerCase());
  let toastTimer = null;
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---------- Dog list ----------
  const canPlay = (d) => ((state.me.species || {})[d.species] || { activities: ['playgroup'] }).activities.includes('playgroup');
  const notPlaygroupReason = (d) => (d.pbFlag ? 'PB only' : d.isPendingAdoption ? 'Pending adoption'
    : (d.tags || []).includes('Best in Home without Dogs') ? 'Best without other dogs' : '');

  // Dogs that can be tagged in a note: every dog that can go to play group,
  // including ones currently in foster -- even once the shelter's own
  // listing drops them, volunteers still write play group notes about a
  // foster dog. Separate from `state.dogs` (the sidebar list, listed dogs
  // only): `all=true` is needed to see delisted foster dogs, and pulling
  // every dog ever seen into the sidebar too would bury it in dogs long gone.
  async function taggableDogs() {
    if (state.tagDogs) return state.tagDogs;
    try {
      const { dogs } = await api('/api/dogs?all=true');
      state.tagDogs = dogs.filter((d) => canPlay(d) && (d.stillListed || d.location === 'In Foster'));
    } catch (e) { state.tagDogs = state.dogs; }
    return state.tagDogs;
  }

  // Listed dogs, plus any dog with notes who has since left the shelter.
  function allDogs() {
    const byId = new Map(state.dogs.map((d) => [String(d.id), d]));
    for (const [id, c] of Object.entries(state.counts)) {
      if (!byId.has(id)) byId.set(id, { id: Number(id), name: c.name, kennelLocation: c.kennelLocation, gone: !c.stillListed, adopted: !!c.adopted });
    }
    return [...byId.values()];
  }

  function renderDogList() {
    const q = document.getElementById('dogSearch').value.trim().toLowerCase();
    const onlyNotes = document.getElementById('onlyWithNotes').checked;
    const sort = document.getElementById('dogSort').value;
    const n = (d) => (state.counts[d.id] || {}).notes || 0;
    let list = allDogs().filter((d) => (!q || [d.name, ...(d.previousNames || []), String(d.id)].some((v) => String(v).toLowerCase().includes(q)))
      && (!onlyNotes || n(d) > 0));
    list.sort((a, b) => {
      if (sort === 'kennel') return String(a.kennelLocation || '~').localeCompare(String(b.kennelLocation || '~')) || a.name.localeCompare(b.name);
      if (sort === 'latest') return String((state.counts[b.id] || {}).last || '').localeCompare(String((state.counts[a.id] || {}).last || '')) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    const el = document.getElementById('dogList');
    el.innerHTML = list.length ? list.map((d) => `
      <li><button type="button" class="dog-row${String(d.id) === String(state.dogId) ? ' active' : ''}" data-dog="${d.id}" role="option" aria-selected="${String(d.id) === String(state.dogId)}">
        <span class="dog-row-name">${esc(d.name)}${d.gone ? ` <span class="badge">${d.adopted ? 'Adopted' : 'Left shelter'}</span>` : ''}</span>
        <span class="dog-row-meta">${d.kennelLocation ? `🏠 ${esc(d.kennelLocation)}` : ''}</span>
        <span class="dog-row-count${n(d) ? '' : ' none'}">${n(d) || ''}</span>
      </button></li>`).join('') : '<li class="muted small" style="padding:10px;">No dogs match.</li>';
  }

  // Back to the list. On a narrow screen the list and the open dog take
  // turns filling the screen (.has-dog); on a wide one this just clears it.
  const EMPTY_PANE = document.getElementById('dogPane').innerHTML;
  function closeDog() {
    state.dogId = null;
    const url = new URL(location.href);
    url.searchParams.delete('dog');
    history.replaceState(null, '', url);
    document.getElementById('writeView').classList.remove('has-dog');
    document.getElementById('dogPane').innerHTML = EMPTY_PANE;
    renderDogList();
  }

  // ---------- One dog: notes and the editor ----------
  async function openDog(id, { focus = true } = {}) {
    state.dogId = String(id);
    const url = new URL(location.href);
    url.searchParams.set('dog', state.dogId);
    history.replaceState(null, '', url);
    document.getElementById('writeView').classList.add('has-dog');
    renderDogList();
    const pane = document.getElementById('dogPane');
    pane.innerHTML = '<p class="muted">Loading…</p>';
    let data;
    try { data = await api(`/api/dogs/${id}/playgroup-notes`); } catch (err) { pane.innerHTML = `<p class="muted">Couldn't load this dog's notes. ${esc(err.message)}</p>`; return; }
    if (state.dogId !== String(id)) return; // picked another dog meanwhile
    renderDog(data, focus);
  }

  function editorHtml({ text = '', date, signed = false, showSign = true, saveLabel = 'Save note', cancel = false } = {}) {
    const placeholder = 'How did play group go? Type @ to tag another dog, or just their name. Paste in earlier notes too.';
    return `<div class="desk-editor">
      ${dateRowHtml(date || state.lastDate || today())}
      ${mdToolbarHtml()}
      <div class="pg-text-wrap">
        <div class="pg-text" data-placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">${esc(text)}</div>
        <div class="pg-suggest hidden" role="listbox" aria-label="Dogs to tag"></div>
      </div>
      <div class="pg-preview"></div>
      <div class="desk-editor-foot">
        ${showSign ? `<label class="small"><input type="checkbox" class="pg-signed"${signed ? ' checked' : ''} /> Sign with my name <span class="muted">(otherwise anonymous)</span></label>` : '<span></span>'}
        ${hasKeyboard ? '<span class="muted small kbd-tip">Ctrl+Enter to save</span>' : ''}
        ${cancel ? '<button type="button" class="btn" data-act="cancel">Cancel</button>' : ''}
        <button type="button" class="btn primary" data-act="save">${saveLabel}</button>
      </div>
    </div>`;
  }

  function wireEditor(root, { picks, ownId, onSave, onCancel }) {
    const ta = root.querySelector('.pg-text');
    const tags = wireTagPicker(ta, root.querySelector('.pg-suggest'), { getDogs: taggableDogs, picks, ownId });
    window.PgTags.wireAutoTagger(ta, { getDogs: taggableDogs, ownId, picks });
    wireDateRow(root);
    wireMarkdownTools(root, ta);
    const saveBtn = root.querySelector('[data-act="save"]');
    const save = async () => {
      const body = tags.body();
      if (!body) { ta.focus(); return; }
      const sign = root.querySelector('.pg-signed');
      const v = { body, noteDate: root.querySelector('.pg-date').value };
      if (sign) v.signed = sign.checked;
      saveBtn.disabled = true;
      try { await onSave(v); } catch (err) { toast(err.message, 'error'); saveBtn.disabled = false; }
    };
    saveBtn.addEventListener('click', save);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
    const cancel = root.querySelector('[data-act="cancel"]');
    if (cancel) cancel.addEventListener('click', onCancel);
    return ta;
  }

  function renderDog(data, focus) {
    const dogId = state.dogId;
    const listed = state.dogs.find((d) => String(d.id) === dogId);
    const info = data.dogs[dogId] || { name: 'This dog' };
    const why = listed ? notPlaygroupReason(listed) : '';
    // A mention under another dog's notes shows a short preview, not the
    // whole thing -- a dog tagged often would otherwise turn this list into
    // a wall of other dogs' full entries. "Read more" swaps in the full,
    // already-rendered note; nothing is re-fetched.
    const entryBodyHtml = (n, fromDog) => {
      if (!fromDog) return `<div class="note-body">${bodyHtml(n.body, data.dogs)}</div>`;
      const snippet = window.PgTags.bodySnippet(n.body, data.dogs);
      if (!snippet.truncated) return `<div class="note-body">${bodyHtml(n.body, data.dogs)}</div>`;
      return `<div class="note-body note-snippet">${esc(snippet.text)}</div>
        <div class="note-body note-full hidden">${bodyHtml(n.body, data.dogs)}</div>
        <button type="button" class="link-btn pg-expand">Read more</button>`;
    };
    const entry = (n, fromDog) => `<li class="note" data-note="${n.id}">
        <div class="note-head">
          ${!fromDog && n.canEdit
    ? `<label class="note-date editable" title="Change the date">${fmtDate(n.noteDate, { weekday: true })} 📅<input type="date" class="pg-redate" value="${n.noteDate}" max="${today()}" aria-label="Change this note's date" /></label>`
    : `<span class="note-date">${fmtDate(n.noteDate, { weekday: true })}</span>`}
          ${fromDog ? `<span class="muted small">in <button type="button" class="pg-tag" data-pg-dog="${fromDog.id}">${esc(fromDog.name)}</button>'s notes</span>` : ''}
          ${n.author ? `<span class="muted small">— ${esc(n.author)}</span>` : ''}
          ${!fromDog && n.canEdit ? `<span class="note-actions">
            <button type="button" class="link-btn" data-act="edit">Edit</button>
            <button type="button" class="link-btn danger" data-act="erase">Delete</button>
          </span>` : ''}
        </div>
        ${entryBodyHtml(n, fromDog)}
      </li>`;
    const pane = document.getElementById('dogPane');
    pane.innerHTML = `
      <button type="button" class="link-btn back-to-list" data-act="back">‹ All dogs</button>
      <div class="dog-head">
        ${info.photoUrl ? `<img src="${esc(info.photoUrl)}" alt="" />` : ''}
        <div>
          <h2>${esc(info.name)}</h2>
          <p class="muted small">ID ${esc(dogId)}${listed ? ` · 🏠 ${esc(listed.kennelLocation || '?')} · ${esc(listed.breed || '')} · ${esc(listed.sex || '')} · ${esc(fmtAge(listed.age))}` : ' · no longer listed at the shelter'}</p>
          ${why ? `<p class="small warn">Not play group eligible right now: ${esc(why)}</p>` : ''}
        </div>
      </div>
      <div class="card new-note">${editorHtml()}</div>
      <h3>Notes (${data.notes.length})</h3>
      ${data.notes.length ? `<ul class="notes">${data.notes.map((n) => entry(n)).join('')}</ul>` : '<p class="muted small">No play group notes yet.</p>'}
      ${data.mentions.length ? `<h3>Mentioned in other dogs' notes (${data.mentions.length})</h3>
        <ul class="notes">${data.mentions.map((n) => entry(n, data.dogs[n.dogId] || { id: n.dogId, name: 'another dog' })).join('')}</ul>` : ''}`;

    const reload = () => Promise.all([refreshCounts(), openDog(dogId, { focus: false })]);
    const ta = wireEditor(pane.querySelector('.new-note'), {
      ownId: dogId,
      onSave: async (v) => {
        await api(`/api/dogs/${dogId}/playgroup-notes`, { method: 'POST', body: JSON.stringify(v) });
        state.lastDate = v.noteDate;
        toast(`Saved for ${info.name} (${fmtDate(v.noteDate)})`);
        await reload();
        const next = document.querySelector('#dogPane .new-note .pg-text');
        if (next && hasKeyboard) next.focus();
      }
    });
    // On a phone, putting the cursor in the box pops up the keyboard over the
    // dog's notes, so only focus it where there's a real keyboard.
    if (focus && hasKeyboard) ta.focus();

    pane.querySelector('[data-act="back"]').addEventListener('click', closeDog);
    pane.querySelectorAll('[data-pg-dog]').forEach((t) => t.addEventListener('click', () => openDog(t.dataset.pgDog)));
    pane.querySelectorAll('.pg-expand').forEach((btn) => {
      btn.addEventListener('click', () => {
        const li = btn.closest('.note');
        const expanding = li.querySelector('.note-full').classList.toggle('hidden') === false;
        li.querySelector('.note-snippet').classList.toggle('hidden', expanding);
        btn.textContent = expanding ? 'Show less' : 'Read more';
      });
    });
    pane.querySelectorAll('.notes .note').forEach((li) => {
      const n = data.notes.find((x) => String(x.id) === li.dataset.note);
      if (!n || !n.canEdit) return;
      const redate = li.querySelector('.pg-redate');
      redate.addEventListener('click', () => { try { redate.showPicker(); } catch (e) { /* browser opens its own */ } });
      redate.addEventListener('change', async () => {
        if (!redate.value || redate.value === n.noteDate) return;
        try {
          await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'PUT', body: JSON.stringify({ body: n.body, noteDate: redate.value }) });
          toast(`Moved to ${fmtDate(redate.value)}`);
          reload();
        } catch (err) { toast(err.message, 'error'); redate.value = n.noteDate; }
      });
      li.querySelector('[data-act="edit"]').addEventListener('click', () => {
        const { text, picks } = toEditable(n.body, data.dogs);
        li.innerHTML = editorHtml({ text, date: n.noteDate, signed: n.signed, showSign: n.mine, saveLabel: 'Save changes', cancel: true });
        const eta = wireEditor(li, {
          picks,
          ownId: dogId,
          onCancel: reload,
          onSave: async (v) => {
            await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'PUT', body: JSON.stringify(v) });
            toast('Note updated');
            reload();
          }
        });
        eta.focus();
      });
      li.querySelector('[data-act="erase"]').addEventListener('click', async () => {
        if (!window.confirm(`Delete this play group note from ${fmtDate(n.noteDate)}?`)) return;
        try { await api(`/api/dogs/${dogId}/playgroup-notes/${n.id}`, { method: 'DELETE' }); toast('Note deleted'); reload(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  async function refreshCounts() {
    try { state.counts = (await api('/api/playgroup-notes/counts')).counts; } catch (e) { /* list just shows no counts */ }
    renderDogList();
  }

  // ---------- All sessions ----------
  function sessionQuery() {
    const p = new URLSearchParams();
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    const q = document.getElementById('sessionSearch').value.trim();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q) p.set('q', q);
    return p.toString();
  }
  let sessionsSeq = 0;
  async function loadSessions() {
    const qs = sessionQuery();
    document.getElementById('exportBtn').href = `/api/playgroup-notes/export.xlsx${qs ? `?${qs}` : ''}`;
    const seq = ++sessionsSeq;
    let data;
    try { data = await api(`/api/playgroup-notes${qs ? `?${qs}` : ''}`); } catch (err) { toast(err.message, 'error'); return; }
    if (seq !== sessionsSeq) return;
    const days = new Set(data.notes.map((n) => n.noteDate)).size;
    const dogCount = new Set(data.notes.map((n) => n.dogId)).size;
    document.getElementById('sessionCount').textContent = `${data.notes.length} note${data.notes.length === 1 ? '' : 's'} · ${dogCount} dog${dogCount === 1 ? '' : 's'} · ${days} day${days === 1 ? '' : 's'}`;
    // data-label: on a narrow screen each row turns into a card (playgroup.css)
    // and these become the little headings inside it.
    document.getElementById('sessionRows').innerHTML = data.notes.length ? data.notes.map((n) => `<tr>
        <td class="nowrap" data-label="Date">${fmtDate(n.noteDate, { weekday: true })}</td>
        <td data-label="Dog"><button type="button" class="pg-tag" data-open-dog="${n.dogId}">${esc(n.dogName)}</button>${n.kennelLocation ? ` <span class="muted small">🏠 ${esc(n.kennelLocation)}</span>` : ''}</td>
        <td class="note-cell" data-label="Note">${bodyHtml(n.body, data.dogs)}</td>
        <td data-label="Dogs tagged"${n.tagged.length ? '' : ' class="empty-cell"'}>${n.tagged.map((id) => `<button type="button" class="pg-tag" data-open-dog="${id}">${esc(data.dogs[id].name)}</button>`).join(', ')}</td>
        <td data-label="Signed by">${n.author ? esc(n.author) : '<span class="muted">—</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="muted">No notes in this range.</td></tr>';
  }
  function setRange(range) {
    const from = document.getElementById('fromDate');
    const to = document.getElementById('toDate');
    // Shelter dates (pg-tags.js), not this device's own calendar.
    if (range === 'all') { from.value = ''; to.value = ''; }
    else if (range === 'year') { from.value = `${today().slice(0, 4)}-01-01`; to.value = today(); }
    else { from.value = daysAgo(Number(range) - 1); to.value = today(); }
    document.querySelectorAll('[data-range]').forEach((c) => c.classList.toggle('active', c.dataset.range === range));
    loadSessions();
  }

  // ---------- Tabs and wiring ----------
  function showView(view) {
    state.view = view;
    document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.getElementById('writeView').classList.toggle('hidden', view !== 'write');
    document.getElementById('sessionsView').classList.toggle('hidden', view !== 'sessions');
    if (view === 'sessions') loadSessions();
  }

  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.getElementById('dogSearch').addEventListener('input', renderDogList);
  document.getElementById('dogSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#dogList .dog-row');
      if (first) { e.preventDefault(); openDog(first.dataset.dog); }
    }
  });
  document.getElementById('onlyWithNotes').addEventListener('change', renderDogList);
  document.getElementById('dogSort').addEventListener('change', renderDogList);
  document.getElementById('dogList').addEventListener('click', (e) => {
    const row = e.target.closest('.dog-row');
    if (row) openDog(row.dataset.dog);
  });
  document.getElementById('sessionRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open-dog], [data-pg-dog]');
    if (!b) return;
    showView('write');
    openDog(b.dataset.openDog || b.dataset.pgDog);
  });
  document.querySelectorAll('[data-range]').forEach((c) => c.addEventListener('click', () => setRange(c.dataset.range)));
  ['fromDate', 'toDate'].forEach((id) => document.getElementById(id).addEventListener('change', () => {
    document.querySelectorAll('[data-range]').forEach((c) => c.classList.remove('active'));
    loadSessions();
  }));
  let searchTimer = null;
  document.getElementById('sessionSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadSessions, 250); });
  // "/" jumps to the dog search from anywhere but a text box.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
    e.preventDefault();
    showView('write');
    document.getElementById('dogSearch').focus();
  });

  (async function start() {
    try {
      state.me = await api('/api/me');
      const [dogs] = await Promise.all([api('/api/dogs?all=false'), refreshCounts()]);
      state.dogs = dogs.dogs.filter(canPlay);
    } catch (err) {
      document.getElementById('dogPane').innerHTML = `<p class="muted">Couldn't load the dogs. ${esc(err.message)}</p>`;
      return;
    }
    renderDogList();
    setRange('all');
    showView('write');
    const want = new URLSearchParams(location.search).get('dog');
    if (want) openDog(want);
  })();
})();
