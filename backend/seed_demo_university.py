"""
Create a demo university login + random issuer wallet (no private key stored on server).

Run from the backend folder with the venv activated:
  .\\.venv\\Scripts\\python seed_demo_university.py

Requires backend/.env with SECRET_KEY and (for on-chain approve) TRUCERT_CONTRACT_ADDRESS +
CONTRACT_OWNER_PRIVATE_KEY.

The script prints a one-time demo private key to stdout so you can import that account into
MetaMask for local testing — it is never sent to the API or stored in the database.
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from eth_account import Account

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import University, User
from app.services import blockchain_service

DEMO_INTERNAL_ID = os.environ.get("DEMO_UNI_INTERNAL_ID", "UWI-DEMO-2026-001")
DEMO_EMAIL = os.environ.get("DEMO_UNI_EMAIL", "trucert.demo@uwitest.edu.jm")
DEMO_PASSWORD = os.environ.get("DEMO_UNI_PASSWORD", "DemoUwi2026!")
DEMO_DOMAIN = "uwitest.edu.jm"


def main() -> int:
    if DEMO_EMAIL.split("@")[-1].lower() != DEMO_DOMAIN:
        print("DEMO_UNI_EMAIL must use domain uwitest.edu.jm for this script.", file=sys.stderr)
        return 1

    app = create_app()
    with app.app_context():
        existing = University.query.filter_by(internal_id=DEMO_INTERNAL_ID).first()
        if existing:
            print(f"University with internal_id={DEMO_INTERNAL_ID} already exists (id={existing.id}).")
            print("Use the portal login with your demo email/password, or delete the row from SQLite.")
            return 0

        acc = Account.create()
        kh = acc.key.hex()
        pk_hex = kh if kh.startswith("0x") else "0x" + kh
        wallet = acc.address

        uni = University(
            name="UWI TruCert Demo (Test)",
            internal_id=DEMO_INTERNAL_ID,
            domain_email=DEMO_DOMAIN,
            wallet_address=wallet,
            institution_contact_email="registrar@uwitest.edu.jm",
            institution_contact_phone="+1-876-000-0000",
            institution_website="https://uwitest.edu.jm",
            institution_license_id="UWI-DEMO-LIC-001",
            institution_license_authority="Jamaica Tertiary Commission",
            institution_license_valid_until="2030-12-31",
            status="pending",
            kyc_notes="Seeded demo university for TruCert testing.",
        )
        user = User(email=DEMO_EMAIL.lower(), role="university")
        user.set_password(DEMO_PASSWORD)
        user.university = uni
        db.session.add(uni)
        db.session.add(user)
        db.session.commit()

        print("Created university record and user (pending).")
        print(f"  university_id: {uni.id}")
        print(f"  issuer_wallet: {wallet}")
        print()

        if Config.TRUCERT_CONTRACT_ADDRESS and Config.CONTRACT_OWNER_PRIVATE_KEY:
            try:
                w3 = blockchain_service.get_w3()
                contract = blockchain_service.get_contract(w3)
                tx = blockchain_service.set_issuer_whitelisted(w3, contract, wallet, True)
                uni.status = "verified"
                db.session.commit()
                print("Whitelisted issuer on-chain and set status=verified.")
                print(f"  tx: {tx}")
            except Exception as e:
                print(f"On-chain whitelist failed: {e}", file=sys.stderr)
                print("You can approve manually from /admin when the RPC/keys are correct.")
                return 1
        else:
            print("TRUCERT_CONTRACT_ADDRESS or CONTRACT_OWNER_PRIVATE_KEY missing — left as pending.")
            print("Approve in Admin UI after fixing env.")

        print()
        print("--- Login (University portal) ---")
        print(f"  URL:      /university")
        print(f"  Email:    {DEMO_EMAIL}")
        print(f"  Password: {DEMO_PASSWORD}")
        print()
        print("--- Import this key into MetaMask (demo only; never reuse in production) ---")
        print(f"  {pk_hex}")
        print()
        print("Fund this wallet with Amoy MATIC for gas, then connect MetaMask to mint.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
