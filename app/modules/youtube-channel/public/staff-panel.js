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

  function rowHtml(m) {
    return `<li class="yt-pending-item" data-id="${m.id}">
      <div>
        <strong>${esc(m.dogName)}</strong> <span class="muted small">matched "${esc(m.matchedText)}"</span>
        <div><a href="${esc(m.videoUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.videoTitle)}</a></div>
      </div>
      <div class="yt-pending-actions">
        <button type="button" class="primary-btn yt-confirm" data-id="${m.id}">Confirm</button>
        <button type="button" class="link-btn yt-dismiss" data-id="${m.id}">Not this dog</button>
      </div>
    </li>`;
  }

  async function load() {
    const list = document.getElementById('ytPendingList');
    if (!list) return;
    let data;
    try { data = await api('/api/modules/youtube-channel/matches'); }
    catch (err) { list.innerHTML = `<li class="muted small">Couldn't load: ${esc(err.message)}</li>`; return; }
    list.innerHTML = data.matches.length ? data.matches.map(rowHtml).join('') : '<li class="muted small">Nothing pending review.</li>';
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.yt-confirm, .yt-dismiss');
    if (!btn) return;
    const action = btn.classList.contains('yt-confirm') ? 'confirm' : 'dismiss';
    btn.closest('.yt-pending-actions').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api(`/api/modules/youtube-channel/matches/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ action }) });
      btn.closest('.yt-pending-item').remove();
    } catch (err) {
      console.error('[youtube-channel] review action failed:', err);
      btn.closest('.yt-pending-actions').querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
