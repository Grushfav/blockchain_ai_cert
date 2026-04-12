import json
from pathlib import Path
from typing import Any

from eth_account import Account
from web3 import Web3
from web3.contract import Contract
from web3.middleware import geth_poa_middleware

from app.config import Config


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _load_abi() -> list[dict[str, Any]]:
    p = _project_root() / "artifacts" / "contracts" / "TruCert.sol" / "TruCert.json"
    if not p.is_file():
        raise FileNotFoundError(f"Compile contracts first; missing ABI at {p}")
    with p.open(encoding="utf-8") as f:
        return json.load(f)["abi"]


def get_w3() -> Web3:
    w3 = Web3(Web3.HTTPProvider(Config.POLYGON_AMOY_RPC_URL))
    # Polygon (Amoy) reports extraData length incompatible with default validator
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    return w3


def get_contract(w3: Web3) -> Contract:
    addr = Config.TRUCERT_CONTRACT_ADDRESS
    if not addr:
        raise ValueError("TRUCERT_CONTRACT_ADDRESS is not set")
    return w3.eth.contract(address=Web3.to_checksum_address(addr), abi=_load_abi())


def send_contract_tx(
    w3: Web3,
    contract: Contract,
    private_key_hex: str,
    fn_name: str,
    *args: Any,
) -> str:
    account = Account.from_key(private_key_hex)
    fn = getattr(contract.functions, fn_name)
    base: dict[str, Any] = {
        "from": account.address,
        "nonce": w3.eth.get_transaction_count(account.address),
        "chainId": w3.eth.chain_id,
    }
    latest = w3.eth.get_block("latest")
    base_fee = latest.get("baseFeePerGas")
    if base_fee is not None:
        # Polygon Amoy enforces a high minimum tip (often ~25 gwei); 2 gwei fails.
        min_tip = Web3.to_wei(30, "gwei")
        try:
            suggested = int(w3.eth.max_priority_fee)
        except Exception:
            suggested = 0
        priority = max(suggested, min_tip)
        base["maxPriorityFeePerGas"] = priority
        base["maxFeePerGas"] = base_fee * 2 + priority
    else:
        base["gasPrice"] = w3.eth.gas_price

    built = fn(*args).build_transaction(base)
    built.setdefault("gas", int(w3.eth.estimate_gas(built) * 1.2))
    signed = account.sign_transaction(built)
    raw = signed.raw_transaction if hasattr(signed, "raw_transaction") else signed.rawTransaction
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if receipt["status"] != 1:
        raise RuntimeError(f"Transaction failed: {tx_hash.hex()}")
    return tx_hash.hex()


def set_issuer_whitelisted(w3: Web3, contract: Contract, issuer: str, allowed: bool) -> str:
    pk = Config.CONTRACT_OWNER_PRIVATE_KEY
    if not pk:
        raise ValueError("CONTRACT_OWNER_PRIVATE_KEY is not set")
    return send_contract_tx(
        w3,
        contract,
        pk,
        "setIssuerWhitelisted",
        Web3.to_checksum_address(issuer),
        allowed,
    )


def mint_to_escrow(
    w3: Web3,
    contract: Contract,
    issuer_private_key: str,
    token_id: int,
    token_uri: str,
) -> str:
    return send_contract_tx(
        w3,
        contract,
        issuer_private_key,
        "mintToEscrow",
        token_id,
        token_uri,
    )


def claim_certificate(
    w3: Web3,
    contract: Contract,
    issuer_private_key: str,
    token_id: int,
    student_wallet: str,
) -> str:
    return send_contract_tx(
        w3,
        contract,
        issuer_private_key,
        "claim",
        token_id,
        Web3.to_checksum_address(student_wallet),
    )


def revoke_certificate(
    w3: Web3,
    contract: Contract,
    signer_private_key: str,
    token_id: int,
) -> str:
    return send_contract_tx(
        w3,
        contract,
        signer_private_key,
        "revokeCertificate",
        token_id,
    )


def read_certificate_public(w3: Web3, contract: Contract, token_id: int) -> dict[str, Any]:
    """Read-only: on-chain verification fields + tokenURI."""
    try:
        owner = contract.functions.ownerOf(token_id).call()
    except Exception:
        return {"exists": False}

    issuer = contract.functions.issuerOf(token_id).call()
    locked = contract.functions.locked(token_id).call()
    valid = contract.functions.valid(token_id).call()
    uri = contract.functions.tokenURI(token_id).call()
    return {
        "exists": True,
        "token_id": token_id,
        "owner_address": owner,
        "issuer_address": issuer,
        "locked": locked,
        "valid": valid,
        "metadata_uri": uri,
    }
