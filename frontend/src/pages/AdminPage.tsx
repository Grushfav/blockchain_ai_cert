import { useCallback, useEffect, useRef, useState } from "react";
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
  is_frozen?: boolean;
  frozen_at?: string | null;
};

type ListResponse = { universities: UniversityRow[] };

type AdminUniversityDetail = {
  id: number;
  name: string;
  internal_id: string;
  domain_email: string;
  wallet_address: string;
  status: string;
  kyc_notes: string | null;
  created_at: string | null;
  institution_contact_email: string | null;
  institution_contact_phone: string | null;
  institution_website: string | null;
  institution_license_id: string | null;
  institution_license_authority: string | null;
  institution_license_valid_until: string | null;
  expected_mints_monthly: number | null;
  expected_mints_annually: number | null;
  operating_days_of_week: number[];
  operating_hours_start: string | null;
  operating_hours_end: string | null;
  operating_timezone: string | null;
  institution_documents: Array<{ label: string; filename: string; uri: string; url: string }>;
  is_frozen?: boolean;
  frozen_reason?: string | null;
  frozen_at?: string | null;
};

const FILTERS = ["all", "pending", "verified", "rejected"] as const;

function truncateWallet(addr: string): string {
  const a = (addr || "").trim();
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function domainLabel(domainEmail: string): string {
  const s = (domainEmail || "").trim();
  if (!s) return "—";
  if (s.startsWith("@")) return s;
  const at = s.indexOf("@");
  if (at >= 0) return `@${s.slice(at + 1)}`;
  return s;
}

function uniInitial(name: string): string {
  const t = name.trim();
  return t ? t.charAt(0).toUpperCase() : "?";
}

function AdminReloadIcon() {
  return (
    <svg className="admin-uni__reload-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 0 1-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
      />
    </svg>
  );
}

function AdminInboxIcon() {
  return (
    <svg className="admin-uni-banner__icon-svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5L4 8V6l8 5 8-5v2z"
      />
    </svg>
  );
}

export function AdminPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("pending");
  const [rows, setRows] = useState<UniversityRow[]>([]);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const tableAnchorRef = useRef<HTMLDivElement>(null);
  const [actionId, setActionId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AdminUniversityDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailLoadId, setDetailLoadId] = useState<number | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
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
      if (filter === "pending") {
        const data = await apiJson<ListResponse>(`/api/admin/universities${q}`);
        setRows(data.universities);
        setPendingQueueCount(data.universities.length);
      } else {
        const [data, pendingOnly] = await Promise.all([
          apiJson<ListResponse>(`/api/admin/universities${q}`),
          apiJson<ListResponse>(`/api/admin/universities?status=${encodeURIComponent("pending")}`),
        ]);
        setRows(data.universities);
        setPendingQueueCount(pendingOnly.universities.length);
      }
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Failed to load");
      setRows([]);
      setPendingQueueCount(0);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelectedRowId(null);
  }, [filter]);

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

  async function freezeUniversity(id: number) {
    if (
      !window.confirm(
        "Freeze this institution? Issuers can still log in and read analytics; minting, batch flows, profile changes, and similar writes will return an error until you unfreeze."
      )
    ) {
      return;
    }
    const reasonRaw = window.prompt("Optional internal reason (stored on the institution record):");
    const reason = (reasonRaw || "").trim() || undefined;
    setActionId(id);
    setErr(null);
    try {
      await apiJson(`/api/admin/universities/${id}/freeze`, { method: "POST", json: reason ? { reason } : {} });
      await load();
      if (detail?.id === id) void openRegistrationDetail(id);
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Freeze failed");
    } finally {
      setActionId(null);
    }
  }

  async function unfreezeUniversity(id: number) {
    if (
      !window.confirm(
        "Unfreeze this institution? For verified issuers, the issuer wallet is re-whitelisted on-chain when the contract and owner key are configured. If that on-chain step fails, the institution stays frozen in the database."
      )
    ) {
      return;
    }
    setActionId(id);
    setErr(null);
    try {
      await apiJson(`/api/admin/universities/${id}/unfreeze`, { method: "POST" });
      await load();
      if (detail?.id === id) void openRegistrationDetail(id);
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Unfreeze failed");
    } finally {
      setActionId(null);
    }
  }

  async function openRegistrationDetail(id: number) {
    setDetail(null);
    setDetailErr(null);
    setDetailBusy(true);
    setDetailLoadId(id);
    try {
      const d = await apiJson<AdminUniversityDetail>(`/api/admin/universities/${id}`);
      setDetail(d);
    } catch (caught: unknown) {
      setDetailErr(caught instanceof Error ? caught.message : "Failed to load university");
    } finally {
      setDetailBusy(false);
      setDetailLoadId(null);
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

  const scrollToTable = () => {
    tableAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const showFullListLoader = loading && rows.length === 0;

  return (
    <div className="admin-uni-page shell-content">
      <header className="admin-uni-page__header">
        <div>
          <h1>Admin — universities</h1>
          <p className="admin-uni-page__lede muted-inline">
            Registration queue and compliance review. Approve to whitelist issuer wallets on-chain.
          </p>
          <p className="muted-inline admin-uni-page__navlinks">
            <Link to="/admin/overview">Operations overview</Link>
            {" · "}
            <Link to="/admin/risk">Institution risk board</Link>
            {" · "}
            <Link to="/admin/analytics">Analytics &amp; audit export</Link>
          </p>
        </div>
      </header>

      {!loading && pendingQueueCount > 0 && (
        <div className="admin-uni-banner" role="status">
          <div className="admin-uni-banner__icon" aria-hidden>
            <AdminInboxIcon />
          </div>
          <div className="admin-uni-banner__text">
            <p className="admin-uni-banner__title">
              <strong>{pendingQueueCount}</strong>{" "}
              {pendingQueueCount === 1 ? "registration waiting for review" : "registrations waiting for review"}
            </p>
            <p className="admin-uni-banner__sub muted-inline">
              Pending institutions need approval before on-chain issuer whitelisting can complete.
            </p>
          </div>
          <button type="button" className="admin-uni-banner__cta" onClick={scrollToTable}>
            Quick view
          </button>
        </div>
      )}

      <section className="panel admin-uni-panel">
        <div className="admin-uni-toolbar">
          <div className="admin-uni-filters" role="tablist" aria-label="Registration status">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={f === filter}
                className={`admin-uni-filter-pill${f === filter ? " admin-uni-filter-pill--active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary admin-uni-toolbar__reload"
            onClick={() => void load()}
            disabled={loading}
            aria-busy={loading}
          >
            <AdminReloadIcon />
            <BusyLabel busy={loading} idle="Reload" busyLabel="Reloading…" />
          </button>
        </div>

        {err && <div className="error">{err}</div>}
        {detailErr && <div className="error">{detailErr}</div>}
        {showFullListLoader && (
          <div className="admin-loading-block" role="status" aria-live="polite" aria-busy="true">
            <BrandedLoader size="lg" />
            <span className="muted-inline">Loading universities…</span>
          </div>
        )}

        {!loading && rows.length === 0 && <p className="muted-inline">No universities in this filter.</p>}

        {rows.length > 0 && (
          <div
            className={`table-wrap admin-uni-table-wrap${loading ? " admin-uni-table-wrap--busy" : ""}`}
            ref={tableAnchorRef}
            id="admin-uni-table-anchor"
            aria-busy={loading}
          >
            <table className="admin-uni-table">
              <colgroup>
                <col className="admin-uni-col admin-uni-col--id" />
                <col className="admin-uni-col admin-uni-col--uni" />
                <col className="admin-uni-col admin-uni-col--internal" />
                <col className="admin-uni-col admin-uni-col--domain" />
                <col className="admin-uni-col admin-uni-col--wallet" />
                <col className="admin-uni-col admin-uni-col--status" />
                <col className="admin-uni-col admin-uni-col--frozen" />
                <col className="admin-uni-col admin-uni-col--details" />
                <col className="admin-uni-col admin-uni-col--risk" />
                <col className="admin-uni-col admin-uni-col--actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>University</th>
                  <th>Internal</th>
                  <th>Domain</th>
                  <th>Wallet</th>
                  <th>Status</th>
                  <th>Frozen</th>
                  <th>Details</th>
                  <th>Risk</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {uniPg.pageItems.map((u) => (
                  <tr
                    key={u.id}
                    className={u.id === selectedRowId ? "admin-uni-row admin-uni-row--selected" : "admin-uni-row"}
                    onClick={() => setSelectedRowId(u.id)}
                  >
                    <td className="mono admin-uni-table__id">#{u.id}</td>
                    <td>
                      <div className="admin-uni-table__namecell">
                        <span className="admin-uni-avatar" aria-hidden>
                          {uniInitial(u.name)}
                        </span>
                        <span className="admin-uni-table__name">{u.name}</span>
                      </div>
                    </td>
                    <td className="admin-uni-table__td-internal" title={u.internal_id}>
                      <span className="admin-uni-table__clip admin-uni-table__clip--mono">
                        {String(u.internal_id).replace(/\r\n|\r|\n/g, " ").trim()}
                      </span>
                    </td>
                    <td className="admin-uni-table__td-domain" title={domainLabel(u.domain_email)}>
                      <span className="admin-uni-table__clip">{domainLabel(u.domain_email)}</span>
                    </td>
                    <td className="mono small" title={u.wallet_address}>
                      {truncateWallet(u.wallet_address)}
                    </td>
                    <td>
                      <span className={`admin-uni-status admin-uni-status--${u.status}`}>{u.status}</span>
                    </td>
                    <td>
                      {u.is_frozen ? (
                        <span className="admin-uni-frozen admin-uni-frozen--yes">Yes</span>
                      ) : (
                        <span className="admin-uni-frozen admin-uni-frozen--no">No</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary btn-secondary--compact"
                        onClick={(e) => {
                          e.stopPropagation();
                          void openRegistrationDetail(u.id);
                        }}
                        disabled={detailBusy}
                        title="Profile, issuance plan, verification documents"
                      >
                        <BusyLabel busy={detailBusy && detailLoadId === u.id} idle="Details" busyLabel="Loading…" />
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary btn-secondary--compact"
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadRiskHints(u.id);
                        }}
                        disabled={riskBusy && riskUniId === u.id}
                        aria-busy={riskBusy && riskUniId === u.id}
                        title="Load operational risk hints (no enforcement)"
                      >
                        <BusyLabel busy={riskBusy && riskUniId === u.id} idle="Risk" busyLabel="Loading…" spinnerSize="sm" />
                      </button>
                    </td>
                    <td className="actions admin-uni-table__actions" onClick={(e) => e.stopPropagation()}>
                      <div className="admin-uni-action-cell">
                        <div className="admin-uni-action-stack">
                        {u.is_frozen ? (
                          <button
                            type="button"
                            className="btn-secondary btn-secondary--compact"
                            disabled={actionId !== null}
                            onClick={() => void unfreezeUniversity(u.id)}
                            aria-busy={actionId === u.id}
                            title="Unfreeze institution"
                          >
                            <BusyLabel busy={actionId === u.id} idle="Unfreeze" busyLabel="Working…" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary btn-secondary--compact"
                            disabled={actionId !== null}
                            onClick={() => void freezeUniversity(u.id)}
                            aria-busy={actionId === u.id}
                            title="Freeze institution"
                          >
                            <BusyLabel busy={actionId === u.id} idle="Freeze" busyLabel="Working…" />
                          </button>
                        )}
                        {u.status === "pending" && (
                          <>
                            <button
                              type="button"
                              className="btn-primary btn-secondary--compact"
                              disabled={actionId !== null}
                              onClick={() => void approve(u.id)}
                              aria-busy={actionId === u.id}
                              title="Approve registration"
                            >
                              <BusyLabel busy={actionId === u.id} idle="Approve" busyLabel="Working…" />
                            </button>
                            <button
                              type="button"
                              className="btn-secondary btn-secondary--compact"
                              disabled={actionId !== null}
                              onClick={() => void reject(u.id)}
                              aria-busy={actionId === u.id}
                              title="Reject registration"
                            >
                              <BusyLabel busy={actionId === u.id} idle="Reject" busyLabel="Working…" />
                            </button>
                          </>
                        )}
                        {u.status !== "pending" && (
                          <button
                            type="button"
                            className="btn-secondary btn-secondary--compact"
                            disabled={actionId !== null}
                            onClick={() => void rewhitelist(u.id)}
                            title="Re-apply on-chain whitelist for the current contract"
                            aria-busy={actionId === u.id}
                          >
                            <BusyLabel busy={actionId === u.id} idle="Re-whitelist" busyLabel="Working…" />
                          </button>
                        )}
                        </div>
                      </div>
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
            <p className="muted-inline small">KYC notes are stored in the database; open Details to review them.</p>
          </div>
        )}
      </section>

      {detail && (
        <div
          className="admin-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-uni-detail-title"
          onClick={() => {
            setDetail(null);
            setDetailErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDetail(null);
              setDetailErr(null);
            }
          }}
        >
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal__head">
              <h2 id="admin-uni-detail-title">University #{detail.id}</h2>
              <button
                type="button"
                className="btn-text"
                onClick={() => {
                  setDetail(null);
                  setDetailErr(null);
                }}
              >
                Close
              </button>
            </div>
            <dl className="admin-modal__dl">
              <dt>Name</dt>
              <dd>{detail.name}</dd>
              <dt>Internal ID</dt>
              <dd className="mono small">{detail.internal_id}</dd>
              <dt>Domain</dt>
              <dd>{detail.domain_email}</dd>
              <dt>Wallet</dt>
              <dd className="mono small">{detail.wallet_address}</dd>
              <dt>Status</dt>
              <dd>
                <span className={`status ${detail.status}`}>{detail.status}</span>
              </dd>
              <dt>Account frozen</dt>
              <dd>
                {detail.is_frozen ? (
                  <>
                    <span className="badge warn">yes</span>
                    {detail.frozen_at ? (
                      <span className="muted-inline small" style={{ marginLeft: "0.35rem" }}>
                        since {detail.frozen_at.slice(0, 19)}
                      </span>
                    ) : null}
                    {detail.frozen_reason ? (
                      <div className="muted-inline small" style={{ marginTop: "0.25rem", whiteSpace: "pre-wrap" }}>
                        {detail.frozen_reason}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="muted-inline">no</span>
                )}
              </dd>
              <dt>Expected mints / mo</dt>
              <dd>{detail.expected_mints_monthly ?? "—"}</dd>
              <dt>Expected mints / yr</dt>
              <dd>{detail.expected_mints_annually ?? "—"}</dd>
              <dt>Operating</dt>
              <dd>
                Days {detail.operating_days_of_week?.join(", ") || "—"} ·{" "}
                {detail.operating_hours_start || "—"}–{detail.operating_hours_end || "—"} ·{" "}
                {detail.operating_timezone || "—"}
              </dd>
              <dt>KYC notes</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{detail.kyc_notes || "—"}</dd>
            </dl>
            <h3 className="subheading">Documents</h3>
            {detail.institution_documents?.length ? (
              <ul className="kv-list">
                {detail.institution_documents.map((d, i) => (
                  <li key={`${d.uri}-${i}`}>
                    <strong>{d.label}</strong> — {d.filename}{" "}
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className="home-link">
                        Open
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-inline small">No verification documents.</p>
            )}
            <div className="admin-modal__actions" style={{ marginTop: "1rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {detail.is_frozen ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={actionId !== null}
                  onClick={() => void unfreezeUniversity(detail.id)}
                  aria-busy={actionId === detail.id}
                >
                  <BusyLabel busy={actionId === detail.id} idle="Unfreeze institution" busyLabel="Working…" />
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={actionId !== null}
                  onClick={() => void freezeUniversity(detail.id)}
                  aria-busy={actionId === detail.id}
                >
                  <BusyLabel busy={actionId === detail.id} idle="Freeze institution" busyLabel="Working…" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
