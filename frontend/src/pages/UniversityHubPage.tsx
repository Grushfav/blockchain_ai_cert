import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { apiJson } from "../api/client";
import { BusyLabel } from "../components/LoadingSpinner";
import { InstitutionBottomNav } from "../components/InstitutionBottomNav";
import { institutionLogoDisplayUrl } from "../utils/institutionLogo";

type Me = {
  name: string;
  internal_id: string;
  status: string;
  wallet_address: string;
  contract_address: string;
  chain_id: number;
  logo_uri?: string | null;
  logo_url?: string | null;
};

type Summary = {
  generated_at_utc: string;
  explorer_tx_base: string;
  institution?: { name: string | null; internal_id: string | null };
  certificates_by_status: Record<string, number>;
  lifecycle: {
    issued_unclaimed: number;
    claimed_locked: number;
    claim_rate: number;
    revoked: number;
    burned: number;
    reissued_tokens: number;
    prepared: number;
    issued_total: number;
  };
  issuance_volume: {
    activity_log_action_issued: { today: number; this_week: number; this_month: number };
    note: string;
  };
  mint_batches: { total: number; by_status: Record<string, number> };
};

type BatchListItem = {
  id: number;
  status: string;
  original_filename: string;
  created_at: string | null;
  total_rows: number;
  snapshot_valid_rows: number;
  snapshot_invalid_rows: number;
  rows_minted_terminal: number;
  rows_mint_failed: number;
  rows_invalid: number;
};

type RiskHints = {
  computed_at: string;
  disclaimer: string;
  summary: { flag_count: number; highest_severity: "low" | "medium" | "high" | null };
  ai_summary_text?: string | null;
};

type ActivityEvent = {
  token_id: number | null;
  action: string;
  tx_hash: string | null;
  tx_explorer_url: string | null;
  created_at: string | null;
};

type PendingCounts = {
  latest_batch_id: number | null;
  rows_awaiting_preparation: number;
  mint_failed_rows: number;
  pending_single_mint_eip712: number;
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
}

