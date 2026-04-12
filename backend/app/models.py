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
    private_key_encrypted = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(32), nullable=False, default="pending")
    kyc_notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    users = db.relationship("User", back_populates="university", lazy="dynamic")
    certificates = db.relationship("CertificateRecord", back_populates="university")


class CertificateRecord(db.Model):
    """Off-chain index for dashboards; source of truth remains chain + IPFS."""

    __tablename__ = "certificate_records"

    id = db.Column(db.Integer, primary_key=True)
    token_id = db.Column(db.Integer, unique=True, nullable=False, index=True)
    university_id = db.Column(db.Integer, db.ForeignKey("universities.id"), nullable=False)
    ipfs_uri = db.Column(db.String(512), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    university = db.relationship("University", back_populates="certificates")
