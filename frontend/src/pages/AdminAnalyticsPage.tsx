import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiDownload, apiJson, API_BASE } from "../api/client";
import { TablePagination } from "../components/TablePagination";
import { usePagination } from "../hooks/usePagination";

type Summary = {
  generated_at_utc: string;
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

export function AdminAnalyticsPage() {
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

  const activityEventsPg = usePagination(activity?.events ?? [], 10, actOffset);
  const batchesPg = usePagination(batches, 10, batchOffset);
  const detailRowsPg = usePagination(detail?.rows ?? [], 10, detailId ?? "none");

  const loadSummary = useCallback(async () => {
    setSumErr(null);
    try {
      const s = await apiJson<Summary>("/api/admin/analytics/summary");
      setSummary(s);
    } catch (e: unknown) {
      setSumErr(e instanceof Error ? e.message : "Failed to load summary");
      setSummary(null);
    }
  }, []);

  const loadBatches = useCallback(async (offset: number) => {
    const data = await apiJson<BatchListResponse>(
      `/api/admin/analytics/batches?limit=30&offset=${offset}`
    );
    setBatches(data.batches);
    setBatchTotal(data.total);
    setBatchOffset(data.offset);
  }, []);

  const loadActivity = useCallback(async (offset: number) => {
    const data = await apiJson<ActivityResponse>(
      `/api/admin/analytics/activity-log?limit=50&offset=${offset}`
    );
    setActivity(data);
    setActOffset(data.offset);
  }, []);

  useEffect(() => {
    void loadSummary();
    void loadBatches(0).catch(() => setBatches([]));
    void loadActivity(0).catch(() => setActivity(null));
  }, [loadSummary, loadBatches, loadActivity]);

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
      const { blob, filename } = await apiDownload("/api/admin/analytics/activity-log.csv?limit=10000");
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
          <p className="muted-inline">
            DB-backed aggregates and audit export. On-chain truth may differ until universities run activity sync.
          </p>
        </div>
        <Link to="/admin" className="btn-secondary">
          ← Universities
        </Link>
      </header>

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

      <section className="panel">
        <div className="admin-analytics-toolbar">
          <h2>Audit log</h2>
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
            <span className="muted-inline small">
              {activity ? `${activity.offset + 1}–${Math.min(activity.offset + activity.limit, activity.total)} of ${activity.total}` : ""}
            </span>
          </div>
        </div>
        <p className="muted-inline small">
          API: <code className="mono">{API_BASE}/api/admin/analytics/activity-log</code> (JSON) and{" "}
          <code className="mono">activity-log.csv</code>.
        </p>
        {activity && activity.events.length === 0 && <p className="muted-inline">No events yet.</p>}
        {activity && activity.events.length > 0 && (
          <div className="table-wrap">
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
      </section>

      <section className="panel">
        <div className="admin-analytics-toolbar">
          <h2>Batch outcomes</h2>
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
        {batches.length === 0 && <p className="muted-inline">No batches.</p>}
        {batches.length > 0 && (
          <div className="table-wrap">
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
