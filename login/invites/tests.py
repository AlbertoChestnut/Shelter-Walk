import re
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .models import InviteCode, InviteRedemption, normalize_code

User = get_user_model()

CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend", SITE_URL="")
class InviteFlowTests(TestCase):
    def setUp(self):
        cache.clear()

    # --- helpers -------------------------------------------------------------
    def visit_invite(self, client, invite):
        return client.get(reverse("invite_join", args=[invite.code]))

    def sign_up(self, client, email):
        return client.post(reverse("account_signup"), {"email": email})

    def last_code(self):
        match = CODE_RE.search(mail.outbox[-1].body)
        self.assertIsNotNone(match, mail.outbox[-1].body)
        return match.group(1)

    # --- gating --------------------------------------------------------------
    def test_signup_closed_without_invite(self):
        resp = self.client.get(reverse("account_signup"))
        self.assertContains(resp, "You need an invite to join")
        self.sign_up(self.client, "nobody@example.org")
        self.assertFalse(User.objects.filter(email="nobody@example.org").exists())

    def test_invite_link_opens_signup_and_counts_use(self):
        invite = InviteCode.objects.create(label="Jane", max_uses=1)
        resp = self.visit_invite(self.client, invite)
        self.assertRedirects(resp, reverse("account_signup"), fetch_redirect_response=False)

        self.sign_up(self.client, "jane@example.org")
        user = User.objects.get(email="jane@example.org")
        invite.refresh_from_db()
        self.assertEqual(invite.use_count, 1)
        self.assertTrue(InviteRedemption.objects.filter(invite=invite, user=user).exists())
        self.assertTrue(user.is_active)
        self.assertFalse(user.has_usable_password())

    def test_single_use_invite_cannot_be_reused(self):
        invite = InviteCode.objects.create(label="Jane", max_uses=1)
        self.visit_invite(self.client, invite)
        self.sign_up(self.client, "jane@example.org")

        other = self.client_class()
        resp = self.visit_invite(other, invite)
        self.assertEqual(resp.status_code, 404)
        self.sign_up(other, "sneaky@example.org")
        self.assertFalse(User.objects.filter(email="sneaky@example.org").exists())

    def test_multi_use_invite_stops_at_limit(self):
        invite = InviteCode.objects.create(label="Room QR", max_uses=3)
        for i in range(3):
            c = self.client_class()
            self.visit_invite(c, invite)
            self.sign_up(c, f"v{i}@example.org")
        invite.refresh_from_db()
        self.assertEqual(invite.use_count, 3)
        c = self.client_class()
        self.assertEqual(self.visit_invite(c, invite).status_code, 404)

    def test_unlimited_invite(self):
        invite = InviteCode.objects.create(label="Open", max_uses=None)
        for i in range(5):
            c = self.client_class()
            self.visit_invite(c, invite)
            self.sign_up(c, f"u{i}@example.org")
        self.assertEqual(User.objects.filter(email__startswith="u").count(), 5)

    def test_expired_and_disabled_invites_rejected(self):
        expired = InviteCode.objects.create(label="Old", expires_at=timezone.now() - timedelta(minutes=1))
        disabled = InviteCode.objects.create(label="Off", is_active=False)
        self.assertEqual(self.visit_invite(self.client, expired).status_code, 404)
        self.assertEqual(self.visit_invite(self.client, disabled).status_code, 404)

    def test_invite_turned_off_after_link_visit_blocks_signup(self):
        invite = InviteCode.objects.create(label="Jane")
        self.visit_invite(self.client, invite)
        InviteCode.objects.filter(pk=invite.pk).update(is_active=False)
        self.sign_up(self.client, "late@example.org")
        self.assertFalse(User.objects.filter(email="late@example.org").exists())

    def test_typed_code_is_forgiving_about_case_and_dashes(self):
        invite = InviteCode.objects.create(label="Room")
        typed = invite.formatted_code.lower().replace("-", " ")
        resp = self.client.post(reverse("invite_enter_code"), {"code": typed})
        self.assertRedirects(resp, reverse("account_signup"), fetch_redirect_response=False)
        self.assertEqual(normalize_code(typed), invite.code)

    def test_bad_typed_codes_get_rate_limited(self):
        for _ in range(20):
            resp = self.client.post(reverse("invite_enter_code"), {"code": "WRONG-WRONG-WRNG"})
            self.assertEqual(resp.status_code, 400)
        resp = self.client.post(reverse("invite_enter_code"), {"code": "WRONG-WRONG-WRNG"})
        self.assertEqual(resp.status_code, 429)
        # Even a valid code is refused until the window passes.
        invite = InviteCode.objects.create(label="Room")
        resp = self.client.post(reverse("invite_enter_code"), {"code": invite.code})
        self.assertEqual(resp.status_code, 429)

    # --- approval ------------------------------------------------------------
    def test_requires_approval_creates_disabled_account(self):
        invite = InviteCode.objects.create(label="Room QR", max_uses=None, requires_approval=True)
        self.visit_invite(self.client, invite)
        resp = self.sign_up(self.client, "pending@example.org")
        user = User.objects.get(email="pending@example.org")
        self.assertFalse(user.is_active)
        self.assertRedirects(resp, reverse("account_inactive"), fetch_redirect_response=False)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_approved_user_can_sign_in_by_code(self):
        invite = InviteCode.objects.create(label="Room QR", max_uses=None, requires_approval=True)
        self.visit_invite(self.client, invite)
        self.sign_up(self.client, "pending@example.org")
        User.objects.filter(email="pending@example.org").update(is_active=True)

        c = self.client_class()
        mail.outbox.clear()
        c.post(reverse("account_request_login_code"), {"email": "pending@example.org"})
        code = self.last_code()
        resp = c.post(reverse("account_confirm_login_code"), {"code": code})
        self.assertRedirects(resp, reverse("home"), fetch_redirect_response=False)
        self.assertEqual(int(c.session["_auth_user_id"]), User.objects.get(email="pending@example.org").pk)

    # --- race condition --------------------------------------------------------
    def test_losing_the_race_for_last_use_leaves_account_disabled(self):
        invite = InviteCode.objects.create(label="Jane", max_uses=1)
        a, b = self.client_class(), self.client_class()
        self.visit_invite(a, invite)
        self.visit_invite(b, invite)  # both opened the link while 1 use was left
        self.sign_up(a, "first@example.org")

        # Simulate b's signup passing the open-for-signup check at the same
        # instant a's claim went through (true concurrency is hard in a test).
        with mock.patch(
            "invites.adapters.InviteOnlyAccountAdapter.is_open_for_signup", return_value=True
        ):
            self.sign_up(b, "second@example.org")

        invite.refresh_from_db()
        self.assertEqual(invite.use_count, 1)
        self.assertTrue(User.objects.get(email="first@example.org").is_active)
        self.assertFalse(User.objects.get(email="second@example.org").is_active)

    def test_google_signup_uses_same_gate(self):
        from allauth.socialaccount.adapter import get_adapter as get_social_adapter
        from django.test import RequestFactory

        request = RequestFactory().get("/")
        request.session = self.client.session
        self.assertFalse(get_social_adapter(request).is_open_for_signup(request, sociallogin=None))

        invite = InviteCode.objects.create(label="Jane")
        self.visit_invite(self.client, invite)
        request.session = self.client.session
        self.assertTrue(get_social_adapter(request).is_open_for_signup(request, sociallogin=None))

    def test_unknown_email_on_sign_in_sends_nothing(self):
        mail.outbox.clear()
        resp = self.client.post(reverse("account_request_login_code"), {"email": "stranger@example.org"})
        self.assertEqual(resp.status_code, 302)  # looks the same as a real account
        self.assertEqual(len(mail.outbox), 0)

    # --- full email signup + later sign-in --------------------------------------
    def test_full_signup_then_code_login(self):
        invite = InviteCode.objects.create(label="Jane")
        self.visit_invite(self.client, invite)
        mail.outbox.clear()
        resp = self.sign_up(self.client, "jane@example.org")
        self.assertEqual(resp.status_code, 302)
        verify_code = self.last_code()
        resp = self.client.post(reverse("account_email_verification_sent"), {"code": verify_code})
        self.assertEqual(int(self.client.session["_auth_user_id"]), User.objects.get(email="jane@example.org").pk)

        # New device: sign in with a code.
        c = self.client_class()
        mail.outbox.clear()
        c.post(reverse("account_request_login_code"), {"email": "jane@example.org"})
        resp = c.post(reverse("account_confirm_login_code"), {"code": self.last_code()})
        self.assertRedirects(resp, reverse("home"), fetch_redirect_response=False)

    def test_disabling_user_ends_their_session(self):
        invite = InviteCode.objects.create(label="Jane")
        self.visit_invite(self.client, invite)
        self.sign_up(self.client, "jane@example.org")
        self.client.post(reverse("account_email_verification_sent"), {"code": self.last_code()})
        self.assertEqual(self.client.get(reverse("home")).status_code, 200)
        User.objects.filter(email="jane@example.org").update(is_active=False)
        resp = self.client.get(reverse("home"))
        self.assertEqual(resp.status_code, 302)

    # --- staff tools ------------------------------------------------------------
    def test_qr_and_print_are_staff_only(self):
        invite = InviteCode.objects.create(label="Room")
        url = reverse("invite_qr_svg", args=[invite.pk])
        self.assertEqual(self.client.get(url).status_code, 302)
        staff = User.objects.create_user("staff", "staff@example.org", is_staff=True)
        self.client.force_login(staff)
        resp = self.client.get(url)
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"<svg", resp.content)
        resp = self.client.get(reverse("invite_print", args=[invite.pk]))
        self.assertContains(resp, invite.formatted_code)

    @override_settings(SITE_URL="https://volunteers.example.org")
    def test_links_use_site_url(self):
        invite = InviteCode.objects.create(label="Room")
        self.assertEqual(
            invite.get_join_url(),
            f"https://volunteers.example.org/join/{invite.code}/",
        )


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend", SITE_URL="")
class StaffLoginTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_create_staff_account_can_reach_admin_by_code(self):
        from django.core.management import call_command

        call_command("create_staff", "coord@example.org", stdout=open("/dev/null", "w"))
        resp = self.client.get(reverse("admin:index"))
        self.assertEqual(resp.status_code, 302)
        login_page = self.client.get(resp["Location"], follow=True)
        self.assertEqual(login_page.status_code, 200)

        mail.outbox.clear()
        self.client.post(reverse("account_request_login_code"), {"email": "coord@example.org"})
        code = CODE_RE.search(mail.outbox[-1].body).group(1)
        self.client.post(reverse("account_confirm_login_code"), {"code": code})
        self.assertEqual(self.client.get(reverse("admin:index")).status_code, 200)
        self.assertEqual(
            self.client.get(reverse("admin:invites_invitecode_add")).status_code, 200
        )

    def test_non_superuser_staff_can_manage_invites_only(self):
        from django.core.management import call_command

        call_command("create_staff", "helper@example.org", stdout=open("/dev/null", "w"))
        user = User.objects.get(email="helper@example.org")
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.has_perm("invites.add_invitecode"))
        self.assertTrue(user.has_perm("auth.change_user"))
        self.assertFalse(user.has_perm("invites.delete_invitecode"))

    def test_non_superuser_staff_cannot_escalate(self):
        from django.core.management import call_command

        call_command("create_staff", "helper@example.org", stdout=open("/dev/null", "w"))
        call_command("create_staff", "boss@example.org", "--superuser", stdout=open("/dev/null", "w"))
        helper = User.objects.get(email="helper@example.org")
        boss = User.objects.get(email="boss@example.org")
        self.client.force_login(helper)

        # Can't open a superuser's account for editing.
        resp = self.client.get(reverse("admin:auth_user_change", args=[boss.pk]))
        self.assertNotContains(resp, 'name="is_active"')

        # Can't make themselves a superuser.
        resp = self.client.get(reverse("admin:auth_user_change", args=[helper.pk]))
        self.assertNotContains(resp, 'name="is_superuser"')
        self.assertNotContains(resp, 'name="is_staff"')

        # Can approve a volunteer, but the disable action skips staff.
        volunteer = User.objects.create_user("v", "v@example.org", is_active=False)
        self.client.post(
            reverse("admin:auth_user_changelist"),
            {"action": "approve_users", "_selected_action": [volunteer.pk, boss.pk]},
        )
        self.client.post(
            reverse("admin:auth_user_changelist"),
            {"action": "disable_users", "_selected_action": [boss.pk]},
        )
        volunteer.refresh_from_db()
        boss.refresh_from_db()
        self.assertTrue(volunteer.is_active)
        self.assertTrue(boss.is_active)


