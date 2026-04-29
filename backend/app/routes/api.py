from __future__ import annotations

from datetime import datetime, timezone
import csv
import io
import json
import os
import re
from typing import Any
from urllib.parse import urlparse

import requests
from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import create_access_token, get_jwt, jwt_required
from web3 import Web3

from app.config import Config
from app.extensions import db
from app.models import ActivityLog, CertificateRecord, MintBatch, MintBatchRow, University, User
from app.services import blockchain_service, metadata_signing, pinata_service

bp = Blueprint("api", __name__, url_prefix="/api")
DEFAULT_IMAGE_CID = "bafybeihehkjcmyzvdldixinxrr3k5jj37tolozwkh3q6bw2q24rzt2o2mi"
ACTION_VALUES = {"issued", "transferred", "revoked", "burned", "reissued"}


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


def _ipfs_uri_to_gateway(uri: str) -> str:
    base = Config.PINATA_GATEWAY_BASE.rstrip("/")
    u = uri.strip()
    if not u:
        return ""
    if u.startswith("ipfs://"):
        cid = u.replace("ipfs://", "", 1)
        return f"{base}/{cid}"
    return u


def _normalize_action(action: str | None) -> str:
    if not action:
        return "issued"
    a = action.strip().lower()
    if a == "status_changed":
        return "revoked"
    if a in ACTION_VALUES:
        return a
    if a == "prepared":
        return "issued"
    return "issued"


def _valid_email(v: str) -> bool:
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v))


