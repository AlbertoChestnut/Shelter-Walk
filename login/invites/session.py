"""Helpers for remembering which invite the visitor arrived with."""

from .models import InviteCode

SESSION_KEY = "invite_code_id"


def remember_invite(request, invite: InviteCode) -> None:
    request.session[SESSION_KEY] = invite.pk


def get_session_invite(request) -> InviteCode | None:
    invite_id = request.session.get(SESSION_KEY)
    if not invite_id:
        return None
    return InviteCode.objects.filter(pk=invite_id).first()


def forget_invite(request) -> None:
    request.session.pop(SESSION_KEY, None)