class AbuseGuardTests(TestCase):
    """An IP that keeps tripping rate limits / guessing invite codes gets shut
    out for a while; nobody else (and no signed-in user) is affected."""

    def setUp(self):
        cache.clear()

    def bad_guess(self, ip):
        return self.client.post(reverse("invite_enter_code"), {"code": "WRONG-WRONG-WRONG"}, HTTP_CF_CONNECTING_IP=ip)

    def test_repeated_abuse_blocks_only_that_ip(self):
        for _ in range(30):
            self.bad_guess("203.0.113.9")
        blocked = self.client.get(reverse("account_login"), HTTP_CF_CONNECTING_IP="203.0.113.9")
        self.assertEqual(blocked.status_code, 403)
        other = self.client.get(reverse("account_login"), HTTP_CF_CONNECTING_IP="203.0.113.10")
        self.assertEqual(other.status_code, 200)

    @override_settings(ALLAUTH_TRUSTED_CLIENT_IP_HEADER="CF-Connecting-IP")
    def test_rate_limits_are_per_real_client_ip_not_shared(self):
        # One attacker exhausting their budget must not lock out anyone else.
        for _ in range(21):
            self.bad_guess("198.51.100.1")
        self.assertEqual(self.bad_guess("198.51.100.1").status_code, 429)
        self.assertEqual(self.bad_guess("198.51.100.2").status_code, 400, "a different IP still gets its own attempts")

    @override_settings(ALLAUTH_TRUSTED_CLIENT_IP_HEADER="CF-Connecting-IP")
    def test_signed_in_users_are_never_blocked(self):
        user = get_user_model().objects.create_user(username="v", email="v@example.org")
        for _ in range(30):
            self.bad_guess("203.0.113.50")
        self.client.force_login(user)
        resp = self.client.get(reverse("account_email"), HTTP_CF_CONNECTING_IP="203.0.113.50")
        self.assertNotEqual(resp.status_code, 403)

    def test_a_ban_expires_and_garbage_ip_headers_are_ignored(self):
        cache.set("abuse:ban:203.0.113.77", 1, 1)
        self.assertEqual(self.client.get(reverse("account_login"), HTTP_CF_CONNECTING_IP="203.0.113.77").status_code, 403)
        # A malformed header can't be used to dodge or to poison the counters.
        resp = self.client.get(reverse("account_login"), HTTP_CF_CONNECTING_IP="not-an-ip; DROP TABLE")
        self.assertEqual(resp.status_code, 200)


