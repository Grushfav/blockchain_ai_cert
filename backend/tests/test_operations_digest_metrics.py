"""Unit tests for platform operations digest aggregates (fixed ``now`` for window math)."""

import unittest
from datetime import datetime, timedelta

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import ActivityLog
from app.services import analytics_service


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True


def _tx(i: int) -> str:
    return "0x" + f"{i:064x}"


class OperationsDigestMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app(MemConfig)
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        db.create_all()

    @classmethod
    def tearDownClass(cls) -> None:
        db.session.remove()
        db.drop_all()
        cls.ctx.pop()

    def setUp(self) -> None:
        db.session.query(ActivityLog).delete()
        db.session.commit()

    def _issued(self, *, created_at: datetime, log_index: int) -> None:
        db.session.add(
            ActivityLog(
                university_id=None,
                token_id=log_index,
                action="issued",
                tx_hash=_tx(log_index),
                log_index=log_index,
                block_number=1000 + log_index,
                block_timestamp=None,
                created_at=created_at,
            )
        )
        db.session.commit()

    def test_histogram_and_trends_use_fixed_now(self) -> None:
        """UTC day 2026-06-10 end-of-day: histogram buckets for hours 10 and 22; yesterday separate."""
        fixed = datetime(2026, 6, 10, 23, 45, 0)
        self._issued(created_at=datetime(2026, 6, 10, 10, 15, 0), log_index=1)
        self._issued(created_at=datetime(2026, 6, 10, 22, 0, 0), log_index=2)
        self._issued(created_at=datetime(2026, 6, 9, 12, 0, 0), log_index=3)

        m = analytics_service.platform_operations_digest_metrics(now=fixed)
        hist = m["today"]["issued_mint_hour_histogram_utc"]
        self.assertEqual(len(hist), 24)
        self.assertEqual(hist[10], 1)
        self.assertEqual(hist[22], 1)
        self.assertEqual(hist[12], 0)

        t = m["trends"]
        self.assertEqual(t["issued_today_utc_day_to_now"], 2)
        self.assertEqual(t["issued_yesterday_full_utc_day"], 1)

    def test_yesterday_boundary_half_open(self) -> None:
        """Event exactly at UTC midnight today belongs to today, not yesterday."""
        fixed = datetime(2026, 6, 10, 8, 0, 0)
        self._issued(created_at=datetime(2026, 6, 10, 0, 0, 0), log_index=10)
        self._issued(created_at=datetime(2026, 6, 9, 23, 59, 59), log_index=11)

        m = analytics_service.platform_operations_digest_metrics(now=fixed)
        self.assertEqual(m["trends"]["issued_today_utc_day_to_now"], 1)
        self.assertEqual(m["trends"]["issued_yesterday_full_utc_day"], 1)

    def test_rolling_7d_includes_recent_only(self) -> None:
        fixed = datetime(2026, 6, 10, 12, 0, 0)
        old = fixed - timedelta(days=8)
        self._issued(created_at=fixed - timedelta(days=1), log_index=20)
        self._issued(created_at=old, log_index=21)

        m = analytics_service.platform_operations_digest_metrics(now=fixed)
        self.assertEqual(m["rolling_7d"]["activity_by_action"]["issued"], 1)


if __name__ == "__main__":
    unittest.main()
