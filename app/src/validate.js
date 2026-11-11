// Shared input validators for the API.

// 'YYYY-MM-DD' when str is a real calendar date (2026-02-29 and 2026-13-45
// are not), otherwise null.
function realDateKey(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? str : null;
}

// Text the API stores must arrive as text: a number, true or an object in
// one of these fields is refused (400) rather than saved as "-1", "true" or
// "[object Object]" (audit 3). null/undefined are left to each route. Keyed
// by path prefix (express app.use), for writes only.
const TEXT_FIELDS = [
  ['/api/dogs/:id/notes', ['body']],
  ['/api/dogs/:id/walk-notes', ['body']],
  ['/api/dogs/:id/private-note', ['body']],
  ['/api/dogs/:id/playgroup-notes', ['body', 'noteDate']],
  ['/api/walks', ['notes']],
  ['/api/wiki', ['title', 'icon', 'body']],
  ['/api/staff/alerts', ['title', 'body', 'until']],
  ['/api/staff/schedule/days', ['note', 'message']],
  ['/api/staff/saved-reports', ['name']],
  ['/api/modules/walker-chat/messages', ['body']],
  ['/api/feedback', ['body']]
];
function textFieldsGuard(fields) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) return next();
    const bad = fields.find((f) => b[f] != null && typeof b[f] !== 'string');
    if (bad) return res.status(400).json({ error: `Send the ${bad} as text.` });
    next();
  };
}
function registerTextFieldGuards(app) {
  for (const [prefix, fields] of TEXT_FIELDS) app.use(prefix, textFieldsGuard(fields));
}

module.exports = { realDateKey, textFieldsGuard, registerTextFieldGuards, TEXT_FIELDS };
