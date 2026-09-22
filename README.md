# Shelter Walk

A mobile-first web app that helps volunteers at an animal shelter walk dogs
safely and fairly: who is available to walk, who has been out, what each dog
needs, and how the shelter is doing as a whole.

It is two small apps behind one reverse proxy:

| Folder | What it is | Stack |
|---|---|---|
| [`app/`](app) | The walking app: available dogs, QR scan, timed walks, stats, updates feed, guide, notes | Node, Express, SQLite (better-sqlite3), plain JavaScript front end (PWA) |
| [`login/`](login) | Invite-only sign-in: email codes and passkeys, staff tools, invite codes | Django, django-allauth |
| [`deploy/`](deploy) | Reverse proxy config, systemd units, backup scripts, health check, env templates | Caddy, systemd |

Caddy sends every request for the app through the login site first
(`forward_auth`). The login site answers with the signed-in email, and the app
trusts only that header, which it can only receive from Caddy.

This is an independent volunteer project. It is not affiliated with, or
endorsed by, any shelter or county. It reads the shelter's public adoptable
dog listings; no shelter data, photos, or volunteer data are in this repository.

## Features

- **Available list** with filters, experience levels, and time-slot awareness
- **Scan a kennel QR code**, start a timed walk, add notes at the end
- **Walk limits:** walks stop automatically after 20 minutes (extendable to 3
  hours) and are flagged as automatically stopped
- **Stats:** personal stats, plus **Together**, anonymous shelter-wide totals
- **Updates feed:** new, returned, and adopted dogs
- **Guide (wiki):** staff-editable sections with sticker meanings and images
- **Dog notes:** an anonymous shared "whiteboard" of tips, plus private notes
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
- Deleting an account removes the login and all personal data first, then
  detaches walk history from the person (`user_id` becomes NULL).

## Security notes

- Every query uses bound parameters; user text is escaped or sanitized before
  display; a strict Content-Security-Policy blocks inline and third-party script.
- The login site rate-limits sign-in and invite guessing per real client IP and
  temporarily bans abusive IPs. Sign-in codes are invalidated after 3 wrong tries.
- Secrets are read from environment files only. Nothing in this repository is a
  credential; see `deploy/env/*.example`.

If you find a security problem, please open a private security advisory on
GitHub rather than a public issue.

## Running it locally

App (Node 20+):

    cd app
    npm install
    DISABLE_SCRAPER=1 npm start        # http://127.0.0.1:3000
    npm test

In production the app receives `X-Auth-Email` and `X-Auth-Staff` headers from
the proxy. For local experiments, put a tiny proxy in front that injects them.
Never expose the app port directly: it trusts those headers.

Login site (Python 3.12+):

    cd login
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    export DJANGO_DEBUG=1 SITE_URL=http://127.0.0.1:8000
    python manage.py migrate && python manage.py createcachetable
    python manage.py create_staff you@example.org --superuser
    python manage.py runserver
    DJANGO_DEBUG=1 python manage.py test invites

See [`login/SPEC.md`](login/SPEC.md) for the login site's requirements.

## Deploying

`deploy/` holds what runs on the single server: `Caddyfile`, systemd units for
both apps, nightly database backups, weekly photo backups, and a health check
that emails when something breaks. Copy `deploy/env/*.example` to
`/etc/dogwalk/env` and `/etc/shelterapp/env`, fill in real values, and keep
them out of version control (`chmod 600`). The value of `INTERNAL_API_TOKEN`
and `DOGWALK_INTERNAL_TOKEN` must match.

Replace the example domains and email addresses with your own.

## Third-party code

`app/public/js/html5-qrcode.min.js` is the [html5-qrcode](https://github.com/mebjas/html5-qrcode) library (Apache-2.0), vendored unmodified for the QR scanner. Other dependencies come from npm and PyPI.

## License

MIT, see [LICENSE](LICENSE).
