import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api/client";
import { TablePagination } from "../components/TablePagination";
import { usePagination } from "../hooks/usePagination";
import { MintHeatmapGrid, MintTimeseriesLineChart } from "../components/MintAnalyticsCharts";
import { institutionLogoDisplayUrl } from "../utils/institutionLogo";

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

type MeStrip = {
  name: string;
  internal_id: string;
  status: string;
  logo_uri?: string | null;
  logo_url?: string | null;
};

type Summary = {
  generated_at_utc: string;
  explorer_tx_base: string;
  institution?: { name: string | null; internal_id: string | null };
  certificates_by_status: Record<string, number>;
  lifecycle: {
    revoked: number;
    burned: number;
    reissued_tokens: number;
    prepared: number;
    issued_total: number;
    claimed_locked: number;
    issued_unclaimed: number;
    claim_rate: number;
  };
  issuance_volume: {
    activity_log_action_issued: { today: number; this_week: number; this_month: number };
    note: string;
  };
  reissues: { reissue_events: number; certificates_marked_reissued: number };
  eip712: {
    single_mint_authorization_requests: {
      requests_by_status: Record<string, number>;
      failed_requests_by_code: Record<string, number>;
    };
    batch_authorizations_recorded: number;
    single_mints_completed_via_request_table: number;
  };
  mint_batches: { total: number; by_status: Record<string, number> };
  mint_timing?: {
    note: string;
    pooled_avg_platform_mint_ms: number | null;
    pooled_sample_count: number;
    single_mint: {
      sample_count: number;
      avg_platform_mint_ms: number | null;
      last: {
        platform_mint_ms: number;
        completed_at_utc: string | null;
        cert_id: string;
      } | null;
    };
    batch_row_mint: { sample_count: number; avg_platform_mint_ms: number | null };
    last_batch_execute_chunk: {
      batch_id: number;
      last_execute_chunk_wall_ms: number;
      batch_updated_at_utc: string | null;
    } | null;
  };
};

type RecentEvent = {
  token_id: number | null;
  action: string;
  tx_hash: string | null;
  tx_explorer_url: string | null;
  block_number: number;
  created_at: string | null;
  block_timestamp: string | null;
  details: unknown;
};

type BatchListItem = {
  id: number;
  status: string;
  original_filename: string;
  created_at: string | null;
  total_rows: number;
  snapshot_valid_rows: number;
  snapshot_invalid_rows: number;
  rows_by_status: Record<string, number>;
  rows_minted_terminal: number;
  rows_mint_failed: number;
  rows_invalid: number;
  last_tx_hash: string | null;
  batch_authorized: boolean;
};

type BatchListResponse = { total: number; limit: number; offset: number; batches: BatchListItem[] };

type DashTab = "metrics" | "activity" | "batches";

type MintTimeseriesResponse = {
  timezone: string;
  days: number;
  series: { date: string; count: number }[];
  total_mints: number;
};

type MintHeatmapResponse = {
  timezone: string;
  days: number;
  cells: { weekday: number; hour: number; count: number }[];
  weekday_note?: string;
};

type BatchDetail = BatchListItem & {
  rows: Array<{
    id: number;
    row_index: number;
    cert_id: string | null;
    row_status: string;
    token_id: number | null;
    tx_hash: string | null;
    tx_explorer_url: string | null;
    error_message: string | null;
    minted_at: string | null;
  }>;
};

