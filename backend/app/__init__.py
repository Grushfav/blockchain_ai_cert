import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from flask import make_response, request

from app.config import Config
from app.extensions import db, jwt
from app.models import ActivityLog, CertificateRecord, MintBatch, MintBatchRow, University, User
from sqlalchemy import inspect, text


def create_app(config_class: type = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_class)

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
    from app.mint_batch_routes import register_mint_batch_routes

    register_mint_batch_routes(api_bp)
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

    with db.engine.begin() as conn:
        for stmt in statements:
            try:
                conn.execute(text(stmt))
            except Exception:
                if "DROP COLUMN" in stmt:
                    continue
                raise
