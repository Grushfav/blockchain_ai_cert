# TruCert (COMP 3901 capstone)

Blockchain-based academic certificate verification: **Polygon Amoy** (testnet), **ERC-721 + escrow + soulbound**, **IPFS metadata via Pinata**, **Flask API + SQLite**, **React (Vite + TypeScript) verifier UI**.

## Repository layout

| Path | Purpose |
|------|---------|
| `contracts/TruCert.sol` | ERC-721: whitelist issuers, mint to escrow, claim (lock), revoke |
| `hardhat.config.js` | Solidity 0.8.27, `polygonAmoy` network |
| `scripts/deploy.js` | Deploy contract (owner = deployer) |
| `test/TruCert.js` | Hardhat tests |
| `backend/` | Flask REST API, DB, Web3 + Pinata |
| `frontend/` | Employer verification UI |

## On-chain vs off-chain

**On-chain (minimal):** `tokenId`, `ownerOf` (ERC-721), `issuerOf`, `locked`, `valid`, `tokenURI` (IPFS link).

**Off-chain JSON (Pinata):** `student_full_name`, `degree_title`, `institution_name`, `gpa_honors`, `issue_date` (plus `format: trucert-v1`).

## Prerequisites

- Node.js 18+ (Hardhat + frontend)
- Python 3.11+ (backend)
- MetaMask or another wallet with **Amoy MATIC** ([faucet](https://faucet.polygon.technology/))

## 1. Smart contract (local + Amoy)

```powershell
cd Capstone\blockchain_ai_cert
npm install
npx hardhat compile
npx hardhat test
```

Deploy to Amoy (set `DEPLOYER_PRIVATE_KEY` in environment — same key must back `CONTRACT_OWNER_PRIVATE_KEY` in the backend so you can whitelist issuers):

```powershell
$env:DEPLOYER_PRIVATE_KEY="0x..."   # funded Amoy account
npx hardhat run scripts/deploy.js --network polygonAmoy
```

Copy the printed contract address into `backend/.env` as `TRUCERT_CONTRACT_ADDRESS`.

## 2. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# Edit .env: SECRET_KEY, TRUCERT_CONTRACT_ADDRESS, CONTRACT_OWNER_PRIVATE_KEY, PINATA_JWT, optional BOOTSTRAP_ADMIN_*
python run.py
```

API base URL: `http://127.0.0.1:5000/api/`.

**University registration:** `POST /api/auth/register-university` with `issuer_private_key` (32-byte hex). The backend derives the wallet address, encrypts the key at rest (Fernet + `SECRET_KEY`), and stores it until mint/claim.

**Admin:** If `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` are set, the first startup creates an admin user. Use `POST /api/auth/login`, then `POST /api/admin/universities/<id>/approve` to whitelist the university wallet on-chain and mark the university verified.

**Mint / claim / revoke:** See `backend/app/routes/api.py` (`/api/university/certificates`, `/claim`, `/revoke`).

## 3. Frontend (verifier)

```powershell
cd frontend
npm install
npm run dev
```

Open the printed URL (default `http://127.0.0.1:5173`). The dev server proxies `/api` to Flask.

**React shell routes:** `/` employer verify · `/login` · `/register` university signup · `/admin` (JWT admin) approve/reject · `/university` (JWT university) mint / claim / revoke.

Production build: `npm run build` → static files in `frontend/dist/`.

## API quick reference

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register-university` | — |
| POST | `/api/auth/login` | — |
| GET | `/api/admin/universities?status=pending` | admin JWT |
| POST | `/api/admin/universities/<id>/approve` | admin JWT |
| POST | `/api/admin/universities/<id>/reject` | admin JWT |
| GET | `/api/university/me` | university JWT |
| POST | `/api/university/certificates` | university JWT (mint) |
| POST | `/api/university/certificates/<token_id>/claim` | university JWT |
| POST | `/api/university/certificates/<token_id>/revoke` | university or admin JWT |
| GET | `/api/verify/<token_id>` | public |

## Security notes (capstone / demo)

- Never commit real private keys. Use Amoy-only keys and rotate Pinata JWT if leaked.
- Issuer keys are encrypted at rest but depend on `SECRET_KEY`; use a strong secret in production.
- For production, replace SQLite, use a proper key vault for signing keys, and add rate limits on public verify.

## License

MIT (capstone / educational use).
