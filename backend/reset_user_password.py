"""
Reset the portal password for an existing user (admin or university).

Run from the backend folder:
  .\\.venv\\Scripts\\python reset_user_password.py "user@domain.edu" "new-password"

Uses DATABASE_URL from .env (SQLite or Postgres).
"""
from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from sqlalchemy import func

from app import create_app
from app.extensions import db
from app.models import User


def main() -> int:
    p = argparse.ArgumentParser(description="Reset TrueCert portal password for an existing user.")
    p.add_argument("email", help="Login email (matched case-insensitively)")
    p.add_argument("password", help="New password")
    args = p.parse_args()

    email = args.email.strip().lower()
    pw = args.password
    if not email or "@" not in email:
        print("Invalid email.", file=sys.stderr)
        return 1
    if len(pw) < 6:
        print("Password should be at least 6 characters.", file=sys.stderr)
        return 1

    app = create_app()
    with app.app_context():
        user = User.query.filter(func.lower(User.email) == email).first()
        if not user:
            print(f"No user found with email matching {email!r}.", file=sys.stderr)
            return 1
        user.set_password(pw)
        db.session.commit()
        print(f"Password updated for {user.email!r} (role={user.role}, id={user.id}).")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
