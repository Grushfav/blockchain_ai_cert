import { useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api/client";

export function RegisterPage() {
  const [name, setName] = useState("");
  const [internalId, setInternalId] = useState("");
  const [domainEmail, setDomainEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [password, setPassword] = useState("");
  const [issuerWallet, setIssuerWallet] = useState("");
  const [institutionContactEmail, setInstitutionContactEmail] = useState("");
  const [institutionContactPhone, setInstitutionContactPhone] = useState("");
  const [institutionWebsite, setInstitutionWebsite] = useState("");
  const [institutionLicenseId, setInstitutionLicenseId] = useState("");
  const [institutionLicenseAuthority, setInstitutionLicenseAuthority] = useState("");
  const [institutionLicenseValidUntil, setInstitutionLicenseValidUntil] = useState("");
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
      const data = await apiJson<{ message: string; issuer_wallet_address: string }>(
        "/api/auth/register-university",
        {
          method: "POST",
          json: {
            name,
            internal_id: internalId,
            domain_email: domainEmail,
            contact_email: contactEmail,
            password,
            issuer_wallet_address: issuerWallet,
            institution_contact_email: institutionContactEmail,
            institution_contact_phone: institutionContactPhone,
            institution_website: institutionWebsite,
            institution_license_id: institutionLicenseId,
            institution_license_authority: institutionLicenseAuthority,
            institution_license_valid_until: institutionLicenseValidUntil,
            kyc_notes: kycNotes || undefined,
          },
        }
      );
      setOk(
        `${data.message} Issuer wallet: ${data.issuer_wallet_address}. Use this same wallet in MetaMask for chain actions.`
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
          <code>domain_email</code>. Submit only your issuer wallet address; private keys remain in
          your wallet and never leave the browser.
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
            <label htmlFor="issuer_wallet">Issuer wallet address (0x…)</label>
            <input
              id="issuer_wallet"
              className="mono"
              value={issuerWallet}
              onChange={(e) => setIssuerWallet(e.target.value)}
              required
              placeholder="0x..."
            />
          </div>
          <div className="row two-col">
            <div>
              <label htmlFor="inst_email">Institution contact email</label>
              <input
                id="inst_email"
                type="email"
                value={institutionContactEmail}
                onChange={(e) => setInstitutionContactEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="inst_phone">Institution contact phone</label>
              <input
                id="inst_phone"
                value={institutionContactPhone}
                onChange={(e) => setInstitutionContactPhone(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="row two-col">
            <div>
              <label htmlFor="inst_web">Institution website (https://...)</label>
              <input
                id="inst_web"
                value={institutionWebsite}
                onChange={(e) => setInstitutionWebsite(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="inst_lic">Institution license ID</label>
              <input
                id="inst_lic"
                value={institutionLicenseId}
                onChange={(e) => setInstitutionLicenseId(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="row two-col">
            <div>
              <label htmlFor="inst_auth">License authority</label>
              <input
                id="inst_auth"
                value={institutionLicenseAuthority}
                onChange={(e) => setInstitutionLicenseAuthority(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="inst_valid">License valid until (YYYY-MM-DD)</label>
              <input
                id="inst_valid"
                type="date"
                value={institutionLicenseValidUntil}
                onChange={(e) => setInstitutionLicenseValidUntil(e.target.value)}
                required
              />
            </div>
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
