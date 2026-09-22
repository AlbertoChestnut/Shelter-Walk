import secrets

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.urls import reverse
from django.utils import timezone

# No 0/O, 1/I/L, or U, so codes are easy to read off a poster and type.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 12  # 30^12 ~= 5e17 possibilities (~59 bits)


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(raw: str) -> str:
    """Accept 'abcd-efgh-jkmn', 'ABCD EFGH JKMN', etc."""
    return "".join(ch for ch in raw.upper() if ch.isalnum())[:64]


def format_code(code: str) -> str:
    return "-".join(code[i : i + 4] for i in range(0, len(code), 4))


class InviteCodeQuerySet(models.QuerySet):
    def usable(self):
        now = timezone.now()
        return (
            self.filter(is_active=True)
            .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
            .filter(Q(max_uses__isnull=True) | Q(use_count__lt=F("max_uses")))
        )


class InviteCode(models.Model):
    code = models.CharField(max_length=32, unique=True, default=generate_code, editable=False)
    label = models.CharField(
        max_length=120,
        help_text="Who or where this is for, e.g. 'Volunteer room QR' or 'Jane Smith'.",
    )
    max_uses = models.PositiveIntegerField(
        null=True,
        blank=True,
        default=1,
        help_text="How many accounts can be created with this invite. Leave blank for unlimited.",
    )
    use_count = models.PositiveIntegerField(default=0, editable=False)
    expires_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Optional. After this time the invite stops working.",
    )
    is_active = models.BooleanField(
        default=True,
        help_text="Uncheck to shut this invite off immediately.",
    )
    requires_approval = models.BooleanField(
        default=False,
        help_text=(
            "New accounts from this invite stay disabled until staff approve them. "
            "Recommended for posted QR codes."
        ),
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        editable=False,
        on_delete=models.SET_NULL,
        related_name="invites_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = InviteCodeQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.label} ({self.formatted_code})"

    @property
    def formatted_code(self) -> str:
        return format_code(self.code)

    @property
    def remaining_uses(self) -> int | None:
        if self.max_uses is None:
            return None
        return max(self.max_uses - self.use_count, 0)

    def is_usable(self) -> bool:
        if not self.is_active:
            return False
        if self.expires_at and self.expires_at <= timezone.now():
            return False
        if self.max_uses is not None and self.use_count >= self.max_uses:
            return False
        return True

    def get_join_path(self) -> str:
        return reverse("invite_join", kwargs={"code": self.code})

    def get_join_url(self, request=None) -> str:
        """
        Full link for sharing. Uses SITE_URL when set so QR codes always point
        at the public address, even if staff are using a LAN address.
        """
        base = getattr(settings, "SITE_URL", "").rstrip("/")
        if base:
            return base + self.get_join_path()
        if request is not None:
            return request.build_absolute_uri(self.get_join_path())
        return self.get_join_path()

    def claim(self) -> bool:
        """
        Atomically take one use of this invite. Returns False if the invite
        ran out, expired, or was disabled in the meantime. Safe when many
        people scan the same QR code at once.
        """
        updated = (
            InviteCode.objects.usable()
            .filter(pk=self.pk)
            .update(use_count=F("use_count") + 1)
        )
        return updated == 1


class InviteRedemption(models.Model):
    invite = models.ForeignKey(
        InviteCode,
        on_delete=models.PROTECT,  # keep the audit trail; deactivate invites instead of deleting
        related_name="redemptions",
    )
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="invite_redemption",
    )
    redeemed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-redeemed_at"]

    def __str__(self) -> str:
        return f"{self.user} via {self.invite.label}"
