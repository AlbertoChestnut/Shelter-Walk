from allauth.account.decorators import secure_admin_login
from django.contrib import admin
from django.urls import include, path

from invites import views as invites_views

# Route the admin login through allauth so staff get the same rate limits
# and code/Google sign-in instead of a separate password form.
admin.site.login = secure_admin_login(admin.site.login)
admin.site.site_header = "Shelter volunteer app"
admin.site.site_title = "Shelter volunteer app"

urlpatterns = [
    path("", invites_views.home, name="home"),
    path("", include("invites.urls")),
    # Shadow two allauth URLs by declaring them here, before allauth.urls is
    # included below -- Django dispatches to whichever pattern matches
    # first, so ours wins. This folds passkey management into the Account
    # page (see AccountEmailView/AddPasskeyView) instead of allauth's
    # default separate "Security Keys" page.
    path("accounts/email/", invites_views.account_email, name="account_email"),
    path("accounts/2fa/webauthn/add/", invites_views.add_passkey, name="mfa_add_webauthn"),
    path("accounts/", include("allauth.urls")),
    path("admin/", admin.site.urls),
]
