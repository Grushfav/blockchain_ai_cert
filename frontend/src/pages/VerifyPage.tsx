import { useEffect, useState } from "react";
import { API_BASE } from "../api/client";
import { BusyLabel, LoadingSpinner } from "../components/LoadingSpinner";
import { VerifyResultView, type FieldVerifyResponse } from "../components/VerifyResultView";

function VerifyResultSkeleton({ hint }: { hint: string }) {
  return (
    <div className="verify-skeleton" role="status" aria-live="polite" aria-busy="true">
      <div className="verify-skeleton__card">
        <div className="verify-skeleton__thumb" />
        <div className="verify-skeleton__body">
          <div className="verify-skeleton__line verify-skeleton__line--title" />
          <div className="verify-skeleton__line verify-skeleton__line--sub" />
          <div className="verify-skeleton__line verify-skeleton__line--sub short" />
        </div>
      </div>
      <div className="verify-skeleton__badges">
        <div className="verify-skeleton__pill" />
        <div className="verify-skeleton__pill" />
        <div className="verify-skeleton__pill" />
      </div>
      <p className="verify-skeleton__hint">{hint}</p>
    </div>
  );
}

type TokenVerifyApi = {
  token_id?: number;
  exists?: boolean;
  hint?: string;
  error?: string;
  chain_id?: number;
  contract_address?: string;
  on_chain?: FieldVerifyResponse["on_chain"];
  off_chain_metadata?: Record<string, unknown>;
};

type ExplainResponse = { model?: string; text?: string; error?: string };

function AiSummary({ verification }: { verification: FieldVerifyResponse }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function explainVerification() {
    setErr(null);
    setText(null);
    setModel(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/verify/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification }),
      });
      const data = (await res.json()) as ExplainResponse;
      if (!res.ok) {
        setErr(data.error || res.statusText || "AI summary failed");
        return;
      }
      setModel((data.model || "").trim() || null);
      setText((data.text || "").trim() || "No summary returned.");
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ai-summary">
      <details
        className="ai-summary__details"
        open={open}
        onToggle={(e) => {
          const next = (e.currentTarget as HTMLDetailsElement).open;
          setOpen(next);
          if (next && !text && !loading && !err) void explainVerification();
        }}
      >
        <summary className="ai-summary__summary">
          <span className="ai-summary__title">
            <span className="ai-summary__title-icon" aria-hidden>
              ✦
            </span>{" "}
            Plain-language summary
          </span>
          <span className="ai-summary__badge">AI · ADVISORY</span>
        </summary>

        <div className="ai-summary__body">
          <p className="ai-summary__disclaimer">
            <em>
              Disclaimer: This summary is AI-generated and may contain inaccuracies. On-chain data and signed metadata are the
              authoritative records.
            </em>
          </p>

          {loading && (
            <div className="ai-summary__loading" role="status" aria-live="polite" aria-busy="true">
              <LoadingSpinner size="sm" label="Generating summary" />
              <span>Generating…</span>
            </div>
          )}

          {err && (
            <div className="ai-summary__error">
              <div className="error" style={{ marginTop: 0 }}>
                {err}
              </div>
              <button type="button" className="btn-secondary" onClick={() => void explainVerification()} disabled={loading}>
                Retry
              </button>
            </div>
          )}

          {!loading && !err && text && (
            <>
              <div className="ai-summary__text-block">
                {text
                  .split(/\n\s*\n/)
                  .map((para) => para.trim())
                  .filter(Boolean)
                  .map((para, i) => (
                    <p key={i} className="ai-summary__text">
                      {para}
                    </p>
                  ))}
              </div>
              <div className="ai-summary__footer">
                <p className="ai-summary__meta">
                  Model:{" "}
                  {model ? (
                    <code>{model}</code>
                  ) : (
                    <span>—</span>
                  )}
                </p>
              </div>
            </>
          )}
        </div>
      </details>
    </div>
  );
}

