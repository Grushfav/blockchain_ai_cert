"""In-process TTL cache for safe Gemini text responses (verify explain, risk summary).

Swap this module for Redis-backed storage later without changing call sites.
"""

from __future__ import annotations

import hashlib
import json
import time
from threading import Lock
from typing import Any

_lock = Lock()
# key -> (text, expiry_monotonic)
_store: dict[str, tuple[str, float]] = {}


def canonical_json(obj: Any) -> str:
    """Deterministic JSON for hashing (sorted keys, compact separators)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def verify_explain_cache_key(sanitized: dict[str, Any], model_name: str) -> str:
    """Content-addressed key; includes model so upgrades invalidate cache."""
    body = canonical_json(sanitized) + "|" + (model_name or "").strip()
    return "ve1:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def risk_summary_cache_key(
    *,
    university_id: int,
    current_days: int,
    reference_days: int,
    summary: Any,
    flags: list[dict[str, Any]],
    aggregates: dict[str, Any],
    model_name: str,
) -> str:
    """Key from institution, window params, and deterministic model-facing payload."""
    payload = {
        "university_id": int(university_id),
        "current_days": int(current_days),
        "reference_days": int(reference_days),
        "summary": summary,
        "flags": flags,
        "aggregates": aggregates,
    }
    body = canonical_json(payload) + "|" + (model_name or "").strip()
    return "rs1:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def _evict_expired(now: float) -> None:
    dead = [k for k, (_, exp) in _store.items() if exp <= now]
    for k in dead:
        del _store[k]


def _trim_to_max(max_entries: int) -> None:
    if max_entries <= 0:
        _store.clear()
        return
    if len(_store) <= max_entries:
        return
    # Drop entries with soonest expiry until under limit.
    while len(_store) > max_entries:
        oldest = min(_store.items(), key=lambda kv: kv[1][1])
        del _store[oldest[0]]


def get_text(key: str, *, max_entries: int) -> str | None:
    """Return cached text if present and not expired; evict expired and trim on access."""
    with _lock:
        now = time.monotonic()
        _evict_expired(now)
        _trim_to_max(max_entries)
        tup = _store.get(key)
        if not tup:
            return None
        text, exp = tup
        if exp <= now:
            del _store[key]
            return None
        return text


def set_text(key: str, text: str, *, ttl_seconds: float, max_entries: int) -> None:
    if ttl_seconds <= 0:
        return
    with _lock:
        now = time.monotonic()
        _evict_expired(now)
        _trim_to_max(max_entries)
        if len(_store) >= max_entries and key not in _store:
            _trim_to_max(max_entries - 1)
        _store[key] = (text, now + float(ttl_seconds))


def clear_for_tests() -> None:
    """Reset store (unit tests only)."""
    with _lock:
        _store.clear()
