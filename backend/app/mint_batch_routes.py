"""CSV batch mint routes (registered on main api blueprint from create_app)."""

from __future__ import annotations

import csv
import io
import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import jwt_required
from web3 import Web3
from werkzeug.utils import secure_filename

from app.config import Config
from app.extensions import db
from app.models import ActivityLog, CertificateRecord, MintBatch, MintBatchRow, University, User
from app.services import (
    blockchain_service,
    eip712_service,
    gemini_service,
    metadata_signing,
    notification_service,
    pinata_service,
)
from app.university_freeze import freeze_guard_response, sync_uni_eip712_watermark

BATCH_ROW_AI_MAX_QUESTION_CHARS = 500

# Late-bound to avoid circular import: set by register_mint_batch_routes
_api_bp: Blueprint | None = None


def _require_roles(*roles: str) -> None:
    assert _api_bp is not None
    from flask import abort
    from flask_jwt_extended import get_jwt

    claims = get_jwt()
    if claims.get("role") not in roles:
        abort(403)


def _current_user() -> User:
    from flask import abort
    from flask_jwt_extended import get_jwt_identity

    assert _api_bp is not None
    uid = get_jwt_identity()
    if not uid:
        abort(401)
    user = db.session.get(User, int(uid))
    if not user:
        abort(401)
    return user


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


def _valid_email(v: str) -> bool:
    import re

    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v))


def _valid_date(v: str) -> bool:
    from datetime import datetime as dt

    try:
        dt.strptime(v, "%Y-%m-%d")
        return True
    except ValueError:
        return False


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
    return digest.hex()


def _build_metadata_for_batch_row(row: MintBatchRow, uni: University) -> dict[str, Any]:
    """Pinned JSON only — no student_email or student_internal_id."""
    import app.routes.api as api_mod

    data = {
        "student_name": (row.student_full_name or "").strip(),
        "degree_type": (row.degree_title or "").strip(),
        "issue_date": (row.issue_date or "").strip(),
        "cert_id": (row.cert_id or "").strip(),
        "image": (row.image_ipfs_uri or "").strip() or None,
    }
    return api_mod._build_metadata(data, uni, skip_cert_id_uniqueness=False)


def _sanitize_batch_row_for_ai(row: MintBatchRow) -> dict[str, Any]:
    """Fields safe to send to an LLM: no email, internal IDs, raw CSV/JSON lines, or secrets."""
    ve: Any = row.validation_errors
    if ve:
        try:
            ve = json.loads(ve) if isinstance(ve, str) else ve
        except Exception:
            ve = str(ve)[:800]
    return {
        "row_index": row.row_index,
        "cert_id": row.cert_id,
        "student_full_name": row.student_full_name,
        "degree_title": row.degree_title,
        "issue_date": row.issue_date,
        "row_status": row.row_status,
        "validation_errors": ve,
        "has_metadata_uri": bool((row.metadata_uri or "").strip()),
        "has_core_hash": bool((row.core_hash or "").strip()),
        "token_id": row.token_id,
        "error_message": ((row.error_message or "")[:500] or None),
        "image_ipfs_uri_present": bool((row.image_ipfs_uri or "").strip()),
    }


def _serialize_row(r: MintBatchRow) -> dict[str, Any]:
    err = None
    if r.validation_errors:
        try:
            err = json.loads(r.validation_errors)
        except Exception:
            err = r.validation_errors
    return {
        "id": r.id,
        "row_index": r.row_index,
        "cert_id": r.cert_id,
        "student_internal_id": r.student_internal_id,
        "student_email": r.student_email,
        "student_full_name": r.student_full_name,
        "degree_title": r.degree_title,
        "issue_date": r.issue_date,
        "image_ipfs_uri": r.image_ipfs_uri,
        "validation_errors": err,
        "row_status": r.row_status,
        "metadata_uri": r.metadata_uri,
        "core_hash": r.core_hash,
        "token_id": r.token_id,
        "tx_hash": r.tx_hash,
        "error_message": r.error_message,
        "prepared_at": r.prepared_at.isoformat() if r.prepared_at else None,
        "minted_at": r.minted_at.isoformat() if r.minted_at else None,
        "emailed_at": r.emailed_at.isoformat() if r.emailed_at else None,
        "prepare_to_mint_ms": r.prepare_to_mint_ms,
        "platform_mint_ms": r.platform_mint_ms,
    }


def _maybe_complete_batch(batch: MintBatch) -> None:
    rows = MintBatchRow.query.filter_by(batch_id=batch.id).all()
    terminals = {"invalid", "mint_confirmed", "email_sent", "email_failed", "mint_failed"}
    if rows and all(r.row_status in terminals for r in rows):
        batch.status = "completed"
    batch.updated_at = datetime.utcnow()


