from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import csv
import logging
import io
import json
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import requests
from flask import Blueprint, Response, current_app, jsonify, make_response, request
from flask_jwt_extended import create_access_token, get_jwt, jwt_required
from web3 import Web3

from app.config import Config
from app.extensions import db
from app.models import (
    ActivityLog,
    CertificateRecord,
    MintAuthorizationRequest,
    MintBatch,
    MintBatchRow,
    Notification,
    University,
    User,
)
from app.services import (
    ai_response_cache,
    analytics_service,
    blockchain_service,
    eip712_service,
    gemini_service,
    metadata_signing,
    notification_service,
    pinata_service,
    risk_hints_service,
)
from app.university_freeze import freeze_guard_response, sync_uni_eip712_watermark

bp = Blueprint("api", __name__, url_prefix="/api")
logger = logging.getLogger(__name__)
DEFAULT_IMAGE_CID = "bafybeihehkjcmyzvdldixinxrr3k5jj37tolozwkh3q6bw2q24rzt2o2mi"
ACTION_VALUES = {"issued", "transferred", "revoked", "burned", "reissued"}
GEMINI_TEST_MAX_PROMPT_CHARS = 2000


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


def _parse_int_qs(v: str | None, default: int, *, lo: int, hi: int) -> int:
    try:
        n = int(str(v).strip())
    except Exception:
        return default
    return max(lo, min(hi, n))


def _parse_bool_qs(v: str | None, default: bool) -> bool:
    if v is None:
        return default
    t = str(v).strip().lower()
    if t in {"1", "true", "yes", "y", "on"}:
        return True
    if t in {"0", "false", "no", "n", "off"}:
        return False
    return default


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


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_INST_DOC_MAX_BYTES = 15 * 1024 * 1024
_INST_DOC_MAX_FILES = 12
_INST_DOC_MIMES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}


def _load_institution_documents(uni: University) -> list[dict[str, Any]]:
    raw = (uni.institution_documents_json or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _serialize_document_entry(entry: dict[str, Any]) -> dict[str, Any]:
    uri = (entry.get("uri") or "").strip()
    out = {
        "label": entry.get("label") or "Other",
        "filename": entry.get("filename") or "",
        "uri": uri,
        "mime": entry.get("mime") or "",
        "uploaded_at": entry.get("uploaded_at") or "",
    }
    out["url"] = _ipfs_uri_to_gateway(uri) if uri.startswith("ipfs://") else uri
    return out


def _parse_operating_days(raw: Any) -> list[int]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        arr = raw
    else:
        s = str(raw).strip()
        if not s:
            return []
        arr = json.loads(s)
    if not isinstance(arr, list):
        raise ValueError("operating_days_of_week must be a JSON array")
    out: list[int] = []
    for x in arr:
        n = int(x)
        if n < 0 or n > 6:
            raise ValueError("operating_days_of_week entries must be integers 0–6 (Mon–Sun)")
        out.append(n)
    return out


def _parse_operational_fields(
    data: dict[str, Any],
    *,
    require_monthly: bool,
) -> dict[str, Any]:
    """
    Returns dict with keys:
      expected_mints_monthly (int|None), expected_mints_annually (int|None),
      operating_days_of_week_json (str|None), operating_hours_start/end (str|None),
      operating_timezone (str|None)
    """
    em = data.get("expected_mints_monthly")
    ea = data.get("expected_mints_annually")
    monthly: int | None = None
    annually: int | None = None
    if em is not None and str(em).strip() != "":
        monthly = int(str(em).strip())
        if monthly < 0:
            raise ValueError("expected_mints_monthly must be non-negative")
    elif require_monthly:
        raise ValueError("expected_mints_monthly is required")
    if ea is not None and str(ea).strip() != "":
        annually = int(str(ea).strip())
        if annually < 0:
            raise ValueError("expected_mints_annually must be non-negative")

    days = _parse_operating_days(data.get("operating_days_of_week"))
    h_start = (data.get("operating_hours_start") or "").strip() or None
    h_end = (data.get("operating_hours_end") or "").strip() or None
    tz = (data.get("operating_timezone") or "").strip() or None

    if h_start and not _HHMM_RE.match(h_start):
        raise ValueError("operating_hours_start must be HH:MM (24h)")
    if h_end and not _HHMM_RE.match(h_end):
        raise ValueError("operating_hours_end must be HH:MM (24h)")
    if (h_start or h_end) and not tz:
        raise ValueError("operating_timezone is required when operating hours are set")
    if (h_start or h_end) and not days:
        raise ValueError("operating_days_of_week must be non-empty when operating hours are set")
    if tz:
        try:
            ZoneInfo(tz)
        except Exception:
            raise ValueError("operating_timezone must be a valid IANA timezone name")

    days_json = json.dumps(days) if days else None
    return {
        "expected_mints_monthly": monthly,
        "expected_mints_annually": annually,
        "operating_days_of_week_json": days_json,
        "operating_hours_start": h_start,
        "operating_hours_end": h_end,
        "operating_timezone": tz,
    }


def _apply_operational_fields(uni: University, op: dict[str, Any]) -> None:
    uni.expected_mints_monthly = op.get("expected_mints_monthly")
    uni.expected_mints_annually = op.get("expected_mints_annually")
    uni.operating_days_of_week = op.get("operating_days_of_week_json")
    uni.operating_hours_start = op.get("operating_hours_start")
    uni.operating_hours_end = op.get("operating_hours_end")
    uni.operating_timezone = op.get("operating_timezone")


def _pin_institution_documents_from_uploads(
    uploads: list[Any],
    labels: list[str],
) -> list[dict[str, Any]]:
    """Pin each file to IPFS via Pinata; returns metadata dicts (requires PINATA_JWT)."""
    if not Config.PINATA_JWT:
        raise ValueError("PINATA_JWT is not configured; cannot store verification documents")
    if len(uploads) > _INST_DOC_MAX_FILES:
        raise ValueError(f"At most {_INST_DOC_MAX_FILES} documents per request")
    out: list[dict[str, Any]] = []
    for i, fs in enumerate(uploads):
        mime = (fs.mimetype or "").lower()
        if mime == "image/jpg":
            mime = "image/jpeg"
        if mime not in _INST_DOC_MIMES:
            raise ValueError(f"Unsupported document type: {mime or 'unknown'} (use PDF or png/jpeg/webp)")
        blob = fs.read()
        if not blob:
            raise ValueError(f"Empty upload: {fs.filename or i}")
        if len(blob) > _INST_DOC_MAX_BYTES:
            raise ValueError(f"Document exceeds {_INST_DOC_MAX_BYTES // (1024 * 1024)}MB: {fs.filename or i}")
        label = labels[i] if i < len(labels) and labels[i] else "Other"
        label = (label or "Other").strip()[:128]
        fname = (fs.filename or f"document-{i}").strip()[:255]
        uri = pinata_service.pin_file_bytes(fname, blob, mime, Config.PINATA_JWT)
        out.append(
            {
                "label": label,
                "filename": fname,
                "uri": uri,
                "mime": mime,
                "uploaded_at": datetime.utcnow().isoformat() + "Z",
            }
        )
    return out


def _merge_registration_payload() -> tuple[dict[str, Any], list[Any], list[str]]:
    """
    Normalize register-university input from JSON or multipart/form-data.
    Returns (flat_dict, file_list, label_list for files).
    """
    ct = (request.content_type or "").lower()
    if "multipart/form-data" in ct:
        d: dict[str, Any] = {}
        for k in request.form:
            if k == "document_labels":
                continue
            d[k] = request.form.get(k)
        files = request.files.getlist("documents")
        labels = request.form.getlist("document_labels")
        return d, files, labels
    data = request.get_json(silent=True) or {}
    return data, [], []


def _require_contract_code(w3: Web3) -> str | None:
    if not Config.TRUECERT_CONTRACT_ADDRESS:
        return "TRUECERT_CONTRACT_ADDRESS is not configured"
    try:
        checksum = Web3.to_checksum_address(Config.TRUECERT_CONTRACT_ADDRESS.strip())
    except Exception:
        return "TRUECERT_CONTRACT_ADDRESS is invalid"
    if len(w3.eth.get_code(checksum)) == 0:
        return (
            "No contract bytecode found at TRUECERT_CONTRACT_ADDRESS on Polygon Amoy. "
            "Deploy TrueCert and update backend/.env."
        )
    return None


@bp.post("/auth/register-university")
def register_university():
    """
    Create pending university + primary university user.

    Supports ``application/json`` (legacy; operational fields optional) or
    ``multipart/form-data`` with the same scalar keys as form fields plus optional
    ``documents`` (repeatable file inputs) and parallel ``document_labels`` entries.
    Multipart registration requires ``expected_mints_monthly`` and full operational
    validation when hours are provided.
    """
    data, upload_files, upload_labels = _merge_registration_payload()
    is_multipart = "multipart/form-data" in (request.content_type or "").lower()

    required = (
        "name",
        "internal_id",
        "domain_email",
        "contact_email",
        "password",
        "issuer_wallet_address",
    )
    for k in required:
        if not (data.get(k) if data.get(k) is not None else "").strip():
            return jsonify({"error": f"Missing field: {k}"}), 400

    domain = str(data["domain_email"]).strip().lower()
    contact = str(data["contact_email"]).strip().lower()
    if contact.split("@")[-1] != domain:
        return jsonify({"error": "Contact email must use the university domain_email"}), 400

    if User.query.filter_by(email=contact).first():
        return jsonify({"error": "Email already registered"}), 400
    if University.query.filter_by(internal_id=str(data["internal_id"]).strip()).first():
        return jsonify({"error": "internal_id already used"}), 400

    wallet = str(data["issuer_wallet_address"]).strip()
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

    try:
        op = _parse_operational_fields(data, require_monthly=is_multipart)
    except (ValueError, json.JSONDecodeError, TypeError) as e:
        return jsonify({"error": str(e)}), 400

    files_clean = [f for f in upload_files if f and getattr(f, "filename", None)]

    uni = University(
        name=str(data["name"]).strip(),
        internal_id=str(data["internal_id"]).strip(),
        domain_email=domain,
        wallet_address=wallet,
        institution_contact_email=profile_fields["institution_contact_email"],
        institution_contact_phone=profile_fields["institution_contact_phone"],
        institution_website=profile_fields["institution_website"],
        institution_license_id=profile_fields["institution_license_id"],
        institution_license_authority=profile_fields["institution_license_authority"],
        institution_license_valid_until=profile_fields["institution_license_valid_until"],
        status="pending",
        kyc_notes=(str(data.get("kyc_notes") or "").strip() or None),
        institution_documents_json=json.dumps([]),
    )
    _apply_operational_fields(uni, op)
    user = User(email=contact, role="university")
    user.set_password(str(data["password"]))
    user.university = uni

    db.session.add(uni)
    db.session.add(user)
    try:
        db.session.flush()
        if files_clean:
            labels = [str(x).strip() for x in upload_labels]
            pinned = _pin_institution_documents_from_uploads(files_clean, labels)
            uni.institution_documents_json = json.dumps(pinned)
        db.session.commit()
    except ValueError as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": f"Registration failed: {e!s}"}), 502

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
                    "is_frozen": bool(getattr(u, "is_frozen", False)),
                    "frozen_at": u.frozen_at.isoformat() + "Z" if getattr(u, "frozen_at", None) else None,
                }
                for u in rows
            ]
        }
    )


