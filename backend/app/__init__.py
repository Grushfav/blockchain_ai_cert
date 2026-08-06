import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from flask import make_response, request

from app.config import Config
from app.extensions import db, jwt
from app.models import (
    ActivityLog,
    CertificateRecord,
    MintAuthorizationRequest,
    MintBatch,
    MintBatchRow,
    Notification,
    StudentClaimRequest,
    University,
    User,
)
from sqlalchemy import inspect, text


def create_app(config_class: type = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_class)
    if hasattr(config_class, "assert_secure_secrets"):
        config_class.assert_secure_secrets(testing=bool(app.config.get("TESTING")))

    # Flask-CORS resource regexes are easy to get wrong; browsers need OPTIONS preflight
    # to return CORS headers before the real POST. Handle OPTIONS early so we never 405.
    @app.before_request
    def _cors_preflight_api():
        if request.method != "OPTIONS" or not request.path.startswith("/api"):
            return None
        resp = make_response("", 204)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = (
            "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
        )
        req_headers = request.headers.get("Access-Control-Request-Headers")
        resp.headers["Access-Control-Allow-Headers"] = (
            req_headers or "Content-Type, Authorization"
        )
        resp.headers["Access-Control-Max-Age"] = "86400"
        return resp

    @app.after_request
    def _cors_on_api_responses(response):
        if request.path.startswith("/api"):
            response.headers.setdefault("Access-Control-Allow-Origin", "*")
        return response

    db.init_app(app)
    jwt.init_app(app)

    from app.routes.api import bp as api_bp
    from app.admin_analytics_routes import register_admin_analytics_routes
    from app.mint_batch_routes import register_mint_batch_routes
    from app.student_claim_routes import register_student_claim_routes
    from app.university_analytics_routes import register_university_analytics_routes

    register_mint_batch_routes(api_bp)
    register_admin_analytics_routes(api_bp)
    register_university_analytics_routes(api_bp)
    register_student_claim_routes(api_bp)
    app.register_blueprint(api_bp)

    with app.app_context():
        db.create_all()
        _apply_lightweight_migrations()
        _bootstrap_admin(app)

    return app


def _bootstrap_admin(app: Flask) -> None:
    email = os.environ.get("BOOTSTRAP_ADMIN_EMAIL")
    password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD")
    if not email or not password:
        return
    if User.query.filter_by(role="admin").first():
        return
    u = User(email=email.lower(), role="admin")
    u.set_password(password)
    db.session.add(u)
    db.session.commit()


