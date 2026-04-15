"""
Create a new admin user, or reset password / promote an existing email to admin.

Run from the backend folder:
  python create_admin.py admin@example.com "your-secure-password"
"""
from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from app import create_app
from app.extensions import db
from app.models import User


def main() -> int:
    p = argparse.ArgumentParser(description="Create or update a TruCert admin user.")
    p.add_argument("email", help="Login email (stored lowercase)")
    p.add_argument("password", help="Password for this admin")
    args = p.parse_args()

    email = args.email.strip().lower()
    if not email or "@" not in email:
        print("Invalid email.", file=sys.stderr)
        return 1

    app = create_app()
    with app.app_context():
        user = User.query.filter_by(email=email).first()
        if user:
            if user.university_id is not None:
                print(
                    "That email belongs to a university account; use a different email for admin.",
                    file=sys.stderr,
                )
                return 1
            user.role = "admin"
            user.set_password(args.password)
            db.session.commit()
            print(f"Updated existing user {email!r}: password reset and role set to admin.")
            return 0

        u = User(email=email, role="admin")
        u.set_password(args.password)
        db.session.add(u)
        db.session.commit()
        print(f"Created admin {email!r}.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