function oneLineAi(text: string | null | undefined, max = 140): string | null {
  if (!text?.trim()) return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function formatIssuedCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`.replace(".0k", "k");
  return String(n);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function chainDisplayName(chainId: number): string {
  if (chainId === 80002) return "Polygon Amoy (testnet)";
  if (chainId === 137) return "Polygon";
  return `Chain ${chainId}`;
}

function shortAddr(hex: string): string {
  if (!hex || hex.length < 12) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function pendingPrimaryKey(p: PendingCounts): "prep" | "fail" | "eip" | null {
  const max = Math.max(p.rows_awaiting_preparation, p.mint_failed_rows, p.pending_single_mint_eip712);
  if (max <= 0) return null;
  if (p.rows_awaiting_preparation === max) return "prep";
  if (p.mint_failed_rows === max) return "fail";
  return "eip";
}

function explorerTxLinkLabel(chainId: number | undefined): string {
  if (chainId === 80002) return "Amoy Polygonscan →";
  if (chainId === 137) return "Polygonscan →";
  return "Block explorer →";
}

export function UniversityHubPage() {
  const { token, role } = useAuth();
  const navigate = useNavigate();

  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [latestBatch, setLatestBatch] = useState<BatchListItem | null>(null);
  const [risk, setRisk] = useState<RiskHints | null>(null);
  const [pending, setPending] = useState<PendingCounts | null>(null);
  const [notifs, setNotifs] = useState<
    { id: number; kind: string; title: string; body: string; created_at: string | null; read_at: string | null }[]
  >([]);
  const [latestTx, setLatestTx] = useState<ActivityEvent | null>(null);

  const loadAll = useCallback(async () => {
    setLoadErr(null);
    setBusy(true);
    try {
      const [
        meData,
        sumData,
        batchData,
        riskData,
        pendData,
        notifData,
        actData,
      ] = await Promise.all([
        apiJson<Me>("/api/university/me"),
        apiJson<Summary>("/api/university/analytics/summary"),
        apiJson<{ batches: BatchListItem[] }>("/api/university/analytics/batches?limit=1&offset=0"),
        apiJson<RiskHints>("/api/university/risk-hints?include_ai_summary=true"),
        apiJson<PendingCounts>("/api/university/hub-pending-counts"),
        apiJson<{ notifications: typeof notifs }>("/api/notifications?limit=30&offset=0"),
        apiJson<{ events: ActivityEvent[] }>("/api/university/analytics/recent-activity?limit=5"),
      ]);
      setMe(meData);
      setSummary(sumData);
      setLatestBatch(batchData.batches[0] ?? null);
      setRisk(riskData);
      setPending(pendData);
      setNotifs((notifData.notifications || []).slice(0, 3));
      setLatestTx(actData.events[0] ?? null);
    } catch (caught: unknown) {
      setLoadErr(caught instanceof Error ? caught.message : "Failed to load overview");
      setMe(null);
      setSummary(null);
      setLatestBatch(null);
      setRisk(null);
      setPending(null);
      setNotifs([]);
      setLatestTx(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token || role !== "university") {
      navigate("/login", { replace: true, state: { from: { pathname: "/university/overview" } } });
      return;
    }
    void loadAll();
  }, [token, role, navigate, loadAll]);

  const verified = me?.status === "verified";
  const logoSrc = useMemo(() => institutionLogoDisplayUrl(me?.logo_url, me?.logo_uri), [me?.logo_url, me?.logo_uri]);

  const aiLine = useMemo(() => oneLineAi(risk?.ai_summary_text), [risk?.ai_summary_text]);

  const pendingPrimary = useMemo(() => (pending ? pendingPrimaryKey(pending) : null), [pending]);

  async function copyTxHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
    } catch {
      // ignore
    }
  }

  if (!token || role !== "university") {
    return null;
  }

  return (
    <div className="inst-portal uni-hub">
      <header className="uni-hub__hero">
        <p className="uni-hub__eyebrow">Institution · Overview</p>
        <h1 className="uni-hub__title">University hub</h1>
        <p className="muted-inline uni-hub__lead">
          Read-only snapshot of issuance, risk, batches, and chain context. Open linked pages for full workflows.
        </p>
        <div className="uni-hub__hero-actions">
          <button type="button" className="btn-secondary" onClick={() => void loadAll()} disabled={busy} aria-busy={busy}>
            <BusyLabel busy={busy} idle="Reload hub" busyLabel="Loading…" />
          </button>
          <Link to="/university" className="btn-secondary" style={{ textDecoration: "none", display: "inline-flex" }}>
            Open portal
          </Link>
        </div>
      </header>

      {loadErr && <div className="error">{loadErr}</div>}

      {!verified && me && (
        <div className="warn-banner uni-hub__warn">
          Your institution is <strong>{me.status}</strong>. Some actions stay disabled until an administrator marks the
          profile verified.
        </div>
      )}

      <div className="uni-hub__grid">
        <section className="panel uni-hub__panel" aria-labelledby="hub-metrics">
          <div className="uni-hub__panel-head">
            <h2 id="hub-metrics" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                ▤
              </span>
              Issuance metrics
            </h2>
          </div>
          {busy && !summary ? (
            <p className="muted-inline">Loading…</p>
          ) : summary ? (
            <>
              <div className="uni-hub__spark-row">
                <div>
                  <span className="uni-hub__spark-label">Today</span>
                  <span className="uni-hub__spark-value">{formatIssuedCount(summary.issuance_volume.activity_log_action_issued.today)}</span>
                </div>
                <div>
                  <span className="uni-hub__spark-label">Week</span>
                  <span className="uni-hub__spark-value">{formatIssuedCount(summary.issuance_volume.activity_log_action_issued.this_week)}</span>
                </div>
                <div>
                  <span className="uni-hub__spark-label">Month</span>
                  <span className="uni-hub__spark-value">{formatIssuedCount(summary.issuance_volume.activity_log_action_issued.this_month)}</span>
                </div>
              </div>
              <dl className="uni-hub__metric-pairs">
                <div>
                  <dt>Indexed cert total</dt>
                  <dd>{Object.values(summary.certificates_by_status).reduce((a, b) => a + b, 0).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Batch upload total</dt>
                  <dd>{summary.mint_batches.total.toLocaleString()}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="muted-inline">No data.</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            <Link to="/university/analytics">View full analytics →</Link>
          </p>
        </section>

        <section className="panel uni-hub__panel" aria-labelledby="hub-risk">
          <div className="uni-hub__panel-head uni-hub__panel-head--split">
            <h2 id="hub-risk" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                🛡
              </span>
              Risk snapshot
            </h2>
            {risk && risk.summary.highest_severity === "high" && (
              <span className="uni-hub__badge uni-hub__badge--danger">High alert</span>
            )}
            {risk && risk.summary.highest_severity === "medium" && (
              <span className="uni-hub__badge uni-hub__badge--warn">Elevated</span>
            )}
          </div>
          {busy && !risk ? (
            <p className="muted-inline">Loading…</p>
          ) : risk ? (
            <>
              <p className="uni-hub__risk-flags">
                <strong>{risk.summary.flag_count}</strong> active flag{risk.summary.flag_count === 1 ? "" : "s"}
              </p>
              {risk.summary.highest_severity ? (
                <p className="uni-hub__risk-warn">
                  <span aria-hidden>⚠</span> Highest severity: <strong>{risk.summary.highest_severity}</strong>
                  {risk.summary.flag_count > 0 ? " — review risk dashboard for codes and context." : ""}
                </p>
              ) : null}
              <p className="muted-inline small uni-hub__disclaimer">{risk.disclaimer}</p>
              {aiLine ? (
                <div className="uni-hub__ai-nest">
                  <p className="uni-hub__ai-nest__text">{aiLine}</p>
                </div>
              ) : null}
              <p className="uni-hub__risk-meta muted-inline small">
                Computed {relativeTime(risk.computed_at)}
                {aiLine ? " · AI-trimmed summary when Gemini is configured" : ""}
              </p>
              <Link to="/university/risk" className="uni-hub__link-cta">
                Open risk dashboard →
              </Link>
            </>
          ) : (
            <p className="muted-inline">No data.</p>
          )}
        </section>

        <section className="panel uni-hub__panel" aria-labelledby="hub-batch">
          <div className="uni-hub__panel-head">
            <h2 id="hub-batch" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                ⧉
              </span>
              Latest batch
            </h2>
          </div>
          {busy && !latestBatch && !loadErr ? (
            <p className="muted-inline">Loading…</p>
          ) : latestBatch ? (
            <>
              <p className="uni-hub__batch-id">#{latestBatch.id}</p>
              <Link to="/university/analytics#inst-dash-csv-batches" className="uni-hub__batch-file">
                {latestBatch.original_filename}
              </Link>
              <p className="uni-hub__batch-line">
                <span aria-hidden>✓</span> {latestBatch.rows_minted_terminal} credential
                {latestBatch.rows_minted_terminal === 1 ? "" : "s"} in terminal mint states · {latestBatch.snapshot_valid_rows} valid
                rows
              </p>
              <p className="uni-hub__batch-line uni-hub__batch-line--muted">
                <span aria-hidden>⏱</span> Status {latestBatch.status} · {fmtTime(latestBatch.created_at)} UTC
              </p>
              <Link to="/university?mode=batch" className="uni-hub__btn-primary">
                Open batch mint
              </Link>
            </>
          ) : (
            <p className="muted-inline">No batch uploads yet.</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            {latestBatch ? <Link to="/university/analytics#inst-dash-csv-batches">On-chain batch analytics →</Link> : null}
          </p>
        </section>

        <section className="panel uni-hub__panel" aria-labelledby="hub-wallet">
          <div className="uni-hub__panel-head">
            <h2 id="hub-wallet" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                👛
              </span>
              Wallet &amp; chain
            </h2>
          </div>
          {me ? (
            <div className="uni-hub__wallet">
              <div className="uni-hub__wallet-id-row">
                {logoSrc ? <img src={logoSrc} alt="" className="uni-hub__wallet-logo" /> : null}
                <div>
                  <p className="uni-hub__inst-name">{me.name}</p>
                  <p className="uni-hub__wallet-internal">Internal ID · {me.internal_id}</p>
                </div>
              </div>
              <div className="uni-hub__wallet-field">
                <span className="uni-hub__wallet-label">Issuer address</span>
                <code className="uni-hub__wallet-value">{shortAddr(me.wallet_address)}</code>
              </div>
              <div className="uni-hub__wallet-field">
                <span className="uni-hub__wallet-label">Contract</span>
                <code className="uni-hub__wallet-value">{shortAddr(me.contract_address)}</code>
              </div>
              <div className="uni-hub__wallet-field">
                <span className="uni-hub__wallet-label">Chain</span>
                <span className="uni-hub__wallet-value">
                  <span aria-hidden>🔗</span> {chainDisplayName(me.chain_id)}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted-inline">—</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            <Link to="/university?mode=wallet">Wallet mode →</Link>
          </p>
        </section>

        <section className="panel uni-hub__panel uni-hub__panel--pending" aria-labelledby="hub-pending">
          <div className="uni-hub__panel-head uni-hub__panel-head--split">
            <h2 id="hub-pending" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                !
              </span>
              Pending actions
            </h2>
            <span className="uni-hub__panel-note muted-inline small">Latest batch = highest batch ID</span>
          </div>
          {busy && !pending ? (
            <p className="muted-inline">Loading…</p>
          ) : pending ? (
            <div className="uni-hub__pending-strip">
              <div
                className={`uni-hub__pending-cell${pendingPrimary === "prep" ? " uni-hub__pending-cell--primary" : ""}${
                  pending.rows_awaiting_preparation > 0 && pendingPrimary !== "prep" ? " uni-hub__pending-cell--warm" : ""
                }`}
              >
                <span className="uni-hub__pending-icon" aria-hidden>
                  ⚡
                </span>
                <span className="uni-hub__pending-num">{pending.rows_awaiting_preparation}</span>
                <span className="uni-hub__pending-label">Rows not prepared</span>
              </div>
              <div
                className={`uni-hub__pending-cell${pendingPrimary === "fail" ? " uni-hub__pending-cell--primary" : ""}${
                  pending.mint_failed_rows > 0 && pendingPrimary !== "fail" ? " uni-hub__pending-cell--warm" : ""
                }`}
              >
                <span className="uni-hub__pending-icon" aria-hidden>
                  ✎
                </span>
                <span className="uni-hub__pending-num">{pending.mint_failed_rows}</span>
                <span className="uni-hub__pending-label">Mint failed (latest batch)</span>
              </div>
              <div
                className={`uni-hub__pending-cell${pendingPrimary === "eip" ? " uni-hub__pending-cell--primary" : ""}${
                  pending.pending_single_mint_eip712 > 0 && pendingPrimary !== "eip" ? " uni-hub__pending-cell--warm" : ""
                }`}
              >
                <span className="uni-hub__pending-icon" aria-hidden>
                  ✉
                </span>
                <span className="uni-hub__pending-num">{pending.pending_single_mint_eip712}</span>
                <span className="uni-hub__pending-label">Awaiting EIP-712 (single mint)</span>
              </div>
            </div>
          ) : (
            <p className="muted-inline">—</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            Counts follow portal batch rules (same terminal row states as batch signing).
          </p>
        </section>

        <section className="panel uni-hub__panel" aria-labelledby="hub-notifs">
          <div className="uni-hub__panel-head">
            <h2 id="hub-notifs" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                🔔
              </span>
              Recent notifications
            </h2>
          </div>
          {notifs.length === 0 ? (
            <p className="muted-inline">No notifications yet.</p>
          ) : (
            <ul className="uni-hub__notif-list">
              {notifs.map((n) => (
                <li key={n.id}>
                  <div className="uni-hub__notif-row">
                    <span className={`uni-hub__notif-dot${n.read_at ? " uni-hub__notif-dot--read" : ""}`} aria-hidden />
                    <div className="uni-hub__notif-body">
                      <strong>{n.title}</strong>
                      <span className="uni-hub__notif-time">{relativeTime(n.created_at)}</span>
                    </div>
                    <span className="uni-hub__notif-chev" aria-hidden>
                      ›
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted-inline small uni-hub__panel-foot uni-hub__panel-foot--center">
            <Link to="/university/overview?openNotifications=1">View all notifications</Link>
          </p>
        </section>

        <section className="panel uni-hub__panel uni-hub__panel--wide" aria-labelledby="hub-funnel">
          <div className="uni-hub__panel-head uni-hub__panel-head--split">
            <h2 id="hub-funnel" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                ◎
              </span>
              Claim funnel
            </h2>
            <Link to="/university?mode=audit" className="uni-hub__panel-head-link">
              Audit portal
            </Link>
          </div>
          {summary ? (
            <>
              <p className="uni-hub__funnel-line">
                <strong>{summary.lifecycle.issued_unclaimed.toLocaleString()}</strong> unclaimed ·{" "}
                <strong>{summary.lifecycle.claimed_locked.toLocaleString()}</strong> locked ·{" "}
                <strong>{(summary.lifecycle.claim_rate * 100).toFixed(1)}%</strong> claim rate
              </p>
              <div
                className="uni-hub__funnel-bar"
                role="img"
                aria-label={`Claim rate about ${(summary.lifecycle.claim_rate * 100).toFixed(0)} percent`}
              >
                <div
                  className="uni-hub__funnel-bar__claimed"
                  style={{ flex: `0 0 ${Math.min(100, Math.max(0, summary.lifecycle.claim_rate * 100))}%` }}
                />
                <div className="uni-hub__funnel-bar__rest" />
              </div>
            </>
          ) : (
            <p className="muted-inline">—</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            <Link to="/university?mode=audit">Claim &amp; lifecycle in portal →</Link>
          </p>
        </section>

        <section className="panel uni-hub__panel uni-hub__panel--wide" aria-labelledby="hub-tx">
          <div className="uni-hub__panel-head">
            <h2 id="hub-tx" className="uni-hub__panel-title">
              <span className="uni-hub__panel-icon" aria-hidden>
                ⧗
              </span>
              Latest on-chain activity
            </h2>
          </div>
          {latestTx?.tx_hash ? (
            <div className="uni-hub__tx-strip">
              <div className="uni-hub__tx-strip__left">
                <span className="uni-hub__tx-strip__icon" aria-hidden>
                  ⧉
                </span>
                <div>
                  <p className="uni-hub__tx-strip__title">
                    {latestTx.action}
                    {latestTx.token_id != null ? ` · token ${latestTx.token_id}` : ""}
                  </p>
                  <p className="uni-hub__tx-strip__hash mono">{shortAddr(latestTx.tx_hash)}</p>
                </div>
                <button
                  type="button"
                  className="uni-hub__tx-copy"
                  title="Copy full tx hash"
                  onClick={() => void copyTxHash(latestTx.tx_hash!)}
                >
                  ⎘
                </button>
              </div>
              <div className="uni-hub__tx-strip__right">
                <span className="muted-inline small">{fmtTime(latestTx.created_at)} UTC</span>
                <a href={latestTx.tx_explorer_url || "#"} target="_blank" rel="noreferrer" className="uni-hub__tx-strip__link">
                  {explorerTxLinkLabel(me?.chain_id)}
                </a>
              </div>
            </div>
          ) : (
            <p className="muted-inline">No indexed activity yet. Sync from the portal audit tab.</p>
          )}
          <p className="muted-inline small uni-hub__panel-foot">
            <Link to="/university/analytics">View on-chain analytics →</Link>
          </p>
        </section>
      </div>

      <InstitutionBottomNav
        active={null}
        hrefFor={(k) => (k === "audit" ? "/university/risk" : `/university?mode=${k}`)}
      />
    </div>
  );
}
