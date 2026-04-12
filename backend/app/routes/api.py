from __future__ import annotations

import re
from typing import Any

import requests
from eth_account import Account
from flask import Blueprint, jsonify, request
from flask_jwt_extended import create_access_token, get_jwt, jwt_required

from app.config import Config
from app.extensions import db
from app.models import CertificateRecord, University, User
from app.services import blockchain_service, pinata_service
from app.services.crypto_util import decrypt_private_key, encrypt_private_key

bp = Blueprint("api", __name__, url_prefix="/api")


def _require_roles(*roles: str) -> None:
    claims = get_jwt()
    if claims.get("role") not in roles:
        from flask import abort

        abort(403)


def _current_user() -> User:
    from flask_jwt_extended import get_jwt_identity

    uid = get_jwt_identity()
    if not uid:
        from flask import abort

        abort(401)
    user = db.session.get(User, int(uid))
    if not user:
        from flask import abort

        abort(401)
    return user


def _ipfs_uri_to_http(uri: str) -> str:
    u = uri.strip()
    if u.startswith("ipfs://"):
        rest = u.replace("ipfs://", "", 1)
        cid = rest.split("/")[0]
        return f"https://gateway.pinata.cloud/ipfs/{cid}"
    return u


@bp.post("/auth/register-university")
def register_university():
    data = request.get_json(silent=True) or {}
    required = (
        "name",
        "internal_id",
        "domain_email",
        "contact_email",
        "password",
        "issuer_private_key",
    )
    for k in required:
        if not data.get(k):
            return jsonify({"error": f"Missing field: {k}"}), 400

    domain = data["domain_email"].strip().lower()
    contact = data["contact_email"].strip().lower()
    if contact.split("@")[-1] != domain:
        return jsonify({"error": "Contact email must use the university domain_email"}), 400

    if User.query.filter_by(email=contact).first():
        return jsonify({"error": "Email already registered"}), 400
    if University.query.filter_by(internal_id=data["internal_id"].strip()).first():
        return jsonify({"error": "internal_id already used"}), 400

    pk = data["issuer_private_key"].strip()
    if pk.startswith("0x"):
        pk = pk[2:]
    if not re.fullmatch(r"[0-9a-fA-F]{64}", pk):
        return jsonify({"error": "issuer_private_key must be a 32-byte hex string"}), 400

    account = Account.from_key("0x" + pk)
    wallet = account.address

    if University.query.filter_by(wallet_address=wallet).first():
        return jsonify({"error": "This issuer wallet is already registered"}), 400

    enc = encrypt_private_key(Config.SECRET_KEY, "0x" + pk)

    uni = University(
        name=data["name"].strip(),
        internal_id=data["internal_id"].strip(),
        domain_email=domain,
        wallet_address=wallet,
        private_key_encrypted=enc,
        status="pending",
        kyc_notes=data.get("kyc_notes"),
    )
    user = User(email=contact, role="university")
    user.set_password(data["password"])
    user.university = uni

    db.session.add(uni)
    db.session.add(user)
    db.session.commit()

    return (
        jsonify(
            {
                "message": "Registration submitted. Await manual admin verification.",
                "university_id": uni.id,
                "derived_wallet_address": wallet,
            }
        ),
        201,
    )


@bp.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    user = User.query.filter_by(email=email).first()
    if not user or not user.check_password(password):
        return jsonify({"error": "Invalid credentials"}), 401

    token = create_access_token(
        identity=str(user.id),
        additional_claims={"role": user.role},
    )
    return jsonify({"access_token": token, "role": user.role, "university_id": user.university_id})


@bp.get("/admin/universities")
@jwt_required()
def list_universities():
    _require_roles("admin")
    status = request.args.get("status")
    q = University.query
    if status:
        q = q.filter_by(status=status)
    rows = q.order_by(University.created_at.desc()).all()
    return jsonify(
        {
            "universities": [
                {
                    "id": u.id,
                    "name": u.name,
                    "internal_id": u.internal_id,
                    "domain_email": u.domain_email,
                    "wallet_address": u.wallet_address,
                    "status": u.status,
                    "kyc_notes": u.kyc_notes,
                    "created_at": u.created_at.isoformat() if u.created_at else None,
                }
                for u in rows
            ]
        }
    )


@bp.post("/admin/universities/<int:uni_id>/approve")
@jwt_required()
def approve_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    if uni.status == "verified":
        return jsonify({"message": "Already verified"}), 200

    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)
    tx = blockchain_service.set_issuer_whitelisted(w3, contract, uni.wallet_address, True)

    uni.status = "verified"
    db.session.commit()
    return jsonify({"message": "University verified and issuer whitelisted on-chain", "tx": tx})


@bp.post("/admin/universities/<int:uni_id>/reject")
@jwt_required()
def reject_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    uni.status = "rejected"
    db.session.commit()
    return jsonify({"message": "University registration rejected"})


