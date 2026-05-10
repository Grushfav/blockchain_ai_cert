# TruCert (COMP 3901 capstone)

Blockchain-based academic credential verification on **Polygon Amoy** with **Flask + SQLAlchemy**, **IPFS (Pinata)**, and a **React university portal**. **Mints** use a platform **minter hot wallet** (`mintForIssuer`) after the university signs an **EIP-712 authorization** (gasless). **Claim / revoke / burn / reissue** remain **issuer wallet** transactions in MetaMask.

## Repository layout

| Path | Purpose |
|------|---------|
| `contracts/TruCert.sol` | ERC-721: whitelist issuers, mint to escrow, claim (lock), revoke, burn, reissue |
| `hardhat.config.js` | Solidity 0.8.27, `polygonAmoy` network |
| `scripts/deploy.js` | Deploy contract (owner = deployer) |
| `test/TruCert.js` | Hardhat tests |
| `backend/` | Flask REST API, SQLAlchemy models, metadata signing, Pinata integration |
| `frontend/` | Marketing home, verify UI, and university portal (wallet-signed issuance) |

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

### Public trust endpoints (no JWT)

Used by the pre-login **home** page so contract address, chain id, and Ed25519 verification keys stay aligned with `.env` without rebuilding the frontend.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/public/config` | `chain_id`, `network_name`, checksum `contract_address`, Amoy Polygonscan `contract_explorer_url`, `platform_minter_address` (if `TRUCERT_MINTER_PRIVATE_KEY` set), `eip712_domain`, `pinata_gateway_base`, optional `active_signing_kid`, `trucert_public_keys` (`kid`, `public_key_base64`, `public_key_hex`), `updated_at` |
| GET | `/api/public/verified-universities` | `{ universities: [{ name, internal_id, logo_url }] }` — **`status=verified` only** (no pending registrations) |

**Frontend:** `/` loads the marketing/trust landing page; `/verify` is the public verification UI. Optional `VITE_REPO_URL` in `frontend/.env` adds a repository link in the home footer. Static batch sample: `frontend/public/samples/batch-mint-example.csv` (also mirrored under repo `samples/`).

### Required backend env vars

- `SECRET_KEY`
- `JWT_SECRET_KEY`
- `TRUCERT_CONTRACT_ADDRESS`
- `CONTRACT_OWNER_PRIVATE_KEY` (admin whitelist only)
- `PINATA_JWT`
- `TRUCERT_SIG_KID`
- `TRUCERT_SIG_PRIVATE_KEY` (Ed25519 private key bytes, hex or base64)
- `TRUCERT_SIG_PUBLIC_KEYS` (JSON map: `{"kid":"hex-or-base64-pubkey"}`)
- `TRUCERT_MINTER_PRIVATE_KEY` — **platform** EVM key allowed by `TruCert.minter`; submits `mintForIssuer` (fund with Amoy MATIC for gas). Prefer KMS / HSM in production; env var is fine for the capstone.
- `EIP712_DOMAIN_NAME` (default `TruCert`), `EIP712_DOMAIN_VERSION` (default `1`), `EIP712_CHAIN_ID` (default `80002`)
- Optional `EIP712_VERIFYING_CONTRACT` — defaults to `TRUCERT_CONTRACT_ADDRESS` for the typed-data domain

**Optional — Google Gemini (AI helpers, not used for verification):**

- `GEMINI_API_KEY` — **never commit**. If unset or empty, admin AI test returns **503** with `Gemini not configured`; the rest of the API runs normally.
- `GEMINI_MODEL` — default `gemini-1.5-flash` (override if you use another Gemini model id).

**Privacy:** Third-party LLMs process whatever text you send. Do **not** paste private keys, student or staff email addresses, government IDs, or other sensitive PII into prompts unless you have an explicit policy covering Google’s processing. TruCert does **not** send student or certificate payloads to Gemini automatically; only `POST /api/admin/ai/gemini-test` forwards the `prompt` JSON field you provide.

After deploy, **contract owner** must call `setMinter(<platform_wallet>)` (see `scripts/deploy.js` + `TRUCERT_MINTER_ADDRESS`, or set manually). The minter address must match the account derived from `TRUCERT_MINTER_PRIVATE_KEY`.

### Database

- Use Neon Postgres via `DATABASE_URL`:
  - `postgresql+psycopg://<user>:<password>@<host>/<db>?sslmode=require`
