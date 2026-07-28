"""Helpers for the off-chain certificate_records index (prepare reservations + sync)."""

from __future__ import annotations

from app.extensions import db
from app.models import CertificateRecord


def reserve_prepared_certificate_record(
    *,
    university_id: int,
    cert_id: str | None,
    ipfs_uri: str,
    core_hash: str | None,
    preferred_token_id: int,
    signed_metadata_json: str | None = None,
    student_internal_id: str | None = None,
    student_email: str | None = None,
    supersedes_token_id: int | None = None,
) -> tuple[CertificateRecord, int]:
    """
    Create or refresh a prepared CertificateRecord without clobbering other rows.

    Prefer an existing row for this cert_id (same university). Otherwise allocate the
    lowest token_id at or above preferred_token_id that is not already taken — never
    overwrite issued/revoked/other-university/other-cert reservations.
    """
    cid = (cert_id or "").strip() or None
    if cid:
        existing = CertificateRecord.query.filter_by(cert_id=cid).first()
        if existing:
            if int(existing.university_id) != int(university_id):
                raise ValueError("cert_id already belongs to another university")
            status = (existing.status or "").lower()
            if status not in ("prepared",):
                raise ValueError(f"cert_id already exists with status {status}")
            existing.ipfs_uri = ipfs_uri
            if core_hash is not None:
                existing.core_hash = core_hash
            existing.status = "prepared"
            if signed_metadata_json is not None:
                existing.signed_metadata_json = signed_metadata_json
            if student_internal_id is not None:
                existing.student_internal_id = student_internal_id
            if student_email is not None:
                existing.student_email = student_email
            if supersedes_token_id is not None:
                existing.supersedes_token_id = supersedes_token_id
            return existing, int(existing.token_id)

    token_id = int(preferred_token_id)
    while CertificateRecord.query.filter_by(token_id=token_id).first() is not None:
        token_id += 1

    rec = CertificateRecord(
        token_id=token_id,
        university_id=int(university_id),
        cert_id=cid,
        ipfs_uri=ipfs_uri,
        core_hash=core_hash,
        status="prepared",
        signed_metadata_json=signed_metadata_json,
        student_internal_id=student_internal_id,
        student_email=student_email,
        supersedes_token_id=supersedes_token_id,
    )
    db.session.add(rec)
    return rec, token_id
