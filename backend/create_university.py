"""
Create a university row + portal user with an issuer wallet address only (no private key on server).

Run from the backend folder:
  .\\.venv\\Scripts\\python create_university.py "University Name" "INTERNAL-ID" "domain.edu" "admin@domain.edu" "password" "0xIssuerWallet..."

Optional: set UNI_ISSUER_WALLET_ADDRESS instead of passing the last positional arg.

Optional: --verify-on-chain whitelists the wallet if TRUCERT_CONTRACT_ADDRESS and CONTRACT_OWNER_PRIVATE_KEY are set.
"""
from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from web3 import Web3

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import University, User
from app.services import blockchain_service


def main() -> int:
    p = argparse.ArgumentParser(description="Create a TruCert university + university user (wallet-only).")
    p.add_argument("name", help="Display name")
    p.add_argument("internal_id", help="Unique internal_id (e.g. accreditation code)")
    p.add_argument("domain_email", help="Email domain only, e.g. example.edu")
    p.add_argument("contact_email", help="Login email; must use domain_email")
    p.add_argument("password", help="Portal password for contact_email")
    p.add_argument(
        "issuer_wallet",
        nargs="?",
        default=None,
        help="Approved issuer 0x address (or set UNI_ISSUER_WALLET_ADDRESS)",
    )
    p.add_argument("--kyc-notes", default=None, help="Optional admin notes")
    p.add_argument("--institution-contact-email", default=None)
    p.add_argument("--institution-contact-phone", default=None)
    p.add_argument("--institution-website", default=None)
    p.add_argument("--institution-license-id", default=None)
    p.add_argument("--institution-license-authority", default=None)
    p.add_argument("--institution-license-valid-until", default=None, help="YYYY-MM-DD")
    p.add_argument(
        "--verify-on-chain",
        action="store_true",
        help="Whitelist issuer on-chain and set status=verified",
    )
    args = p.parse_args()

    wallet = (args.issuer_wallet or os.environ.get("UNI_ISSUER_WALLET_ADDRESS") or "").strip()
    if not wallet:
        print("Pass issuer_wallet as last argument or set UNI_ISSUER_WALLET_ADDRESS.", file=sys.stderr)
        return 1
    if not wallet.startswith("0x") or len(wallet) != 42:
        print("issuer_wallet must be a 0x-prefixed 20-byte address.", file=sys.stderr)
        return 1
    try:
        wallet = Web3.to_checksum_address(wallet)
    except Exception:
        print("issuer_wallet is invalid.", file=sys.stderr)
        return 1

    domain = args.domain_email.strip().lower()
    contact = args.contact_email.strip().lower()
    if contact.split("@")[-1] != domain:
        print("contact_email must use the same domain as domain_email.", file=sys.stderr)
        return 1

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

        uni = University(
            name=args.name.strip(),
            internal_id=args.internal_id.strip(),
            domain_email=domain,
            wallet_address=wallet,
            institution_contact_email=args.institution_contact_email,
            institution_contact_phone=args.institution_contact_phone,
            institution_website=args.institution_website,
            institution_license_id=args.institution_license_id,
            institution_license_authority=args.institution_license_authority,
            institution_license_valid_until=args.institution_license_valid_until,
            status="pending",
            kyc_notes=args.kyc_notes,
        )
        user = User(email=contact, role="university")
        user.set_password(args.password)
        user.university = uni
        db.session.add(uni)
        db.session.add(user)
        db.session.commit()

        print(f"Created university id={uni.id} issuer_wallet={wallet} (pending).")
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
