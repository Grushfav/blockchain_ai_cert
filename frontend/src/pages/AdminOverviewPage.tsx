import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE, apiJson } from "../api/client";
import type { PublicConfig, PublicKeyEntry } from "../types/publicConfig";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { MintMiniBars } from "../components/MintAnalyticsCharts";

type DigestPeriod = "today" | "rolling_7d";

type DigestWindowMetrics = {
  activity_by_action: Record<string, number>;
  failures: {
    mint_authorization_requests_failed?: number;
    mint_batch_rows_mint_failed_touched?: number;
    eip712_single_mint_failed_by_code?: Record<string, number>;
  };
  issued_mint_hour_histogram_utc: number[];
};

type OperationsDigestResponse = {
  metrics: {
    documentation: Record<string, string>;
    computed_at_utc: string;
    today: DigestWindowMetrics;
    rolling_7d: DigestWindowMetrics;
    trends: Record<string, number>;
    attention: {
      risk_flags_by_severity?: Record<string, number>;
      institutions_with_any_risk_flag?: number;
      batches_high_mint_failed_count?: number;
      batches_high_mint_failed_rolling_7d?: unknown[];
      signals_v1?: { issued_week_up_vs_prior_50pct_and_min5?: boolean };
    };
  };
  ai_text: string | null;
  ai_error: string | null;
  model: string | null;
};

function renderOperationsDigestAi(text: string): ReactNode {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  const bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="admin-ops-digest__ul">
        {bullets.map((b, i) => (
          <li key={i}>{b.replace(/^\s*[-*•]\s+/, "")}</li>
        ))}
      </ul>
    );
    bullets.length = 0;
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flush();
      continue;
    }
    if (t.startsWith("## ")) {
      flush();
      nodes.push(
        <h4 key={`h-${nodes.length}`} className="admin-ops-digest__section-title">
          {t.slice(3)}
        </h4>
      );
    } else if (/^[-*•]\s/.test(t)) {
      bullets.push(t);
    } else {
      flush();
      nodes.push(
        <p key={`p-${nodes.length}`} className="admin-ops-digest__plain muted-inline small">
          {t}
        </p>
      );
    }
  }
  flush();
  return <div className="admin-ops-digest__ai">{nodes}</div>;
}

function peakIssuedHourLabel(hist: number[]): string {
  let max = -1;
  let idx = 0;
  hist.forEach((c, h) => {
    if (c > max) {
      max = c;
      idx = h;
    }
  });
  if (max <= 0) return "—";
  return `UTC-5 ${idx}:00 (${max} issued)`;
}

function mintSeriesPeakInsight(series: { date: string; count: number }[]): string | null {
  if (!series.length) return null;
  let best = series[0]!;
  for (const p of series) {
    if (p.count > best.count) best = p;
  }
  if (best.count <= 0) return null;
  return `Busiest UTC-5 day in this window: ${best.date} (${best.count.toLocaleString()} mints).`;
}

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
    return `${s}M`;
  }
  if (n >= 10_000) {
    const v = n / 1000;
    const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
    return `${s}k`;
  }
  return n.toLocaleString();
}

function truncateMiddle(s: string, edge = 10): string {
  const t = s.trim();
  if (t.length <= edge * 2 + 1) return t;
  return `${t.slice(0, edge)}…${t.slice(-edge)}`;
}

function formatKeySnippet(k: PublicKeyEntry): string {
  const hex = (k.public_key_hex || "").replace(/^0x/i, "");
  if (hex.length >= 16) return `0x${truncateMiddle(hex, 8)}`;
  if (k.public_key_base64) return truncateMiddle(k.public_key_base64, 12);
  return k.kid || "—";
}

function RefreshIcon() {
  return (
    <svg className="admin-overview__refresh-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
      />
    </svg>
  );
}

type Summary = {
  generated_at_utc: string;
  university_id?: number | null;
  university_name?: string | null;
  scope?: string;
  lifecycle: {
    issued_total: number;
    claimed_locked: number;
    issued_unclaimed: number;
    claim_rate: number;
    revoked: number;
    burned: number;
  };
  issuance_volume: { activity_log_action_issued: { today: number; this_week: number; this_month: number } };
  mint_batches: { total: number; by_status: Record<string, number> };
};

