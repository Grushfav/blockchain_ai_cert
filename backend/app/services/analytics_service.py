"""Read-only aggregates for admin and university analytics (DB-backed; not full chain truth)."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import exists, func

from app.analytics_timezone import (
    DISPLAY_TZ_LABEL,
    DISPLAY_ZONE,
    app_day_end_exclusive_utc_naive,
    app_day_start_utc_naive,
    app_month_start_utc_naive,
    app_week_start_monday_utc_naive,
    app_yesterday_start_utc_naive,
    local_weekday_and_hour_from_utc_naive_event,
    to_display_zoned,
)
from app.extensions import db
from app.models import (
    ActivityLog,
    CertificateRecord,
    MintAuthorizationRequest,
    MintBatch,
    MintBatchRow,
    University,
)


def _activity_ts_column():
    """Prefer block time when present (synced on-chain events)."""
    return func.coalesce(ActivityLog.block_timestamp, ActivityLog.created_at)


def _activity_day_bucket_expr(ts_col):
    """Calendar date YYYY-MM-DD in DISPLAY_ZONE for grouping (SQLite vs PostgreSQL)."""
    bind = db.session.get_bind()
    dialect = bind.dialect.name if bind else "sqlite"
    if dialect == "postgresql":
        return func.to_char(
            func.timezone("America/Panama", func.timezone("UTC", ts_col)),
            "YYYY-MM-DD",
        )
    return func.strftime("%Y-%m-%d", func.datetime(ts_col, "-5 hours"))


def issuance_counts_by_window(now: datetime | None = None) -> dict[str, int]:
    """Counts ActivityLog rows with action ``issued`` in each window (calendar day/week/month in UTC-5)."""
    now = now or datetime.utcnow()
    day0 = app_day_start_utc_naive(now)
    week0 = app_week_start_monday_utc_naive(now)
    month0 = app_month_start_utc_naive(now)
    ts = _activity_ts_column()
    q = ActivityLog.query.filter(ActivityLog.action == "issued")
    today = q.filter(ts >= day0).count()
    week = q.filter(ts >= week0).count()
    month = q.filter(ts >= month0).count()
    return {"today": int(today), "this_week": int(week), "this_month": int(month)}


def activity_counts_by_action_since_days(days: int = 7, now: datetime | None = None) -> dict[str, int]:
    """Count ActivityLog rows per ``action`` in the last ``days`` (rolling wall-clock from naive UTC timestamps)."""
    now = now or datetime.utcnow()
    start = now - timedelta(days=max(1, int(days)))
    ts = _activity_ts_column()
    rows = (
        db.session.query(ActivityLog.action, func.count(ActivityLog.id))
        .filter(ts >= start)
        .group_by(ActivityLog.action)
        .all()
    )
    out: dict[str, int] = {str(a or "unknown"): int(n) for a, n in rows}
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


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
    day0 = app_day_start_utc_naive(now)
    week0 = app_week_start_monday_utc_naive(now)
    month0 = app_month_start_utc_naive(now)
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


def _round_ms_optional(v: float | None) -> float | None:
    if v is None:
        return None
    return round(float(v), 1)


def mint_timing_summary(university_id: int | None = None) -> dict[str, Any]:
    """
    Operational mint timing from persisted columns (single MAR + batch rows + last execute chunk).

    ``university_id`` None = platform-wide (admin). Else scoped to that institution.
    """
    mar_base = MintAuthorizationRequest.query.filter(
        MintAuthorizationRequest.status == "minted",
        MintAuthorizationRequest.platform_mint_ms.isnot(None),
    )
    if university_id is not None:
        mar_base = mar_base.filter(MintAuthorizationRequest.university_id == university_id)

    mar_agg = mar_base.with_entities(
        func.count(MintAuthorizationRequest.id),
        func.avg(MintAuthorizationRequest.platform_mint_ms),
        func.sum(MintAuthorizationRequest.platform_mint_ms),
    ).one()
    n_single = int(mar_agg[0] or 0)
    avg_single = mar_agg[1]
    sum_single = int(mar_agg[2] or 0)

    mbr_q = (
        db.session.query(MintBatchRow)
        .join(MintBatch, MintBatchRow.batch_id == MintBatch.id)
        .filter(MintBatchRow.platform_mint_ms.isnot(None))
    )
    if university_id is not None:
        mbr_q = mbr_q.filter(MintBatch.university_id == university_id)

    mbr_agg = mbr_q.with_entities(
        func.count(MintBatchRow.id),
        func.avg(MintBatchRow.platform_mint_ms),
        func.sum(MintBatchRow.platform_mint_ms),
    ).one()
    n_batch_rows = int(mbr_agg[0] or 0)
    avg_batch_row = mbr_agg[1]
    sum_batch_rows = int(mbr_agg[2] or 0)

    total_n = n_single + n_batch_rows
    pooled_avg = None
    if total_n > 0:
        pooled_avg = round((sum_single + sum_batch_rows) / float(total_n), 1)

    last_mar = (
        mar_base.order_by(
            MintAuthorizationRequest.completed_at.desc().nullslast(),
            MintAuthorizationRequest.created_at.desc(),
        ).first()
    )
    last_single_out: dict[str, Any] | None = None
    if last_mar and last_mar.platform_mint_ms is not None:
        last_single_out = {
            "platform_mint_ms": int(last_mar.platform_mint_ms),
            "completed_at_utc": last_mar.completed_at.isoformat() + "Z" if last_mar.completed_at else None,
            "cert_id": last_mar.cert_id,
        }

    bq = MintBatch.query.filter(MintBatch.last_execute_chunk_wall_ms.isnot(None))
    if university_id is not None:
        bq = bq.filter(MintBatch.university_id == university_id)
    last_batch = bq.order_by(MintBatch.updated_at.desc().nullslast(), MintBatch.id.desc()).first()
    last_chunk_out: dict[str, Any] | None = None
    if last_batch and last_batch.last_execute_chunk_wall_ms is not None:
        last_chunk_out = {
            "batch_id": int(last_batch.id),
            "last_execute_chunk_wall_ms": int(last_batch.last_execute_chunk_wall_ms),
            "batch_updated_at_utc": last_batch.updated_at.isoformat() + "Z" if last_batch.updated_at else None,
        }

    return {
        "note": (
            "avg_platform_mint_ms pools single-mint and batch-row samples (server mint+receipt only). "
            "last_execute_chunk_wall_ms is wall time for the most recent batch execute POST that minted at least one row."
        ),
        "pooled_avg_platform_mint_ms": pooled_avg,
        "pooled_sample_count": int(total_n),
        "single_mint": {
            "sample_count": n_single,
            "avg_platform_mint_ms": _round_ms_optional(float(avg_single) if avg_single is not None else None),
            "last": last_single_out,
        },
        "batch_row_mint": {
            "sample_count": n_batch_rows,
            "avg_platform_mint_ms": _round_ms_optional(float(avg_batch_row) if avg_batch_row is not None else None),
        },
        "last_batch_execute_chunk": last_chunk_out,
    }


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


_DIGEST_ACTIONS = ("issued", "transferred", "revoked", "burned", "reissued")


def _digest_naive_utc(now: datetime | None) -> datetime:
    """Normalize to naive UTC for comparisons against typical SQLAlchemy naive datetimes."""
    n = now or datetime.utcnow()
    if n.tzinfo is not None:
        return n.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)
    return n.replace(microsecond=0)


def _mar_touch_ts():
    return func.coalesce(MintAuthorizationRequest.completed_at, MintAuthorizationRequest.created_at)


def _mint_batch_row_touch_ts():
    return func.coalesce(MintBatchRow.minted_at, MintBatchRow.prepared_at, MintBatch.updated_at)


def _activity_by_action_in_range(start: datetime, end: datetime) -> dict[str, int]:
    """ActivityLog counts per action in [start, end] inclusive on coalesced event time."""
    ts = _activity_ts_column()
    rows = (
        db.session.query(ActivityLog.action, func.count(ActivityLog.id))
        .filter(ts >= start, ts <= end)
        .group_by(ActivityLog.action)
        .all()
    )
    out: dict[str, int] = {a: 0 for a in _DIGEST_ACTIONS}
    other = 0
    for act, n in rows:
        key = (act or "").strip() or "unknown"
        if key in out:
            out[key] += int(n)
        else:
            other += int(n)
    out["other"] = int(other)
    return out


def _issued_count_in_range(start: datetime, end: datetime) -> int:
    ts = _activity_ts_column()
    return int(
        ActivityLog.query.filter(
            ActivityLog.action == "issued",
            ts >= start,
            ts <= end,
        ).count()
    )


def _issued_count_half_open(start: datetime, end: datetime) -> int:
    """Issued events in [start, end) on coalesced activity time."""
    ts = _activity_ts_column()
    return int(
        ActivityLog.query.filter(
            ActivityLog.action == "issued",
            ts >= start,
            ts < end,
        ).count()
    )


def _issued_hour_histogram_utc(start: datetime, end: datetime) -> list[int]:
    """24-length array index 0..23 = clock hour in UTC-5 (America/Panama) for ``issued`` only."""
    hist = [0] * 24
    ts_expr = func.coalesce(ActivityLog.block_timestamp, ActivityLog.created_at)
    rows = (
        ActivityLog.query.filter(
            ActivityLog.action == "issued",
            ts_expr >= start,
            ts_expr <= end,
        )
        .with_entities(ActivityLog.block_timestamp, ActivityLog.created_at)
        .all()
    )
    for block_ts, created_at in rows:
        t = block_ts or created_at
        if not t:
            continue
        _wd, hr = local_weekday_and_hour_from_utc_naive_event(t)
        hist[int(hr) % 24] += 1
    return hist


def _mar_failed_count_in_range(start: datetime, end: datetime) -> int:
    mar_ts = _mar_touch_ts()
    return int(
        MintAuthorizationRequest.query.filter(
            MintAuthorizationRequest.status == "failed",
            mar_ts >= start,
            mar_ts <= end,
        ).count()
    )


def _mar_failed_by_code_in_range(start: datetime, end: datetime) -> dict[str, int]:
    mar_ts = _mar_touch_ts()
    fc = func.coalesce(MintAuthorizationRequest.failure_code, "unknown")
    rows = (
        db.session.query(fc, func.count(MintAuthorizationRequest.id))
        .filter(
            MintAuthorizationRequest.status == "failed",
            mar_ts >= start,
            mar_ts <= end,
        )
        .group_by(fc)
        .all()
    )
    out: dict[str, int] = {}
    for code, n in rows:
        k = (str(code) if code is not None else "unknown").strip() or "unknown"
        out[k] = int(n)
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def _mint_batch_row_mint_failed_count_in_range(start: datetime, end: datetime) -> int:
    """
    Rows with ``row_status == mint_failed`` whose touch time falls in the window.

    Touch time = ``coalesce(minted_at, prepared_at, batch.updated_at)`` (operational proxy for
    when the failure was observed or last batch activity).
    """
    touch = _mint_batch_row_touch_ts()
    return int(
        db.session.query(func.count(MintBatchRow.id))
        .join(MintBatch, MintBatchRow.batch_id == MintBatch.id)
        .filter(
            MintBatchRow.row_status == "mint_failed",
            touch >= start,
            touch <= end,
        )
        .scalar()
        or 0
    )


def _platform_risk_flag_aggregates(as_of_utc: datetime) -> tuple[dict[str, int], int]:
    """Count individual risk flags by severity across all institutions; second value = unis with ≥1 flag."""
    from app.services import risk_hints_service

    if as_of_utc.tzinfo is None:
        as_of = as_of_utc.replace(tzinfo=timezone.utc)
    else:
        as_of = as_of_utc.astimezone(timezone.utc)

    sev_ctr: Counter[str] = Counter()
    inst_with_any = 0
    for u in University.query.order_by(University.id.asc()).all():
        try:
            metrics = risk_hints_service.compute_metrics(
                int(u.id),
                as_of=as_of,
                current_days=7,
                reference_days=90,
            )
            flags = risk_hints_service.compute_flags(metrics)
            if flags:
                inst_with_any += 1
            for f in flags:
                s = (f.get("severity") or "unknown").strip().lower() or "unknown"
                sev_ctr[s] += 1
        except Exception:
            continue
    return dict(sorted(sev_ctr.items(), key=lambda kv: (-kv[1], kv[0]))), int(inst_with_any)


def _high_mint_failed_batches_for_window(
    window_start: datetime,
    window_end: datetime,
    *,
    min_failed: int = 3,
    min_rate: float = 0.25,
    min_rows: int = 5,
    cap: int = 25,
) -> list[dict[str, Any]]:
    """
    Batches whose *current* row_status snapshot shows elevated ``mint_failed`` share, and that
    were touched in the rolling window (batch.updated_at or any mint_failed row touch time).
    """
    touch = _mint_batch_row_touch_ts()
    ids_from_rows = {
        int(r[0])
        for r in db.session.query(MintBatchRow.batch_id)
        .join(MintBatch, MintBatchRow.batch_id == MintBatch.id)
        .filter(
            MintBatchRow.row_status == "mint_failed",
            touch >= window_start,
            touch <= window_end,
        )
        .distinct()
        .limit(400)
        .all()
        if r[0] is not None
    }
    ids_from_batch_updates = {
        int(r[0])
        for r in db.session.query(MintBatch.id)
        .filter(
            MintBatch.updated_at >= window_start,
            MintBatch.updated_at <= window_end,
        )
        .limit(400)
        .all()
        if r[0] is not None
    }
    ids = list(ids_from_rows | ids_from_batch_updates)
    out: list[dict[str, Any]] = []
    for bid in ids:
        if len(out) >= cap:
            break
        b = db.session.get(MintBatch, bid)
        if not b:
            continue
        bd = mint_batch_row_breakdown(bid)
        failed = int(bd.get("mint_failed", 0))
        denom = int(b.valid_rows or b.total_rows or 0)
        if denom < min_rows:
            continue
        rate = float(failed) / float(max(1, denom))
        if failed < min_failed or rate < min_rate:
            continue
        out.append(
            {
                "batch_id": int(b.id),
                "university_id": int(b.university_id),
                "mint_failed_rows": failed,
                "denominator_valid_rows": denom,
                "mint_failed_rate": round(rate, 4),
            }
        )
    return out


def _failures_bundle(start: datetime, end: datetime) -> dict[str, Any]:
    return {
        "mint_authorization_requests_failed": _mar_failed_count_in_range(start, end),
        "mint_batch_rows_mint_failed_touched": _mint_batch_row_mint_failed_count_in_range(start, end),
        "eip712_single_mint_failed_by_code": _mar_failed_by_code_in_range(start, end),
    }


def _trend_issued_bundle(now_naive: datetime) -> dict[str, Any]:
    day0 = app_day_start_utc_naive(now_naive)
    y0 = app_yesterday_start_utc_naive(now_naive)
    issued_today = _issued_count_in_range(day0, now_naive)
    issued_yesterday = _issued_count_half_open(y0, day0)
    w0 = now_naive - timedelta(days=7)
    w1 = now_naive - timedelta(days=14)
    issued_7d = _issued_count_in_range(w0, now_naive)
    issued_prev_7d = _issued_count_half_open(w1, w0)
    return {
        "issued_today_utc_day_to_now": int(issued_today),
        "issued_yesterday_full_utc_day": int(issued_yesterday),
        "issued_delta_today_minus_yesterday": int(issued_today - issued_yesterday),
        "issued_rolling_7d": int(issued_7d),
        "issued_prior_7d": int(issued_prev_7d),
        "issued_delta_last_7d_minus_prior_7d": int(issued_7d - issued_prev_7d),
    }


def mint_timeseries_filled_days(
    university_id: int | None,
    days: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Daily ``issued`` ActivityLog counts in UTC-5 calendar days (bucket = local date of coalesced UTC time).

    ``days`` must be 7, 30, or 90 (others clamped to 30). Series covers ``days`` consecutive local days
    ending on the current local calendar day, with missing days as count 0.
    """
    d = int(days)
    if d not in (7, 30, 90):
        d = 30
    now_naive = _digest_naive_utc(now)
    z_now = to_display_zoned(now_naive)
    local_end_date = z_now.date()
    local_start_date = local_end_date - timedelta(days=d - 1)
    ts_lo = datetime.combine(local_start_date, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(
        tzinfo=None
    )
    ts_hi = app_day_end_exclusive_utc_naive(now_naive)
    ts = _activity_ts_column()
    day_bucket = _activity_day_bucket_expr(ts)
    q = (
        db.session.query(day_bucket, func.count(ActivityLog.id))
        .filter(
            ActivityLog.action == "issued",
            ts >= ts_lo,
            ts < ts_hi,
        )
    )
    if university_id is not None:
        q = q.filter(ActivityLog.university_id == university_id)
    rows = q.group_by(day_bucket).all()
    counts: dict[str, int] = {}
    for dkey, n in rows:
        if dkey is None:
            continue
        if hasattr(dkey, "isoformat"):
            ds = dkey.isoformat()
        else:
            ds = str(dkey).strip()[:10]
        counts[str(ds)] = int(n)

    series: list[dict[str, Any]] = []
    cur = local_start_date
    for _ in range(d):
        ds = cur.isoformat()
        series.append({"date": ds, "count": counts.get(ds, 0)})
        cur = cur + timedelta(days=1)
    total = sum(int(x["count"]) for x in series)
    return {
        "timezone": DISPLAY_TZ_LABEL,
        "days": d,
        "university_id": university_id,
        "series": series,
        "total_mints": int(total),
    }


def mint_heatmap_weekday_hour_utc(
    university_id: int,
    days: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Sparse heatmap cells for ``issued`` events: ``weekday`` Monday=0..Sunday=6, ``hour`` 0–23 in UTC-5,
    from coalesce(block_timestamp, created_at). ``days`` is 30 or 90 (default 90).
    """
    d = int(days)
    if d not in (30, 90):
        d = 90
    now_naive = _digest_naive_utc(now)
    z_now = to_display_zoned(now_naive)
    local_end_date = z_now.date()
    local_start_date = local_end_date - timedelta(days=d - 1)
    ts_lo = datetime.combine(local_start_date, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(
        tzinfo=None
    )
    ts_hi = app_day_end_exclusive_utc_naive(now_naive)
    ts = _activity_ts_column()
    rows = (
        ActivityLog.query.filter(
            ActivityLog.action == "issued",
            ActivityLog.university_id == university_id,
            ts >= ts_lo,
            ts < ts_hi,
        )
        .with_entities(ActivityLog.block_timestamp, ActivityLog.created_at)
        .all()
    )
    cells_map: dict[tuple[int, int], int] = {}
    for block_ts, created_at in rows:
        t = block_ts or created_at
        if not t:
            continue
        wd, hr = local_weekday_and_hour_from_utc_naive_event(t)
        k = (wd, hr)
        cells_map[k] = cells_map.get(k, 0) + 1
    cells = [{"weekday": wd, "hour": hr, "count": c} for (wd, hr), c in sorted(cells_map.items())]
    return {
        "timezone": DISPLAY_TZ_LABEL,
        "days": d,
        "university_id": university_id,
        "weekday_note": f"weekday is Monday=0 through Sunday=6 in {DISPLAY_TZ_LABEL} (from coalesced event time).",
        "hour_note": f"hour is 0–23 in {DISPLAY_TZ_LABEL}.",
        "cells": cells,
    }


def mints_by_institution_last_days(days: int, now: datetime | None = None) -> list[dict[str, Any]]:
    """Per-institution ``issued`` counts in the last ``days`` UTC-5 calendar days (inclusive of today local)."""
    d = int(days)
    d = max(7, min(366, d))
    now_naive = _digest_naive_utc(now)
    z_now = to_display_zoned(now_naive)
    local_end_date = z_now.date()
    local_start_date = local_end_date - timedelta(days=d - 1)
    ts_lo = datetime.combine(local_start_date, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(
        tzinfo=None
    )
    ts_hi = app_day_end_exclusive_utc_naive(now_naive)
    ts = _activity_ts_column()
    rows = (
        db.session.query(ActivityLog.university_id, func.count(ActivityLog.id))
        .filter(
            ActivityLog.action == "issued",
            ActivityLog.university_id.isnot(None),
            ts >= ts_lo,
            ts < ts_hi,
        )
        .group_by(ActivityLog.university_id)
        .order_by(func.count(ActivityLog.id).desc())
        .all()
    )
    uni_ids = [int(uid) for uid, _ in rows if uid is not None]
    names: dict[int, tuple[str, str]] = {}
    if uni_ids:
        for u in University.query.filter(University.id.in_(uni_ids)).all():
            names[int(u.id)] = (u.name or "", u.internal_id or "")
    out: list[dict[str, Any]] = []
    for uid, cnt in rows:
        if uid is None:
            continue
        name, internal_id = names.get(int(uid), ("", ""))
        out.append(
            {
                "university_id": int(uid),
                "name": name,
                "internal_id": internal_id,
                "count": int(cnt),
            }
        )
    return out


def platform_operations_digest_metrics(*, now: datetime | None = None) -> dict[str, Any]:
    """
    Platform-wide aggregates for admin operations digest (no PII, no per-student fields).

    Windows (DB timestamps are naive UTC; reporting day boundaries use UTC-5 / America/Panama):
    - ``today``: inclusive from local calendar day 00:00 through ``now``.
    - ``rolling_7d``: inclusive ``now - 7 days`` through ``now`` (rolling 168h, not ISO week).
    """
    now_naive = _digest_naive_utc(now)
    day0 = app_day_start_utc_naive(now_naive)
    week0 = now_naive - timedelta(days=7)

    today_start, today_end = day0, now_naive
    roll_start, roll_end = week0, now_naive

    as_of_for_risk = now_naive.replace(tzinfo=timezone.utc)
    risk_by_sev, inst_with_flags = _platform_risk_flag_aggregates(as_of_for_risk)
    high_batches = _high_mint_failed_batches_for_window(week0, now_naive)

    trends = _trend_issued_bundle(now_naive)
    prior_7 = int(trends.get("issued_prior_7d") or 0)
    last_7 = int(trends.get("issued_rolling_7d") or 0)
    spike_week = bool(prior_7 > 0 and last_7 >= int(prior_7 * 1.5) + 5)

    return {
        "documentation": {
            "activity_log_event_time": "coalesce(block_timestamp, created_at) for ActivityLog filters and histograms.",
            "utc5_today_window": f"[{DISPLAY_TZ_LABEL} calendar day 00:00, now] inclusive on coalesced UTC-stored time.",
            "rolling_7d_window": "[now - 7 calendar days, now] inclusive (not ISO week).",
            "trend_yesterday_mints": f"[previous {DISPLAY_TZ_LABEL} day 00:00, today 00:00) half-open on coalesced time.",
            "trend_prior_7d_mints": "[now-14d, now-7d) half-open vs [now-7d, now] for issued counts.",
            "mar_failed_time": "coalesce(completed_at, created_at) for MintAuthorizationRequest status=failed.",
            "mint_failed_row_touch_time": (
                "coalesce(MintBatchRow.minted_at, MintBatchRow.prepared_at, MintBatch.updated_at) "
                "for row_status=mint_failed."
            ),
            "risk_flags": "Per-institution risk_hints flags (7d current vs 90d reference) counted by severity.",
        },
        "computed_at_utc": now_naive.isoformat() + "Z",
        "today": {
            "activity_by_action": _activity_by_action_in_range(today_start, today_end),
            "failures": _failures_bundle(today_start, today_end),
            "issued_mint_hour_histogram_utc": _issued_hour_histogram_utc(today_start, today_end),
        },
        "rolling_7d": {
            "activity_by_action": _activity_by_action_in_range(roll_start, roll_end),
            "failures": _failures_bundle(roll_start, roll_end),
            "issued_mint_hour_histogram_utc": _issued_hour_histogram_utc(roll_start, roll_end),
        },
        "trends": trends,
        "attention": {
            "risk_flags_by_severity": risk_by_sev,
            "institutions_with_any_risk_flag": inst_with_flags,
            "batches_high_mint_failed_rolling_7d": high_batches,
            "batches_high_mint_failed_count": len(high_batches),
            "signals_v1": {
                "issued_week_up_vs_prior_50pct_and_min5": spike_week,
            },
        },
    }


_MAX_MS_SANE = 600_000  # 10 minutes — drop pathological samples


def _ms_percentile_band(samples: list[int]) -> dict[str, Any]:
    vals = sorted(int(x) for x in samples if x is not None and 0 < int(x) <= _MAX_MS_SANE)
    n = len(vals)
    if n == 0:
        return {"n": 0, "p50_ms": None, "p90_ms": None}

    def _pct(q: float) -> int:
        if n == 1:
            return int(vals[0])
        pos = (n - 1) * q
        lo_i = int(pos)
        hi_i = min(lo_i + 1, n - 1)
        frac = pos - lo_i
        return int(round(vals[lo_i] + (vals[hi_i] - vals[lo_i]) * frac))

    return {"n": n, "p50_ms": _pct(0.5), "p90_ms": _pct(0.9)}


def global_mint_time_percentiles() -> dict[str, Any]:
    """
    Platform-wide mint timing bands (no PII; suitable for a public JSON endpoint).

    Uses recent samples only. p50 / p90 describe typical vs heavier-tail waits on-platform;
    wallet signing and RPC variance are not fully captured.
    """
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    mar_rows = (
        db.session.query(MintAuthorizationRequest.platform_mint_ms)
        .filter(
            MintAuthorizationRequest.status == "minted",
            MintAuthorizationRequest.platform_mint_ms.isnot(None),
        )
        .order_by(
            MintAuthorizationRequest.completed_at.desc().nullslast(),
            MintAuthorizationRequest.id.desc(),
        )
        .limit(400)
        .all()
    )
    mar_ms = [int(r[0]) for r in mar_rows]

    mbr_rows = (
        db.session.query(MintBatchRow.platform_mint_ms)
        .filter(MintBatchRow.platform_mint_ms.isnot(None))
        .order_by(MintBatchRow.minted_at.desc().nullslast(), MintBatchRow.id.desc())
        .limit(600)
        .all()
    )
    mbr_ms = [int(r[0]) for r in mbr_rows]

    chunk_rows = (
        db.session.query(MintBatch.last_execute_chunk_wall_ms)
        .filter(MintBatch.last_execute_chunk_wall_ms.isnot(None))
        .order_by(MintBatch.updated_at.desc().nullslast(), MintBatch.id.desc())
        .limit(200)
        .all()
    )
    chunk_ms = [int(r[0]) for r in chunk_rows]

    return {
        "computed_at_utc": now,
        "default_execute_max_mints": 40,
        "documentation": {
            "single_mint_platform": (
                "Milliseconds from authorization verify through mint receipt (minted rows only). "
                "Does not include wallet signing time."
            ),
            "batch_row_platform": (
                "Per-row server segment (often receipt-heavy). Batch execute runs many rows per HTTP POST; "
                "see execute_chunk_wall for how long one execute click tends to take."
            ),
            "execute_chunk_wall": (
                "Wall time for the last batch execute request (partial or full chunk). Chunk size varies "
                "(UI default 40, server allows up to 80 mints per request)."
            ),
        },
        "note": (
            "This data was collected from recent mints on the platform."
        ),
        "single_mint_platform": _ms_percentile_band(mar_ms),
        "batch_row_platform": _ms_percentile_band(mbr_ms),
        "execute_chunk_wall": _ms_percentile_band(chunk_ms),
    }
