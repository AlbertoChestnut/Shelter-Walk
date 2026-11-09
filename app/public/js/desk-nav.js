// The view switcher at the top of the desktop pages (play group desk, staff
// dashboard): a link to each page this person can use, and which one opens
// first when they go to the site on a computer. The list of pages comes from
// the server (desktopViews.js via /api/me), so a new desktop page shows up
// here without touching this file.
(function () {
  const el = document.getElementById('deskNav');
  if (!el) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function render() {
    let me;
    try { me = await (await fetch('/api/me')).json(); } catch (e) { return; }
    if (!me || !me.desktop) return;
    const here = location.pathname.replace(/\/$/, '') || '/app';
    const views = me.desktop.views;
    const current = views.find((v) => v.path === here);
    el.innerHTML = `
      <span class="desk-nav-views" role="navigation" aria-label="Switch page">
        ${views.map((v) => (v === current
    ? `<span class="desk-nav-link current" aria-current="page">${esc(v.label)}</span>`
    : `<a class="desk-nav-link" href="${esc(v.path)}">${esc(v.label)}</a>`)).join('')}
      </span>
      ${current ? `<label class="desk-nav-start">
        <input type="checkbox" id="deskNavStart"${me.desktop.start === current.key ? ' checked' : ''} />
        Open this page first on a computer
      </label>` : ''}`;
    const box = document.getElementById('deskNavStart');
    if (!box) return;
    box.addEventListener('change', async () => {
      // Unticking goes back to the default for who you are.
      const desktopView = box.checked ? current.key : null;
      box.disabled = true;
      try {
        const res = await fetch(`/api/users/${me.id}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desktopView }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Not saved');
      } catch (err) {
        box.checked = !box.checked;
        window.alert(`Couldn't save that: ${err.message}`);
      }
      await render();
    });
  }
  render();
})();
