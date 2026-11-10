// Floating chat widget, injected into index.html when this module is
// enabled (see manifest.js clientAssets.index). Self-contained: its own
// DOM, its own EventSource -- nothing in core app.js knows this exists.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'wc-toggle';
  toggle.setAttribute('aria-label', 'Walker chat');
  toggle.innerHTML = '💬<span class="wc-badge"></span>';
  const badge = toggle.querySelector('.wc-badge');

  const panel = document.createElement('div');
  panel.className = 'wc-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="wc-head">Walker chat <button type="button" class="wc-close" aria-label="Close">✕</button></div>
    <div class="wc-list" id="wcList"></div>
    <div class="wc-typing" id="wcTyping"></div>
    <form class="wc-form" id="wcForm">
      <input id="wcInput" type="text" maxlength="1000" placeholder="Message..." autocomplete="off" />
      <button type="submit">Send</button>
    </form>
  `;
  document.body.appendChild(panel);
  document.body.appendChild(toggle);

  const list = panel.querySelector('#wcList');
  const typingEl = panel.querySelector('#wcTyping');
  const form = panel.querySelector('#wcForm');
  const input = panel.querySelector('#wcInput');
  let unread = 0;
  let open = false;

  // Who's currently typing, each with a timer that clears them if no
  // further 'typing' event arrives -- so a closed tab or a dropped
  // connection doesn't leave a stale "is typing..." stuck forever.
  const typingUsers = new Map();
  const TYPING_TIMEOUT_MS = 3000;
  function renderTyping() {
    const names = [...typingUsers.values()];
    if (!names.length) { typingEl.textContent = ''; return; }
    typingEl.textContent = names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(', ')} are typing...`;
  }
  function markTyping(userId, authorName) {
    clearTimeout((typingUsers.get(userId) || {}).timer);
    const timer = setTimeout(() => { typingUsers.delete(userId); renderTyping(); }, TYPING_TIMEOUT_MS);
    typingUsers.set(userId, { name: authorName, timer });
    renderTyping();
  }
  function clearTypingFor(userId) {
    clearTimeout((typingUsers.get(userId) || {}).timer);
    typingUsers.delete(userId);
    renderTyping();
  }

  let lastTypingSent = 0;
  const TYPING_SEND_THROTTLE_MS = 3000; // the server takes at most one per 3 s
  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSent < TYPING_SEND_THROTTLE_MS) return;
    lastTypingSent = now;
    api('/api/modules/walker-chat/typing', { method: 'POST', body: '{}' }).catch(() => {});
  }
  input.addEventListener('input', () => { if (input.value.trim()) notifyTyping(); });

  function setUnread(n) {
    unread = n;
    badge.textContent = unread > 9 ? '9+' : (unread || '');
  }

  function atBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function appendMessage(m) {
    const wasAtBottom = atBottom();
    const row = document.createElement('div');
    row.className = `wc-msg${m.mine ? ' wc-mine' : ''}`;
    row.dataset.id = m.id;
    row.innerHTML = `<div class="wc-author">${esc(m.authorName)}</div><div class="wc-bubble">${esc(m.body)}</div>`;
    list.appendChild(row);
    if (wasAtBottom) list.scrollTop = list.scrollHeight;
    if (!open && !m.mine) setUnread(unread + 1);
  }

  function removeMessage(id) {
    const row = list.querySelector(`.wc-msg[data-id="${id}"]`);
    if (row) row.remove();
  }

  async function loadHistory() {
    let data;
    try { data = await api('/api/modules/walker-chat/messages'); }
    catch (err) { list.innerHTML = `<div class="muted small">Couldn't load chat: ${esc(err.message)}</div>`; return; }
    list.innerHTML = '';
    data.messages.forEach(appendMessage);
    list.scrollTop = list.scrollHeight;
  }

  // The browser's own reconnect gives up for good after an answer that isn't
  // a stream (a 429 when too many tabs are open, a 502 during a restart), and
  // chat would then just go quiet. So any error closes it and a new one is
  // opened after a wait that doubles each time (2 s up to a minute), back to
  // 2 s once a stream opens. Messages missed meanwhile come from the history.
  const RETRY_MIN_MS = 2000;
  const RETRY_MAX_MS = 60000;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let hadStream = false;
  function connectStream() {
    retryTimer = null;
    const es = new EventSource('/api/modules/walker-chat/stream');
    window.__wcStream = es;
    es.onopen = () => {
      if (hadStream) loadHistory();
      hadStream = true;
      retryMs = RETRY_MIN_MS;
    };
    es.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      // The stream carries userId, not mine -- stamped against whichever
      // account loaded this page, same as the initial history fetch.
      m.mine = m.userId === window.__wcMeId;
      clearTypingFor(m.userId);
      appendMessage(m);
    });
    es.addEventListener('deleted', (e) => removeMessage(JSON.parse(e.data).id));
    es.addEventListener('typing', (e) => {
      const t = JSON.parse(e.data);
      if (t.userId !== window.__wcMeId) markTyping(t.userId, t.authorName);
    });
    es.onerror = () => {
      es.close();
      if (retryTimer) return;
      const wait = retryMs;
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
      retryTimer = setTimeout(connectStream, wait);
    };
  }

  toggle.addEventListener('click', () => {
    open = !open;
    panel.hidden = !open;
    if (open) { setUnread(0); input.focus(); }
  });
  panel.querySelector('.wc-close').addEventListener('click', () => { open = false; panel.hidden = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      await api('/api/modules/walker-chat/messages', { method: 'POST', body: JSON.stringify({ body }) });
      input.value = '';
    } catch (err) {
      console.error('[walker-chat] send failed:', err);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  api('/api/me').then((me) => { window.__wcMeId = me.id; }).catch(() => {})
    .finally(() => { loadHistory(); connectStream(); });
})();
