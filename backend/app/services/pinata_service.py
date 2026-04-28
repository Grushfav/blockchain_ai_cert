from io import BytesIO
from typing import Any

import requests


def pin_certificate_metadata(
    token_id: int,
    metadata: dict[str, Any],
    pinata_jwt: str | None,
) -> str:
    """
    Upload JSON to Pinata; returns ipfs:// CID URI for tokenURI.
    """
    if not pinata_jwt:
        raise ValueError("PINATA_JWT is not configured")

    body = {
        "pinataContent": metadata,
        "pinataMetadata": {"name": f"trucert-{token_id}.json"},
    }
    r = requests.post(
        "https://api.pinata.cloud/pinning/pinJSONToIPFS",
        headers={
            "Authorization": f"Bearer {pinata_jwt}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    cid = data.get("IpfsHash")
    if not cid:
        raise RuntimeError(f"Unexpected Pinata response: {data}")
    return f"ipfs://{cid}"


def pin_file_bytes(
    filename: str,
    content: bytes,
    mime_type: str,
    pinata_jwt: str | None,
) -> str:
    if not pinata_jwt:
        raise ValueError("PINATA_JWT is not configured")
    files = {
        "file": (filename, BytesIO(content), mime_type),
    }
    r = requests.post(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        headers={"Authorization": f"Bearer {pinata_jwt}"},
        files=files,
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()
    cid = data.get("IpfsHash")
    if not cid:
        raise RuntimeError(f"Unexpected Pinata response: {data}")
    return f"ipfs://{cid}"