@bp.get("/admin/universities/<int:uni_id>")
@jwt_required()
def get_university_admin(uni_id: int):
    """Admin review payload: profile, operational fields, document metadata (no secrets)."""
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    try:
        days_parsed = json.loads(uni.operating_days_of_week or "[]")
        if not isinstance(days_parsed, list):
            days_parsed = []
    except Exception:
        days_parsed = []
    docs = [_serialize_document_entry(x) for x in _load_institution_documents(uni)]
    return jsonify(
        {
            "id": uni.id,
            "name": uni.name,
            "internal_id": uni.internal_id,
            "domain_email": uni.domain_email,
            "wallet_address": uni.wallet_address,
            "status": uni.status,
            "kyc_notes": uni.kyc_notes,
            "created_at": uni.created_at.isoformat() if uni.created_at else None,
            "institution_contact_email": uni.institution_contact_email,
            "institution_contact_phone": uni.institution_contact_phone,
            "institution_website": uni.institution_website,
            "institution_license_id": uni.institution_license_id,
            "institution_license_authority": uni.institution_license_authority,
            "institution_license_valid_until": uni.institution_license_valid_until,
            "expected_mints_monthly": uni.expected_mints_monthly,
            "expected_mints_annually": uni.expected_mints_annually,
            "operating_days_of_week": days_parsed,
            "operating_hours_start": uni.operating_hours_start,
            "operating_hours_end": uni.operating_hours_end,
            "operating_timezone": uni.operating_timezone,
            "institution_documents": docs,
            "is_frozen": bool(getattr(uni, "is_frozen", False)),
            "frozen_reason": getattr(uni, "frozen_reason", None),
            "frozen_at": uni.frozen_at.isoformat() + "Z" if getattr(uni, "frozen_at", None) else None,
        }
    )


@bp.post("/admin/universities/<int:uni_id>/freeze")
@jwt_required()
def freeze_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    if getattr(uni, "is_frozen", False):
        return jsonify({"message": "Institution is already frozen", "is_frozen": True}), 200
    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "").strip() or None
    uni.is_frozen = True
    uni.frozen_reason = reason
    uni.frozen_at = datetime.now(timezone.utc).replace(tzinfo=None)
    tx = None
    if (
        uni.status == "verified"
        and (Config.TRUECERT_CONTRACT_ADDRESS or "").strip()
        and (Config.CONTRACT_OWNER_PRIVATE_KEY or "").strip()
    ):
        try:
            w3 = blockchain_service.get_w3()
            contract = blockchain_service.get_contract(w3)
            tx = blockchain_service.set_issuer_whitelisted(w3, contract, uni.wallet_address, False)
        except Exception as e:
            logger.error(
                "freeze_university: setIssuerWhitelisted(false) failed for university_id=%s: %s",
                uni_id,
                e,
                exc_info=True,
            )
    db.session.commit()
    return jsonify({"message": "Institution frozen", "is_frozen": True, "tx": tx})


@bp.post("/admin/universities/<int:uni_id>/unfreeze")
@jwt_required()
def unfreeze_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    if not getattr(uni, "is_frozen", False):
        return jsonify({"message": "Institution is not frozen", "is_frozen": False}), 200
    tx = None
    if (
        uni.status == "verified"
        and (Config.TRUECERT_CONTRACT_ADDRESS or "").strip()
        and (Config.CONTRACT_OWNER_PRIVATE_KEY or "").strip()
    ):
        try:
            w3 = blockchain_service.get_w3()
            contract = blockchain_service.get_contract(w3)
            tx = blockchain_service.set_issuer_whitelisted(w3, contract, uni.wallet_address, True)
        except Exception as e:
            logger.error(
                "unfreeze_university: setIssuerWhitelisted(true) failed for university_id=%s: %s",
                uni_id,
                e,
                exc_info=True,
            )
            return (
                jsonify(
                    {
                        "error": "Could not restore issuer on-chain whitelist; institution remains frozen.",
                        "detail": str(e),
                    }
                ),
                503,
            )
    uni.is_frozen = False
    uni.frozen_reason = None
    uni.frozen_at = None
    db.session.commit()
    return jsonify({"message": "Institution unfrozen", "is_frozen": False, "tx": tx})


