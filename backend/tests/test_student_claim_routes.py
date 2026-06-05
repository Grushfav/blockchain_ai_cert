import unittest
from unittest.mock import patch

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import CertificateRecord, StudentClaimRequest, University


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True


class StudentClaimRoutesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = create_app(MemConfig)
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _seed_single_mint_certificate(self) -> University:
        uni = University(
            name="Claim Test University",
            internal_id="claim-test-uni",
            domain_email="example.edu",
            wallet_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            status="verified",
        )
        db.session.add(uni)
        db.session.flush()
        db.session.add(
            CertificateRecord(
                token_id=77,
                university_id=uni.id,
                cert_id="CERT-CLAIM-1",
                ipfs_uri="ipfs://bafytestclaim",
                core_hash="0x" + ("a" * 64),
                status="issued",
                student_internal_id="STU-100",
                student_email="student@example.edu",
            )
        )
        db.session.commit()
        return uni

    def test_public_claim_request_supports_single_mint_certificate(self) -> None:
        uni = self._seed_single_mint_certificate()

        with patch(
            "app.student_claim_routes.blockchain_service.escrow_claim_eligibility",
            return_value=(True, None),
        ) as mock_eligibility:
            with patch(
                "app.student_claim_routes.notification_service.notify_university_users",
                return_value=0,
            ):
                resp = self.client.post(
                    "/api/public/student-claim-requests",
                    json={
                        "university_id": uni.id,
                        "student_internal_id": " STU-100 ",
                        "student_email": "Student@Example.edu",
                        "wallet_address": "0x0000000000000000000000000000000000000001",
                    },
                )

        self.assertEqual(resp.status_code, 201, resp.get_data(as_text=True))
        self.assertEqual((resp.get_json() or {}).get("token_id"), 77)
        mock_eligibility.assert_called_once_with(token_id=77, issuer_wallet=uni.wallet_address)

        claim = StudentClaimRequest.query.one()
        self.assertIsNone(claim.mint_batch_row_id)
        self.assertEqual(claim.token_id, 77)
        self.assertEqual(claim.cert_id, "CERT-CLAIM-1")
        self.assertEqual(claim.student_internal_id, "STU-100")
        self.assertEqual(claim.student_email, "student@example.edu")


if __name__ == "__main__":
    unittest.main()
