import os


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY") or "dev-change-me"
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL") or "sqlite:///trucert.db"
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or SECRET_KEY
    JWT_ACCESS_TOKEN_EXPIRES = False

    POLYGON_AMOY_RPC_URL = os.environ.get("POLYGON_AMOY_RPC_URL", "https://rpc-amoy.polygon.technology")
    TRUCERT_CONTRACT_ADDRESS = os.environ.get("TRUCERT_CONTRACT_ADDRESS", "")

    # Signs whitelist / admin contract calls (must be contract owner).
    CONTRACT_OWNER_PRIVATE_KEY = os.environ.get("CONTRACT_OWNER_PRIVATE_KEY", "")

    PINATA_JWT = os.environ.get("PINATA_JWT", "")
