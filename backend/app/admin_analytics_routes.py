"""Admin-only Phase 1 analytics: dashboard aggregates, activity CSV, batch outcomes."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, Response, abort, jsonify, request
from flask_jwt_extended import get_jwt, jwt_required
from sqlalchemy import func

from app.config import Config
from app.extensions import db
from app.models import ActivityLog, CertificateRecord, MintBatch, MintBatchRow, University
from app.services import analytics_service, gemini_service, risk_hints_service

_api_bp: Blueprint | None = None

AMOY_TX_EXPLORER = "https://amoy.polygonscan.com/tx/"


def _require_admin() -> None:
    assert _api_bp is not None
    from flask_jwt_extended import get_jwt

    if get_jwt().get("role") != "admin":
        abort(403)


def _admin_summary_body(uni_id: int | None) -> tuple[dict[str, Any] | None, int | None]:
    """Build the same JSON shape as GET /admin/analytics/summary. Returns (body, error_status)."""
    uni_name: str | None = None
    if uni_id is not None:
        u = db.session.get(University, uni_id)
        if not u:
            return {"error": "University not found"}, 404
        uni_name = u.name
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
        batch_total = int(MintBatch.query.filter_by(university_id=uni_id).count())
    else:
        certs = analytics_service.certificate_status_counts()
        lifecycle = analytics_service.lifecycle_claim_subset()
        issuance = analytics_service.issuance_counts_by_window()
        reissues = analytics_service.reissue_counts()
        eip_single = analytics_service.eip712_single_mint_summary()
        batch_signed = analytics_service.batch_signature_count()
        batch_status_rows = (
            db.session.query(MintBatch.status, func.count(MintBatch.id)).group_by(MintBatch.status).all()
        )
        batch_total = int(MintBatch.query.count())

    batch_by_status = {str(s or ""): int(n) for s, n in batch_status_rows}
    minted_single = int(eip_single.get("requests_by_status", {}).get("minted", 0))
    mint_timing = analytics_service.mint_timing_summary(university_id=uni_id)

    body: dict[str, Any] = {
        "generated_at_utc": datetime.utcnow().isoformat() + "Z",
        "explorer_tx_base": AMOY_TX_EXPLORER,
        "university_id": uni_id,
        "university_name": uni_name,
        "scope": "institution" if uni_id is not None else "platform",
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
            "total": batch_total,
            "by_status": batch_by_status,
        },
        "mint_timing": mint_timing,
    }
    return body, None


ACTIVITY_BRIEF_DISCLAIMER = (
    "This briefing is AI-generated from aggregate analytics only; it is not proof of fraud or abuse. "
    "Confirm details in Admin Analytics, the Risk board, and university records before acting."
)


def admin_institutions_overview_payload(include_risk: bool) -> dict[str, Any]:
    """Same rows as GET /admin/analytics/institutions-overview (no HTTP)."""
    as_of = datetime.now(timezone.utc)
    unis = University.query.order_by(University.id.asc()).all()
    out: list[dict[str, Any]] = []
    for u in unis:
        cert_total = int(CertificateRecord.query.filter_by(university_id=u.id).count())
        activity_n = int(ActivityLog.query.filter_by(university_id=u.id).count())
        batch_n = int(MintBatch.query.filter_by(university_id=u.id).count())
        last_log = ActivityLog.query.filter_by(university_id=u.id).order_by(ActivityLog.id.desc()).first()
        last_at: str | None = None
        if last_log:
            ts = last_log.block_timestamp or last_log.created_at
            if ts:
                last_at = ts.isoformat()

        row: dict[str, Any] = {
            "id": u.id,
            "name": u.name,
            "internal_id": u.internal_id,
            "status": u.status,
            "certificates_indexed": cert_total,
            "activity_events": activity_n,
            "mint_batches": batch_n,
            "last_activity_at": last_at,
        }
        if include_risk:
            try:
                metrics = risk_hints_service.compute_metrics(
                    int(u.id),
                    as_of=as_of,
                    current_days=7,
                    reference_days=90,
                )
                flags = risk_hints_service.compute_flags(metrics)
                summ = risk_hints_service.summarize_severity(flags)
                row["risk"] = {
                    "computed_at": metrics.get("computed_at"),
                    "flag_count": summ["flag_count"],
                    "highest_severity": summ["highest_severity"],
                    "flag_codes": [str(f.get("code") or "") for f in flags[:12] if f.get("code")],
                }
            except Exception:
                row["risk"] = {
                    "computed_at": None,
                    "flag_count": None,
                    "highest_severity": None,
                    "flag_codes": [],
                    "error": "risk_compute_failed",
                }
        out.append(row)

    return {"generated_at_utc": datetime.utcnow().isoformat() + "Z", "institutions": out}


def _reduced_platform_summary_for_brief(body: dict[str, Any]) -> dict[str, Any]:
    mt = body.get("mint_timing") or {}
    single = dict(mt.get("single_mint") or {})
    last = single.get("last")
    if isinstance(last, dict):
        single["last"] = {
            k: last[k] for k in ("platform_mint_ms", "completed_at_utc") if k in last and last[k] is not None
        } or None
    lbec = mt.get("last_batch_execute_chunk")
    chunk_out: dict[str, Any] | None = None
    if isinstance(lbec, dict):
        chunk_out = {
            k: lbec[k]
            for k in ("last_execute_chunk_wall_ms", "batch_updated_at_utc", "batch_id")
            if k in lbec and lbec[k] is not None
        } or None
    reduced_mt: dict[str, Any] = {
        "pooled_avg_platform_mint_ms": mt.get("pooled_avg_platform_mint_ms"),
        "pooled_sample_count": mt.get("pooled_sample_count"),
        "single_mint": {
            "sample_count": single.get("sample_count"),
            "avg_platform_mint_ms": single.get("avg_platform_mint_ms"),
            "last": single.get("last"),
        },
        "batch_row_mint": {
            "sample_count": (mt.get("batch_row_mint") or {}).get("sample_count"),
            "avg_platform_mint_ms": (mt.get("batch_row_mint") or {}).get("avg_platform_mint_ms"),
        },
        "last_batch_execute_chunk": chunk_out,
    }
    eip = body.get("eip712") or {}
    sm = eip.get("single_mint_authorization_requests") or {}
    eip_reduced = {
        "single_mint_requests_by_status": sm.get("requests_by_status"),
        "single_mint_failed_by_code": sm.get("failed_requests_by_code"),
        "batch_authorizations_recorded": eip.get("batch_authorizations_recorded"),
        "single_mints_completed_via_request_table": eip.get("single_mints_completed_via_request_table"),
    }
    return {
        "generated_at_utc": body.get("generated_at_utc"),
        "scope": body.get("scope"),
        "certificates_by_status": body.get("certificates_by_status"),
        "lifecycle": body.get("lifecycle"),
        "issuance_volume": body.get("issuance_volume"),
        "reissues": body.get("reissues"),
        "eip712": eip_reduced,
        "mint_batches": body.get("mint_batches"),
        "mint_timing": reduced_mt,
    }


_SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, None: 9}


def _reduced_institutions_for_brief(inst_rows: list[dict[str, Any]], cap: int = 50) -> dict[str, Any]:
    status_counts = dict(Counter((r.get("status") or "unknown") for r in inst_rows))
    not_verified = sum(int(n) for st, n in status_counts.items() if st != "verified")

    def sort_key(r: dict[str, Any]) -> tuple[int, int, int]:
        risk = r.get("risk") or {}
        if risk.get("error"):
            return (6, 0, int(r.get("id") or 0))
        sev = risk.get("highest_severity")
        rank = _SEVERITY_RANK.get(sev if sev in _SEVERITY_RANK else None, 5)
        fc = int(risk.get("flag_count") or 0)
        return (rank, -fc, int(r.get("id") or 0))

    ordered = sorted(inst_rows, key=sort_key)
    slim: list[dict[str, Any]] = []
    for r in ordered[:cap]:
        risk = r.get("risk") or {}
        slim.append(
            {
                "id": r.get("id"),
                "name": r.get("name"),
                "internal_id": r.get("internal_id"),
                "status": r.get("status"),
                "certificates_indexed": r.get("certificates_indexed"),
                "activity_events": r.get("activity_events"),
                "mint_batches": r.get("mint_batches"),
                "last_activity_at": r.get("last_activity_at"),
                "risk": {
                    "flag_count": risk.get("flag_count"),
                    "highest_severity": risk.get("highest_severity"),
                    "flag_codes": (risk.get("flag_codes") or [])[:8],
                    "error": risk.get("error"),
                },
            }
        )
    return {
        "total_institutions": len(inst_rows),
        "institutions_in_brief": len(slim),
        "institution_status_counts": status_counts,
        "non_verified_institutions": int(not_verified),
        "institutions_ranked": slim,
    }


def register_admin_analytics_routes(bp: Blueprint) -> None:
    global _api_bp
    _api_bp = bp

    @bp.get("/admin/analytics/summary")
    @jwt_required()
    def admin_analytics_summary():
        _require_admin()
        uni_id = request.args.get("university_id", type=int)
        body, err = _admin_summary_body(uni_id)
        if err:
            return jsonify(body), err
        return jsonify(body)

    @bp.get("/admin/analytics/mints-timeseries")
    @jwt_required()
    def admin_mints_timeseries():
        _require_admin()
        raw = (request.args.get("days") or "30").strip()
        try:
            d = int(raw)
        except Exception:
            d = 30
        if d not in (7, 30, 90):
            d = 30
        uni_id = request.args.get("university_id", type=int)
        scope_id = uni_id if uni_id is not None else None
        return jsonify(analytics_service.mint_timeseries_filled_days(university_id=scope_id, days=d))

    @bp.get("/admin/analytics/mints-by-institution")
    @jwt_required()
    def admin_mints_by_institution():
        _require_admin()
        d = request.args.get("days", type=int) or 30
        d = max(7, min(366, int(d)))
        rows = analytics_service.mints_by_institution_last_days(d)
        return jsonify({"timezone": "UTC", "days": d, "rows": rows})

    @bp.get("/admin/analytics/institutions-overview")
    @jwt_required()
    def admin_institutions_overview():
        _require_admin()
        include_risk = (request.args.get("include_risk") or "true").strip().lower() not in ("0", "false", "no")
        return jsonify(admin_institutions_overview_payload(include_risk))

    @bp.get("/admin/ai/activity-brief")
    @jwt_required()
    def admin_ai_activity_brief():
        _require_admin()
        body, err = _admin_summary_body(None)
        if err or not body:
            return (
                jsonify(
                    {
                        "text": None,
                        "reason": (body or {}).get("error", "analytics_unavailable") if body else "analytics_unavailable",
                        "model": None,
                        "disclaimer": ACTIVITY_BRIEF_DISCLAIMER,
                    }
                ),
                err or 500,
            )

        inst_payload = admin_institutions_overview_payload(include_risk=True)
        inst_rows = list(inst_payload.get("institutions") or [])
        brief_facts = {
            "platform_summary_reduced": _reduced_platform_summary_for_brief(body),
            "institutions_reduced": _reduced_institutions_for_brief(inst_rows),
            "activity_log_counts_by_action_last_7d_utc": analytics_service.activity_counts_by_action_since_days(7),
            "brief_generated_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        out: dict[str, Any] = {
            "text": None,
            "reason": None,
            "model": None,
            "disclaimer": ACTIVITY_BRIEF_DISCLAIMER,
        }

        if not gemini_service.is_configured():
            out["reason"] = "Gemini not configured"
            return jsonify(out), 200

        system_instruction = (
            "You write short operational briefings for TruCert platform administrators. "
            "Use ONLY the JSON facts provided; do not invent numbers, users, or events. "
            "Never include or guess personal identifiers (names of individuals, emails, wallet addresses, token ids). "
            "Do not claim fraud, abuse, illegality, or wrongdoing; use neutral, cautious language. "
            "Reference institutions by id and name from the payload when helpful. "
            "Suggest practical human follow-ups: Admin Analytics, Risk board, reviewing non-verified institutions, "
            "and activity patterns by action type. "
            "This is advisory only; you must not recommend automatic enforcement."
        )
        prompt = (
            "Write a concise operations brief for an admin (6–12 short sentences, plain text paragraphs allowed). "
            "Lead with platform-wide posture (issuance, batches, lifecycle), then notable institution risk signals "
            "(severity / flag density) without dramatizing, then 7-day activity mix by action if useful. "
            "End with 2–4 concrete checks an admin could take next.\n\n"
            + json.dumps(brief_facts, ensure_ascii=False)
        )

        try:
            text = gemini_service.generate_text(prompt, system_instruction=system_instruction)
        except gemini_service.GeminiNotConfiguredError:
            out["reason"] = "Gemini not configured"
            return jsonify(out), 200
        except gemini_service.GeminiError as e:
            out["reason"] = str(e)
            return jsonify(out), 200

        out["text"] = text
        out["reason"] = None
        out["model"] = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()
        return jsonify(out), 200

    @bp.get("/admin/ai/operations-digest")
    @jwt_required()
    def admin_ai_operations_digest():
        _require_admin()
        now = datetime.now(timezone.utc)
        metrics = analytics_service.platform_operations_digest_metrics(now=now)
        out: dict[str, Any] = {
            "metrics": metrics,
            "ai_text": None,
            "ai_error": None,
            "model": None,
        }
        if not gemini_service.is_configured():
            out["ai_error"] = "Gemini not configured"
            return jsonify(out), 200

        system_instruction = (
            "You are an operations analyst for TruCert administrators. "
            "You will receive ONLY a JSON object of aggregate platform metrics (no raw rows, no personal data). "
            "You must ONLY restate numbers and relationships that appear in that JSON—never invent incidents, "
            "entities, or causes. Do not claim fraud, abuse, or proof of wrongdoing; use cautious, neutral wording. "
            "OUTPUT FORMAT (use these exact Markdown headings, each followed by bullet lines starting with '- '):\n"
            "## Today\n"
            "## This week\n"
            "## Transactions\n"
            "## Failures\n"
            "## Risk & anomalies\n"
            "## Timing patterns\n"
            "## Trends\n"
            "Under each heading, 1–4 bullets referencing the relevant metrics keys (e.g. today.activity_by_action.issued). "
            "If a section has no applicable data, use a single bullet stating that counts are zero or not present. "
            "Advisory only; suggest follow-up in Admin Analytics or Risk board where appropriate."
        )
        prompt = "Operations digest metrics (JSON). Produce the briefing.\n\n" + json.dumps(
            metrics, ensure_ascii=False
        )
        try:
            out["ai_text"] = gemini_service.generate_text(prompt, system_instruction=system_instruction)
            out["model"] = (Config.GEMINI_MODEL or "gemini-1.5-flash").strip()
        except gemini_service.GeminiNotConfiguredError:
            out["ai_error"] = "Gemini not configured"
        except gemini_service.GeminiError as e:
            out["ai_error"] = str(e)
        return jsonify(out), 200

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
        uni_filter = request.args.get("university_id", type=int)
        q = MintBatch.query.order_by(MintBatch.id.desc())
        if uni_filter is not None:
            q = q.filter(MintBatch.university_id == uni_filter)
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
