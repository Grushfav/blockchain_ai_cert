"""Regression tests for public student claim requests."""

import unittest
from unittest.mock import patch

from flask import Blueprint, Flask

from app.config import Config
from app.extensions import db, jwt
from app.models import CertificateRecord, StudentClaimRequest, University
from app.student_claim_routes import register_student_claim_routes


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True


class StudentClaimRequestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = Flask(__name__)
        self.app.config.from_object(MemConfig)
        db.init_app(self.app)
        jwt.init_app(self.app)
        bp = Blueprint("student_claim_test_api", __name__, url_prefix="/api")
        register_student_claim_routes(bp)
        self.app.register_blueprint(bp)
        self.ctx = self.app.app_context()
        self.ctx.push()
        db.create_all()
        self.client = self.app.test_client()

    def tearDown(self) -> None:
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def test_single_mint_claim_request_does_not_require_batch_row(self) -> None:
        uni = University(
            name="Single Mint University",
            internal_id="single-mint-claim-uni",
            domain_email="example.edu",
            wallet_address="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            status="verified",
        )
        db.session.add(uni)
        db.session.flush()
        db.session.add(
            CertificateRecord(
                token_id=101,
                university_id=uni.id,
                cert_id="CERT-SINGLE-101",
                ipfs_uri="ipfs://bafyexample",
                status="issued",
                student_internal_id="stu-101",
                student_email="student@example.edu",
            )
        )
        db.session.commit()

        with (
            patch(
                "app.student_claim_routes.blockchain_service.escrow_claim_eligibility",
                return_value=(True, None),
            ),
            patch(
                "app.student_claim_routes.notification_service.notify_university_users",
                return_value=0,
            ),
        ):
            resp = self.client.post(
                "/api/public/student-claim-requests",
                json={
                    "university_id": uni.id,
                    "student_internal_id": "stu-101",
                    "student_email": "Student@Example.Edu",
                    "wallet_address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
                },
            )

        self.assertEqual(resp.status_code, 201, resp.get_data(as_text=True))
        self.assertEqual(resp.get_json()["token_id"], 101)

        claim = StudentClaimRequest.query.one()
        self.assertIsNone(claim.mint_batch_row_id)
        self.assertEqual(claim.cert_id, "CERT-SINGLE-101")
        self.assertEqual(claim.student_email, "student@example.edu")


if __name__ == "__main__":
    unittest.main()