- If `DATABASE_URL` is missing, backend falls back to local SQLite (`backend/instance/trucert.db`).
- Rotate any leaked credentials and keep `.env` local only.

### University registration (wallet-only, no private keys)

`POST /api/auth/register-university` JSON body includes **`issuer_wallet_address`** (0x…).  
The backend **does not** accept/store issuer private keys. Issuers sign **EIP-712 mint authorizations** and lifecycle txs (`claim`, `revoke`, …) in-browser via `window.ethereum`. Only the platform **minter** key submits mint transactions.

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

**Gemini smoke test (optional):** With `GEMINI_API_KEY` set, `POST /api/admin/ai/gemini-test` and body `{"prompt":"..."}` returns `{"model":"...","text":"..."}`. Prompts over 2,000 characters are rejected (**400**). Without a key: **503** `Gemini not configured`. Example (PowerShell, after login):

```powershell
$base = "http://127.0.0.1:5000/api"
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType "application/json" -Body (@{ email = "admin@example.com"; password = "your-password" } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.access_token)"; "Content-Type" = "application/json" }
Invoke-RestMethod -Method Post -Uri "$base/admin/ai/gemini-test" -Headers $headers -Body (@{ prompt = "Summarize TruCert in one sentence." } | ConvertTo-Json)
```

### Issuer actions (prepare + EIP-712 + platform mint)

University JWT endpoints **prepare** Ed25519-signed IPFS metadata and build **EIP-712** typed data. The backend **never** holds issuer private keys; the **minter** key sends `mintForIssuer(issuer, uri, coreHash, certId)` after a valid authorization.

- `POST /api/university/certificates/prepare-mint` — pin metadata; returns `mint_request_id`, `eip712`, `commitment`, `nonce`, `expiry_unix`
- `POST /api/university/certificates/submit-authorization` — body `{ mint_request_id, signature }`; verifies typed data + on-chain whitelist; minter mints; increments per-university `eip712_nonce` on success
- `POST /api/university/certificates/prepare-reissue/<old_token_id>` — still prepares metadata for **issuer-signed** `revokeAndReissue` in the wallet
- `GET /api/university/activity/basic` — simple activity derived from DB + current on-chain state (no large `eth_getLogs` scans)
- `POST /api/university/logo` — multipart image upload to Pinata (`ipfs://...`) for institution branding

**EIP-712 commitments (off-chain, documented in `app/services/eip712_service.py`):**

- Single mint: `keccak256(abi.encode(certId, coreHash))`
- Batch: `inner = keccak256(abi.encodePacked(sorted row commitments))` where each row commitment matches the single-mint formula; `commitment = keccak256(abi.encode(batchId, inner))`

University portal **wallet** calls:
- `claim`, `revokeCertificate`, `burnCertificate`, `revokeAndReissue`

Platform **minter** (server) calls:
- `mintForIssuer`

Mint/reissue request payloads contain certificate-specific fields only:
- `student_name`
- `degree_type`
- `cert_id`
- `issue_date`
- optional `image`

Institution contact/license fields are sourced from authenticated university profile in DB.

### Batch mint (CSV → one EIP-712 batch auth → platform mint loop)

Universities upload a UTF-8 CSV. Each valid row is **prepared** on the server (IPFS + `CertificateRecord`). When all rows are prepared, the issuer signs **one** `BatchMintAuthorization`; the backend verifies it, increments `eip712_nonce`, then `POST .../execute` runs **N** `mintForIssuer` transactions from the minter wallet (chunked via `max_mints`).

**CSV columns (required header row):**

`cert_id,student_internal_id,student_email,student_full_name,degree_title,issue_date`

Optional: `image_ipfs_uri` (must be `ipfs://` or `http(s)://`, max 512 chars).

- Max rows per upload: **500** (override with `MINT_BATCH_MAX_ROWS` in `.env`).
- `issue_date` must be `YYYY-MM-DD`.
- `student_email` must look like a valid email.
- `cert_id` must be unique in the file and must not already exist in `certificate_records`.
- **Privacy:** `student_email` and `student_internal_id` are stored only on **`mint_batch_rows`** in the database. They are **not** included in pinned IPFS metadata (same pipeline as single mint: institution fields come from the university profile).

