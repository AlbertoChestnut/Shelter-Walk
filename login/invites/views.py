import hmac
import json
import logging
from urllib.parse import quote

import qrcode
import qrcode.image.svg
import requests
from allauth.account.mixins import NextRedirectMixin
from allauth.account.models import EmailAddress
from allauth.account.views import EmailView
from allauth.core import ratelimit
from allauth.mfa.models import Authenticator
from allauth.mfa.webauthn.views import AddWebAuthnView
from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.sessions.models import Session
from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.conf import settings
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_http_methods, require_POST

from .forms import InviteCodeForm
from .models import InviteCode, normalize_code
from .session import remember_invite

logger = logging.getLogger(__name__)

RATE_LIMIT_ACTION = "invite_code_failed"


def _lookup_usable(raw_code: str) -> InviteCode | None:
    code = normalize_code(raw_code)
    if not code:
        return None
    invite = InviteCode.objects.filter(code=code).first()
    if invite is None or not invite.is_usable():
        return None
    return invite


def _rate_limited(request) -> bool:
    """
    True if this IP has already had too many failed attempts on the typed-code
    form. Uses allauth's rate limiter, so it respects ALLAUTH_TRUSTED_PROXY_COUNT.
    (allauth only rate limits POST requests, which is what this form sends.)
    """
    return not ratelimit.consume(request, action=RATE_LIMIT_ACTION, dry_run=True)


def _record_failure(request) -> None:
    ratelimit.consume(request, action=RATE_LIMIT_ACTION)


def _too_many_attempts(request):
    return render(request, "invites/join.html", {"rate_limited": True}, status=429)


def _accept(request, invite: InviteCode):
    remember_invite(request, invite)
    return redirect("account_signup")


@require_http_methods(["GET"])
def join_with_code(request, code: str):
    """Landing page for invite links and QR codes: /join/<code>/"""
    if request.user.is_authenticated:
        messages.info(request, "You're already signed in.")
        return redirect("home")

    # Not rate limited: guessing a 12-character code by URL is hopeless
    # (~5e17 possibilities), and everyone scanning the poster from the
    # shelter's Wi-Fi shares one IP address.
    invite = _lookup_usable(code)
    if invite is None:
        return render(request, "invites/join.html", {"invalid": True}, status=404)
    return _accept(request, invite)


@require_http_methods(["GET", "POST"])
def join_enter_code(request):
    """Page where someone can type a code off the poster: /join/"""
    if request.user.is_authenticated:
        return redirect("home")
    if request.method == "GET":
        return render(request, "invites/join.html")

    if _rate_limited(request):
        return _too_many_attempts(request)

    invite = _lookup_usable(request.POST.get("code", ""))
    if invite is None:
        _record_failure(request)
        return render(
            request,
            "invites/join.html",
            {"invalid": True, "entered": request.POST.get("code", "")},
            status=400,
        )
    return _accept(request, invite)


@login_required
def home(request):
    if settings.DOGWALK_APP_URL:
        return redirect(settings.DOGWALK_APP_URL)
    return render(request, "home.html")


def forward_auth_check(request):
    """
    Gate for other apps on this box (e.g. the dog-walk tracker) that sit
    behind Caddy's `forward_auth`. Caddy calls this for every request to
    the protected site and only proxies through on a 2xx response; anything
    else (here, a redirect to sign in) is sent back to the browser as-is.

    Relies on SESSION_COOKIE_DOMAIN covering both this host and the
    protected subdomain, so the same session cookie is visible to both.

    On success, also tells Caddy (via `copy_headers` in the Caddyfile) to
    pass X-Auth-Email and X-Auth-Staff through to the protected app, so it
    knows who's using it (and whether to show admin-only features) without
    needing its own login of any kind.
    """
    if request.user.is_authenticated:
        return HttpResponse(status=204, headers={
            "X-Auth-Email": request.user.email,
            "X-Auth-Staff": "1" if request.user.is_staff else "0",
        })

    proto = request.headers.get("X-Forwarded-Proto", "https")
    host = request.headers.get("X-Forwarded-Host", request.get_host())
    uri = request.headers.get("X-Forwarded-Uri", "/")
    # A background API call from the already-open app (not a page load) can't
    # follow a redirect to another origin's login page -- the browser blocks
    # it and the app just sees an unexplained network failure. Answer those
    # with a plain 401 the app can recognize and explain ("sign in again").
    if uri.startswith("/api/"):
        return JsonResponse(
            {"error": "Your sign-in has expired. Reload the page to sign in again.", "sessionExpired": True},
            status=401,
        )
    next_url = f"{proto}://{host}{uri}"
    # Caddy relays this response back to the browser as-is, which is still
    # pointed at the PROTECTED app's domain (e.g. shelterwalk.com), not this
    # one -- so the login URL has to be absolute (this app now lives on its
    # own subdomain) or the browser tries to load /accounts/login/ on the
    # protected app's domain, which doesn't exist there.
    login_url = f"{settings.SITE_URL}{reverse('account_login')}?next={quote(next_url, safe='')}"
    return redirect(login_url)


