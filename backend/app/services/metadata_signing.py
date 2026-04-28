from __future__ import annotations

import base64
import json
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from app.config import Config

SIG_FIELDS = {"trucert_sig_v", "trucert_sig_kid", "trucert_sig_alg", "trucert_sig"}


def _decode_key_bytes(raw: str) -> bytes:
    s = raw.strip()
    if not s:
        raise ValueError("Missing key material")
    if s.startswith("0x"):
        s = s[2:]
    try:
        return bytes.fromhex(s)
    except ValueError:
        return base64.b64decode(s)


def canonical_payload_bytes(payload: dict[str, Any]) -> bytes:
    core = {k: v for k, v in payload.items() if k not in SIG_FIELDS}
    canonical = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return canonical.encode("utf-8")


def sign_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    if not Config.TRUCERT_SIG_PRIVATE_KEY or not Config.TRUCERT_SIG_KID:
        raise ValueError("TRUCERT_SIG_PRIVATE_KEY or TRUCERT_SIG_KID not configured")
    private_bytes = _decode_key_bytes(Config.TRUCERT_SIG_PRIVATE_KEY)
    private_key = Ed25519PrivateKey.from_private_bytes(private_bytes)
    signature = private_key.sign(canonical_payload_bytes(payload))
    out = dict(payload)
    out["trucert_sig_v"] = 1
    out["trucert_sig_kid"] = Config.TRUCERT_SIG_KID
    out["trucert_sig_alg"] = "ed25519"
    out["trucert_sig"] = base64.b64encode(signature).decode("utf-8")
    return out


def _public_key_map() -> dict[str, Ed25519PublicKey]:
    if not Config.TRUCERT_SIG_PUBLIC_KEYS:
        return {}
    raw_map = json.loads(Config.TRUCERT_SIG_PUBLIC_KEYS)
    out: dict[str, Ed25519PublicKey] = {}
    for kid, raw in raw_map.items():
        out[str(kid)] = Ed25519PublicKey.from_public_bytes(_decode_key_bytes(str(raw)))
    return out


def verify_metadata_signature(payload: dict[str, Any]) -> tuple[bool, str | None]:
    kid = payload.get("trucert_sig_kid")
    sig_b64 = payload.get("trucert_sig")
    alg = payload.get("trucert_sig_alg")
    if not kid or not sig_b64 or alg != "ed25519":
        return False, "Missing or invalid signature metadata"
    pubkeys = _public_key_map()
    key = pubkeys.get(str(kid))
    if not key:
        return False, f"Unknown signature key id: {kid}"
    try:
        key.verify(base64.b64decode(str(sig_b64)), canonical_payload_bytes(payload))
        return True, None
    except Exception as e:
        return False, str(e)
