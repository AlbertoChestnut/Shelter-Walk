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

New volunteers: see the illustrated [tutorial](docs/TUTORIAL.md).


- **Available list** with filters, experience levels, and time-slot awareness
- **Scan a kennel QR code**, start a timed walk, add notes at the end
- **Walk limits:** walks, cuddles and play groups stop automatically after
  45 minutes (matchmaking after 60), extendable 10 minutes at a time to 3
  hours in total, and are flagged as automatically stopped. A daycation can
  run up to 12 hours
- **Walking hours:** staff set the shelter's walking hours and closed days
  (7am to 7pm unless they change them). Walks can't start outside those
  hours and stop at closing time, and the app shows a notice on a closed or
  changed day
- **Accurate end times:** a walk ends when End walk is tapped, not when the
  notes are saved: the server ends it right then, so the dog shows as free to
  everyone at once, and the notes screen comes back after a reload until it's
  saved (an End tapped offline is sent once back online). If the time limit stopped it, the walker gets the same end
  screen (even after reopening the app) and says when it really ended: just
  now, at the limit, or a picked time (never a future one)
- **Walk length alerts:** up to 3 push notifications per walk at lengths
  each walker picks in Settings (e.g. 7 and 10 minutes)
- **Stats&Notes:** personal stats, plus **Together**, anonymous shelter-wide
  totals, split by dogs and cats; every note in one place, with @ tags to
  link a note to another dog or cat
- **Updates feed:** new, returned, and adopted dogs, plus staff alerts.
  Adoption, pending-adoption and return news isn't pushed between 9pm and
  7am shelter time (it still shows in Updates), and "someone is adopting" is
  pushed at most once per dog per day
- **Guide (wiki):** staff-editable sections with sticker meanings and images
- **Dog notes:** an anonymous shared tip list per dog, plus private notes
- **Light list photos:** cards load a 160px thumbnail (made once from the
  cached photo with sharp, ~5 KB instead of ~100 KB); the profile and full
  screen view use the full photo
- **Who walked when stays private:** other volunteers' walks show only the day,
  the walk window and a rounded length; shared notes carry only their date and
  aren't linked to a walk. Only your own walks show clock times
- **Installable, works on flaky Wi-Fi** (service worker), light and dark themes.
  A walk in progress survives going offline and reopening the app. A page left
  open across a deploy reloads itself when nothing is in progress (otherwise it
  offers a reload). Signing out clears this person's walk and drafts from the
  phone, for shared shelter phones
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
- With `NODE_ENV=production` the app refuses to start without
  `EMAIL_HASH_PEPPER` and `INTERNAL_API_TOKEN`.
- A fresh database seeds no accounts, and a sign-in never takes over an
  existing walker profile by name unless `LINK_ACCOUNTS_BY_NAME=1` is set (a
  one-time migration aid; leave it off). Grant staff permissions from your
  auth service.
- Secrets are read from environment files only. Nothing in this repository is a
  credential; see `deploy/env/*.example`.
- Rate-limiting sign-in and invite attempts is your auth service's job, not
  this app's; whatever you pair it with should do that per real client IP.

If you find a security problem, please open a private security advisory on
GitHub rather than a public issue.

## Running it locally

App (Node 22+; CI and the Docker image use 22):

    cd app
    npm install
    DISABLE_SCRAPER=1 npm start        # http://127.0.0.1:3000
    npm test
    npm run test:tz                    # the tests in UTC and in New York time
    npm run check                      # node --check over src, public/js, modules

Browser smoke tests (headless Chromium; Playwright is a dev dependency):

    npx playwright install chromium
    npm run smoke                      # the main volunteer flow
    npm run smoke:all                  # every smoke test

`smoke:all` reads `SMOKE_TZ`, `SMOKE_JOBS` and `SMOKE_SHOTS_DIR` from the
environment. GitHub Actions runs the checks, tests and smoke tests on every
push (`.github/workflows/test.yml`).

In production the app receives `X-Auth-Email` and `X-Auth-Staff` headers from
the proxy. For local experiments, put a tiny proxy in front that injects them.
Never expose the app port directly: it trusts those headers.

## Configuration