def _valid_date(v: str) -> bool:
    try:
        datetime.strptime(v, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _valid_url(v: str) -> bool:
    p = urlparse(v)
    return p.scheme in {"http", "https"} and bool(p.netloc)


def _extract_institution_profile_fields(data: dict[str, Any]) -> dict[str, str | None]:
    fields = {
        "institution_contact_email": (data.get("institution_contact_email") or "").strip() or None,
        "institution_contact_phone": (data.get("institution_contact_phone") or "").strip() or None,
        "institution_website": (data.get("institution_website") or "").strip() or None,
        "institution_license_id": (data.get("institution_license_id") or "").strip() or None,
        "institution_license_authority": (data.get("institution_license_authority") or "").strip() or None,
        "institution_license_valid_until": (data.get("institution_license_valid_until") or "").strip() or None,
    }
    if fields["institution_contact_email"] and not _valid_email(fields["institution_contact_email"]):
        raise ValueError("institution_contact_email must be a valid email")
    if fields["institution_website"] and not _valid_url(fields["institution_website"]):
        raise ValueError("institution_website must be a valid http(s) URL")
    if fields["institution_license_valid_until"] and not _valid_date(fields["institution_license_valid_until"]):
        raise ValueError("institution_license_valid_until must be YYYY-MM-DD")
    return fields


def _missing_profile_fields(uni: University) -> list[str]:
    required = {
        "institution_contact_email": uni.institution_contact_email,
        "institution_contact_phone": uni.institution_contact_phone,
        "institution_website": uni.institution_website,
        "institution_license_id": uni.institution_license_id,
        "institution_license_authority": uni.institution_license_authority,
        "institution_license_valid_until": uni.institution_license_valid_until,
    }
    return [k for k, v in required.items() if not (v or "").strip()]


def _require_contract_code(w3: Web3) -> str | None:
    if not Config.TRUCERT_CONTRACT_ADDRESS:
        return "TRUCERT_CONTRACT_ADDRESS is not configured"
    try:
        checksum = Web3.to_checksum_address(Config.TRUCERT_CONTRACT_ADDRESS.strip())
    except Exception:
        return "TRUCERT_CONTRACT_ADDRESS is invalid"
    if len(w3.eth.get_code(checksum)) == 0:
        return (
            "No contract bytecode found at TRUCERT_CONTRACT_ADDRESS on Polygon Amoy. "
            "Deploy TruCert and update backend/.env."
        )
    return None


@bp.post("/auth/register-university")
def register_university():
    data = request.get_json(silent=True) or {}
    required = (
        "name",
        "internal_id",
        "domain_email",
        "contact_email",
        "password",
        "issuer_wallet_address",
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

    wallet = (data["issuer_wallet_address"] or "").strip()
    if not wallet.startswith("0x") or len(wallet) != 42:
        return jsonify({"error": "issuer_wallet_address must be a 0x address"}), 400
    try:
        wallet = Web3.to_checksum_address(wallet)
    except Exception:
        return jsonify({"error": "issuer_wallet_address is invalid"}), 400

    if University.query.filter_by(wallet_address=wallet).first():
        return jsonify({"error": "This issuer wallet is already registered"}), 400
    try:
        profile_fields = _extract_institution_profile_fields(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    uni = University(
        name=data["name"].strip(),
        internal_id=data["internal_id"].strip(),
        domain_email=domain,
        wallet_address=wallet,
        institution_contact_email=profile_fields["institution_contact_email"],
        institution_contact_phone=profile_fields["institution_contact_phone"],
        institution_website=profile_fields["institution_website"],
        institution_license_id=profile_fields["institution_license_id"],
        institution_license_authority=profile_fields["institution_license_authority"],
        institution_license_valid_until=profile_fields["institution_license_valid_until"],
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
                "issuer_wallet_address": wallet,
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
    chain_id = 80002
    try:
        chain_id = int(blockchain_service.get_w3().eth.chain_id)
    except Exception:
        pass
    return jsonify(
        {
            "name": uni.name,
            "internal_id": uni.internal_id,
            "status": uni.status,
            "wallet_address": uni.wallet_address,
            "contract_address": Config.TRUCERT_CONTRACT_ADDRESS,
            "chain_id": chain_id,
            "logo_uri": uni.logo_uri,
            "logo_url": _ipfs_uri_to_gateway(uni.logo_uri or ""),
            "institution_contact_email": uni.institution_contact_email,
            "institution_contact_phone": uni.institution_contact_phone,
            "institution_website": uni.institution_website,
            "institution_license_id": uni.institution_license_id,
            "institution_license_authority": uni.institution_license_authority,
            "institution_license_valid_until": uni.institution_license_valid_until,
        }
    )


@bp.put("/university/profile")
@jwt_required()
def update_university_profile():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    data = request.get_json(silent=True) or {}
    try:
        fields = _extract_institution_profile_fields(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    for k, v in fields.items():
        if v is not None:
            setattr(uni, k, v)
    db.session.commit()
    return jsonify({"message": "University profile updated."})


@bp.post("/university/logo")
@jwt_required()
def upload_university_logo():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403
    file = request.files.get("file")
    if file is None:
        return jsonify({"error": "file is required"}), 400
    mime = (file.mimetype or "").lower()
    allowed = {"image/png", "image/jpeg", "image/webp", "image/gif"}
    if mime not in allowed:
        return jsonify({"error": "Unsupported image type. Use png/jpeg/webp/gif"}), 400
    blob = file.read()
    if not blob:
        return jsonify({"error": "Uploaded file is empty"}), 400
    if len(blob) > Config.UNIVERSITY_LOGO_MAX_BYTES:
        return jsonify({"error": "Image exceeds 2MB limit"}), 400
    try:
        logo_uri = pinata_service.pin_file_bytes(
            file.filename or f"university-logo-{uni.id}.png",
            blob,
            mime,
            Config.PINATA_JWT,
        )
    except Exception as e:
        return jsonify({"error": f"Logo upload failed: {e!s}"}), 502
    uni.logo_uri = logo_uri
    db.session.commit()
    return jsonify(
        {
            "message": "Logo uploaded.",
            "logo_uri": logo_uri,
            "logo_url": _ipfs_uri_to_gateway(logo_uri),
        }
    )


def _build_metadata(
    data: dict[str, Any],
    uni: University,
    *,
    supersedes_token_id: int | None = None,
    skip_cert_id_uniqueness: bool = False,
) -> dict[str, Any]:
    required = ("student_name", "degree_type", "issue_date", "cert_id")
    for k in required:
        if not data.get(k):
            raise ValueError(f"Missing metadata field: {k}")
    cert_id = str(data["cert_id"]).strip()
    if not skip_cert_id_uniqueness and CertificateRecord.query.filter_by(cert_id=cert_id).first():
        raise ValueError("cert_id already exists in database")
    missing_profile = _missing_profile_fields(uni)
    if missing_profile:
        raise ValueError(f"Institution profile incomplete: missing {missing_profile[0]}")

    image = (data.get("image") or "").strip() or f"ipfs://{DEFAULT_IMAGE_CID}"
    metadata: dict[str, Any] = {
        "format": "trucert-v1",
        "name": f"TruCert Certificate #{cert_id}",
        "description": f"Academic credential issued by {uni.name}",
        "image": image,
        "student_full_name": str(data["student_name"]).strip(),
        "degree_title": str(data["degree_type"]).strip(),
        "issue_date": str(data["issue_date"]).strip(),
        "institution_name": uni.name,
        "institution_logo": uni.logo_uri or f"ipfs://{DEFAULT_IMAGE_CID}",
        "institution_contact_email": uni.institution_contact_email,
        "institution_contact_phone": uni.institution_contact_phone,
        "institution_website": uni.institution_website,
        "institution_license_id": uni.institution_license_id,
        "institution_license_authority": uni.institution_license_authority,
        "institution_license_valid_until": uni.institution_license_valid_until,
        "cert_id": cert_id,
        "verification_method": "onchain+ipfs",
    }
    if supersedes_token_id is not None:
        metadata["supersedes_token_id"] = supersedes_token_id
    return metadata


def _core_hash_hex(metadata: dict[str, Any]) -> str:
    digest = Web3.solidity_keccak(
        ["string", "string", "string", "string", "string"],
        [
            metadata["institution_name"],
            metadata["student_full_name"],
            metadata["degree_title"],
            metadata["cert_id"],
            metadata["issue_date"],
        ],
    )
    # solidity_keccak returns HexBytes and .hex() already includes the 0x prefix.
    return digest.hex()


def _signature_status(metadata: dict[str, Any]) -> dict[str, Any]:
    ok, reason = metadata_signing.verify_metadata_signature(metadata)
    return {"ok": ok, "reason": reason, "kid": metadata.get("trucert_sig_kid")}


@bp.post("/university/certificates/prepare-mint")
@jwt_required()
def prepare_mint_certificate():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403

    data = request.get_json(silent=True) or {}
    try:
        metadata = _build_metadata(data, uni)
        core_hash = _core_hash_hex(metadata)
        signed_metadata = metadata_signing.sign_metadata(metadata)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        w3 = blockchain_service.get_w3()
        cfg_err = _require_contract_code(w3)
        if cfg_err:
            return jsonify({"error": cfg_err}), 503
        contract = blockchain_service.get_contract(w3)
        next_token_id = int(contract.functions.nextTokenId().call())
        ipfs_uri = pinata_service.pin_certificate_metadata(next_token_id, signed_metadata, Config.PINATA_JWT)
    except Exception as e:
        return jsonify({"error": f"Prepare mint failed: {e!s}"}), 502

    rec = CertificateRecord.query.filter_by(token_id=next_token_id).first()
    if not rec:
        rec = CertificateRecord(token_id=next_token_id, university_id=uni.id, ipfs_uri=ipfs_uri)
        db.session.add(rec)
    rec.university_id = uni.id
    rec.ipfs_uri = ipfs_uri
    rec.cert_id = metadata["cert_id"]
    rec.core_hash = core_hash
    rec.status = "prepared"
    db.session.commit()

    return jsonify(
        {
            "metadata_uri": ipfs_uri,
            "core_hash": core_hash,
            "cert_id": metadata["cert_id"],
            "next_token_id_hint": next_token_id,
            "institution_name": metadata["institution_name"],
        }
    )


@bp.post("/university/certificates/prepare-reissue/<int:old_token_id>")
@jwt_required()
def prepare_reissue(old_token_id: int):
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403

    data = request.get_json(silent=True) or {}
    try:
        metadata = _build_metadata(data, uni, supersedes_token_id=old_token_id)
        core_hash = _core_hash_hex(metadata)
        signed_metadata = metadata_signing.sign_metadata(metadata)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        w3 = blockchain_service.get_w3()
        cfg_err = _require_contract_code(w3)
        if cfg_err:
            return jsonify({"error": cfg_err}), 503
        contract = blockchain_service.get_contract(w3)
        next_token_id = int(contract.functions.nextTokenId().call())
        ipfs_uri = pinata_service.pin_certificate_metadata(next_token_id, signed_metadata, Config.PINATA_JWT)
    except Exception as e:
        return jsonify({"error": f"Prepare reissue failed: {e!s}"}), 502

    rec = CertificateRecord.query.filter_by(token_id=next_token_id).first()
    if not rec:
        rec = CertificateRecord(token_id=next_token_id, university_id=uni.id, ipfs_uri=ipfs_uri)
        db.session.add(rec)
    rec.university_id = uni.id
    rec.ipfs_uri = ipfs_uri
    rec.cert_id = metadata["cert_id"]
    rec.core_hash = core_hash
    rec.status = "prepared"
    rec.supersedes_token_id = old_token_id
    db.session.commit()

    return jsonify(
        {
            "metadata_uri": ipfs_uri,
            "core_hash": core_hash,
            "cert_id": metadata["cert_id"],
            "old_token_id": old_token_id,
            "next_token_id_hint": next_token_id,
        }
    )


@bp.get("/university/activity")
@jwt_required()
def list_university_activity():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    limit = min(max(int(request.args.get("limit", 100)), 1), 300)
    rows = (
        ActivityLog.query.filter_by(university_id=uni.id)
        .order_by(ActivityLog.block_number.desc(), ActivityLog.log_index.desc())
        .limit(limit)
        .all()
    )
    return jsonify(
        {
            "events": [
                {
                    "token_id": r.token_id,
                    "action": r.action,
                    "tx_hash": r.tx_hash,
                    "block_number": r.block_number,
                    "actor": r.actor,
                    "details": json.loads(r.details_json) if r.details_json else None,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ]
        }
    )


@bp.get("/university/activity/basic")
@jwt_required()
def list_university_activity_basic():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400

    limit = min(max(int(request.args.get("limit", 100)), 1), 300)
    rows = (
        CertificateRecord.query.filter_by(university_id=uni.id)
        .order_by(CertificateRecord.created_at.desc())
        .limit(limit)
        .all()
    )
    token_ids = [r.token_id for r in rows]
    latest_logs_by_token: dict[int, ActivityLog] = {}
    if token_ids:
        logs = (
            ActivityLog.query.filter(ActivityLog.university_id == uni.id, ActivityLog.token_id.in_(token_ids))
            .order_by(ActivityLog.block_number.desc(), ActivityLog.log_index.desc())
            .all()
        )
        for lg in logs:
            if lg.token_id is None or lg.token_id in latest_logs_by_token:
                continue
            latest_logs_by_token[lg.token_id] = lg

    w3 = blockchain_service.get_w3()
    cfg_err = _require_contract_code(w3)
    contract = blockchain_service.get_contract(w3) if not cfg_err else None

    events: list[dict[str, Any]] = []
    for r in rows:
        if contract is None:
            lg = latest_logs_by_token.get(r.token_id)
            events.append(
                {
                    "token_id": r.token_id,
                    "action": _normalize_action((lg.action if lg else r.status) or "issued"),
                    "tx_hash": lg.tx_hash if lg else None,
                    "block_number": lg.block_number if lg else None,
                    "actor": uni.wallet_address,
                    "details": {
                        "metadata_uri": r.ipfs_uri,
                        "cert_id": r.cert_id,
                        "core_hash": r.core_hash,
                        "on_chain_error": cfg_err,
                    },
                    "created_at": (
                        (lg.block_timestamp or lg.created_at).isoformat()
                        if lg and (lg.block_timestamp or lg.created_at)
                        else (r.created_at.isoformat() if r.created_at else None)
                    ),
                }
            )
            continue

        try:
            onchain = blockchain_service.read_certificate_public(w3, contract, r.token_id)
        except Exception as e:
            onchain = {"exists": False, "_error": str(e)}

        if not onchain.get("exists"):
            action = "burned"
        elif not onchain.get("valid", True):
            action = "revoked"
        elif onchain.get("locked"):
            action = "transferred"
        else:
            action = "issued"
        lg = latest_logs_by_token.get(r.token_id)
        if lg:
            action = _normalize_action(lg.action)

        details: dict[str, Any] = {
            "metadata_uri": r.ipfs_uri,
            "cert_id": r.cert_id,
            "core_hash": r.core_hash,
            "status": r.status,
            "supersedes_token_id": r.supersedes_token_id,
        }
        if onchain.get("exists"):
            details["owner_address"] = onchain.get("owner_address")
            details["issuer_address"] = onchain.get("issuer_address")
            details["valid"] = onchain.get("valid")
            details["locked"] = onchain.get("locked")
        elif onchain.get("_error"):
            details["on_chain_error"] = onchain["_error"]

        events.append(
            {
                "token_id": r.token_id,
                "action": action,
                "tx_hash": lg.tx_hash if lg else None,
                "block_number": lg.block_number if lg else None,
                "actor": (lg.actor if lg else uni.wallet_address),
                "details": details,
                "created_at": (
                    (lg.block_timestamp or lg.created_at).isoformat()
                    if lg and (lg.block_timestamp or lg.created_at)
                    else (r.created_at.isoformat() if r.created_at else None)
                ),
            }
        )

    return jsonify({"events": events})


def _upsert_certificate_status(
    *,
    university: University | None,
    token_id: int,
    ipfs_uri: str | None = None,
    core_hash: str | None = None,
    cert_id: str | None = None,
    status: str | None = None,
    supersedes_token_id: int | None = None,
) -> None:
    if not university:
        return
    rec = CertificateRecord.query.filter_by(token_id=token_id).first()
    if not rec:
        rec = CertificateRecord(
            token_id=token_id,
            university_id=university.id,
            ipfs_uri=ipfs_uri or "",
        )
        db.session.add(rec)
    if ipfs_uri:
        rec.ipfs_uri = ipfs_uri
    if core_hash:
        rec.core_hash = core_hash
    if cert_id:
        rec.cert_id = cert_id
    if status:
        rec.status = status
    if supersedes_token_id is not None:
        rec.supersedes_token_id = supersedes_token_id


def _append_activity(
    *,
    university_id: int | None,
    token_id: int | None,
    action: str,
    tx_hash: str,
    log_index: int,
    block_number: int,
    actor: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    existing = ActivityLog.query.filter_by(tx_hash=tx_hash, log_index=log_index).first()
    if existing:
        return
    block_dt = datetime.now(timezone.utc)
    try:
        blk = blockchain_service.get_w3().eth.get_block(block_number)
        block_dt = datetime.fromtimestamp(int(blk["timestamp"]), tz=timezone.utc)
    except Exception:
        pass
    db.session.add(
        ActivityLog(
            university_id=university_id,
            token_id=token_id,
            action=action,
            tx_hash=tx_hash,
            log_index=log_index,
            block_number=block_number,
            block_timestamp=block_dt,
            actor=actor,
            details_json=json.dumps(details) if details else None,
            created_at=block_dt,
        )
    )


def _safe_event_logs(
    event: Any,
    *,
    from_block: int,
    to_block: int,
    argument_filters: dict[str, Any] | None = None,
    step: int = 2000,
) -> list[Any]:
    """Fetch logs in windows to avoid RPC block-range limits."""
    logs: list[Any] = []
    start = max(0, from_block)
    end = max(start, to_block)
    while start <= end:
        current_step = max(1, step)
        while True:
            chunk_end = min(start + current_step - 1, end)
            kwargs: dict[str, Any] = {"fromBlock": start, "toBlock": chunk_end}
            if argument_filters is not None:
                kwargs["argument_filters"] = argument_filters
            try:
                logs.extend(event.get_logs(**kwargs))
                start = chunk_end + 1
                break
            except Exception as e:
                msg = str(e).lower()
                if "block range exceeds configured limit" in msg and current_step > 1:
                    current_step = max(1, current_step // 2)
                    continue
                raise
    return logs


@bp.post("/university/activity/sync")
@jwt_required()
def sync_university_activity():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    if uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403

    latest_synced = (
        db.session.query(db.func.max(ActivityLog.block_number))
        .filter(ActivityLog.university_id == uni.id)
        .scalar()
    )
    default_from = int(latest_synced) + 1 if latest_synced is not None else 0
    from_block = int(request.args.get("from_block", default_from))
    try:
        w3 = blockchain_service.get_w3()
        cfg_err = _require_contract_code(w3)
        if cfg_err:
            return jsonify({"error": cfg_err}), 503
        contract = blockchain_service.get_contract(w3)
        to_block = int(w3.eth.block_number)
    except Exception as e:
        return jsonify({"error": f"Contract configuration error: {e!s}"}), 502
    wallet = Web3.to_checksum_address(uni.wallet_address)

    synced = 0
    try:
        minted = _safe_event_logs(
            contract.events.CertificateMinted,
            from_block=from_block,
            to_block=to_block,
            argument_filters={"issuer": wallet},
        )
    except Exception as e:
        return jsonify({"error": f"Activity sync failed (CertificateMinted): {e!s}"}), 502
    for ev in minted:
        token_id = int(ev["args"]["tokenId"])
        txh = ev["transactionHash"].hex()
        _upsert_certificate_status(
            university=uni,
            token_id=token_id,
            ipfs_uri=ev["args"]["tokenURI"],
            core_hash=ev["args"]["coreHash"].hex() if hasattr(ev["args"]["coreHash"], "hex") else str(ev["args"]["coreHash"]),
            cert_id=ev["args"]["certId"],
            status="issued",
        )
        _append_activity(
            university_id=uni.id,
            token_id=token_id,
            action="issued",
            tx_hash=txh,
            log_index=int(ev["logIndex"]),
            block_number=int(ev["blockNumber"]),
            actor=wallet,
            details={"metadata_uri": ev["args"]["tokenURI"], "cert_id": ev["args"]["certId"]},
        )
        synced += 1

    try:
        claims = _safe_event_logs(
            contract.events.CertificateClaimed,
            from_block=from_block,
            to_block=to_block,
        )
    except Exception as e:
        return jsonify({"error": f"Activity sync failed (CertificateClaimed): {e!s}"}), 502
    for ev in claims:
        token_id = int(ev["args"]["tokenId"])
        txh = ev["transactionHash"].hex()
        issuer = contract.functions.issuerOf(token_id).call()
        if issuer.lower() != wallet.lower():
            continue
        _append_activity(
            university_id=uni.id,
            token_id=token_id,
            action="transferred",
            tx_hash=txh,
            log_index=int(ev["logIndex"]),
            block_number=int(ev["blockNumber"]),
            actor=ev["args"]["from"],
            details={"to": ev["args"]["student"]},
        )
        synced += 1

    try:
        revoked = _safe_event_logs(
            contract.events.CertificateRevoked,
            from_block=from_block,
            to_block=to_block,
        )
    except Exception as e:
        return jsonify({"error": f"Activity sync failed (CertificateRevoked): {e!s}"}), 502
    for ev in revoked:
        token_id = int(ev["args"]["tokenId"])
        issuer = contract.functions.issuerOf(token_id).call()
        if issuer.lower() != wallet.lower():
            continue
        _upsert_certificate_status(university=uni, token_id=token_id, status="revoked")
        _append_activity(
            university_id=uni.id,
            token_id=token_id,
            action="revoked",
            tx_hash=ev["transactionHash"].hex(),
            log_index=int(ev["logIndex"]),
            block_number=int(ev["blockNumber"]),
            actor=wallet,
            details={"status": "revoked"},
        )
        synced += 1

    try:
        burned = _safe_event_logs(
            contract.events.CertificateBurned,
            from_block=from_block,
            to_block=to_block,
            argument_filters={"issuer": wallet},
        )
    except Exception as e:
        return jsonify({"error": f"Activity sync failed (CertificateBurned): {e!s}"}), 502
    for ev in burned:
        token_id = int(ev["args"]["tokenId"])
        _upsert_certificate_status(university=uni, token_id=token_id, status="burned")
        _append_activity(
            university_id=uni.id,
            token_id=token_id,
            action="burned",
            tx_hash=ev["transactionHash"].hex(),
            log_index=int(ev["logIndex"]),
            block_number=int(ev["blockNumber"]),
            actor=wallet,
            details=None,
        )
        synced += 1

    try:
        reissued = _safe_event_logs(
            contract.events.CertificateReissued,
            from_block=from_block,
            to_block=to_block,
            argument_filters={"issuer": wallet},
        )
    except Exception as e:
        return jsonify({"error": f"Activity sync failed (CertificateReissued): {e!s}"}), 502
    for ev in reissued:
        old_token = int(ev["args"]["oldTokenId"])
        new_token = int(ev["args"]["newTokenId"])
        _upsert_certificate_status(university=uni, token_id=old_token, status="reissued")
        _upsert_certificate_status(
            university=uni, token_id=new_token, status="issued", supersedes_token_id=old_token
        )
        _append_activity(
            university_id=uni.id,
            token_id=new_token,
            action="reissued",
            tx_hash=ev["transactionHash"].hex(),
            log_index=int(ev["logIndex"]),
            block_number=int(ev["blockNumber"]),
            actor=wallet,
            details={"old_token_id": old_token, "new_token_id": new_token},
        )
        synced += 1

    db.session.commit()
    return jsonify({"synced_events": synced, "latest_block": to_block, "from_block": from_block})


@bp.get("/verify/<int:token_id>")
def verify_token(token_id: int):
    if not Config.TRUCERT_CONTRACT_ADDRESS:
        return jsonify({"error": "TRUCERT_CONTRACT_ADDRESS is not configured"}), 503
    w3 = blockchain_service.get_w3()
    checksum = Web3.to_checksum_address(Config.TRUCERT_CONTRACT_ADDRESS.strip())
    if len(w3.eth.get_code(checksum)) == 0:
        return jsonify(
            {
                "error": (
                    "TRUCERT_CONTRACT_ADDRESS has no contract bytecode on Polygon Amoy. "
                    "Set it to the TruCert address from "
                    "`npx hardhat run scripts/deploy.js --network polygonAmoy` — not a university or student wallet."
                )
            }
        ), 503
    contract = blockchain_service.get_contract(w3)
    try:
        onchain = blockchain_service.read_certificate_public(w3, contract, token_id)
    except Exception as e:
        return jsonify({"error": f"Chain read failed: {e!s}"}), 502

    if not onchain.get("exists"):
        return jsonify(
            {
                "token_id": token_id,
                "exists": False,
                "hint": (
                    "This token ID is not minted on the configured contract, or the contract/network "
                    "does not match where the certificate was issued."
                ),
            }
        )

    uri = onchain.get("metadata_uri") or ""
    offchain: dict[str, Any] | None = None
    if uri:
        try:
            http_url = _ipfs_uri_to_http(uri)
            r = requests.get(http_url, timeout=30)
            r.raise_for_status()
            offchain = r.json()
            offchain["_signature"] = _signature_status(offchain)
        except Exception as e:
            offchain = {"_error": f"Could not fetch metadata: {e!s}"}

    try:
        chain_id = int(w3.eth.chain_id)
    except Exception:
        chain_id = 80002
    return jsonify(
        {
            "token_id": token_id,
            "exists": True,
            "chain_id": chain_id,
            "contract_address": checksum,
            "on_chain": {
                "issuer_address": onchain["issuer_address"],
                "owner_address": onchain["owner_address"],
                "locked": onchain["locked"],
                "valid": onchain["valid"],
                "metadata_uri": onchain["metadata_uri"],
                "core_hash": onchain.get("core_hash"),
            },
            "off_chain_metadata": offchain,
        }
    )


@bp.post("/verify/fields")
def verify_by_fields():
    data = request.get_json(silent=True) or {}
    required = ("institution_name", "student_name", "degree_type", "cert_id", "issue_date")
    missing = [k for k in required if not str(data.get(k) or "").strip()]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    normalized = {
        "institution_name": str(data["institution_name"]).strip(),
        "student_full_name": str(data["student_name"]).strip(),
        "degree_title": str(data["degree_type"]).strip(),
        "cert_id": str(data["cert_id"]).strip(),
        "issue_date": str(data["issue_date"]).strip(),
    }
    core_hash = _core_hash_hex(normalized)
    rec = (
        CertificateRecord.query.filter_by(cert_id=normalized["cert_id"]).first()
        or CertificateRecord.query.filter_by(core_hash=core_hash).first()
    )
    if not rec:
        return jsonify({"matched": False, "core_hash": core_hash, "error": "No indexed certificate match"}), 404
    if rec.core_hash and rec.core_hash.lower() != core_hash.lower():
        return jsonify({"matched": False, "core_hash": core_hash, "error": "Provided fields do not match indexed hash"}), 400
    w3 = blockchain_service.get_w3()
    cfg_err = _require_contract_code(w3)
    if cfg_err:
        return jsonify({"error": cfg_err}), 503
    contract = blockchain_service.get_contract(w3)
    try:
        onchain = blockchain_service.read_certificate_public(w3, contract, rec.token_id)
    except Exception as e:
        return jsonify({"error": f"Chain read failed: {e!s}"}), 502
    offchain: dict[str, Any] | None = None
    if onchain.get("exists") and onchain.get("metadata_uri"):
        try:
            rr = requests.get(_ipfs_uri_to_http(onchain["metadata_uri"]), timeout=30)
            rr.raise_for_status()
            offchain = rr.json()
            offchain["_signature"] = _signature_status(offchain)
        except Exception as e:
            offchain = {"_error": f"Could not fetch metadata: {e!s}"}
    try:
        chain_id = int(w3.eth.chain_id)
    except Exception:
        chain_id = 80002
    contract_checksum = Web3.to_checksum_address(Config.TRUCERT_CONTRACT_ADDRESS.strip())
    return jsonify(
        {
            "matched": True,
            "token_id": rec.token_id,
            "core_hash": core_hash,
            "chain_id": chain_id,
            "contract_address": contract_checksum,
            "on_chain": {
                "exists": onchain.get("exists"),
                "issuer_address": onchain.get("issuer_address"),
                "owner_address": onchain.get("owner_address"),
                "valid": onchain.get("valid"),
                "locked": onchain.get("locked"),
                "metadata_uri": onchain.get("metadata_uri"),
                "core_hash": onchain.get("core_hash"),
            },
            "off_chain_metadata": offchain,
        }
    )


@bp.get("/health")
def health():
    return jsonify({"status": "ok"})
