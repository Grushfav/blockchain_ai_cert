import { useState } from "react";
import { API_BASE } from "../api/client";

type FieldVerifyResponse = {
  matched: boolean;
  token_id?: number;
  core_hash?: string;
  on_chain?: {
    issuer_address: string;
    owner_address: string;
    locked: boolean;
    valid: boolean;
    metadata_uri: string;
    core_hash?: string | null;
    exists?: boolean;
  };
  off_chain_metadata?: Record<string, unknown>;
  error?: string;
};

export function VerifyPage() {
  const [fieldLoading, setFieldLoading] = useState(false);
  const [fieldResult, setFieldResult] = useState<FieldVerifyResponse | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [institutionName, setInstitutionName] = useState("");
  const [studentName, setStudentName] = useState("");
  const [degreeType, setDegreeType] = useState("");
  const [certId, setCertId] = useState("");
  const [issueDate, setIssueDate] = useState("");

  async function verifyByFields(e: React.FormEvent) {
    e.preventDefault();
    setFieldErr(null);
    setFieldResult(null);
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
        return;
      }
      setFieldResult(data);
    } catch (caught: unknown) {
      setFieldErr(caught instanceof Error ? caught.message : "Network error");
    } finally {
      setFieldLoading(false);
    }
  }

  return (
    <>
      <header>
        <h1>Certificate verification</h1>
        <p>Verify credentials by exact issued fields. Document upload flow is coming soon.</p>
      </header>

      <section className="panel verify-card">
        <h2 className="verify-title">Verify by Fields</h2>
        <form className="stack verify-form" onSubmit={verifyByFields}>
          <div className="row two-col">
            <div>
              <label htmlFor="vf_inst">Institution name</label>
              <input
                id="vf_inst"
                placeholder="e.g. Massachusetts Institute of Technology"
                value={institutionName}
                onChange={(e) => setInstitutionName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="vf_student">Student name</label>
              <input
                id="vf_student"
                placeholder="e.g. John Doe"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="row two-col">
            <div>
              <label htmlFor="vf_degree">Degree type</label>
              <input
                id="vf_degree"
                placeholder="e.g. B.A."
                value={degreeType}
                onChange={(e) => setDegreeType(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="vf_cert">Certificate ID</label>
              <input
                id="vf_cert"
                placeholder="ID-8829"
                value={certId}
                onChange={(e) => setCertId(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="vf_date">Issue date (YYYY-MM-DD)</label>
            <input
              id="vf_date"
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
            <p className="muted-inline small">Submitting as: {issueDate || "—"}</p>
          </div>
          <p className="muted-inline small">Field values must match issued certificate formatting exactly.</p>
          <button type="submit" disabled={fieldLoading}>
            {fieldLoading ? "Verifying..." : "Verify"}
          </button>
        </form>
        {fieldErr && <div className="error">{fieldErr}</div>}
        {fieldResult?.matched && (
          <div className="result">
            <p>Matched token ID: <strong>{fieldResult.token_id}</strong></p>
            <p className="mono small">Core hash: {fieldResult.core_hash}</p>
            {fieldResult.off_chain_metadata && (
              <div className="meta-block">
                <h3>Off-chain metadata (IPFS JSON)</h3>
                <pre className="json">{JSON.stringify(fieldResult.off_chain_metadata, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel verify-card">
        <div className="verify-head-row">
          <h2 className="verify-title">Verify by Document</h2>
          <span className="coming-soon">COMING SOON</span>
        </div>
        <div className="doc-dropzone">
          <p className="doc-drop-title">Select Certificate Document</p>
          <p className="doc-drop-sub">Supports PDF, PNG, JPG (Max 5MB)</p>
        </div>
        <div className="stack">
          <div>
            <label>Institution name (optional)</label>
            <input type="text" disabled />
          </div>
          <div>
            <label>Candidate name (optional)</label>
            <input type="text" disabled />
          </div>
          <div className="warn-banner">
            Document upload is available for secure storage; automated extraction and verification
            against ledger will be enabled in a future release.
          </div>
          <button type="button" disabled>
            Upload & verify (coming soon)
          </button>
        </div>
      </section>

      <footer>TruCert — UWI capstone · Flask API + Polygon + IPFS (Pinata)</footer>
    </>
  );
}
