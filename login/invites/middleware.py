"""
Abuse guard for the sign-in site.

allauth already rate-limits individual actions (code requests, logins, typed
invite codes) per IP and per email. This adds a second layer on top: an IP
that keeps hammering those limits, or keeps submitting wrong invite codes, is
shut out entirely for a while, so a bot can't just keep probing at the
allowed rate all day.

Deliberately conservative, because the shelter's Wi-Fi puts many volunteers
behind ONE public IP:
  - signed-in visitors are never blocked or counted;
  - only clear abuse counts (429 rate-limit responses, wrong invite codes);
  - the threshold is well above what a confused human can reach;
  - a ban expires by itself after 30 minutes.
The real client IP comes from Cloudflare's CF-Connecting-IP header. That is
safe to trust here only because the firewall admits Cloudflare alone on 80/443.
"""
import ipaddress
import logging

from django.core.cache import cache
from django.http import HttpResponse

logger = logging.getLogger("abuse")

STRIKE_WINDOW = 10 * 60      # strikes are counted over 10 minutes
STRIKE_LIMIT = 25            # this many strikes in the window -> ban
BAN_SECONDS = 30 * 60
EXEMPT_PREFIXES = ("/internal/", "/static/")  # Caddy's own auth subrequests, assets


def client_ip(request):
    raw = request.headers.get("CF-Connecting-IP") or request.META.get("REMOTE_ADDR", "")
    try:
        return str(ipaddress.ip_address(raw.strip()))
    except ValueError:
        return request.META.get("REMOTE_ADDR", "unknown")


class AbuseGuardMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(EXEMPT_PREFIXES):
            return self.get_response(request)
        user = getattr(request, "user", None)
        signed_in = bool(user and user.is_authenticated)
        ip = client_ip(request)

        if not signed_in and cache.get(f"abuse:ban:{ip}"):
            return HttpResponse(
                "Too many failed attempts from this network. Please wait a while and try again, "
                "or ask the volunteer coordinator for help.",
                status=403,
                content_type="text/plain",
            )

        response = self.get_response(request)

        if not signed_in and self._is_strike(request, response):
            key = f"abuse:strikes:{ip}"
            try:
                strikes = cache.incr(key)
            except ValueError:
                cache.set(key, 1, STRIKE_WINDOW)
                strikes = 1
            if strikes >= STRIKE_LIMIT and not cache.get(f"abuse:ban:{ip}"):
                cache.set(f"abuse:ban:{ip}", 1, BAN_SECONDS)
                logger.warning("[abuse] blocked %s for %ss after %s strikes", ip, BAN_SECONDS, strikes)
        return response

    @staticmethod
    def _is_strike(request, response):
        if response.status_code == 429:
            return True
        # A wrong typed invite code (join page answers 400 to a bad guess).
        return request.method == "POST" and request.path.rstrip("/") == "/join" and response.status_code == 400
