// Applies the saved light/dark choice before first paint (loaded from <head>,
// as an external file so the page can forbid inline scripts entirely).
(function () {
  try {
    var pref = localStorage.getItem('sw_theme') || 'system';
    var resolved = pref === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.dataset.theme = resolved;
  } catch (e) {}
})();
