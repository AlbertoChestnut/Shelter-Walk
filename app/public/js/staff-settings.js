// The Settings tab: lists every discovered module (app/modules/*) with a
// toggle and any config fields it declares, and saves changes straight
// through -- a module takes effect (or stops) on its very next request/job
// tick, no restart. Its own small IIFE; requests go through the shared
// helper in js/http-errors.js (friendly errors, signed-out bar).
(function () {
  'use strict';

  const api = (path, opts) => window.ShelterHttp.request(path, opts);
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fieldHtml(moduleId, field, value) {
    const type = field.type === 'number' ? 'number' : 'text';
    return `<label class="module-field">${escapeHtml(field.label)}
      <input type="${type}" data-module-id="${moduleId}" data-key="${escapeHtml(field.key)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(field.placeholder || '')}" />
    </label>`;
  }

  // A labeled on/off switch: the word next to it says which state it's in.
  function moduleCardHtml(m) {
    return `<div class="module-card" data-module-id="${m.id}">
      <div class="module-card-head">
        <strong id="module-name-${escapeHtml(m.id)}">${escapeHtml(m.name)}</strong>
        <label class="switch">
          <input type="checkbox" role="switch" class="module-toggle" data-module-id="${m.id}" ${m.enabled ? 'checked' : ''} aria-labelledby="module-name-${escapeHtml(m.id)}" />
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-state">${m.enabled ? 'On' : 'Off'}</span>
        </label>
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
    try { data = await api('/api/modules'); } catch (err) { list.innerHTML = `<p class="muted small">Couldn't load the extra features. ${escapeHtml(err.message)}</p>`; return; }
    list.innerHTML = data.modules.length ? data.modules.map(moduleCardHtml).join('') : '<p class="muted small">No extra features are installed.</p>';
    const toast = window.staffToast || ((msg) => window.alert(msg));
    list.querySelectorAll('.module-toggle').forEach((cb) => {
      const stateEl = cb.closest('.switch').querySelector('.switch-state');
      const name = cb.closest('.module-card').querySelector('strong').textContent;
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        stateEl.textContent = cb.checked ? 'On' : 'Off';
        try {
          await api(`/api/modules/${cb.dataset.moduleId}`, { method: 'PUT', body: JSON.stringify({ enabled: cb.checked }) });
          toast(`${name} is ${cb.checked ? 'on' : 'off'}.`);
        } catch (err) {
          cb.checked = !cb.checked;
          stateEl.textContent = cb.checked ? 'On' : 'Off';
          toast(`Couldn't turn ${name} ${cb.checked ? 'off' : 'on'}. ${err.message}`, 'error');
          console.error('[settings] toggling module failed:', err);
        }
        cb.disabled = false;
      });
    });
    list.querySelectorAll('.module-config input').forEach((input) => {
      input.addEventListener('change', () => saveConfig(input.dataset.moduleId));
    });
  }

  window.loadModuleSettings = loadModuleSettings;
})();
