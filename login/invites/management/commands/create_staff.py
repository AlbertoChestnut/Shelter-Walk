"""
Create a staff account that signs in with emailed codes (no password).

    python manage.py create_staff coordinator@theirshelter.org
    python manage.py create_staff you@example.org --superuser

Use this instead of `createsuperuser`: it also records the email as
verified, which allauth needs for code sign-in to go straight through.
"""

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction


class Command(BaseCommand):
    help = "Create (or promote) a passwordless staff account."

    def add_arguments(self, parser):
        parser.add_argument("email")
        parser.add_argument(
            "--superuser",
            action="store_true",
            help="Full access, including managing other staff. Otherwise staff with invite permissions only.",
        )

    @transaction.atomic
    def handle(self, *args, email, superuser, **options):
        email = email.strip().lower()
        try:
            validate_email(email)
        except Exception as exc:
            raise CommandError(f"Not a valid email address: {email}") from exc

        User = get_user_model()
        user = User.objects.filter(email__iexact=email).first()
        created = user is None
        if created:
            user = User(username=email[:150], email=email)
            user.set_unusable_password()

        user.is_active = True
        user.is_staff = True
        if superuser:
            user.is_superuser = True
        user.save()

        if not superuser and not user.is_superuser:
            from django.contrib.auth.models import Permission

            perms = Permission.objects.filter(
                content_type__app_label__in=["invites", "auth"],
                codename__in=[
                    "add_invitecode",
                    "change_invitecode",
                    "view_invitecode",
                    "view_inviteredemption",
                    "view_user",
                    "change_user",
                ],
            )
            user.user_permissions.add(*perms)

        EmailAddress.objects.filter(user=user).exclude(email__iexact=email).update(primary=False)
        address, _ = EmailAddress.objects.get_or_create(
            user=user, email=email, defaults={"verified": True, "primary": True}
        )
        if not (address.verified and address.primary):
            address.verified = True
            address.primary = True
            address.save()

        role = "superuser" if user.is_superuser else "staff"
        verb = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{verb} {role} account for {email}. Sign in at /accounts/login/ with an emailed code."))
