// Express 4 doesn't catch a rejected promise from an async route: the request
// just hangs and Node logs an unhandled rejection. Wrap async handlers so the
// error reaches the app's error handler (server.js) and the client gets an
// answer.
//   app.get('/x', asyncRoute(async (req, res) => { ... }));
const asyncRoute = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

module.exports = asyncRoute;
