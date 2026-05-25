import json
import unittest
from datetime import datetime
from unittest.mock import patch

from flask_jwt_extended import create_access_token

from app import create_app
from app.config import Config
from app.extensions import db
from app.models import CertificateRecord, MintBatch, MintBatchRow, University, User


class MemConfig(Config):
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    TESTING = True
    TRUECERT_CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111"


class _FakeEth:
    def get_transaction_receipt(self, _tx_hash):
        raise RuntimeError("activity log scan is not part of this unit test")


class _FakeW3:
    eth = _FakeEth()


def _tx(i: int) -> str:
    return "0x" + f"{i:064x}"


class MintBatchExecutePersistenceTests(unittest.TestCase):
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
        db.session.remove()
        db.drop_all()
        db.create_all()

    def _authorized_headers(self, user_id: int) -> dict[str, str]:
        token = create_access_token(identity=str(user_id), additional_claims={"role": "university"})
        return {"Authorization": f"Bearer {token}"}

    def _create_authorized_batch(self) -> tuple[int, int, int, int]:
        uni = University(
            name="Example University",
            internal_id="EXU",
            domain_email="example.edu",
            wallet_address="0x2222222222222222222222222222222222222222",
            status="verified",
            institution_contact_email="registrar@example.edu",
            institution_contact_phone="+1-555-0100",
            institution_website="https://example.edu",
            institution_license_id="LIC-1",
            institution_license_authority="Accreditor",
            institution_license_valid_until="2030-01-01",
        )
        user = User(email="registrar@example.edu", role="university", university=uni)
        user.set_password("password123")
        db.session.add_all([uni, user])
        db.session.flush()

        batch = MintBatch(
            university_id=uni.id,
            status="authorized",
            original_filename="batch.csv",
            created_by_user_id=user.id,
            total_rows=2,
            valid_rows=2,
            invalid_rows=0,
            authorized_signature_hex="0xsigned",
        )
        db.session.add(batch)
        db.session.flush()

        row1 = MintBatchRow(
            batch_id=batch.id,
            row_index=0,
            cert_id="CERT-A",
            student_internal_id="S1",
            student_email="s1@example.edu",
            student_full_name="Student One",
            degree_title="BSc",
            issue_date="2026-05-25",
            row_status="prepared",
            metadata_uri="ipfs://metadata-a",
            core_hash="0x" + "a" * 64,
            prepared_at=datetime.utcnow(),
        )
        row2 = MintBatchRow(
            batch_id=batch.id,
            row_index=1,
            cert_id="CERT-B",
            student_internal_id="S2",
            student_email="s2@example.edu",
            student_full_name="Student Two",
            degree_title="BSc",
            issue_date="2026-05-25",
            row_status="prepared",
            metadata_uri="ipfs://metadata-b",
            core_hash="0x" + "b" * 64,
            prepared_at=datetime.utcnow(),
        )
        db.session.add_all([row1, row2])
        db.session.flush()

        db.session.add_all(
            [
                CertificateRecord(
                    token_id=101,
                    university_id=uni.id,
                    cert_id=row1.cert_id,
                    ipfs_uri=row1.metadata_uri,
                    core_hash=row1.core_hash,
                    status="prepared",
                ),
                CertificateRecord(
                    token_id=102,
                    university_id=uni.id,
                    cert_id=row2.cert_id,
                    ipfs_uri=row2.metadata_uri,
                    core_hash=row2.core_hash,
                    status="prepared",
                ),
                CertificateRecord(
                    token_id=2,
                    university_id=uni.id,
                    cert_id="EXISTING-CERT",
                    ipfs_uri="ipfs://existing",
                    core_hash="0x" + "e" * 64,
                    status="issued",
                ),
            ]
        )
        batch.authorized_payload_json = json.dumps(
            [
                {
                    "row_id": row1.id,
                    "row_index": row1.row_index,
                    "cert_id": row1.cert_id,
                    "core_hash": row1.core_hash,
                    "metadata_uri": row1.metadata_uri,
                    "expected_token_id": 101,
                },
                {
                    "row_id": row2.id,
                    "row_index": row2.row_index,
                    "cert_id": row2.cert_id,
                    "core_hash": row2.core_hash,
                    "metadata_uri": row2.metadata_uri,
                    "expected_token_id": 102,
                },
            ]
        )
        db.session.commit()
        return user.id, batch.id, row1.id, row2.id

    def test_token_collision_after_chain_mint_records_rows_and_blocks_retry(self) -> None:
        user_id, batch_id, row1_id, row2_id = self._create_authorized_batch()

        with (
            patch("app.mint_batch_routes._require_contract_code", return_value=None),
            patch("app.mint_batch_routes._verify_certificate_mint_receipt", return_value=(True, "")),
            patch("app.mint_batch_routes.blockchain_service.get_w3", return_value=_FakeW3()),
            patch("app.mint_batch_routes.blockchain_service.get_contract", return_value=object()),
            patch(
                "app.mint_batch_routes.blockchain_service.minter_account_address",
                return_value="0x3333333333333333333333333333333333333333",
            ),
            patch(
                "app.mint_batch_routes.blockchain_service.find_minted_token_id_by_cert_id",
                return_value=None,
            ),
            patch(
                "app.mint_batch_routes.blockchain_service.mint_for_issuer",
                side_effect=[(1, _tx(1)), (2, _tx(2))],
            ) as mint_for_issuer,
        ):
            first = self.client.post(
                f"/api/university/mint-batches/{batch_id}/execute",
                json={"max_mints": 2},
                headers=self._authorized_headers(user_id),
            )
            self.assertEqual(first.status_code, 500)
            self.assertEqual(len(first.get_json()["partial"]), 2)

            # A rollback here simulates request teardown and proves row 1 was committed
            # before row 2 hit the post-chain certificate-index collision.
            db.session.rollback()
            row1 = db.session.get(MintBatchRow, row1_id)
            row2 = db.session.get(MintBatchRow, row2_id)
            self.assertEqual(row1.row_status, "mint_confirmed")
            self.assertEqual(row1.token_id, 1)
            self.assertEqual(row1.tx_hash, _tx(1))
            self.assertEqual(row2.row_status, "mint_confirmed")
            self.assertEqual(row2.token_id, 2)
            self.assertEqual(row2.tx_hash, _tx(2))
            self.assertIn("Certificate index collision", row2.error_message)

            retry = self.client.post(
                f"/api/university/mint-batches/{batch_id}/execute",
                json={"max_mints": 2},
                headers=self._authorized_headers(user_id),
            )
            self.assertEqual(retry.status_code, 200)
            self.assertEqual(retry.get_json()["minted"], [])
            self.assertEqual(mint_for_issuer.call_count, 2)


if __name__ == "__main__":
    unittest.main()
