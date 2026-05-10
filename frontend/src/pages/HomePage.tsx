import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  Shield,
  KeyRound,
  Eye,
  Building,
} from "lucide-react";

import { API_BASE } from "../api/client";
import batchIssuanceImg from "../images/batch_issuance.png";
import lifecycleControlsImg from "../images/lifecycle_controls.png";
import auditLogImg from "../images/audit_log.png";

import type { PublicConfig } from "../types/publicConfig";

type VerifiedUniversity = {
  name: string;
  internal_id: string;
  logo_url: string | null;
};

const REPO_URL = (
  import.meta.env.VITE_REPO_URL as string | undefined
)?.trim();

function homeRailItemClass(active: boolean): string {
  return `home-bottom-rail__item${active ? " active" : ""}`;
}

export function HomePage() {
  const location = useLocation();

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
  const path = location.pathname;
  const hash = location.hash;

  return (
    <div className="home-page home-page--mock">

      {/* HERO */}

      <section
        className="home-mock-hero-card"
        aria-label="Verifiers"
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
          credentials using blockchain technology.
          Prevent fraud, reduce manual verification,
          and give employers instant trust.
        </p>

        <Link
          to="/verify"
          className="home-mock-cta-link"
        >
          Verify Credentials →
        </Link>
      </section>

      {/* INSTITUTION CARD */}

      <div className="home-mock-role-grid home-mock-role-grid--single">

        <Link
          to="/register"
          className="home-mock-role-card"
        >
          <span className="home-mock-role-title">
            Institutions
          </span>

          <span className="home-mock-role-action home-mock-role-action--accent">
            Onboard →
          </span>
        </Link>

      </div>

      {/* TRUST CHIPS */}

      <section
        className="home-trust-logos"
        aria-label="Stack"
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

      <section>
  <h2 className="home-section-title">
    What We Offer
  </h2>

  <ul className="home-bullets">

    <li>
      Instantly verify academic credentials through
      a secure public verification portal.
    </li>

    <li>
      Allow institutions to securely issue, manage,
      revoke, and update digital certificates.
    </li>

    <li>
      Give employers and organizations real time
      access to trusted credential validation.
    </li>

    <li>
      Support large scale certificate issuance with
      streamlined batch processing tools.
    </li>

    <li>
      Protect certificate integrity using secure
      blockchainb backed verification technology.
    </li>

    <li>
      Maintain transparent credential history and
      audit records for institutions and administrators.
    </li>

    </ul>
    </section>

      {/* SECURITY SECTION */}

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
              Every credential is securely stored and
              validated against blockchain records to
              ensure authenticity and prevent fraud.
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
              Only verified institutions can issue
              credentials, ensuring trust and
              preventing unauthorized activity.
            </p>

          </div>

        </div>
      </section>

      {/* VERIFICATION FLOW */}

      <section
        className="home-mock-split-flows"
        aria-label="Verification and lifecycle"
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
                  Validate certificates against secure
                  blockchain records.
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
                  Securely fetch credential metadata
                  and verification details.
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
                  Institutions securely register and
                  verify their identity.
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
                  Trusted administrators validate the
                  institution.
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
                  Credentials are securely generated
                  and issued.
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
                  Employers and institutions can
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
              Efficiently issue multiple credentials
              in a single workflow.
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
              Revoke, update, and manage credentials
              securely.
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
              Maintain transparent and secure activity
              tracking.
            </p>

          </div>

        </article>

      </section>

      {/* VERIFIED UNIVERSITIES */}

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

                <div>

                  <div className="home-uni-name">
                    {u.name}
                  </div>

                  <code className="home-uni-id">
                    {u.internal_id}
                  </code>

                </div>

              </li>

            ))}

          </ul>

        )}

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
          TruCert — COMP 3901 Capstone Project
        </p>

      </footer>

      {/* BOTTOM NAV */}

      <nav
        className="home-bottom-rail"
        aria-label="Primary destinations"
      >

        <NavLink
          to="/verify"
          className={({ isActive }) =>
            homeRailItemClass(isActive)
          }
        >

          <Shield
            className="home-bottom-rail__icon"
          />

          <span className="home-bottom-rail__label">
            Verify
          </span>

        </NavLink>

        <NavLink
          to="/login"
          className={() =>
            homeRailItemClass(
              path.startsWith("/university") ||
              path === "/login" ||
              path === "/register"
            )
          }
        >

          <Building
            className="home-bottom-rail__icon"
          />

          <span className="home-bottom-rail__label">
            Issuer
          </span>

        </NavLink>

        <Link
          to="/#trust-panel"
          className={homeRailItemClass(
            path === "/" &&
            hash === "#trust-panel"
          )}
        >

          <KeyRound
            className="home-bottom-rail__icon"
          />

          <span className="home-bottom-rail__label">
            Security
          </span>

        </Link>

      </nav>

    </div>
  );
}
