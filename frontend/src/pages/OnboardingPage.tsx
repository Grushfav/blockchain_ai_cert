import { Link } from "react-router-dom";
import {
  Wallet,
  Building2,
  Shield,
  Stamp,
  Search,
  Settings2,
  Link2,
  BarChart3,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  Circle,
} from "lucide-react";

import { BusyLabel } from "../components/LoadingSpinner";
import { OnboardingStepFigures, type OnboardingFigure } from "../components/OnboardingStepFigures";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
  useOnboardingProgress,
} from "../hooks/useOnboardingProgress";
import truecertLogo from "../images/truecert_logo.png";
import downloadMetamaskImg from "../images/download_metamask_step1.png";
import requestPolImg from "../images/request_POL_matic.png";
import registerUniversityImg from "../images/register_university_step2.png";
import adminLoginImg from "../images/admin_login_2.5.png";
import whitelistImg from "../images/whitelist_institution_step3.png";
import loginMintImg from "../images/login_mint_1stcert.png";
import mintSignImg from "../images/mint_cert_sign_wallet.png";
import verifyImg from "../images/verify_cert.png";
import certificateActionsImg from "../images/certificate actions.png";
import connectWalletImg from "../images/connect_issuer_wallet.png";
import viewMetricsImg from "../images/view_analytics_metrics.png";

const STEP_ICONS: Record<OnboardingStepId, typeof Wallet> = {
  wallet: Wallet,
  register: Building2,
  admin_whitelist: Shield,
  connect_wallet: Link2,
  mint: Stamp,
  verify: Search,
  actions: Settings2,
  metrics: BarChart3,
};

const STEP_FIGURES: Record<OnboardingStepId, OnboardingFigure[]> = {
  wallet: [
    { src: downloadMetamaskImg, alt: "Download and install MetaMask", caption: "Install MetaMask (or another EVM wallet)." },
    { src: requestPolImg, alt: "Request test POL on Polygon Amoy faucet", caption: "Request test POL for your issuer wallet on the Amoy faucet." },
  ],
  register: [
    {
      src: registerUniversityImg,
      alt: "University registration form with issuer wallet address",
      caption: "Register the institution and paste your public issuer wallet only.",
    },
  ],
  admin_whitelist: [
    { src: adminLoginImg, alt: "Admin login to TrueCert", caption: "Log in with the bootstrap admin account." },
    {
      src: whitelistImg,
      alt: "Admin approves institution and whitelists issuer on-chain",
      caption: "Approve the pending institution to whitelist the issuer wallet.",
    },
  ],
  connect_wallet: [
    {
      src: connectWalletImg,
      alt: "Connect issuer wallet in institution settings",
      caption: "Connect the registered issuer wallet on Polygon Amoy (Settings → Wallet).",
    },
  ],
  mint: [
    { src: loginMintImg, alt: "Institution portal mint workflow", caption: "Open the Issue tab to prepare and mint a credential." },
    {
      src: mintSignImg,
      alt: "Sign EIP-712 mint authorization in MetaMask",
      caption: "Sign the authorization in MetaMask (no gas), then submit mint.",
    },
  ],
  verify: [
    { src: verifyImg, alt: "Public certificate verification result", caption: "Verify by token ID or credential fields on the public page." },
  ],
  actions: [
    {
      src: certificateActionsImg,
      alt: "Claim revoke burn and reissue actions in institution portal",
      caption: "Use Actions to claim, revoke, burn, or reissue with the issuer wallet.",
    },
  ],
  metrics: [
    {
      src: viewMetricsImg,
      alt: "Institution analytics dashboard with mint charts",
      caption: "Review issues per day and mint timing heatmaps under Analytics.",
    },
  ],
};

const AMOY_NETWORK = {
  chainId: "80002 (0x13882)",
  rpc: "https://rpc-amoy.polygon.technology",
  symbol: "POL",
  explorer: "https://amoy.polygonscan.com",
};

