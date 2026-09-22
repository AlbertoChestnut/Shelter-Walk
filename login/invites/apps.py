from django.apps import AppConfig


class InvitesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "invites"

    def ready(self):
        from . import signals  # noqa: F401  (registers the signup handler)
