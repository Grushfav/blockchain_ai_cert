import os
from pathlib import Path

# Stable DB path regardless of cwd (relative sqlite:///trucert.db breaks when the IDE runs Flask from the repo root).
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_INSTANCE_DIR = _BACKEND_DIR / "instance"


def _default_sqlite_uri() -> str:
    _INSTANCE_DIR.mkdir(exist_ok=True)
    db_path = (_INSTANCE_DIR / "trucert.db").resolve()
    return f"sqlite:///{db_path.as_posix()}"


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY") or "dev-change-me"
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL") or _default_sqlite_uri()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or SECRET_KEY
    JWT_ACCESS_TOKEN_EXPIRES = False

    POLYGON_AMOY_RPC_URL = os.environ.get("POLYGON_AMOY_RPC_URL", "https://rpc-amoy.polygon.technology")
    POLYGON_AMOY_RPC_FALLBACK_URLS = os.environ.get(
        "POLYGON_AMOY_RPC_FALLBACK_URLS",
        "https://polygon-amoy-bor-rpc.publicnode.com",
    )
    TRUCERT_CONTRACT_ADDRESS = os.environ.get("TRUCERT_CONTRACT_ADDRESS", "")

    # Signs whitelist / admin contract calls (must be contract owner).
    CONTRACT_OWNER_PRIVATE_KEY = os.environ.get("CONTRACT_OWNER_PRIVATE_KEY", "")

    PINATA_JWT = os.environ.get("PINATA_JWT", "")
    PINATA_GATEWAY_BASE = os.environ.get("PINATA_GATEWAY_BASE", "https://gateway.pinata.cloud/ipfs")

    # Metadata signature (Ed25519) settings.
    TRUCERT_SIG_KID = os.environ.get("TRUCERT_SIG_KID", "")
    TRUCERT_SIG_PRIVATE_KEY = os.environ.get("TRUCERT_SIG_PRIVATE_KEY", "")
    # JSON map {"kid": "base64-or-hex-encoded-public-key", ...}
    TRUCERT_SIG_PUBLIC_KEYS = os.environ.get("TRUCERT_SIG_PUBLIC_KEYS", "")

    UNIVERSITY_LOGO_MAX_BYTES = int(os.environ.get("UNIVERSITY_LOGO_MAX_BYTES", str(2 * 1024 * 1024)))
