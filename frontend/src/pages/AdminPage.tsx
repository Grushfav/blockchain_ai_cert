import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../api/client";

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

  return (
    <>
      <header>
        <h1>Admin — universities</h1>
        <p>Review registrations and approve to whitelist issuer wallets on-chain.</p>
      </header>

      <section className="panel">
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
          <button type="button" className="tab ghost" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>

        {err && <div className="error">{err}</div>}
        {loading && <p className="muted-inline">Loading…</p>}

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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>{u.name}</td>
                    <td>{u.internal_id}</td>
                    <td>{u.domain_email}</td>
                    <td className="mono small">{u.wallet_address}</td>
                    <td>
                      <span className={`status ${u.status}`}>{u.status}</span>
                    </td>
                    <td className="actions">
                      {u.status === "pending" && (
                        <>
                          <button
                            type="button"
                            disabled={actionId !== null}
                            onClick={() => void approve(u.id)}
                          >
                            {actionId === u.id ? "…" : "Approve"}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={actionId !== null}
                            onClick={() => void reject(u.id)}
                          >
                            {actionId === u.id ? "…" : "Reject"}
                          </button>
                        </>
                      )}
                      {u.status !== "pending" && <span className="muted-inline">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
