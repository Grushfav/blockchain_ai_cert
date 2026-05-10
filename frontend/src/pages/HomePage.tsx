import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { API_BASE } from "../api/client";
import batchIssuanceImg from "../images/batch_issuance.png";
import lifecycleControlsImg from "../images/lifecycle_controls.png";
import auditLogImg from "../images/audit_log.png";

type PublicKeyEntry = { kid: string; public_key_base64: string; public_key_hex: string };

type PublicConfig = {
  chain_id: number;
  network_name: string;
  contract_address: string | null;
  contract_explorer_url: string | null;
  pinata_gateway_base: string;
  active_signing_kid: string | null;
  trucert_public_keys: PublicKeyEntry[];
  updated_at: string;
};

type VerifiedUniversity = { name: string; internal_id: string; logo_url: string | null };

const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined)?.trim();

function homeRailItemClass(active: boolean): string {
  return `home-bottom-rail__item${active ? " active" : ""}`;
}

export function HomePage() {
  const location = useLocation();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [universities, setUniversities] = useState<VerifiedUniversity[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, uRes] = await Promise.all([
          fetch(`${API_BASE}/api/public/config`),
          fetch(`${API_BASE}/api/public/verified-universities`),
        ]);
        const cJson = (await cRes.json()) as PublicConfig & { error?: string };
        if (!cRes.ok) {
          if (!cancelled) setCfgErr(cJson.error || `Config HTTP ${cRes.status}`);
          return;
        }
        if (!cancelled) {
          setCfg(cJson);
          setCfgErr(null);
        }
        const uJson = (await uRes.json()) as { universities?: VerifiedUniversity[] };
        if (uRes.ok && !cancelled) setUniversities(uJson.universities ?? []);
      } catch (e) {
        if (!cancelled) setCfgErr(e instanceof Error ? e.message : "Could not load trust config");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chainLabel = cfg?.network_name ?? "Polygon Amoy";
  const chainId = cfg?.chain_id ?? 80002;
  const path = location.pathname;
  const hash = location.hash;

  return (
    <div className="home-page home-page--mock">
      <section className="home-mock-hero-card" aria-label="Verifiers">
        <div className="home-mock-hero-top">
          <span className="home-mock-eyebrow">Verifiers</span>
          <span className="home-mock-hero-icon" aria-hidden>
            👁
          </span>
        </div>
        <h1 className="home-mock-hero-title">Zero-trust checks</h1>
        <p className="home-mock-hero-lead">
          Blockchain-verified academic credentials on {chainLabel}. Read public chain state, fetch IPFS metadata, and
          compare anchored hashes — no TruCert account required to verify.
        </p>
        <ul className="home-mock-checklist">
          <li>Instant authenticity checks against the ledger</li>
          <li>Token ID or certificate-field matching</li>
        </ul>
        <Link to="/verify" className="home-mock-cta-link">
          Get access →
        </Link>
      </section>

      <div className="home-mock-role-grid home-mock-role-grid--single">
        <Link to="/register" className="home-mock-role-card">
          <span className="home-mock-role-icon home-mock-role-icon--issuer" aria-hidden>
            🏛
          </span>
          <span className="home-mock-role-title">Institutions</span>
          <span className="home-mock-role-action home-mock-role-action--accent">
            Onboard →
          </span>
        </Link>
      </div>

      <section className="home-trust-logos" aria-label="Stack">
        <span className="home-trust-chip">Polygon Amoy</span>
        <span className="home-trust-chip">IPFS / Pinata</span>
        <span className="home-trust-chip">ERC-721</span>
        <span className="home-trust-chip">Issuer whitelist</span>
        <span className="home-trust-chip home-trust-chip--demo">Capstone demo</span>
      </section>

      <section className="home-mock-security" aria-labelledby="credible-heading">
        <p className="home-mock-section-eyebrow">Security protocol</p>
        <h2 id="credible-heading" className="home-mock-section-title">
          Why this is credible
        </h2>
        <div className="home-mock-cred-row">
          <div className="home-mock-cred-icon" aria-hidden>
            🔐
          </div>
          <div>
            <h3 className="home-mock-cred-title">Tamper-evident ledger</h3>
            <p className="home-mock-cred-text">
              Revocation, burn, and lock state live on-chain. Metadata URIs and core hashes give verifiers a stable path
              to audit what was issued.
            </p>
          </div>
        </div>
        <div className="home-mock-cred-row">
          <div className="home-mock-cred-icon" aria-hidden>
            🔗
          </div>
          <div>
            <h3 className="home-mock-cred-title">Issuer-controlled keys</h3>
            <p className="home-mock-cred-text">
              Only verified institutional wallets authorize mints (EIP-712 in the browser). The platform minter submits
              transactions — university private keys are never stored on the server.
            </p>
          </div>
        </div>
      </section>

      <section className="home-mock-split-flows" aria-label="Verification and lifecycle">
        <div className="home-mock-flow-panel">
          <h3 className="home-mock-flow-heading">Verification pipeline</h3>
          <ol className="home-mock-vtimeline">
            <li className="home-mock-vtimeline__item home-mock-vtimeline__item--active">
              <span className="home-mock-vtimeline__dot" />
              <div>
                <span className="home-mock-vtimeline__label">Read state</span>
                <p className="home-mock-vtimeline__desc">Query the contract for validity, lock, and URI.</p>
              </div>
            </li>
            <li className="home-mock-vtimeline__item">
              <span className="home-mock-vtimeline__dot" />
              <div>
                <span className="home-mock-vtimeline__label">Fetch metadata</span>
                <p className="home-mock-vtimeline__desc">Resolve IPFS JSON and optional TruCert signatures.</p>
              </div>
            </li>
            <li className="home-mock-vtimeline__item">
              <span className="home-mock-vtimeline__dot" />
              <div>
                <span className="home-mock-vtimeline__label">Compare hashes</span>
                <p className="home-mock-vtimeline__desc">Match presented fields to the anchored core hash.</p>
              </div>
            </li>
          </ol>
        </div>
        <div className="home-mock-flow-panel">
          <h3 className="home-mock-flow-heading">Lifecycle management</h3>
          <ol className="home-mock-lifecycle">
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">1</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Register</span>
                <p className="home-mock-lifecycle__desc">
                  Institutions link their physical identity to a blockchain address.
                </p>
              </div>
            </li>
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">2</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Approve</span>
                <p className="home-mock-lifecycle__desc">
                  Governance DAO validates the institution&apos;s signing authority.
                </p>
              </div>
            </li>
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">3</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Mint</span>
                <p className="home-mock-lifecycle__desc">
                  Credentials generated as unique, cryptographically sealed tokens.
                </p>
              </div>
            </li>
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">4</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Claim</span>
                <p className="home-mock-lifecycle__desc">
                  Students receive the token in their secure private vault.
                </p>
              </div>
            </li>
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">5</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Verify</span>
                <p className="home-mock-lifecycle__desc">
                  Employers check status against the ledger in real-time.
                </p>
              </div>
            </li>
            <li className="home-mock-lifecycle__item">
              <span className="home-mock-lifecycle__num">6</span>
              <div className="home-mock-lifecycle__body">
                <span className="home-mock-lifecycle__title">Revoke / burn</span>
                <p className="home-mock-lifecycle__desc">
                  Invalidate credentials immediately if policy violations occur.
                </p>
              </div>
            </li>
          </ol>
          <p className="home-mock-flow-foot muted small">
            Students receive the token after claim; employers verify in real time; issuers can invalidate credentials on
            policy breaches.
          </p>
        </div>
      </section>

      <section className="home-mock-spotlights" aria-label="Platform capabilities">
        <article className="home-mock-spotlight home-mock-spotlight--left">
          <img src={batchIssuanceImg} alt="" className="home-mock-spotlight__bg" />
          <div className="home-mock-spotlight__overlay" />
          <div className="home-mock-spotlight__text">
            <h3 className="home-mock-spotlight__title">Batch issuance</h3>
            <p className="home-mock-spotlight__sub">Issue many credentials from CSV with one batch authorization flow.</p>
          </div>
        </article>
        <article className="home-mock-spotlight home-mock-spotlight--right">
          <img src={lifecycleControlsImg} alt="" className="home-mock-spotlight__bg" />
          <div className="home-mock-spotlight__overlay" />
          <div className="home-mock-spotlight__text">
            <h3 className="home-mock-spotlight__title">Lifecycle controls</h3>
            <p className="home-mock-spotlight__sub">Revoke, burn, and reissue with clear on-chain semantics.</p>
          </div>
        </article>
        <article className="home-mock-spotlight home-mock-spotlight--left">
          <img src={auditLogImg} alt="" className="home-mock-spotlight__bg" />
          <div className="home-mock-spotlight__overlay" />
          <div className="home-mock-spotlight__text">
            <h3 className="home-mock-spotlight__title">Audit-friendly logs</h3>
            <p className="home-mock-spotlight__sub">Indexed activity and exports for institutional and admin review.</p>
          </div>
        </article>
      </section>

      <section>
        <h2 className="home-section-title">What we offer</h2>
        <ul className="home-bullets">
          <li>Public verification portal: lookup by NFT token ID or by exact issued certificate fields.</li>
          <li>
            Institution dashboard: EIP-712 authorized mint (platform minter), claim, revoke, burn, reissue —
            including batch CSV with one batch signature then server-side mint loop.
          </li>
          <li>On-chain status surface: valid, revoked, and locked (SBT) are readable from the contract.</li>
          <li>
            Optional TruCert-signed metadata (Ed25519): the platform can sign the canonical JSON envelope so
            verifiers can confirm metadata was produced with an approved publishing key.
          </li>
        </ul>
      </section>

      <section
        className="home-panel trust-panel home-trust-redesign"
        id="trust-panel"
        aria-labelledby="trust-heading"
      >
        <h2 id="trust-heading" className="home-trust-redesign__title">
          Trust and transparency
        </h2>
        <p className="home-trust-redesign__intro">
          Values below are served from the API so they track your deployment configuration. Use the published
          Ed25519 keys to verify{" "}
          <code className="home-trust-redesign__code">trucert_sig</code> in metadata JSON (canonical JSON payload,
          sorted keys).
        </p>
        {cfgErr && <div className="error home-trust-err">{cfgErr}</div>}

        <div className="home-trust-grid">
          <div className="home-trust-kv-card">
            <div className="home-trust-kv-label">Network</div>
            <div className="home-trust-kv-value">
              {chainLabel} <span className="home-trust-kv-muted">(chainId {chainId})</span>
            </div>
          </div>
          <div className="home-trust-kv-card">
            <div className="home-trust-kv-label">TruCert contract</div>
            <div className="home-trust-kv-value">
              {cfg?.contract_address ? (
                <code className="home-trust-kv-mono">{cfg.contract_address}</code>
              ) : (
                <span className="home-trust-kv-muted">Not configured</span>
              )}
            </div>
            {cfg?.contract_explorer_url ? (
              <a
                className="home-trust-explorer-link"
                href={cfg.contract_explorer_url}
                target="_blank"
                rel="noreferrer"
              >
                View contract on Amoy Polygonscan
                <span className="home-trust-external-icon" aria-hidden>
                  ↗
                </span>
              </a>
            ) : (
              <span className="home-trust-kv-muted home-trust-explorer-fallback">—</span>
            )}
          </div>
          <div className="home-trust-kv-card">
            <div className="home-trust-kv-label">IPFS gateway (read)</div>
            <div className="home-trust-kv-value">
              <code className="home-trust-kv-mono">{cfg?.pinata_gateway_base || "—"}</code>
            </div>
          </div>
          <div className="home-trust-kv-card">
            <div className="home-trust-kv-label">Active signing key id</div>
            <div className="home-trust-kv-value">
              {cfg?.active_signing_kid ? (
                <code className="home-trust-kv-mono">{cfg.active_signing_kid}</code>
              ) : (
                <span className="home-trust-kv-muted">—</span>
              )}
            </div>
          </div>
        </div>

        {cfg?.updated_at ? (
          <p className="home-trust-snapshot muted small">Config snapshot: {cfg.updated_at}</p>
        ) : null}

        <div className="home-trust-keys-block">
          <h3 className="home-trust-keys-heading">
            <span className="home-trust-keys-icon" aria-hidden>
              🔑
            </span>
            Ed25519 public keys
          </h3>
          {!cfg?.trucert_public_keys?.length ? (
            <div className="home-trust-key-card home-trust-key-card--empty">
              <p className="home-trust-key-empty-msg">None published (optional signing)</p>
            </div>
          ) : (
            <div className="home-trust-keys-list">
              {cfg.trucert_public_keys.map((k) => (
                <div key={k.kid} className="home-trust-key-card">
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">KID</span>
                    <code className="home-trust-key-field-value">{k.kid}</code>
                  </div>
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">PUBLIC KEY (BASE64)</span>
                    {k.public_key_base64 ? (
                      <code className="home-trust-key-field-value home-trust-key-field-value--break">
                        {k.public_key_base64}
                      </code>
                    ) : (
                      <span className="home-trust-kv-muted">Invalid key material in env</span>
                    )}
                  </div>
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">RAW HEX</span>
                    {k.public_key_hex ? (
                      <code className="home-trust-key-field-value home-trust-key-field-value--break">
                        {k.public_key_hex.startsWith("0x") ? k.public_key_hex : `0x${k.public_key_hex}`}
                      </code>
                    ) : (
                      <span className="home-trust-kv-muted">—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="home-section-title">Register your university</h2>
        <p className="home-muted">
          Only <strong>verified</strong> institutions appear in the public directory below. Pending
          applications stay private to reduce spam and protect registrants.
        </p>
        <div className="home-register-card">
          <p>
            Requirements: official domain email, issuer wallet address, and admin approval. Timeline depends
            on manual review for this demo.
          </p>
          <Link to="/register" className="btn btn-primary">
            Start registration
          </Link>
        </div>
      </section>

      <section aria-labelledby="verified-heading">
        <h2 id="verified-heading" className="home-section-title">
          Verified institutions
        </h2>
        {universities.length === 0 ? (
          <p className="home-muted">No verified institutions yet.</p>
        ) : (
          <ul className="home-uni-grid">
            {universities.map((u) => (
              <li key={u.internal_id} className="home-uni-card">
                {u.logo_url ? (
                  <img src={u.logo_url} alt="" className="home-uni-logo" />
                ) : (
                  <div className="home-uni-logo-ph" aria-hidden />
                )}
                <div>
                  <div className="home-uni-name">{u.name}</div>
                  <code className="home-uni-id">{u.internal_id}</code>
                  <p className="home-uni-hint muted small">Issuer wallet is whitelisted on-chain.</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="home-section-title">Security and privacy</h2>
        <ul className="home-bullets">
          <li>Student operational email and internal IDs used in batch CSV are kept in the database, not on IPFS.</li>
          <li>
            Mint authorizations (EIP-712) and lifecycle transactions are signed by the institution wallet in the
            browser; mint transactions are paid by the platform minter.
          </li>
          <li>Optional Ed25519 platform signature on metadata helps detect tampering with the JSON envelope.</li>
          <li>
            Contract read methods expose <code className="mono-inline">valid</code>,{" "}
            <code className="mono-inline">locked</code>, issuer, and URI for auditors.
          </li>
        </ul>
      </section>

      <section className="home-panel">
        <h2 className="home-section-title">On-chain status glossary</h2>
        <table className="home-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Valid</td>
              <td>Certificate has not been revoked; metadata URI and hash remain the authoritative record.</td>
            </tr>
            <tr>
              <td>Revoked</td>
              <td>Issuer marked the credential invalid on-chain; verifiers should treat it as untrusted.</td>
            </tr>
            <tr>
              <td>Locked (SBT)</td>
              <td>After claim, transfer may be disabled so the token cannot move to another wallet.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="home-mock-faq-wrap">
        <h2 className="home-mock-protocol-faq-title">Protocol FAQ</h2>
        <div className="home-faq home-faq--protocol">
          <details>
            <summary>Why testnet?</summary>
            <p>Amoy is for learning and demos: MATIC is free from faucets and mistakes do not risk real funds.</p>
          </details>
          <details>
            <summary>What if my wallet shows no image?</summary>
            <p>
              The NFT image comes from token URI metadata. If the gateway is slow or the CID is wrong, the
              wallet may show a placeholder until the asset loads.
            </p>
          </details>
          <details>
            <summary>What does revoked mean?</summary>
            <p>
              The issuer called the revoke path on-chain. Verifiers should reject the credential even if an
              old PDF still exists off-chain.
            </p>
          </details>
          <details>
            <summary>How does a student claim?</summary>
            <p>
              After mint to escrow, the student connects the wallet that should hold the credential and runs
              the claim transaction from the university portal flow.
            </p>
          </details>
          <details>
            <summary>Who can mint?</summary>
            <p>
              Only wallets on the contract issuer whitelist, enforced on-chain after admin approval of the
              institution.
            </p>
          </details>
          <details>
            <summary>Is metadata private?</summary>
            <p>
              IPFS content is public to anyone with the CID. TruCert avoids putting student email on IPFS;
              design your fields accordingly.
            </p>
          </details>
          <details>
            <summary>What is trucert_sig?</summary>
            <p>
              Optional Ed25519 signature over canonical metadata fields, with a key id. Compare against the
              public keys listed in the trust panel.
            </p>
          </details>
          <details>
            <summary>Where do API errors come from?</summary>
            <p>
              RPC, IPFS, or misconfigured contract addresses. The verify page surfaces HTTP errors; check
              backend logs and environment alignment with Amoy.
            </p>
          </details>
        </div>
      </section>

      <section>
        <h2 className="home-section-title">Contact</h2>
        <p className="home-muted">
          Course and project inquiries: use your course coordinator email. For this codebase, open an issue or
          discussion on the repository if published.
        </p>
        {REPO_URL ? (
          <p>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="home-link">
              Repository / docs
            </a>
          </p>
        ) : null}
      </section>

      <footer className="home-footer">
        <nav className="home-footer-nav" aria-label="Footer">
          <Link to="/verify">Verify</Link>
          <span className="home-footer-sep">·</span>
          <Link to="/register">Register</Link>
          <span className="home-footer-sep">·</span>
          <Link to="/login">Login</Link>
          {REPO_URL ? (
            <>
              <span className="home-footer-sep">·</span>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                GitHub
              </a>
            </>
          ) : null}
        </nav>
        <p className="home-disclaimer">
          TruCert — COMP 3901 capstone demo on Polygon Amoy. Not legal advice; not a production certificate
          authority.
        </p>
      </footer>

      <nav className="home-bottom-rail" aria-label="Primary destinations">
        <NavLink to="/verify" className={({ isActive }) => homeRailItemClass(isActive)}>
          <span className="home-bottom-rail__icon" aria-hidden>
            ⧉
          </span>
          <span className="home-bottom-rail__label">Verify</span>
        </NavLink>
        <NavLink
          to="/login"
          className={() =>
            homeRailItemClass(path.startsWith("/university") || path === "/login" || path === "/register")
          }
        >
          <span className="home-bottom-rail__icon" aria-hidden>
            🏛
          </span>
          <span className="home-bottom-rail__label">Issuer</span>
        </NavLink>
        <Link
          to="/#trust-panel"
          className={homeRailItemClass(path === "/" && hash === "#trust-panel")}
        >
          <span className="home-bottom-rail__icon" aria-hidden>
            ◈
          </span>
          <span className="home-bottom-rail__label">Vault</span>
        </Link>
      </nav>
    </div>
  );
}