@bp.get("/university/me")
@jwt_required()
def university_me():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    return jsonify(
        {
            "name": uni.name,
            "internal_id": uni.internal_id,
            "status": uni.status,
            "wallet_address": uni.wallet_address,
        }
    )


@bp.post("/university/certificates")
@jwt_required()
def mint_certificate():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403

    data = request.get_json(silent=True) or {}
    token_id = data.get("token_id")
    if token_id is None:
        return jsonify({"error": "token_id required"}), 400
    try:
        token_id = int(token_id)
    except (TypeError, ValueError):
        return jsonify({"error": "token_id must be an integer"}), 400

    meta_fields = (
        "student_full_name",
        "degree_title",
        "institution_name",
        "gpa_honors",
        "issue_date",
    )
    metadata: dict[str, Any] = {"format": "trucert-v1"}
    for k in meta_fields:
        if not data.get(k):
            return jsonify({"error": f"Missing metadata field: {k}"}), 400
        metadata[k] = data[k]

    if CertificateRecord.query.filter_by(token_id=token_id).first():
        return jsonify({"error": "token_id already used in database"}), 400

    try:
        ipfs_uri = pinata_service.pin_certificate_metadata(
            token_id, metadata, Config.PINATA_JWT
        )
    except Exception as e:
        return jsonify({"error": f"Pinata upload failed: {e!s}"}), 502

    pk = decrypt_private_key(Config.SECRET_KEY, uni.private_key_encrypted)
    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)
    try:
        tx = blockchain_service.mint_to_escrow(w3, contract, pk, token_id, ipfs_uri)
    except Exception as e:
        return jsonify({"error": f"Mint failed: {e!s}"}), 502

    rec = CertificateRecord(token_id=token_id, university_id=uni.id, ipfs_uri=ipfs_uri)
    db.session.add(rec)
    db.session.commit()

    return jsonify({"tx": tx, "token_id": token_id, "metadata_uri": ipfs_uri}), 201


@bp.post("/university/certificates/<int:token_id>/claim")
@jwt_required()
def claim_certificate(token_id: int):
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403

    data = request.get_json(silent=True) or {}
    student_wallet = data.get("student_wallet") or ""
    if not student_wallet.startswith("0x") or len(student_wallet) != 42:
        return jsonify({"error": "student_wallet must be a checksummed 0x address"}), 400

    pk = decrypt_private_key(Config.SECRET_KEY, uni.private_key_encrypted)
    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)
    try:
        student_wallet = w3.to_checksum_address(student_wallet)
        tx = blockchain_service.claim_certificate(w3, contract, pk, token_id, student_wallet)
    except Exception as e:
        return jsonify({"error": f"Claim failed: {e!s}"}), 502

    return jsonify({"tx": tx, "token_id": token_id})


@bp.post("/university/certificates/<int:token_id>/revoke")
@jwt_required()
def revoke_certificate_route(token_id: int):
    user = _current_user()
    claims = get_jwt()
    role = claims.get("role")
    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)

    if role == "admin":
        pk = Config.CONTRACT_OWNER_PRIVATE_KEY
        if not pk:
            return jsonify({"error": "CONTRACT_OWNER_PRIVATE_KEY not configured"}), 500
    elif role == "university":
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        pk = decrypt_private_key(Config.SECRET_KEY, uni.private_key_encrypted)
    else:
        return jsonify({"error": "Forbidden"}), 403

    try:
        tx = blockchain_service.revoke_certificate(w3, contract, pk, token_id)
    except Exception as e:
        return jsonify({"error": f"Revoke failed: {e!s}"}), 502

    return jsonify({"tx": tx, "token_id": token_id})


@bp.get("/verify/<int:token_id>")
def verify_token(token_id: int):
    if not Config.TRUCERT_CONTRACT_ADDRESS:
        return jsonify({"error": "TRUCERT_CONTRACT_ADDRESS is not configured"}), 503
    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)
    try:
        onchain = blockchain_service.read_certificate_public(w3, contract, token_id)
    except Exception as e:
        return jsonify({"error": f"Chain read failed: {e!s}"}), 502

    if not onchain.get("exists"):
        return jsonify({"token_id": token_id, "exists": False})

    uri = onchain.get("metadata_uri") or ""
    offchain: dict[str, Any] | None = None
    if uri:
        try:
            http_url = _ipfs_uri_to_http(uri)
            r = requests.get(http_url, timeout=30)
            r.raise_for_status()
            offchain = r.json()
        except Exception as e:
            offchain = {"_error": f"Could not fetch metadata: {e!s}"}

    return jsonify(
        {
            "token_id": token_id,
            "exists": True,
            "on_chain": {
                "issuer_address": onchain["issuer_address"],
                "owner_address": onchain["owner_address"],
                "locked": onchain["locked"],
                "valid": onchain["valid"],
                "metadata_uri": onchain["metadata_uri"],
            },
            "off_chain_metadata": offchain,
        }
    )


@bp.get("/health")
def health():
    return jsonify({"status": "ok"})
