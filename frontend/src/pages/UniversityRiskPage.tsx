import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../AuthContext";
import { apiJson } from "../api/client";
import { BusyLabel } from "../components/LoadingSpinner";
import { InstitutionBottomNav } from "../components/InstitutionBottomNav";

type RiskHintsPayload = {
  computed_at: string;
  disclaimer: string;
  summary: { flag_count: number; highest_severity: "low" | "medium" | "high" | null };
  flags: { code: string; severity: "low" | "medium" | "high"; detail: string }[];
  ai_summary_text?: string | null;
  ai_summary_reason?: string | null;
};

function severityPill(sev: "low" | "medium" | "high"): { label: string; className: string } {
  if (sev === "high") return { label: "BAD", className: "risk-flag-pill risk-flag-pill--bad" };
  if (sev === "medium") return { label: "WARN", className: "risk-flag-pill risk-flag-pill--warn" };
  return { label: "INFO", className: "risk-flag-pill risk-flag-pill--info" };
}

function formatHighest(sev: string | null | undefined): string {
  if (!sev) return "—";
  return sev.charAt(0).toUpperCase() + sev.slice(1);
}

/** Light emphasis for common advisory phrases in AI text (no markup from API). */
function AiSummaryBody({ text }: { text: string }) {
  const chunks = text.split(/(\b(?:Recommended|Consider|Review|Check|Verify)\b[^\n.]*[.\n]?)/gi);
  return (
    <p className="risk-ai-card__text">
      {chunks.map((part, i) =>
        /^(Recommended|Consider|Review|Check|Verify)/i.test(part.trim()) ? (
          <mark key={i} className="risk-ai-card__hl">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

export function UniversityRiskPage() {
  const { token, role } = useAuth();
  const navigate = useNavigate();
  const [payload, setPayload] = useState<RiskHintsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const data = await apiJson<RiskHintsPayload>("/api/university/risk-hints");
      setPayload(data);
    } catch (caught: unknown) {
      setPayload(null);
      setErr(caught instanceof Error ? caught.message : "Failed to load risk hints");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!token || role !== "university") {
      navigate("/login", { replace: true, state: { from: { pathname: "/university/risk" } } });
      return;
    }
    void load();
  }, [token, role, navigate, load]);

  if (!token || role !== "university") {
    return null;
  }

  const n = payload?.summary.flag_count ?? 0;
  const hi = payload?.summary.highest_severity;

  return (
    <div className="inst-portal risk-page">
      <header className="risk-page__hero">
        <p className="risk-page__eyebrow">Institution · Security</p>
        <h1 className="risk-page__title">Audit &amp; risk monitoring</h1>
        <p className="risk-page__lead">Real-time security telemetry and cryptographic integrity reports.</p>
      </header>

      <section className="risk-page__section panel" aria-labelledby="risk-hints-heading">
        <div className="risk-page__section-head">
          <div>
            <h2 id="risk-hints-heading" className="risk-page__section-title">
              Risk hints (phase D)
            </h2>
            <p className="risk-page__section-sub muted-inline small">Operational signals only — not proof of credential validity.</p>
          </div>
          <div className="risk-page__actions">
            <button type="button" className="btn-secondary" onClick={() => void load()} disabled={busy} aria-busy={busy}>
              <BusyLabel busy={busy} idle="Refresh hints" busyLabel="Refreshing…" />
            </button>
            <button type="button" className="risk-page__btn-show" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {err && <div className="error">{err}</div>}
        {busy && !payload && !err && <p className="muted-inline">Loading risk hints…</p>}

        {payload && (
          <>
            <button
              type="button"
              className="risk-page__summary-bar"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
            >
              <span className="risk-page__summary-bar-icon" aria-hidden>
                ⚠
              </span>
              <span className="risk-page__summary-bar-text">
                {n === 0 ? "No flags triggered" : `${n} flag${n === 1 ? "" : "s"} triggered`}
                <span className="risk-page__summary-bar-sep">|</span>
                Highest severity: <strong>{formatHighest(hi)}</strong>
              </span>
              <span className={`risk-page__chevron${expanded ? " risk-page__chevron--open" : ""}`} aria-hidden />
            </button>

            {expanded && (
              <div className="risk-page__detail stack">
                <div className="risk-page__info-banner" role="note">
                  <span className="risk-page__info-icon" aria-hidden>
                    i
                  </span>
                  <p>
                    Operational only; validity = on-chain + signed metadata. These hints assist in fraud detection but do not
                    override cryptographic status.
                  </p>
                </div>

                {payload.flags.length === 0 ? (
                  <p className="muted-inline">No flags triggered for the current window.</p>
                ) : (
                  <ul className="risk-page__flag-list">
                    {payload.flags.map((f) => {
                      const pill = severityPill(f.severity);
                      return (
                        <li key={f.code} className="risk-page__flag-card">
                          <div className="risk-page__flag-card-top">
                            <span className="risk-page__flag-code">{f.code}</span>
                            <span className={pill.className}>{pill.label}</span>
                          </div>
                          <p className="risk-page__flag-detail">{f.detail}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {payload.ai_summary_text ? (
                  <div className="risk-ai-card">
                    <div className="risk-ai-card__head">
                      <span className="risk-ai-card__sparkle" aria-hidden>
                        ✦
                      </span>
                      <h3 className="risk-ai-card__title">AI summary (optional)</h3>
                    </div>
                    <AiSummaryBody text={payload.ai_summary_text} />
                  </div>
                ) : payload.ai_summary_reason ? (
                  <p className="muted-inline small risk-ai-card__unavailable">AI summary unavailable: {payload.ai_summary_reason}</p>
                ) : null}

                {payload.computed_at && (
                  <p className="muted-inline small" style={{ margin: 0 }}>
                    Computed at {new Date(payload.computed_at).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <p className="risk-page__footer-links muted-inline small">
          <Link to="/university?mode=audit">← Back to portal (audit &amp; lifecycle)</Link>
          {" · "}
          <Link to="/university/analytics">Institution dashboard</Link>
        </p>
      </section>

      <InstitutionBottomNav
        active="audit"
        hrefFor={(k) => (k === "audit" ? "/university/risk" : `/university?mode=${k}`)}
      />
    </div>
  );
}
