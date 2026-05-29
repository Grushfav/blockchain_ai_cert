"""University-scoped Phase 1 analytics (JWT university role; filtered by logged-in institution)."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from flask import Blueprint, abort, jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from sqlalchemy import func

from app.extensions import db
from app.models import ActivityLog, MintAuthorizationRequest, MintBatch, MintBatchRow, University, User
from app.services import analytics_service

_api_bp: Blueprint | None = None
_routes_registered = False

AMOY_TX_EXPLORER = "https://amoy.polygonscan.com/tx/"


def _require_university() -> tuple[User, int]:
    assert _api_bp is not None
    uid = get_jwt_identity()
    if not uid:
        abort(401)
    user = db.session.get(User, int(uid))
    if not user or user.role != "university" or not user.university_id:
        abort(403)
    return user, int(user.university_id)


def register_university_analytics_routes(bp: Blueprint) -> None:
    global _api_bp, _routes_registered
    _api_bp = bp
    if _routes_registered:
        return
    _routes_registered = True

    @bp.get("/university/analytics/summary")
    @jwt_required()
    def university_analytics_summary():
        _, uni_id = _require_university()
        certs = analytics_service.certificate_status_counts_for_university(uni_id)
        lifecycle = analytics_service.lifecycle_claim_subset_for_university(uni_id)
        issuance = analytics_service.issuance_counts_by_window_for_university(uni_id)
        reissues = analytics_service.reissue_counts_for_university(uni_id)
        eip_single = analytics_service.eip712_single_mint_summary_for_university(uni_id)
        batch_signed = analytics_service.batch_signature_count_for_university(uni_id)

        batch_status_rows = (
            db.session.query(MintBatch.status, func.count(MintBatch.id))
            .filter(MintBatch.university_id == uni_id)
            .group_by(MintBatch.status)
            .all()
        )
        batch_by_status = {str(s or ""): int(n) for s, n in batch_status_rows}

        minted_single = int(eip_single.get("requests_by_status", {}).get("minted", 0))
        mint_timing = analytics_service.mint_timing_summary(university_id=uni_id)

        uni = db.session.get(University, uni_id)

        return jsonify(
            {
                "generated_at_utc": datetime.utcnow().isoformat() + "Z",
                "explorer_tx_base": AMOY_TX_EXPLORER,
                "institution": {"name": uni.name if uni else None, "internal_id": uni.internal_id if uni else None},
                "certificates_by_status": certs,
                "lifecycle": {
                    "revoked": int(certs.get("revoked", 0)),
                    "burned": int(certs.get("burned", 0)),
                    "reissued_tokens": int(certs.get("reissued", 0)),
                    "prepared": int(certs.get("prepared", 0)),
                    **lifecycle,
                },
                "issuance_volume": {
                    "activity_log_action_issued": issuance,
                    "note": "UTC-5 (America/Panama) windows; includes mints once activity sync / indexing has logged them.",
                },
                "reissues": reissues,
                "eip712": {
                    "single_mint_authorization_requests": eip_single,
                    "batch_authorizations_recorded": batch_signed,
                    "single_mints_completed_via_request_table": minted_single,
                },
                "mint_batches": {
                    "total": MintBatch.query.filter_by(university_id=uni_id).count(),
                    "by_status": batch_by_status,
                },
                "mint_timing": mint_timing,
            }
        )

    @bp.get("/university/analytics/mints-timeseries")
    @jwt_required()
    def university_mints_timeseries():
        _, uni_id = _require_university()
        raw = (request.args.get("days") or "30").strip()
        try:
            d = int(raw)
        except Exception:
            d = 30
        if d not in (7, 30, 90):
            d = 30
        return jsonify(analytics_service.mint_timeseries_filled_days(university_id=uni_id, days=d))

    @bp.get("/university/analytics/mints-heatmap")
    @jwt_required()
    def university_mints_heatmap():
        _, uni_id = _require_university()
        raw = (request.args.get("days") or "90").strip()
        try:
            d = int(raw)
        except Exception:
            d = 90
        if d not in (30, 90):
            d = 90
        return jsonify(analytics_service.mint_heatmap_weekday_hour_utc(university_id=uni_id, days=d))

    @bp.get("/university/analytics/recent-activity")
    @jwt_required()
    def university_recent_activity():
        _, uni_id = _require_university()
        limit = min(max(int(request.args.get("limit", 25)), 1), 100)
        rows = (
            ActivityLog.query.filter_by(university_id=uni_id)
            .order_by(ActivityLog.block_number.desc(), ActivityLog.log_index.desc())
            .limit(limit)
            .all()
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            tx = (r.tx_hash or "").strip()
            details = None
            if r.details_json:
                try:
                    details = json.loads(r.details_json)
                except Exception:
                    details = None
            out.append(
                {
                    "token_id": r.token_id,
                    "action": r.action,
                    "tx_hash": tx or None,
                    "tx_explorer_url": (AMOY_TX_EXPLORER + tx) if tx else None,
                    "block_number": r.block_number,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                    "block_timestamp": r.block_timestamp.isoformat() if r.block_timestamp else None,
                    "details": details,
                }
            )
        return jsonify({"events": out})

    @bp.get("/university/hub-pending-counts")
    @jwt_required()
    def university_hub_pending_counts():
        """
        Compact counts for the institution overview hub.

        Latest batch rule: the row with the greatest MintBatch.id for this university_id (same ordering as
        GET /university/analytics/batches). This matches newest-first batch list; created_at is not used
        so IDs remain stable if backfilled.

        Row semantics align with portal batch signing:
        - rows_awaiting_preparation: rows not in terminal success/invalid states and not yet `prepared`.
        - mint_failed_rows: rows with row_status == mint_failed on that latest batch only.
        """
        _, uni_id = _require_university()
        pending_eip712 = int(
            MintAuthorizationRequest.query.filter_by(university_id=uni_id, status="pending").count()
        )

        latest = MintBatch.query.filter_by(university_id=uni_id).order_by(MintBatch.id.desc()).first()
        if not latest:
            return jsonify(
                {
                    "latest_batch_id": None,
                    "rows_awaiting_preparation": 0,
                    "mint_failed_rows": 0,
                    "pending_single_mint_eip712": pending_eip712,
                }
            )

        bid = int(latest.id)
        terminal = ("invalid", "mint_confirmed", "email_sent", "email_failed")
        awaiting = (
            MintBatchRow.query.filter_by(batch_id=bid)
            .filter(~MintBatchRow.row_status.in_(terminal))
            .filter(MintBatchRow.row_status != "prepared")
            .count()
        )
        mint_failed = int(MintBatchRow.query.filter_by(batch_id=bid, row_status="mint_failed").count())

        return jsonify(
            {
                "latest_batch_id": bid,
                "rows_awaiting_preparation": int(awaiting),
                "mint_failed_rows": mint_failed,
                "pending_single_mint_eip712": pending_eip712,
            }
        )

    @bp.get("/university/analytics/batches")
    @jwt_required()
    def university_batches_list():
        _, uni_id = _require_university()
        limit = min(max(int(request.args.get("limit", 30)), 1), 100)
        offset = max(int(request.args.get("offset", 0)), 0)
        q = MintBatch.query.filter_by(university_id=uni_id).order_by(MintBatch.id.desc())
        total = q.count()
        batches = q.offset(offset).limit(limit).all()
        uni = db.session.get(University, uni_id)
        out = [analytics_service.serialize_batch_list_item(b, uni) for b in batches]
        return jsonify({"total": total, "limit": limit, "offset": offset, "batches": out})

    @bp.get("/university/analytics/batches/<int:batch_id>")
    @jwt_required()
    def university_batch_detail(batch_id: int):
        _, uni_id = _require_university()
        b = db.session.get(MintBatch, batch_id)
        if not b or b.university_id != uni_id:
            return jsonify({"error": "Batch not found"}), 404
        uni = db.session.get(University, uni_id)
        summary = analytics_service.serialize_batch_list_item(b, uni)
        rows = MintBatchRow.query.filter_by(batch_id=batch_id).order_by(MintBatchRow.row_index.asc()).all()
        row_out = []
        for r in rows:
            tx = (r.tx_hash or "").strip()
            row_out.append(
                {
                    "id": r.id,
                    "row_index": r.row_index,
                    "cert_id": r.cert_id,
                    "row_status": r.row_status,
                    "token_id": r.token_id,
                    "tx_hash": tx or None,
                    "tx_explorer_url": (AMOY_TX_EXPLORER + tx) if tx else None,
                    "error_message": (r.error_message or "")[:500] if r.error_message else None,
                    "minted_at": r.minted_at.isoformat() if r.minted_at else None,
                }
            )
        summary["rows"] = row_out
        return jsonify(summary)
