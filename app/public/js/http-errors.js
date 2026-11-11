// One request helper for the desktop pages (staff dashboard, staff Settings,
// Playgroup desk) and the modules' scripts (walker chat, YouTube staff
// panel), so they all word errors the same way as app.js's api():
//
//   - A 4xx's own `error` is written for people and shown as-is. A 5xx is
//     shown as-is only when the server marks it `userFacing: true`; anything
//     else becomes a plain line, never "Request failed (500)".
//   - A signed-out session (the service worker's 401 with sessionExpired, or
//     the login gate answering an API call with its HTML sign-in page) shows
//     one "Your sign-in has expired" bar with a Reload button.
//
// Exposed as window.ShelterHttp; load it before the page's own script.
(function () {
  'use strict';

  const EXPIRED_TEXT = 'Your sign-in has expired. Reload the page to sign in again.';

  function errorMessage(status, body) {
    if ((status < 500 || (body && body.userFacing === true)) && body && typeof body.error === 'string' && body.error) return body.error;
    if (status === 404) return "That couldn't be found. It may have been removed.";
    if (status === 401 || status === 403) return "You don't have access to that. Reload the page to sign in again.";
    if (status === 429) return 'Too many tries in a row. Wait a moment and try again.';
    if (status >= 502 && status <= 504) return "The server isn't responding right now. Try again in a minute.";
    return 'Something went wrong on our end. Try again in a moment.';
  }

  let expiredShown = false;
  function showSessionExpired() {
    if (expiredShown || !document.body) return;
    expiredShown = true;
    const bar = document.createElement('div');
    bar.className = 'session-expired-bar';
    bar.setAttribute('role', 'alert');
    // Inline styles: every page that loads this gets the bar, whatever its CSS.
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:1000;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:center;padding:10px 16px;background:#b3392c;color:#fff;font:600 0.95rem/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
    const text = document.createElement('span');
    text.textContent = 'Your sign-in has expired.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload to sign in';
    btn.style.cssText = 'border:0;border-radius:999px;padding:6px 14px;background:#fff;color:#b3392c;font:inherit;cursor:pointer;';
    btn.addEventListener('click', () => window.location.reload());
    bar.append(text, btn);
    document.body.prepend(bar);
  }

  function apiError(message, extra) {
    const err = new Error(message);
    err.fromApi = true;
    return Object.assign(err, extra);
  }

  // fetch() with a timeout, JSON in and out, and friendly errors. Resolves to
  // the parsed JSON body (null when the answer isn't JSON).
  async function request(path, opts = {}) {
    const { timeout = 20000, headers, ...fetchOpts } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(path, { ...fetchOpts, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, signal: controller.signal });
    } catch (err) {
      let message;
      if (err && err.name === 'AbortError') message = "That's taking too long. Check the connection and try again.";
      else if (typeof navigator !== 'undefined' && navigator.onLine === false) message = "You're offline. Check the connection and try again.";
      // Online but the request failed: an expired sign-in redirecting to the
      // login page on another site looks exactly like this to fetch().
      else message = "Couldn't reach the server. If this keeps happening, your sign-in may have expired. Reload the page to sign in again.";
      throw apiError(message, { networkError: true });
    } finally {
      clearTimeout(timer);
    }
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      if (res.status === 401 && body && body.sessionExpired) showSessionExpired();
      throw apiError(errorMessage(res.status, body), { status: res.status, body, serverMessage: (body && body.error) || null });
    }
    // An API call that came back as a web page after a redirect is the login
    // gate's sign-in page: the session is gone.
    if (!isJson && res.redirected && /text\/html/.test(res.headers.get('content-type') || '')) {
      showSessionExpired();
      throw apiError(EXPIRED_TEXT, { status: 401, sessionExpired: true });
    }
    return body;
  }

  window.ShelterHttp = { request, errorMessage, showSessionExpired };
})();
