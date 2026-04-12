import { useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api/client";

export function RegisterPage() {
  const [name, setName] = useState("");
  const [internalId, setInternalId] = useState("");
  const [domainEmail, setDomainEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [password, setPassword] = useState("");
  const [issuerKey, setIssuerKey] = useState("");
  const [kycNotes, setKycNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const data = await apiJson<{ message: string; derived_wallet_address: string }>(
        "/api/auth/register-university",
        {
          method: "POST",
          json: {
            name,
            internal_id: internalId,
            domain_email: domainEmail,
            contact_email: contactEmail,
            password,
            issuer_private_key: issuerKey,
            kyc_notes: kycNotes || undefined,
          },
        }
      );
      setOk(
        `${data.message} Issuer wallet (derived): ${data.derived_wallet_address}. Fund this wallet on Amoy for gas.`
      );
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header>
        <h1>Register university</h1>
        <p>
          Submit your institution for manual verification. Contact email must match your{" "}
          <code>domain_email</code>. The issuer private key is encrypted at rest; fund the derived
          wallet with Amoy MATIC for minting.
        </p>
      </header>

      <section className="panel">
        <form className="stack" onSubmit={onSubmit}>
          <div>
            <label htmlFor="name">Institution name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="internal_id">Internal ID (your reference number)</label>
            <input
              id="internal_id"
              value={internalId}
              onChange={(e) => setInternalId(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="domain_email">Email domain (e.g. uwimona.edu.jm)</label>
            <input
              id="domain_email"
              value={domainEmail}
              onChange={(e) => setDomainEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="contact_email">Contact email (login)</label>
            <input
              id="contact_email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="issuer_private_key">Issuer private key (32-byte hex, 0x optional)</label>
            <textarea
              id="issuer_private_key"
              className="mono"
              rows={2}
              value={issuerKey}
              onChange={(e) => setIssuerKey(e.target.value)}
              required
              placeholder="0x…"
            />
          </div>
          <div>
            <label htmlFor="kyc">KYC / notes (optional)</label>
            <textarea
              id="kyc"
              rows={2}
              value={kycNotes}
              onChange={(e) => setKycNotes(e.target.value)}
            />
          </div>
          {err && <div className="error">{err}</div>}
          {ok && <div className="success">{ok}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "Submitting…" : "Submit registration"}
          </button>
        </form>
        <p className="muted-inline">
          <Link to="/login">Back to login</Link>
        </p>
      </section>
    </>
  );
}