@bp.post("/admin/universities/<int:uni_id>/approve")
@jwt_required()
def approve_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    was_verified = uni.status == "verified"
    w3 = blockchain_service.get_w3()
    contract = blockchain_service.get_contract(w3)
    tx = blockchain_service.set_issuer_whitelisted(w3, contract, uni.wallet_address, True)

    uni.status = "verified"
    notification_service.notify_university_users(
        uni.id,
        kind="university_approved",
        title="University approved",
        body="Your institution was approved and the issuer wallet was whitelisted on-chain.",
        payload={"university_id": int(uni.id), "tx_hash": (tx.get("tx_hash") if isinstance(tx, dict) else None)},
    )
    db.session.commit()
    msg = "University verified and issuer whitelisted on-chain"
    if was_verified:
        msg = "Issuer whitelisted on-chain (status already verified)"
    return jsonify({"message": msg, "tx": tx})


@bp.post("/admin/universities/<int:uni_id>/reject")
@jwt_required()
def reject_university(uni_id: int):
    _require_roles("admin")
    uni = University.query.get_or_404(uni_id)
    uni.status = "rejected"
    notification_service.notify_university_users(
        uni.id,
        kind="university_rejected",
        title="University registration rejected",
        body="Your institution registration was rejected by an admin. Contact support or re-apply if needed.",
        payload={"university_id": int(uni.id)},
    )
    db.session.commit()
    return jsonify({"message": "University registration rejected"})


@bp.post("/admin/ai/gemini-test")
@jwt_required()
def admin_gemini_test():
    """Admin-only smoke test for Gemini; does not send certificate or student data."""
    _require_roles("admin")
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400
    if len(prompt) > GEMINI_TEST_MAX_PROMPT_CHARS:
        return jsonify(
            {"error": f"prompt must be at most {GEMINI_TEST_MAX_PROMPT_CHARS} characters"}
        ), 400

    if not gemini_service.is_configured():
        return jsonify({"error": "Gemini not configured"}), 503

    model = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()
    try:
        text = gemini_service.generate_text(prompt)
    except gemini_service.GeminiNotConfiguredError:
        return jsonify({"error": "Gemini not configured"}), 503
    except gemini_service.GeminiError as e:
        return jsonify({"error": str(e)}), 503

    return jsonify({"model": model, "text": text})


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
    eip712_domain: dict[str, Any] | None = None
    try:
        eip712_domain = {
            "name": Config.EIP712_DOMAIN_NAME,
            "version": Config.EIP712_DOMAIN_VERSION,
            "chainId": int(Config.EIP712_CHAIN_ID),
            "verifyingContract": eip712_service.get_verifying_contract_checksum(),
        }
    except Exception:
        eip712_domain = None

    docs = [_serialize_document_entry(x) for x in _load_institution_documents(uni)]
    try:
        days_parsed = json.loads(uni.operating_days_of_week or "[]")
        if not isinstance(days_parsed, list):
            days_parsed = []
    except Exception:
        days_parsed = []

    return jsonify(
        {
            "name": uni.name,
            "internal_id": uni.internal_id,
            "status": uni.status,
            "wallet_address": uni.wallet_address,
            "contract_address": Config.TRUECERT_CONTRACT_ADDRESS,
            "chain_id": chain_id,
            "eip712_nonce": max(
                int(uni.eip712_nonce or 0),
                int(getattr(uni, "eip712_single_nonce", 0) or 0),
                int(getattr(uni, "eip712_batch_nonce", 0) or 0),
            ),
            "eip712_single_nonce": int(getattr(uni, "eip712_single_nonce", 0) or 0),
            "eip712_batch_nonce": int(getattr(uni, "eip712_batch_nonce", 0) or 0),
            "eip712_domain": eip712_domain,
            "logo_uri": uni.logo_uri,
            "logo_url": _ipfs_uri_to_gateway(uni.logo_uri or ""),
            "institution_contact_email": uni.institution_contact_email,
            "institution_contact_phone": uni.institution_contact_phone,
            "institution_website": uni.institution_website,
            "institution_license_id": uni.institution_license_id,
            "institution_license_authority": uni.institution_license_authority,
            "institution_license_valid_until": uni.institution_license_valid_until,
            "expected_mints_monthly": uni.expected_mints_monthly,
            "expected_mints_annually": uni.expected_mints_annually,
            "operating_days_of_week": days_parsed,
            "operating_hours_start": uni.operating_hours_start,
            "operating_hours_end": uni.operating_hours_end,
            "operating_timezone": uni.operating_timezone,
            "institution_documents": docs,
            "is_frozen": bool(getattr(uni, "is_frozen", False)),
            "frozen_reason": getattr(uni, "frozen_reason", None),
            "frozen_at": uni.frozen_at.isoformat() + "Z" if getattr(uni, "frozen_at", None) else None,
        }
    )


def _seed_operational_from_university(uni: University) -> dict[str, Any]:
    try:
        days = json.loads(uni.operating_days_of_week or "[]")
    except Exception:
        days = []
    if not isinstance(days, list):
        days = []
    return {
        "expected_mints_monthly": uni.expected_mints_monthly,
        "expected_mints_annually": uni.expected_mints_annually,
        "operating_days_of_week": days,
        "operating_hours_start": uni.operating_hours_start,
        "operating_hours_end": uni.operating_hours_end,
        "operating_timezone": uni.operating_timezone,
    }


@bp.patch("/university/me")
@jwt_required()
def patch_university_me():
    """Update issuance / operating expectations (not certificate-profile fields — use PUT /profile)."""
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    g = freeze_guard_response(uni)
    if g:
        return g
    data = request.get_json(silent=True) or {}
    if not data:
        return jsonify({"error": "No fields to update"}), 400
    seed = _seed_operational_from_university(uni)
    _op_patch_keys = {
        "expected_mints_monthly",
        "expected_mints_annually",
        "operating_days_of_week",
        "operating_hours_start",
        "operating_hours_end",
        "operating_timezone",
    }
    for k in _op_patch_keys:
        if k in data:
            seed[k] = data[k]
    try:
        op = _parse_operational_fields(seed, require_monthly=False)
    except (ValueError, json.JSONDecodeError, TypeError) as e:
        return jsonify({"error": str(e)}), 400
    _apply_operational_fields(uni, op)
    db.session.commit()
    return jsonify({"message": "Operating profile updated."})