The app reads these environment variables (in production, from
`/etc/dogwalk/env`; see `deploy/env/dogwalk.env.example`). Paths default to
folders under `app/`.

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_HASH_PEPPER` | dev-only value | Secret for the one-way hash kept in place of an email. **Required when `NODE_ENV=production`** (the app refuses to start without it). Never change or lose it: every account would stop resolving. Keep a copy off the server. |
| `INTERNAL_API_TOKEN` | none | Bearer token your auth service uses to call the app (account deletion, extra features) and the app uses to call it back. **Required when `NODE_ENV=production`.** |
| `NODE_ENV` | unset | `production` turns on the checks above. |
| `LINK_ACCOUNTS_BY_NAME` | unset | `1` lets a first sign-in claim an existing unlinked walker profile whose name matches the email's local part. A one-time migration aid only; leave it off. |
| `PORT` | `3000` | Port the app listens on. |
| `BIND_HOST` | `127.0.0.1` | Address the app listens on. Keep it on loopback: the app trusts `X-Auth-*` headers, so only the proxy may reach it. (Inside the Docker container it is `0.0.0.0`, with the host side published on loopback only; see `app/docker-compose.yml`.) |
| `DB_PATH` | `data/dogwalk.db` | SQLite database file. |
| `IMAGES_DIR` | `data/images` | Cached dog photos. |
| `WIKI_IMAGES_DIR` | `data/wiki-images` | Images staff upload to the Guide. |
| `WALK_HOURS` | `07:00-19:00` | Default walking hours (shelter time, `HH:MM-HH:MM`) on days staff haven't set. `00:00-24:00` means no limit (tests use it); a day staff closed stays closed. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | empty | Web push keys (`npx web-push generate-vapid-keys`). Push is off when empty. |
| `VAPID_SUBJECT` | `mailto:admin@shelterwalk.com` | Contact sent to push services. Set your own. |
| `DJANGO_INTERNAL_URL` | `http://127.0.0.1:8001` | Your auth service's internal address, called when an account is deleted. |
| `DJANGO_INTERNAL_HOST` | `login.shelterwalk.com` | `Host` header sent with those calls. |
| `DISABLE_SCRAPER` | unset | Any value stops the shelter-listing scraper (local runs, tests, a stage copy). `/uptime` then skips the scrape-age check. |
| `SCRAPER_DELAY_SCALE` | `1` | Multiplies the scraper's pauses between requests; tests set `0`. |
| `DISABLE_MODULE_JOBS` | unset | Any value stops optional modules' background jobs (e.g. on a stage copy). |
| `YOUTUBE_FEED_BASE_URL` | `https://www.youtube.com/feeds/videos.xml` | Feed address for the YouTube channel module; tests point it at a local mock. |
| `STAGE_BANNER` | unset | Short label (e.g. `STAGE`) shown as a strip on every page and in the tab title, so a test copy isn't mistaken for the real site. |

## Deploying

`deploy/` holds what runs on the server for this app: `Caddyfile` (the
`shelterwalk.com` block only; add your own auth service's block beside it),
the `dogwalk` systemd unit, nightly database backups, weekly backups of dog
photos and Guide images (`data/images` and `data/wiki-images`), and a health
check that emails when something breaks. Backups are created readable by the
app's user only, since the database holds private notes; keep a copy off the
server too, along with `EMAIL_HASH_PEPPER`. Copy
`deploy/env/dogwalk.env.example` to `/etc/dogwalk/env`, fill in real values,
and keep it out of version control (`chmod 600`). `INTERNAL_API_TOKEN` must
match whatever your auth service sends as its bearer token.

Replace the example domains and email addresses with your own.

`deploy/Caddyfile` removes any `X-Auth-Email`/`X-Auth-Staff` header the client
sent before anything else runs, on every route; keep that in any proxy you
use instead. Have your auth service send `X-Auth-Staff: 1` for staff only
(anything else means not staff).

Static files under `/js`, `/css` and `/modules` are requested with a
content-hash `?v=` and sent with `Cache-Control: max-age=1y, immutable`; don't
let your proxy override `Cache-Control` for them.

`app/Dockerfile` and `app/docker-compose.yml` run the app in a container as
an unprivileged user, published on the host's loopback only. You still need
the proxy and auth service in front, and an `app/dogwalk.env` with
`EMAIL_HASH_PEPPER` and `INTERNAL_API_TOKEN` (see the comments in
`docker-compose.yml`).

## Third-party code

`app/public/js/html5-qrcode.min.js` is the [html5-qrcode](https://github.com/mebjas/html5-qrcode) library (Apache-2.0), vendored unmodified for the QR scanner. Other dependencies come from npm and PyPI.

## License

Copyright (C) Alberto J. Chestnut.

Shelter Walk is free software under the [GNU Affero General Public License
v3.0 or later](LICENSE). You can use, change, and host it, but if you share a
changed version or run one for other people (including as a website), you
must make your source code available to them under the same license.

Versions released before this change were under the MIT License.

The name "Shelter Walk" and its logo are not covered by the license. Forks
are welcome, but please give yours a different name and don't suggest it is
the official project.
