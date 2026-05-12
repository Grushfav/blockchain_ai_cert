"""Reporting timezone for analytics (fixed UTC-5, no DST — e.g. America/Panama).

DB timestamps are stored as naive UTC wall times; this module converts for calendar windows,
day buckets, and local clock hours used in charts and digest.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# Single-offset UTC-5 year-round (no daylight saving).
DISPLAY_ZONE = ZoneInfo("America/Panama")

DISPLAY_TZ_LABEL = "UTC-5"


def utc_naive_wall(dt: datetime) -> datetime:
    """Normalize to naive UTC wall time (strip tz if present)."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def to_display_zoned(dt: datetime) -> datetime:
    """Interpret naive ``dt`` as UTC and return aware datetime in ``DISPLAY_ZONE``."""
    n = utc_naive_wall(dt)
    return n.replace(tzinfo=timezone.utc).astimezone(DISPLAY_ZONE)


def app_day_start_utc_naive(now_naive: datetime) -> datetime:
    """Start of the current calendar day in ``DISPLAY_ZONE``, as a naive UTC instant."""
    z = to_display_zoned(now_naive)
    d = z.date()
    return datetime.combine(d, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(tzinfo=None)


def app_day_end_exclusive_utc_naive(now_naive: datetime) -> datetime:
    """Start of the next calendar day in ``DISPLAY_ZONE`` (exclusive upper bound for queries)."""
    z = to_display_zoned(now_naive)
    nxt = z.date() + timedelta(days=1)
    return datetime.combine(nxt, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(tzinfo=None)


def app_yesterday_start_utc_naive(now_naive: datetime) -> datetime:
    """Start of the previous calendar day in ``DISPLAY_ZONE``, as naive UTC."""
    z = to_display_zoned(now_naive)
    prev = z.date() - timedelta(days=1)
    return datetime.combine(prev, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(tzinfo=None)


def app_week_start_monday_utc_naive(now_naive: datetime) -> datetime:
    """Monday 00:00 of the current ISO week in ``DISPLAY_ZONE``, as naive UTC."""
    z = to_display_zoned(now_naive)
    d = z.date()
    monday = d - timedelta(days=int(d.weekday()))
    return datetime.combine(monday, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(tzinfo=None)


def app_month_start_utc_naive(now_naive: datetime) -> datetime:
    """First day of the calendar month in ``DISPLAY_ZONE``, as naive UTC."""
    z = to_display_zoned(now_naive)
    d = z.date().replace(day=1)
    return datetime.combine(d, datetime.min.time(), tzinfo=DISPLAY_ZONE).astimezone(timezone.utc).replace(tzinfo=None)


def local_date_str_from_utc_naive_event(ts: datetime) -> str:
    """Calendar date string YYYY-MM-DD in ``DISPLAY_ZONE`` for a naive-UTC event time."""
    return to_display_zoned(ts).strftime("%Y-%m-%d")


def local_weekday_and_hour_from_utc_naive_event(ts: datetime) -> tuple[int, int]:
    """(weekday Monday=0..Sunday=6, hour 0..23) in ``DISPLAY_ZONE``."""
    z = to_display_zoned(ts)
    return int(z.weekday()), int(z.hour)