@bp.post("/university/documents")
@jwt_required()
def upload_university_documents():
    """
    Append verification documents (IPFS via Pinata). Does not replace existing entries;
    new files are merged onto ``institution_documents_json``. Requires PINATA_JWT.
    """
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400
    g = freeze_guard_response(uni)
    if g:
        return g
    files_clean = [f for f in request.files.getlist("documents") if f and getattr(f, "filename", None)]
    if not files_clean:
        return jsonify({"error": "documents file(s) required"}), 400
    labels = [str(x).strip() for x in request.form.getlist("document_labels")]
    existing = _load_institution_documents(uni)
    try:
        pinned = _pin_institution_documents_from_uploads(files_clean, labels)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"Upload failed: {e!s}"}), 502
    merged = existing + pinned
    uni.institution_documents_json = json.dumps(merged)
    db.session.commit()
    return jsonify(
        {
            "message": f"Added {len(pinned)} document(s).",
            "institution_documents": [_serialize_document_entry(x) for x in merged],
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
    g = freeze_guard_response(uni)
    if g:
        return g
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
    g = freeze_guard_response(uni)
    if g:
        return g
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
    """Public certificate JSON fields only.

    ``student_internal_id`` / ``student_email`` from ``data`` are intentionally ignored here so they
    never affect Ed25519-signed JSON, ``_core_hash_hex``, or the EIP-712 mint commitment (on-chain).
    """
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
        "format": "truecert-v1",
        "name": f"TrueCert Certificate #{cert_id}",
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
    """Keccak256 of the five TrueCert core strings — must match contract; excludes any DB-only issuer fields."""
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
    return {"ok": ok, "reason": reason, "kid": metadata.get("truecert_sig_kid")}


def _validate_single_mint_student_contact(data: dict[str, Any]) -> tuple[str, str]:
    """Issuer-only keys for operations / future claim; never included in pinned or signed credential JSON."""
    iid = str(data.get("student_internal_id") or "").strip()
    email = str(data.get("student_email") or "").strip()
    if not iid:
        raise ValueError("student_internal_id is required")
    if len(iid) > 128:
        raise ValueError("student_internal_id must be at most 128 characters")
    if not email:
        raise ValueError("student_email is required")
    if not _valid_email(email):
        raise ValueError("student_email is not a valid email")
    return iid, email


def _effective_public_metadata_base() -> str:
    """Env PUBLIC_METADATA_BASE_URL / _BASE_URI; else same-origin fallback for local dev (localhost / debug)."""
    base = (Config.PUBLIC_METADATA_BASE_URL or "").strip().rstrip("/")
    if base:
        return base
    try:
        h = (request.host or "").split(":")[0].lower()
        local_host = h in ("127.0.0.1", "localhost", "::1")
        if local_host or getattr(current_app, "debug", False):
            return (request.host_url or "").rstrip("/")
    except Exception:
        pass
    return ""


def _public_single_mint_metadata_url(token_id: int) -> str:
    """Legacy HTTPS tokenURI for older mint requests; new single mints use ``ipfs://`` from Pinata."""
    base = _effective_public_metadata_base()
    if not base:
        raise ValueError(
            "PUBLIC_METADATA_BASE_URL is not configured (alias: PUBLIC_METADATA_BASE_URI). "
            "Set it in .env to your API’s public origin with no trailing slash, e.g. https://api.example.com "
            "or http://127.0.0.1:5000 for local testing. "
            "If you open the portal from localhost without setting it, the server uses the request host automatically."
        )
    return f"{base}/api/public/metadata/{int(token_id)}"


def _http_url_for_metadata_fetch(uri: str) -> str:
    u = (uri or "").strip()
    if u.startswith("http://") or u.startswith("https://"):
        return u
    return _ipfs_uri_to_http(u)


def _offchain_metadata_from_certificate_record(rec: CertificateRecord) -> dict[str, Any] | None:
    raw = (rec.signed_metadata_json or "").strip()
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    obj = dict(obj)
    obj["_signature"] = _signature_status(obj)
    return obj


def _fetch_offchain_metadata_from_uri(uri: str) -> dict[str, Any]:
    r = requests.get(_http_url_for_metadata_fetch(uri), timeout=30)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, dict):
        raise ValueError("metadata response is not a JSON object")
    out = dict(data)
    out["_signature"] = _signature_status(out)
    return out


@bp.post("/university/certificates/prepare-mint")
@jwt_required()
def prepare_mint_certificate():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403
    g = freeze_guard_response(uni)
    if g:
        return g

    data = request.get_json(silent=True) or {}
    try:
        # IID/email: DB + MAR only — never in metadata, core_hash, or EIP-712 commitment.
        student_internal_id, student_email = _validate_single_mint_student_contact(data)
        metadata = _build_metadata(data, uni)
        core_hash = _core_hash_hex(metadata)
        signed_metadata = metadata_signing.sign_metadata(metadata)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if not (Config.PINATA_JWT or "").strip():
        return jsonify(
            {
                "error": (
                    "PINATA_JWT is not configured. Single-mint metadata is pinned to IPFS (on-chain tokenURI is "
                    "ipfs://…). Set PINATA_JWT in backend/.env (Pinata API JWT). "
                    "PUBLIC_METADATA_BASE_URL is only needed for legacy HTTP tokenURIs."
                )
            }
        ), 503

    signed_json = json.dumps(signed_metadata, ensure_ascii=False, separators=(",", ":"))

    try:
        w3 = blockchain_service.get_w3()
        cfg_err = _require_contract_code(w3)
        if cfg_err:
            return jsonify({"error": cfg_err}), 503
        contract = blockchain_service.get_contract(w3)
        next_token_id = int(contract.functions.nextTokenId().call())
        metadata_uri = pinata_service.pin_certificate_metadata(
            next_token_id, signed_metadata, Config.PINATA_JWT
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        return jsonify({"error": f"Prepare mint failed: {e!s}"}), 502

    rec = CertificateRecord.query.filter_by(token_id=next_token_id).first()
    if not rec:
        rec = CertificateRecord(token_id=next_token_id, university_id=uni.id, ipfs_uri=metadata_uri)
        db.session.add(rec)
    rec.university_id = uni.id
    rec.ipfs_uri = metadata_uri
    rec.cert_id = metadata["cert_id"]
    rec.core_hash = core_hash
    rec.status = "prepared"
    rec.signed_metadata_json = signed_json
    rec.student_internal_id = student_internal_id
    rec.student_email = student_email
    commitment = eip712_service.single_mint_commitment(metadata["cert_id"], core_hash)
    mint_request_id = str(uuid.uuid4())
    nonce = int(uni.eip712_single_nonce or 0)
    expiry = eip712_service.default_expiry_unix()
    eip712 = eip712_service.mint_authorization_full_message(
        issuer_address=uni.wallet_address,
        commitment=commitment,
        nonce=nonce,
        expiry_unix=expiry,
    )
    db.session.add(
        MintAuthorizationRequest(
            id=mint_request_id,
            university_id=uni.id,
            cert_id=metadata["cert_id"],
            core_hash=core_hash,
            metadata_uri=metadata_uri,
            expected_token_id=next_token_id,
            student_internal_id=student_internal_id,
            student_email=student_email,
            signed_metadata_json=signed_json,
            commitment_hex=Web3.to_hex(commitment),
            nonce_snapshot=nonce,
            expiry_unix=expiry,
            status="pending",
        )
    )
    db.session.commit()

    return jsonify(
        {
            "metadata_uri": metadata_uri,
            "core_hash": core_hash,
            "cert_id": metadata["cert_id"],
            "next_token_id_hint": next_token_id,
            "institution_name": metadata["institution_name"],
            "mint_request_id": mint_request_id,
            "eip712": eip712,
            "commitment": Web3.to_hex(commitment),
            "nonce": nonce,
            "expiry_unix": expiry,
        }
    )


@bp.post("/university/certificates/submit-authorization")
@jwt_required()
def submit_mint_authorization():
    """Verify EIP-712 mint authorization and submit mintForIssuer with platform minter key."""
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni or uni.status != "verified":
        return jsonify({"error": "University is not verified"}), 403
    g = freeze_guard_response(uni)
    if g:
        return g

    body = request.get_json(silent=True) or {}
    mint_request_id = (body.get("mint_request_id") or "").strip()
    signature = (body.get("signature") or "").strip()
    if not mint_request_id or not signature:
        return jsonify({"error": "mint_request_id and signature are required"}), 400

    req = db.session.get(MintAuthorizationRequest, mint_request_id)
    if not req or req.university_id != uni.id:
        return jsonify({"error": "Mint request not found"}), 404
    if req.status != "pending":
        return jsonify({"error": f"Mint request already {req.status}"}), 409

    if int(time.time()) > int(req.expiry_unix):
        req.status = "failed"
        req.failure_code = "expired"
        db.session.commit()
        return jsonify({"error": "Authorization expired; prepare mint again."}), 400

    if int(uni.eip712_single_nonce or 0) != int(req.nonce_snapshot):
        req.status = "failed"
        req.failure_code = "nonce_mismatch"
        db.session.commit()
        return jsonify(
            {
                "error": "Nonce mismatch; prepare a new mint request.",
                "error_code": "eip712_nonce_mismatch",
            }
        ), 409

    ch = (req.commitment_hex or "").strip()
    if ch.startswith("0x"):
        ch = ch[2:]
    commitment_bytes = bytes.fromhex(ch)
    full = eip712_service.mint_authorization_full_message(
        issuer_address=uni.wallet_address,
        commitment=commitment_bytes,
        nonce=int(req.nonce_snapshot),
        expiry_unix=int(req.expiry_unix),
    )
    try:
        signer = eip712_service.recover_typed_data_signer(full, signature)
    except Exception as e:
        req.status = "failed"
        req.failure_code = "invalid_signature"
        db.session.commit()
        return jsonify({"error": f"Invalid signature: {e!s}"}), 400
    if signer.lower() != Web3.to_checksum_address(uni.wallet_address).lower():
        req.status = "failed"
        req.failure_code = "wrong_signer"
        db.session.commit()
        return jsonify({"error": "Signature signer does not match university wallet"}), 403

    try:
        w3 = blockchain_service.get_w3()
        cfg_err = _require_contract_code(w3)
        if cfg_err:
            return jsonify({"error": cfg_err}), 503
        contract = blockchain_service.get_contract(w3)
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    # Preflight: ensure the deployed contract supports platform minting and is configured with our minter.
    if not hasattr(contract.functions, "mintForIssuer"):
        return (
            jsonify(
                {
                    "error": (
                        "Configured contract ABI does not expose mintForIssuer. "
                        "You may be pointing at an older TrueCert deployment; redeploy and update TRUECERT_CONTRACT_ADDRESS."
                    )
                }
            ),
            503,
        )
    try:
        expected_minter = blockchain_service.minter_account_address()
    except Exception as e:
        return jsonify({"error": f"Platform minter key not configured: {e!s}"}), 503
    try:
        onchain_minter = contract.functions.minter().call()
    except Exception:
        onchain_minter = None
    if not onchain_minter or Web3.to_checksum_address(onchain_minter).lower() != Web3.to_checksum_address(expected_minter).lower():
        return (
            jsonify(
                {
                    "error": (
                        "Contract minter is not set to this backend's platform minter address. "
                        f"On-chain minter: {onchain_minter or 'unset'}; backend minter: {expected_minter}. "
                        "As contract owner, call setMinter(<backend minter address>) on the deployed TrueCert contract."
                    )
                }
            ),
            409,
        )

    try:
        if not contract.functions.whitelistedIssuers(Web3.to_checksum_address(uni.wallet_address)).call():
            return jsonify({"error": "Issuer wallet is not whitelisted on-chain"}), 403
    except Exception as e:
        return jsonify({"error": f"Whitelist read failed: {e!s}"}), 502

    digest = eip712_service.typed_data_signable_hash_hex(full)

    mint_uri = (req.metadata_uri or "").strip()
    if (req.signed_metadata_json or "").strip():
        # Legacy mints used an HTTPS tokenURI tied to nextTokenId; realign before mint if another mint interleaved.
        # IPFS tokenURIs are content-addressed and stay valid for this cert — keep as-is.
        if mint_uri.startswith("http://") or mint_uri.startswith("https://"):
            try:
                next_tid = int(contract.functions.nextTokenId().call())
                mint_uri = _public_single_mint_metadata_url(next_tid)
            except ValueError as e:
                return jsonify({"error": str(e)}), 503
            req.metadata_uri = mint_uri
            for cr in CertificateRecord.query.filter_by(cert_id=req.cert_id, university_id=uni.id).all():
                if (cr.status or "").lower() == "prepared":
                    cr.ipfs_uri = mint_uri
            db.session.flush()

    chain_t0 = time.perf_counter()
    try:
        token_id, tx_hex = blockchain_service.mint_for_issuer(
            w3,
            contract,
            uni.wallet_address,
            mint_uri,
            req.core_hash,
            req.cert_id,
        )
    except Exception as e:
        return jsonify({"error": f"Mint transaction failed: {e!s}"}), 502

    # Token ids are sequential; other mints can interleave between prepare and submit.
    # The authorization commitment does not include token_id, so accept the minted token id and reconcile the DB index.
    token_id_int = int(token_id)
    rec = CertificateRecord.query.filter_by(cert_id=req.cert_id).first()
    if not rec:
        existing = CertificateRecord.query.filter_by(token_id=token_id_int).first()
        if existing:
            if (existing.status or "").lower() == "prepared":
                db.session.delete(existing)
                db.session.flush()
            else:
                other_tid = blockchain_service.find_minted_token_id_by_cert_id(
                    w3,
                    contract,
                    issuer=uni.wallet_address,
                    cert_id=str(existing.cert_id or "").strip(),
                )
                if other_tid and int(other_tid) != token_id_int:
                    if CertificateRecord.query.filter_by(token_id=int(other_tid)).first() is None:
                        existing.token_id = int(other_tid)
                        db.session.flush()
                        existing = None
                if existing:
                    return (
                        jsonify(
                            {
                                "error": (
                                    "Certificate index collision on token_id; another certificate record already "
                                    "claims this token id. Resolve in DB or rebuild the index."
                                ),
                                "collision": {
                                    "token_id": token_id_int,
                                    "existing_cert_id": existing.cert_id,
                                    "existing_status": existing.status,
                                },
                            }
                        ),
                        500,
                    )
        rec = CertificateRecord(
            token_id=token_id_int,
            university_id=uni.id,
            cert_id=req.cert_id,
            ipfs_uri=mint_uri,
            core_hash=req.core_hash,
            status="issued",
            signed_metadata_json=req.signed_metadata_json,
            student_internal_id=req.student_internal_id,
            student_email=req.student_email,
        )
        db.session.add(rec)
    else:
        other_tid = CertificateRecord.query.filter_by(token_id=token_id_int).first()
        if other_tid and other_tid.id != rec.id:
            # Auto-resolve stale reservations: if the other record was only "prepared", it never minted on-chain.
            if (other_tid.status or "").lower() == "prepared":
                db.session.delete(other_tid)
                db.session.flush()
            else:
                other_chain = blockchain_service.find_minted_token_id_by_cert_id(
                    w3,
                    contract,
                    issuer=uni.wallet_address,
                    cert_id=str(other_tid.cert_id or "").strip(),
                )
                if other_chain and int(other_chain) != token_id_int:
                    if CertificateRecord.query.filter_by(token_id=int(other_chain)).first() is None:
                        other_tid.token_id = int(other_chain)
                        db.session.flush()
                        other_tid = None
                if other_tid and other_tid.id != rec.id:
                    return (
                        jsonify(
                            {
                                "error": (
                                    "Certificate index collision on token_id; another certificate record already "
                                    "claims this token id. Resolve in DB or rebuild the index."
                                ),
                                "collision": {
                                    "token_id": token_id_int,
                                    "existing_cert_id": other_tid.cert_id,
                                    "existing_status": other_tid.status,
                                },
                            }
                        ),
                        500,
                    )
        rec.token_id = token_id_int
        rec.ipfs_uri = mint_uri
        rec.core_hash = req.core_hash
        rec.status = "issued"
        if (req.signed_metadata_json or "").strip():
            rec.signed_metadata_json = req.signed_metadata_json
            rec.student_internal_id = req.student_internal_id or rec.student_internal_id
            rec.student_email = req.student_email or rec.student_email
    req.status = "minted"
    req.failure_code = None
    req.signature_hex = signature
    req.digest_hex = digest
    req.minter_tx_hash = tx_hex
    uni.eip712_single_nonce = int(uni.eip712_single_nonce or 0) + 1
    sync_uni_eip712_watermark(uni)

    h = (tx_hex or "").strip()
    if not h.startswith("0x"):
        h = "0x" + h
    try:
        receipt = w3.eth.get_transaction_receipt(h)
        processed = contract.events.CertificateMinted().process_receipt(receipt)
        block_dt = datetime.now(timezone.utc)
        try:
            blk = w3.eth.get_block(int(receipt["blockNumber"]))
            block_dt = datetime.fromtimestamp(int(blk["timestamp"]), tz=timezone.utc)
        except Exception:
            pass
        for lg in processed:
            args = lg["args"]
            if str(args.get("certId", "")).strip() != str(req.cert_id).strip():
                continue
            _li = lg.get("logIndex", lg.get("log_index", 0))
            log_index = int(_li) if _li is not None else 0
            existing = ActivityLog.query.filter_by(tx_hash=h, log_index=log_index).first()
            if not existing:
                db.session.add(
                    ActivityLog(
                        university_id=uni.id,
                        token_id=int(token_id),
                        action="issued",
                        tx_hash=h,
                        log_index=log_index,
                        block_number=int(receipt["blockNumber"]),
                        block_timestamp=block_dt,
                        actor=blockchain_service.minter_account_address(),
                        details_json=json.dumps(
                            {
                                "metadata_uri": mint_uri,
                                "cert_id": req.cert_id,
                                "mint_request_id": mint_request_id,
                                "commitment": req.commitment_hex,
                                "nonce": req.nonce_snapshot,
                                "eip712_digest": digest,
                                "minter_tx_hash": h,
                                "platform_mint": True,
                            }
                        ),
                        created_at=block_dt,
                    )
                )
            break
    except Exception:
        pass

    platform_mint_ms = int((time.perf_counter() - chain_t0) * 1000)

    now_utc = datetime.utcnow()
    prepare_to_complete_ms = None
    if req.created_at:
        prepare_to_complete_ms = max(0, int((now_utc - req.created_at).total_seconds() * 1000))
    req.completed_at = now_utc
    req.prepare_to_complete_ms = prepare_to_complete_ms
    req.platform_mint_ms = platform_mint_ms

    notification_service.notify_university_users(
        uni.id,
        kind="mint_success",
        title="Certificate minted successfully",
        body=f"Certificate {req.cert_id} minted on-chain as token #{int(token_id)}.",
        payload={"token_id": int(token_id), "cert_id": req.cert_id, "tx_hash": tx_hex},
    )
    db.session.commit()
    return jsonify(
        {
            "token_id": int(token_id),
            "tx_hash": tx_hex,
            "mint_request_id": mint_request_id,
            "eip712_digest": digest,
            "timing": {
                # Wall clock from MintAuthorizationRequest.created_at (prepare-mint) until this handler finishes.
                # Includes user wallet signing time between prepare and submit.
                "prepare_to_complete_ms": prepare_to_complete_ms,
                # Wall clock for mint_for_issuer + receipt read + activity log insert in this request only.
                "platform_mint_ms": platform_mint_ms,
            },
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
    g = freeze_guard_response(uni)
    if g:
        return g

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
    # Preserve issuer-only student contact so public /claim keeps working after reissue.
    old_rec = CertificateRecord.query.filter_by(token_id=int(old_token_id)).first()
    if old_rec:
        if (old_rec.student_internal_id or "").strip():
            rec.student_internal_id = old_rec.student_internal_id
        if (old_rec.student_email or "").strip():
            rec.student_email = old_rec.student_email
    if not (rec.student_internal_id or "").strip() or not (rec.student_email or "").strip():
        brow = (
            MintBatchRow.query.filter_by(token_id=int(old_token_id))
            .order_by(MintBatchRow.id.desc())
            .first()
        )
        if brow:
            if not (rec.student_internal_id or "").strip() and (brow.student_internal_id or "").strip():
                rec.student_internal_id = brow.student_internal_id
            if not (rec.student_email or "").strip() and (brow.student_email or "").strip():
                rec.student_email = brow.student_email
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


def _propagate_reissue_claim_continuity(*, old_token_id: int, new_token_id: int) -> None:
    """Keep public student-claim matching pointed at the replacement token after reissue.

    Student contact lives on ``CertificateRecord`` (single-mint) and/or ``MintBatchRow`` (batch).
    ``revokeAndReissue`` mints a new ``token_id``; without retargeting, claim lookup still finds the
    revoked/reissued token and eligibility fails (or single-mint contact is missing on the new row).
    """
    old_tid = int(old_token_id)
    new_tid = int(new_token_id)
    if old_tid == new_tid:
        return
    old_rec = CertificateRecord.query.filter_by(token_id=old_tid).first()
    new_rec = CertificateRecord.query.filter_by(token_id=new_tid).first()
    if new_rec and old_rec:
        if not (new_rec.student_internal_id or "").strip() and (old_rec.student_internal_id or "").strip():
            new_rec.student_internal_id = old_rec.student_internal_id
        if not (new_rec.student_email or "").strip() and (old_rec.student_email or "").strip():
            new_rec.student_email = old_rec.student_email

    batch_rows = MintBatchRow.query.filter_by(token_id=old_tid).all()
    for brow in batch_rows:
        brow.token_id = new_tid
        if new_rec and (new_rec.cert_id or "").strip():
            brow.cert_id = new_rec.cert_id
        if new_rec:
            if not (new_rec.student_internal_id or "").strip() and (brow.student_internal_id or "").strip():
                new_rec.student_internal_id = brow.student_internal_id
            if not (new_rec.student_email or "").strip() and (brow.student_email or "").strip():
                new_rec.student_email = brow.student_email


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
    g = freeze_guard_response(uni)
    if g:
        return g

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
        _propagate_reissue_claim_continuity(old_token_id=old_token, new_token_id=new_token)
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
    if not Config.TRUECERT_CONTRACT_ADDRESS:
        return jsonify({"error": "TRUECERT_CONTRACT_ADDRESS is not configured"}), 503
    w3 = blockchain_service.get_w3()
    checksum = Web3.to_checksum_address(Config.TRUECERT_CONTRACT_ADDRESS.strip())
    if len(w3.eth.get_code(checksum)) == 0:
        return jsonify(
            {
                "error": (
                    "TRUECERT_CONTRACT_ADDRESS has no contract bytecode on Polygon Amoy. "
                    "Set it to the TrueCert address from "
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
            offchain = _fetch_offchain_metadata_from_uri(uri)
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
    from_db = _offchain_metadata_from_certificate_record(rec)
    if from_db is not None:
        offchain = from_db
    elif onchain.get("exists") and onchain.get("metadata_uri"):
        try:
            offchain = _fetch_offchain_metadata_from_uri(str(onchain.get("metadata_uri") or ""))
        except Exception as e:
            offchain = {"_error": f"Could not fetch metadata: {e!s}"}
    try:
        chain_id = int(w3.eth.chain_id)
    except Exception:
        chain_id = 80002
    contract_checksum = Web3.to_checksum_address(Config.TRUECERT_CONTRACT_ADDRESS.strip())
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


def _sanitize_verify_explain_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Keep only non-sensitive fields already exposed by public verification responses.
    Drop anything that looks like email/internal identifiers or signature blobs.
    """
    on_chain_in = payload.get("on_chain") if isinstance(payload.get("on_chain"), dict) else {}
    meta_in = payload.get("off_chain_metadata") if isinstance(payload.get("off_chain_metadata"), dict) else {}

    # Only keep metadata fields that are already displayed in the public verify UI and avoid emails.
    allowed_meta_keys = {
        "student_full_name",
        "degree_title",
        "issue_date",
        "cert_id",
        "institution_name",
        "institution_contact_phone",
        "institution_website",
        "institution_license_id",
        "institution_license_authority",
        "institution_license_valid_until",
        "format",
        "name",
        "description",
        "verification_method",
    }

    meta_out: dict[str, Any] = {}
    for k, v in meta_in.items():
        kk = str(k)
        low = kk.lower()
        if kk in allowed_meta_keys:
            meta_out[kk] = v
            continue
        if low.endswith("email") or "email" in low:
            continue
        if "internal_id" in low or low.endswith("_id") and "cert_id" not in low:
            continue
        if low in {"truecert_sig", "truecert_sig_v", "truecert_sig_kid", "truecert_sig_alg"}:
            continue

    sig = meta_in.get("_signature") if isinstance(meta_in.get("_signature"), dict) else None
    if sig:
        meta_out["_signature"] = {
            "ok": bool(sig.get("ok")) if "ok" in sig else None,
            "reason": sig.get("reason"),
        }

    on_chain_out = {
        "exists": on_chain_in.get("exists"),
        "issuer_address": on_chain_in.get("issuer_address"),
        "owner_address": on_chain_in.get("owner_address"),
        "valid": on_chain_in.get("valid"),
        "locked": on_chain_in.get("locked"),
        "metadata_uri": on_chain_in.get("metadata_uri"),
        "core_hash": on_chain_in.get("core_hash"),
    }

    # `exists` is used by /verify/<token_id>; `matched` is used by /verify/fields.
    return {
        "token_id": payload.get("token_id"),
        "exists": payload.get("exists"),
        "matched": payload.get("matched"),
        "chain_id": payload.get("chain_id"),
        "contract_address": payload.get("contract_address"),
        "on_chain": on_chain_out,
        "off_chain_metadata": meta_out,
    }


@bp.post("/verify/explain")
def verify_explain():
    """
    Optional AI explainer for public verification payloads.
    Advisory only: never treated as proof of authenticity.
    """
    if not gemini_service.is_configured():
        return jsonify({"error": "Gemini not configured"}), 503

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    # Accept either {verification: {...}} or a raw verification response object.
    payload = data.get("verification") if isinstance(data.get("verification"), dict) else data
    if not isinstance(payload, dict):
        return jsonify({"error": "verification payload is required"}), 400

    token_id = payload.get("token_id")
    if token_id is None:
        return jsonify({"error": "token_id is required"}), 400

    sanitized = _sanitize_verify_explain_payload(payload)

    model_name = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()
    cache_key = ai_response_cache.verify_explain_cache_key(sanitized, model_name)
    cache_ttl = float(Config.GEMINI_VERIFY_EXPLAIN_CACHE_TTL_SECONDS)
    cache_max = int(Config.GEMINI_VERIFY_EXPLAIN_CACHE_MAX_ENTRIES)

    cached_text = ai_response_cache.get_text(cache_key, max_entries=cache_max)
    if cached_text is not None:
        resp = make_response(jsonify({"model": model_name, "text": cached_text}))
        resp.headers["X-Cache"] = "HIT"
        return resp

    system_instruction = (
        "You help employers and the public read a TrueCert verification result. "
        "Output must be exactly two paragraphs separated by one blank line (no markdown, no bullets, no headings). "
        "Paragraph 1 — credential narrative: in plain English, describe what the record appears to be using ONLY "
        "fields present in the JSON (e.g. recipient/student name, degree or program, institution, certificate ID, "
        "issue date). If chain_id is 80002, you may say Polygon Amoy testnet; otherwise name the chain only if obvious "
        "from chain_id; otherwise say 'the configured network'. Do not invent details. "
        "Paragraph 2 — what was checked: explain token match/existence, issuer and owner addresses in short form, "
        "whether the credential is marked valid or revoked on-chain, locked/soulbound if applicable, and whether "
        "off-chain metadata signature verification passed, failed, or could not be checked. "
        "Tone: helpful and confident."
        "Do not assert the institution 'authorized' anything beyond what the JSON supports. "
        "If data is missing or an error field exists, say clearly what could not be verified."
    )

    prompt = (
        "Write the two-paragraph verification summary described in your instructions.\n\n"
        f"Verification payload (sanitized JSON):\n{json.dumps(sanitized, ensure_ascii=False)}"
    )

    try:
        text = gemini_service.generate_text(prompt, system_instruction=system_instruction)
    except gemini_service.GeminiNotConfiguredError:
        return jsonify({"error": "Gemini not configured"}), 503
    except gemini_service.GeminiError as e:
        return jsonify({"error": str(e)}), 503

    ai_response_cache.set_text(cache_key, text, ttl_seconds=cache_ttl, max_entries=cache_max)
    resp = make_response(jsonify({"model": model_name, "text": text}))
    resp.headers["X-Cache"] = "MISS"
    return resp


def _risk_hints_payload(
    *,
    university_id: int,
    include_ai_summary: bool,
    current_days: int,
    reference_days: int,
) -> tuple[dict[str, Any], int]:
    as_of = datetime.now(timezone.utc)
    metrics = risk_hints_service.compute_metrics(
        university_id,
        as_of=as_of,
        current_days=current_days,
        reference_days=reference_days,
    )
    flags = risk_hints_service.compute_flags(metrics)
    summary = risk_hints_service.summarize_severity(flags)

    out: dict[str, Any] = {
        "disclaimer": (
            "Risk hints are operational signals only (not proof). "
            "Certificate validity remains determined by on-chain state and signed metadata."
        ),
        "computed_at": metrics.get("computed_at"),
        "windows": metrics.get("windows"),
        "metrics": metrics,
        "flags": flags,
        "summary": summary,
    }

    if not include_ai_summary:
        return out, 200

    # IMPORTANT: AI must not take enforcement actions. Narrative is optional and derived from flags/aggregates only.
    if not gemini_service.is_configured():
        out["ai_summary_text"] = None
        out["ai_summary_reason"] = "Gemini not configured"
        return out, 200

    system_instruction = (
        "You are an assistant helping operations staff interpret risk hint flags for a university dashboard. "
        "Explain what the flags mean in plain language (4-7 sentences), using cautious, non-accusatory wording. "
        "Do not claim fraud, illegality, or proof. "
        "Do not request or infer personal data. "
        "Suggest 2-4 practical human checks (e.g., review recent mint logs, confirm issuer wallet, check RPC health). "
        "You must not recommend automatic enforcement; this is advisory only."
    )

    model_name = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()
    flags_for_ai = [{"code": f.get("code"), "severity": f.get("severity"), "detail": f.get("detail")} for f in flags]
    aggregates_for_ai = {
        "mint_velocity": metrics.get("mint_velocity"),
        "revoke": metrics.get("revoke"),
        "single_mint_auth": metrics.get("single_mint_auth"),
        "batch": metrics.get("batch"),
    }
    risk_cache_key = ai_response_cache.risk_summary_cache_key(
        university_id=university_id,
        current_days=current_days,
        reference_days=reference_days,
        summary=summary,
        flags=flags_for_ai,
        aggregates=aggregates_for_ai,
        model_name=model_name,
    )
    risk_ttl = float(Config.GEMINI_RISK_SUMMARY_CACHE_TTL_SECONDS)
    risk_max = int(Config.GEMINI_VERIFY_EXPLAIN_CACHE_MAX_ENTRIES)

    cached_risk = ai_response_cache.get_text(risk_cache_key, max_entries=risk_max)
    if cached_risk is not None:
        out["ai_summary_text"] = cached_risk
        out["ai_summary_reason"] = None
        return out, 200

    ai_payload = {
        "summary": summary,
        "flags": flags_for_ai,
        "aggregates": aggregates_for_ai,
        "windows": metrics.get("windows"),
    }
    prompt = (
        "Write a brief operational summary of these risk hints. "
        "Focus on what changed, why it might happen benignly, and what to check next.\n\n"
        + json.dumps(ai_payload, ensure_ascii=False)
    )

    try:
        out["ai_summary_text"] = gemini_service.generate_text(prompt, system_instruction=system_instruction)
        out["ai_summary_reason"] = None
        if out["ai_summary_text"]:
            ai_response_cache.set_text(
                risk_cache_key,
                out["ai_summary_text"],
                ttl_seconds=risk_ttl,
                max_entries=risk_max,
            )
    except gemini_service.GeminiNotConfiguredError:
        out["ai_summary_text"] = None
        out["ai_summary_reason"] = "Gemini not configured"
    except gemini_service.GeminiError as e:
        out["ai_summary_text"] = None
        out["ai_summary_reason"] = str(e)

    return out, 200


@bp.get("/university/risk-hints")
@jwt_required()
def university_risk_hints():
    _require_roles("university")
    user = _current_user()
    uni = user.university
    if not uni:
        return jsonify({"error": "No university profile"}), 400

    current_days = _parse_int_qs(request.args.get("current_days"), 7, lo=1, hi=30)
    reference_days = _parse_int_qs(request.args.get("reference_days"), 90, lo=14, hi=365)
    include_default = gemini_service.is_configured()
    include_ai = _parse_bool_qs(request.args.get("include_ai_summary"), include_default)

    payload, status = _risk_hints_payload(
        university_id=int(uni.id),
        include_ai_summary=include_ai,
        current_days=current_days,
        reference_days=reference_days,
    )
    return jsonify(payload), status


@bp.get("/admin/universities/<int:uni_id>/risk-hints")
@jwt_required()
def admin_university_risk_hints(uni_id: int):
    _require_roles("admin")
    current_days = _parse_int_qs(request.args.get("current_days"), 7, lo=1, hi=30)
    reference_days = _parse_int_qs(request.args.get("reference_days"), 90, lo=14, hi=365)
    include_default = gemini_service.is_configured()
    include_ai = _parse_bool_qs(request.args.get("include_ai_summary"), include_default)

    payload, status = _risk_hints_payload(
        university_id=int(uni_id),
        include_ai_summary=include_ai,
        current_days=current_days,
        reference_days=reference_days,
    )
    return jsonify(payload), status


@bp.get("/notifications")
@jwt_required()
def list_notifications():
    user = _current_user()
    limit = _parse_int_qs(request.args.get("limit"), 30, lo=1, hi=200)
    offset = _parse_int_qs(request.args.get("offset"), 0, lo=0, hi=1000000)
    unread_only = _parse_bool_qs(request.args.get("unread_only"), False)

    q = Notification.query.filter_by(user_id=int(user.id))
    if unread_only:
        q = q.filter(Notification.read_at.is_(None))
    rows = q.order_by(Notification.created_at.desc()).offset(offset).limit(limit).all()

    unread_count = int(Notification.query.filter_by(user_id=int(user.id), read_at=None).count())

    def _row(n: Notification) -> dict[str, Any]:
        payload = None
        if (n.payload_json or "").strip():
            try:
                payload = json.loads(n.payload_json)
            except Exception:
                payload = None
        return {
            "id": int(n.id),
            "kind": n.kind,
            "title": n.title,
            "body": n.body,
            "payload": payload,
            "read_at": n.read_at.isoformat() if n.read_at else None,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }

    return jsonify({"notifications": [_row(n) for n in rows], "unread_count": unread_count})


@bp.post("/notifications/<int:notif_id>/read")
@jwt_required()
def mark_notification_read(notif_id: int):
    user = _current_user()
    n = Notification.query.filter_by(id=int(notif_id), user_id=int(user.id)).first()
    if not n:
        return jsonify({"error": "Not found"}), 404
    if not n.read_at:
        n.read_at = datetime.utcnow()
        db.session.commit()
    unread_count = int(Notification.query.filter_by(user_id=int(user.id), read_at=None).count())
    return jsonify({"ok": True, "unread_count": unread_count})


@bp.post("/notifications/read-all")
@jwt_required()
def mark_notifications_read_all():
    user = _current_user()
    updated = notification_service.mark_all_read(int(user.id))
    db.session.commit()
    return jsonify({"ok": True, "updated": int(updated), "unread_count": 0})


@bp.get("/public/metadata/<int:token_id>")
def public_certificate_metadata(token_id: int):
    """Serve DB-backed certificate JSON (HTTPS tokenURI legacy) or proxy ipfs:// metadata as JSON."""
    rec = CertificateRecord.query.filter_by(token_id=int(token_id)).first()
    if not rec:
        return jsonify({"error": "Not found"}), 404
    raw = (rec.signed_metadata_json or "").strip()
    if raw:
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            return jsonify({"error": "Invalid stored metadata"}), 500
        if not isinstance(obj, dict):
            return jsonify({"error": "Invalid stored metadata"}), 500
        return Response(json.dumps(obj, ensure_ascii=False), mimetype="application/json; charset=utf-8")
    uri = (rec.ipfs_uri or "").strip()
    if uri.startswith("ipfs://"):
        try:
            r = requests.get(_http_url_for_metadata_fetch(uri), timeout=30)
            r.raise_for_status()
            return Response(r.text, mimetype="application/json; charset=utf-8")
        except Exception as e:
            return jsonify({"error": str(e)}), 502
    return jsonify({"error": "Metadata not available"}), 404


@bp.get("/public/config")
def public_trust_config():
    """Non-secret trust fields for marketing / verification transparency (no JWT)."""
    chain_id = 80002
    try:
        w3 = blockchain_service.get_w3()
        chain_id = int(w3.eth.chain_id)
    except Exception:
        pass
    addr = (Config.TRUECERT_CONTRACT_ADDRESS or "").strip()
    checksum = ""
    explorer = ""
    if addr:
        try:
            checksum = Web3.to_checksum_address(addr)
            explorer = f"https://amoy.polygonscan.com/address/{checksum}"
        except Exception:
            checksum = addr
    keys: list[dict[str, str]] = []
    try:
        keys = metadata_signing.export_public_verification_keys()
    except Exception:
        keys = []
    minter_addr = None
    try:
        if (Config.TRUECERT_MINTER_PRIVATE_KEY or "").strip():
            minter_addr = blockchain_service.minter_account_address()
    except Exception:
        minter_addr = None
    return jsonify(
        {
            "chain_id": chain_id,
            "network_name": "Polygon Amoy",
            "contract_address": checksum or None,
            "contract_explorer_url": explorer or None,
            "platform_minter_address": minter_addr,
            "pinata_gateway_base": Config.PINATA_GATEWAY_BASE.rstrip("/"),
            "active_signing_kid": (Config.TRUECERT_SIG_KID or "").strip() or None,
            "truecert_public_keys": keys,
            "eip712_domain": {
                "name": Config.EIP712_DOMAIN_NAME,
                "version": Config.EIP712_DOMAIN_VERSION,
                "chainId": int(Config.EIP712_CHAIN_ID),
                "verifyingContract": checksum or None,
            },
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )


@bp.get("/public/mint-time-insights")
def public_mint_time_insights():
    """Typical on-platform mint timing bands (p50 / p90) for UX expectations; no JWT."""
    return jsonify(analytics_service.global_mint_time_percentiles())


@bp.get("/public/verified-universities")
def public_verified_universities():
    """Verified issuers only (no pending registrations)."""
    rows = (
        University.query.filter_by(status="verified")
        .order_by(University.name.asc())
        .all()
    )
    return jsonify(
        {
            "universities": [
                {
                    "id": u.id,
                    "name": u.name,
                    "internal_id": u.internal_id,
                    "logo_url": _ipfs_uri_to_gateway(u.logo_uri) if u.logo_uri else None,
                    "wallet_address": u.wallet_address,
                    "domain_email": u.domain_email,
                    "institution_contact_email": u.institution_contact_email,
                }
                for u in rows
            ]
        }
    )


@bp.get("/health")
def health():
    return jsonify({"status": "ok"})
