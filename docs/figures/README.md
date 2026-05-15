# Suggested screenshots for COMP3901 final report

Capture these from a running dev stack (Flask on port 5000, Vite dev or built frontend) on **Polygon Amoy** with test wallets. Redact any secrets, emails, or unrelated PII.

| # | Suggested filename | What to show |
|---|---------------------|--------------|
| 1 | `verify-by-token-id.png` | Public **Verify** flow: token ID input and result (on-chain validity, metadata, optional AI disclaimer if used). |
| 2 | `batch-completed.png` | University portal: batch mint progress or completed batch summary (rows minted / status). |
| 3 | `admin-approve.png` | Admin UI: pending university registration and **Approve** action (or equivalent whitelist confirmation). |
| 4 | `university-wallet-connected.png` | University portal with MetaMask connected, chain Amoy, wallet matches registered issuer. |
| 5 | `single-mint-eip712.png` | Prepare mint → wallet signature prompt or success message showing EIP-712–backed flow (no private keys on screen). |
| 6 | `claim-soulbound.png` | **Claim & lock** transaction submitted from issuer wallet, or student claim request list with approve/complete flow. |
| 7 | `revoke-burn-reissue.png` | Revoke / burn / reissue forms or transaction receipts (test tokens only). |
| 8 | `hardhat-tests.png` | Terminal: `npx hardhat test` showing **7 passing** tests. |

Embed figures in the exported PDF/Word from `docs/COMP3901_FINAL_REPORT.md` using your editor’s image insertion, or convert Markdown with a tool that supports local image paths under `docs/figures/`.
