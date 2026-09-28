# Shelter Walk

A mobile-first web app that helps volunteers at an animal shelter walk dogs
safely and fairly: who is available to walk, who has been out, what each dog
needs, and how the shelter is doing as a whole.

| Folder | What it is | Stack |
|---|---|---|
| [`app/`](app) | The walking app: available dogs, QR scan, timed walks, stats, updates feed, guide, notes | Node, Express, SQLite (better-sqlite3), plain JavaScript front end (PWA) |
| [`deploy/`](deploy) | Reverse proxy config, systemd unit, backup scripts, health check, env template | Caddy, systemd |

The app expects a reverse proxy to authenticate every request first and pass
along who signed in (see `deploy/Caddyfile`); it never has a login of its own
and trusts the `X-Auth-Email`/`X-Auth-Staff` headers only because nothing but
that proxy can set them. This repository doesn't include a sign-in service:
the production deployment uses an invite-only Django/allauth site (email
codes, passkeys, staff tools) that isn't published here since it's the gate
that decides who may access shelter dogs. Any auth provider that can act as a
Caddy `forward_auth` backend will work in its place.

This is an independent volunteer project. It is not affiliated with, or
endorsed by, any shelter or county. It reads the shelter's public adoptable
dog listings; no shelter data, photos, or volunteer data are in this repository.

## Features

- **Available list** with filters, experience levels, and time-slot awareness
- **Scan a kennel QR code**, start a timed walk, add notes at the end
- **Walk limits:** walks stop automatically after 30 minutes (extendable to 3
  hours) and are flagged as automatically stopped
- **Accurate end times:** a walk ends when End Walk is tapped, not when the
  notes are saved. If the time limit stopped it, the walker gets the same end
  screen (even after reopening the app) and says when it really ended: just
  now, at the limit, or a picked time (never a future one)
- **Walk length alerts:** up to 3 push notifications per walk at lengths
  each walker picks in Settings (e.g. 7 and 10 minutes)
- **Stats:** personal stats, plus **Together**, anonymous shelter-wide totals
- **Updates feed:** new, returned, and adopted dogs
- **Guide (wiki):** staff-editable sections with sticker meanings and images
- **Dog notes:** an anonymous shared tip list per dog, plus private notes
- **Installable, works on flaky Wi-Fi** (service worker), light and dark themes
- **Account deletion** with three confirmations; walk records are kept but no
  longer linked to anyone

## Privacy is a design rule

Volunteers must never be singled out or compared. The code enforces this, and
the tests in `app/test/privacy.test.js` are release blockers:

- Shelter-wide stats never read any user column, show no rankings or per-person
  numbers, and hide any day or session with fewer than 3 walks.
- Shared tips never store or return an author. Private notes are readable only
  by their owner, with no staff override.
- Every API call is scoped to the signed-in account; user ids in requests are
  ignored.
- Deleting an account tells your auth service to remove the sign-in and all
  personal data first, then detaches walk history from the person
  (`user_id` becomes NULL) only once that succeeds (`app/src/account.js`).

## Security notes

- Every query uses bound parameters; user text is escaped or sanitized before
  display; a strict Content-Security-Policy blocks inline and third-party script.
- Every write from the auth service to the app (account deletion, and looking up
  or changing an account's extra features) requires a shared bearer token
  (`INTERNAL_API_TOKEN`); nothing else can call it.
- The app never stores an email address. `X-Auth-Email` can carry any stable
  per-account identifier (production sends a placeholder, not a real email);
  the app keeps only a keyed one-way hash of it (`app/src/emailHash.js`, secret
  `EMAIL_HASH_PEPPER`, which must never change).
- Secrets are read from environment files only. Nothing in this repository is a
  credential; see `deploy/env/*.example`.
- Rate-limiting sign-in and invite attempts is your auth service's job, not
  this app's; whatever you pair it with should do that per real client IP.

If you find a security problem, please open a private security advisory on
GitHub rather than a public issue.

## Running it locally

App (Node 20+):

    cd app
    npm install
    DISABLE_SCRAPER=1 npm start        # http://127.0.0.1:3000
    npm test

Browser smoke test (drives the main volunteer flow in headless Chromium):

    npm i --no-save playwright@1 && npx playwright install chromium
    npm run smoke

GitHub Actions runs both on every push (`.github/workflows/test.yml`).

In production the app receives `X-Auth-Email` and `X-Auth-Staff` headers from
the proxy. For local experiments, put a tiny proxy in front that injects them.
Never expose the app port directly: it trusts those headers.

## Deploying

`deploy/` holds what runs on the server for this app: `Caddyfile` (the
`shelterwalk.com` block only; add your own auth service's block beside it),
the `dogwalk` systemd unit, nightly database backups, weekly photo backups,
and a health check that emails when something breaks. Copy
`deploy/env/dogwalk.env.example` to `/etc/dogwalk/env`, fill in real values,
and keep it out of version control (`chmod 600`). `INTERNAL_API_TOKEN` must
match whatever your auth service sends as its bearer token.

Replace the example domains and email addresses with your own.

## Third-party code

`app/public/js/html5-qrcode.min.js` is the [html5-qrcode](https://github.com/mebjas/html5-qrcode) library (Apache-2.0), vendored unmodified for the QR scanner. Other dependencies come from npm and PyPI.

## License

MIT, see [LICENSE](LICENSE).
