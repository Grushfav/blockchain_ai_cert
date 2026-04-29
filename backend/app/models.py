from datetime import datetime

from werkzeug.security import generate_password_hash, check_password_hash

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

    university = db.relationship("University", back_populates="certificates")


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
