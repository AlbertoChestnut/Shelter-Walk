# Shelter volunteer app (auth + invites prototype)

Working prototype of the requirements in SPEC.md. All 21 acceptance tests pass.

## Local dev

    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    export DJANGO_DEBUG=1 SITE_URL=http://127.0.0.1:8000
    python manage.py migrate
    python manage.py createcachetable
    python manage.py create_staff you@example.org --superuser
    python manage.py runserver

Sign in at http://127.0.0.1:8000/admin/ — with no EMAIL_HOST set, the sign-in
code is printed in the runserver terminal. Create an invite under
Invites > Invite codes, then open its link in a private window to test signup.

## Tests

    DJANGO_DEBUG=1 python manage.py test invites

See SPEC.md for production environment variables, Resend and Google setup,
and the security requirements.
