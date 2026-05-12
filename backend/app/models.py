from datetime import datetime

from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy.sql import expression

from app.extensions import db


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(32), nullable=False)  # "admin" | "university"
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=True)
    university = db.relationship("University", back_populates="users")
    mint_batches_created = db.relationship(
        "MintBatch",
        foreign_keys="MintBatch.created_by_user_id",
        back_populates="created_by",
    )

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class University(db.Model):
    __tablename__ = "universities"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    internal_id = db.Column(db.String(128), unique=True, nullable=False)
    domain_email = db.Column(db.String(255), nullable=False)
    wallet_address = db.Column(db.String(42), unique=True, nullable=False)
    logo_uri = db.Column(db.String(512), nullable=True)
    institution_contact_email = db.Column(db.String(255), nullable=True)
    institution_contact_phone = db.Column(db.String(64), nullable=True)
    institution_website = db.Column(db.String(255), nullable=True)
    institution_license_id = db.Column(db.String(128), nullable=True)
    institution_license_authority = db.Column(db.String(255), nullable=True)
    institution_license_valid_until = db.Column(db.String(32), nullable=True)
    status = db.Column(db.String(32), nullable=False, default="pending")
    kyc_notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Legacy unified watermark (kept in sync as max(single, batch, self) for older dashboards).
    eip712_nonce = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    # Separate replay counters so single-mint EIP-712 does not invalidate in-flight batch authorization.
    eip712_single_nonce = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    eip712_batch_nonce = db.Column(db.Integer, nullable=False, default=0, server_default="0")

    # Operational / compliance (admin review; not included in public certificate verify responses).
    expected_mints_monthly = db.Column(db.Integer, nullable=True)
    expected_mints_annually = db.Column(db.Integer, nullable=True)
    # JSON array of weekday ints 0=Mon .. 6=Sun
    operating_days_of_week = db.Column(db.Text, nullable=True)
    operating_hours_start = db.Column(db.String(8), nullable=True)
    operating_hours_end = db.Column(db.String(8), nullable=True)
    operating_timezone = db.Column(db.String(128), nullable=True)
    # JSON array: [{ "label", "filename", "uri", "mime", "uploaded_at" }, ...]
    institution_documents_json = db.Column(db.Text, nullable=True)

    # Admin freeze: read-only portal; issuance and profile mutations blocked via API.
    is_frozen = db.Column(db.Boolean, nullable=False, default=False, server_default=expression.false())
    frozen_reason = db.Column(db.Text, nullable=True)
    frozen_at = db.Column(db.DateTime, nullable=True)

    users = db.relationship("User", back_populates="university", lazy="dynamic")
    certificates = db.relationship("CertificateRecord", back_populates="university")
    mint_batches = db.relationship("MintBatch", back_populates="university")


