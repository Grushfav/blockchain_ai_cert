import json
from pathlib import Path
from typing import Any

from eth_account import Account
from web3 import Web3
from web3.contract import Contract
from web3.middleware import geth_poa_middleware

from app.config import Config

_last_good_rpc_url: str | None = None


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _load_abi() -> list[dict[str, Any]]:
    p = _project_root() / "artifacts" / "contracts" / "TruCert.sol" / "TruCert.json"
    if not p.is_file():
        raise FileNotFoundError(f"Compile contracts first; missing ABI at {p}")
    with p.open(encoding="utf-8") as f:
        return json.load(f)["abi"]


def _rpc_urls() -> list[str]:
    urls: list[str] = []
    primary = (Config.POLYGON_AMOY_RPC_URL or "").strip()
    if primary:
        urls.append(primary)
    raw_fallbacks = (Config.POLYGON_AMOY_RPC_FALLBACK_URLS or "").strip()
    if raw_fallbacks:
        for part in raw_fallbacks.split(","):
            u = part.strip()
            if u and u not in urls:
                urls.append(u)
    return urls


def _make_w3(url: str) -> Web3:
    w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))
    # Polygon (Amoy) reports extraData length incompatible with default validator
    w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    return w3


def get_w3() -> Web3:
    global _last_good_rpc_url
    urls = _rpc_urls()
    if not urls:
        raise ValueError("No Polygon Amoy RPC URL configured")

    if _last_good_rpc_url and _last_good_rpc_url in urls:
        urls = [_last_good_rpc_url] + [u for u in urls if u != _last_good_rpc_url]

    last_error: Exception | None = None
    for url in urls:
        try:
            w3 = _make_w3(url)
            # Probe the endpoint so callers don't fail later on first RPC call.
            _ = w3.eth.chain_id
            _last_good_rpc_url = url
            return w3
        except Exception as e:
            last_error = e
            continue
    raise RuntimeError(f"All configured Polygon Amoy RPC endpoints failed: {last_error}")


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
    core_hash = None
    try:
        raw_hash = contract.functions.coreHashOf(token_id).call()
        core_hash = raw_hash.hex() if hasattr(raw_hash, "hex") else str(raw_hash)
    except Exception:
        # Legacy contract deployments do not expose coreHashOf.
        core_hash = None
    return {
        "exists": True,
        "token_id": token_id,
        "owner_address": owner,
        "issuer_address": issuer,
        "locked": locked,
        "valid": valid,
        "metadata_uri": uri,
        "core_hash": core_hash,
    }
