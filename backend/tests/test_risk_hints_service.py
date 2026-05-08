import unittest

from app.services import risk_hints_service


class RiskHintsServiceTests(unittest.TestCase):
    def test_compute_flags_normal_no_flags(self):
        metrics = {
            "windows": {"current": {"days": 7}, "reference": {"days": 90}},
            "mint_velocity": {"issued_current_total": 10, "reference_mean_per_day": 2.0},
            "revoke": {"revoked_current": 0, "revoked_reference": 2},
            "single_mint_auth": {
                "failed_ratio_current": 0.0,
                "current_total": 10,
                "current_status_counts": {"pending": 2, "minted": 8, "failed": 0},
            },
            "batch": {"rows_considered": 200, "mint_failed_ratio": 0.0, "batches_considered": 2},
            "issued_hour_of_week": {
                "current_hist": {10: 3, 11: 3, 12: 4},
                "reference_hist": {10: 30, 11: 40, 12: 30},
            },
        }
        flags = risk_hints_service.compute_flags(metrics)
        self.assertEqual(flags, [])

    def test_compute_flags_velocity_spike(self):
        metrics = {
            "windows": {"current": {"days": 7}, "reference": {"days": 90}},
            "mint_velocity": {"issued_current_total": 250, "reference_mean_per_day": 5.0},
            "revoke": {"revoked_current": 0, "revoked_reference": 0},
            "single_mint_auth": {"failed_ratio_current": 0.0, "current_total": 0, "current_status_counts": {}},
            "batch": {"rows_considered": 0, "mint_failed_ratio": 0.0, "batches_considered": 0},
            "issued_hour_of_week": {"current_hist": {}, "reference_hist": {}},
        }
        flags = risk_hints_service.compute_flags(metrics)
        self.assertTrue(any(f["code"] == "MINT_VELOCITY_SPIKE" for f in flags))


if __name__ == "__main__":
    unittest.main()

