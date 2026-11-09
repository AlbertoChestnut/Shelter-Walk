// The Settings tab: lists every discovered module (app/modules/*) with a
// toggle and any config fields it declares, and saves changes straight
// through -- a module takes effect (or stops) on its very next request/job
// tick, no restart. Its own small IIFE, same reasoning as staff.js's own
// comment: no module system to import from, so the api()/escapeHtml()
// helpers are copied rather than shared.
(function () {
  'use strict';

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

  function fieldHtml(moduleId, field, value) {
    const type = field.type === 'number' ? 'number' : 'text';
    return `<label class="module-field">${escapeHtml(field.label)}
      <input type="${type}" data-module-id="${moduleId}" data-key="${escapeHtml(field.key)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(field.placeholder || '')}" />
    </label>`;
  }

  function moduleCardHtml(m) {
    return `<div class="module-card" data-module-id="${m.id}">
      <div class="module-card-head">
        <label class="check"><input type="checkbox" class="module-toggle" data-module-id="${m.id}" ${m.enabled ? 'checked' : ''} /> <strong>${escapeHtml(m.name)}</strong></label>
        <span class="muted small">v${escapeHtml(m.version)}</span>
      </div>
      <p class="muted small">${escapeHtml(m.description)}</p>
      ${m.configSchema.length ? `<div class="module-config">
        ${m.configSchema.map((f) => fieldHtml(m.id, f, m.config[f.key])).join('')}
        <p class="module-config-status small muted" data-module-id="${m.id}"></p>
      </div>` : ''}
    </div>`;
  }

  let saveTimers = {};
  function saveConfig(moduleId) {
    const status = document.querySelector(`.module-config-status[data-module-id="${moduleId}"]`);
    clearTimeout(saveTimers[moduleId]);
    if (status) status.textContent = 'Saving…';
    saveTimers[moduleId] = setTimeout(async () => {
      const config = {};
      document.querySelectorAll(`.module-config input[data-module-id="${moduleId}"]`).forEach((input) => { config[input.dataset.key] = input.value; });
      try {
        const { module: saved } = await api(`/api/modules/${moduleId}`, { method: 'PUT', body: JSON.stringify({ config }) });
        // A module can normalize what was typed (the youtube-channel module
        // turns a pasted link into the actual channel id) -- show the
        // result, so saving doubles as confirmation it understood the link.
        Object.keys(saved.config).forEach((key) => {
          const input = document.querySelector(`.module-config input[data-module-id="${moduleId}"][data-key="${key}"]`);
          if (input && document.activeElement !== input) input.value = saved.config[key];
        });
        if (status) { status.textContent = 'Saved.'; status.style.color = ''; }
      } catch (err) {
        if (status) { status.textContent = err.message; status.style.color = 'var(--red)'; }
        console.error('[settings] saving module config failed:', err);
      }
    }, 400);
  }

  async function loadModuleSettings() {
    const list = document.getElementById('moduleList');
    if (!list) return;
    let data;
    try { data = await api('/api/modules'); } catch (err) { list.innerHTML = `<p class="muted small">Couldn't load modules: ${escapeHtml(err.message)}</p>`; return; }
    list.innerHTML = data.modules.length ? data.modules.map(moduleCardHtml).join('') : '<p class="muted small">No modules installed.</p>';
    list.querySelectorAll('.module-toggle').forEach((cb) => {
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try { await api(`/api/modules/${cb.dataset.moduleId}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) }); }
        catch (err) { cb.checked = !cb.checked; console.error('[settings] toggling module failed:', err); }
        cb.disabled = false;
      });
    });
    list.querySelectorAll('.module-config input').forEach((input) => {
      input.addEventListener('change', () => saveConfig(input.dataset.moduleId));
    });
  }

  window.loadModuleSettings = loadModuleSettings;
})();
