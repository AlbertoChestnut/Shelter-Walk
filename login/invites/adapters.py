from allauth.account.adapter import DefaultAccountAdapter

from .session import get_session_invite


class InviteOnlyAccountAdapter(DefaultAccountAdapter):
    """
    Signup (email or Google) is only open to visitors who arrived through a
    valid invite link or typed a valid invite code. Existing users can
    always sign in.

    allauth's social adapter defers to this method by default, so Google
    signups are gated by the same check.
    """

    # Skipped entirely: the "enter your code" page already says this itself
    # (see templates/account/confirm_login_code.html), so the flash message
    # on top of it was just the same sentence twice.
    SUPPRESSED_MESSAGE_TEMPLATES = {"account/messages/login_code_sent.txt"}

    def is_open_for_signup(self, request) -> bool:
        invite = get_session_invite(request)
        return invite is not None and invite.is_usable()

    def add_message(self, request, level, message_template=None, message_context=None, extra_tags="", message=None):
        if message_template in self.SUPPRESSED_MESSAGE_TEMPLATES:
            return
        super().add_message(request, level, message_template, message_context, extra_tags, message)