export function VerifyPage() {
  const [tokenIdInput, setTokenIdInput] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenErr, setTokenErr] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<FieldVerifyResponse | null>(null);

  const [fieldLoading, setFieldLoading] = useState(false);
  const [fieldResult, setFieldResult] = useState<FieldVerifyResponse | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [showTokenFallback, setShowTokenFallback] = useState(false);
  const [institutionName, setInstitutionName] = useState("");
  const [studentName, setStudentName] = useState("");
  const [degreeType, setDegreeType] = useState("");
  const [certId, setCertId] = useState("");
  const [issueDate, setIssueDate] = useState("");

  const fieldsNoMatch = Boolean(fieldResult && !fieldResult.matched);

  useEffect(() => {
    if (window.location.hash.replace(/^#/, "") === "by-token") {
      setShowTokenFallback(true);
    }
  }, []);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    requestAnimationFrame(() => {
      if (showTokenFallback) {
        document.getElementById("by-token")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (hash) {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [showTokenFallback]);

  async function verifyByToken(e: React.FormEvent) {
    e.preventDefault();
    setTokenErr(null);
    setTokenResult(null);
    const n = parseInt(tokenIdInput.trim(), 10);
    if (Number.isNaN(n) || n < 0) {
      setTokenErr("Enter a non-negative integer token ID.");
      return;
    }
    setTokenLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/verify/${n}`);
      const data = (await res.json()) as TokenVerifyApi;
      if (!res.ok) {
        setTokenErr(data.error || res.statusText || "Token verification failed");
        return;
      }
      if (data.exists === false) {
        setTokenErr(data.hint || "This token ID does not exist on the configured contract.");
        return;
      }
      setTokenResult({
        matched: true,
        token_id: data.token_id,
        chain_id: data.chain_id,
        contract_address: data.contract_address,
        on_chain: data.on_chain,
        off_chain_metadata: data.off_chain_metadata,
      });
    } catch (caught: unknown) {
      setTokenErr(caught instanceof Error ? caught.message : "Network error");
    } finally {
      setTokenLoading(false);
    }
  }

  async function verifyByFields(e: React.FormEvent) {
    e.preventDefault();
    setFieldErr(null);
    setFieldResult(null);
    setTokenErr(null);
    setTokenResult(null);
    setFieldLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/verify/fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institution_name: institutionName,
          student_name: studentName,
          degree_type: degreeType,
          cert_id: certId,
          issue_date: issueDate,
        }),
      });
      const data = (await res.json()) as FieldVerifyResponse & { error?: string };
      if (!res.ok) {
        let msg = data.error || res.statusText || "Field verification failed";
        if ((data.error || "").toLowerCase().includes("indexed hash")) {
          msg =
            `${msg}. Check that issue date is the exact issued value in YYYY-MM-DD ` +
            `(submitted: ${issueDate || "empty"}).`;
        }
        setFieldErr(msg);
        setShowTokenFallback(true);
        return;
      }
      setFieldResult(data);
      if (data.matched) {
        setShowTokenFallback(false);
      } else {
        setShowTokenFallback(true);
      }
    } catch (caught: unknown) {
      setFieldErr(caught instanceof Error ? caught.message : "Network error");
      setShowTokenFallback(true);
    } finally {
      setFieldLoading(false);
    }
  }

  return (
    <div className="verify-page verify-page--mock">
      <header className="verify-mock-hero">
        <div className="verify-mock-hero__top">
          <span className="home-mock-eyebrow">Public verification</span>
        </div>
        <h1 className="verify-mock-hero__title">Certificate verification</h1>
        <p className="verify-mock-hero__lead">
          Enter the issued fields exactly as they appear on the credential. If there is no match, you can verify with a token
          ID instead.
        </p>
      </header>

      <section id="by-fields" className="verify-mock-panel" aria-labelledby="verify-fields-heading">
        <div className="verify-mock-panel__head">
          <span className="verify-mock-step">Step 1</span>
          <h2 id="verify-fields-heading" className="verify-mock-panel__title">
            Verify by fields
          </h2>
        </div>
        <p className="verify-mock-panel__hint muted-inline small">
          Values must match issued certificate formatting exactly (including issue date as YYYY-MM-DD).
        </p>
        <form className="stack verify-form verify-form--mock" onSubmit={verifyByFields}>
          <div className="row two-col verify-mock-two-col">
            <div className="inst-field">
              <label htmlFor="vf_inst">Institution name</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  🏛
                </span>
                <input
                  id="vf_inst"
                  placeholder="e.g. Massachusetts Institute of Technology"
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="vf_student">Student name</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  👤
                </span>
                <input
                  id="vf_student"
                  placeholder="e.g. John Doe"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>
          <div className="row two-col verify-mock-two-col">
            <div className="inst-field">
              <label htmlFor="vf_degree">Degree type</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  🎓
                </span>
                <input
                  id="vf_degree"
                  placeholder="e.g. B.A."
                  value={degreeType}
                  onChange={(e) => setDegreeType(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="vf_cert">Certificate ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  ▣
                </span>
                <input id="vf_cert" placeholder="ID-8829" value={certId} onChange={(e) => setCertId(e.target.value)} required />
              </div>
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="vf_date">Issue date (YYYY-MM-DD)</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                📅
              </span>
              <input id="vf_date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
            </div>
            <p className="verify-mock-date-hint muted-inline small">Submitting as: {issueDate || "—"}</p>
          </div>
          <button type="submit" className="inst-submit-wide" disabled={fieldLoading} aria-busy={fieldLoading}>
            <BusyLabel busy={fieldLoading} idle="Verify with fields" busyLabel="Verifying…" />
          </button>
        </form>
        {fieldLoading && <VerifyResultSkeleton hint="Matching indexed certificate fields…" />}
        {fieldErr && <div className="error verify-mock-alert">{fieldErr}</div>}
        {fieldsNoMatch && (
          <div className="verify-mock-callout" role="status">
            <strong>No matching certificate</strong>
            <p>Those values did not match an issued credential in the index. Use token ID verification below if you have one.</p>
          </div>
        )}
        {!fieldLoading && fieldResult?.matched && <VerifyResultView result={fieldResult} />}
        {!fieldLoading && fieldResult?.matched && <AiSummary verification={fieldResult} />}
      </section>

      {showTokenFallback && (
        <section id="by-token" className="verify-mock-panel verify-mock-panel--secondary" aria-labelledby="verify-token-heading">
          <div className="verify-mock-panel__head">
            <span className="verify-mock-step">Step 2</span>
            <h2 id="verify-token-heading" className="verify-mock-panel__title">
              Verify by token ID
            </h2>
          </div>
          <p className="verify-mock-panel__hint muted-inline small">
            Reads the TruCert contract on the RPC configured for this deployment and fetches IPFS metadata when present.
          </p>
          <form className="stack verify-form verify-form--mock" onSubmit={verifyByToken}>
            <div className="inst-field">
              <label htmlFor="vf_token">Token ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  #
                </span>
                <input
                  id="vf_token"
                  type="number"
                  min={0}
                  step={1}
                  placeholder="e.g. 1"
                  className="mono"
                  value={tokenIdInput}
                  onChange={(e) => setTokenIdInput(e.target.value)}
                  required
                />
              </div>
            </div>
            <button type="submit" className="inst-submit-wide" disabled={tokenLoading} aria-busy={tokenLoading}>
              <BusyLabel busy={tokenLoading} idle="Verify with token ID" busyLabel="Verifying…" />
            </button>
          </form>
          {tokenLoading && <VerifyResultSkeleton hint="Checking chain record and metadata…" />}
          {tokenErr && <div className="error verify-mock-alert">{tokenErr}</div>}
          {!tokenLoading && tokenResult && <VerifyResultView result={tokenResult} />}
          {!tokenLoading && tokenResult && <AiSummary verification={tokenResult} />}
        </section>
      )}

      <section className="verify-mock-panel verify-mock-panel--muted" aria-labelledby="verify-doc-heading">
        <div className="verify-head-row">
          <h2 id="verify-doc-heading" className="verify-mock-panel__title verify-mock-panel__title--inline">
            Verify by document
          </h2>
          <span className="coming-soon">COMING SOON</span>
        </div>
        <div className="doc-dropzone verify-mock-dropzone">
          <p className="doc-drop-title">Select certificate document</p>
          <p className="doc-drop-sub">Supports PDF, PNG, JPG (max 5MB)</p>
        </div>
        <div className="stack verify-form--mock">
          <div className="inst-field">
            <label htmlFor="vf_doc_inst">Institution name (optional)</label>
            <div className="inst-input-wrap inst-input-wrap--disabled">
              <span className="inst-input-icon" aria-hidden>
                🏛
              </span>
              <input id="vf_doc_inst" type="text" disabled placeholder="—" />
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="vf_doc_candidate">Candidate name (optional)</label>
            <div className="inst-input-wrap inst-input-wrap--disabled">
              <span className="inst-input-icon" aria-hidden>
                👤
              </span>
              <input id="vf_doc_candidate" type="text" disabled placeholder="—" />
            </div>
          </div>
          <div className="warn-banner">
            Document upload is available for secure storage; automated extraction and verification against the ledger will be
            enabled in a future release.
          </div>
          <button type="button" className="inst-submit-wide" disabled>
            Upload &amp; verify (coming soon)
          </button>
        </div>
      </section>

      <footer className="verify-mock-footer">TruCert — UWI capstone · Flask API + Polygon + IPFS (Pinata)</footer>
    </div>
  );
}
