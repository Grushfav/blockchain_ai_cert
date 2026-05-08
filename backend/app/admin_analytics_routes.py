"""Admin-only Phase 1 analytics: dashboard aggregates, activity CSV, batch outcomes."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime
from typing import Any

from flask import Blueprint, Response, abort, jsonify, request
from flask_jwt_extended import get_jwt, jwt_required
from sqlalchemy import func

from app.extensions import db
from app.models import ActivityLog, MintBatch, MintBatchRow, University
from app.services import analytics_service

_api_bp: Blueprint | None = None

AMOY_TX_EXPLORER = "https://amoy.polygonscan.com/tx/"


def _require_admin() -> None:
    assert _api_bp is not None
    from flask_jwt_extended import get_jwt

    if get_jwt().get("role") != "admin":
        abort(403)


def register_admin_analytics_routes(bp: Blueprint) -> None:
    global _api_bp
    _api_bp = bp

    @bp.get("/admin/analytics/summary")
    @jwt_required()
    def admin_analytics_summary():
        _require_admin()
        certs = analytics_service.certificate_status_counts()
        lifecycle = analytics_service.lifecycle_claim_subset()
        issuance = analytics_service.issuance_counts_by_window()
        reissues = analytics_service.reissue_counts()
        eip_single = analytics_service.eip712_single_mint_summary()
        batch_signed = analytics_service.batch_signature_count()
        batch_status_rows = (
            db.session.query(MintBatch.status, func.count(MintBatch.id)).group_by(MintBatch.status).all()
        )
        batch_by_status = {str(s or ""): int(n) for s, n in batch_status_rows}

        minted_single = int(eip_single.get("requests_by_status", {}).get("minted", 0))

        return jsonify(
            {
                "generated_at_utc": datetime.utcnow().isoformat() + "Z",
                "explorer_tx_base": AMOY_TX_EXPLORER,
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
                    "note": "Windows use UTC; week starts Monday 00:00 UTC.",
                },
                "reissues": reissues,
                "eip712": {
                    "single_mint_authorization_requests": eip_single,
                    "batch_authorizations_recorded": batch_signed,
                    "single_mints_completed_via_request_table": minted_single,
                },
                "mint_batches": {
                    "total": MintBatch.query.count(),
                    "by_status": batch_by_status,
                },
            }
        )

    @bp.get("/admin/analytics/activity-log")
    @jwt_required()
    def admin_activity_log_json():
        _require_admin()
        limit = min(max(int(request.args.get("limit", 100)), 1), 500)
        offset = max(int(request.args.get("offset", 0)), 0)
        uni_id = request.args.get("university_id", type=int)
        action = (request.args.get("action") or "").strip() or None

        q = ActivityLog.query
        if uni_id is not None:
            q = q.filter(ActivityLog.university_id == uni_id)
        if action:
            q = q.filter(ActivityLog.action == action)
        total = q.count()
        rows = (
            q.order_by(ActivityLog.block_number.desc(), ActivityLog.log_index.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        uni_ids = {r.university_id for r in rows if r.university_id}
        uni_map: dict[int, str] = {}
        if uni_ids:
            for u in University.query.filter(University.id.in_(uni_ids)).all():
                uni_map[u.id] = u.name

        def row_to_dict(r: ActivityLog) -> dict[str, Any]:
            details = None
            if r.details_json:
                try:
                    details = json.loads(r.details_json)
                except Exception:
                    details = {"raw": r.details_json[:500]}
            tx = (r.tx_hash or "").strip()
            return {
                "id": r.id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "block_timestamp": r.block_timestamp.isoformat() if r.block_timestamp else None,
                "university_id": r.university_id,
                "university_name": uni_map.get(r.university_id) if r.university_id else None,
                "token_id": r.token_id,
                "action": r.action,
                "tx_hash": tx,
                "tx_explorer_url": (AMOY_TX_EXPLORER + tx) if tx else None,
                "log_index": r.log_index,
                "block_number": r.block_number,
                "actor": r.actor,
                "details": details,
            }

        return jsonify(
            {
                "total": total,
                "limit": limit,
                "offset": offset,
                "events": [row_to_dict(r) for r in rows],
            }
        )

    @bp.get("/admin/analytics/activity-log.csv")
    @jwt_required()
    def admin_activity_log_csv():
        _require_admin()
        limit = min(max(int(request.args.get("limit", 5000)), 1), 20000)
        uni_id = request.args.get("university_id", type=int)
        action = (request.args.get("action") or "").strip() or None

        q = ActivityLog.query
        if uni_id is not None:
            q = q.filter(ActivityLog.university_id == uni_id)
        if action:
            q = q.filter(ActivityLog.action == action)
        rows = (
            q.order_by(ActivityLog.block_number.desc(), ActivityLog.log_index.desc()).limit(limit).all()
        )
        uni_ids = {r.university_id for r in rows if r.university_id}
        uni_map: dict[int, str] = {}
        if uni_ids:
            for u in University.query.filter(University.id.in_(uni_ids)).all():
                uni_map[u.id] = u.name

        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(
            [
                "id",
                "created_at",
                "block_timestamp",
                "university_id",
                "university_name",
                "token_id",
                "action",
                "tx_hash",
                "log_index",
                "block_number",
                "actor",
                "details_json",
            ]
        )
        for r in rows:
            w.writerow(
                [
                    r.id,
                    r.created_at.isoformat() if r.created_at else "",
                    r.block_timestamp.isoformat() if r.block_timestamp else "",
                    r.university_id or "",
                    uni_map.get(r.university_id, "") if r.university_id else "",
                    r.token_id if r.token_id is not None else "",
                    r.action,
                    r.tx_hash,
                    r.log_index,
                    r.block_number,
                    r.actor or "",
                    (r.details_json or "").replace("\n", " ").replace("\r", " ")[:8000],
                ]
            )
        name = f"trucert-activity-log-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
        return Response(
            buf.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )

    @bp.get("/admin/analytics/batches")
    @jwt_required()
    def admin_batches_list():
        _require_admin()
        limit = min(max(int(request.args.get("limit", 50)), 1), 200)
        offset = max(int(request.args.get("offset", 0)), 0)
        q = MintBatch.query.order_by(MintBatch.id.desc())
        total = q.count()
        batches = q.offset(offset).limit(limit).all()
        uni_ids = {b.university_id for b in batches}
        unis = {u.id: u for u in University.query.filter(University.id.in_(uni_ids)).all()} if uni_ids else {}
        out = [analytics_service.serialize_batch_list_item(b, unis.get(b.university_id)) for b in batches]
        return jsonify({"total": total, "limit": limit, "offset": offset, "batches": out})

    @bp.get("/admin/analytics/batches/<int:batch_id>")
    @jwt_required()
    def admin_batch_detail(batch_id: int):
        _require_admin()
        b = db.session.get(MintBatch, batch_id)
        if not b:
            return jsonify({"error": "Batch not found"}), 404
        uni = db.session.get(University, b.university_id)
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
