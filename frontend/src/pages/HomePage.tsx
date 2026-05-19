import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Shield,
  KeyRound,
  Eye,
} from "lucide-react";

import { API_BASE } from "../api/client";

import batchIssuanceImg from "../images/batch_issuance.png";
import lifecycleControlsImg from "../images/lifecycle_controls.png";
import auditLogImg from "../images/audit_log.png";

import type { PublicConfig } from "../types/publicConfig";

type VerifiedUniversity = {
  id?: number;
  name: string;
  internal_id: string;
  logo_url: string | null;
  wallet_address?: string | null;
  domain_email?: string | null;
  institution_contact_email?: string | null;
};

const REPO_URL = (
  import.meta.env.VITE_REPO_URL as string | undefined
)?.trim();

function formatWalletShort(addr: string | null | undefined): string {
  const a = addr?.trim();
  if (!a) return "—";
  if (a.length < 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function HomePage() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  const [universities, setUniversities] = useState<
    VerifiedUniversity[]
  >([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [cRes, uRes] = await Promise.all([
          fetch(`${API_BASE}/api/public/config`),
          fetch(`${API_BASE}/api/public/verified-universities`),
        ]);

        const cJson = (await cRes.json()) as PublicConfig & {
          error?: string;
        };

        if (!cRes.ok) {
          if (!cancelled) {
            setCfgErr(
              cJson.error || `Config HTTP ${cRes.status}`
            );
          }

          return;
        }

        if (!cancelled) {
          setCfg(cJson);
          setCfgErr(null);
        }

        const uJson = (await uRes.json()) as {
          universities?: VerifiedUniversity[];
        };

        if (uRes.ok && !cancelled) {
          setUniversities(uJson.universities ?? []);
        }
      } catch (e) {
        if (!cancelled) {
          setCfgErr(
            e instanceof Error
              ? e.message
              : "Could not load trust config"
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const chainLabel = cfg?.network_name ?? "Polygon Amoy";
  const chainId = cfg?.chain_id ?? 80002;

  return (
    <div className="home-page home-page--mock">
      {cfgErr ? (
        <div className="error" role="alert" style={{ margin: "0 1rem 1rem" }}>
          {cfgErr}
        </div>
      ) : null}

      {/* HERO */}

      <section
        className="home-mock-hero-card"
        aria-label="Hero"
      >

        <div className="home-mock-hero-top">

          <span className="home-mock-eyebrow">
            Trusted Verification
          </span>

          <Eye
            className="home-mock-hero-icon"
            aria-hidden
          />

        </div>

        <h1 className="home-mock-hero-title">
          Verify Academic Credentials Instantly
        </h1>

        <p className="home-mock-hero-lead">
          Securely issue and verify academic
          credentials using blockchain-backed
          technology. Reduce fraud, simplify
          verification, and build trust between
          institutions, students, and employers.
        </p>

        <p className="muted-inline small" style={{ marginTop: "0.5rem" }}>
          Demo network: {chainLabel}
        </p>

        <div className="home-mock-hero-ctas">
          <Link to="/verify" className="home-mock-cta-link">
            Verify Credentials →
          </Link>
          <Link to="/onboarding" className="home-mock-cta-link home-mock-cta-link--secondary">
            Demo onboarding guide →
          </Link>
        </div>

      </section>

      {/* TRUST CHIPS */}

      <section
        className="home-trust-logos"
        aria-label="Trust indicators"
      >

        <span className="home-trust-chip">
          Trusted Verification
        </span>

        <span className="home-trust-chip">
          Tamper-Proof Records
        </span>

        <span className="home-trust-chip">
          Instant Validation
        </span>

        <span className="home-trust-chip">
          Secure Academic Credentials
        </span>

      </section>

      {/* WHAT WE OFFER */}

      <section>

        <h2 className="home-section-title">
          What We Offer
        </h2>

        <ul className="home-bullets">

          <li>
            Instantly verify academic credentials
            through a secure public verification
            portal.
          </li>

          <li>
            Allow institutions to securely issue,
            manage, revoke, and update digital
            certificates.
          </li>

          <li>
            Give employers and organizations
            real-time access to trusted
            credential validation.
          </li>

          <li>
            Support large-scale certificate
            issuance with streamlined batch
            processing tools.
          </li>

          <li>
            Protect certificate integrity using
            secure blockchain-backed verification
            technology.
          </li>

          <li>
            Maintain transparent credential
            history and audit records for
            institutions and administrators.
          </li>

        </ul>

      </section>

      {/* SECURITY */}

      <section
        className="home-mock-security"
        aria-labelledby="credible-heading"
      >

        <p className="home-mock-section-eyebrow">
          Security Protocol
        </p>

        <h2
          id="credible-heading"
          className="home-mock-section-title"
        >
          Why this is credible
        </h2>

        <div className="home-mock-cred-row">

          <div
            className="home-mock-cred-icon"
            aria-hidden
          >
            <Shield />
          </div>

          <div>

            <h3 className="home-mock-cred-title">
              Tamper-Proof Verification
            </h3>

            <p className="home-mock-cred-text">
              Every credential is securely stored
              and verified to ensure authenticity
              and prevent fraud.
            </p>

          </div>

        </div>

        <div className="home-mock-cred-row">

          <div
            className="home-mock-cred-icon"
            aria-hidden
          >
            <KeyRound />
          </div>

          <div>

            <h3 className="home-mock-cred-title">
              Secure Institutional Authorization
            </h3>

            <p className="home-mock-cred-text">
              Only approved institutions can issue
              credentials, helping maintain trust
              and security across the platform.
            </p>

          </div>

        </div>

      </section>

      {/* VERIFICATION FLOW */}

      <section
        className="home-mock-split-flows"
        aria-label="Verification process"
      >

        <div className="home-mock-flow-panel">

          <h3 className="home-mock-flow-heading">
            Verification Process
          </h3>

          <ol className="home-mock-vtimeline">

            <li className="home-mock-vtimeline__item home-mock-vtimeline__item--active">

              <span className="home-mock-vtimeline__dot" />

              <div>

                <span className="home-mock-vtimeline__label">
                  Check authenticity
                </span>

                <p className="home-mock-vtimeline__desc">
                  Validate certificates against
                  secure verification records.
                </p>

              </div>

            </li>

            <li className="home-mock-vtimeline__item">

              <span className="home-mock-vtimeline__dot" />

              <div>

                <span className="home-mock-vtimeline__label">
                  Retrieve certificate data
                </span>

                <p className="home-mock-vtimeline__desc">
                  Securely access credential
                  information and verification
                  details.
                </p>

              </div>

            </li>

            <li className="home-mock-vtimeline__item">

              <span className="home-mock-vtimeline__dot" />

              <div>

                <span className="home-mock-vtimeline__label">
                  Confirm integrity
                </span>

                <p className="home-mock-vtimeline__desc">
                  Ensure credentials have not been
                  altered or tampered with.
                </p>

              </div>

            </li>

          </ol>

        </div>

        <div className="home-mock-flow-panel">

          <h3 className="home-mock-flow-heading">
            Credential Lifecycle
          </h3>

          <ol className="home-mock-lifecycle">

            <li className="home-mock-lifecycle__item">

              <span className="home-mock-lifecycle__num">
                1
              </span>

              <div className="home-mock-lifecycle__body">

                <span className="home-mock-lifecycle__title">
                  Register
                </span>

                <p className="home-mock-lifecycle__desc">
                  Institutions securely register
                  and verify their identity.
                </p>

              </div>

            </li>

            <li className="home-mock-lifecycle__item">

              <span className="home-mock-lifecycle__num">
                2
              </span>

              <div className="home-mock-lifecycle__body">

                <span className="home-mock-lifecycle__title">
                  Approve
                </span>

                <p className="home-mock-lifecycle__desc">
                  Trusted administrators validate
                  the institution.
                </p>

              </div>

            </li>

            <li className="home-mock-lifecycle__item">

              <span className="home-mock-lifecycle__num">
                3
              </span>

              <div className="home-mock-lifecycle__body">

                <span className="home-mock-lifecycle__title">
                  Issue
                </span>

                <p className="home-mock-lifecycle__desc">
                  Credentials are securely created
                  and issued to students.
                </p>

              </div>

            </li>

            <li className="home-mock-lifecycle__item">

              <span className="home-mock-lifecycle__num">
                4
              </span>

              <div className="home-mock-lifecycle__body">

                <span className="home-mock-lifecycle__title">
                  Verify
                </span>

                <p className="home-mock-lifecycle__desc">
                  Employers and organizations can
                  instantly verify authenticity.
                </p>

              </div>

            </li>

          </ol>

        </div>

      </section>

      {/* SPOTLIGHTS */}

      <section
        className="home-mock-spotlights"
        aria-label="Platform capabilities"
      >

        <article className="home-mock-spotlight home-mock-spotlight--left">

          <img
            src={batchIssuanceImg}
            alt=""
            className="home-mock-spotlight__bg"
          />

          <div className="home-mock-spotlight__overlay" />

          <div className="home-mock-spotlight__text">

            <h3 className="home-mock-spotlight__title">
              Batch Issuance
            </h3>

            <p className="home-mock-spotlight__sub">
              Efficiently issue multiple
              credentials in a single workflow.
            </p>

          </div>

        </article>

        <article className="home-mock-spotlight home-mock-spotlight--right">

          <img
            src={lifecycleControlsImg}
            alt=""
            className="home-mock-spotlight__bg"
          />

          <div className="home-mock-spotlight__overlay" />

          <div className="home-mock-spotlight__text">

            <h3 className="home-mock-spotlight__title">
              Lifecycle Controls
            </h3>

            <p className="home-mock-spotlight__sub">
              Revoke, update, and manage
              credentials securely.
            </p>

          </div>

        </article>

        <article className="home-mock-spotlight home-mock-spotlight--left">

          <img
            src={auditLogImg}
            alt=""
            className="home-mock-spotlight__bg"
          />

          <div className="home-mock-spotlight__overlay" />

          <div className="home-mock-spotlight__text">

            <h3 className="home-mock-spotlight__title">
              Audit-Friendly Logs
            </h3>

            <p className="home-mock-spotlight__sub">
              Maintain transparent and secure
              activity tracking.
            </p>

          </div>

        </article>

      </section>

      {/* SECURITY & TRANSPARENCY */}

      <section
        className="home-panel trust-panel home-trust-redesign"
        id="trust-panel"
        aria-labelledby="trust-heading"
      >

        <h2
          id="trust-heading"
          className="home-trust-redesign__title"
        >
          Security & Transparency
        </h2>

        <p className="home-trust-redesign__intro">
          TrueCert provides transparent
          verification records so institutions,
          employers, and students can confidently
          trust issued credentials.

          The information below helps confirm the
          authenticity and integrity of
          certificates issued through the
          platform.
        </p>

        {cfgErr && (
          <div className="error home-trust-err">
            {cfgErr}
          </div>
        )}

        <div className="home-trust-grid">

          <div className="home-trust-kv-card">

            <div className="home-trust-kv-label">
              Network
            </div>

            <div className="home-trust-kv-value">
              {chainLabel}{" "}
              <span className="home-trust-kv-muted">(chainId {chainId})</span>
            </div>
          </div>

          <div className="home-trust-kv-card">
            <div className="home-trust-kv-label">TrueCert contract</div>
            <div className="home-trust-kv-value">
              {cfg?.contract_address ? (
                <code className="home-trust-kv-mono">{cfg.contract_address}</code>
              ) : (
                <span className="home-trust-kv-muted">Not configured</span>
              )}
              {cfg?.contract_explorer_url ? (
                <>
                  {" "}
                  <a
                    href={cfg.contract_explorer_url}
                    className="home-trust-explorer-link"
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on explorer
                    <span className="home-trust-external-icon" aria-hidden>
                      ↗
                    </span>
                  </a>
                </>
              ) : (
                <span className="home-trust-kv-muted home-trust-explorer-fallback">—</span>
              )}
            </div>
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

        {cfg ? (
          <p className="home-trust-snapshot muted small">
            Config snapshot: {cfg.updated_at}
          </p>
        ) : null}

        <div className="home-trust-keys-block">
          <h3 className="home-trust-keys-heading">
            <KeyRound className="home-trust-keys-icon" aria-hidden />
            Ed25519 public keys
          </h3>

          {!cfg?.truecert_public_keys?.length ? (
            <div className="home-trust-key-card home-trust-key-card--empty">
              <p className="home-trust-key-empty-msg">None published (optional signing)</p>
            </div>
          ) : (
            <div className="home-trust-keys-list">
              {cfg.truecert_public_keys.map((k) => (
                <div key={k.kid} className="home-trust-key-card">
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">KID</span>
                    <code className="home-trust-key-field-value">{k.kid}</code>
                  </div>
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">Public key (base64)</span>
                    {k.public_key_base64 ? (
                      <code className="home-trust-key-field-value home-trust-key-field-value--break">
                        {k.public_key_base64}
                      </code>
                    ) : (
                      <span className="home-trust-kv-muted">Invalid key material in env</span>
                    )}
                  </div>
                  <div className="home-trust-key-row">
                    <span className="home-trust-key-field-label">Raw hex</span>
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

{/* REGISTER INSTITUTION */}

<section className="home-register-section">

  <div className="home-register-card">

    <h2 className="home-section-title">
      Register Institution
    </h2>

    <p className="home-register-text">
      Join trusted institutions using TrueCert
      to securely issue and verify academic
      credentials.
    </p>

    <Link
      to="/register"
      className="btn btn-primary"
    >
      Register Institution
    </Link>

  </div>

</section>

{/* VERIFIED INSTITUTIONS */}

<section aria-labelledby="verified-heading">

  <h2
    id="verified-heading"
    className="home-section-title"
  >
    Verified Institutions
  </h2>

  {universities.length === 0 ? (

    <p className="home-muted">
      No verified institutions yet.
    </p>

  ) : (

    <ul className="home-uni-grid">

      {universities.map((u) => (

        <li
          key={u.internal_id}
          className="home-uni-card"
        >

          {u.logo_url ? (

            <img
              src={u.logo_url}
              alt=""
              className="home-uni-logo"
            />

          ) : (

            <div
              className="home-uni-logo-ph"
              aria-hidden
            />

          )}

          <div className="home-uni-body">

            <div className="home-uni-name-wrap">

              <span className="home-uni-name">
                {u.name}
              </span>

              <span className="home-verified-badge">
                Verified Institution
              </span>

            </div>

            <code className="home-uni-id">
              {u.internal_id}
            </code>

            <dl className="home-uni-meta">

              <div className="home-uni-meta-row">
                <dt>Wallet</dt>
                <dd>
                  {u.wallet_address ? (
                    <code className="home-uni-wallet" title={u.wallet_address}>
                      {formatWalletShort(u.wallet_address)}
                    </code>
                  ) : (
                    <span className="home-muted">—</span>
                  )}
                </dd>
              </div>

              <div className="home-uni-meta-row">
                <dt>Email</dt>
                <dd>
                  {u.institution_contact_email?.trim() ? (
                    <a href={`mailto:${u.institution_contact_email.trim()}`}>
                      {u.institution_contact_email.trim()}
                    </a>
                  ) : (
                    <span className="home-muted">—</span>
                  )}
                </dd>
              </div>

              <div className="home-uni-meta-row">
                <dt>Domain</dt>
                <dd className="home-uni-domain">{u.domain_email?.trim() || "—"}</dd>
              </div>

            </dl>

          </div>

        </li>

      ))}

    </ul>

  )}

</section>

      {/* GLOSSARY */}

      <section className="home-panel">

        <h2 className="home-section-title">
          Credential Status Guide
        </h2>

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

              <td>
                The credential is active and
                verified.
              </td>

            </tr>

            <tr>

              <td>Revoked</td>

              <td>
                The credential has been cancelled
                by the issuing institution.
              </td>

            </tr>

            <tr>

              <td>Locked</td>

              <td>
                The credential is securely tied to
                its owner and cannot be
                transferred.
              </td>

            </tr>

          </tbody>

        </table>

      </section>

      {/* FAQ */}

      <section className="home-mock-faq-wrap">

        <h2 className="home-mock-protocol-faq-title">
          Frequently Asked Questions
        </h2>

        <div className="home-faq home-faq--protocol">

          <details>

            <summary>
              Why is TrueCert secure?
            </summary>

            <p>
              TrueCert uses secure verification
              technology to help protect academic
              credentials from fraud or
              unauthorized changes.
            </p>

          </details>

          <details>

            <summary>
              Why is my certificate taking time
              to load?
            </summary>

            <p>
              Verification records may sometimes
              take a few moments to fully load
              depending on network activity.
            </p>

          </details>

          <details>

            <summary>
              What happens if a credential is
              revoked?
            </summary>

            <p>
              The issuing institution has marked
              the credential as no longer valid.
            </p>

          </details>

          <details>

            <summary>
              Who can issue credentials?
            </summary>

            <p>
              Only approved and verified
              institutions can issue credentials
              through TrueCert.
            </p>

          </details>

          <details>

            <summary>
              Can employers verify certificates?
            </summary>

            <p>
              Yes. Employers can instantly verify
              credentials through the public
              verification portal.
            </p>

          </details>

        </div>

      </section>

      {/* FOOTER */}

      <footer className="home-footer">

        <nav
          className="home-footer-nav"
          aria-label="Footer"
        >

          <Link to="/verify">
            Verify
          </Link>

          <span className="home-footer-sep">
            ·
          </span>

          <Link to="/register">
            Register
          </Link>

          <span className="home-footer-sep">
            ·
          </span>

          <Link to="/login">
            Login
          </Link>

          {REPO_URL ? (
            <>
              <span className="home-footer-sep">
                ·
              </span>

              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </>
          ) : null}

        </nav>

        <p className="home-disclaimer">
          TrueCert — COMP 3901 Capstone Project
        </p>

      </footer>

    </div>
  );
}