@override_settings(DOGWALK_INTERNAL_TOKEN="test-secret")
class AccountDeletionTests(TestCase):
    """The app's account-deletion request: server-to-server only, refuses staff,
    removes the login and everything hanging off it."""

    def setUp(self):
        cache.clear()
        User = get_user_model()
        self.volunteer = User.objects.create_user(username="v", email="vol@example.org")
        self.invite = InviteCode.objects.create(label="test", max_uses=1)
        InviteRedemption.objects.create(invite=self.invite, user=self.volunteer)
        self.invite.use_count = 1
        self.invite.save()

    def post(self, email, token="test-secret"):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        return self.client.post(
            reverse("internal_delete_account"),
            data={"email": email}, content_type="application/json", **headers,
        )

    def test_requires_the_shared_secret(self):
        self.assertEqual(self.post("vol@example.org", token=None).status_code, 403)
        self.assertEqual(self.post("vol@example.org", token="wrong").status_code, 403)
        self.assertTrue(get_user_model().objects.filter(email="vol@example.org").exists())

    @override_settings(DOGWALK_INTERNAL_TOKEN="")
    def test_disabled_when_no_secret_is_configured(self):
        self.assertEqual(self.post("vol@example.org", token="").status_code, 403)

    def test_deletes_the_account_and_its_records(self):
        resp = self.post("VOL@example.org")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(get_user_model().objects.filter(email="vol@example.org").exists())
        self.assertFalse(InviteRedemption.objects.filter(invite=self.invite).exists())
        self.invite.refresh_from_db()
        self.assertEqual(self.invite.use_count, 1, "deleting a volunteer must not free their invite for reuse")

    def test_refuses_staff_and_superusers(self):
        User = get_user_model()
        User.objects.create_user(username="s", email="staff@example.org", is_staff=True)
        User.objects.create_superuser(username="root", email="root@example.org", password="x")
        self.assertEqual(self.post("staff@example.org").status_code, 403)
        self.assertEqual(self.post("root@example.org").status_code, 403)
        self.assertTrue(User.objects.filter(email="staff@example.org").exists())

    def test_unknown_email_and_bad_input(self):
        self.assertEqual(self.post("nobody@example.org").status_code, 404)
        self.assertEqual(self.post("").status_code, 400)
        resp = self.client.post(reverse("internal_delete_account"), data="not json", content_type="application/json", HTTP_AUTHORIZATION="Bearer test-secret")
        self.assertEqual(resp.status_code, 400)

    def test_ends_their_sessions(self):
        self.client.force_login(self.volunteer)
        from django.contrib.sessions.models import Session
        self.assertEqual(Session.objects.count(), 1)
        # The real caller (the app's server) carries no cookies; a separate
        # client also keeps this request from re-saving the volunteer's session.
        from django.test import Client
        resp = Client().post(reverse("internal_delete_account"), data={"email": "vol@example.org"},
                             content_type="application/json", HTTP_AUTHORIZATION="Bearer test-secret")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(Session.objects.count(), 0)

    def test_get_is_not_allowed(self):
        self.assertEqual(self.client.get(reverse("internal_delete_account")).status_code, 405)