**Batch API (university JWT):**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/university/mint-batches` | multipart field `file` — CSV upload |
| GET | `/api/university/mint-batches/<batch_id>` | batch summary |
| GET | `/api/university/mint-batches/<batch_id>/rows?status=&limit=&offset=` | paginated rows |
| POST | `/api/university/mint-batches/<batch_id>/rows/<row_id>/prepare` | pin metadata + `CertificateRecord` (same as single prepare) |
| POST | `/api/university/mint-batches/<batch_id>/rows/<row_id>/reset-prepare` | clears DB `prepared` state when **no token exists on-chain** for that cert |
| GET | `/api/university/mint-batches/<batch_id>/eip712` | builds typed data + persists row snapshot / commitment (call again to refresh before signing) |
| POST | `/api/university/mint-batches/<batch_id>/submit-authorization` | body `{ signature }` — verify EIP-712, increment nonce, mark batch **authorized** |
| POST | `/api/university/mint-batches/<batch_id>/execute` | body `{ max_mints? }` — minter submits mints for rows in the snapshot |
| GET | `/api/university/mint-batches/<batch_id>/export-errors` | CSV of `invalid` + `mint_failed` rows |

**Email stub:** After a successful mint row, if `SENDGRID_API_KEY` or `SMTP_HOST` is set, the row is marked **`email_sent`** (no real SMTP implementation yet). If neither is set, the row stays **`mint_confirmed`** (email not attempted).

**Database:** New tables `mint_batches` and `mint_batch_rows` are created automatically with `db.create_all()` on startup (works with **Neon Postgres** and **SQLite**).

## 3. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open the printed URL (default `http://127.0.0.1:5173`). Dev server proxies `/api` to Flask.

**Routes:** `/` home · `/verify` verify · `/login` · `/register` · `/admin` · `/university`.

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
| GET | `/api/public/config` | — |
| GET | `/api/public/verified-universities` | — |
| GET | `/api/admin/universities?status=pending` | admin JWT |
| POST | `/api/admin/universities/<id>/approve` | admin JWT |
| POST | `/api/admin/universities/<id>/reject` | admin JWT |
| POST | `/api/admin/ai/gemini-test` | admin JWT — `{"prompt":"..."}` (optional `GEMINI_API_KEY`; max 2,000 chars) |
| GET | `/api/university/me` | university JWT |
| PUT | `/api/university/profile` | university JWT |
| POST | `/api/university/logo` | university JWT |
| POST | `/api/university/certificates/prepare-mint` | university JWT |
| POST | `/api/university/certificates/submit-authorization` | university JWT — `{ mint_request_id, signature }` |
| POST | `/api/university/certificates/prepare-reissue/<old_token_id>` | university JWT |
| POST | `/api/university/mint-batches` | university JWT (multipart CSV) |
| GET | `/api/university/mint-batches/<id>` | university JWT |
| GET | `/api/university/mint-batches/<id>/rows` | university JWT |
| POST | `/api/university/mint-batches/<id>/rows/<row_id>/prepare` | university JWT |
| POST | `/api/university/mint-batches/<id>/rows/<row_id>/reset-prepare` | university JWT — clear stuck `prepared` row if no on-chain token yet |
| GET | `/api/university/mint-batches/<id>/eip712` | university JWT |
| POST | `/api/university/mint-batches/<id>/submit-authorization` | university JWT — `{ signature }` |
| POST | `/api/university/mint-batches/<id>/execute` | university JWT — `{ max_mints? }` |
| GET | `/api/university/mint-batches/<id>/export-errors` | university JWT |
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
- `TRUCERT_MINTER_PRIVATE_KEY` is a **hot wallet** with on-chain mint power (within `mintForIssuer` rules). Protect like a signing key; prefer KMS in production. Fund it only with test MATIC.
- Batch flow **increments `eip712_nonce` on `submit-authorization`**. If `execute` fails mid-batch, you may need a fresh CSV batch or manual DB help — design assumes execute is retried until rows complete.
- `CONTRACT_OWNER_PRIVATE_KEY` is for platform admin chain actions (whitelist + `setMinter`), not university issuance.
- Rotate leaked DB/API credentials and keep `.env` local only.

## License

MIT (capstone / educational use).