def _site_url(request, path: str) -> str:
    base = getattr(settings, "SITE_URL", "").rstrip("/")
    return base + path if base else request.build_absolute_uri(path)


def _qr_svg(request, invite: InviteCode) -> str:
    url = invite.get_join_url(request)
    img = qrcode.make(
        url,
        image_factory=qrcode.image.svg.SvgPathImage,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        border=2,
    )
    return img.to_string(encoding="unicode")


@staff_member_required
def invite_qr_svg(request, pk: int):
    invite = get_object_or_404(InviteCode, pk=pk)
    response = HttpResponse(_qr_svg(request, invite), content_type="image/svg+xml")
    response["Content-Disposition"] = f'inline; filename="invite-{invite.pk}.svg"'
    return response


@staff_member_required
def invite_print(request, pk: int):
    """A printable sign with the QR code and the typed-code fallback."""
    invite = get_object_or_404(InviteCode, pk=pk)
    return render(
        request,
        "invites/print.html",
        {
            "invite": invite,
            "qr_svg": _qr_svg(request, invite),
            "join_url": invite.get_join_url(request),
            "enter_code_url": _site_url(request, reverse("invite_enter_code")),
        },
    )


# ---------------------------------------------------------------------------
# Staff panel — a small, task-focused replacement for Django's built-in
# /admin/ for the two things staff actually need day to day: managing invite
# codes and managing volunteer accounts. (The raw admin is still there for
# anything unusual, but its default UI isn't a good fit for these tasks —
# invite QR/print in particular predates it and isn't a model-CRUD screen.)
# ---------------------------------------------------------------------------


@staff_member_required
def staff_dashboard(request):
    return render(
        request,
        "invites/staff_dashboard.html",
        {
            "invite_count": InviteCode.objects.filter(is_active=True).count(),
            "user_count": get_user_model().objects.count(),
        },
    )


@staff_member_required
def staff_invite_list(request):
    invites = InviteCode.objects.all().select_related(None)
    return render(request, "invites/staff_invites.html", {"invites": invites})


@staff_member_required
def staff_invite_new(request):
    if request.method == "POST":
        form = InviteCodeForm(request.POST)
        if form.is_valid():
            invite = form.save(commit=False)
            invite.created_by = request.user
            invite.save()
            messages.success(request, f"Created invite “{invite.label}”.")
            return redirect("staff_invite_list")
    else:
        form = InviteCodeForm()
    return render(request, "invites/staff_invite_form.html", {"form": form})


@staff_member_required
@require_POST
def staff_invite_toggle(request, pk: int):
    invite = get_object_or_404(InviteCode, pk=pk)
    invite.is_active = not invite.is_active
    invite.save(update_fields=["is_active"])
    messages.success(request, f"{'Activated' if invite.is_active else 'Deactivated'} “{invite.label}”.")
    return redirect("staff_invite_list")


def _dogwalk_api(method: str, path: str, **kwargs):
    return requests.request(
        method,
        f"{settings.DOGWALK_API_URL}{path}",
        headers={"Authorization": f"Bearer {settings.DOGWALK_INTERNAL_TOKEN}"},
        timeout=5,
        **kwargs,
    )


@staff_member_required
def staff_walker_permissions(request):
    if request.method == "POST":
        walker_id = request.POST.get("walker_id")
        try:
            resp = _dogwalk_api(
                "PUT",
                f"/api/users/{walker_id}/permissions",
                json={
                    "isPrivileged": request.POST.get("is_privileged") == "on",
                    "canAudit": request.POST.get("can_audit") == "on",
                },
            )
            resp.raise_for_status()
            messages.success(request, "Updated.")
        except requests.RequestException as exc:
            messages.error(request, f"Couldn't reach the dog-walk app: {exc}")
        return redirect("staff_walker_permissions")

    walkers = []
    error = None
    try:
        resp = _dogwalk_api("GET", "/api/users")
        resp.raise_for_status()
        walkers = resp.json().get("users", [])
    except requests.RequestException as exc:
        error = f"Couldn't reach the dog-walk app: {exc}"
    return render(
        request,
        "invites/staff_walker_permissions.html",
        {"walkers": walkers, "error": error},
    )