type MintTimeseriesResponse = {
  series: { date: string; count: number }[];
  total_mints: number;
};

type InstitutionRow = {
  id: number;
  name: string;
  internal_id: string;
  status: string;
  certificates_indexed: number;
  activity_events: number;
  mint_batches: number;
  last_activity_at: string | null;
  risk?: {
    computed_at?: string | null;
    flag_count: number | null;
    highest_severity: "low" | "medium" | "high" | null;
    flag_codes?: string[];
    error?: string;
  };
};

export function AdminOverviewPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [institutions, setInstitutions] = useState<InstitutionRow[]>([]);
  const [instErr, setInstErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<OperationsDigestResponse | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestHttpErr, setDigestHttpErr] = useState<string | null>(null);
  const [digestPeriod, setDigestPeriod] = useState<DigestPeriod>("today");
  const [mint7Series, setMint7Series] = useState<{ date: string; count: number }[]>([]);
  const [mint7Total, setMint7Total] = useState<number | null>(null);
  const [mint7Err, setMint7Err] = useState<string | null>(null);
  const [trustCfg, setTrustCfg] = useState<PublicConfig | null>(null);
  const [trustErr, setTrustErr] = useState<string | null>(null);
  const [trustLoading, setTrustLoading] = useState(false);

  const loadDigest = useCallback(async () => {
    setDigestHttpErr(null);
    setDigestLoading(true);
    try {
      const d = await apiJson<OperationsDigestResponse>("/api/admin/ai/operations-digest");
      setDigest(d);
    } catch (e: unknown) {
      setDigest(null);
      setDigestHttpErr(e instanceof Error ? e.message : "Failed to load operations digest");
    } finally {
      setDigestLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setSumErr(null);
    setInstErr(null);
    setMint7Err(null);
    try {
      const [s, o, m] = await Promise.all([
        apiJson<Summary>("/api/admin/analytics/summary"),
        apiJson<{ institutions: InstitutionRow[] }>("/api/admin/analytics/institutions-overview?include_risk=true"),
        apiJson<MintTimeseriesResponse>("/api/admin/analytics/mints-timeseries?days=7").catch(() => null),
      ]);
      setSummary(s);
      setInstitutions(o.institutions || []);
      if (m) {
        setMint7Series(m.series || []);
        setMint7Total(typeof m.total_mints === "number" ? m.total_mints : null);
        setMint7Err(null);
      } else {
        setMint7Series([]);
        setMint7Total(null);
        setMint7Err("Mint snapshot unavailable");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load overview";
      setSumErr(msg);
      setInstErr(msg);
      setSummary(null);
      setInstitutions([]);
      setMint7Series([]);
      setMint7Total(null);
      setMint7Err(null);
    }
  }, []);

  const loadTrustAnchor = useCallback(async () => {
    setTrustErr(null);
    setTrustLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/public/config`);
      const j = (await res.json()) as PublicConfig & { error?: string };
      if (!res.ok) {
        setTrustCfg(null);
        setTrustErr(j.error || `Config HTTP ${res.status}`);
        return;
      }
      setTrustCfg(j);
    } catch (e: unknown) {
      setTrustCfg(null);
      setTrustErr(e instanceof Error ? e.message : "Could not load trust config");
    } finally {
      setTrustLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadDigest(), loadTrustAnchor()]);
  }, [load, loadDigest, loadTrustAnchor]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const verifiedCount = institutions.filter((i) => i.status === "verified").length;
  const digestSlice = digest?.metrics ? (digestPeriod === "today" ? digest.metrics.today : digest.metrics.rolling_7d) : null;
  const mint7dTotal = mint7Series.length
    ? mint7Total ?? mint7Series.reduce((a, p) => a + p.count, 0)
    : null;
  const mintInsight = mint7Series.length ? mintSeriesPeakInsight(mint7Series) : null;

  return (
    <div className="admin-overview shell-content">
      <header className="admin-analytics-header admin-overview__page-header">
        <div>
          <h1>Admin Operations overview</h1>
          <p className="muted-inline admin-overview__tagline">
            Real-time cryptographic monitoring and institutional activity audit trail.
          </p>
        </div>
        <div className="toolbar-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button type="button" className="btn-secondary admin-overview__refresh" onClick={() => void refreshAll()}>
            <RefreshIcon />
            <span>Refresh</span>
          </button>
          <Link to="/admin" className="btn-secondary">
            Universities
          </Link>
          <Link to="/admin/analytics" className="btn-secondary">
            Analytics
          </Link>
          <Link to="/admin/risk" className="btn-secondary">
            Risk board
          </Link>
        </div>
      </header>

      <section className="panel admin-overview__trust" aria-labelledby="admin-overview-trust-heading">
        <div className="admin-overview__trust-head">
          <h2 id="admin-overview-trust-heading" className="admin-overview__trust-title">
            Platform - Trust anchor
          </h2>
          <Link to="/#trust-panel" className="btn-text admin-overview__trust-site-link">
            View full trust copy on site
          </Link>
        </div>
        <p className="muted-inline small admin-overview__trust-lede">
        
        </p>
        {trustLoading && (
          <div className="ai-summary__loading" role="status" aria-live="polite">
            <LoadingSpinner size="sm" label="Loading trust config" />
            <span>Loading trust config…</span>
          </div>
        )}
        {!trustLoading && trustErr && (
          <div className="ai-summary__error">
            <div className="error" style={{ marginTop: 0 }}>
              {trustErr}
            </div>
            <button type="button" className="btn-secondary" onClick={() => void loadTrustAnchor()}>
              Retry
            </button>
          </div>
        )}
        {!trustLoading && !trustErr && trustCfg && (
          <>
            <dl className="admin-overview__trust-grid">
              <div className="admin-overview__trust-item">
                <dt>Network</dt>
                <dd>
                  {trustCfg.network_name}{" "}
                  <span className="muted-inline small">(chainId {trustCfg.chain_id})</span>
                </dd>
              </div>
              <div className="admin-overview__trust-item">
                <dt>TrueCert contract</dt>
                <dd>
                  {trustCfg.contract_address ? (
                    <>
                      <code className="mono admin-overview__trust-mono">{trustCfg.contract_address}</code>
                      {trustCfg.contract_explorer_url ? (
                        <>
                          {" "}
                          <a
                            href={trustCfg.contract_explorer_url}
                            className="btn-text"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Explorer
                          </a>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted-inline">Not configured</span>
                  )}
                </dd>
              </div>
              <div className="admin-overview__trust-item">
                <dt>IPFS gateway (read)</dt>
                <dd>
                  <code className="mono admin-overview__trust-mono">{trustCfg.pinata_gateway_base || "—"}</code>
                </dd>
              </div>
              <div className="admin-overview__trust-item">
                <dt>Active signing KID</dt>
                <dd>
                  {trustCfg.active_signing_kid ? (
                    <code className="mono admin-overview__trust-mono">{trustCfg.active_signing_kid}</code>
                  ) : (
                    <span className="muted-inline">—</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="admin-overview__trust-keys">
              <h3 className="admin-overview__trust-keys-heading">Verification keys (Ed25519)</h3>
              {!trustCfg.truecert_public_keys?.length ? (
                <p className="muted-inline small">None published.</p>
              ) : (
                <ul className="admin-overview__trust-key-list">
                  {trustCfg.truecert_public_keys.map((k, i) => (
                    <li key={k.kid || `public-key-${i}`}>
                      <span className="admin-overview__trust-key-kid">
                        <code className="mono">{k.kid || "—"}</code>
                      </span>
                      <code className="mono admin-overview__trust-key-snippet" title={k.public_key_hex || k.public_key_base64}>
                        {formatKeySnippet(k)}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="muted-inline small admin-overview__trust-snapshot">
              Config snapshot:{" "}
              {(() => {
                try {
                  return new Date(trustCfg.updated_at).toLocaleString();
                } catch {
                  return trustCfg.updated_at;
                }
              })()}
            </p>
          </>
        )}
      </section>

      <div className="admin-overview__hero">
        <section className="panel admin-overview__mint-panel" aria-labelledby="admin-overview-mint-snap">
          <h2 id="admin-overview-mint-snap" className="admin-overview__panel-title">
            Platform mints
          </h2>
          {mint7Err && <p className="muted-inline small">{mint7Err}</p>}
          {!mint7Err && mint7Series.length > 0 && mint7dTotal !== null && (
            <div className="mint-snapshot-card mint-snapshot-card--hero">
              <div className="mint-snapshot-card__body">
                <span className="mint-snapshot-card__kicker">Mints last 7d (UTC-5)</span>
                <p className="mint-snapshot-card__hero-value">{mint7dTotal.toLocaleString()}</p>
                {mintInsight ? (
                  <p className="mint-snapshot-card__insight">
                    <em>{mintInsight}</em>
                  </p>
                ) : (
                  <p className="mint-snapshot-card__sub">Indexed activity log · one bar per UTC-5 day</p>
                )}
                <p className="mint-snapshot-card__link">
                  <Link to="/admin/analytics">View analytics →</Link>
                </p>
              </div>
              <div className="mint-snapshot-card__chart">
                <MintMiniBars series={mint7Series} />
              </div>
            </div>
          )}
          {!mint7Err && mint7Series.length === 0 && summary && (
            <p className="muted-inline small">No indexed mints in the last 7 UTC-5 days.</p>
          )}
        </section>

        <section className="panel admin-ops-digest admin-overview__digest-panel" aria-labelledby="admin-ops-digest-heading">
          <div className="admin-ops-digest__topbar">
            <h2 id="admin-ops-digest-heading" className="admin-overview__panel-title">
              Operations digest
            </h2>
            <div className="admin-ops-digest__topbar-right">
              <span className="ai-summary__badge ai-summary__badge--sparkle">AI · ADVISORY</span>
              <div className="admin-ops-digest__tabs admin-ops-digest__tabs--segmented" role="tablist" aria-label="Digest window">
                <button
                  type="button"
                  role="tab"
                  aria-selected={digestPeriod === "today"}
                  className={`tab ghost${digestPeriod === "today" ? " active" : ""}`}
                  onClick={() => setDigestPeriod("today")}
                >
                  Today (UTC-5 day)
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={digestPeriod === "rolling_7d"}
                  className={`tab ghost${digestPeriod === "rolling_7d" ? " active" : ""}`}
                  onClick={() => setDigestPeriod("rolling_7d")}
                >
                  Rolling 7d
                </button>
              </div>
            </div>
          </div>
          <p className="admin-ops-digest__fineprint muted-inline small">
            <em>
              Aggregate metrics only (no learner PII). Confirm in Analytics and Risk board before acting on AI text.
            </em>
          </p>
          <div className="admin-ops-digest__toolbar">
            <span className="admin-ops-digest__toolbar-spacer" aria-hidden />
            <button type="button" className="btn-secondary btn-secondary--compact" onClick={() => void loadDigest()} disabled={digestLoading}>
              Refresh digest
            </button>
          </div>
          {digest?.metrics?.documentation?.rolling_7d_window && (
            <p className="muted-inline small mono" style={{ marginBottom: "0.75rem" }}>
              Windows: see <code>metrics.documentation</code> in API — rolling week is last 7 calendar days (not ISO
              week).
            </p>
          )}
          {digestLoading && (
            <div className="ai-summary__loading" role="status" aria-live="polite">
              <LoadingSpinner size="sm" label="Loading digest" />
              <span>Loading digest…</span>
            </div>
          )}
          {!digestLoading && digestHttpErr && (
            <div className="ai-summary__error">
              <div className="error" style={{ marginTop: 0 }}>
                {digestHttpErr}
              </div>
              <button type="button" className="btn-secondary" onClick={() => void loadDigest()}>
                Retry
              </button>
            </div>
          )}
          {!digestLoading && !digestHttpErr && digest && digestSlice && (
            <div className="admin-ops-digest__metrics">
              <div className="admin-ops-digest__hero-row" aria-label="Primary activity counts">
                <div className="admin-ops-digest__hero-metric admin-ops-digest__hero-metric--issued">
                  <span className="admin-ops-digest__hero-label">Issued</span>
                  <span className="admin-ops-digest__hero-value">{(digestSlice.activity_by_action.issued ?? 0).toLocaleString()}</span>
                </div>
                <div className="admin-ops-digest__hero-metric">
                  <span className="admin-ops-digest__hero-label">Transferred</span>
                  <span className="admin-ops-digest__hero-value">
                    {(digestSlice.activity_by_action.transferred ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="admin-ops-digest__hero-metric admin-ops-digest__hero-metric--revoked">
                  <span className="admin-ops-digest__hero-label">Revoked</span>
                  <span className="admin-ops-digest__hero-value">{(digestSlice.activity_by_action.revoked ?? 0).toLocaleString()}</span>
                </div>
                <div className="admin-ops-digest__hero-metric">
                  <span className="admin-ops-digest__hero-label">Burned</span>
                  <span className="admin-ops-digest__hero-value">{(digestSlice.activity_by_action.burned ?? 0).toLocaleString()}</span>
                </div>
                <div className="admin-ops-digest__hero-metric">
                  <span className="admin-ops-digest__hero-label">Reissued</span>
                  <span className="admin-ops-digest__hero-value">{(digestSlice.activity_by_action.reissued ?? 0).toLocaleString()}</span>
                </div>
              </div>
              <div className="admin-ops-digest__insights">
                <h3 className="admin-ops-digest__insights-title">Summary insights</h3>
                <p className="muted-inline small">Computed {digest.metrics.computed_at_utc}</p>
                <ul className="admin-ops-digest__insights-list">
                  <li>
                    Other indexed actions: {(digestSlice.activity_by_action.other ?? 0).toLocaleString()} · MAR failed:{" "}
                    {digestSlice.failures.mint_authorization_requests_failed ?? 0} · Batch rows mint_failed (touch):{" "}
                    {digestSlice.failures.mint_batch_rows_mint_failed_touched ?? 0}
                  </li>
                  <li>
                    Peak issued hour ({digestPeriod === "today" ? "this UTC-5 day" : "rolling 7d"}):{" "}
                    {peakIssuedHourLabel(digestSlice.issued_mint_hour_histogram_utc)}
                  </li>
                  <li>
                    Trends — today vs yesterday issued: {digest.metrics.trends.issued_today_utc_day_to_now ?? 0} vs{" "}
                    {digest.metrics.trends.issued_yesterday_full_utc_day ?? 0} (Δ{" "}
                    {digest.metrics.trends.issued_delta_today_minus_yesterday ?? 0}) · last 7d vs prior 7d:{" "}
                    {digest.metrics.trends.issued_rolling_7d ?? 0} vs {digest.metrics.trends.issued_prior_7d ?? 0} (Δ{" "}
                    {digest.metrics.trends.issued_delta_last_7d_minus_prior_7d ?? 0})
                  </li>
                  <li>
                    Risk snapshot: institutions with any flag {digest.metrics.attention.institutions_with_any_risk_flag ?? 0}{" "}
                    · severity mix:{" "}
                    {Object.entries(digest.metrics.attention.risk_flags_by_severity ?? {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ") || "—"}{" "}
                    · high mint_failed batches (7d): {digest.metrics.attention.batches_high_mint_failed_count ?? 0}
                    {digest.metrics.attention.signals_v1?.issued_week_up_vs_prior_50pct_and_min5
                      ? " · week-on-week mint spike signal"
                      : ""}
                  </li>
                </ul>
              </div>
            </div>
          )}
          {!digestLoading && !digestHttpErr && digest && (
            <div className="admin-ops-digest__ai-block admin-ops-digest__ai-block--nest">
              <h3 className="admin-ops-digest__ai-heading">AI bullet summary</h3>
              {digest.ai_error && !digest.ai_text && (
                <p className="muted-inline small">
                  {digest.ai_error}
                  {digest.model ? (
                    <>
                      {" "}
                      (<code>{digest.model}</code>)
                    </>
                  ) : null}
                </p>
              )}
              {digest.ai_text && renderOperationsDigestAi(digest.ai_text)}
              {digest.ai_text && digest.model && (
                <p className="ai-summary__meta" style={{ marginTop: "0.75rem" }}>
                  Model: <code>{digest.model}</code>
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      {(sumErr || instErr) && <div className="error">{sumErr || instErr}</div>}

      {summary && (
        <section className="panel admin-analytics-grid admin-overview__snapshot">
          <h2>Platform snapshot</h2>
          <p className="muted-inline small">Generated {new Date(summary.generated_at_utc).toLocaleString()} (API timestamp field)</p>
          <div className="stat-cards stat-cards--overview">
            <div className="stat-card stat-card--accent-blue">
              <span className="stat-label">Institutions</span>
              <span className="stat-value">{institutions.length}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Verified issuers</span>
              <span className="stat-value">{verifiedCount.toLocaleString()}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Active issued (index)</span>
              <span className="stat-value" title={summary.lifecycle.issued_total.toLocaleString()}>
                {formatCompactCount(summary.lifecycle.issued_total)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Mints today (UTC-5)</span>
              <span className="stat-value stat-value--accent">
                {summary.issuance_volume.activity_log_action_issued.today.toLocaleString()}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Mint batches</span>
              <span className="stat-value">{summary.mint_batches.total.toLocaleString()}</span>
            </div>
            <div className="stat-card stat-card--accent-amber">
              <span className="stat-label">Claim rate</span>
              <span className="stat-value">{(summary.lifecycle.claim_rate * 100).toFixed(1)}%</span>
            </div>
          </div>
        </section>
      )}

      <section className="panel admin-overview__institutions">
        <div className="admin-overview__section-head">
          <div>
            <h2>Institutions — activity &amp; risk snapshot</h2>
            <p className="muted-inline small">
              Risk columns use the same deterministic rules as the institution risk dashboard (no Gemini on this table).
            </p>
          </div>
          {institutions.length > 0 ? (
            <p className="muted-inline small admin-overview__entity-count">
              Showing {institutions.length} {institutions.length === 1 ? "institution" : "institutions"}
            </p>
          ) : null}
        </div>
        {institutions.length === 0 && !instErr && <p className="muted-inline">No institutions yet.</p>}
        {institutions.length > 0 && (
          <div className="table-wrap">
            <table className="admin-analytics-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Institution</th>
                  <th>Status</th>
                  <th>Certs (index)</th>
                  <th>Activity events</th>
                  <th>Batches</th>
                  <th>Last activity</th>
                  <th>Risk flags</th>
                  <th>Severity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {institutions.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="muted-inline small mono">{r.internal_id}</div>
                    </td>
                    <td>
                      <span className={`status ${r.status}`}>{r.status}</span>
                    </td>
                    <td>{r.certificates_indexed}</td>
                    <td>{r.activity_events}</td>
                    <td>{r.mint_batches}</td>
                    <td className="mono small">{r.last_activity_at ? r.last_activity_at.slice(0, 19) : "—"}</td>
                    <td className="small">
                      {r.risk?.error ? (
                        <span className="muted-inline">—</span>
                      ) : (
                        <>
                          {r.risk?.flag_count ?? 0}
                          {r.risk?.flag_codes && r.risk.flag_codes.length > 0 ? (
                            <div className="muted-inline small mono" style={{ maxWidth: "14rem" }}>
                              {r.risk.flag_codes.slice(0, 4).join(", ")}
                              {(r.risk.flag_codes.length || 0) > 4 ? "…" : ""}
                            </div>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td>
                      {r.risk?.highest_severity ? (
                        <span className={`status ${r.risk.highest_severity}`}>{r.risk.highest_severity}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <Link to={`/admin/analytics?university_id=${r.id}`} className="btn-text">
                        Metrics
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
