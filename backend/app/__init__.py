import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from flask import make_response, request

from app.config import Config
from app.extensions import db, jwt
from app.models import User


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

    app.register_blueprint(api_bp)

    with app.app_context():
        db.create_all()
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
