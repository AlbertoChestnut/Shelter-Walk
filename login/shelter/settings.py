"""
Django settings for the shelter volunteer app.

Everything environment-specific comes from environment variables so the
same file works for local dev and production. See README.md for the list.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG", False)

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "dev-only-insecure-key-do-not-use-in-production"
    else:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off")

# Public address of THIS app (account/invite pages), e.g. https://login.example.org
# Used for invite links, QR codes, and absolute login redirects so they never
# point at a LAN address or (once other apps live on their own subdomain,
# gated behind this one via forward_auth) at the wrong host.
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")

# Where to send someone right after they sign in. This is normally the
# volunteer-facing app (e.g. the dog-walk tracker), not this account app --
# this app exists mainly to gate access to that one. Falls back to SITE_URL
# so a bare deployment (no separate app yet) still has somewhere to land.
DOGWALK_APP_URL = os.environ.get("DOGWALK_APP_URL", "").rstrip("/") or SITE_URL

# Server-to-server access to the dog-walk app's own API (a separate Node
# service with its own SQLite database), used only by the staff panel's
# walker-permissions page -- there's no dogwalk account to attribute the
# call to when the caller is this service rather than a browser session, so
# it presents this shared secret instead (see dogwalk's isInternalRequest()
# in server.js).
DOGWALK_API_URL = os.environ.get("DOGWALK_API_URL", "http://127.0.0.1:3000").rstrip("/")
DOGWALK_INTERNAL_TOKEN = os.environ.get("DOGWALK_INTERNAL_TOKEN", "")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",  # needed by allauth's passkey list template
    "allauth",
    "allauth.account",
    "allauth.mfa",
    "allauth.socialaccount",
    "allauth.socialaccount.providers.google",
    "invites",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    # After authentication (it never blocks signed-in visitors).
    "invites.middleware.AbuseGuardMiddleware",
]

ROOT_URLCONF = "shelter.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "shelter.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": Path(os.environ.get("DJANGO_DB_PATH", BASE_DIR / "db.sqlite3")),
    }
}

# Rate limits are stored in the cache. The default local-memory cache is
# per-process, so if you run multiple gunicorn workers, switch this to a
# shared cache (database cache or Redis) or the limits are per-worker.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "django_cache",
    }
}

AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = os.environ.get("DJANGO_TIME_ZONE", "America/New_York")
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LOGIN_URL = "account_login"
LOGIN_REDIRECT_URL = "home"

# --- Sessions -------------------------------------------------------------
# Database-backed sessions (Django's default) so they can be revoked.
#
# Volunteers should never be logged out on their own — the only ways a
# session should end are staff disabling the account (checked on every
# request via ModelBackend.get_user) or deleting the Session row directly.
# True "never expires" isn't something a cookie can do, so this uses a
# sliding window instead: SESSION_SAVE_EVERY_REQUEST re-issues a fresh
# 60-day cookie on every request (including, but not limited to, signing
# in), so as long as someone uses the app at least once every 60 days their
# session renews indefinitely. Only someone who stays away longer than that
# would see it lapse on its own.
SESSION_COOKIE_AGE = 60 * 60 * 24 * 60  # 60 days
SESSION_SAVE_EVERY_REQUEST = True  # slide the expiry forward on every request
# Set to e.g. ".shelterwalk.com" so the same session cookie is visible to
# other apps on a subdomain gated behind this one via Caddy's forward_auth
# (see invites.views.forward_auth_check). Unset in dev.
SESSION_COOKIE_DOMAIN = os.environ.get("SESSION_COOKIE_DOMAIN") or None
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

# --- HTTPS / proxy ----------------------------------------------------------
# If you run behind a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel)
# that terminates TLS, set DJANGO_BEHIND_PROXY=1 so Django trusts its
# X-Forwarded-Proto header.
if env_bool("DJANGO_BEHIND_PROXY", False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

if not DEBUG:
    SECURE_SSL_REDIRECT = env_bool("DJANGO_SSL_REDIRECT", True)
    SECURE_HSTS_SECONDS = 60 * 60 * 24 * 30
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"

# --- Email ------------------------------------------------------------------
# Resend over SMTP: host smtp.resend.com, user "resend", password = API key.
DEFAULT_FROM_EMAIL = os.environ.get("DJANGO_FROM_EMAIL", "Shelter Volunteers <no-reply@example.org>")
if os.environ.get("EMAIL_HOST"):
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = os.environ["EMAIL_HOST"]
    EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
    EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
    EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
    EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
    EMAIL_TIMEOUT = 15
else:
    # No SMTP configured: print emails (and login codes) to the console.
    EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# --- django-allauth ---------------------------------------------------------
# Passwordless: people sign up with just an email, verify it with a code,
# and sign in later with an emailed code or Google.
ACCOUNT_ADAPTER = "invites.adapters.InviteOnlyAccountAdapter"
ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_SIGNUP_FIELDS = ["email*"]
ACCOUNT_UNIQUE_EMAIL = True
# One email per account, full stop — the account page shows only "change
# email" (verify the new one, then it replaces the old), not allauth's
# default multi-address management (add/remove/set-primary).
ACCOUNT_CHANGE_EMAIL = True
ACCOUNT_USER_MODEL_USERNAME_FIELD = "username"
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True
ACCOUNT_LOGIN_BY_CODE_ENABLED = True
ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = True
ACCOUNT_SESSION_REMEMBER = True
ACCOUNT_EMAIL_SUBJECT_PREFIX = "[Shelter Volunteers] "
# Don't send "no account found" emails when someone types an unknown address
# into the sign-in form. The page still looks identical either way, so it
# doesn't reveal who has an account, and it keeps strangers from using your
# domain to email arbitrary people.
ACCOUNT_EMAIL_UNKNOWN_ACCOUNTS = False

# --- Passkeys (WebAuthn) ---------------------------------------------------
# A full, standalone way to sign in -- not a second factor on top of the
# email code. Someone who's added a passkey (Account > Manage passkeys) sees
# a "Sign in with a passkey" button right on the login page, alongside the
# email-code form; either one gets them in on its own.
MFA_SUPPORTED_TYPES = ["webauthn"]
MFA_PASSKEY_LOGIN_ENABLED = True

# Merged with allauth's defaults, which stay in effect for everything else.
ACCOUNT_RATE_LIMITS = {
    # Typed invite codes that don't match, per IP (the invite code page).
    "invite_code_failed": "20/h/ip",
    # Sign-in code emails. Tighter than allauth's per-minute default so one
    # person spamming a volunteer's address can't burn through a free email
    # plan's daily cap (Resend free = 100/day) and lock everyone else out.
    "request_login_code": "20/h/ip,5/h/key",
}

# How many reverse proxies sit in front of Django. allauth uses this to find
# the real client IP for rate limiting. 0 = Django is hit directly.
# Behind one proxy (e.g. Caddy or nginx) set this to 1.
ALLAUTH_TRUSTED_PROXY_COUNT = int(os.environ.get("ALLAUTH_TRUSTED_PROXY_COUNT", "0"))
# If you're behind Cloudflare, use its header instead of X-Forwarded-For:
if os.environ.get("ALLAUTH_TRUSTED_CLIENT_IP_HEADER"):
    ALLAUTH_TRUSTED_CLIENT_IP_HEADER = os.environ["ALLAUTH_TRUSTED_CLIENT_IP_HEADER"]

# Google sign-in. Only enabled when both env vars are set.
SOCIALACCOUNT_PROVIDERS = {}
if os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET"):
    SOCIALACCOUNT_PROVIDERS["google"] = {
        "APPS": [
            {
                "client_id": os.environ["GOOGLE_CLIENT_ID"],
                "secret": os.environ["GOOGLE_CLIENT_SECRET"],
            }
        ],
        "SCOPE": ["openid", "profile", "email"],
        "AUTH_PARAMS": {"access_type": "online"},
        "OAUTH_PKCE_ENABLED": True,
    }
SOCIALACCOUNT_ONLY = False
SOCIALACCOUNT_LOGIN_ON_GET = False
SOCIALACCOUNT_AUTO_SIGNUP = True
# Let an existing account sign in with Google when the Google email matches
# a verified email on that account.
SOCIALACCOUNT_EMAIL_AUTHENTICATION = True
SOCIALACCOUNT_EMAIL_AUTHENTICATION_AUTO_CONNECT = True
SOCIALACCOUNT_EMAIL_VERIFICATION = "none"  # Google already verified it
SOCIALACCOUNT_STORE_TOKENS = False

# --- Logging ----------------------------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {
        "invites": {"handlers": ["console"], "level": "INFO"},
        "abuse": {"handlers": ["console"], "level": "INFO"},
    },
}
