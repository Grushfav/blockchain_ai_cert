import base64
import hashlib

from cryptography.fernet import Fernet


def fernet_from_secret(secret: str) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_private_key(secret: str, private_key_hex: str) -> str:
    f = fernet_from_secret(secret)
    return f.encrypt(private_key_hex.encode("utf-8")).decode("utf-8")


def decrypt_private_key(secret: str, encrypted: str) -> str:
    f = fernet_from_secret(secret)
    return f.decrypt(encrypted.encode("utf-8")).decode("utf-8")
