"""In-app notifications (persisted) for admin + university users.

Notes:
- These notifications are in-app only for v1. Email delivery (SendGrid) is out of scope here.
- Do not store secrets, passwords, or JWTs in payload_json.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from app.extensions import db
from app.models import Notification, User


def notify_user(
    user_id: int,
    *,
    kind: str,
    title: str,
    body: str,
    payload: dict[str, Any] | None = None,
) -> Notification:
    n = Notification(
        user_id=int(user_id),
        kind=str(kind),
        title=str(title)[:255],
        body=str(body),
        payload_json=json.dumps(payload or {}, ensure_ascii=False) if payload is not None else None,
        read_at=None,
    )
    db.session.add(n)
    return n


def notify_university_users(
    university_id: int,
    *,
    kind: str,
    title: str,
    body: str,
    payload: dict[str, Any] | None = None,
) -> int:
    users = User.query.filter_by(university_id=int(university_id)).all()
    for u in users:
        notify_user(u.id, kind=kind, title=title, body=body, payload=payload)
    return int(len(users))


def mark_all_read(user_id: int) -> int:
    now = datetime.utcnow()
    # SQLAlchemy bulk update; safe because we scope to user_id.
    q = Notification.query.filter_by(user_id=int(user_id), read_at=None)
    n = int(q.count())
    q.update({"read_at": now})
    return n

