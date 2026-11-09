// Injected into index.html (the phone app) when this module is enabled --
// adds a "📺 Videos" section to a dog's profile via the generic
// window.ShelterWalkModules.profileSections hook (see public/js/app.js).
(function () {
  window.ShelterWalkModules = window.ShelterWalkModules || { profileSections: [] };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  window.ShelterWalkModules.profileSections.push(function (dog) {
    if (!dog.videos || !dog.videos.length) return '';
    return `<div class="yt-videos">
      <h3 style="margin:16px 0 6px;font-size:0.95rem;">📺 Videos</h3>
      <ul style="margin:0;padding-left:20px;">${dog.videos.map((v) =>
    `<li><a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a></li>`).join('')}</ul>
    </div>`;
  });
})();
