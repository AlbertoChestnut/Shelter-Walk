from django.contrib import admin, messages
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.urls import reverse
from django.utils.html import format_html

from .models import InviteCode, InviteRedemption

User = get_user_model()


class RedemptionInline(admin.TabularInline):
    model = InviteRedemption
    fields = ("user", "user_is_active", "redeemed_at")
    readonly_fields = fields
    extra = 0
    can_delete = False
    show_change_link = False
    verbose_name_plural = "Accounts created with this invite"

    def has_add_permission(self, request, obj=None):
        return False

    @admin.display(boolean=True, description="Active")
    def user_is_active(self, obj):
        return obj.user.is_active


@admin.register(InviteCode)
class InviteCodeAdmin(admin.ModelAdmin):
    list_display = (
        "label",
        "code_display",
        "uses_display",
        "expires_at",
        "is_active",
        "requires_approval",
        "usable_display",
        "print_link",
    )
    list_filter = ("is_active", "requires_approval")
    search_fields = ("label", "code")
    readonly_fields = (
        "code_display",
        "join_link",
        "qr_preview",
        "use_count",
        "created_by",
        "created_at",
    )
    fieldsets = (
        (None, {"fields": ("label", "max_uses", "expires_at", "is_active", "requires_approval")}),
        ("Share it", {"fields": ("code_display", "join_link", "qr_preview")}),
        ("History", {"fields": ("use_count", "created_by", "created_at")}),
    )
    inlines = [RedemptionInline]
    actions = ["deactivate"]

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    @admin.display(description="Code")
    def code_display(self, obj):
        return obj.formatted_code if obj.pk else "Generated when you save"

    @admin.display(description="Uses")
    def uses_display(self, obj):
        limit = "unlimited" if obj.max_uses is None else obj.max_uses
        return f"{obj.use_count} of {limit}"

    @admin.display(boolean=True, description="Working")
    def usable_display(self, obj):
        return obj.is_usable()

    @admin.display(description="Invite link")
    def join_link(self, obj):
        if not obj.pk:
            return "Available after you save"
        url = obj.get_join_url()
        if not url.startswith("http"):
            return format_html(
                '{} <br><small>Set SITE_URL in your environment to show the full link here.</small>',
                url,
            )
        return format_html('<a href="{0}" target="_blank" rel="noopener">{0}</a>', url)

    @admin.display(description="QR code")
    def qr_preview(self, obj):
        if not obj.pk:
            return "Available after you save"
        svg_url = reverse("invite_qr_svg", args=[obj.pk])
        print_url = reverse("invite_print", args=[obj.pk])
        return format_html(
            '<img src="{}" alt="QR code for this invite" style="width:180px;height:180px;'
            'background:#fff;display:block;margin-bottom:8px">'
            '<a href="{}" target="_blank" rel="noopener">Open printable sign</a> &nbsp;|&nbsp; '
            '<a href="{}" download>Download QR (SVG)</a>',
            svg_url,
            print_url,
            svg_url,
        )

    @admin.display(description="Sign")
    def print_link(self, obj):
        return format_html(
            '<a href="{}" target="_blank" rel="noopener">Print</a>',
            reverse("invite_print", args=[obj.pk]),
        )

    @admin.action(description="Turn off selected invites")
    def deactivate(self, request, queryset):
        count = queryset.update(is_active=False)
        self.message_user(request, f"Turned off {count} invite(s).", messages.SUCCESS)


class InviteRedemptionUserInline(admin.StackedInline):
    model = InviteRedemption
    fk_name = "user"
    fields = ("invite", "redeemed_at")
    readonly_fields = fields
    can_delete = False
    extra = 0
    verbose_name_plural = "Joined with invite"

    def has_add_permission(self, request, obj=None):
        return False


admin.site.unregister(User)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = ("email", "first_name", "last_name", "is_active", "is_staff", "joined_via", "date_joined")
    list_filter = ("is_active", "is_staff", "invite_redemption__invite")
    search_fields = ("email", "first_name", "last_name", "username")
    ordering = ("-date_joined",)
    inlines = [InviteRedemptionUserInline]
    actions = ["approve_users", "disable_users"]

    @admin.display(description="Joined via")
    def joined_via(self, obj):
        redemption = getattr(obj, "invite_redemption", None)
        return redemption.invite.label if redemption else "-"

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("invite_redemption__invite")

    # Staff who aren't superusers can approve and disable volunteers, but
    # can't hand out staff/superuser rights or touch superuser accounts.
    PROTECTED_FIELDS = ("is_staff", "is_superuser", "groups", "user_permissions", "password")

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        if not request.user.is_superuser:
            fields += [f for f in self.PROTECTED_FIELDS if f not in fields]
        return fields

    def has_change_permission(self, request, obj=None):
        if obj is not None and obj.is_superuser and not request.user.is_superuser:
            return False
        return super().has_change_permission(request, obj)

    def _manageable(self, request, queryset):
        queryset = queryset.exclude(pk=request.user.pk)
        if not request.user.is_superuser:
            queryset = queryset.filter(is_superuser=False, is_staff=False)
        return queryset

    @admin.action(description="Approve selected accounts")
    def approve_users(self, request, queryset):
        count = self._manageable(request, queryset).filter(is_active=False).update(is_active=True)
        self.message_user(request, f"Approved {count} account(s).", messages.SUCCESS)

    @admin.action(description="Disable selected accounts")
    def disable_users(self, request, queryset):
        count = self._manageable(request, queryset).update(is_active=False)
        self.message_user(
            request,
            f"Disabled {count} account(s). They're signed out on their next page load.",
            messages.SUCCESS,
        )
