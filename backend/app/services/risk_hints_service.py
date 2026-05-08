"""Deterministic fraud/anomaly hinting (operational hints only; no enforcement).

This module computes per-university aggregates and applies simple threshold rules to emit
structured flags. Gemini (if enabled) may be used by API routes to generate an OPTIONAL
narrative from these precomputed flags/metrics only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import func

from app.extensions import db
from app.models import ActivityLog, MintAuthorizationRequest, MintBatch, MintBatchRow

Severity = Literal["low", "medium", "high"]


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _coalesced_activity_ts():
    """Prefer block time when present (synced on-chain events)."""
    return func.coalesce(ActivityLog.block_timestamp, ActivityLog.created_at)


def _window_bounds(as_of: datetime, days: int) -> tuple[datetime, datetime]:
    end = _utc(as_of)
    start = end - timedelta(days=int(days))
    return start, end


def _daily_bucket(dt: datetime) -> str:
    d = _utc(dt).date()
    return d.isoformat()


def _hour_of_week(dt: datetime) -> int:
    t = _utc(dt)
    return int(t.weekday()) * 24 + int(t.hour)


def _safe_rate(n: int, d: int) -> float:
    return float(n) / float(max(1, int(d)))


def _severity_from_ratio(r: float, *, low: float, medium: float, high: float) -> Severity | None:
    if r >= high:
        return "high"
    if r >= medium:
        return "medium"
    if r >= low:
        return "low"
    return None


@dataclass(frozen=True)
class Windows:
    current_start: datetime
    current_end: datetime
    reference_start: datetime
    reference_end: datetime


def compute_windows(
    *,
    as_of: datetime,
    current_days: int = 7,
    reference_days: int = 90,
) -> Windows:
    current_start, current_end = _window_bounds(as_of, current_days)
    reference_end = current_start
    reference_start = reference_end - timedelta(days=int(reference_days))
    return Windows(
        current_start=current_start,
        current_end=current_end,
        reference_start=reference_start,
        reference_end=reference_end,
    )


def issued_daily_series(university_id: int, *, start: datetime, end: datetime) -> dict[str, int]:
    """Daily issued counts in [start, end) as {YYYY-MM-DD: count}."""
    ts = _coalesced_activity_ts()
    rows = (
        db.session.query(ts)
        .filter(
            ActivityLog.university_id == university_id,
            ActivityLog.action == "issued",
            ts >= start,
            ts < end,
        )
        .all()
    )
    out: dict[str, int] = {}
    for (dt,) in rows:
        if not dt:
            continue
        k = _daily_bucket(dt)
        out[k] = out.get(k, 0) + 1
    return out


def issued_hour_of_week_hist(university_id: int, *, start: datetime, end: datetime) -> dict[int, int]:
    """Histogram for issued events in [start, end): {0..167: count}."""
    ts = _coalesced_activity_ts()
    rows = (
        db.session.query(ts)
        .filter(
            ActivityLog.university_id == university_id,
            ActivityLog.action == "issued",
            ts >= start,
            ts < end,
        )
        .all()
    )
    out: dict[int, int] = {}
    for (dt,) in rows:
        if not dt:
            continue
        h = _hour_of_week(dt)
        out[h] = out.get(h, 0) + 1
    return out


def count_activity(university_id: int, action: str, *, start: datetime, end: datetime) -> int:
    ts = _coalesced_activity_ts()
    return int(
        ActivityLog.query.filter(
            ActivityLog.university_id == university_id,
            ActivityLog.action == action,
            ts >= start,
            ts < end,
        ).count()
    )


def single_mint_status_counts(university_id: int, *, start: datetime, end: datetime) -> dict[str, int]:
    """MintAuthorizationRequest counts by status in [start, end) (created_at-based)."""
    rows = (
        db.session.query(MintAuthorizationRequest.status, func.count(MintAuthorizationRequest.id))
        .filter(
            MintAuthorizationRequest.university_id == university_id,
            MintAuthorizationRequest.created_at >= start,
            MintAuthorizationRequest.created_at < end,
        )
        .group_by(MintAuthorizationRequest.status)
        .all()
    )
    return {str(st or "unknown"): int(n) for st, n in rows}


def batch_failed_ratio(university_id: int, *, start: datetime, end: datetime) -> dict[str, Any]:
    """
    Fraction of mint_failed rows among all rows in batches updated in [start, end).
    Uses MintBatch.updated_at to approximate recent batch activity.
    """
    batch_ids = [
        int(bid)
        for (bid,) in db.session.query(MintBatch.id)
        .filter(
            MintBatch.university_id == university_id,
            MintBatch.updated_at >= start,
            MintBatch.updated_at < end,
        )
        .all()
    ]
    if not batch_ids:
        return {"batches_considered": 0, "rows_considered": 0, "mint_failed_rows": 0, "mint_failed_ratio": 0.0}

    rows_considered = int(MintBatchRow.query.filter(MintBatchRow.batch_id.in_(batch_ids)).count())
    failed_rows = int(
        MintBatchRow.query.filter(
            MintBatchRow.batch_id.in_(batch_ids),
            MintBatchRow.row_status == "mint_failed",
        ).count()
    )
    return {
        "batches_considered": int(len(batch_ids)),
        "rows_considered": rows_considered,
        "mint_failed_rows": failed_rows,
        "mint_failed_ratio": round(_safe_rate(failed_rows, rows_considered), 4),
    }


def compute_metrics(
    university_id: int,
    *,
    as_of: datetime,
    current_days: int = 7,
    reference_days: int = 90,
) -> dict[str, Any]:
    w = compute_windows(as_of=as_of, current_days=current_days, reference_days=reference_days)

    issued_current_series = issued_daily_series(university_id, start=w.current_start, end=w.current_end)
    issued_reference_series = issued_daily_series(university_id, start=w.reference_start, end=w.reference_end)

    issued_current_total = int(sum(issued_current_series.values()))
    issued_reference_total = int(sum(issued_reference_series.values()))
    ref_mean_per_day = float(issued_reference_total) / float(max(1, reference_days))

    revoked_current = count_activity(university_id, "revoked", start=w.current_start, end=w.current_end)
    revoked_reference = count_activity(university_id, "revoked", start=w.reference_start, end=w.reference_end)
    revoke_rate_current = round(_safe_rate(revoked_current, max(1, issued_current_total)), 4)

    single_current = single_mint_status_counts(university_id, start=w.current_start, end=w.current_end)
    failed_single = int(single_current.get("failed", 0))
    minted_single = int(single_current.get("minted", 0))
    pending_single = int(single_current.get("pending", 0))
    single_total = failed_single + minted_single + pending_single
    failed_single_ratio = round(_safe_rate(failed_single, single_total), 4)

    batch_current = batch_failed_ratio(university_id, start=w.current_start, end=w.current_end)

    how_current = issued_hour_of_week_hist(university_id, start=w.current_start, end=w.current_end)
    how_reference = issued_hour_of_week_hist(university_id, start=w.reference_start, end=w.reference_end)

    return {
        "computed_at": _utc(as_of).isoformat(),
        "windows": {
            "current": {
                "start": w.current_start.isoformat(),
                "end": w.current_end.isoformat(),
                "days": int(current_days),
            },
            "reference": {
                "start": w.reference_start.isoformat(),
                "end": w.reference_end.isoformat(),
                "days": int(reference_days),
            },
        },
        "mint_velocity": {
            "issued_daily_series": issued_current_series,
            "issued_current_total": issued_current_total,
            "issued_reference_total": issued_reference_total,
            "reference_mean_per_day": round(ref_mean_per_day, 4),
        },
        "revoke": {
            "revoked_current": revoked_current,
            "revoked_reference": revoked_reference,
            "revoke_rate_current": revoke_rate_current,
        },
        "single_mint_auth": {
            "current_status_counts": single_current,
            "failed_ratio_current": failed_single_ratio,
            "current_total": int(single_total),
        },
        "batch": batch_current,
        "issued_hour_of_week": {
            "current_hist": how_current,
            "reference_hist": how_reference,
        },
    }


def _top_bucket_share(hist: dict[int, int]) -> float:
    total = sum(hist.values())
    if total <= 0:
        return 0.0
    m = max(hist.values()) if hist else 0
    return float(m) / float(total)


def _emit_flag(
    out: list[dict[str, Any]],
    *,
    code: str,
    severity: Severity,
    detail: str,
    metrics_snapshot: dict[str, Any],
) -> None:
    out.append(
        {
            "code": code,
            "severity": severity,
            "detail": detail,
            "metrics_snapshot": metrics_snapshot,
        }
    )


def compute_flags(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Deterministic rules over metrics; unit-testable.

    Notes on thresholds:
    - We prefer conservative thresholds to avoid noisy accusations.
    - Flags are operational hints only; not proof of fraud.
    """
    flags: list[dict[str, Any]] = []

    mv = metrics.get("mint_velocity") or {}
    issued_cur = int(mv.get("issued_current_total") or 0)
    ref_mean = float(mv.get("reference_mean_per_day") or 0.0)
    cur_days = int(((metrics.get("windows") or {}).get("current") or {}).get("days") or 7)

    # Mint velocity spike: current total > max(20, 3x reference mean/day * days).
    expected = ref_mean * float(max(1, cur_days))
    spike_thresh = max(20.0, 3.0 * expected)
    if issued_cur >= int(spike_thresh) and issued_cur >= 30:
        sev: Severity = "medium" if issued_cur < 6 * expected else "high"
        _emit_flag(
            flags,
            code="MINT_VELOCITY_SPIKE",
            severity=sev,
            detail=f"Issuance volume in current window is elevated ({issued_cur} vs expected≈{expected:.1f}).",
            metrics_snapshot={"issued_current_total": issued_cur, "expected": round(expected, 2), "days": cur_days},
        )

    # Revoke spike: revoked_current >= max(3, 2x revoked_reference * current/reference).
    rv = metrics.get("revoke") or {}
    revoked_cur = int(rv.get("revoked_current") or 0)
    revoked_ref = int(rv.get("revoked_reference") or 0)
    ref_days = int(((metrics.get("windows") or {}).get("reference") or {}).get("days") or 90)
    scale = float(max(1, cur_days)) / float(max(1, ref_days))
    revoked_expected = float(revoked_ref) * scale
    if revoked_cur >= max(3, int(2.0 * max(1.0, revoked_expected))):
        sev = "medium" if revoked_cur < 2 * max(3.0, revoked_expected) else "high"
        _emit_flag(
            flags,
            code="REVOKE_SPIKE",
            severity=sev,
            detail=f"Revocations spiked in the current window ({revoked_cur} vs expected≈{revoked_expected:.2f}).",
            metrics_snapshot={"revoked_current": revoked_cur, "expected": round(revoked_expected, 3)},
        )

    # Failed single-mint authorization ratio.
    sm = metrics.get("single_mint_auth") or {}
    fail_ratio = float(sm.get("failed_ratio_current") or 0.0)
    total = int(sm.get("current_total") or 0)
    if total >= 5:
        sev = _severity_from_ratio(fail_ratio, low=0.15, medium=0.3, high=0.5)
        if sev:
            _emit_flag(
                flags,
                code="SINGLE_MINT_AUTH_FAILURE_RATE",
                severity=sev,
                detail=f"Single-mint authorization failures are elevated (fail_rate={fail_ratio:.2%}, n={total}).",
                metrics_snapshot={"failed_ratio_current": fail_ratio, "n": total, "status_counts": sm.get("current_status_counts")},
            )

    # Batch stress: mint_failed ratio among recently active batches.
    bt = metrics.get("batch") or {}
    batch_rows = int(bt.get("rows_considered") or 0)
    batch_ratio = float(bt.get("mint_failed_ratio") or 0.0)
    if batch_rows >= 25:
        sev = _severity_from_ratio(batch_ratio, low=0.05, medium=0.12, high=0.2)
        if sev:
            _emit_flag(
                flags,
                code="BATCH_MINT_FAILED_RATIO",
                severity=sev,
                detail=f"Batch mint failures are elevated (failed_ratio={batch_ratio:.2%}, rows={batch_rows}).",
                metrics_snapshot={"mint_failed_ratio": batch_ratio, "rows_considered": batch_rows, "batches_considered": bt.get("batches_considered")},
            )

    # Hour-of-week distribution shift: current top-bucket share differs from reference by > threshold.
    how = metrics.get("issued_hour_of_week") or {}
    cur_hist = how.get("current_hist") or {}
    ref_hist = how.get("reference_hist") or {}
    cur_total = sum(int(v) for v in cur_hist.values())
    ref_total = sum(int(v) for v in ref_hist.values())
    if cur_total >= 20 and ref_total >= 100:
        cur_share = _top_bucket_share({int(k): int(v) for k, v in cur_hist.items()})
        ref_share = _top_bucket_share({int(k): int(v) for k, v in ref_hist.items()})
        delta = abs(cur_share - ref_share)
        if delta >= 0.18 and cur_share >= 0.35:
            sev: Severity = "low" if delta < 0.28 else "medium"
            _emit_flag(
                flags,
                code="ISSUANCE_TIME_DISTRIBUTION_SHIFT",
                severity=sev,
                detail=(
                    "Issuance timing is more concentrated than usual (top-hour share "
                    f"{cur_share:.0%} vs baseline {ref_share:.0%})."
                ),
                metrics_snapshot={"current_top_share": round(cur_share, 4), "reference_top_share": round(ref_share, 4), "delta": round(delta, 4)},
            )

    return flags


def summarize_severity(flags: list[dict[str, Any]]) -> dict[str, Any]:
    order = {"low": 1, "medium": 2, "high": 3}
    worst: Severity | None = None
    for f in flags:
        s = f.get("severity")
        if s not in order:
            continue
        if worst is None or order[str(s)] > order[worst]:
            worst = str(s)  # type: ignore[assignment]
    return {
        "flag_count": int(len(flags)),
        "highest_severity": worst,
    }

