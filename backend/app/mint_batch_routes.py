"""CSV batch mint routes (registered on main api blueprint from create_app)."""

from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import jwt_required
from web3 import Web3
from werkzeug.utils import secure_filename

from app.config import Config
from app.extensions import db
from app.models import ActivityLog, CertificateRecord, MintBatch, MintBatchRow, University, User
from app.services import blockchain_service, metadata_signing, pinata_service

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
    }


def _other_prepared_row(university_id: int, exclude_row_id: int) -> MintBatchRow | None:
    return (
        MintBatchRow.query.join(MintBatch)
        .filter(
            MintBatch.university_id == university_id,
            MintBatchRow.row_status == "prepared",
            MintBatchRow.id != exclude_row_id,
        )
        .first()
    )


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
        return False, "tx not to TruCert contract"
    if Web3.to_checksum_address(tx["from"]).lower() != Web3.to_checksum_address(expected_issuer).lower():
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

        if row.row_status == "mint_failed" and row.metadata_uri and row.core_hash:
            other_mf = _other_prepared_row(uni.id, row.id)
            if other_mf:
                return jsonify(
                    {
                        "error": "Another batch row is prepared and awaiting mint. Finish that mint before retrying this row.",
                        "blocking_row_id": other_mf.id,
                    }
                ), 409
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

        other = _other_prepared_row(uni.id, row.id)
        if other:
            return jsonify(
                {
                    "error": "Another batch row is prepared and awaiting mint. Mint or clear it before preparing another.",
                    "blocking_row_id": other.id,
                }
            ), 409

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

    @bp.post("/university/mint-batches/<int:batch_id>/rows/<int:row_id>/confirm-mint")
    @jwt_required()
    def confirm_mint_batch_row(batch_id: int, row_id: int):
        _require_roles("university")
        user = _current_user()
        uni = user.university
        if not uni or uni.status != "verified":
            return jsonify({"error": "University is not verified"}), 403
        b = MintBatch.query.filter_by(id=batch_id, university_id=uni.id).first()
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        row = MintBatchRow.query.filter_by(id=row_id, batch_id=batch_id).first()
        if not row:
            return jsonify({"error": "Row not found"}), 404
        if row.row_status not in ("prepared",):
            return jsonify({"error": "Row is not in prepared state"}), 400

        body = request.get_json(silent=True) or {}
        tx_hash = (body.get("tx_hash") or "").strip()
        token_id = body.get("token_id")
        if not tx_hash or token_id is None:
            return jsonify({"error": "tx_hash and token_id are required"}), 400
        try:
            token_id_int = int(token_id)
        except (TypeError, ValueError):
            return jsonify({"error": "token_id must be an integer"}), 400

        if not row.core_hash or not row.metadata_uri or not row.cert_id:
            return jsonify({"error": "Row is missing prepare data"}), 400

        try:
            w3 = blockchain_service.get_w3()
            cfg_err = _require_contract_code(w3)
            if cfg_err:
                return jsonify({"error": cfg_err}), 503
            contract = blockchain_service.get_contract(w3)
        except Exception as e:
            return jsonify({"error": str(e)}), 502

        ok, reason = _verify_certificate_mint_receipt(
            w3,
            contract,
            tx_hash,
            expected_issuer=uni.wallet_address,
            expected_cert_id=row.cert_id or "",
            expected_core_hash_hex=row.core_hash or "",
            claimed_token_id=token_id_int,
        )
        if not ok:
            row.row_status = "mint_failed"
            row.error_message = reason
            b.updated_at = datetime.utcnow()
            db.session.commit()
            return jsonify({"error": reason}), 400

        rec = CertificateRecord.query.filter_by(cert_id=row.cert_id).first()
        if not rec or rec.token_id != token_id_int:
            return jsonify({"error": "CertificateRecord does not match minted token"}), 400
        if rec.university_id != uni.id:
            return jsonify({"error": "Certificate record belongs to another university"}), 403

        receipt = w3.eth.get_transaction_receipt(tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash)
        rec.status = "issued"
        row.tx_hash = tx_hash if tx_hash.startswith("0x") else "0x" + tx_hash
        row.token_id = token_id_int
        row.minted_at = datetime.utcnow()
        row.row_status = "mint_confirmed"
        row.error_message = None

        try:
            processed = contract.events.CertificateMinted().process_receipt(receipt)
            for lg in processed:
                args = lg["args"]
                if str(args.get("certId", "")).strip() == str(row.cert_id).strip():
                    _li = lg.get("logIndex", lg.get("log_index", 0))
                    log_index = int(_li) if _li is not None else 0
                    _append_mint_activity(
                        university_id=uni.id,
                        token_id=token_id_int,
                        tx_hash=row.tx_hash,
                        block_number=int(receipt["blockNumber"]),
                        log_index=log_index,
                        actor=uni.wallet_address,
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

        b.updated_at = datetime.utcnow()
        _maybe_complete_batch(b)
        db.session.commit()

        return jsonify(
            {
                "message": "Mint confirmed",
                "token_id": token_id_int,
                "tx_hash": row.tx_hash,
                "row_status": row.row_status,
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
