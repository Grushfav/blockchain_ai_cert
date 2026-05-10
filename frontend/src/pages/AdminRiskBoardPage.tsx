import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api/client";

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

const SEV_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function AdminRiskBoardPage() {
  const [rows, setRows] = useState<InstitutionRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const o = await apiJson<{ institutions: InstitutionRow[] }>(
        "/api/admin/analytics/institutions-overview?include_risk=true"
      );
      setRows(o.institutions || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const fa = a.risk?.flag_count ?? 0;
      const fb = b.risk?.flag_count ?? 0;
      if (fb !== fa) return fb - fa;
      const sa = SEV_ORDER[a.risk?.highest_severity || ""] ?? 0;
      const sb = SEV_ORDER[b.risk?.highest_severity || ""] ?? 0;
      if (sb !== sa) return sb - sa;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [rows]);

  const withFlags = sorted.filter((r) => (r.risk?.flag_count ?? 0) > 0);

  return (
    <div className="admin-risk-board shell-content">
      <header className="admin-analytics-header">
        <div>
          <h1>Admin — institution risk board</h1>
          <p className="muted-inline">
            Operational hints only (velocity, failures, revokes, batch health). Not proof of fraud or invalid
            credentials. Use <strong>Load risk hints</strong> on the Universities admin screen for full flag text and
            optional AI narrative (Gemini).
          </p>
        </div>
        <div className="toolbar-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button type="button" className="tab ghost" onClick={() => void load()} disabled={busy}>
            {busy ? "…" : "Refresh"}
          </button>
          <Link to="/admin/overview" className="btn-secondary">
            Overview
          </Link>
          <Link to="/admin" className="btn-secondary">
            Universities
          </Link>
        </div>
      </header>

      {err && <div className="error">{err}</div>}

      <section className="panel">
        <p className="muted-inline small" style={{ marginTop: 0 }}>
          <strong>{withFlags.length}</strong> institution{withFlags.length === 1 ? "" : "s"} with at least one active
          flag · <strong>{sorted.length - withFlags.length}</strong> with zero flags in the current windows (7d vs 90d
          reference).
        </p>
        <div className="table-wrap">
          <table className="admin-analytics-table">
            <thead>
              <tr>
                <th>Institution</th>
                <th>Status</th>
                <th>Flags</th>
                <th>Worst</th>
                <th>Codes</th>
                <th>Activity (log)</th>
                <th>Batches</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted-inline small mono">#{r.id} · {r.internal_id}</div>
                  </td>
                  <td>
                    <span className={`status ${r.status}`}>{r.status}</span>
                  </td>
                  <td>{r.risk?.error ? "—" : r.risk?.flag_count ?? 0}</td>
                  <td>
                    {r.risk?.highest_severity ? (
                      <span className={`status ${r.risk.highest_severity}`}>{r.risk.highest_severity}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="small mono">
                    {r.risk?.flag_codes?.length ? r.risk.flag_codes.join(", ") : "—"}
                  </td>
                  <td>{r.activity_events}</td>
                  <td>{r.mint_batches}</td>
                  <td>
                    <Link to="/admin" className="btn-text">
                      Open admin
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
