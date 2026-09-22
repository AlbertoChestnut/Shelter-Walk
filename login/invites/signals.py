import logging

from allauth.account.signals import user_signed_up
from django.dispatch import receiver

from .models import InviteRedemption
from .session import forget_invite, get_session_invite

logger = logging.getLogger("invites")


@receiver(user_signed_up)
def redeem_invite_on_signup(sender, request, user, **kwargs):
    """
    Runs for both email and Google signups, right after the user is saved
    and before they're logged in.

    The signup page already checked the invite, but two people can load the
    form for the last remaining use at the same time. The atomic claim() makes
    sure only one of them gets it; anyone who loses that race is created but
    left disabled for staff to approve, rather than silently getting in.
    """
    invite = get_session_invite(request)
    forget_invite(request)

    if invite is None:
        logger.warning("Signup without an invite in session for user %s; disabling.", user.pk)
        user.is_active = False
        user.save(update_fields=["is_active"])
        return

    if not invite.claim():
        logger.warning(
            "Invite %s was used up before user %s finished signing up; disabling.",
            invite.pk,
            user.pk,
        )
        InviteRedemption.objects.create(invite=invite, user=user)
        user.is_active = False
        user.save(update_fields=["is_active"])
        return

    InviteRedemption.objects.create(invite=invite, user=user)

    if invite.requires_approval:
        user.is_active = False
        user.save(update_fields=["is_active"])
        logger.info("User %s signed up via invite %s and is awaiting approval.", user.pk, invite.pk)
    else:
        logger.info("User %s signed up via invite %s.", user.pk, invite.pk)
