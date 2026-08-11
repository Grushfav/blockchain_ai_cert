"""Unit tests for platform operations digest aggregates and Gemini /verify/explain cache."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import (
    ActivityLog,
    CertificateRecord,
    MintAuthorizationRequest,
    MintBatch,
    MintBatchRow,
    StudentClaimRequest,
    University,
    User,
)
from app.services import ai_response_cache, analytics_service, gemini_service


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True
    GEMINI_API_KEY = "test-key-not-used-with-mock"
    GEMINI_MODEL = "gemini-test-model"


def _tx(i: int) -> str:
    return "0x" + f"{i:064x}"


class OperationsDigestMetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app(MemConfig)
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        cls.client = cls.app.test_client()
        db.create_all()

    @classmethod
    def tearDownClass(cls) -> None:
        db.session.remove()
        db.drop_all()
        cls.ctx.pop()

    def setUp(self) -> None:
        ai_response_cache.clear_for_tests()
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
        """UTC-5 (Panama) day 2026-06-10 end-of-day UTC: histogram buckets for local hours 5 and 17; yesterday separate."""
        fixed = datetime(2026, 6, 10, 23, 45, 0)
        self._issued(created_at=datetime(2026, 6, 10, 10, 15, 0), log_index=1)
        self._issued(created_at=datetime(2026, 6, 10, 22, 0, 0), log_index=2)
        self._issued(created_at=datetime(2026, 6, 9, 12, 0, 0), log_index=3)

        m = analytics_service.platform_operations_digest_metrics(now=fixed)
        hist = m["today"]["issued_mint_hour_histogram_utc"]
        self.assertEqual(len(hist), 24)
        self.assertEqual(hist[5], 1)
        self.assertEqual(hist[17], 1)
        self.assertEqual(hist[12], 0)

        t = m["trends"]
        self.assertEqual(t["issued_today_utc_day_to_now"], 2)
        self.assertEqual(t["issued_yesterday_full_utc_day"], 1)

    def test_yesterday_boundary_half_open(self) -> None:
        """Local-day boundary: 2026-06-10 05:00 UTC is start of June 10 in UTC-5; instant before counts as yesterday."""
        fixed = datetime(2026, 6, 10, 8, 0, 0)
        self._issued(created_at=datetime(2026, 6, 10, 5, 0, 0), log_index=10)
        self._issued(created_at=datetime(2026, 6, 10, 4, 59, 59), log_index=11)

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

    @staticmethod
    def _base_verification(issue_date: str) -> dict:
        return {
            "token_id": 42,
            "exists": True,
            "matched": True,
            "chain_id": 80002,
            "contract_address": "0x" + "1" * 40,
            "on_chain": {
                "exists": True,
                "issuer_address": "0x" + "2" * 40,
                "owner_address": "0x" + "3" * 40,
                "valid": True,
                "locked": False,
                "metadata_uri": "ipfs://bafyexample",
                "core_hash": "0x" + "a" * 64,
            },
            "off_chain_metadata": {
                "student_full_name": "Test Student",
                "degree_title": "BSc",
                "issue_date": issue_date,
                "cert_id": "CERT-1",
                "institution_name": "Demo U",
            },
        }

    def test_verify_explain_same_payload_twice_cache_hit_no_second_gemini(self) -> None:
        body = {"verification": self._base_verification("2024-06-01")}
        mock_gen = MagicMock(return_value="First and only Gemini paragraph one.\n\nParagraph two.")
        with patch.object(gemini_service, "generate_text", mock_gen):
            r1 = self.client.post("/api/verify/explain", json=body)
            r2 = self.client.post("/api/verify/explain", json=body)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r1.json, r2.json)
        self.assertEqual(r1.headers.get("X-Cache"), "MISS")
        self.assertEqual(r2.headers.get("X-Cache"), "HIT")
        self.assertEqual(mock_gen.call_count, 1)

    def test_verify_explain_different_issue_date_cache_miss(self) -> None:
        mock_gen = MagicMock(side_effect=["Summary A paragraph one.\n\nTwo.", "Summary B paragraph one.\n\nTwo."])
        with patch.object(gemini_service, "generate_text", mock_gen):
            r1 = self.client.post(
                "/api/verify/explain", json={"verification": self._base_verification("2024-01-01")}
            )
            r2 = self.client.post(
                "/api/verify/explain", json={"verification": self._base_verification("2024-02-01")}
            )
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertNotEqual(r1.json.get("text"), r2.json.get("text"))
        self.assertEqual(mock_gen.call_count, 2)
        self.assertEqual(r1.headers.get("X-Cache"), "MISS")
        self.assertEqual(r2.headers.get("X-Cache"), "MISS")

    # --- Single-mint HTTPS metadata (same app/db lifecycle as class; must run before tearDownClass drop_all) ---

    def _cleanup_mint_fixtures(self) -> None:
        MintAuthorizationRequest.query.delete()
        CertificateRecord.query.delete()
        User.query.filter(User.email == "singlemint@example.edu").delete(synchronize_session=False)
        University.query.filter_by(internal_id="single-mint-test-uni").delete(synchronize_session=False)
        db.session.commit()

    def _seed_verified_university_single_mint(self) -> tuple[University, User]:
        uni = University(
            name="Single Mint Uni",
            internal_id="single-mint-test-uni",
            domain_email="example.edu",
            wallet_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            status="verified",
            eip712_nonce=0,
            eip712_single_nonce=0,
            eip712_batch_nonce=0,
            institution_contact_email="registrar@example.edu",
            institution_contact_phone="+10000000000",
            institution_website="https://example.edu",
            institution_license_id="LIC-1",
            institution_license_authority="Board",
            institution_license_valid_until="2035-12-31",
        )
        db.session.add(uni)
        db.session.flush()
        user = User(email="singlemint@example.edu", role="university", university_id=uni.id)
        user.set_password("testpass123")
        db.session.add(user)
        db.session.commit()
        return uni, user

    def _uni_jwt_single_mint(self, user: User) -> dict[str, str]:
        from flask_jwt_extended import create_access_token

        tok = create_access_token(identity=str(user.id), additional_claims={"role": "university"})
        return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}

    def test_core_hash_only_five_fields(self) -> None:
        from app.routes import api as api_mod

        meta = {
            "institution_name": "U",
            "student_full_name": "S",
            "degree_title": "D",
            "cert_id": "C1",
            "issue_date": "2020-01-01",
        }
        self.assertTrue(api_mod._core_hash_hex(meta).startswith("0x"))

    def test_prepare_single_mint_invalid_email_400(self) -> None:
        self._cleanup_mint_fixtures()
        _, user = self._seed_verified_university_single_mint()
        headers = self._uni_jwt_single_mint(user)
        body = {
            "student_internal_id": "stu-1",
            "student_email": "not-an-email",
            "student_name": "Pat",
            "degree_type": "BSc",
            "cert_id": "CERT-SM-1",
            "issue_date": "2024-06-01",
        }
        r = self.client.post("/api/university/certificates/prepare-mint", json=body, headers=headers)
        self.assertEqual(r.status_code, 400)
        self.assertIn("email", (r.get_json() or {}).get("error", "").lower())
        self._cleanup_mint_fixtures()

    def test_prepare_single_mint_pins_ipfs_metadata(self) -> None:
        import json

        import app.config as app_config
        from app.routes import api as api_mod
        from app.services import metadata_signing

        self._cleanup_mint_fixtures()
        _, user = self._seed_verified_university_single_mint()

        orig_pub = app_config.Config.PUBLIC_METADATA_BASE_URL
        orig_jwt = app_config.Config.PINATA_JWT
        orig_kid = app_config.Config.TRUECERT_SIG_KID
        orig_priv = app_config.Config.TRUECERT_SIG_PRIVATE_KEY
        orig_pubkeys = app_config.Config.TRUECERT_SIG_PUBLIC_KEYS
        app_config.Config.PUBLIC_METADATA_BASE_URL = ""
        app_config.Config.PINATA_JWT = "test-jwt-placeholder"
        app_config.Config.TRUECERT_SIG_KID = "unit-test"
        app_config.Config.TRUECERT_SIG_PRIVATE_KEY = (
            "0x2ce2795dc16073228f97a72d58e7b2694422336912356849487544a36d8ed6eb"
        )
        app_config.Config.TRUECERT_SIG_PUBLIC_KEYS = (
            '{"unit-test": "0x72f2d39a93d51d639c441592b0c399394d7fdab70d6ac9011e54e24ec76fd4ee"}'
        )

        mock_pin = MagicMock(return_value="ipfs://QmTestSingleMintJson")
        mock_contract = MagicMock()
        mock_contract.functions.nextTokenId.return_value.call.return_value = 42
        try:
            with patch.object(api_mod.pinata_service, "pin_certificate_metadata", mock_pin):
                with patch.object(api_mod, "_require_contract_code", return_value=None):
                    with patch.object(api_mod.blockchain_service, "get_w3", return_value=MagicMock()):
                        with patch.object(api_mod.blockchain_service, "get_contract", return_value=mock_contract):
                            r = self.client.post(
                                "/api/university/certificates/prepare-mint",
                                json={
                                    "student_internal_id": "IID-9",
                                    "student_email": "student@example.edu",
                                    "student_name": "Pat Lee",
                                    "degree_type": "BSc CS",
                                    "cert_id": "CERT-SM-99",
                                    "issue_date": "2024-06-15",
                                },
                                headers=self._uni_jwt_single_mint(user),
                            )
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            mock_pin.assert_called_once()
            self.assertEqual(mock_pin.call_args[0][0], 42)
            data = r.get_json() or {}
            self.assertEqual(data.get("metadata_uri"), "ipfs://QmTestSingleMintJson")
            mar = MintAuthorizationRequest.query.filter_by(cert_id="CERT-SM-99").first()
            self.assertIsNotNone(mar)
            self.assertEqual(mar.metadata_uri, "ipfs://QmTestSingleMintJson")
            self.assertEqual(mar.student_internal_id, "IID-9")
            self.assertEqual(mar.student_email, "student@example.edu")
            self.assertTrue((mar.signed_metadata_json or "").strip())

            gr = self.client.get("/api/public/metadata/42")
            self.assertEqual(gr.status_code, 200)
            payload = json.loads(gr.get_data(as_text=True))
            ok, _reason = metadata_signing.verify_metadata_signature(payload)
            self.assertTrue(ok)
        finally:
            app_config.Config.PUBLIC_METADATA_BASE_URL = orig_pub
            app_config.Config.PINATA_JWT = orig_jwt
            app_config.Config.TRUECERT_SIG_KID = orig_kid
            app_config.Config.TRUECERT_SIG_PRIVATE_KEY = orig_priv
            app_config.Config.TRUECERT_SIG_PUBLIC_KEYS = orig_pubkeys
            self._cleanup_mint_fixtures()

    def _cleanup_reissue_claim_fixtures(self) -> None:
        StudentClaimRequest.query.delete()
        MintBatchRow.query.delete()
        MintBatch.query.delete()
        CertificateRecord.query.delete()
        User.query.filter(User.email == "reissue-claim@example.edu").delete(synchronize_session=False)
        University.query.filter_by(internal_id="reissue-claim-test-uni").delete(synchronize_session=False)
        db.session.commit()

    def _seed_reissue_claim_university(self) -> University:
        uni = University(
            name="Reissue Claim Uni",
            internal_id="reissue-claim-test-uni",
            domain_email="reissue.edu",
            wallet_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            status="verified",
            eip712_nonce=0,
            eip712_single_nonce=0,
            eip712_batch_nonce=0,
            institution_contact_email="registrar@reissue.edu",
            institution_contact_phone="+10000000000",
            institution_website="https://reissue.edu",
            institution_license_id="LIC-R1",
            institution_license_authority="Board",
            institution_license_valid_until="2035-12-31",
        )
        db.session.add(uni)
        db.session.flush()
        user = User(email="reissue-claim@example.edu", role="university", university_id=uni.id)
        user.set_password("testpass123")
        db.session.add(user)
        db.session.commit()
        return uni

    def test_propagate_reissue_claim_continuity_batch_and_single(self) -> None:
        """After reissue sync, claim matching must use the new token (batch row + student contact)."""
        from app.routes import api as api_mod
        from app.student_claim_routes import _find_mint_row_for_student, _find_single_certificate_for_student

        self._cleanup_reissue_claim_fixtures()
        uni = self._seed_reissue_claim_university()

        old_tid, new_tid = 101, 202
        db.session.add(
            CertificateRecord(
                token_id=old_tid,
                university_id=uni.id,
                cert_id="CERT-OLD",
                ipfs_uri="ipfs://old",
                status="reissued",
                student_internal_id="STU-42",
                student_email="student@reissue.edu",
            )
        )
        db.session.add(
            CertificateRecord(
                token_id=new_tid,
                university_id=uni.id,
                cert_id="CERT-NEW",
                ipfs_uri="ipfs://new",
                status="issued",
                supersedes_token_id=old_tid,
            )
        )
        batch = MintBatch(
            university_id=uni.id,
            created_by_user_id=User.query.filter_by(email="reissue-claim@example.edu").first().id,
            original_filename="cohort.csv",
            status="completed",
        )
        db.session.add(batch)
        db.session.flush()
        brow = MintBatchRow(
            batch_id=batch.id,
            row_index=0,
            cert_id="CERT-OLD",
            student_internal_id="STU-42",
            student_email="student@reissue.edu",
            student_full_name="Pat Lee",
            degree_title="BSc",
            row_status="mint_confirmed",
            token_id=old_tid,
        )
        db.session.add(brow)
        db.session.commit()

        api_mod._propagate_reissue_claim_continuity(old_token_id=old_tid, new_token_id=new_tid)
        db.session.commit()

        db.session.refresh(brow)
        new_rec = CertificateRecord.query.filter_by(token_id=new_tid).first()
        self.assertEqual(brow.token_id, new_tid)
        self.assertEqual(brow.cert_id, "CERT-NEW")
        self.assertEqual(new_rec.student_internal_id, "STU-42")
        self.assertEqual(new_rec.student_email, "student@reissue.edu")

        matched_row = _find_mint_row_for_student(
            university_id=uni.id, student_internal_id="STU-42", email="student@reissue.edu"
        )
        self.assertIsNotNone(matched_row)
        self.assertEqual(matched_row.token_id, new_tid)

        matched_cert = _find_single_certificate_for_student(
            university_id=uni.id, student_internal_id="STU-42", email="student@reissue.edu"
        )
        self.assertIsNotNone(matched_cert)
        self.assertEqual(matched_cert.token_id, new_tid)
        self._cleanup_reissue_claim_fixtures()

    def test_public_claim_create_single_mint_null_safe_after_reissue(self) -> None:
        """Single-mint claim path must not crash when mint_batch_row is absent."""
        from app.services import blockchain_service, notification_service

        self._cleanup_reissue_claim_fixtures()
        uni = self._seed_reissue_claim_university()
        db.session.add(
            CertificateRecord(
                token_id=303,
                university_id=uni.id,
                cert_id="CERT-SM-REISSUE",
                ipfs_uri="ipfs://sm",
                status="issued",
                student_internal_id="SM-7",
                student_email="sm@reissue.edu",
            )
        )
        db.session.commit()

        with patch.object(blockchain_service, "escrow_claim_eligibility", return_value=(True, None)):
            with patch.object(notification_service, "notify_university_users", return_value=0):
                r = self.client.post(
                    "/api/public/student-claim-requests",
                    json={
                        "university_id": uni.id,
                        "student_internal_id": "SM-7",
                        "student_email": "sm@reissue.edu",
                        "wallet_address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
                    },
                )
        self.assertEqual(r.status_code, 201, r.get_data(as_text=True))
        body = r.get_json() or {}
        self.assertEqual(body.get("token_id"), 303)
        created = StudentClaimRequest.query.filter_by(token_id=303).first()
        self.assertIsNotNone(created)
        self.assertIsNone(created.mint_batch_row_id)
        self.assertEqual(created.cert_id, "CERT-SM-REISSUE")
        self._cleanup_reissue_claim_fixtures()


if __name__ == "__main__":
    unittest.main()
