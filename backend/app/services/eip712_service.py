"""
EIP-712 typed data for university-signed mint authorizations (gasless signatures).

Commitments (Solidity-aligned, off-chain verified):
- Single mint: keccak256(abi.encode(certId, coreHash)) with coreHash as bytes32.
- Batch: inner = keccak256(abi.encodePacked(sorted row commitments)); each row commitment uses
  the same encoding as single; outer = keccak256(abi.encode(uint256 batchId, inner)).
"""

from __future__ import annotations

import time
from typing import Any

from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils.crypto import keccak
from web3 import Web3

from app.config import Config

EIP712_MINT_PRIMARY = "MintAuthorization"
EIP712_BATCH_PRIMARY = "BatchMintAuthorization"


def _core_hash_to_bytes(core_hash_hex: str) -> bytes:
    h = (core_hash_hex or "").strip()
    if h.startswith("0x"):
        h = h[2:]
    raw = bytes.fromhex(h)
    if len(raw) != 32:
        raise ValueError("core_hash must be 32 bytes")
    return raw


def single_mint_commitment(cert_id: str, core_hash_hex: str) -> bytes:
    """keccak256(abi.encode(string certId, bytes32 coreHash)) — matches Solidity."""
    core = _core_hash_to_bytes(core_hash_hex)
    return keccak(encode(["string", "bytes32"], [cert_id, core]))


def batch_mint_commitment(batch_id: int, row_commitments_32: list[bytes]) -> bytes:
    """Binds batch id + multiset of row commitments (order-independent via sorted pack)."""
    if any(len(x) != 32 for x in row_commitments_32):
        raise ValueError("each row commitment must be bytes32")
    packed = b"".join(sorted(row_commitments_32))
    inner = keccak(packed)
    return keccak(encode(["uint256", "bytes32"], [batch_id, inner]))


def get_verifying_contract_checksum() -> str:
    override = (Config.EIP712_VERIFYING_CONTRACT or "").strip()
    if override:
        return Web3.to_checksum_address(override)
    addr = (Config.TRUCERT_CONTRACT_ADDRESS or "").strip()
    if not addr:
        raise ValueError("TRUCERT_CONTRACT_ADDRESS is not set (needed for EIP-712 domain)")
    return Web3.to_checksum_address(addr)


def _domain_dict() -> dict[str, Any]:
    v = get_verifying_contract_checksum()
    return {
        "name": Config.EIP712_DOMAIN_NAME,
        "version": Config.EIP712_DOMAIN_VERSION,
        "chainId": int(Config.EIP712_CHAIN_ID),
        "verifyingContract": v,
    }


def mint_authorization_full_message(
    *,
    issuer_address: str,
    commitment: bytes,
    nonce: int,
    expiry_unix: int,
) -> dict[str, Any]:
    issuer = Web3.to_checksum_address(issuer_address)
    if len(commitment) != 32:
        raise ValueError("commitment must be 32 bytes")
    commitment_hex = Web3.to_hex(commitment)
    domain = _domain_dict()
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            EIP712_MINT_PRIMARY: [
                {"name": "issuer", "type": "address"},
                {"name": "commitment", "type": "bytes32"},
                {"name": "nonce", "type": "uint256"},
                {"name": "expiry", "type": "uint256"},
            ],
        },
        "primaryType": EIP712_MINT_PRIMARY,
        "domain": domain,
        "message": {
            "issuer": issuer,
            "commitment": commitment_hex,
            "nonce": int(nonce),
            "expiry": int(expiry_unix),
        },
    }


def batch_mint_authorization_full_message(
    *,
    issuer_address: str,
    batch_id: int,
    commitment: bytes,
    nonce: int,
    expiry_unix: int,
) -> dict[str, Any]:
    issuer = Web3.to_checksum_address(issuer_address)
    if len(commitment) != 32:
        raise ValueError("commitment must be 32 bytes")
    commitment_hex = Web3.to_hex(commitment)
    domain = _domain_dict()
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            EIP712_BATCH_PRIMARY: [
                {"name": "issuer", "type": "address"},
                {"name": "batchId", "type": "uint256"},
                {"name": "commitment", "type": "bytes32"},
                {"name": "nonce", "type": "uint256"},
                {"name": "expiry", "type": "uint256"},
            ],
        },
        "primaryType": EIP712_BATCH_PRIMARY,
        "domain": domain,
        "message": {
            "issuer": issuer,
            "batchId": int(batch_id),
            "commitment": commitment_hex,
            "nonce": int(nonce),
            "expiry": int(expiry_unix),
        },
    }


def typed_data_signable_hash_hex(full_message: dict[str, Any]) -> str:
    signable = encode_typed_data(full_message=full_message)
    # EIP-712: 0x1901 ‖ domainSeparator ‖ hashStruct(message)
    digest = keccak(b"\x19\x01" + signable.header + signable.body)
    return Web3.to_hex(digest)


def recover_typed_data_signer(full_message: dict[str, Any], signature_hex: str) -> str:
    sig = (signature_hex or "").strip()
    if not sig.startswith("0x"):
        sig = "0x" + sig
    raw = bytes.fromhex(sig[2:])
    signable = encode_typed_data(full_message=full_message)
    return Web3.to_checksum_address(Account.recover_message(signable, signature=raw))


def default_expiry_unix(ttl_seconds: int = 3600) -> int:
    return int(time.time()) + int(ttl_seconds)