def _append_mint_activity(
    *,
    university_id: int,
    token_id: int,
    tx_hash: str,
    block_number: int,
    log_index: int,
    actor: str,
    metadata_uri: str,
    cert_id: str,
) -> None:
    existing = ActivityLog.query.filter_by(tx_hash=tx_hash, log_index=log_index).first()
    if existing:
        return
    block_dt = datetime.now(timezone.utc)
    try:
        w3 = blockchain_service.get_w3()
        blk = w3.eth.get_block(block_number)
        block_dt = datetime.fromtimestamp(int(blk["timestamp"]), tz=timezone.utc)
    except Exception:
        pass
    db.session.add(
        ActivityLog(
            university_id=university_id,
            token_id=token_id,
            action="issued",
            tx_hash=tx_hash,
            log_index=log_index,
            block_number=block_number,
            block_timestamp=block_dt,
            actor=actor,
            details_json=json.dumps({"metadata_uri": metadata_uri, "cert_id": cert_id}),
            created_at=block_dt,
        )
    )


def _verify_certificate_mint_receipt(
    w3: Web3,
    contract,
    tx_hash: str,
    *,
    expected_issuer: str,
    expected_cert_id: str,
    expected_core_hash_hex: str,
    claimed_token_id: int,
    minter_address: str | None = None,
) -> tuple[bool, str]:
    h = (tx_hash or "").strip()
    if not h.startswith("0x"):
        h = "0x" + h
    try:
        receipt = w3.eth.get_transaction_receipt(h)
    except Exception as e:
        return False, f"receipt error: {e!s}"
    if receipt is None:
        return False, "no receipt"
    if int(receipt.get("status", 0)) != 1:
        return False, "transaction failed or reverted"
    try:
        tx = w3.eth.get_transaction(h)
    except Exception as e:
        return False, f"tx fetch error: {e!s}"
    if tx is None:
        return False, "no transaction"
    contract_addr = Web3.to_checksum_address(contract.address)
    if Web3.to_checksum_address(tx["to"]) != contract_addr:
        return False, "tx not to TrueCert contract"
    tx_from = Web3.to_checksum_address(tx["from"])
    if minter_address:
        if tx_from.lower() != Web3.to_checksum_address(minter_address).lower():
            return False, "tx sender is not platform minter"
    elif tx_from.lower() != Web3.to_checksum_address(expected_issuer).lower():
        return False, "tx sender is not approved issuer wallet"
    try:
        processed = contract.events.CertificateMinted().process_receipt(receipt)
    except Exception as e:
        return False, f"could not parse CertificateMinted: {e!s}"
    match = None
    ch_hex = expected_core_hash_hex.strip()
    if not ch_hex.startswith("0x"):
        ch_hex = "0x" + ch_hex
    want_core = Web3.to_bytes(hexstr=ch_hex)
    for lg in processed:
        args = lg["args"]
        if str(args.get("certId", "")).strip() != str(expected_cert_id).strip():
            continue
        tid = int(args.get("tokenId", 0))
        if tid != int(claimed_token_id):
            return False, "tokenId mismatch vs receipt"
        core = args.get("coreHash")
        got = bytes(core) if not isinstance(core, bytes) else core
        if got != want_core:
            return False, "coreHash mismatch vs receipt"
        issuer_log = args.get("issuer")
        if issuer_log and Web3.to_checksum_address(issuer_log).lower() != Web3.to_checksum_address(expected_issuer).lower():
            return False, "issuer mismatch in mint log"
        match = lg
        break
    if match is None:
        return False, "no CertificateMinted log for this cert_id"
    return True, ""


