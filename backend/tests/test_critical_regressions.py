import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from app import create_app
import app.config as app_config
from app.config import Config
from app.extensions import db
from app.models import CertificateRecord, MintBatch, MintBatchRow, StudentClaimRequest, University, User


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True


class CriticalRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = create_app(MemConfig)
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        cls.client = cls.app.test_client()

    @classmethod
    def tearDownClass(cls) -> None:
        db.session.remove()
        db.drop_all()
        cls.ctx.pop()

    def setUp(self) -> None:
        StudentClaimRequest.query.delete()
        CertificateRecord.query.delete()
        MintBatchRow.query.delete()
        MintBatch.query.delete()
        User.query.delete()
        University.query.delete()
        db.session.commit()

    def _seed_university(self) -> University:
        uni = University(
            name="Regression University",
            internal_id="regression-u",
            domain_email="regression.example",
            wallet_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            status="verified",
        )
        db.session.add(uni)
        db.session.commit()
        return uni

    def test_single_mint_student_claim_does_not_require_batch_row(self) -> None:
        import app.student_claim_routes as claim_routes

        uni = self._seed_university()
        db.session.add(
            CertificateRecord(
                token_id=123,
                university_id=uni.id,
                cert_id="CERT-SINGLE-1",
                ipfs_uri="ipfs://single",
                core_hash="0x" + "a" * 64,
                status="issued",
                student_internal_id="SID-123",
                student_email="student@example.edu",
            )
        )
        db.session.commit()

        with patch.object(claim_routes.blockchain_service, "escrow_claim_eligibility", return_value=(True, None)):
            with patch.object(claim_routes.notification_service, "notify_university_users", return_value=1):
                resp = self.client.post(
                    "/api/public/student-claim-requests",
                    json={
                        "university_id": uni.id,
                        "student_internal_id": "SID-123",
                        "student_email": "student@example.edu",
                        "wallet_address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
                    },
                )

        self.assertEqual(resp.status_code, 201, resp.get_data(as_text=True))
        req = StudentClaimRequest.query.one()
        self.assertIsNone(req.mint_batch_row_id)
        self.assertEqual(req.cert_id, "CERT-SINGLE-1")
        self.assertEqual(req.token_id, 123)

    def test_verify_fields_rejects_prepared_record_not_minted_on_chain(self) -> None:
        from app.routes import api as api_mod

        uni = self._seed_university()
        fields = {
            "institution_name": uni.name,
            "student_full_name": "Prepared Student",
            "degree_title": "BSc Testing",
            "cert_id": "CERT-PREPARED-1",
            "issue_date": "2026-05-26",
        }
        core_hash = api_mod._core_hash_hex(fields)
        db.session.add(
            CertificateRecord(
                token_id=444,
                university_id=uni.id,
                cert_id=fields["cert_id"],
                ipfs_uri="ipfs://prepared",
                core_hash=core_hash,
                status="prepared",
            )
        )
        db.session.commit()

        old_contract = app_config.Config.TRUECERT_CONTRACT_ADDRESS
        app_config.Config.TRUECERT_CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111"
        mock_w3 = MagicMock()
        mock_w3.eth.chain_id = 80002
        try:
            with patch.object(api_mod.blockchain_service, "get_w3", return_value=mock_w3):
                with patch.object(api_mod, "_require_contract_code", return_value=None):
                    with patch.object(api_mod.blockchain_service, "get_contract", return_value=MagicMock()):
                        with patch.object(
                            api_mod.blockchain_service,
                            "read_certificate_public",
                            return_value={"exists": False},
                        ):
                            resp = self.client.post(
                                "/api/verify/fields",
                                json={
                                    "institution_name": fields["institution_name"],
                                    "student_name": fields["student_full_name"],
                                    "degree_type": fields["degree_title"],
                                    "cert_id": fields["cert_id"],
                                    "issue_date": fields["issue_date"],
                                },
                            )
        finally:
            app_config.Config.TRUECERT_CONTRACT_ADDRESS = old_contract

        self.assertEqual(resp.status_code, 404, resp.get_data(as_text=True))
        self.assertFalse((resp.get_json() or {}).get("matched"))

    def test_default_sqlite_uri_preserves_legacy_database_when_new_name_missing(self) -> None:
        old_instance_dir = app_config._INSTANCE_DIR
        try:
            with tempfile.TemporaryDirectory() as td:
                app_config._INSTANCE_DIR = Path(td)
                legacy_path = Path(td) / "trucert.db"
                legacy_path.write_bytes(b"legacy")
                self.assertTrue(app_config._default_sqlite_uri().endswith("/trucert.db"))

                new_path = Path(td) / "truecert.db"
                new_path.write_bytes(b"new")
                self.assertTrue(app_config._default_sqlite_uri().endswith("/truecert.db"))
        finally:
            app_config._INSTANCE_DIR = old_instance_dir


if __name__ == "__main__":
    unittest.main()
