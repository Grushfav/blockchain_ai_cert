import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BrandedLoader } from "../components/BrandedLoader";
import { BusyLabel } from "../components/LoadingSpinner";
import { apiJson } from "../api/client";
import { TablePagination } from "../components/TablePagination";
import { usePagination } from "../hooks/usePagination";

type UniversityRow = {
  id: number;
  name: string;
  internal_id: string;
  domain_email: string;
  wallet_address: string;
  status: string;
  kyc_notes: string | null;
  created_at: string | null;
};

type ListResponse = { universities: UniversityRow[] };

const FILTERS = ["all", "pending", "verified", "rejected"] as const;

export function AdminPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("pending");
  const [rows, setRows] = useState<UniversityRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);
  const [riskUniId, setRiskUniId] = useState<number | null>(null);
  const [riskBusy, setRiskBusy] = useState(false);
  const [riskErr, setRiskErr] = useState<string | null>(null);
  const [riskHints, setRiskHints] = useState<{
    computed_at: string;
    disclaimer: string;
    summary: { flag_count: number; highest_severity: "low" | "medium" | "high" | null };
    flags: { code: string; severity: "low" | "medium" | "high"; detail: string }[];
    ai_summary_text?: string | null;
    ai_summary_reason?: string | null;
  } | null>(null);

  const uniPg = usePagination(rows, 10, filter);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const q = filter === "all" ? "" : `?status=${encodeURIComponent(filter)}`;
      const data = await apiJson<ListResponse>(`/api/admin/universities${q}`);
      setRows(data.universities);
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(id: number) {
    setActionId(id);
    setErr(null);
    try {
      await apiJson(`/api/admin/universities/${id}/approve`, { method: "POST" });
      await load();
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Approve failed");
    } finally {
      setActionId(null);
    }
  }

  async function rewhitelist(id: number) {
    setActionId(id);
    setErr(null);
    try {
      await apiJson(`/api/admin/universities/${id}/approve`, { method: "POST" });
      await load();
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Whitelist failed");
    } finally {
      setActionId(null);
    }
  }

  async function reject(id: number) {
    setActionId(id);
    setErr(null);
    try {
      await apiJson(`/api/admin/universities/${id}/reject`, { method: "POST" });
      await load();
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Reject failed");
    } finally {
      setActionId(null);
    }
  }

  async function loadRiskHints(id: number) {
    setRiskErr(null);
    setRiskBusy(true);
    setRiskUniId(id);
    setRiskHints(null);
    try {
      const data = await apiJson<{
        computed_at: string;
        disclaimer: string;
        summary: { flag_count: number; highest_severity: "low" | "medium" | "high" | null };
        flags: { code: string; severity: "low" | "medium" | "high"; detail: string }[];
        ai_summary_text?: string | null;
        ai_summary_reason?: string | null;
      }>(`/api/admin/universities/${id}/risk-hints`);
      setRiskHints(data);
    } catch (caught: unknown) {
      setRiskErr(caught instanceof Error ? caught.message : "Failed to load risk hints");
    } finally {
      setRiskBusy(false);
    }
  }

  return (
    <>
      <header>
        <h1>Admin — universities</h1>
        <p>Review registrations and approve to whitelist issuer wallets on-chain.</p>
        <p className="muted-inline">
          <Link to="/admin/analytics">Phase 1 analytics dashboard →</Link>
        </p>
      </header>

      <section className="panel">
        {!loading && filter === "pending" && rows.length > 0 && (
          <div className="admin-inbox-callout" role="status">
            <strong>{rows.length}</strong>{" "}
            {rows.length === 1 ? "registration awaits" : "registrations await"} your review — use the actions in the
            table below.
          </div>
        )}
        <div className="tabs">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === filter ? "tab active" : "tab"}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
          <button type="button" className="tab ghost" onClick={() => void load()} disabled={loading} aria-busy={loading}>
            <BusyLabel busy={loading} idle="Refresh" busyLabel="Refreshing…" />
          </button>
        </div>

        {err && <div className="error">{err}</div>}
        {loading && (
          <div className="admin-loading-block" role="status" aria-live="polite" aria-busy="true">
            <BrandedLoader size="lg" />
            <span className="muted-inline">Loading universities…</span>
          </div>
        )}

        {!loading && rows.length === 0 && <p className="muted-inline">No universities in this filter.</p>}

        {!loading && rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Internal ID</th>
                  <th>Domain</th>
                  <th>Wallet</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {uniPg.pageItems.map((u) => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>{u.name}</td>
                    <td>{u.internal_id}</td>
                    <td>{u.domain_email}</td>
                    <td className="mono small">{u.wallet_address}</td>
                    <td>
                      <span className={`status ${u.status}`}>{u.status}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void loadRiskHints(u.id)}
                        disabled={riskBusy && riskUniId === u.id}
                        aria-busy={riskBusy && riskUniId === u.id}
                        title="Load operational risk hints (no enforcement)"
                      >
                        <BusyLabel
                          busy={riskBusy && riskUniId === u.id}
                          idle="View"
                          busyLabel="Loading…"
                          spinnerSize="sm"
                        />
                      </button>
                    </td>
                    <td className="actions">
                      {u.status === "pending" && (
                        <>
                          <button
                            type="button"
                            disabled={actionId !== null}
                            onClick={() => void approve(u.id)}
                            aria-busy={actionId === u.id}
                          >
                            <BusyLabel busy={actionId === u.id} idle="Approve" busyLabel="Working…" />
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={actionId !== null}
                            onClick={() => void reject(u.id)}
                            aria-busy={actionId === u.id}
                          >
                            <BusyLabel busy={actionId === u.id} idle="Reject" busyLabel="Working…" />
                          </button>
                        </>
                      )}
                      {u.status !== "pending" && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={actionId !== null}
                          onClick={() => void rewhitelist(u.id)}
                          title="Re-apply on-chain whitelist for the current contract"
                          aria-busy={actionId === u.id}
                        >
                          <BusyLabel busy={actionId === u.id} idle="Re-whitelist" busyLabel="Working…" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TablePagination
              page={uniPg.page}
              pageSize={uniPg.pageSize}
              totalPages={uniPg.totalPages}
              total={uniPg.total}
              from={uniPg.from}
              to={uniPg.to}
              onPageChange={uniPg.setPage}
              onPageSizeChange={uniPg.setPageSize}
            />
            {riskErr && <div className="error" style={{ marginTop: "0.75rem" }}>{riskErr}</div>}
            {riskHints && (
              <div className="panel" style={{ marginTop: "0.75rem" }}>
                <h3 style={{ marginTop: 0 }}>Risk hints for university #{riskUniId}</h3>
                <p className="muted-inline small">{riskHints.disclaimer}</p>
                <p className="muted-inline small" style={{ marginTop: 0 }}>
                  Flags: <strong>{riskHints.summary.flag_count}</strong>{" "}
                  {riskHints.summary.highest_severity ? (
                    <>
                      · Highest: <strong>{riskHints.summary.highest_severity}</strong>
                    </>
                  ) : (
                    <>· Highest: —</>
                  )}
                </p>

                {riskHints.flags.length === 0 ? (
                  <p className="muted-inline">No flags triggered for the current window.</p>
                ) : (
                  <ul className="stack" style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
                    {riskHints.flags.map((f) => (
                      <li key={f.code} className="panel" style={{ margin: 0 }}>
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                          <strong className="mono small">{f.code}</strong>
                          <span className={`badge ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}`}>
                            {f.severity}
                          </span>
                        </div>
                        <p style={{ margin: "0.4rem 0 0", whiteSpace: "pre-wrap" }}>{f.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {riskHints.ai_summary_text ? (
                  <div className="panel" style={{ marginTop: "0.75rem" }}>
                    <h4 style={{ marginTop: 0 }}>AI summary (optional)</h4>
                    <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{riskHints.ai_summary_text}</p>
                  </div>
                ) : riskHints.ai_summary_reason ? (
                  <p className="muted-inline small" style={{ marginBottom: 0 }}>
                    AI summary unavailable: {riskHints.ai_summary_reason}
                  </p>
                ) : null}
              </div>
            )}
            <p className="muted-inline small">
              KYC notes are stored in the database; expand your table UI if you need to show them in
              demos.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
