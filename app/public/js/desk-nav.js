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
        <span class="desk-nav-start-long">Open this page first on a computer</span><span class="desk-nav-start-short" title="Open this page first on a computer">Start here</span>
      </label>` : ''}`;
    const box = document.getElementById('deskNavStart');
    if (!box) return;
    box.addEventListener('change', async () => {
      // Unticking picks the volunteer app. Not null ("the default for who
      // you are"): for staff that default is this very page, so the box
      // would just tick itself again.
      const desktopView = box.checked ? current.key : 'app';
      box.disabled = true;
      try {
        const res = await fetch(`/api/users/${me.id}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desktopView }) }).catch(() => null);
        if (!res) throw new Error("Couldn't reach the server.");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          // A 4xx's own `error` is written for people; anything else gets a plain line.
          throw new Error(res.status < 500 && typeof body.error === 'string' && body.error ? body.error : 'Something went wrong on our end.');
        }
      } catch (err) {
        box.checked = !box.checked;
        window.alert(`Couldn't save that. ${err.message} Try again in a moment.`);
      }
      await render();
    });
  }
  render();
})();