def _apply_lightweight_migrations() -> None:
    inspector = inspect(db.engine)
    cols = {c["name"] for c in inspector.get_columns("certificate_records")}
    statements: list[str] = []
    if "cert_id" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN cert_id VARCHAR(128)")
        statements.append("CREATE UNIQUE INDEX IF NOT EXISTS ix_certificate_records_cert_id ON certificate_records (cert_id)")
    if "core_hash" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN core_hash VARCHAR(66)")
    if "status" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN status VARCHAR(32) DEFAULT 'issued'")
    if "supersedes_token_id" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN supersedes_token_id INTEGER")
    if "signed_metadata_json" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN signed_metadata_json TEXT")
    if "student_internal_id" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN student_internal_id VARCHAR(128)")
    if "student_email" not in cols:
        statements.append("ALTER TABLE certificate_records ADD COLUMN student_email VARCHAR(255)")

    uni_cols = {c["name"] for c in inspector.get_columns("universities")}
    if "logo_uri" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN logo_uri VARCHAR(512)")
    if "institution_contact_email" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_contact_email VARCHAR(255)")
    if "institution_contact_phone" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_contact_phone VARCHAR(64)")
    if "institution_website" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_website VARCHAR(255)")
    if "institution_license_id" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_license_id VARCHAR(128)")
    if "institution_license_authority" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_license_authority VARCHAR(255)")
    if "institution_license_valid_until" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_license_valid_until VARCHAR(32)")
    if "private_key_encrypted" in uni_cols:
        statements.append("ALTER TABLE universities DROP COLUMN private_key_encrypted")

    act_cols = {c["name"] for c in inspector.get_columns("activity_logs")}
    if "block_timestamp" not in act_cols:
        statements.append("ALTER TABLE activity_logs ADD COLUMN block_timestamp TIMESTAMP")

    if "eip712_nonce" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN eip712_nonce INTEGER DEFAULT 0")
    added_eip712_split = False
    if "eip712_single_nonce" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN eip712_single_nonce INTEGER DEFAULT 0")
        added_eip712_split = True
    if "eip712_batch_nonce" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN eip712_batch_nonce INTEGER DEFAULT 0")
        added_eip712_split = True
    if "expected_mints_monthly" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN expected_mints_monthly INTEGER")
    if "expected_mints_annually" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN expected_mints_annually INTEGER")
    if "operating_days_of_week" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN operating_days_of_week TEXT")
    if "operating_hours_start" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN operating_hours_start VARCHAR(8)")
    if "operating_hours_end" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN operating_hours_end VARCHAR(8)")
    if "operating_timezone" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN operating_timezone VARCHAR(128)")
    if "institution_documents_json" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN institution_documents_json TEXT")
    if "is_frozen" not in uni_cols:
        if db.engine.dialect.name == "postgresql":
            statements.append(
                "ALTER TABLE universities ADD COLUMN is_frozen BOOLEAN NOT NULL DEFAULT false"
            )
        else:
            statements.append("ALTER TABLE universities ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0")
    if "frozen_reason" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN frozen_reason TEXT")
    if "frozen_at" not in uni_cols:
        statements.append("ALTER TABLE universities ADD COLUMN frozen_at TIMESTAMP")

    mb_cols = {c["name"] for c in inspector.get_columns("mint_batches")}
    _mb_add = [
        ("authorized_commitment_hex", "VARCHAR(66)"),
        ("authorized_row_ids_json", "TEXT"),
        ("authorized_payload_json", "TEXT"),
        ("authorized_nonce_snapshot", "INTEGER"),
        ("authorized_expiry_unix", "INTEGER"),
        ("authorized_signature_hex", "TEXT"),
        ("authorized_digest_hex", "VARCHAR(66)"),
    ]
    for col, typ in _mb_add:
        if col not in mb_cols:
            statements.append(f"ALTER TABLE mint_batches ADD COLUMN {col} {typ}")
    if "last_execute_chunk_wall_ms" not in mb_cols:
        statements.append("ALTER TABLE mint_batches ADD COLUMN last_execute_chunk_wall_ms INTEGER")
    if "cumulative_execute_wall_ms" not in mb_cols:
        statements.append("ALTER TABLE mint_batches ADD COLUMN cumulative_execute_wall_ms INTEGER")

    if "mint_batch_rows" in inspector.get_table_names():
        mbr_cols = {c["name"] for c in inspector.get_columns("mint_batch_rows")}
        if "prepare_to_mint_ms" not in mbr_cols:
            statements.append("ALTER TABLE mint_batch_rows ADD COLUMN prepare_to_mint_ms INTEGER")
        if "platform_mint_ms" not in mbr_cols:
            statements.append("ALTER TABLE mint_batch_rows ADD COLUMN platform_mint_ms INTEGER")

    if "mint_authorization_requests" in inspector.get_table_names():
        mar_cols = {c["name"] for c in inspector.get_columns("mint_authorization_requests")}
        if "failure_code" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN failure_code VARCHAR(64)")
        if "completed_at" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN completed_at TIMESTAMP")
        if "prepare_to_complete_ms" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN prepare_to_complete_ms INTEGER")
        if "platform_mint_ms" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN platform_mint_ms INTEGER")
        if "student_internal_id" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN student_internal_id VARCHAR(128)")
        if "student_email" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN student_email VARCHAR(255)")
        if "signed_metadata_json" not in mar_cols:
            statements.append("ALTER TABLE mint_authorization_requests ADD COLUMN signed_metadata_json TEXT")

    with db.engine.begin() as conn:
        for stmt in statements:
            try:
                conn.execute(text(stmt))
            except Exception:
                if "DROP COLUMN" in stmt:
                    continue
                raise

    if added_eip712_split:
        with db.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE universities SET eip712_single_nonce = COALESCE(eip712_nonce, 0), "
                    "eip712_batch_nonce = COALESCE(eip712_nonce, 0)"
                )
            )

    # PostgreSQL: legacy is_frozen INTEGER (SQLite-era lightweight migration) vs SQLAlchemy Boolean.
    if db.engine.dialect.name == "postgresql":
        fix_is_frozen_type = text(
            """
            DO $migrate$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'universities'
                      AND column_name = 'is_frozen'
                      AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE universities ALTER COLUMN is_frozen DROP DEFAULT;
                    ALTER TABLE universities ALTER COLUMN is_frozen TYPE boolean
                        USING (CASE WHEN is_frozen = 0 THEN false ELSE true END);
                    ALTER TABLE universities ALTER COLUMN is_frozen SET DEFAULT false;
                END IF;
            END $migrate$;
            """
        )
        with db.engine.begin() as conn:
            conn.execute(fix_is_frozen_type)
