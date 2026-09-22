from django.urls import path

from . import views

urlpatterns = [
    path("join/", views.join_enter_code, name="invite_enter_code"),
    path("join/<str:code>/", views.join_with_code, name="invite_join"),
    path("internal/authcheck/", views.forward_auth_check, name="forward_auth_check"),
    path("internal/delete-account/", views.internal_delete_account, name="internal_delete_account"),
    path("staff/", views.staff_dashboard, name="staff_dashboard"),
    path("staff/invites/", views.staff_invite_list, name="staff_invite_list"),
    path("staff/invites/new/", views.staff_invite_new, name="staff_invite_new"),
    path("staff/invites/<int:pk>/qr.svg", views.invite_qr_svg, name="invite_qr_svg"),
    path("staff/invites/<int:pk>/print/", views.invite_print, name="invite_print"),
    path("staff/invites/<int:pk>/toggle/", views.staff_invite_toggle, name="staff_invite_toggle"),
    path("staff/users/", views.staff_user_list, name="staff_user_list"),
    path("staff/users/<int:pk>/force-signout/", views.staff_user_force_signout, name="staff_user_force_signout"),
    path("staff/users/<int:pk>/deactivate/", views.staff_user_deactivate, name="staff_user_deactivate"),
    path("staff/users/<int:pk>/reactivate/", views.staff_user_reactivate, name="staff_user_reactivate"),
    path("staff/walkers/", views.staff_walker_permissions, name="staff_walker_permissions"),
]