export function OnboardingPage() {
  const {
    completedCount,
    percent,
    checking,
    markComplete,
    resetProgress,
    refresh,
    isComplete,
    isAuto,
  } = useOnboardingProgress();

  return (
    <div className="onboarding-page">
      <header className="onboarding-page__hero panel">
        <img src={truecertLogo} alt="" className="onboarding-page__logo" width={72} height={72} />
        <p className="onboarding-page__eyebrow">Capstone demo walkthrough</p>
        <h1 className="onboarding-page__title">TrueCert onboarding</h1>
        <p className="onboarding-page__lead muted-inline">
          Follow these eight steps end-to-end: wallet setup, registration, admin approval, issuer wallet connection,
          minting, verification, lifecycle actions, and analytics. Progress saves in your browser and refreshes when
          you log in or complete on-chain steps.
        </p>

        <div className="onboarding-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="onboarding-progress__bar" style={{ width: `${percent}%` }} />
        </div>
        <div className="onboarding-progress__meta">
          <span>
            <strong>{completedCount}</strong> of {ONBOARDING_STEPS.length} steps complete ({percent}%)
          </span>
          <span className="onboarding-progress__actions">
            <button type="button" className="btn-secondary btn-secondary--sm" onClick={() => void refresh()} disabled={checking}>
              <RefreshCw size={14} aria-hidden />
              <BusyLabel busy={checking} idle="Refresh status" busyLabel="Checking…" />
            </button>
            <button type="button" className="btn-secondary btn-secondary--sm" onClick={resetProgress}>
              Reset progress
            </button>
          </span>
        </div>
      </header>

      <ol className="onboarding-steps">
        {ONBOARDING_STEPS.map((step, index) => {
          const done = isComplete(step.id);
          const auto = isAuto(step.id);
          const Icon = STEP_ICONS[step.id];
          const isFirstIncomplete =
            !done && ONBOARDING_STEPS.findIndex((s) => !isComplete(s.id)) === index;

          return (
            <li
              key={step.id}
              className={`onboarding-step panel${done ? " onboarding-step--done" : ""}${
                isFirstIncomplete ? " onboarding-step--highlight" : ""
              }`}
            >
              <div className="onboarding-step__head">
                <span className={`onboarding-step__badge${done ? " onboarding-step__badge--done" : ""}`} aria-hidden>
                  {done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                </span>
                <span className="onboarding-step__icon" aria-hidden>
                  <Icon size={22} />
                </span>
                <div className="onboarding-step__titles">
                  <span className="onboarding-step__kicker">
                    Step {index + 1}
                    {auto && done ? " · detected automatically" : ""}
                  </span>
                  <h2 className="onboarding-step__title">{step.title}</h2>
                </div>
              </div>

              <p className="onboarding-step__summary muted-inline">{step.summary}</p>

              <OnboardingStepFigures figures={STEP_FIGURES[step.id]} />

              {step.id === "wallet" && (
                <div className="onboarding-step__detail">
                  <h3 className="onboarding-step__subhead">Add Polygon Amoy in MetaMask</h3>
                  <ul className="onboarding-step__list">
                    <li>
                      Network name: <strong>Polygon Amoy</strong>
                    </li>
                    <li>
                      Chain ID: <code className="mono">{AMOY_NETWORK.chainId}</code>
                    </li>
                    <li>
                      RPC URL: <code className="mono">{AMOY_NETWORK.rpc}</code>
                    </li>
                    <li>
                      Currency: <strong>{AMOY_NETWORK.symbol}</strong> (test POL)
                    </li>
                    <li>
                      Explorer:{" "}
                      <a href={AMOY_NETWORK.explorer} target="_blank" rel="noreferrer">
                        {AMOY_NETWORK.explorer}
                      </a>
                    </li>
                  </ul>
                  <p className="muted-inline small">
                    Request test tokens for the wallet you will register as the <strong>issuer</strong> address. Mint gas
                    is paid by the platform minter; your issuer wallet still needs POL for claim and other actions.
                  </p>
                </div>
              )}

              {step.id === "admin_whitelist" && (
                <div className="onboarding-step__detail">
                  <ol className="onboarding-step__list onboarding-step__list--ordered">
                    <li>
                      <Link to="/login">Log in</Link> with the admin account configured through{" "}
                      <code>BOOTSTRAP_ADMIN_EMAIL</code> and <code>BOOTSTRAP_ADMIN_PASSWORD</code>.
                    </li>
                    <li>
                      Open <Link to="/admin">Admin queue</Link>, review the pending institution, and click{" "}
                      <strong>Approve</strong> to whitelist the issuer wallet on-chain.
                    </li>
                  </ol>
                </div>
              )}

              {step.id === "connect_wallet" && (
                <div className="onboarding-step__detail">
                  <ol className="onboarding-step__list onboarding-step__list--ordered">
                    <li>
                      <Link to="/login">Log in</Link> as the institution after admin approval.
                    </li>
                    <li>
                      Open <Link to="/university?mode=settings">Settings → Wallet</Link> or use the sidebar{" "}
                      <strong>Connect issuer wallet</strong> control.
                    </li>
                    <li>
                      Confirm the header shows <strong>issuer wallet ready</strong> and chain <strong>80002</strong> (Amoy).
                    </li>
                  </ol>
                </div>
              )}

              {step.id === "mint" && (
                <div className="onboarding-step__detail">
                  <ol className="onboarding-step__list onboarding-step__list--ordered">
                    <li>
                      Use <strong>Generate credential</strong> → sign EIP-712 in MetaMask → <strong>Submit mint</strong>.
                    </li>
                    <li>Note the <strong>token ID</strong> from the success message for verify and claim.</li>
                  </ol>
                </div>
              )}

            

              {step.id === "actions" && (
                <div className="onboarding-step__detail">
                  <p className="muted-inline small">
                    Open <Link to="/university?mode=actions">Actions</Link>: <strong>Claim</strong> transfers the NFT to
                    the student and locks it; <strong>Revoke</strong>, <strong>Burn</strong>, and{" "}
                    <strong>Reissue</strong> are also issuer-wallet transactions.
                  </p>
                </div>
              )}

              <div className="onboarding-step__footer">
                {step.external?.map((link) => (
                  <a
                    key={link.href}
                    className="btn-secondary btn-secondary--sm"
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {link.label}
                    <ExternalLink size={14} aria-hidden />
                  </a>
                ))}
                {step.to && (
                  <Link className="btn-primary btn-primary--sm" to={step.to}>
                    Open step
                  </Link>
                )}
                {!done && (
                  <button type="button" className="btn-secondary btn-secondary--sm" onClick={() => markComplete(step.id)}>
                    Mark complete
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {percent === 100 && (
        <section className="panel onboarding-page__done">
          <h2 className="subhead">Onboarding complete</h2>
          <p className="muted-inline">
            You have walked through the full TrueCert demo path. Explore{" "}
            <Link to="/university/overview">institution analytics</Link> or{" "}
            <Link to="/admin/overview">admin overview</Link> next.
          </p>
        </section>
      )}
    </div>
  );
}
