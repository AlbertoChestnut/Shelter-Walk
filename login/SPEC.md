# Shelter Volunteer App: Authentication and Invite System Requirements

## 1. Context

This is a web app for volunteers at an animal shelter (dog walkers and similar roles). This first phase builds only the account system: invite-only signup, passwordless sign-in, and staff tools to manage invites and approve accounts. The actual volunteer features come later and should plug into the authenticated user this phase produces.

There are two kinds of people:

- **Volunteers** create an account through an invite and sign in on their phones, usually for months at a time.
- **Staff** (volunteer coordinators) create invites, print the QR sign for the volunteer room, approve pending accounts, and disable accounts.

The developer codes in Python, is comfortable with Linux, and prefers complete files over partial diffs.

### Explicitly out of scope

- **Better Impact integration.** This was considered and dropped. There is no sync with Better Impact's API and no volunteer-status checks against it. Invites replace it as the gate.
- **Passwords.** No volunteer ever creates or types a password.
- **Building auth primitives from scratch.** Use a validated library for all security-critical code (Section 2).

## 2. Technology decisions

| Area | Decision | Reason |
|---|---|---|
| Language | Python 3.12+ | Developer preference |
| Framework | Django (current stable, 6.x) | Mature, built-in admin gives staff a back office for free, DB-backed sessions |
| Auth library | `django-allauth[socialaccount]` >= 65.18, < 66 | Widely used, actively maintained. Has email login-by-code, email verification by code, Google login, rate limiting, and enumeration protection built in. 65.18+ uses RFC 8628-style dashed codes (e.g. `WDJB-MJHT`) and has the `authenticate_by_email` social hook. |
| QR codes | `qrcode` (SVG output, no Pillow needed) | Simple and pure Python |
| Database | SQLite to start | Small user base. Keep the ORM portable so Postgres is a drop-in later. |
| Cache | Django database cache (`createcachetable`) | allauth rate limits live in the cache. Local-memory cache would be per-process and break limits under multiple gunicorn workers. |
| Email | Resend over SMTP (`smtp.resend.com`, user `resend`, password = API key) | Free tier is 3,000 emails/month, capped at 100/day, one verified domain. Enough for a shelter-sized volunteer list. |
| Dev email | Django console backend when `EMAIL_HOST` is unset | Login codes print to the terminal |
| App server | gunicorn behind a TLS-terminating reverse proxy (Caddy, nginx, Traefik, or Cloudflare Tunnel) | Standard Django deployment |

Do not use FastAPI Users (maintenance mode, password-centric). Do not use Supabase or other hosted auth for this phase. Do not hand-roll token generation, code hashing, or session handling. allauth and Django own those.

## 3. Authentication requirements

### 3.1 Passwordless email sign-in (primary method)

- Signup asks for **email only**: `ACCOUNT_SIGNUP_FIELDS = ["email*"]`. Users are created with an unusable password.
- Login identifies users by email: `ACCOUNT_LOGIN_METHODS = {"email"}`.
- Email verification is **mandatory** and **by code**, not by link. The code is emailed and typed into the page.
  - Settings: `ACCOUNT_EMAIL_VERIFICATION = "mandatory"`, `ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True`, `ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = True`.