export function UniversityAnalyticsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentEvent[]>([]);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchOffset, setBatchOffset] = useState(0);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [me, setMe] = useState<MeStrip | null>(null);
  const [dashTab, setDashTab] = useState<DashTab>("metrics");
  const [logoFailed, setLogoFailed] = useState(false);
  const [mintDays, setMintDays] = useState<30 | 90>(30);
  const [mintSeries, setMintSeries] = useState<{ date: string; count: number }[]>([]);
  const [mintTotal, setMintTotal] = useState<number | null>(null);
  const [mintLoading, setMintLoading] = useState(false);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [heatDays, setHeatDays] = useState<30 | 90>(90);
  const [heatCells, setHeatCells] = useState<{ weekday: number; hour: number; count: number }[]>([]);
  const [heatLoading, setHeatLoading] = useState(false);
  const [heatErr, setHeatErr] = useState<string | null>(null);

  const recentPg = usePagination(recent, 10);
  const batchesPg = usePagination(batches, 10, batchOffset);
  const detailRowsPg = usePagination(detail?.rows ?? [], 10, detailId ?? "none");

  const loadSummary = useCallback(async () => {
    setSumErr(null);
    try {
      const s = await apiJson<Summary>("/api/university/analytics/summary");
      setSummary(s);
    } catch (e: unknown) {
      setSumErr(e instanceof Error ? e.message : "Failed to load analytics");
      setSummary(null);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    const data = await apiJson<{ events: RecentEvent[] }>("/api/university/analytics/recent-activity?limit=30");
    setRecent(data.events);
  }, []);

  const loadBatches = useCallback(async (offset: number) => {
    const data = await apiJson<BatchListResponse>(
      `/api/university/analytics/batches?limit=30&offset=${offset}`
    );
    setBatches(data.batches);
    setBatchTotal(data.total);
    setBatchOffset(data.offset);
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadRecent().catch(() => setRecent([]));
    void loadBatches(0).catch(() => setBatches([]));
  }, [loadSummary, loadRecent, loadBatches]);

  useEffect(() => {
    let cancelled = false;
    setMintLoading(true);
    setMintErr(null);
    void (async () => {
      try {
        const m = await apiJson<MintTimeseriesResponse>(
          `/api/university/analytics/mints-timeseries?days=${mintDays}`
        );
        if (!cancelled) {
          setMintSeries(m.series || []);
          setMintTotal(typeof m.total_mints === "number" ? m.total_mints : null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setMintSeries([]);
          setMintTotal(null);
          setMintErr(e instanceof Error ? e.message : "Failed to load mint timeseries");
        }
      } finally {
        if (!cancelled) setMintLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mintDays]);

  useEffect(() => {
    let cancelled = false;
    setHeatLoading(true);
    setHeatErr(null);
    void (async () => {
      try {
        const h = await apiJson<MintHeatmapResponse>(`/api/university/analytics/mints-heatmap?days=${heatDays}`);
        if (!cancelled) setHeatCells(h.cells || []);
      } catch (e: unknown) {
        if (!cancelled) {
          setHeatCells([]);
          setHeatErr(e instanceof Error ? e.message : "Failed to load mint heatmap");
        }
      } finally {
        if (!cancelled) setHeatLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [heatDays]);

  useEffect(() => {
    void apiJson<MeStrip>("/api/university/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    setLogoFailed(false);
  }, [me?.logo_url, me?.logo_uri]);

  async function openBatch(id: number) {
    setDashTab("batches");
    setDetailId(id);
    setDetailErr(null);
    setDetail(null);
    try {
      const d = await apiJson<BatchDetail>(`/api/university/analytics/batches/${id}`);
      setDetail(d);
    } catch (e: unknown) {
      setDetailErr(e instanceof Error ? e.message : "Failed to load batch");
    }
  }

  const displayName = me?.name || summary?.institution?.name || "Institution";
  const displayId = me?.internal_id || summary?.institution?.internal_id || null;
  const logoSrc = institutionLogoDisplayUrl(me?.logo_url, me?.logo_uri);

  return (
    <>
      <header>
        <h1>Institution dashboard</h1>
        <p className="muted-inline">
          Read-only issuance and batch metrics for your institution. Counts follow the activity index — use{" "}
          <strong>Sync and refresh</strong> in the portal (Audit → Activity log) if numbers look behind chain events.
        </p>
        <p className="muted-inline small">
          <Link to="/university">Open university portal</Link>
          {" · "}
          <button
            type="button"
            className="btn-text"
            onClick={() => {
              void loadSummary();
              void loadRecent().catch(() => setRecent([]));
              void loadBatches(batchOffset);
            }}
          >
            Reload figures
          </button>
        </p>
      </header>

      <div className="inst-portal inst-dashboard shell-content">
        <section className="inst-dashboard-hero" aria-label="Institution overview">
          <div className="inst-identity-row inst-dashboard-hero__row">
            {logoSrc && !logoFailed ? (
              <img
                src={logoSrc}
                alt=""
                className="inst-identity-avatar"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <span className="inst-identity-avatar inst-identity-avatar--ph" aria-hidden>
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="inst-identity-text">
              <p className="inst-identity-name">Dashboard</p>
              <p className="inst-identity-sub">
                {displayName}
                {displayId ? ` · ${displayId}` : ""}
                {me && (
                  <>
                    {" "}
                    · <span className={`status ${me.status}`}>{me.status}</span>
                  </>
                )}
              </p>
              {summary && (
                <p className="muted-inline small" style={{ margin: "0.35rem 0 0" }}>
                  Figures updated {new Date(summary.generated_at_utc).toLocaleString()}
                </p>
              )}
            </div>
            <div className="inst-dashboard-hero__actions">
              <Link to="/university" className="btn-secondary">
                Open portal
              </Link>
            </div>
          </div>
        </section>

        {sumErr && <div className="error">{sumErr}</div>}

        {dashTab === "metrics" && !summary && !sumErr && (
          <p className="muted-inline">Loading metrics…</p>
        )}

        {dashTab === "metrics" && summary && (
          <>
            <section className="panel inst-dashboard-panel">
              <div className="inst-card-head">
                <h2 className="inst-card-title">Credential lifecycle</h2>
              </div>
              <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Issued (active)</span>
                <span className="stat-value">{summary.lifecycle.issued_total}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Claimed (locked / SBT)</span>
                <span className="stat-value">{summary.lifecycle.claimed_locked}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Unclaimed</span>
                <span className="stat-value">{summary.lifecycle.issued_unclaimed}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Claim rate</span>
                <span className="stat-value">{(summary.lifecycle.claim_rate * 100).toFixed(1)}%</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Revoked</span>
                <span className="stat-value">{summary.lifecycle.revoked}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Burned</span>
                <span className="stat-value">{summary.lifecycle.burned}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Reissued (superseded)</span>
                <span className="stat-value">{summary.lifecycle.reissued_tokens}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Prepared (pending mint)</span>
                <span className="stat-value">{summary.lifecycle.prepared}</span>
              </div>
            </div>
          </section>

          <section className="panel inst-dashboard-panel">
            <div className="inst-card-head">
              <h2 className="inst-card-title">Issuance volume (indexed mint events)</h2>
            </div>
            <p className="muted-inline small">{summary.issuance_volume.note}</p>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Today (UTC)</span>
                <span className="stat-value">{summary.issuance_volume.activity_log_action_issued.today}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">This week</span>
                <span className="stat-value">{summary.issuance_volume.activity_log_action_issued.this_week}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">This month</span>
                <span className="stat-value">{summary.issuance_volume.activity_log_action_issued.this_month}</span>
              </div>
            </div>
          </section>

          <section className="panel inst-dashboard-panel" aria-labelledby="inst-mint-chart-heading">
            <div className="inst-card-head" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
              <h2 id="inst-mint-chart-heading" className="inst-card-title">
                Mints per day (UTC)
              </h2>
              <div className="admin-ops-digest__tabs" role="tablist" aria-label="Mint chart window">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mintDays === 30}
                  className={`tab ghost${mintDays === 30 ? " active" : ""}`}
                  onClick={() => setMintDays(30)}
                >
                  Last 30 days
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mintDays === 90}
                  className={`tab ghost${mintDays === 90 ? " active" : ""}`}
                  onClick={() => setMintDays(90)}
                >
                  Last 90 days
                </button>
              </div>
            </div>
            <p className="muted-inline small" style={{ marginTop: 0 }}>
              Indexed <code>issued</code> activity events; bucket date is UTC from block time or record time. Axes labeled
              UTC.
            </p>
            {mintErr && <div className="error">{mintErr}</div>}
            {mintLoading && !mintErr && <p className="muted-inline">Loading chart…</p>}
            {!mintLoading && !mintErr && mintSeries.length > 0 && (
              <>
                <p className="muted-inline small" style={{ marginBottom: "0.35rem" }}>
                  Total in window: <strong>{mintTotal ?? mintSeries.reduce((a, p) => a + p.count, 0)}</strong> mints
                </p>
                <MintTimeseriesLineChart series={mintSeries} height={mintDays === 90 ? 280 : 260} />
              </>
            )}
            {!mintLoading && !mintErr && mintSeries.length === 0 && (
              <p className="muted-inline">No indexed mints in this UTC window.</p>
            )}
          </section>

          <section className="panel inst-dashboard-panel" aria-labelledby="inst-mint-heat-heading">
            <div className="inst-card-head" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: "0.5rem" }}>
              <h2 id="inst-mint-heat-heading" className="inst-card-title">
                Mint timing heatmap (UTC)
              </h2>
              <div className="admin-ops-digest__tabs" role="tablist" aria-label="Heatmap window">
                <button
                  type="button"
                  role="tab"
                  aria-selected={heatDays === 30}
                  className={`tab ghost${heatDays === 30 ? " active" : ""}`}
                  onClick={() => setHeatDays(30)}
                >
                  30d
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={heatDays === 90}
                  className={`tab ghost${heatDays === 90 ? " active" : ""}`}
                  onClick={() => setHeatDays(90)}
                >
                  90d
                </button>
              </div>
            </div>
            <p className="muted-inline small" style={{ marginTop: 0 }}>
              Weekday × hour of day for indexed mints. Rows Mon→Sun; columns hour UTC (0–23).
            </p>
            {heatErr && <div className="error">{heatErr}</div>}
            {heatLoading && !heatErr && <p className="muted-inline">Loading heatmap…</p>}
            {!heatLoading && !heatErr && <MintHeatmapGrid cells={heatCells} />}
          </section>

          <div className="inst-dashboard-two-col">
            <section className="panel inst-dashboard-panel">
              <div className="inst-card-head">
                <h2 className="inst-card-title">Reissues</h2>
              </div>
              <div className="stat-cards">
                <div className="stat-card">
                  <span className="stat-label">Reissue events</span>
                  <span className="stat-value">{summary.reissues.reissue_events}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Old tokens marked reissued</span>
                  <span className="stat-value">{summary.reissues.certificates_marked_reissued}</span>
                </div>
              </div>
            </section>

            <section className="panel inst-dashboard-panel">
              <div className="inst-card-head">
                <h2 className="inst-card-title">EIP-712 mint authorization</h2>
              </div>
              <div className="stat-cards">
                <div className="stat-card">
                  <span className="stat-label">Single mints completed</span>
                  <span className="stat-value">{summary.eip712.single_mints_completed_via_request_table}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Batch auths signed</span>
                  <span className="stat-value">{summary.eip712.batch_authorizations_recorded}</span>
                </div>
              </div>
              <h3 className="subheading">Single-mint requests</h3>
              <ul className="kv-list">
                {Object.entries(summary.eip712.single_mint_authorization_requests.requests_by_status).map(
                  ([k, v]) => (
                    <li key={k}>
                      <code>{k || "—"}</code>: {v}
                    </li>
                  )
                )}
              </ul>
              <h3 className="subheading">Failed authorizations (by reason)</h3>
              <ul className="kv-list">
                {Object.keys(summary.eip712.single_mint_authorization_requests.failed_requests_by_code).length ===
                0 ? (
                  <li className="muted-inline">None</li>
                ) : (
                  Object.entries(summary.eip712.single_mint_authorization_requests.failed_requests_by_code).map(
                    ([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v}
                      </li>
                    )
                  )
                )}
              </ul>
            </section>
          </div>

          {summary.mint_timing && (
            <section className="panel inst-dashboard-panel">
              <div className="inst-card-head">
                <h2 className="inst-card-title">Mint timing (recorded)</h2>
              </div>
              <p className="muted-inline small">{summary.mint_timing.note}</p>
              <div className="stat-cards">
                <div className="stat-card">
                  <span className="stat-label">Avg mint time (platform)</span>
                  <span className="stat-value">
                    {summary.mint_timing.pooled_avg_platform_mint_ms != null
                      ? formatDurationMs(summary.mint_timing.pooled_avg_platform_mint_ms)
                      : "—"}
                  </span>
                  <span className="muted-inline small" style={{ display: "block", marginTop: "0.25rem" }}>
                    {summary.mint_timing.pooled_sample_count} sample
                    {summary.mint_timing.pooled_sample_count === 1 ? "" : "s"} (single + batch rows)
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Last single mint (platform)</span>
                  <span className="stat-value">
                    {summary.mint_timing.single_mint.last
                      ? formatDurationMs(summary.mint_timing.single_mint.last.platform_mint_ms)
                      : "—"}
                  </span>
                  {summary.mint_timing.single_mint.last?.completed_at_utc ? (
                    <span className="muted-inline small" style={{ display: "block", marginTop: "0.25rem" }}>
                      {new Date(summary.mint_timing.single_mint.last.completed_at_utc).toLocaleString()}
                      {summary.mint_timing.single_mint.last.cert_id
                        ? ` · ${summary.mint_timing.single_mint.last.cert_id}`
                        : ""}
                    </span>
                  ) : (
                    <span className="muted-inline small" style={{ display: "block", marginTop: "0.25rem" }}>
                      No timed single mints yet
                    </span>
                  )}
                </div>
                <div className="stat-card">
                  <span className="stat-label">Last batch mint (execute chunk wall)</span>
                  <span className="stat-value">
                    {summary.mint_timing.last_batch_execute_chunk
                      ? formatDurationMs(summary.mint_timing.last_batch_execute_chunk.last_execute_chunk_wall_ms)
                      : "—"}
                  </span>
                  {summary.mint_timing.last_batch_execute_chunk ? (
                    <span className="muted-inline small" style={{ display: "block", marginTop: "0.25rem" }}>
                      Batch #{summary.mint_timing.last_batch_execute_chunk.batch_id}
                      {summary.mint_timing.last_batch_execute_chunk.batch_updated_at_utc
                        ? ` · ${new Date(summary.mint_timing.last_batch_execute_chunk.batch_updated_at_utc).toLocaleString()}`
                        : ""}
                    </span>
                  ) : (
                    <span className="muted-inline small" style={{ display: "block", marginTop: "0.25rem" }}>
                      No timed batch executes yet
                    </span>
                  )}
                </div>
              </div>
              <p className="muted-inline small" style={{ marginTop: "0.75rem" }}>
                Single avg {formatDurationMs(summary.mint_timing.single_mint.avg_platform_mint_ms ?? undefined)} (
                {summary.mint_timing.single_mint.sample_count} mints) · Batch row avg{" "}
                {formatDurationMs(summary.mint_timing.batch_row_mint.avg_platform_mint_ms ?? undefined)} (
                {summary.mint_timing.batch_row_mint.sample_count} rows)
              </p>
            </section>
          )}

          <section className="panel inst-dashboard-panel">
            <div className="inst-card-head">
              <h2 className="inst-card-title">Certificate index (raw statuses)</h2>
            </div>
            <ul className="kv-list">
              {Object.entries(summary.certificates_by_status).map(([k, v]) => (
                <li key={k}>
                  <code>{k}</code>: {v}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {dashTab === "activity" && (
        <section className="panel inst-dashboard-panel" id="inst-dash-recent-activity">
          <div className="inst-card-head">
            <h2 className="inst-card-title">Recent activity</h2>
          </div>
          {recent.length === 0 && <p className="muted-inline">No indexed events yet — mint or sync activity.</p>}
          {recent.length > 0 && (
            <div className="table-wrap">
              <table className="admin-analytics-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Token</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPg.pageItems.map((ev, i) => (
                    <tr key={`${ev.tx_hash}-${ev.block_number}-${i}`}>
                      <td className="mono small">{ev.block_timestamp || ev.created_at || "—"}</td>
                      <td>
                        <span className={`status ${ev.action}`}>{ev.action}</span>
                      </td>
                      <td>{ev.token_id ?? "—"}</td>
                      <td className="mono small">
                        {ev.tx_explorer_url ? (
                          <a href={ev.tx_explorer_url} target="_blank" rel="noreferrer">
                            view
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TablePagination
                page={recentPg.page}
                pageSize={recentPg.pageSize}
                totalPages={recentPg.totalPages}
                total={recentPg.total}
                from={recentPg.from}
                to={recentPg.to}
                onPageChange={recentPg.setPage}
                onPageSizeChange={recentPg.setPageSize}
              />
            </div>
          )}
        </section>
      )}

      {dashTab === "batches" && (
        <>
          <section className="panel inst-dashboard-panel" id="inst-dash-csv-batches">
            <div className="inst-card-head inst-dashboard-toolbar">
              <h2 className="inst-card-title">CSV batch jobs</h2>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="tab ghost"
                  onClick={() => void loadBatches(Math.max(0, batchOffset - 30))}
                  disabled={batchOffset === 0}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="tab ghost"
                  onClick={() => void loadBatches(batchOffset + 30)}
                  disabled={batchOffset + 30 >= batchTotal}
                >
                  Next
                </button>
              </div>
            </div>
            <p className="muted-inline small">
              Batches: {summary?.mint_batches.total ?? "—"} total · Status mix:{" "}
              {summary
                ? Object.entries(summary.mint_batches.by_status)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")
                : "—"}
            </p>
            {batches.length === 0 && <p className="muted-inline">No batches uploaded.</p>}
            {batches.length > 0 && (
              <div className="table-wrap">
                <table className="admin-analytics-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>File</th>
                      <th>Status</th>
                      <th>Rows</th>
                      <th>Invalid</th>
                      <th>Minted</th>
                      <th>Failed</th>
                      <th>Signed</th>
                      <th>Last tx</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {batchesPg.pageItems.map((b) => (
                      <tr key={b.id}>
                        <td>{b.id}</td>
                        <td className="small">{b.original_filename}</td>
                        <td>
                          <span className={`status ${b.status}`}>{b.status}</span>
                        </td>
                        <td>{b.total_rows}</td>
                        <td>{b.rows_invalid}</td>
                        <td>{b.rows_minted_terminal}</td>
                        <td>{b.rows_mint_failed}</td>
                        <td>{b.batch_authorized ? "yes" : "no"}</td>
                        <td className="mono small">
                          {b.last_tx_hash ? (
                            <a
                              href={`${summary?.explorer_tx_base ?? "https://amoy.polygonscan.com/tx/"}${b.last_tx_hash}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              link
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <button type="button" className="btn-text" onClick={() => void openBatch(b.id)}>
                            Rows
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <TablePagination
                  page={batchesPg.page}
                  pageSize={batchesPg.pageSize}
                  totalPages={batchesPg.totalPages}
                  total={batchesPg.total}
                  from={batchesPg.from}
                  to={batchesPg.to}
                  onPageChange={batchesPg.setPage}
                  onPageSizeChange={batchesPg.setPageSize}
                />
              </div>
            )}
          </section>

          {detailId !== null && (
            <section className="panel admin-analytics-detail inst-dashboard-panel">
              <div className="inst-card-head">
                <h2 className="inst-card-title">Batch #{detailId}</h2>
                <button
                  type="button"
                  className="inst-card-action"
                  onClick={() => {
                    setDetailId(null);
                    setDetail(null);
                    setDetailErr(null);
                  }}
                >
                  Close
                </button>
              </div>
              {detailErr && <div className="error">{detailErr}</div>}
              {detail && (
                <>
                  <p className="muted-inline small">
                    CSV valid (snapshot): {detail.snapshot_valid_rows} · Invalid rows: {detail.rows_invalid} · Minted:{" "}
                    {detail.rows_minted_terminal} · Mint failed: {detail.rows_mint_failed}
                  </p>
                  <div className="table-wrap">
                    <table className="admin-analytics-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Cert ID</th>
                          <th>Status</th>
                          <th>Token</th>
                          <th>Tx</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailRowsPg.pageItems.map((r) => (
                          <tr key={r.id}>
                            <td>{r.row_index}</td>
                            <td className="mono small">{r.cert_id || "—"}</td>
                            <td>
                              <span className={`status ${r.row_status}`}>{r.row_status}</span>
                            </td>
                            <td>{r.token_id ?? "—"}</td>
                            <td className="mono small">
                              {r.tx_explorer_url ? (
                                <a href={r.tx_explorer_url} target="_blank" rel="noreferrer">
                                  link
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="small">{r.error_message || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <TablePagination
                      page={detailRowsPg.page}
                      pageSize={detailRowsPg.pageSize}
                      totalPages={detailRowsPg.totalPages}
                      total={detailRowsPg.total}
                      from={detailRowsPg.from}
                      to={detailRowsPg.to}
                      onPageChange={detailRowsPg.setPage}
                      onPageSizeChange={detailRowsPg.setPageSize}
                    />
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
      </div>

      <nav className="inst-dashboard-bottom-nav" aria-label="Dashboard views">
        <button
          type="button"
          className={
            dashTab === "metrics" ? "inst-dashboard-bottom-nav__item active" : "inst-dashboard-bottom-nav__item"
          }
          onClick={() => {
            setDashTab("metrics");
            setDetailId(null);
            setDetail(null);
            setDetailErr(null);
          }}
        >
          <span className="inst-dashboard-bottom-nav__icon" aria-hidden>
            📊
          </span>
          <span className="inst-dashboard-bottom-nav__label">Metrics</span>
        </button>
        <button
          type="button"
          className={
            dashTab === "activity" ? "inst-dashboard-bottom-nav__item active" : "inst-dashboard-bottom-nav__item"
          }
          onClick={() => {
            setDashTab("activity");
            setDetailId(null);
            setDetail(null);
            setDetailErr(null);
          }}
        >
          <span className="inst-dashboard-bottom-nav__icon" aria-hidden>
            📋
          </span>
          <span className="inst-dashboard-bottom-nav__label">Recent activity</span>
        </button>
        <button
          type="button"
          className={
            dashTab === "batches" ? "inst-dashboard-bottom-nav__item active" : "inst-dashboard-bottom-nav__item"
          }
          onClick={() => setDashTab("batches")}
        >
          <span className="inst-dashboard-bottom-nav__icon" aria-hidden>
            📑
          </span>
          <span className="inst-dashboard-bottom-nav__label">CSV batch jobs</span>
        </button>
      </nav>
    </>
  );
}
