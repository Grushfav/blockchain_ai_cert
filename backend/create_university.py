"""
Create a university row + portal user from an issuer private key (same rules as /api/auth/register-university).

Private key: set env UNI_ISSUER_PRIVATE_KEY (64 hex, optional 0x prefix) — avoids shell history in argv.

Run from the backend folder:
  .\\.venv\\Scripts\\python create_university.py "University Name" "INTERNAL-ID" "domain.edu" "admin@domain.edu" "password"
"""
from __future__ import annotations

import argparse
import os
import re
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from eth_account import Account

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import University, User
from app.services import blockchain_service
from app.services.crypto_util import encrypt_private_key


def main() -> int:
    p = argparse.ArgumentParser(description="Create a TruCert university + university user.")
    p.add_argument("name", help="Display name")
    p.add_argument("internal_id", help="Unique internal_id (e.g. accreditation code)")
    p.add_argument("domain_email", help="Email domain only, e.g. example.edu")
    p.add_argument("contact_email", help="Login email; must use domain_email")
    p.add_argument("password", help="Portal password for contact_email")
    p.add_argument(
        "--kyc-notes",
        default=None,
        help="Optional admin notes",
    )
    p.add_argument(
        "--verify-on-chain",
        action="store_true",
        help="If TRUCERT_CONTRACT_ADDRESS and CONTRACT_OWNER_PRIVATE_KEY are set, whitelist issuer and set verified",
    )
    args = p.parse_args()

    pk = (os.environ.get("UNI_ISSUER_PRIVATE_KEY") or "").strip()
    if not pk:
        print("Set UNI_ISSUER_PRIVATE_KEY to the 32-byte issuer private key (hex).", file=sys.stderr)
        return 1
    if pk.startswith("0x"):
        pk = pk[2:]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", pk):
        print("UNI_ISSUER_PRIVATE_KEY must be a 32-byte hex string.", file=sys.stderr)
        return 1

    domain = args.domain_email.strip().lower()
    contact = args.contact_email.strip().lower()
    if contact.split("@")[-1] != domain:
        print("contact_email must use the same domain as domain_email.", file=sys.stderr)
        return 1

    account = Account.from_key("0x" + pk)
    wallet = account.address

    app = create_app()
    with app.app_context():
        if User.query.filter_by(email=contact).first():
            print(f"User already exists: {contact}", file=sys.stderr)
            return 1
        if University.query.filter_by(internal_id=args.internal_id.strip()).first():
            print(f"internal_id already used: {args.internal_id!r}", file=sys.stderr)
            return 1
        if University.query.filter_by(wallet_address=wallet).first():
            print(f"Issuer wallet already registered: {wallet}", file=sys.stderr)
            return 1

        enc = encrypt_private_key(Config.SECRET_KEY, "0x" + pk)
        uni = University(
            name=args.name.strip(),
            internal_id=args.internal_id.strip(),
            domain_email=domain,
            wallet_address=wallet,
            private_key_encrypted=enc,
            status="pending",
            kyc_notes=args.kyc_notes,
        )
        user = User(email=contact, role="university")
        user.set_password(args.password)
        user.university = uni
        db.session.add(uni)
        db.session.add(user)
        db.session.commit()

        print(f"Created university id={uni.id} wallet={wallet} (pending).")
        print(f"  Portal login: {contact}")

        if args.verify_on_chain and Config.TRUCERT_CONTRACT_ADDRESS and Config.CONTRACT_OWNER_PRIVATE_KEY:
            try:
                w3 = blockchain_service.get_w3()
                contract = blockchain_service.get_contract(w3)
                tx = blockchain_service.set_issuer_whitelisted(w3, contract, wallet, True)
                uni.status = "verified"
                db.session.commit()
                print(f"Whitelisted on-chain; status=verified. tx: {tx}")
            except Exception as e:
                print(f"On-chain whitelist failed: {e}", file=sys.stderr)
                return 1
        elif args.verify_on_chain:
            print("TRUCERT_CONTRACT_ADDRESS or CONTRACT_OWNER_PRIVATE_KEY missing; left pending.", file=sys.stderr)

        return 0


if __name__ == "__main__":
    raise SystemExit(main())
