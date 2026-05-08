"""Read-only aggregates for admin and university analytics (DB-backed; not full chain truth)."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import exists, func

from app.extensions import db
from app.models import ActivityLog, CertificateRecord, MintAuthorizationRequest, MintBatch, MintBatchRow, University


def _utc_day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _utc_week_start_monday(now: datetime) -> datetime:
    d0 = _utc_day_start(now)
    return d0 - timedelta(days=d0.weekday())


def _utc_month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _activity_ts_column():
    """Prefer block time when present (synced on-chain events)."""
    return func.coalesce(ActivityLog.block_timestamp, ActivityLog.created_at)


def issuance_counts_by_window(now: datetime | None = None) -> dict[str, int]:
    """Counts ActivityLog rows with action ``issued`` in each window (UTC)."""
    now = now or datetime.utcnow()
    day0 = _utc_day_start(now)
    week0 = _utc_week_start_monday(now)
    month0 = _utc_month_start(now)
    ts = _activity_ts_column()
    q = ActivityLog.query.filter(ActivityLog.action == "issued")
    today = q.filter(ts >= day0).count()
    week = q.filter(ts >= week0).count()
    month = q.filter(ts >= month0).count()
    return {"today": int(today), "this_week": int(week), "this_month": int(month)}


def certificate_status_counts() -> dict[str, int]:
    rows = (
        db.session.query(CertificateRecord.status, func.count(CertificateRecord.id))
        .group_by(CertificateRecord.status)
        .all()
    )
    out: dict[str, int] = {}
    for st, c in rows:
        key = (st or "").lower() or "unknown"
        out[key] = int(c)
    return out


def lifecycle_claim_subset() -> dict[str, Any]:
    """
    ``issued`` rows split by whether a ``transferred`` (claim) event exists for the token.
    Claim rate = claimed_locked / max(1, issued_total).
    """
    issued_total = CertificateRecord.query.filter_by(status="issued").count()
    transferred_exists = exists().where(
        ActivityLog.token_id == CertificateRecord.token_id,
        ActivityLog.action == "transferred",
    )
    claimed_locked = CertificateRecord.query.filter(
        CertificateRecord.status == "issued",
        transferred_exists,
    ).count()
    issued_unclaimed = max(0, int(issued_total) - int(claimed_locked))
    rate = float(claimed_locked) / float(issued_total) if issued_total else 0.0
    return {
        "issued_total": int(issued_total),
        "claimed_locked": int(claimed_locked),
        "issued_unclaimed": int(issued_unclaimed),
        "claim_rate": round(rate, 4),
    }


def reissue_counts() -> dict[str, int]:
    reissued_events = ActivityLog.query.filter_by(action="reissued").count()
    reissued_tokens = CertificateRecord.query.filter_by(status="reissued").count()
    return {
        "reissue_events": int(reissued_events),
        "certificates_marked_reissued": int(reissued_tokens),
    }


def eip712_single_mint_summary() -> dict[str, Any]:
    rows = (
        db.session.query(MintAuthorizationRequest.status, func.count(MintAuthorizationRequest.id))
        .group_by(MintAuthorizationRequest.status)
        .all()
    )
    by_status: dict[str, int] = {str(st or ""): int(n) for st, n in rows}
    fc_rows = (
        db.session.query(MintAuthorizationRequest.failure_code, func.count(MintAuthorizationRequest.id))
        .filter(MintAuthorizationRequest.status == "failed")
        .group_by(MintAuthorizationRequest.failure_code)
        .all()
    )
    failures_by_code: dict[str, int] = {}
    for code, n in fc_rows:
        k = (code or "unknown").strip() or "unknown"
        failures_by_code[k] = int(n)
    return {
        "requests_by_status": by_status,
        "failed_requests_by_code": failures_by_code,
    }


def batch_signature_count() -> int:
    """Batches that have recorded an EIP-712 authorization signature."""
    return int(
        MintBatch.query.filter(
            MintBatch.authorized_signature_hex.isnot(None),
            MintBatch.authorized_signature_hex != "",
        ).count()
    )


def mint_batch_row_breakdown(batch_id: int) -> dict[str, int]:
    rows = db.session.query(MintBatchRow.row_status).filter(MintBatchRow.batch_id == batch_id).all()
    ctr: Counter[str] = Counter((r[0] or "").strip() for r in rows)
    return dict(ctr)


def mint_batch_last_tx(batch_id: int) -> str | None:
    row = (
        MintBatchRow.query.filter_by(batch_id=batch_id)
        .filter(MintBatchRow.tx_hash.isnot(None), MintBatchRow.tx_hash != "")
        .order_by(MintBatchRow.id.desc())
        .first()
    )
    if not row or not (row.tx_hash or "").strip():
        return None
    return (row.tx_hash or "").strip()


# --- University-scoped (same semantics as global helpers; filtered by ``university_id``) ---


def issuance_counts_by_window_for_university(university_id: int, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.utcnow()
    day0 = _utc_day_start(now)
    week0 = _utc_week_start_monday(now)
    month0 = _utc_month_start(now)
    ts = _activity_ts_column()
    q = ActivityLog.query.filter(
        ActivityLog.action == "issued",
        ActivityLog.university_id == university_id,
    )
    today = q.filter(ts >= day0).count()
    week = q.filter(ts >= week0).count()
    month = q.filter(ts >= month0).count()
    return {"today": int(today), "this_week": int(week), "this_month": int(month)}


def certificate_status_counts_for_university(university_id: int) -> dict[str, int]:
    rows = (
        db.session.query(CertificateRecord.status, func.count(CertificateRecord.id))
        .filter(CertificateRecord.university_id == university_id)
        .group_by(CertificateRecord.status)
        .all()
    )
    out: dict[str, int] = {}
    for st, c in rows:
        key = (st or "").lower() or "unknown"
        out[key] = int(c)
    return out


def lifecycle_claim_subset_for_university(university_id: int) -> dict[str, Any]:
    issued_total = CertificateRecord.query.filter_by(
        university_id=university_id,
        status="issued",
    ).count()
    transferred_exists = exists().where(
        ActivityLog.token_id == CertificateRecord.token_id,
        ActivityLog.action == "transferred",
        ActivityLog.university_id == university_id,
    )
    claimed_locked = CertificateRecord.query.filter(
        CertificateRecord.university_id == university_id,
        CertificateRecord.status == "issued",
        transferred_exists,
    ).count()
    issued_unclaimed = max(0, int(issued_total) - int(claimed_locked))
    rate = float(claimed_locked) / float(issued_total) if issued_total else 0.0
    return {
        "issued_total": int(issued_total),
        "claimed_locked": int(claimed_locked),
        "issued_unclaimed": int(issued_unclaimed),
        "claim_rate": round(rate, 4),
    }


def reissue_counts_for_university(university_id: int) -> dict[str, int]:
    reissued_events = ActivityLog.query.filter_by(
        university_id=university_id,
        action="reissued",
    ).count()
    reissued_tokens = CertificateRecord.query.filter_by(
        university_id=university_id,
        status="reissued",
    ).count()
    return {
        "reissue_events": int(reissued_events),
        "certificates_marked_reissued": int(reissued_tokens),
    }


def eip712_single_mint_summary_for_university(university_id: int) -> dict[str, Any]:
    rows = (
        db.session.query(MintAuthorizationRequest.status, func.count(MintAuthorizationRequest.id))
        .filter(MintAuthorizationRequest.university_id == university_id)
        .group_by(MintAuthorizationRequest.status)
        .all()
    )
    by_status: dict[str, int] = {str(st or ""): int(n) for st, n in rows}
    fc_rows = (
        db.session.query(MintAuthorizationRequest.failure_code, func.count(MintAuthorizationRequest.id))
        .filter(
            MintAuthorizationRequest.university_id == university_id,
            MintAuthorizationRequest.status == "failed",
        )
        .group_by(MintAuthorizationRequest.failure_code)
        .all()
    )
    failures_by_code: dict[str, int] = {}
    for code, n in fc_rows:
        k = (code or "unknown").strip() or "unknown"
        failures_by_code[k] = int(n)
    return {
        "requests_by_status": by_status,
        "failed_requests_by_code": failures_by_code,
    }


def batch_signature_count_for_university(university_id: int) -> int:
    return int(
        MintBatch.query.filter(
            MintBatch.university_id == university_id,
            MintBatch.authorized_signature_hex.isnot(None),
            MintBatch.authorized_signature_hex != "",
        ).count()
    )


def serialize_batch_list_item(b: MintBatch, uni: University | None) -> dict[str, Any]:
    breakdown = mint_batch_row_breakdown(b.id)
    minted = sum(
        breakdown.get(k, 0)
        for k in ("mint_confirmed", "email_sent", "email_failed")
    )
    failed = int(breakdown.get("mint_failed", 0))
    invalid = int(breakdown.get("invalid", 0))
    last_tx = mint_batch_last_tx(b.id)
    return {
        "id": b.id,
        "university_id": b.university_id,
        "university_name": uni.name if uni else None,
        "status": b.status,
        "original_filename": b.original_filename,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
        "total_rows": b.total_rows,
        "snapshot_valid_rows": b.valid_rows,
        "snapshot_invalid_rows": b.invalid_rows,
        "rows_by_status": breakdown,
        "rows_minted_terminal": minted,
        "rows_mint_failed": failed,
        "rows_invalid": invalid,
        "last_tx_hash": last_tx,
        "batch_authorized": bool((b.authorized_signature_hex or "").strip()),
    }
