"""Institution freeze: block mutating university routes while allowing read-only portal use."""

from __future__ import annotations

from typing import TYPE_CHECKING

from flask import Response, jsonify

if TYPE_CHECKING:
    from app.models import University


def freeze_guard_response(uni: "University | None") -> tuple[Response, int] | None:
    """
    If the institution is frozen, return ``(jsonify(...), 403)`` for the route to return.
    Otherwise return ``None``.
    """
    if uni is None:
        return None
    if not bool(getattr(uni, "is_frozen", False)):
        return None
    frozen_at = getattr(uni, "frozen_at", None)
    return (
        jsonify(
            {
                "error": "Institution account is frozen",
                "frozen_reason": getattr(uni, "frozen_reason", None),
                "frozen_at": frozen_at.isoformat() + "Z" if frozen_at else None,
            }
        ),
        403,
    )
