import os
from pathlib import Path

# Stable DB path regardless of cwd (relative sqlite:///truecert.db breaks when the IDE runs Flask from the repo root).
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_INSTANCE_DIR = _BACKEND_DIR / "instance"


def _default_sqlite_uri() -> str:
    _INSTANCE_DIR.mkdir(exist_ok=True)
    db_path = _INSTANCE_DIR / "truecert.db"
    legacy_db_path = _INSTANCE_DIR / "trucert.db"
    if not db_path.exists() and legacy_db_path.exists():
        db_path = legacy_db_path
    db_path = db_path.resolve()
    return f"sqlite:///{db_path.as_posix()}"


def _env(primary: str, legacy: str = "") -> str:
    """Read env var; fall back to legacy TRUCERT_* names from older deployments."""
    v = (os.environ.get(primary) or "").strip()
    if v:
        return v
    return (os.environ.get(legacy) or "").strip() if legacy else ""


def _normalize_database_url(raw: str) -> str:
    """Use psycopg v3 (requirements.txt); Neon often gives postgresql:// which defaults to psycopg2."""
    url = (raw or "").strip()
    if not url:
        return url
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://") :]
    if url.startswith("postgresql+psycopg2://"):
        return "postgresql+psycopg://" + url[len("postgresql+psycopg2://") :]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY") or "dev-change-me"
    _database_url = (os.environ.get("DATABASE_URL") or "").strip()
    SQLALCHEMY_DATABASE_URI = (
        _normalize_database_url(_database_url) if _database_url else _default_sqlite_uri()
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or SECRET_KEY
    JWT_ACCESS_TOKEN_EXPIRES = False

    POLYGON_AMOY_RPC_URL = os.environ.get("POLYGON_AMOY_RPC_URL", "https://rpc-amoy.polygon.technology")
    POLYGON_AMOY_RPC_FALLBACK_URLS = os.environ.get(
        "POLYGON_AMOY_RPC_FALLBACK_URLS",
        "https://polygon-amoy-bor-rpc.publicnode.com",
    )
    TRUECERT_CONTRACT_ADDRESS = _env("TRUECERT_CONTRACT_ADDRESS", "TRUCERT_CONTRACT_ADDRESS")

    # Signs whitelist / admin contract calls (must be contract owner).
    CONTRACT_OWNER_PRIVATE_KEY = os.environ.get("CONTRACT_OWNER_PRIVATE_KEY", "")

    # Platform minter hot wallet — submits mintForIssuer after EIP-712 university authorization.
    TRUECERT_MINTER_PRIVATE_KEY = _env("TRUECERT_MINTER_PRIVATE_KEY", "TRUCERT_MINTER_PRIVATE_KEY")

    # EIP-712 ({MintAuthorization},{BatchMintAuthorization}) — domain matches MetaMask / ethers signTypedData.
    EIP712_DOMAIN_NAME = os.environ.get("EIP712_DOMAIN_NAME", "TrueCert")
    EIP712_DOMAIN_VERSION = os.environ.get("EIP712_DOMAIN_VERSION", "1")
    EIP712_CHAIN_ID = int(os.environ.get("EIP712_CHAIN_ID", "80002"))
    # Optional override; defaults to TRUECERT_CONTRACT_ADDRESS (the TrueCert ERC-721).
    EIP712_VERIFYING_CONTRACT = os.environ.get("EIP712_VERIFYING_CONTRACT", "").strip()

    PINATA_JWT = os.environ.get("PINATA_JWT", "")
    PINATA_GATEWAY_BASE = os.environ.get("PINATA_GATEWAY_BASE", "https://gateway.pinata.cloud/ipfs")

    # Absolute base (no trailing slash) for single-mint tokenURI: {base}/api/public/metadata/<token_id>
    # PUBLIC_METADATA_BASE_URI is accepted as a typo-tolerant alias.
    _pub_meta = (os.environ.get("PUBLIC_METADATA_BASE_URL") or os.environ.get("PUBLIC_METADATA_BASE_URI") or "").strip()
    PUBLIC_METADATA_BASE_URL = _pub_meta.rstrip("/")

    # Metadata signature (Ed25519) settings.
    TRUECERT_SIG_KID = _env("TRUECERT_SIG_KID", "TRUCERT_SIG_KID")
    TRUECERT_SIG_PRIVATE_KEY = _env("TRUECERT_SIG_PRIVATE_KEY", "TRUCERT_SIG_PRIVATE_KEY")
    # JSON map {"kid": "base64-or-hex-encoded-public-key", ...}
    TRUECERT_SIG_PUBLIC_KEYS = _env("TRUECERT_SIG_PUBLIC_KEYS", "TRUCERT_SIG_PUBLIC_KEYS")

    UNIVERSITY_LOGO_MAX_BYTES = int(os.environ.get("UNIVERSITY_LOGO_MAX_BYTES", str(2 * 1024 * 1024)))
    MINT_BATCH_MAX_ROWS = int(os.environ.get("MINT_BATCH_MAX_ROWS", "500"))

    # Reconciliation scans CertificateMinted logs for cert_id → token_id. Keep this window small to avoid RPC rate limits.
    RECONCILE_SCAN_BLOCKS = int(os.environ.get("RECONCILE_SCAN_BLOCKS", "200000"))

    # Optional Google Gemini (Developer API). Backend runs fine with these unset.
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
    GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
    # Verify /explain cache: keys are SHA-256 of canonical sanitized payload + model (safe long TTL).
    GEMINI_VERIFY_EXPLAIN_CACHE_TTL_SECONDS = int(
        os.environ.get("GEMINI_VERIFY_EXPLAIN_CACHE_TTL_SECONDS", str(24 * 3600))
    )
    GEMINI_VERIFY_EXPLAIN_CACHE_MAX_ENTRIES = int(os.environ.get("GEMINI_VERIFY_EXPLAIN_CACHE_MAX_ENTRIES", "500"))
    # Risk hints AI summary: short TTL (rolling windows / DB change often).
    GEMINI_RISK_SUMMARY_CACHE_TTL_SECONDS = int(os.environ.get("GEMINI_RISK_SUMMARY_CACHE_TTL_SECONDS", "180"))
