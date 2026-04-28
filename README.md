# TruCert (COMP 3901 capstone)

Blockchain-based academic credential verification on **Polygon Amoy** with **Flask + SQLAlchemy**, **IPFS (Pinata)**, and a **React university portal** where issuer actions are wallet-signed only.

## Repository layout

| Path | Purpose |
|------|---------|
| `contracts/TruCert.sol` | ERC-721: whitelist issuers, mint to escrow, claim (lock), revoke, burn, reissue |
| `hardhat.config.js` | Solidity 0.8.27, `polygonAmoy` network |
| `scripts/deploy.js` | Deploy contract (owner = deployer) |
| `test/TruCert.js` | Hardhat tests |
| `backend/` | Flask REST API, SQLAlchemy models, metadata signing, Pinata integration |
| `frontend/` | Verify UI + university portal (wallet-signed issuance) |

## On-chain vs off-chain trust model

**On-chain:** `tokenId`, `issuerOf`, `ownerOf`, `locked`, `valid`, `tokenURI`, `coreHashOf`.

**Off-chain JSON (IPFS):** rich presentation fields + institution profile + Ed25519 signature envelope:
- `trucert_sig_v`
- `trucert_sig_kid`
- `trucert_sig_alg = ed25519`
- `trucert_sig` (base64)

Canonical signature payload is JSON-serialized with sorted keys and compact separators.

## Prerequisites

- Node.js 18+ (Hardhat + frontend)
- Python 3.11+ (backend)
- MetaMask or another **injected wallet** with **Amoy MATIC** ([faucet](https://faucet.polygon.technology/))

## 1. Smart contract (local + Amoy)

```powershell
cd blockchain_ai_cert
npm install
npx hardhat compile
npx hardhat test
```

Deploy to Amoy (`DEPLOYER_PRIVATE_KEY` must match `CONTRACT_OWNER_PRIVATE_KEY` for admin whitelist API actions):

```powershell
$env:DEPLOYER_PRIVATE_KEY="0x..."   # funded Amoy account
npx hardhat run scripts/deploy.js --network polygonAmoy
```

Copy the printed contract address into `backend/.env` as `TRUCERT_CONTRACT_ADDRESS`.

## 2. Backend setup (Neon Postgres or SQLite fallback)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# Create .env with values listed below
python run.py
```

API base URL: `http://127.0.0.1:5000/api/`.

### Required backend env vars

- `SECRET_KEY`
- `JWT_SECRET_KEY`
- `TRUCERT_CONTRACT_ADDRESS`
- `CONTRACT_OWNER_PRIVATE_KEY` (admin whitelist only)
- `PINATA_JWT`
- `TRUCERT_SIG_KID`
- `TRUCERT_SIG_PRIVATE_KEY` (Ed25519 private key bytes, hex or base64)
- `TRUCERT_SIG_PUBLIC_KEYS` (JSON map: `{"kid":"hex-or-base64-pubkey"}`)

### Database

- Use Neon Postgres via `DATABASE_URL`:
  - `postgresql+psycopg://<user>:<password>@<host>/<db>?sslmode=require`
- If `DATABASE_URL` is missing, backend falls back to local SQLite (`backend/instance/trucert.db`).
- Rotate any leaked credentials and keep `.env` local only.

### University registration (wallet-only, no private keys)

`POST /api/auth/register-university` JSON body includes **`issuer_wallet_address`** (0x…).  
The backend **does not** accept/store issuer private keys. Issuer mint/claim/revoke/burn/reissue are signed in-browser via `window.ethereum`.

Institution profile fields are stored at the university profile level (not per mint):
- `institution_contact_email`
- `institution_contact_phone`
- `institution_website`
- `institution_license_id`
- `institution_license_authority`
- `institution_license_valid_until`

You can set these at registration time or later with `PUT /api/university/profile`.

### Admin

If `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` are set, first startup creates an admin.  
`POST /api/auth/login` → `POST /api/admin/universities/<id>/approve` whitelists the registered wallet on-chain and marks the university **verified**.

### Issuer actions (prepare + client sign)

University JWT endpoints **prepare** IPFS metadata and return values for the contract; they **never** sign as the issuer:

- `POST /api/university/certificates/prepare-mint`
- `POST /api/university/certificates/prepare-reissue/<old_token_id>`
- `GET /api/university/activity/basic` — simple activity derived from DB + current on-chain state (no large `eth_getLogs` scans)
- `POST /api/university/logo` — multipart image upload to Pinata (`ipfs://...`) for institution branding

University portal then calls contract functions with MetaMask/injected wallet:
- `mintToEscrow`
- `claim`
- `revokeCertificate`
- `burnCertificate`
- `revokeAndReissue`

Mint/reissue request payloads contain certificate-specific fields only:
- `student_name`
- `degree_type`
- `cert_id`
- `issue_date`
- optional `image`

Institution contact/license fields are sourced from authenticated university profile in DB.

## 3. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open the printed URL (default `http://127.0.0.1:5173`). Dev server proxies `/api` to Flask.

**Routes:** `/` verify · `/login` · `/register` · `/admin` · `/university`.

`/university` requires:
- connected wallet
- chain match (`chain_id` from backend)
- account match with approved `wallet_address`

Production: `npm run build` → `frontend/dist/`.

## API quick reference

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/auth/register-university` | — |
| POST | `/api/auth/login` | — |
| GET | `/api/admin/universities?status=pending` | admin JWT |
| POST | `/api/admin/universities/<id>/approve` | admin JWT |
| POST | `/api/admin/universities/<id>/reject` | admin JWT |
| GET | `/api/university/me` | university JWT |
| PUT | `/api/university/profile` | university JWT |
| POST | `/api/university/logo` | university JWT |
| POST | `/api/university/certificates/prepare-mint` | university JWT |
| POST | `/api/university/certificates/prepare-reissue/<old_token_id>` | university JWT |
| GET | `/api/university/activity/basic` | university JWT |
| GET | `/api/verify/<token_id>` | public |
| POST | `/api/verify/fields` | public |

## Verification modes

- By token id: `GET /api/verify/<token_id>`
- By fields: `POST /api/verify/fields` with:
  - `institution_name`
  - `student_name`
  - `degree_type`
  - `cert_id`
  - `issue_date`

Field verification recomputes the canonical core hash, looks up indexed records (`cert_id/core_hash/token_id`), then confirms chain status.

## Institution logo support

- Upload logo from university portal (`POST /api/university/logo`, max 2MB image).
- Returned/stored as `logo_uri` (`ipfs://...`) and exposed as `logo_url` in `/api/university/me`.
- Mint metadata includes `institution_logo`.

## Demo seed script

`backend/seed_demo_university.py` creates a demo university with a **random issuer address** stored in the DB. It prints a **one-time private key to the terminal** so you can import that account into MetaMask locally — that key is **not** stored by the backend.

## Security notes

- Never commit real keys. Use Amoy-only keys and rotated secrets.
- University private keys are never accepted or stored by backend.
- `CONTRACT_OWNER_PRIVATE_KEY` is for platform admin chain actions (whitelist), not university issuance.
- Rotate leaked DB/API credentials and keep `.env` local only.

## License

MIT (capstone / educational use).
