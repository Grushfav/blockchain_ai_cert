import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api/client";
import { BusyLabel } from "../components/LoadingSpinner";

type VerifiedUni = {
  id: number;
  name: string;
  internal_id: string;
  logo_url?: string | null;
  wallet_address?: string | null;
  domain_email?: string | null;
  institution_contact_email?: string | null;
};

export function StudentClaimPage() {
  const [universities, setUniversities] = useState<VerifiedUni[]>([]);
  const [uniBusy, setUniBusy] = useState(true);
  const [uniErr, setUniErr] = useState<string | null>(null);

  const [universityId, setUniversityId] = useState("");
  const [studentInternalId, setStudentInternalId] = useState("");
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState("");

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setUniBusy(true);
      setUniErr(null);
      try {
        const data = await apiJson<{ universities: VerifiedUni[] }>("/api/public/verified-universities");
        if (!cancelled) setUniversities(data.universities || []);
      } catch (caught: unknown) {
        if (!cancelled) setUniErr(caught instanceof Error ? caught.message : "Failed to load institutions");
      } finally {
        if (!cancelled) setUniBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitErr(null);
    setSubmitOk(null);
    const uid = Number(universityId);
    if (!Number.isInteger(uid) || uid < 1) {
      setSubmitErr("Choose your institution.");
      return;
    }
    setSubmitBusy(true);
    try {
      const out = await apiJson<{ message?: string; id?: number }>("/api/public/student-claim-requests", {
        method: "POST",
        json: {
          university_id: uid,
          student_internal_id: studentInternalId.trim(),
          student_email: email.trim(),
          wallet_address: wallet.trim(),
        },
      });
      setSubmitOk(out.message || "Request submitted.");
      setWallet("");
    } catch (caught: unknown) {
      setSubmitErr(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setSubmitBusy(false);
    }
  }

  return (
    <div className="verify-page verify-page--mock">
      <header className="verify-mock-hero">
        <p className="verify-mock-hero__top">Students</p>
        <h1 className="verify-mock-hero__title">Request credential transfer</h1>
        <p className="verify-mock-hero__lead">
          If your school issued your TruCert on-chain credential to their escrow wallet, submit the details below. Your
          institution reviews the request and runs the claim transaction to your wallet (then the token is soulbound).
        </p>
      </header>

      <section className="verify-mock-panel">
        <div className="verify-mock-panel__head">
          <h2 className="verify-mock-panel__title">Claim request form</h2>
          <p className="verify-mock-panel__hint muted-inline small">
            Use the same student ID and email your institution stored for your batch row.
          </p>
        </div>

        {uniBusy ? (
          <p className="muted-inline">Loading institutions…</p>
        ) : uniErr ? (
          <div className="error">{uniErr}</div>
        ) : (
          <form className="verify-form--mock stack" onSubmit={(e) => void onSubmit(e)}>
            <div className="inst-field">
              <label htmlFor="claim-uni">Institution</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  🎓
                </span>
                <select id="claim-uni" value={universityId} onChange={(e) => setUniversityId(e.target.value)} required>
                  <option value="">Select…</option>
                  {universities.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name} ({u.internal_id})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="claim-sid">Student ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  #
                </span>
                <input
                  id="claim-sid"
                  value={studentInternalId}
                  onChange={(e) => setStudentInternalId(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="claim-email">Email</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  ✉
                </span>
                <input
                  id="claim-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="claim-wallet">Your wallet address</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  ⧉
                </span>
                <input
                  id="claim-wallet"
                  className="mono"
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                  required
                />
              </div>
            </div>
            {submitErr && <div className="error">{submitErr}</div>}
            {submitOk && <div className="success">{submitOk}</div>}
            <button type="submit" disabled={submitBusy} aria-busy={submitBusy}>
              <BusyLabel busy={submitBusy} idle="Submit request" busyLabel="Submitting…" />
            </button>
          </form>
        )}

        <p className="muted-inline small verify-mock-footer" style={{ marginTop: "1rem" }}>
          <Link to="/verify">Verify a credential</Link>
          {" · "}
          <Link to="/">Home</Link>
        </p>
      </section>

      <section className="verify-mock-panel verify-mock-panel--muted">
        <h3 className="verify-mock-panel__title verify-mock-panel__title--inline">Security notes</h3>
        <ul className="muted-inline small" style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
          <li>Anyone can submit a request; matching uses institution-held batch data plus on-chain escrow checks.</li>
          <li>Your institution should confirm identity out-of-band before approving (email, registrar, in-person).</li>
          <li>Never share seed phrases. TruCert staff will never ask for your wallet private key.</li>
        </ul>
      </section>
    </div>
  );
}
