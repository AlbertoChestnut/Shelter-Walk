from django import forms

from .models import InviteCode


class InviteCodeForm(forms.ModelForm):
    class Meta:
        model = InviteCode
        fields = ["label", "max_uses", "expires_at"]
        widgets = {
            "expires_at": forms.DateTimeInput(attrs={"type": "datetime-local"}),
        }