@staff_member_required
def staff_user_list(request):
    users = get_user_model().objects.order_by("-date_joined")
    return render(request, "invites/staff_users.html", {"users": users})


@staff_member_required
@require_POST
def staff_user_force_signout(request, pk: int):
    user = get_object_or_404(get_user_model(), pk=pk)
    ended = 0
    for session in Session.objects.iterator():
        data = session.get_decoded()
        if str(data.get("_auth_user_id")) == str(user.pk):
            session.delete()
            ended += 1
    messages.success(request, f"Signed {user.email} out everywhere ({ended} session(s) ended).")
    return redirect("staff_user_list")


@staff_member_required
@require_POST
def staff_user_deactivate(request, pk: int):
    return _staff_user_set_active(request, pk, active=False)


@staff_member_required
@require_POST
def staff_user_reactivate(request, pk: int):
    return _staff_user_set_active(request, pk, active=True)


def _staff_user_set_active(request, pk: int, active: bool):
    user = get_object_or_404(get_user_model(), pk=pk)
    if user.pk == request.user.pk and not active:
        messages.error(request, "You can't deactivate your own account.")
        return redirect("staff_user_list")
    user.is_active = active
    user.save(update_fields=["is_active"])
    # No need to also end their session here: ModelBackend re-checks
    # is_active on every request (via get_user()), so this takes effect
    # immediately, not just on their next sign-in.
    messages.success(request, f"{'Reactivated' if active else 'Deactivated'} {user.email}.")
    return redirect("staff_user_list")


# ---------------------------------------------------------------------------
# Passkeys, folded into the Account page rather than kept as their own
# destination -- a passkey is a property of "your account" as far as
# volunteers are concerned, same as their email.
# ---------------------------------------------------------------------------


class AccountEmailView(EmailView):
    def get_context_data(self, **kwargs):
        ret = super().get_context_data(**kwargs)
        ret["passkeys"] = Authenticator.objects.filter(
            user=self.request.user, type=Authenticator.Type.WEBAUTHN
        )
        return ret


account_email = AccountEmailView.as_view()


class AddPasskeyView(NextRedirectMixin, AddWebAuthnView):
    """
    Passkeys here are always a full sign-in method, not a second factor on
    top of something else -- so unlike upstream there's no "Passwordless"
    checkbox: every key is created as a discoverable, passwordless
    credential (forced client-side, see the add_form.html override), and
    the name is asked for AFTER the browser ceremony succeeds rather than
    before, with a guessed default -- naming a physical thing you haven't
    created yet is backwards. NextRedirectMixin adds support for a ?next=
    so a caller (e.g. onboarding in the dog-walk app) can send someone here
    and get them back afterwards, same as RemoveWebAuthnView/EditWebAuthnView
    already do upstream.
    """

    pass


add_passkey = AddPasskeyView.as_view()


@csrf_exempt
@require_POST
def internal_delete_account(request):
    """
    Permanently deletes a volunteer's sign-in account. Called only by the
    Shelter Walk app (server to server, shared secret) after the volunteer has
    confirmed three times that they want this; there is no undo. Never
    reachable from the internet: Caddy answers 404 for /internal/ here.

    Staff and superuser accounts are refused, so this can never lock the
    coordinators out of the staff panel; they are removed there instead.
    """
    token = settings.DOGWALK_INTERNAL_TOKEN
    supplied = request.headers.get("Authorization", "")
    if not token or not hmac.compare_digest(supplied, f"Bearer {token}"):
        return JsonResponse({"error": "forbidden"}, status=403)
    try:
        email = str(json.loads(request.body or b"{}").get("email", "")).strip().lower()
    except (ValueError, AttributeError):
        return JsonResponse({"error": "bad request"}, status=400)
    if not email:
        return JsonResponse({"error": "email required"}, status=400)

    User = get_user_model()
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        address = EmailAddress.objects.filter(email__iexact=email).select_related("user").first()
        user = address.user if address else None
    if user is None:
        return JsonResponse({"error": "not found"}, status=404)
    if user.is_staff or user.is_superuser:
        return JsonResponse({"error": "staff"}, status=403)

    for session in Session.objects.iterator():
        if str(session.get_decoded().get("_auth_user_id")) == str(user.pk):
            session.delete()
    pk = user.pk
    user.delete()  # cascades: email addresses, passkeys, social logins, invite redemption
    logger.warning("[account] permanently deleted account pk=%s at the volunteer's request", pk)
    return JsonResponse({"deleted": True})
