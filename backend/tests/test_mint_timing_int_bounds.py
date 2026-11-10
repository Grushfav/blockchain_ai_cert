"""Mint timing columns are PostgreSQL INTEGER. Values past 2^31-1 must not be stored.

A batch row prepared and then executed weeks later used to persist
prepare_to_mint_ms unbounded. PostgreSQL rejects that UPDATE, the request
rolls back, and the row stays prepared after the chain mint — a retry mints
a second token.
"""

import unittest
from datetime import datetime, timedelta

from sqlalchemy import CheckConstraint, Column, Integer, create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Session

from app.mint_batch_routes import (
    _SIGNED_INT32_MAX,
    clamp_signed_int32,
    elapsed_ms_for_int_column,
)


class MintTimingIntBoundTests(unittest.TestCase):
    def test_elapsed_ms_saturates_at_signed_32bit_max(self):
        end = datetime(2026, 6, 20, 12, 0, 0)
        start = end - timedelta(days=25)
        raw = int((end - start).total_seconds() * 1000)
        self.assertGreater(raw, _SIGNED_INT32_MAX)
        self.assertEqual(elapsed_ms_for_int_column(start, end), _SIGNED_INT32_MAX)

    def test_elapsed_ms_keeps_short_and_negative_spans(self):
        end = datetime(2026, 6, 20, 12, 0, 1)
        start = datetime(2026, 6, 20, 12, 0, 0)
        self.assertEqual(elapsed_ms_for_int_column(start, end), 1000)
        self.assertEqual(elapsed_ms_for_int_column(end, start), 0)
        self.assertIsNone(elapsed_ms_for_int_column(None, end))
        self.assertIsNone(elapsed_ms_for_int_column(start, None))

    def test_clamp_bounds(self):
        self.assertEqual(clamp_signed_int32(0), 0)
        self.assertEqual(clamp_signed_int32(_SIGNED_INT32_MAX), _SIGNED_INT32_MAX)
        self.assertEqual(clamp_signed_int32(_SIGNED_INT32_MAX + 1), _SIGNED_INT32_MAX)
        self.assertEqual(clamp_signed_int32(-5), 0)

    def test_unclamped_duration_fails_int32_check_and_clamped_commits(self):
        """SQLite stand-in for PostgreSQL INTEGER overflow: the statement fails and rolls back."""

        class Base(DeclarativeBase):
            pass

        class TimingRow(Base):
            __tablename__ = "timing_rows"
            __table_args__ = (
                CheckConstraint(
                    f"prepare_to_mint_ms <= {_SIGNED_INT32_MAX}",
                    name="ck_prepare_to_mint_ms_int32",
                ),
            )
            id = Column(Integer, primary_key=True)
            prepare_to_mint_ms = Column(Integer)

        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        end = datetime(2026, 6, 20, 12, 0, 0)
        start = end - timedelta(days=25)
        raw = int((end - start).total_seconds() * 1000)

        with Session(engine) as session:
            session.add(TimingRow(id=1, prepare_to_mint_ms=raw))
            with self.assertRaises(IntegrityError):
                session.commit()
            session.rollback()

        with Session(engine) as session:
            session.add(
                TimingRow(id=1, prepare_to_mint_ms=elapsed_ms_for_int_column(start, end))
            )
            session.commit()
            stored = session.get(TimingRow, 1)
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.prepare_to_mint_ms, _SIGNED_INT32_MAX)


if __name__ == "__main__":
    unittest.main()