def register_mint_batch_routes(bp: Blueprint) -> None:
    global _api_bp
    _api_bp = bp

    @bp.post("/university/mint-batches")
    @jwt_required()
    def create_mint_batch():
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr

        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify({"error": "file is required (multipart field name: file)"}), 400
        raw = f.read()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return jsonify({"error": "CSV must be UTF-8 encoded"}), 400

        max_rows = Config.MINT_BATCH_MAX_ROWS
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None:
            return jsonify({"error": "CSV has no header row"}), 400
        norm_headers = {(h or "").strip().lower(): h for h in reader.fieldnames if h is not None}
        required = (
            "cert_id",
            "student_internal_id",
            "student_email",
            "student_full_name",
            "degree_title",
            "issue_date",
        )
        missing_hdr = [h for h in required if h not in norm_headers]
        if missing_hdr:
            return jsonify({"error": f"Missing required CSV columns: {', '.join(missing_hdr)}"}), 400

        rows_out: list[dict[str, Any]] = []
        for row_index, raw_row in enumerate(reader):
            if row_index >= max_rows:
                return jsonify({"error": f"CSV exceeds max of {max_rows} data rows"}), 400
            d = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items()}
            rows_out.append({"row_index": row_index, "data": d})

        if not rows_out:
            return jsonify({"error": "CSV has no data rows"}), 400

        seen_cert: set[str] = set()
        batch = MintBatch(
            university_id=uni.id,
            status="uploaded",
            original_filename=secure_filename(f.filename)[:500],
            created_by_user_id=user.id,
            total_rows=len(rows_out),
            valid_rows=0,
            invalid_rows=0,
        )
        db.session.add(batch)
        db.session.flush()

        summary_errors: list[dict[str, Any]] = []
        for item in rows_out:
            idx = item["row_index"]
            d = item["data"]
            errs: list[str] = []
            cert_id = d.get("cert_id", "").strip()
            sid = d.get("student_internal_id", "").strip()
            email = d.get("student_email", "").strip()
            name = d.get("student_full_name", "").strip()
            deg = d.get("degree_title", "").strip()
            issue = d.get("issue_date", "").strip()
            img = (d.get("image_ipfs_uri") or "").strip() or None

            if not cert_id:
                errs.append("cert_id is required")
            if not sid:
                errs.append("student_internal_id is required")
            if not email:
                errs.append("student_email is required")
            elif not _valid_email(email):
                errs.append("student_email is not a valid email")
            if not name:
                errs.append("student_full_name is required")
            if not deg:
                errs.append("degree_title is required")
            if not issue:
                errs.append("issue_date is required")
            elif not _valid_date(issue):
                errs.append("issue_date must be YYYY-MM-DD")

            if cert_id:
                if cert_id in seen_cert:
                    errs.append("duplicate cert_id within this CSV file")
                seen_cert.add(cert_id)
                if CertificateRecord.query.filter_by(cert_id=cert_id).first():
                    errs.append("cert_id already exists in certificate index")
                other = (
                    MintBatchRow.query.join(MintBatch)
                    .filter(
                        MintBatch.university_id == uni.id,
                        MintBatchRow.cert_id == cert_id,
                        MintBatchRow.row_status == "prepared",
                    )
                    .first()
                )
                if other:
                    errs.append("cert_id is held by another batch row awaiting mint (finish that mint first)")
            if img:
                if len(img) > 512:
                    errs.append("image_ipfs_uri too long")
                elif not (img.startswith("ipfs://") or img.startswith("http://") or img.startswith("https://")):
                    errs.append("image_ipfs_uri must be ipfs:// or http(s)://")

            st = "invalid" if errs else "pending_validation"
            mbr = MintBatchRow(
                batch_id=batch.id,
                row_index=idx,
                raw_json=json.dumps(d),
                cert_id=cert_id or None,
                student_internal_id=sid or None,
                student_email=email or None,
                student_full_name=name or None,
                degree_title=deg or None,
                issue_date=issue or None,
                image_ipfs_uri=img,
                validation_errors=json.dumps(errs) if errs else None,
                row_status=st,
            )
            db.session.add(mbr)
            if errs and len(summary_errors) < 25:
                summary_errors.append({"row_index": idx, "errors": errs})

        batch.valid_rows = MintBatchRow.query.filter_by(batch_id=batch.id, row_status="pending_validation").count()
        batch.invalid_rows = MintBatchRow.query.filter_by(batch_id=batch.id, row_status="invalid").count()
        batch.status = "validated" if batch.valid_rows > 0 else "failed"
        batch.error_summary = json.dumps({"sample_row_errors": summary_errors})
        db.session.commit()

        return (
            jsonify(
                {
                    "batch_id": batch.id,
                    "summary": {
                        "status": batch.status,
                        "total_rows": batch.total_rows,
                        "valid_rows": batch.valid_rows,
                        "invalid_rows": batch.invalid_rows,
                    },
                }
            ),
            201,
        )

    @bp.get("/university/mint-batches/<int:batch_id>")
    @jwt_required()
    def get_mint_batch(batch_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni:
            return jsonify({"error": "No university profile"}), 400
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        return jsonify(
            {
                "id": b.id,
                "status": b.status,
                "original_filename": b.original_filename,
                "created_at": b.created_at.isoformat() if b.created_at else None,
                "updated_at": b.updated_at.isoformat() if b.updated_at else None,
                "total_rows": b.total_rows,
                "valid_rows": b.valid_rows,
                "invalid_rows": b.invalid_rows,
                "error_summary": json.loads(b.error_summary) if b.error_summary else None,
                "timing": {
                    "last_execute_chunk_wall_ms": b.last_execute_chunk_wall_ms,
                    "cumulative_execute_wall_ms": b.cumulative_execute_wall_ms,
                },
            }
        )

    @bp.get("/university/mint-batches/<int:batch_id>/rows")
    @jwt_required()
    def list_mint_batch_rows(batch_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni:
            return jsonify({"error": "No university profile"}), 400
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        status_filter = (request.args.get("status") or "").strip()
        limit = min(max(int(request.args.get("limit", 50)), 1), 200)
        offset = max(int(request.args.get("offset", 0)), 0)
        q = MintBatchRow.query.filter_by(batch_id=batch_id)
        if status_filter:
            q = q.filter_by(row_status=status_filter)
        q = q.order_by(MintBatchRow.row_index.asc())
        total = q.count()
        rows = q.offset(offset).limit(limit).all()
        return jsonify(
            {
                "total": total,
                "offset": offset,
                "limit": limit,
                "rows": [_serialize_row(r) for r in rows],
            }
        )

    @bp.post("/university/mint-batches/<int:batch_id>/rows/<int:row_id>/prepare")
    @jwt_required()
    def prepare_mint_batch_row(batch_id: int, row_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        row = MintBatchRow.query.filter_by(id=row_id, batch_id=batch_id).first()
        if not row:
            return jsonify({"error": "Row not found"}), 404
        if row.row_status == "invalid":
            return jsonify({"error": "Row failed CSV validation"}), 400
        if row.row_status in ("mint_confirmed", "email_sent", "email_failed"):
            return jsonify({"error": "Row already minted"}), 400

        miss = _missing_profile_fields(uni)
        if miss:
            return jsonify({"error": f"Institution profile incomplete: missing {miss[0]}"}), 400

        if row.row_status == "prepared" and row.metadata_uri and row.core_hash:
            rec = CertificateRecord.query.filter_by(cert_id=row.cert_id).first() if row.cert_id else None
            tid = rec.token_id if rec else None
            # If a row was prepared but the DB index was deleted/corrupted, recreate a fresh allocation.
            # This keeps the batch workflow unblocked; token id is advisory until minted.
            if tid is None and row.cert_id:
                try:
                    w3 = blockchain_service.get_w3()
                    cfg_err = _require_contract_code(w3)
                    if cfg_err:
                        return jsonify({"error": cfg_err}), 503
                    contract = blockchain_service.get_contract(w3)
                    next_token_id = int(contract.functions.nextTokenId().call())
                    rec2 = CertificateRecord.query.filter_by(token_id=next_token_id).first()
                    if not rec2:
                        rec2 = CertificateRecord(token_id=next_token_id, university_id=uni.id, ipfs_uri=row.metadata_uri)
                        db.session.add(rec2)
                    rec2.university_id = uni.id
                    rec2.ipfs_uri = row.metadata_uri
                    rec2.cert_id = row.cert_id
                    rec2.core_hash = row.core_hash
                    rec2.status = "prepared"
                    db.session.commit()
                    tid = next_token_id
                except Exception:
                    # fall back to returning idempotent response without hint
                    tid = None
            return jsonify(
                {
                    "metadata_uri": row.metadata_uri,
                    "core_hash": row.core_hash,
                    "cert_id": row.cert_id,
                    "next_token_id_hint": tid,
                    "idempotent": True,
                }
            )

        if row.row_status == "mint_failed" and row.metadata_uri and row.core_hash:
            row.row_status = "prepared"
            row.error_message = None
            db.session.commit()
            rec = CertificateRecord.query.filter_by(cert_id=row.cert_id).first()
            tid = rec.token_id if rec else None
            return jsonify(
                {
                    "metadata_uri": row.metadata_uri,
                    "core_hash": row.core_hash,
                    "cert_id": row.cert_id,
                    "next_token_id_hint": tid,
                    "idempotent": True,
                }
            )

        try:
            metadata = _build_metadata_for_batch_row(row, uni)
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
            return jsonify({"error": f"Prepare failed: {e!s}"}), 502

        rec = CertificateRecord.query.filter_by(token_id=next_token_id).first()
        if not rec:
            rec = CertificateRecord(token_id=next_token_id, university_id=uni.id, ipfs_uri=ipfs_uri)
            db.session.add(rec)
        rec.university_id = uni.id
        rec.ipfs_uri = ipfs_uri
        rec.cert_id = metadata["cert_id"]
        rec.core_hash = core_hash
        rec.status = "prepared"

        row.metadata_uri = ipfs_uri
        row.core_hash = core_hash
        row.row_status = "prepared"
        row.prepared_at = datetime.utcnow()
        row.error_message = None

        if b.status == "validated":
            b.status = "processing"
        b.updated_at = datetime.utcnow()
        db.session.commit()

        return jsonify(
            {
                "metadata_uri": ipfs_uri,
                "core_hash": core_hash,
                "cert_id": metadata["cert_id"],
                "next_token_id_hint": next_token_id,
                "idempotent": False,
            }
        )

    @bp.post("/university/mint-batches/<int:batch_id>/rows/<int:row_id>/reset-prepare")
    @jwt_required()
    def reset_prepare_batch_row(batch_id: int, row_id: int):
        """Clear a stuck prepared row when no token exists on-chain (wallet tx never landed)."""
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        row = MintBatchRow.query.filter_by(id=row_id, batch_id=batch_id).first()
        if not row:
            return jsonify({"error": "Row not found"}), 404
        if row.row_status != "prepared":
            return jsonify({"error": "Row is not in prepared state; nothing to reset."}), 400

        rec = CertificateRecord.query.filter_by(cert_id=row.cert_id, university_id=uni.id).first()
        if rec:
            if (rec.status or "").lower() != "prepared":
                return jsonify(
                    {
                        "error": "Certificate index is no longer prepared; refresh the batch list.",
                    }
                ), 409
            try:
                w3 = blockchain_service.get_w3()
                cfg_err = _require_contract_code(w3)
                if cfg_err:
                    return jsonify({"error": cfg_err}), 503
                contract = blockchain_service.get_contract(w3)
                onchain = blockchain_service.read_certificate_public(w3, contract, rec.token_id)
            except Exception as e:
                return jsonify({"error": f"Chain read failed: {e!s}"}), 502
            if onchain.get("exists"):
                return jsonify(
                    {
                        "error": (
                            "A token already exists on-chain for this certificate. "
                            "If this is unexpected, contact support; otherwise the row may already be minted."
                        ),
                        "token_id": rec.token_id,
                    }
                ), 409
            db.session.delete(rec)

        row.metadata_uri = None
        row.core_hash = None
        row.prepared_at = None
        row.row_status = "pending_validation"
        row.error_message = None
        b.updated_at = datetime.utcnow()
        db.session.commit()
        return jsonify({"message": "Prepare state cleared. You can prepare this row again."})

    @bp.get("/university/mint-batches/<int:batch_id>/eip712")
    @jwt_required()
    def get_batch_mint_eip712(batch_id: int):
        """Build BatchMintAuthorization typed data; persists row snapshot + commitment for later submit."""
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        if (b.authorized_signature_hex or "").strip():
            return jsonify(
                {"error": "Batch already authorized. Run execute to mint, or finish outstanding mints first."}
            ), 409

        rows = (
            MintBatchRow.query.filter_by(batch_id=batch_id).order_by(MintBatchRow.row_index.asc()).all()
        )
        pending: list[MintBatchRow] = []
        for r in rows:
            if r.row_status == "invalid":
                continue
            if r.row_status in ("mint_confirmed", "email_sent", "email_failed"):
                continue
            if r.row_status != "prepared":
                return jsonify(
                    {
                        "error": (
                            f"Row {r.row_index} must be in prepared state for batch signing "
                            f"(currently {r.row_status})."
                        ),
                    }
                ), 400
            pending.append(r)

        if not pending:
            return jsonify({"error": "No prepared rows to authorize for this batch."}), 400

        # Ensure every prepared row has a CertificateRecord allocation (token_id reservation).
        # If an index row was deleted/corrupted after prepare, recreate it here so batch signing can proceed.
        try:
            w3 = blockchain_service.get_w3()
            cfg_err = _require_contract_code(w3)
            if cfg_err:
                return jsonify({"error": cfg_err}), 503
            contract = blockchain_service.get_contract(w3)
            next_token_id_base = int(contract.functions.nextTokenId().call())
        except Exception as e:
            return jsonify({"error": f"Chain read failed: {e!s}"}), 502

        row_hashes = [
            eip712_service.single_mint_commitment((r.cert_id or "").strip(), (r.core_hash or "").strip())
            for r in pending
        ]
        commitment = eip712_service.batch_mint_commitment(batch_id, row_hashes)
        nonce = int(uni.eip712_batch_nonce or 0)
        expiry = eip712_service.default_expiry_unix()
        payload: list[dict[str, Any]] = []
        token_nex = next_token_id_base
        for r in pending:
            rec = CertificateRecord.query.filter_by(cert_id=r.cert_id).first() if r.cert_id else None
            if not rec:
                # Allocate a fresh token id, avoiding collisions in the local index.
                while CertificateRecord.query.filter_by(token_id=token_nex).first() is not None:
                    token_nex += 1
                rec = CertificateRecord(
                    token_id=int(token_nex),
                    university_id=uni.id,
                    cert_id=r.cert_id,
                    ipfs_uri=r.metadata_uri or "",
                    core_hash=r.core_hash or "",
                    status="prepared",
                )
                db.session.add(rec)
                db.session.flush()
                token_nex += 1
            payload.append(
                {
                    "row_id": r.id,
                    "row_index": r.row_index,
                    "cert_id": r.cert_id,
                    "core_hash": r.core_hash,
                    "metadata_uri": r.metadata_uri,
                    "expected_token_id": rec.token_id,
                }
            )

        b.authorized_commitment_hex = Web3.to_hex(commitment)
        b.authorized_row_ids_json = json.dumps([r.id for r in pending])
        b.authorized_payload_json = json.dumps(payload)
        b.authorized_nonce_snapshot = nonce
        b.authorized_expiry_unix = expiry
        b.authorized_signature_hex = None
        b.authorized_digest_hex = None
        b.updated_at = datetime.utcnow()
        db.session.commit()

        full = eip712_service.batch_mint_authorization_full_message(
            issuer_address=uni.wallet_address,
            batch_id=batch_id,
            commitment=commitment,
            nonce=nonce,
            expiry_unix=expiry,
        )
        return jsonify(
            {
                "batch_id": batch_id,
                "eip712": full,
                "commitment": Web3.to_hex(commitment),
                "nonce": nonce,
                "expiry_unix": expiry,
                "row_count": len(pending),
            }
        )

    @bp.post("/university/mint-batches/<int:batch_id>/submit-authorization")
    @jwt_required()
    def submit_batch_mint_authorization(batch_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        if not b.authorized_commitment_hex or not b.authorized_payload_json:
            return jsonify({"error": "Call GET /eip712 first to build batch authorization."}), 400
        if (b.authorized_signature_hex or "").strip():
            return jsonify({"error": "Batch authorization already submitted."}), 409

        body = request.get_json(silent=True) or {}
        signature = (body.get("signature") or "").strip()
        if not signature:
            return jsonify({"error": "signature is required"}), 400

        if int(time.time()) > int(b.authorized_expiry_unix or 0):
            return jsonify({"error": "Batch authorization expired; call GET /eip712 again."}), 400

        snap = b.authorized_nonce_snapshot
        if snap is None:
            return jsonify({"error": "Call GET /eip712 first to build batch authorization."}), 400
        if int(uni.eip712_batch_nonce or 0) != int(snap):
            return jsonify(
                {
                    "error": "Nonce mismatch; refresh EIP-712 payload from GET /eip712.",
                    "error_code": "eip712_nonce_mismatch",
                }
            ), 409

        ch = (b.authorized_commitment_hex or "").strip()
        if ch.startswith("0x"):
            ch = ch[2:]
        commitment_bytes = bytes.fromhex(ch)
        full = eip712_service.batch_mint_authorization_full_message(
            issuer_address=uni.wallet_address,
            batch_id=batch_id,
            commitment=commitment_bytes,
            nonce=int(snap),
            expiry_unix=int(b.authorized_expiry_unix or 0),
        )
        try:
            signer = eip712_service.recover_typed_data_signer(full, signature)
        except Exception as e:
            return jsonify({"error": f"Invalid signature: {e!s}"}), 400
        if signer.lower() != Web3.to_checksum_address(uni.wallet_address).lower():
            return jsonify({"error": "Signature signer does not match university wallet"}), 403

        try:
            w3 = blockchain_service.get_w3()
            cfg_err = _require_contract_code(w3)
            if cfg_err:
                return jsonify({"error": cfg_err}), 503
            contract = blockchain_service.get_contract(w3)
        except Exception as e:
            return jsonify({"error": str(e)}), 502

        try:
            if not contract.functions.whitelistedIssuers(Web3.to_checksum_address(uni.wallet_address)).call():
                return jsonify({"error": "Issuer wallet is not whitelisted on-chain"}), 403
        except Exception as e:
            return jsonify({"error": f"Whitelist read failed: {e!s}"}), 502

        digest = eip712_service.typed_data_signable_hash_hex(full)
        b.authorized_signature_hex = signature
        b.authorized_digest_hex = digest
        b.status = "authorized"
        uni.eip712_batch_nonce = int(uni.eip712_batch_nonce or 0) + 1
        sync_uni_eip712_watermark(uni)
        b.updated_at = datetime.utcnow()
        db.session.commit()

        return jsonify(
            {
                "message": "Batch authorized. Call POST .../execute to run platform mints.",
                "batch_id": batch_id,
                "eip712_digest": digest,
            }
        )

    @bp.post("/university/mint-batches/<int:batch_id>/execute")
    @jwt_required()
    def execute_batch_mints(batch_id: int):
        """Platform minter submits mintForIssuer for each row in the authorized snapshot."""
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        if not (b.authorized_signature_hex or "").strip():
            return jsonify({"error": "Batch is not authorized yet (submit EIP-712 signature first)."}), 400

        body = request.get_json(silent=True) or {}
        max_mints = min(max(int(body.get("max_mints") or 25), 1), 80)

        try:
            payload: list[dict[str, Any]] = json.loads(b.authorized_payload_json or "[]")
        except Exception:
            return jsonify({"error": "Corrupt batch authorization payload"}), 500

        try:
            w3 = blockchain_service.get_w3()
            cfg_err = _require_contract_code(w3)
            if cfg_err:
                return jsonify({"error": cfg_err}), 503
            contract = blockchain_service.get_contract(w3)
        except Exception as e:
            return jsonify({"error": str(e)}), 502

        minter_addr = blockchain_service.minter_account_address()
        minted_out: list[dict[str, Any]] = []
        processed = 0
        execute_chunk_start = time.perf_counter()

        def _apply_execute_chunk_timing() -> int:
            """Persist wall time for this execute POST (partial or full). Call before commit."""
            cw = int((time.perf_counter() - execute_chunk_start) * 1000)
            if processed > 0:
                b.last_execute_chunk_wall_ms = cw
                b.cumulative_execute_wall_ms = int(b.cumulative_execute_wall_ms or 0) + cw
            return cw

        for ent in sorted(payload, key=lambda x: int(x.get("row_index", 0))):
            if processed >= max_mints:
                break
            row = MintBatchRow.query.filter_by(id=int(ent["row_id"]), batch_id=batch_id).first()
            if not row:
                continue
            if row.row_status in ("mint_confirmed", "email_sent", "email_failed"):
                continue
            if row.row_status == "invalid":
                continue
            # mint_failed / pending_validation (reset-prepare) must not abort the rest of
            # the authorized snapshot. Hash checks only apply to rows we are about to mint.
            if row.row_status != "prepared":
                continue
            if str(row.cert_id or "").strip() != str(ent.get("cert_id") or "").strip():
                return jsonify({"error": f"Row {row.id} cert_id changed since authorization"}), 409
            if str(row.core_hash or "").strip() != str(ent.get("core_hash") or "").strip():
                return jsonify({"error": f"Row {row.id} core_hash changed since authorization"}), 409

            prep_at_snapshot = row.prepared_at
            chain_t0 = time.perf_counter()
            try:
                token_id, tx_hex = blockchain_service.mint_for_issuer(
                    w3,
                    contract,
                    uni.wallet_address,
                    row.metadata_uri or "",
                    row.core_hash or "",
                    row.cert_id or "",
                )
            except Exception as e:
                row.row_status = "mint_failed"
                row.error_message = str(e)
                b.updated_at = datetime.utcnow()
                chunk_wall_ms = _apply_execute_chunk_timing()
                db.session.commit()
                return jsonify(
                    {"error": f"Mint failed at row {row.row_index}: {e!s}", "partial": minted_out, "timing": {"chunk_wall_ms": chunk_wall_ms}}
                ), 502

            # Accept token id from chain; other mints may interleave between prepare and execute.

            ok, reason = _verify_certificate_mint_receipt(
                w3,
                contract,
                tx_hex,
                expected_issuer=uni.wallet_address,
                expected_cert_id=row.cert_id or "",
                expected_core_hash_hex=row.core_hash or "",
                claimed_token_id=int(token_id),
                minter_address=minter_addr,
            )
            if not ok:
                row.row_status = "mint_failed"
                row.error_message = reason
                b.updated_at = datetime.utcnow()
                chunk_wall_ms = _apply_execute_chunk_timing()
                db.session.commit()
                return jsonify({"error": reason, "partial": minted_out, "timing": {"chunk_wall_ms": chunk_wall_ms}}), 400

            try:
                token_id_int = int(token_id)
                rec = CertificateRecord.query.filter_by(cert_id=row.cert_id).first() if row.cert_id else None
                if not rec:
                    # Collision check must also run for brand-new records, otherwise INSERT can violate UNIQUE(token_id).
                    existing = CertificateRecord.query.filter_by(token_id=token_id_int).first()
                    if existing:
                        if (existing.status or "").lower() == "prepared":
                            db.session.delete(existing)
                            db.session.flush()
                        else:
                            # Attempt reconciliation: move the existing record to its real on-chain token id by certId.
                            other_tid = blockchain_service.find_minted_token_id_by_cert_id(
                                w3,
                                contract,
                                issuer=uni.wallet_address,
                                cert_id=str(existing.cert_id or "").strip(),
                            )
                            if other_tid and int(other_tid) != token_id_int:
                                # Avoid cascading collisions.
                                if CertificateRecord.query.filter_by(token_id=int(other_tid)).first() is None:
                                    existing.token_id = int(other_tid)
                                    db.session.flush()
                                else:
                                    other_tid = None
                            if not other_tid:
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
                        cert_id=row.cert_id,
                        ipfs_uri=row.metadata_uri or "",
                        core_hash=row.core_hash or "",
                        status="issued",
                    )
                    db.session.add(rec)
                else:
                    other_tid = CertificateRecord.query.filter_by(token_id=token_id_int).first()
                    if other_tid and other_tid.id != rec.id:
                        if (other_tid.status or "").lower() == "prepared":
                            db.session.delete(other_tid)
                            db.session.flush()
                        else:
                            # Attempt reconciliation on the conflicting record if it points to a different cert.
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
                    rec.ipfs_uri = row.metadata_uri or rec.ipfs_uri
                    rec.core_hash = row.core_hash or rec.core_hash
                    rec.status = "issued"
            except Exception as e:
                db.session.rollback()
                row.row_status = "mint_failed"
                row.error_message = str(e)
                b.updated_at = datetime.utcnow()
                chunk_wall_ms = _apply_execute_chunk_timing()
                db.session.commit()
                return jsonify(
                    {"error": f"DB update failed at row {row.row_index}: {e!s}", "partial": minted_out, "timing": {"chunk_wall_ms": chunk_wall_ms}}
                ), 500
            row.tx_hash = tx_hex if tx_hex.startswith("0x") else "0x" + tx_hex
            row.token_id = int(token_id)
            row.minted_at = datetime.utcnow()
            row.row_status = "mint_confirmed"
            row.error_message = None

            h = row.tx_hash
            try:
                receipt = w3.eth.get_transaction_receipt(h)
                proc = contract.events.CertificateMinted().process_receipt(receipt)
                for lg in proc:
                    args = lg["args"]
                    if str(args.get("certId", "")).strip() == str(row.cert_id).strip():
                        _li = lg.get("logIndex", lg.get("log_index", 0))
                        log_index = int(_li) if _li is not None else 0
                        _append_mint_activity(
                            university_id=uni.id,
                            token_id=int(token_id),
                            tx_hash=h,
                            block_number=int(receipt["blockNumber"]),
                            log_index=log_index,
                            actor=minter_addr,
                            metadata_uri=row.metadata_uri or "",
                            cert_id=row.cert_id or "",
                        )
                        break
            except Exception:
                pass

            if os.environ.get("SENDGRID_API_KEY") or os.environ.get("SMTP_HOST"):
                row.row_status = "email_sent"
                row.emailed_at = datetime.utcnow()
            else:
                row.row_status = "mint_confirmed"

            platform_ms = int((time.perf_counter() - chain_t0) * 1000)
            prep_to_mint_ms = None
            if prep_at_snapshot and row.minted_at:
                prep_to_mint_ms = max(0, int((row.minted_at - prep_at_snapshot).total_seconds() * 1000))
            row.prepare_to_mint_ms = prep_to_mint_ms
            row.platform_mint_ms = platform_ms

            minted_out.append(
                {
                    "row_id": row.id,
                    "token_id": int(token_id),
                    "tx_hash": h,
                    "timing": {
                        # Wall time from row prepared_at (server prepare) until minted_at is set this request.
                        "prepare_to_mint_ms": prep_to_mint_ms,
                        # mint_for_issuer + receipt verify + DB updates + receipt scan for activity log.
                        "platform_mint_ms": platform_ms,
                    },
                }
            )
            processed += 1

        remaining = 0
        for ent in payload:
            rr = MintBatchRow.query.filter_by(id=int(ent["row_id"]), batch_id=batch_id).first()
            if rr and rr.row_status == "prepared":
                remaining += 1

        b.status = "executing" if b.status == "authorized" else b.status
        b.updated_at = datetime.utcnow()
        _maybe_complete_batch(b)

        chunk_wall_ms = _apply_execute_chunk_timing()

        if minted_out:
            # In-app notifications only; keep these aggregated to avoid one-per-row noise.
            if remaining == 0 and b.status == "completed":
                total_ok = (
                    MintBatchRow.query.filter_by(batch_id=batch_id)
                    .filter(MintBatchRow.row_status.in_(["mint_confirmed", "email_sent", "email_failed"]))
                    .count()
                )
                notification_service.notify_university_users(
                    uni.id,
                    kind="batch_completed",
                    title="Batch mint completed",
                    body=f"Batch #{b.id} completed. Minted {int(total_ok)} row(s).",
                    payload={"batch_id": int(b.id), "minted_total": int(total_ok)},
                )
            else:
                notification_service.notify_university_users(
                    uni.id,
                    kind="batch_mint_progress",
                    title="Batch mint progress",
                    body=f"Minted {len(minted_out)} row(s) in batch #{b.id}. Remaining rows: {remaining}.",
                    payload={
                        "batch_id": int(b.id),
                        "minted_count": int(len(minted_out)),
                        "remaining_rows": int(remaining),
                    },
                )
        db.session.commit()

        return jsonify(
            {
                "minted": minted_out,
                "remaining_rows": remaining,
                "batch_status": b.status,
                "timing": {
                    # Wall time for this entire execute handler (all rows minted in this POST, up to commit).
                    "chunk_wall_ms": chunk_wall_ms,
                },
            }
        )

    @bp.get("/university/mint-batches/<int:batch_id>/export-errors")
    @jwt_required()
    def export_mint_batch_errors(batch_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni:
            return jsonify({"error": "No university profile"}), 400
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        rows = (
            MintBatchRow.query.filter_by(batch_id=batch_id)
            .filter(MintBatchRow.row_status.in_(["invalid", "mint_failed"]))
            .order_by(MintBatchRow.row_index.asc())
            .all()
        )
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["row_index", "cert_id", "row_status", "validation_errors", "error_message"])
        for r in rows:
            w.writerow(
                [
                    r.row_index,
                    r.cert_id or "",
                    r.row_status,
                    r.validation_errors or "",
                    (r.error_message or "").replace("\n", " "),
                ]
            )
        return Response(
            buf.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename=batch-{batch_id}-errors.csv"},
        )

    @bp.post("/university/mint-batches/<int:batch_id>/rows/<int:row_id>/ai-qa")
    @jwt_required()
    def batch_row_ai_qa(batch_id: int, row_id: int):
        """Advisory consistency check for one batch row; omits email/internal IDs from the model payload."""
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        row = MintBatchRow.query.filter_by(id=row_id, batch_id=batch_id).first()
        if not row:
            return jsonify({"error": "Row not found"}), 404

        body = request.get_json(silent=True) or {}
        question = (body.get("question") or "").strip()
        if len(question) > BATCH_ROW_AI_MAX_QUESTION_CHARS:
            return jsonify(
                {"error": f"question must be at most {BATCH_ROW_AI_MAX_QUESTION_CHARS} characters"}
            ), 400

        if not gemini_service.is_configured():
            return jsonify({"error": "Gemini not configured"}), 503

        snapshot = {
            "institution": {"name": uni.name},
            "batch_id": batch_id,
            "row": _sanitize_batch_row_for_ai(row),
        }

        system_instruction = (
            "You help university staff sanity-check one CSV batch row before TrueCert minting. "
            "Comment on internal consistency: date format (YYYY-MM-DD), cert_id style, whether name/degree/issue "
            "date look plausible together, and whether row_status matches preparation (e.g. prepared vs pending_validation). "
            "If validation_errors are present, explain them in plain language. "
            "Advisory only: issuer systems and TrueCert server validation are authoritative. "
            "Never ask for or infer student email or internal student IDs — those were not provided on purpose. "
            "Answer in under 180 words, plain text, no markdown headings or bullet lists."
        )
        prompt = "Review this batch row snapshot.\n" + json.dumps(snapshot, ensure_ascii=False)
        if question:
            prompt += f"\n\nIssuer question: {question}"

        try:
            text = gemini_service.generate_text(prompt, system_instruction=system_instruction)
        except gemini_service.GeminiNotConfiguredError:
            return jsonify({"error": "Gemini not configured"}), 503
        except gemini_service.GeminiError as e:
            return jsonify({"error": str(e)}), 503

        return jsonify({"model": (Config.GEMINI_MODEL or "gemini-1.5-flash").strip(), "text": text})
