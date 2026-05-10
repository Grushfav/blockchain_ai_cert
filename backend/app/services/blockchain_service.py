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


def _build_and_send_raw_tx(
    w3: Web3,
    contract: Contract,
    account: Any,
    fn_name: str,
    *args: Any,
) -> dict[str, Any]:
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
    return dict(receipt)


def send_contract_tx(
    w3: Web3,
    contract: Contract,
    private_key_hex: str,
    fn_name: str,
    *args: Any,
) -> str:
    account = Account.from_key(private_key_hex)
    receipt = _build_and_send_raw_tx(w3, contract, account, fn_name, *args)
    th = receipt["transactionHash"]
    return th.hex() if hasattr(th, "hex") else str(th)


def minter_account_address() -> str:
    pk = (Config.TRUCERT_MINTER_PRIVATE_KEY or "").strip()
    if not pk:
        raise ValueError("TRUCERT_MINTER_PRIVATE_KEY is not set")
    return Account.from_key(pk).address


def mint_for_issuer(
    w3: Web3,
    contract: Contract,
    issuer_checksum: str,
    uri: str,
    core_hash_hex: str,
    cert_id: str,
) -> tuple[int, str]:
    """Platform minter submits mintForIssuer; returns (token_id, tx_hash_hex)."""
    pk = (Config.TRUCERT_MINTER_PRIVATE_KEY or "").strip()
    if not pk:
        raise ValueError("TRUCERT_MINTER_PRIVATE_KEY is not set")
    ch = (core_hash_hex or "").strip()
    if not ch.startswith("0x"):
        ch = "0x" + ch
    core_bytes = Web3.to_bytes(hexstr=ch)
    account = Account.from_key(pk)
    receipt = _build_and_send_raw_tx(
        w3,
        contract,
        account,
        "mintForIssuer",
        Web3.to_checksum_address(issuer_checksum),
        uri,
        core_bytes,
        cert_id,
    )
    processed = contract.events.CertificateMinted().process_receipt(receipt)
    want_cert = str(cert_id).strip()
    token_id: int | None = None
    for lg in processed:
        args = lg["args"]
        if str(args.get("certId", "")).strip() != want_cert:
            continue
        token_id = int(args.get("tokenId", 0))
        break
    if token_id is None:
        raise RuntimeError("mintForIssuer receipt missing matching CertificateMinted log")
    th = receipt["transactionHash"]
    tx_hex = th.hex() if hasattr(th, "hex") else str(th)
    if not tx_hex.startswith("0x"):
        tx_hex = "0x" + tx_hex
    return token_id, tx_hex


def _safe_event_logs(event: Any, *, from_block: int, to_block: int, argument_filters: dict[str, Any] | None = None, step: int = 2000) -> list[Any]:
    """Fetch logs in windows to avoid RPC block-range limits."""
    logs: list[Any] = []
    start = max(0, int(from_block))
    end = max(start, int(to_block))
    while start <= end:
        current_step = max(1, int(step))
        while True:
            chunk_end = min(start + current_step - 1, end)
            kwargs: dict[str, Any] = {"fromBlock": start, "toBlock": chunk_end}
            if argument_filters is not None:
                kwargs["argument_filters"] = argument_filters
            try:
                logs.extend(event.get_logs(**kwargs))
                start = chunk_end + 1
                break
            except Exception as e:
                msg = str(e).lower()
                if "block range exceeds configured limit" in msg and current_step > 1:
                    current_step = max(1, current_step // 2)
                    continue
                raise
    return logs


def find_minted_token_id_by_cert_id(w3: Web3, contract: Contract, *, issuer: str, cert_id: str, from_block: int = 0) -> int | None:
    """Scan CertificateMinted logs for an issuer and return tokenId for a cert_id (if found)."""
    try:
        to_block = int(w3.eth.block_number)
    except Exception:
        to_block = 0
    # Clamp scan window to reduce RPC load / rate limiting.
    scan_window = max(10_000, int(getattr(Config, "RECONCILE_SCAN_BLOCKS", 200_000)))
    if int(from_block) <= 0 and to_block > scan_window:
        from_block = max(0, to_block - scan_window)
    issuer_cs = Web3.to_checksum_address(issuer)
    want = str(cert_id).strip()
    try:
        logs = _safe_event_logs(
            contract.events.CertificateMinted,
            from_block=from_block,
            to_block=to_block,
            argument_filters={"issuer": issuer_cs},
        )
    except Exception:
        return None
    for ev in logs:
        try:
            args = ev["args"]
            if str(args.get("certId", "")).strip() != want:
                continue
            return int(args.get("tokenId", 0))
        except Exception:
            continue
    return None


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


def escrow_claim_eligibility(*, token_id: int, issuer_wallet: str) -> tuple[bool, str | None]:
    """True when the token is still escrowed with the issuer (valid, not locked, owner == issuer)."""
    try:
        w3 = get_w3()
        c = get_contract(w3)
        info = read_certificate_public(w3, c, int(token_id))
    except Exception:
        return False, "Could not read on-chain status; try again later."
    if not info.get("exists"):
        return False, "Token does not exist on-chain."
    if not info.get("valid"):
        return False, "This credential has been revoked on-chain."
    if info.get("locked"):
        return False, "This credential is already soulbound (claimed)."
    try:
        issuer_cs = Web3.to_checksum_address(issuer_wallet)
        chain_issuer = Web3.to_checksum_address(info["issuer_address"])
        owner_cs = Web3.to_checksum_address(info["owner_address"])
    except Exception:
        return False, "Invalid wallet or on-chain addresses."
    if chain_issuer != issuer_cs:
        return False, "This token was not issued by the selected institution wallet."
    if owner_cs != issuer_cs:
        return False, "This token is not held in the institution escrow wallet (it may already be claimed)."
    return True, None