class MintBatch(db.Model):
    """CSV batch upload for sequential wallet minting."""

    __tablename__ = "mint_batches"

    id = db.Column(db.Integer, primary_key=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=False, index=True)
    status = db.Column(db.String(32), nullable=False, default="uploaded", index=True)
    original_filename = db.Column(db.String(512), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    total_rows = db.Column(db.Integer, nullable=False, default=0)
    valid_rows = db.Column(db.Integer, nullable=False, default=0)
    invalid_rows = db.Column(db.Integer, nullable=False, default=0)
    error_summary = db.Column(db.Text, nullable=True)

    # EIP-712 batch authorization (one signature for the whole batch commitment).
    authorized_commitment_hex = db.Column(db.String(66), nullable=True)
    authorized_row_ids_json = db.Column(db.Text, nullable=True)
    authorized_payload_json = db.Column(db.Text, nullable=True)
    authorized_nonce_snapshot = db.Column(db.Integer, nullable=True)
    authorized_expiry_unix = db.Column(db.BigInteger, nullable=True)
    authorized_signature_hex = db.Column(db.Text, nullable=True)
    authorized_digest_hex = db.Column(db.String(66), nullable=True)

    # Execute timing (ms): last POST /execute wall time; cumulative sum across all execute chunks for this batch.
    last_execute_chunk_wall_ms = db.Column(db.Integer, nullable=True)
    cumulative_execute_wall_ms = db.Column(db.Integer, nullable=True)

    university = db.relationship("University", back_populates="mint_batches")
    created_by = db.relationship(
        "User",
        foreign_keys=[created_by_user_id],
        back_populates="mint_batches_created",
    )
    rows = db.relationship(
        "MintBatchRow",
        back_populates="batch",
        cascade="all, delete-orphan",
    )


class MintBatchRow(db.Model):
    """One CSV row; email and student_internal_id are DB-only (never pinned to IPFS)."""

    __tablename__ = "mint_batch_rows"
    __table_args__ = (db.UniqueConstraint("batch_id", "row_index", name="uq_mint_batch_row_batch_index"),)

    id = db.Column(db.Integer, primary_key=True)
    batch_id = db.Column(db.Integer, db.ForeignKey("mint_batches.id"), nullable=False, index=True)
    row_index = db.Column(db.Integer, nullable=False)
    raw_json = db.Column(db.Text, nullable=True)
    raw_csv_line = db.Column(db.Text, nullable=True)

    cert_id = db.Column(db.String(128), nullable=True, index=True)
    student_internal_id = db.Column(db.String(128), nullable=True)
    student_email = db.Column(db.String(255), nullable=True)
    student_full_name = db.Column(db.String(512), nullable=True)
    degree_title = db.Column(db.String(512), nullable=True)
    issue_date = db.Column(db.String(32), nullable=True)
    image_ipfs_uri = db.Column(db.String(512), nullable=True)

    validation_errors = db.Column(db.Text, nullable=True)
    row_status = db.Column(db.String(32), nullable=False, default="pending_validation", index=True)

    metadata_uri = db.Column(db.String(512), nullable=True)
    core_hash = db.Column(db.String(66), nullable=True)
    token_id = db.Column(db.Integer, nullable=True, index=True)
    tx_hash = db.Column(db.String(66), nullable=True)
    error_message = db.Column(db.Text, nullable=True)

    prepared_at = db.Column(db.DateTime, nullable=True)
    minted_at = db.Column(db.DateTime, nullable=True)
    emailed_at = db.Column(db.DateTime, nullable=True)

    # Mint timing (ms), set when row is successfully minted on execute (advisory / operational metrics).
    prepare_to_mint_ms = db.Column(db.Integer, nullable=True)
    platform_mint_ms = db.Column(db.Integer, nullable=True)

    batch = db.relationship("MintBatch", back_populates="rows")


class CertificateRecord(db.Model):
    """Off-chain index for dashboards; source of truth remains chain + IPFS."""

    __tablename__ = "certificate_records"

    id = db.Column(db.Integer, primary_key=True)
    token_id = db.Column(db.Integer, unique=True, nullable=False, index=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=False)
    cert_id = db.Column(db.String(128), unique=True, nullable=True, index=True)
    ipfs_uri = db.Column(db.String(512), nullable=False)
    core_hash = db.Column(db.String(66), nullable=True)
    status = db.Column(db.String(32), nullable=False, default="issued")
    supersedes_token_id = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Single-mint: Ed25519-signed JSON stored in DB (not IPFS). Issuer-only contact keys (not in pinned JSON).
    signed_metadata_json = db.Column(db.Text, nullable=True)
    student_internal_id = db.Column(db.String(128), nullable=True)
    student_email = db.Column(db.String(255), nullable=True)

    university = db.relationship("University", back_populates="certificates")


class StudentClaimRequest(db.Model):
    """Student-initiated request to move an escrowed token to their wallet (issuer executes `claim` on-chain)."""

    __tablename__ = "student_claim_requests"

    id = db.Column(db.Integer, primary_key=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=False, index=True)
    mint_batch_row_id = db.Column(db.Integer, db.ForeignKey("mint_batch_rows.id"), nullable=True, index=True)
    token_id = db.Column(db.Integer, nullable=False, index=True)
    cert_id = db.Column(db.String(128), nullable=True)
    student_internal_id = db.Column(db.String(128), nullable=False)
    student_email = db.Column(db.String(255), nullable=False)
    wallet_address = db.Column(db.String(42), nullable=False)
    status = db.Column(db.String(24), nullable=False, default="pending", index=True)
    rejection_reason = db.Column(db.Text, nullable=True)
    decided_at = db.Column(db.DateTime, nullable=True)
    decided_by_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    claim_tx_hash = db.Column(db.String(66), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    university = db.relationship("University", backref=db.backref("student_claim_requests", lazy="dynamic"))
    mint_batch_row = db.relationship("MintBatchRow", foreign_keys=[mint_batch_row_id])
    decided_by = db.relationship("User", foreign_keys=[decided_by_user_id])


class MintAuthorizationRequest(db.Model):
    """Pending single-mint EIP-712 authorization (prepare → sign → submit)."""

    __tablename__ = "mint_authorization_requests"

    id = db.Column(db.String(36), primary_key=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=False, index=True)
    cert_id = db.Column(db.String(128), nullable=False)
    core_hash = db.Column(db.String(66), nullable=False)
    metadata_uri = db.Column(db.String(512), nullable=False)
    expected_token_id = db.Column(db.Integer, nullable=False)
    student_internal_id = db.Column(db.String(128), nullable=True)
    student_email = db.Column(db.String(255), nullable=True)
    signed_metadata_json = db.Column(db.Text, nullable=True)
    commitment_hex = db.Column(db.String(66), nullable=False)
    nonce_snapshot = db.Column(db.Integer, nullable=False)
    expiry_unix = db.Column(db.BigInteger, nullable=False)
    status = db.Column(db.String(24), nullable=False, default="pending")
    failure_code = db.Column(db.String(64), nullable=True)
    signature_hex = db.Column(db.Text, nullable=True)
    digest_hex = db.Column(db.String(66), nullable=True)
    minter_tx_hash = db.Column(db.String(66), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Set when status becomes minted: wall prepare→submit and platform mint+receipt segment (ms).
    completed_at = db.Column(db.DateTime, nullable=True)
    prepare_to_complete_ms = db.Column(db.Integer, nullable=True)
    platform_mint_ms = db.Column(db.Integer, nullable=True)


class ActivityLog(db.Model):
    __tablename__ = "activity_logs"
    __table_args__ = (db.UniqueConstraint("tx_hash", "log_index", name="uq_activity_tx_log"),)

    id = db.Column(db.Integer, primary_key=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=True, index=True)
    token_id = db.Column(db.Integer, nullable=True, index=True)
    action = db.Column(db.String(64), nullable=False, index=True)
    tx_hash = db.Column(db.String(66), nullable=False, index=True)
    log_index = db.Column(db.Integer, nullable=False)
    block_number = db.Column(db.Integer, nullable=False, index=True)
    block_timestamp = db.Column(db.DateTime, nullable=True, index=True)
    actor = db.Column(db.String(42), nullable=True)
    details_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)


class Notification(db.Model):
    __tablename__ = "notifications"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    kind = db.Column(db.String(64), nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    body = db.Column(db.Text, nullable=False)
    payload_json = db.Column(db.Text, nullable=True)
    read_at = db.Column(db.DateTime, nullable=True, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