- Later sign-ins use an emailed **login code**: `ACCOUNT_LOGIN_BY_CODE_ENABLED = True`.
- The login page must show only the email field, with no password field. Submitting it sends a code and goes to the code-confirmation page. (allauth does this automatically when `password1` isn't in `SIGNUP_FIELDS`.)

**Why codes instead of magic links.** On phones, tapping an emailed link usually opens it in the mail app's in-app browser, not the browser where the person started, so they end up signed in in the wrong place. Also, corporate email security scanners (e.g. Outlook Safe Links) prefetch links, which can use up single-use tokens before the person clicks. Typed codes avoid both problems.

### 3.2 Google sign-in (optional convenience)

- Enable only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars are set. The app must work fully without them.
- Scopes: `openid`, `profile`, `email` only. These are Google's non-sensitive scopes, so the OAuth app can be published to production without Google's verification review. Brand verification (showing the shelter's name and logo on the consent screen) is optional and needs a homepage and privacy policy on a domain the shelter controls.
- Use PKCE (`OAUTH_PKCE_ENABLED: True`) and `access_type: online`. Don't store provider tokens: `SOCIALACCOUNT_STORE_TOKENS = False`.
- An existing account may sign in with Google when the Google email matches a verified email on the account: `SOCIALACCOUNT_EMAIL_AUTHENTICATION = True`, `SOCIALACCOUNT_EMAIL_AUTHENTICATION_AUTO_CONNECT = True`. allauth stores Google's stable `sub` ID, so matching after the first link doesn't depend on the email.
- A *new* account created through Google must pass the same invite gate as email signup (Section 4.4).
- Known edge case, optional for this phase: Gmail ignores dots, so `j.smith@gmail.com` and `jsmith@gmail.com` are the same inbox. If mismatches show up in practice, normalize dots for `gmail.com` addresses via allauth's `authenticate_by_email` hook.
- Sign in with Apple is out of scope because it requires a paid Apple Developer membership.

### 3.3 Sessions

- Use Django's default **database-backed** sessions so they can be revoked. Do not use signed-cookie sessions.
- Session length: 60 days (`SESSION_COOKIE_AGE = 60 * 60 * 24 * 60`), with `ACCOUNT_SESSION_REMEMBER = True`. Volunteers should rarely need to sign in again.
- Cookies: `HttpOnly`, `SameSite=Lax`, `Secure` whenever `DEBUG` is off. Same for the CSRF cookie.
- Setting a user's `is_active = False` must end their access on their **next request**, even with a valid session cookie. Django's `ModelBackend.get_user` already does this; keep that behavior and cover it with a test.

## 4. Invite-only signup

### 4.1 Goal

Nobody can create an account without an invite. The coordinator needs two ways to hand out invites:

1. **Direct invites** for one person, sent by text or email. Typically single-use.
2. **A posted QR code** in the volunteer room. Multi-use with a configurable cap, or unlimited.

This gate also cuts down on spam accounts and random attackers, since the signup form is closed to anyone without an invite.

### 4.2 `InviteCode` model

| Field | Type | Notes |
|---|---|---|
| `code` | CharField(32), unique, not editable | Generated with `secrets.choice` (never `random`). 12 characters from the alphabet `23456789ABCDEFGHJKMNPQRSTVWXYZ`, which drops 0/O, 1/I/L, and U so codes are easy to read off a poster. That's about 5×10^17 possibilities (~59 bits). Stored without dashes. |
| `label` | CharField(120), required | e.g. "Volunteer room QR" or "Jane Smith" |
| `max_uses` | PositiveIntegerField, nullable, default 1 | `NULL` means unlimited |
| `use_count` | PositiveIntegerField, default 0, not editable | Incremented only by the atomic claim (4.5) |
| `expires_at` | DateTimeField, nullable | Optional hard cutoff |
| `is_active` | BooleanField, default True | Kill switch that takes effect immediately |
| `requires_approval` | BooleanField, default False | If True, accounts created with this invite start **disabled** until staff approve them. Recommended for posted QR codes. |
| `created_by` | FK User, nullable, SET_NULL, not editable | Set automatically in the admin on create |
| `created_at` | auto_now_add | |

Required methods and helpers:

- `formatted_code` shows the code as `XXXX-XXXX-XXXX`.
- `remaining_uses` returns the number left, or `None` for unlimited.
- `is_usable()` is True only if the invite is active, not expired, and has uses left.
- A queryset `usable()` applies the same conditions in SQL.
- `get_join_path()` returns `/join/<code>/`.
- `get_join_url(request=None)` prefers the `SITE_URL` setting and falls back to `request.build_absolute_uri`. QR codes and shared links must use `SITE_URL` so they never encode a LAN or localhost address, even when staff are using the admin from the local network.
- `normalize_code(raw)` uppercases the input and strips everything that isn't alphanumeric, so `abcd-efgh-jkmn`, `ABCD EFGH JKMN`, and `ABCDEFGHJKMN` all match.

### 4.3 `InviteRedemption` model (audit trail)

- `invite`: FK to `InviteCode`, `on_delete=PROTECT`. Invites that have been used can't be deleted; staff turn them off instead, which keeps the audit trail.
- `user`: OneToOne to User, CASCADE, `related_name="invite_redemption"`.
- `redeemed_at`: auto_now_add.

This lets staff answer "which invite did this person use?" and find every account created from a leaked QR code.

### 4.4 Signup flow

1. A person scans the QR code or opens `/join/<code>/`.
   - If the invite is usable, store its primary key in the session and redirect to the allauth signup page.
   - If it isn't (unknown, expired, used up, or turned off), show a clear page with a 404 status: "That invite isn't working. The code is wrong, has expired, or has already been used the maximum number of times." Include a form to try a typed code.
   - If the person is already signed in, redirect home with an "already signed in" message.
2. Alternatively, a person goes to `/join/` and types the code from the poster. A valid code does the same as step 1. An invalid one shows the error with a 400 status and keeps what they typed in the field.
3. Signup gating lives in a custom account adapter: `ACCOUNT_ADAPTER = "invites.adapters.InviteOnlyAccountAdapter"`. It overrides `is_open_for_signup(request)` to return True only when the session holds an invite that is still usable. allauth's social adapter defers to this method by default, so **Google signups are gated by the same check with no extra code**. Verify this with a test.
4. Visiting `/accounts/signup/` without a valid invite shows an overridden `account/signup_closed.html`: "You need an invite to join", a button to the typed-code page, and a sign-in link.
5. If an invite is turned off after someone opens the link but before they submit the signup form, the signup must be refused.

### 4.5 Counting uses (atomic, race-safe)

- A use is consumed when the **account is created**, not when the link is opened. Link previews and email scanners that open the link must not burn uses.
- Consume the use in a receiver for allauth's `user_signed_up` signal. It fires for both email and Google signups, after the user is saved and before login.
- The claim must be one atomic conditional UPDATE, not read-then-write:

  ```python
  InviteCode.objects.usable().filter(pk=invite.pk).update(use_count=F("use_count") + 1) == 1
  ```

- Signal handler behavior:
  - Pop the invite from the session so it can't be reused in that session.
  - **Claim succeeded:** create the `InviteRedemption`. If `requires_approval` is set, set `user.is_active = False`. allauth then shows the "account inactive" page instead of logging them in.
  - **Claim failed** (two people raced for the last use and this one lost): still create the redemption for the audit trail, but set `user.is_active = False` so staff can review. Do not silently let them in, and do not delete the account.
  - **No invite in session** (shouldn't be possible, but handle it defensively): set `is_active = False` and log a warning.
- Log each signup with the invite ID at INFO level, and anomalies at WARNING level.

### 4.6 Approval flow

- Override `account/account_inactive.html` with: "Your account is waiting for approval. A volunteer coordinator needs to approve new accounts before you can sign in. Once they do, sign in with the same email address."
- After staff approve an account (set `is_active = True`), the volunteer signs in with an emailed code. This must work in a single step without a second verification email. Cover it with a test.

## 5. Staff tools (Django admin)

### 5.1 Admin sign-in

- Route the admin login through allauth: `admin.site.login = secure_admin_login(admin.site.login)` using `allauth.account.decorators.secure_admin_login`. Staff sign in the same way as everyone else (emailed code or Google) and get allauth's rate limits. There is no separate admin password form.

### 5.2 `create_staff` management command

Accounts made with `createsuperuser` have no allauth `EmailAddress` row. Code sign-in then triggers a second verification step, so staff would need two codes. Replace it with a command:

```
python manage.py create_staff coordinator@theirshelter.org
python manage.py create_staff you@example.org --superuser
```

The command must:

- Validate the email address.
- Create the user with an unusable password, or promote the user if one already exists with that email.
- Set `is_staff = True` and `is_active = True`.
- Create or update a **verified, primary** `EmailAddress` row.
- Without `--superuser`, grant only these permissions: `add_invitecode`, `change_invitecode`, `view_invitecode`, `view_inviteredemption`, `view_user`, `change_user`. Notably, no delete permission on invites.
- Print a clear success message.

### 5.3 Invite admin

- **List columns:** label, formatted code, uses shown as "3 of 10" or "3 of unlimited", expiry, active, requires approval, a "Working" boolean (`is_usable()`), and a "Print" link.
- **Filters:** active, requires approval. **Search:** label, code.
- **Change form sections:**
  - Main: label, max_uses, expires_at, is_active, requires_approval.
  - Share it: formatted code, full invite link, inline QR preview, "Open printable sign" link, "Download QR (SVG)" link.
  - History: use_count, created_by, created_at.
- Read-only inline listing the accounts created with this invite: user, whether they're active, and when they redeemed.
- Bulk action: "Turn off selected invites".
- Don't store `request` on the ModelAdmin instance to build URLs. Admin instances are shared across requests and threads. Use `SITE_URL`.

### 5.4 QR code and printable sign

- `/staff/invites/<pk>/qr.svg` returns the QR code as SVG, staff only (`staff_member_required`). Encode `get_join_url()` with medium error correction.
- `/staff/invites/<pk>/print/` is a letter-size printable sign, staff only. It shows a large headline ("Volunteering here?"), "Scan to create your volunteer account.", a large QR code, a fallback line ("No camera? Go to <SITE_URL>/join/ and enter" followed by the formatted code in large type), and the label and expiry date in small print. The "Print this sign" button is hidden with `@media print`.

### 5.5 User admin (replace the default)

- **Columns:** email, name, active, staff, "Joined via" (the invite label), date joined.
- **Filters:** active, staff, which invite they joined with.
- Read-only inline showing the redemption.
- **Actions:** "Approve selected accounts" (activates inactive users) and "Disable selected accounts". Disabling takes effect on the user's next page load.
- **Privilege-escalation guards** for staff who aren't superusers:
  - `is_staff`, `is_superuser`, `groups`, `user_permissions`, and `password` are read-only.
  - Superuser accounts can't be edited: `has_change_permission` returns False for them.
  - The bulk actions skip the acting user, all staff, and all superusers.

## 6. Security requirements

### 6.1 Rate limits

Configure these through `ACCOUNT_RATE_LIMITS`, which merges with allauth's defaults.

| Action | Limit | Why |
|---|---|---|
| `invite_code_failed` (custom) | `20/h/ip` | Wrong codes on the typed-code form. Check with `ratelimit.consume(..., dry_run=True)` before looking up the code, and consume only on failure. Once the limit is hit, even correct codes are refused until the window passes. Return 429 with a "Too many tries" page. |
| `request_login_code` | `20/h/ip,5/h/key` | Stricter than allauth's per-minute default. Otherwise someone spamming one volunteer's address could use up Resend's 100-emails-per-day free cap and block every other login that day. |
| `login_failed`, `signup`, `confirm_email`, others | allauth defaults | Already cover per-IP and per-account failed attempts |

- **Do not rate limit `GET /join/<code>/`.** Everyone scanning the poster on the shelter's Wi-Fi shares one public IP, so a per-IP limit would lock out real volunteers. Guessing a 12-character code by URL is hopeless anyway (~5×10^17 possibilities). allauth's limiter also ignores GET requests by design.
- Set `ALLAUTH_TRUSTED_PROXY_COUNT` from an env var: 0 when Django is reached directly, 1 behind a single reverse proxy. If behind Cloudflare, set `ALLAUTH_TRUSTED_CLIENT_IP_HEADER` (e.g. `CF-Connecting-IP`) instead. Never trust `X-Forwarded-For` blindly, because it can be spoofed to dodge rate limits.

### 6.2 Enumeration and email abuse

- Keep allauth's enumeration protection on (the default). The sign-in page must look identical whether or not the email has an account.
- Set `ACCOUNT_EMAIL_UNKNOWN_ACCOUNTS = False` so typing an unknown address sends no email at all. This stops strangers from using the shelter's sending domain to email arbitrary people, and protects the daily email cap.

### 6.3 Codes

- allauth generates, stores, expires, and limits attempts for login and verification codes. Keep its defaults:
  - RFC 8628 dashed format (e.g. `WDJB-MJHT`), a much larger space than 6-digit codes.
  - Login codes expire after 3 minutes, verification codes after 15.
  - 3 wrong attempts per code.
- Invite codes use `secrets` and the unambiguous alphabet described in Section 4.2.

### 6.4 HTTPS and headers (when `DEBUG` is off)

- `SECURE_SSL_REDIRECT` (on by default, can be turned off by env var), HSTS for 30 days, `SECURE_CONTENT_TYPE_NOSNIFF`, and `SECURE_REFERRER_POLICY = "same-origin"`.
- `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` only when `DJANGO_BEHIND_PROXY=1`.
- Refuse to start if `DJANGO_SECRET_KEY` is missing and `DEBUG` is off. A dev-only fallback key is allowed only when `DEBUG` is on.

### 6.5 Accepted risk, to note in the README

Emailed codes can be phished in real time: a fake site asks for the code and passes it to the real one. That's acceptable for regular volunteers. If staff accounts later gain sensitive powers, such as volunteer contact details or dog behavior records, require Google sign-in or passkeys for staff. allauth supports both.

## 7. Email deliverability

- Send from a domain the shelter controls, ideally a subdomain like `app.theirshelter.org`. Set up SPF, DKIM, and DMARC through Resend's domain verification. This requires DNS access, usually from the shelter's IT or web person.
- Configuration via `EMAIL_HOST`, `EMAIL_PORT` (587), `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS`, and `DJANGO_FROM_EMAIL`. Set `EMAIL_TIMEOUT = 15`.
- Subject prefix: `[Shelter Volunteers] `.

## 8. Configuration (environment variables)

| Variable | Required | Purpose |
|---|---|---|
| `DJANGO_SECRET_KEY` | Prod | Secret key |
| `DJANGO_DEBUG` | No | `1` for local dev |
| `DJANGO_ALLOWED_HOSTS` | Prod | Comma-separated hostnames |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | Prod | e.g. `https://volunteers.theirshelter.org` |
| `SITE_URL` | Prod | Public base URL used in invite links and QR codes |
| `DJANGO_DB_PATH` | No | SQLite file location (put it on a volume that gets backed up) |
| `DJANGO_TIME_ZONE` | No | Default `America/New_York` |
| `DJANGO_BEHIND_PROXY` | No | `1` to trust `X-Forwarded-Proto` |
| `DJANGO_SSL_REDIRECT` | No | Default on when `DEBUG` is off |
| `ALLAUTH_TRUSTED_PROXY_COUNT` | No | Number of proxies in front of Django |
| `ALLAUTH_TRUSTED_CLIENT_IP_HEADER` | No | e.g. `CF-Connecting-IP` |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS` | Prod | SMTP (Resend) |
| `DJANGO_FROM_EMAIL` | Prod | e.g. `Shelter Volunteers <no-reply@app.theirshelter.org>` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | No | Turns on Google sign-in when both are set |

## 9. Pages and UI

- A shared `templates/base.html` layout. Override `templates/allauth/layouts/base.html` to extend it, so allauth's sign-in, sign-up, and code pages match the rest of the site.
- Mobile-first, since most volunteers will be on phones: a single ~34rem column, large tap targets, visible keyboard focus outlines, and a system font stack.
- Header: app name, plus "Staff" (for staff), "Account", and "Sign out" when signed in, or "Sign in" when signed out.
- Invite code input: `autocapitalize="characters"`, `autocomplete="off"`, `spellcheck="false"`, placeholder `ABCD-EFGH-JKMN`.
- Copy is plain and direct. Error messages say what went wrong and what to do next, without apologizing.
- `/` is a login-required placeholder home page ("You're signed in"), where the real volunteer features will go later.

### URL map

| URL | View |
|---|---|
| `/` | Home (login required) |
| `/join/` | Type an invite code (GET, POST) |
| `/join/<code>/` | Invite link / QR landing page (GET) |
| `/accounts/…` | allauth |
| `/admin/` | Django admin (staff) |
| `/staff/invites/<pk>/qr.svg` | QR SVG (staff) |
| `/staff/invites/<pk>/print/` | Printable sign (staff) |

## 10. Acceptance tests (all must pass: `python manage.py test`)

Use the locmem email backend and pull codes out of the emails with the regex `\b([A-Z0-9]{4}-[A-Z0-9]{4})\b`. Clear the cache in `setUp` so rate limits don't carry over between tests.

1. Signup without an invite shows "You need an invite to join", and POSTing to signup creates no user.
2. An invite link redirects to signup. Signing up creates the user, adds 1 to `use_count`, creates a redemption, leaves the user active, and gives them no usable password.
3. A single-use invite can't be used a second time: the link returns 404 and signup is refused.
4. A `max_uses=3` invite allows exactly 3 signups, then returns 404.
5. An unlimited invite (`max_uses=None`) allows many signups.
6. Expired and turned-off invites return 404.
7. An invite turned off after the link was opened causes signup to be refused.
8. A typed code works regardless of case, dashes, or spaces.
9. 20 wrong typed codes each return 400. The 21st attempt returns 429, and a valid code is also refused while limited.
10. A `requires_approval` invite creates an inactive user, redirects to the account-inactive page, and doesn't log them in.
11. After approval, the user signs in with a single emailed code and lands on home.
12. **Race:** two sessions open the last remaining use. The first signs up normally. The second, simulated by patching `is_open_for_signup` to True, gets created but stays inactive, and `use_count` stays at 1.
13. The Google/social adapter's `is_open_for_signup` is False without an invite in the session and True with one.
14. Requesting a sign-in code for an unknown email redirects like normal but sends no email.
15. Full flow: sign up, enter the verification code, get signed in. Then from a new client, request a login code, enter it, and land on home.
16. Disabling a signed-in user: their next request to home redirects to login.
17. The QR SVG and print page redirect anonymous users, return 200 for staff, and the print page shows the formatted code.
18. With `SITE_URL` set, `get_join_url()` returns `https://…/join/<code>/`.
19. A `create_staff` account can reach `/admin/` and the "add invite" page after one emailed code.
20. A `create_staff` account without `--superuser` can add invites and change users, but can't delete invites.
21. Non-superuser staff can't open a superuser for editing, can't see editable `is_staff`/`is_superuser` fields on themselves, can approve volunteers, and can't disable superusers through the bulk action.

## 11. Deliverables

- A Django project (`shelter/`) and an app (`invites/`) containing: models, the adapter, the signal handler (registered in `AppConfig.ready()`), session helpers, views, URLs, admin, the `create_staff` command, migrations, and tests.
- Templates: `base.html`, `allauth/layouts/base.html`, `account/signup_closed.html`, `account/account_inactive.html`, `invites/join.html`, `invites/print.html`, `home.html`.
- `requirements.txt` pinned to compatible ranges: `Django>=6.1,<6.2`, `django-allauth[socialaccount]>=65.18,<66`, `qrcode>=8`, `gunicorn`.
- A `README.md` covering: local dev setup (`DJANGO_DEBUG=1`, `migrate`, `createcachetable`, `create_staff`, `runserver`, with codes printed to the console), production env vars, Resend domain setup, Google OAuth client setup (External audience, basic scopes, redirect URI `https://<host>/accounts/google/login/callback/`), reverse proxy settings, SQLite backups, and the accepted-risk note from Section 6.5.

## 12. Operational notes

- **Hosting.** If this runs on a homelab, the shelter's logins depend on that machine and its internet connection being up. Consider a small VPS or PaaS for production, and back up the SQLite file regularly.
- **Rotating the room QR code.** Give posted QR invites an expiry date and/or a use cap, and reprint periodically. If a code leaks (for example, a photo of the poster ends up online), turn it off, filter users by "Joined via" that invite, and disable any accounts that shouldn't be there.
- **Unverified accounts.** Uses are consumed at signup even if the person never verifies their email. That's acceptable because `max_uses` caps the damage. A future cleanup job can prune unverified accounts older than N days.
