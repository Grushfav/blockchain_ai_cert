import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiDownload, apiJson, API_BASE } from "../api/client";
import { MintTimeseriesLineChart } from "../components/MintAnalyticsCharts";
import { TablePagination } from "../components/TablePagination";
import { usePagination } from "../hooks/usePagination";

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

type Summary = {
  generated_at_utc: string;
  university_id?: number | null;
  university_name?: string | null;
  scope?: string;
  explorer_tx_base: string;
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

type ActivityResponse = {
  total: number;
  limit: number;
  offset: number;
  events: Array<{
    id: number;
    created_at: string | null;
    block_timestamp: string | null;
    university_id: number | null;
    university_name: string | null;
    token_id: number | null;
    action: string;
    tx_hash: string;
    tx_explorer_url: string | null;
    log_index: number;
    block_number: number;
    actor: string | null;
    details: unknown;
  }>;
};

type BatchListItem = {
  id: number;
  university_id: number;
  university_name: string | null;
  status: string;
  original_filename: string;
  created_at: string | null;
  updated_at: string | null;
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

type UniListRow = { id: number; name: string; internal_id: string; status: string };

type MintTimeseriesResponse = {
  timezone: string;
  days: number;
  series: { date: string; count: number }[];
  total_mints: number;
  university_id?: number | null;
};

type MintByInstitutionResponse = {
  timezone: string;
  days: number;
  rows: { university_id: number; name: string; internal_id: string; count: number }[];
};

export function AdminAnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialUni = useMemo(() => {
    const raw = searchParams.get("university_id");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }, [searchParams]);

  const [filterUniversityId, setFilterUniversityId] = useState<number | null>(initialUni);
  const [universities, setUniversities] = useState<UniListRow[]>([]);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchOffset, setBatchOffset] = useState(0);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [actOffset, setActOffset] = useState(0);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [adminMintDays, setAdminMintDays] = useState<30 | 90>(30);
  const [adminMintSeries, setAdminMintSeries] = useState<{ date: string; count: number }[]>([]);
  const [adminMintTotal, setAdminMintTotal] = useState<number | null>(null);
  const [adminMintLoading, setAdminMintLoading] = useState(false);
  const [adminMintErr, setAdminMintErr] = useState<string | null>(null);
  const [byInstRows, setByInstRows] = useState<MintByInstitutionResponse["rows"]>([]);
  const [byInstDays, setByInstDays] = useState(30);
  const [byInstLoading, setByInstLoading] = useState(false);
  const [byInstErr, setByInstErr] = useState<string | null>(null);
  const [byInstSort, setByInstSort] = useState<"count" | "name" | "id">("count");
  const [byInstAsc, setByInstAsc] = useState(false);
  const [logsTab, setLogsTab] = useState<"audit" | "batches">("audit");

  const activityEventsPg = usePagination(activity?.events ?? [], 10, actOffset);
  const batchesPg = usePagination(batches, 10, batchOffset);
  const detailRowsPg = usePagination(detail?.rows ?? [], 10, detailId ?? "none");

  const sortedByInst = useMemo(() => {
    const rows = [...byInstRows];
    const dir = byInstAsc ? 1 : -1;
    rows.sort((a, b) => {
      if (byInstSort === "count") return dir * (a.count - b.count);
      if (byInstSort === "id") return dir * (a.university_id - b.university_id);
      return dir * (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    });
    return rows;
  }, [byInstRows, byInstSort, byInstAsc]);

  const uniQuery = filterUniversityId != null ? `&university_id=${filterUniversityId}` : "";

  const loadUniversities = useCallback(async () => {
    try {
      const data = await apiJson<{ universities: UniListRow[] }>("/api/admin/universities");
      setUniversities(data.universities || []);
    } catch {
      setUniversities([]);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    setSumErr(null);
    try {
      const q = filterUniversityId != null ? `?university_id=${filterUniversityId}` : "";
      const s = await apiJson<Summary>(`/api/admin/analytics/summary${q}`);
      setSummary(s);
    } catch (e: unknown) {
      setSumErr(e instanceof Error ? e.message : "Failed to load summary");
      setSummary(null);
    }
  }, [filterUniversityId]);

  const loadBatches = useCallback(
    async (offset: number) => {
      const data = await apiJson<BatchListResponse>(
        `/api/admin/analytics/batches?limit=30&offset=${offset}${uniQuery}`
      );
      setBatches(data.batches);
      setBatchTotal(data.total);
      setBatchOffset(data.offset);
    },
    [uniQuery]
  );

  const loadActivity = useCallback(
    async (offset: number) => {
      const data = await apiJson<ActivityResponse>(
        `/api/admin/analytics/activity-log?limit=50&offset=${offset}${uniQuery}`
      );
      setActivity(data);
      setActOffset(data.offset);
    },
    [uniQuery]
  );

  useEffect(() => {
    setFilterUniversityId(initialUni);
  }, [initialUni]);

  useEffect(() => {
    void loadUniversities();
  }, [loadUniversities]);

  useEffect(() => {
    void loadSummary();
    void loadBatches(0).catch(() => setBatches([]));
    void loadActivity(0).catch(() => setActivity(null));
  }, [loadSummary, loadBatches, loadActivity, filterUniversityId]);

  useEffect(() => {
    let cancelled = false;
    setAdminMintLoading(true);
    setAdminMintErr(null);
    const uq = filterUniversityId != null ? `&university_id=${filterUniversityId}` : "";
    void (async () => {
      try {
        const m = await apiJson<MintTimeseriesResponse>(
          `/api/admin/analytics/mints-timeseries?days=${adminMintDays}${uq}`
        );
        if (!cancelled) {
          setAdminMintSeries(m.series || []);
          setAdminMintTotal(typeof m.total_mints === "number" ? m.total_mints : null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setAdminMintSeries([]);
          setAdminMintTotal(null);
          setAdminMintErr(e instanceof Error ? e.message : "Failed to load mint timeseries");
        }
      } finally {
        if (!cancelled) setAdminMintLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminMintDays, filterUniversityId]);

  useEffect(() => {
    if (filterUniversityId != null) {
      setByInstRows([]);
      setByInstErr(null);
      setByInstLoading(false);
      return;
    }
    let cancelled = false;
    setByInstLoading(true);
    setByInstErr(null);
    void (async () => {
      try {
        const r = await apiJson<MintByInstitutionResponse>(
          `/api/admin/analytics/mints-by-institution?days=${byInstDays}`
        );
        if (!cancelled) setByInstRows(r.rows || []);
      } catch (e: unknown) {
        if (!cancelled) {
          setByInstRows([]);
          setByInstErr(e instanceof Error ? e.message : "Failed to load per-institution mints");
        }
      } finally {
        if (!cancelled) setByInstLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filterUniversityId, byInstDays]);

  function setInstitutionFilter(id: number | null) {
    setFilterUniversityId(id);
    setBatchOffset(0);
    setActOffset(0);
    const next = new URLSearchParams(searchParams);
    if (id == null) next.delete("university_id");
    else next.set("university_id", String(id));
    setSearchParams(next, { replace: true });
  }

  async function openBatch(id: number) {
    setDetailId(id);
    setDetailErr(null);
    setDetail(null);
    try {
      const d = await apiJson<BatchDetail>(`/api/admin/analytics/batches/${id}`);
      setDetail(d);
    } catch (e: unknown) {
      setDetailErr(e instanceof Error ? e.message : "Failed to load batch");
    }
  }

  async function downloadActivityCsv() {
    setCsvBusy(true);
    try {
      const uq = filterUniversityId != null ? `&university_id=${filterUniversityId}` : "";
      const { blob, filename } = await apiDownload(`/api/admin/analytics/activity-log.csv?limit=10000${uq}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "CSV download failed");
    } finally {
      setCsvBusy(false);
    }
  }

  return (
    <div className="admin-analytics shell-content">
      <header className="admin-analytics-header">
        <div>
          <h1>Admin — analytics (Phase 1)</h1>
          <p className="muted-inline admin-analytics-header__lede">
            DB-backed aggregates and audit export. On-chain truth may differ until universities run activity sync.
          </p>
        </div>
        <div className="admin-analytics-header__nav">
          <Link to="/admin/overview" className="btn-secondary">
            Overview
          </Link>
          <Link to="/admin/risk" className="btn-secondary">
            Risk
          </Link>
          <Link to="/admin" className="btn-secondary">
            Universities
          </Link>
        </div>
      </header>

      <div className="panel admin-analytics-scope">
        <label htmlFor="admin_analytics_uni" className="admin-analytics-scope__label">
          Scope
        </label>
        <select
          id="admin_analytics_uni"
          className="admin-analytics-scope__select"
          value={filterUniversityId ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            setInstitutionFilter(v === "" ? null : Number(v));
          }}
        >
          <option value="">All institutions (platform)</option>
          {universities.map((u) => (
            <option key={u.id} value={u.id}>
              #{u.id} · {u.name} ({u.status})
            </option>
          ))}
        </select>
        {filterUniversityId != null && summary?.university_name && (
          <p className="muted-inline small admin-analytics-scope__hint">
            Metrics, audit log, and batches are filtered to <strong>{summary.university_name}</strong>.{" "}
            <button type="button" className="btn-text" onClick={() => setInstitutionFilter(null)}>
              Clear filter
            </button>
          </p>
        )}
      </div>

      {sumErr && <div className="error">{sumErr}</div>}

      {summary && (
        <>
          <section className="panel admin-analytics-grid">
            <h2>Lifecycle (certificate index)</h2>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Issued (active)</span>
                <span className="stat-value">{summary.lifecycle.issued_total}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Claimed (locked)</span>
                <span className="stat-value">{summary.lifecycle.claimed_locked}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Unclaimed mints</span>
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
                <span className="stat-label">Reissued (old tokens)</span>
                <span className="stat-value">{summary.lifecycle.reissued_tokens}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Prepared (pending mint)</span>
                <span className="stat-value">{summary.lifecycle.prepared}</span>
              </div>
            </div>
          </section>

          <section className="panel admin-analytics-grid">
            <h2>Issuance volume (mint events in activity log)</h2>
            <p className="muted-inline small">{summary.issuance_volume.note}</p>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Today (UTC-5)</span>
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

          <section className="panel admin-analytics-grid" aria-labelledby="admin-mint-ts-heading">
            <div className="admin-analytics__section-head">
              <h2 id="admin-mint-ts-heading" className="admin-analytics__section-title">
                Mints per day (UTC-5)
                {filterUniversityId != null ? (
                  <span className="muted-inline small admin-analytics__section-sub">
                    Scoped to selected institution
                  </span>
                ) : (
                  <span className="muted-inline small admin-analytics__section-sub">
                    Platform-wide indexed mints
                  </span>
                )}
              </h2>
              <div className="admin-ops-digest__tabs" role="tablist" aria-label="Admin mint chart window">
                <button
                  type="button"
                  role="tab"
                  aria-selected={adminMintDays === 30}
                  className={`tab ghost${adminMintDays === 30 ? " active" : ""}`}
                  onClick={() => setAdminMintDays(30)}
                >
                  Last 30 days
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={adminMintDays === 90}
                  className={`tab ghost${adminMintDays === 90 ? " active" : ""}`}
                  onClick={() => setAdminMintDays(90)}
                >
                  Last 90 days
                </button>
              </div>
            </div>
            <p className="muted-inline small admin-analytics__section-lede">
              Activity log <code>issued</code> rows; daily bucket in UTC-5 (axes labeled UTC-5).
            </p>
            {adminMintErr && <div className="error">{adminMintErr}</div>}
            {adminMintLoading && !adminMintErr && <p className="muted-inline">Loading chart…</p>}
            {!adminMintLoading && !adminMintErr && adminMintSeries.length > 0 && (
              <>
                <p className="muted-inline small admin-analytics-chart-caption">
                  Total in window:{" "}
                  <strong>{adminMintTotal ?? adminMintSeries.reduce((a, p) => a + p.count, 0)}</strong> mints
                </p>
                <MintTimeseriesLineChart series={adminMintSeries} height={adminMintDays === 90 ? 280 : 260} />
              </>
            )}
            {!adminMintLoading && !adminMintErr && adminMintSeries.length === 0 && (
              <p className="muted-inline">No indexed mints in this UTC-5 window.</p>
            )}
          </section>

          {filterUniversityId == null && (
            <section className="panel admin-analytics-grid" aria-labelledby="admin-mint-by-inst-heading">
              <div className="admin-analytics__section-head">
                <h2 id="admin-mint-by-inst-heading" className="admin-analytics__section-title">
                  Mints by institution
                </h2>
                <div className="admin-ops-digest__tabs" role="tablist" aria-label="Table window">
                  <button
                    type="button"
                    className={`tab ghost${byInstDays === 30 ? " active" : ""}`}
                    onClick={() => setByInstDays(30)}
                  >
                    30d
                  </button>
                  <button
                    type="button"
                    className={`tab ghost${byInstDays === 90 ? " active" : ""}`}
                    onClick={() => setByInstDays(90)}
                  >
                    90d
                  </button>
                </div>
              </div>
              <p className="muted-inline small admin-analytics__section-lede">
                Sortable table of indexed mint counts per institution (UTC-5 window). Use charts above for trends.
              </p>
              {byInstErr && <div className="error">{byInstErr}</div>}
              {byInstLoading && !byInstErr && <p className="muted-inline">Loading…</p>}
              {!byInstLoading && !byInstErr && sortedByInst.length === 0 && (
                <p className="muted-inline">No mints in this window.</p>
              )}
              {!byInstLoading && !byInstErr && sortedByInst.length > 0 && (
                <table className="admin-mint-by-inst-table">
                  <thead>
                    <tr>
                      <th>
                        <button
                          type="button"
                          className="sort"
                          onClick={() => {
                            if (byInstSort === "id") setByInstAsc(!byInstAsc);
                            else {
                              setByInstSort("id");
                              setByInstAsc(false);
                            }
                          }}
                        >
                          ID
                        </button>
                      </th>
                      <th>
                        <button
                          type="button"
                          className="sort"
                          onClick={() => {
                            if (byInstSort === "name") setByInstAsc(!byInstAsc);
                            else {
                              setByInstSort("name");
                              setByInstAsc(false);
                            }
                          }}
                        >
                          Institution
                        </button>
                      </th>
                      <th>Internal ID</th>
                      <th style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="sort"
                          onClick={() => {
                            if (byInstSort === "count") setByInstAsc(!byInstAsc);
                            else {
                              setByInstSort("count");
                              setByInstAsc(false);
                            }
                          }}
                        >
                          Mints ({byInstDays}d UTC-5)
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedByInst.map((r) => (
                      <tr key={r.university_id}>
                        <td>{r.university_id}</td>
                        <td>{r.name || "—"}</td>
                        <td>
                          <code>{r.internal_id || "—"}</code>
                        </td>
                        <td style={{ textAlign: "right" }}>{r.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <section className="panel admin-analytics-grid">
            <h2>Reissues</h2>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Reissue events (log)</span>
                <span className="stat-value">{summary.reissues.reissue_events}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Certificates marked reissued</span>
                <span className="stat-value">{summary.reissues.certificates_marked_reissued}</span>
              </div>
            </div>
          </section>

          <section className="panel admin-analytics-grid">
            <h2>EIP-712 authorization</h2>
            <div className="stat-cards">
              <div className="stat-card">
                <span className="stat-label">Single mints completed (DB)</span>
                <span className="stat-value">{summary.eip712.single_mints_completed_via_request_table}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Batch auths recorded</span>
                <span className="stat-value">{summary.eip712.batch_authorizations_recorded}</span>
              </div>
            </div>
            <h3 className="subheading">Single-mint request statuses</h3>
            <ul className="kv-list">
              {Object.entries(summary.eip712.single_mint_authorization_requests.requests_by_status).map(
                ([k, v]) => (
                  <li key={k}>
                    <code>{k || "—"}</code>: {v}
                  </li>
                )
              )}
            </ul>
            <h3 className="subheading">Failed authorizations (by code)</h3>
            <ul className="kv-list">
              {Object.keys(summary.eip712.single_mint_authorization_requests.failed_requests_by_code).length ===
              0 ? (
                <li className="muted-inline">None recorded</li>
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

          {summary.mint_timing && (
            <section className="panel admin-analytics-grid">
              <h2>Mint timing (recorded)</h2>
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

          <section className="panel">
            <h2>Certificate status (raw index)</h2>
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

      <section className="panel admin-analytics-logs-panel" aria-label="Audit and batch data">
        <div
          className="admin-ops-digest__tabs admin-ops-digest__tabs--segmented admin-analytics-logs-panel__tabs"
          role="tablist"
          aria-label="Choose audit log or batch outcomes"
        >
          <button
            type="button"
            role="tab"
            id="admin-logs-tab-audit"
            aria-selected={logsTab === "audit"}
            aria-controls="admin-logs-panel-audit"
            className={`tab ghost${logsTab === "audit" ? " active" : ""}`}
            onClick={() => setLogsTab("audit")}
          >
            Audit log
          </button>
          <button
            type="button"
            role="tab"
            id="admin-logs-tab-batches"
            aria-selected={logsTab === "batches"}
            aria-controls="admin-logs-panel-batches"
            className={`tab ghost${logsTab === "batches" ? " active" : ""}`}
            onClick={() => setLogsTab("batches")}
          >
            Batch outcomes
          </button>
        </div>

        <div
          id="admin-logs-panel-audit"
          role="tabpanel"
          aria-labelledby="admin-logs-tab-audit"
          hidden={logsTab !== "audit"}
          className="admin-analytics-logs-panel__body"
        >
          <div className="admin-analytics-toolbar">
            <h2 className="admin-analytics-toolbar__heading">Audit log</h2>
            <div className="toolbar-actions">
              <button type="button" className="btn-secondary" disabled={csvBusy} onClick={() => void downloadActivityCsv()}>
                {csvBusy ? "…" : "Download CSV"}
              </button>
              <button
                type="button"
                className="tab ghost"
                onClick={() => void loadActivity(Math.max(0, actOffset - 50))}
                disabled={!activity || actOffset === 0}
              >
                Prev
              </button>
              <button
                type="button"
                className="tab ghost"
                onClick={() => void loadActivity(actOffset + 50)}
                disabled={!activity || actOffset + 50 >= activity.total}
              >
                Next
              </button>
              <span className="muted-inline small admin-analytics-toolbar__meta">
                {activity ? `${activity.offset + 1}–${Math.min(activity.offset + activity.limit, activity.total)} of ${activity.total}` : ""}
              </span>
            </div>
          </div>
          <p className="muted-inline small admin-analytics-api-hint">
            API: <code className="mono">{API_BASE}/api/admin/analytics/activity-log</code> (JSON) and{" "}
            <code className="mono">activity-log.csv</code>.
          </p>
          {activity && activity.events.length === 0 && <p className="muted-inline admin-analytics-empty">No events yet.</p>}
          {activity && activity.events.length > 0 && (
            <div className="table-wrap admin-analytics-table-wrap">
              <table className="admin-analytics-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>University</th>
                    <th>Action</th>
                    <th>Token</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {activityEventsPg.pageItems.map((ev) => (
                    <tr key={ev.id}>
                      <td className="mono small">{ev.block_timestamp || ev.created_at || "—"}</td>
                      <td>{ev.university_name || ev.university_id || "—"}</td>
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
                page={activityEventsPg.page}
                pageSize={activityEventsPg.pageSize}
                totalPages={activityEventsPg.totalPages}
                total={activityEventsPg.total}
                from={activityEventsPg.from}
                to={activityEventsPg.to}
                onPageChange={activityEventsPg.setPage}
                onPageSizeChange={activityEventsPg.setPageSize}
              />
            </div>
          )}
        </div>

        <div
          id="admin-logs-panel-batches"
          role="tabpanel"
          aria-labelledby="admin-logs-tab-batches"
          hidden={logsTab !== "batches"}
          className="admin-analytics-logs-panel__body"
        >
          <div className="admin-analytics-toolbar">
            <h2 className="admin-analytics-toolbar__heading">Batch outcomes</h2>
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
              <span className="muted-inline small admin-analytics-toolbar__meta">
                {batchTotal > 0 ? `${batchOffset + 1}–${Math.min(batchOffset + batches.length, batchTotal)} of ${batchTotal}` : ""}
              </span>
            </div>
          </div>
          {batches.length === 0 && <p className="muted-inline admin-analytics-empty">No batches.</p>}
          {batches.length > 0 && (
            <div className="table-wrap admin-analytics-table-wrap">
              <table className="admin-analytics-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>University</th>
                    <th>File</th>
                    <th>Status</th>
                    <th>Rows</th>
                    <th>Invalid</th>
                    <th>Minted</th>
                    <th>Failed</th>
                    <th>Auth</th>
                    <th>Last tx</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {batchesPg.pageItems.map((b) => (
                    <tr key={b.id}>
                      <td>{b.id}</td>
                      <td>{b.university_name || b.university_id}</td>
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
                          Details
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
        </div>
      </section>

      {detailId !== null && (
        <section className="panel admin-analytics-detail">
          <h2>Batch #{detailId}</h2>
          {detailErr && <div className="error">{detailErr}</div>}
          {detail && (
            <>
              <p className="muted-inline small">
                Valid (CSV): {detail.snapshot_valid_rows} · Invalid: {detail.rows_invalid} · Minted:{" "}
                {detail.rows_minted_terminal} · Mint failed: {detail.rows_mint_failed} · Row status mix:{" "}
                {Object.entries(detail.rows_by_status)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
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
    </div>
  );
}
