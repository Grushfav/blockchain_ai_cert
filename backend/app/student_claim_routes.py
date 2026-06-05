"""Public student claim requests + university approval workflow."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from flask import Blueprint, abort, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required
from sqlalchemy import func
from web3 import Web3

from app.extensions import db
from app.models import CertificateRecord, MintBatch, MintBatchRow, StudentClaimRequest, University, User
from app.services import blockchain_service, notification_service
from app.university_freeze import freeze_guard_response

ROW_READY_FOR_CLAIM = frozenset({"mint_confirmed", "email_sent", "email_failed"})
ACTIVE_STATUSES = frozenset({"pending", "approved"})


def _require_roles(*roles: str) -> None:
    claims = get_jwt()
    if claims.get("role") not in roles:
        abort(403)


def _current_user() -> User:
    uid = get_jwt_identity()
    if not uid:
        abort(401)
    user = db.session.get(User, int(uid))
    if not user:
        abort(401)
    return user


def _serialize_request(r: StudentClaimRequest, *, row: MintBatchRow | None = None) -> dict[str, Any]:
    name = row.student_full_name if row else None
    degree = row.degree_title if row else None
    return {
        "id": r.id,
        "university_id": r.university_id,
        "token_id": r.token_id,
        "cert_id": r.cert_id,
        "student_internal_id": r.student_internal_id,
        "student_email": r.student_email,
        "wallet_address": r.wallet_address,
        "status": r.status,
        "rejection_reason": r.rejection_reason,
        "decided_at": r.decided_at.isoformat() + "Z" if r.decided_at else None,
        "claim_tx_hash": r.claim_tx_hash,
        "created_at": r.created_at.isoformat() + "Z" if r.created_at else None,
        "student_full_name": name,
        "degree_title": degree,
    }


def _find_single_certificate_for_student(
    *, university_id: int, student_internal_id: str, email: str
) -> CertificateRecord | None:
    """Single-mint credentials stored on certificate_records (not mint_batch_rows)."""
    sid = student_internal_id.strip()
    em = email.strip().lower()
    if not sid or not em:
        return None
    q = (
        CertificateRecord.query.filter_by(university_id=int(university_id))
        .filter(CertificateRecord.token_id.isnot(None))
        .filter(CertificateRecord.status == "issued")
        .filter(CertificateRecord.student_internal_id.isnot(None))
        .filter(CertificateRecord.student_email.isnot(None))
        .filter(func.lower(func.trim(CertificateRecord.student_email)) == em)
        .filter(func.trim(CertificateRecord.student_internal_id) == sid)
        .order_by(CertificateRecord.id.desc())
    )
    rows = q.all()
    return rows[0] if rows else None


def _find_mint_row_for_student(*, university_id: int, student_internal_id: str, email: str) -> MintBatchRow | None:
    sid = student_internal_id.strip()
    em = email.strip().lower()
    if not sid or not em:
        return None
    q = (
        MintBatchRow.query.join(MintBatch)
        .filter(MintBatch.university_id == int(university_id))
        .filter(MintBatchRow.token_id.isnot(None))
        .filter(MintBatchRow.student_internal_id.isnot(None))
        .filter(MintBatchRow.student_email.isnot(None))
        .filter(MintBatchRow.row_status.in_(tuple(ROW_READY_FOR_CLAIM)))
        .filter(func.lower(func.trim(MintBatchRow.student_email)) == em)
        .filter(func.trim(MintBatchRow.student_internal_id) == sid)
        .order_by(MintBatchRow.id.desc())
    )
    rows = q.all()
    return rows[0] if rows else None


def register_student_claim_routes(bp: Blueprint) -> None:
    @bp.post("/public/student-claim-requests")
    def public_create_student_claim_request():
        data = request.get_json(silent=True) or {}
        try:
            university_id = int(data.get("university_id"))
        except Exception:
            return ({"error": "university_id is required"}, 400)
        student_internal_id = (data.get("student_internal_id") or "").strip()
        student_email = (data.get("student_email") or "").strip()
        wallet_raw = (data.get("wallet_address") or "").strip()
        if not student_internal_id or not student_email:
            return ({"error": "student_internal_id and student_email are required"}, 400)
        if not wallet_raw.startswith("0x") or len(wallet_raw) != 42:
            return ({"error": "wallet_address must be a 0x-prefixed 20-byte address"}, 400)
        try:
            wallet = Web3.to_checksum_address(wallet_raw)
        except Exception:
            return ({"error": "wallet_address is invalid"}, 400)

        uni = db.session.get(University, university_id)
        if not uni or uni.status != "verified":
            return ({"error": "Institution not found or not accepting requests"}, 404)

        row = _find_mint_row_for_student(
            university_id=university_id,
            student_internal_id=student_internal_id,
            email=student_email,
        )
        cert_rec: CertificateRecord | None = None
        if not row or row.token_id is None:
            cert_rec = _find_single_certificate_for_student(
                university_id=university_id,
                student_internal_id=student_internal_id,
                email=student_email,
            )
            if not cert_rec or cert_rec.token_id is None:
                return (
                    {
                        "error": (
                            "No minted credential matched that institution, student ID, and email. "
                            "Use the same student ID and email your school used when the certificate was issued "
                            "(single mint or batch upload)."
                        )
                    },
                    404,
                )
            tid = int(cert_rec.token_id)
        else:
            tid = int(row.token_id)
        ok_chain, chain_err = blockchain_service.escrow_claim_eligibility(
            token_id=tid, issuer_wallet=uni.wallet_address
        )
        if not ok_chain:
            return ({"error": chain_err or "This credential cannot be transferred right now."}, 400)

        open_req = (
            StudentClaimRequest.query.filter_by(university_id=university_id, token_id=tid)
            .filter(StudentClaimRequest.status.in_(tuple(ACTIVE_STATUSES)))
            .first()
        )
        if open_req:
            return ({"error": "A claim request for this credential is already open."}, 409)

        cert_id = row.cert_id if row else (cert_rec.cert_id if cert_rec else None)
        rec = StudentClaimRequest(
            university_id=university_id,
            mint_batch_row_id=row.id if row else None,
            token_id=tid,
            cert_id=(cert_id or "").strip() or None,
            student_internal_id=student_internal_id.strip(),
            student_email=student_email.strip().lower(),
            wallet_address=wallet,
            status="pending",
        )
        db.session.add(rec)
        db.session.flush()

        n = notification_service.notify_university_users(
            university_id,
            kind="student_claim_request",
            title="New student claim request",
            body=f"Token #{tid} — student {student_email.strip()} requested transfer to {wallet[:6]}…{wallet[-4:]}.",
            payload={"request_id": rec.id, "token_id": tid},
        )
        db.session.commit()

        return (
            {
                "id": rec.id,
                "status": rec.status,
                "token_id": tid,
                "message": "Request submitted. Your institution will review and execute the on-chain transfer.",
                "notifications_sent": n,
            },
            201,
        )

    @bp.get("/university/student-claim-requests")
    @jwt_required()
    def university_list_claim_requests():
        _require_roles("university")
        user = _current_user()
        if not user.university_id:
            abort(403)
        status_filter = (request.args.get("status") or "").strip().lower()
        q = StudentClaimRequest.query.filter_by(university_id=int(user.university_id))
        if status_filter:
            q = q.filter_by(status=status_filter)
        rows = q.order_by(StudentClaimRequest.created_at.desc()).limit(200).all()
        out = []
        for r in rows:
            row = r.mint_batch_row if r.mint_batch_row_id else None
            if row is None and r.mint_batch_row_id:
                row = db.session.get(MintBatchRow, r.mint_batch_row_id)
            out.append(_serialize_request(r, row=row))
        return jsonify({"requests": out})

    @bp.post("/university/student-claim-requests/<int:req_id>/approve")
    @jwt_required()
    def university_approve_claim_request(req_id: int):
        _require_roles("university")
        user = _current_user()
        if not user.university_id:
            abort(403)
        rec = db.session.get(StudentClaimRequest, req_id)
        if not rec or rec.university_id != int(user.university_id):
            return ({"error": "Request not found"}, 404)
        if rec.status != "pending":
            return ({"error": "Only pending requests can be approved"}, 400)

        uni = db.session.get(University, rec.university_id)
        if not uni:
            return ({"error": "Institution missing"}, 400)
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        ok_chain, chain_err = blockchain_service.escrow_claim_eligibility(
            token_id=int(rec.token_id), issuer_wallet=uni.wallet_address
        )
        if not ok_chain:
            return ({"error": chain_err or "On-chain state no longer allows this claim."}, 400)

        rec.status = "approved"
        rec.decided_at = datetime.utcnow()
        rec.decided_by_user_id = user.id
        rec.rejection_reason = None
        db.session.commit()
        return jsonify({"ok": True, "request": _serialize_request(rec, row=rec.mint_batch_row)})

    @bp.post("/university/student-claim-requests/<int:req_id>/reject")
    @jwt_required()
    def university_reject_claim_request(req_id: int):
        _require_roles("university")
        user = _current_user()
        if not user.university_id:
            abort(403)
        data = request.get_json(silent=True) or {}
        reason = (data.get("reason") or "").strip() or None
        rec = db.session.get(StudentClaimRequest, req_id)
        if not rec or rec.university_id != int(user.university_id):
            return ({"error": "Request not found"}, 404)
        if rec.status != "pending":
            return ({"error": "Only pending requests can be rejected"}, 400)
        uni = db.session.get(University, rec.university_id)
        if not uni:
            return ({"error": "Institution missing"}, 400)
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        rec.status = "rejected"
        rec.decided_at = datetime.utcnow()
        rec.decided_by_user_id = user.id
        rec.rejection_reason = reason
        db.session.commit()
        return jsonify({"ok": True, "request": _serialize_request(rec, row=rec.mint_batch_row)})

    @bp.post("/university/student-claim-requests/<int:req_id>/complete")
    @jwt_required()
    def university_complete_claim_request(req_id: int):
        _require_roles("university")
        user = _current_user()
        if not user.university_id:
            abort(403)
        data = request.get_json(silent=True) or {}
        tx_hash = (data.get("claim_tx_hash") or "").strip() or None
        if tx_hash and not tx_hash.startswith("0x"):
            tx_hash = "0x" + tx_hash
        rec = db.session.get(StudentClaimRequest, req_id)
        if not rec or rec.university_id != int(user.university_id):
            return ({"error": "Request not found"}, 404)
        if rec.status != "approved":
            return ({"error": "Only approved requests can be marked complete"}, 400)
        uni = db.session.get(University, rec.university_id)
        if not uni:
            return ({"error": "Institution missing"}, 400)
        fr = freeze_guard_response(uni)
        if fr:
            return fr
        rec.status = "completed"
        rec.claim_tx_hash = tx_hash[:66] if tx_hash else None
        rec.decided_at = datetime.utcnow()
        db.session.commit()
        return jsonify({"ok": True, "request": _serialize_request(rec, row=rec.mint_batch_row)})
