import { useState } from "react";
import { Link } from "react-router-dom";
import { BusyLabel } from "../components/LoadingSpinner";
import { apiFormData } from "../api/client";

const DOC_LABELS = ["Accreditation", "Authorization letter", "Other"] as const;

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

const COMMON_TIMEZONES = [
  "UTC",
  "America/Jamaica",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Asia/Dubai",
  "Asia/Singapore",
  "Australia/Sydney",
];

type DocSlot = { file: File | null; label: (typeof DOC_LABELS)[number] };

export function RegisterPage() {
  const [step, setStep] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const [expectedMintsMonthly, setExpectedMintsMonthly] = useState("");
  const [expectedMintsAnnually, setExpectedMintsAnnually] = useState("");
  const [opDays, setOpDays] = useState<Set<number>>(() => new Set([0, 1, 2, 3, 4]));
  const [opStart, setOpStart] = useState("");
  const [opEnd, setOpEnd] = useState("");
  const [opTz, setOpTz] = useState("");
  const [docSlots, setDocSlots] = useState<DocSlot[]>([{ file: null, label: "Accreditation" }]);

  function toggleDay(d: number) {
    setOpDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  function validateStep(s: number): string | null {
    if (s === 0) {
      if (!name.trim()) return "Institution name is required.";
      if (!internalId.trim()) return "Internal ID is required.";
      if (!domainEmail.trim()) return "Email domain is required.";
      if (!contactEmail.trim()) return "Contact email (login) is required.";
      if (!password || password.length < 8) return "Password must be at least 8 characters.";
      const w = issuerWallet.trim();
      if (!w.startsWith("0x") || w.length !== 42) return "Issuer wallet must be a 0x address (42 characters).";
      const dom = domainEmail.trim().toLowerCase();
      const ce = contactEmail.trim().toLowerCase();
      if (!ce.endsWith(`@${dom}`)) return "Contact email must use your institution domain.";
      return null;
    }
    if (s === 1) {
      if (!institutionContactEmail.trim()) return "Institution contact email is required.";
      if (!institutionContactPhone.trim()) return "Institution contact phone is required.";
      if (!institutionWebsite.trim()) return "Institution website is required.";
      if (!institutionLicenseId.trim()) return "Institution license ID is required.";
      if (!institutionLicenseAuthority.trim()) return "License authority is required.";
      if (!institutionLicenseValidUntil.trim()) return "License valid-until date is required.";
      return null;
    }
    if (s === 2) {
      const m = expectedMintsMonthly.trim();
      if (m === "") return "Expected mints per month is required.";
      const n = parseInt(m, 10);
      if (Number.isNaN(n) || n < 0) return "Expected mints per month must be a non-negative integer.";
      const ann = expectedMintsAnnually.trim();
      if (ann !== "") {
        const na = parseInt(ann, 10);
        if (Number.isNaN(na) || na < 0) return "Expected mints annually must be a non-negative integer or empty.";
      }
      const hasStart = Boolean(opStart.trim());
      const hasEnd = Boolean(opEnd.trim());
      if (hasStart !== hasEnd) return "Provide both operating start and end times, or leave both empty.";
      if (hasStart && hasEnd) {
        if (!opTz.trim()) return "Operating timezone is required when hours are set.";
        if (opDays.size === 0) return "Select at least one operating day when hours are set.";
      }
      return null;
    }
    return null;
  }

  function goNext() {
    setErr(null);
    const v = validateStep(step);
    if (v) {
      setErr(v);
      return;
    }
    setStep((s) => Math.min(2, s + 1));
  }

  function goBack() {
    setErr(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function onFinalSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    const v = validateStep(2);
    if (v) {
      setErr(v);
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("name", name.trim());
      fd.append("internal_id", internalId.trim());
      fd.append("domain_email", domainEmail.trim().toLowerCase());
      fd.append("contact_email", contactEmail.trim().toLowerCase());
      fd.append("password", password);
      fd.append("issuer_wallet_address", issuerWallet.trim());
      fd.append("institution_contact_email", institutionContactEmail.trim());
      fd.append("institution_contact_phone", institutionContactPhone.trim());
      fd.append("institution_website", institutionWebsite.trim());
      fd.append("institution_license_id", institutionLicenseId.trim());
      fd.append("institution_license_authority", institutionLicenseAuthority.trim());
      fd.append("institution_license_valid_until", institutionLicenseValidUntil.trim());
      if (kycNotes.trim()) fd.append("kyc_notes", kycNotes.trim());
      fd.append("expected_mints_monthly", String(parseInt(expectedMintsMonthly.trim(), 10)));
      if (expectedMintsAnnually.trim() !== "") {
        fd.append("expected_mints_annually", String(parseInt(expectedMintsAnnually.trim(), 10)));
      }
      fd.append("operating_days_of_week", JSON.stringify(Array.from(opDays).sort((a, b) => a - b)));
      if (opStart.trim() && opEnd.trim()) {
        fd.append("operating_hours_start", opStart.trim());
        fd.append("operating_hours_end", opEnd.trim());
        fd.append("operating_timezone", opTz.trim());
      }
      for (const slot of docSlots) {
        if (slot.file) {
          fd.append("documents", slot.file);
          fd.append("document_labels", slot.label);
        }
      }
      const data = await apiFormData<{ message: string; issuer_wallet_address: string }>(
        "/api/auth/register-university",
        fd
      );
      setOk(
        `${data.message} Issuer wallet: ${data.issuer_wallet_address}. Use this same wallet in MetaMask for chain actions.`
      );
      setStep(0);
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
          Submit your institution for manual verification in three short steps. Your login password and issuer wallet
          address are handled like the rest of TruCert: private keys stay in your wallet and are never sent to our
          servers.
        </p>
      </header>

      <section className="panel">
        <nav className="register-wizard-steps" aria-label="Registration progress">
          {["Account & issuer", "Profile & compliance", "Issuance & documents"].map((label, i) => (
            <span
              key={label}
              className={`register-wizard-steps__item${i === step ? " register-wizard-steps__item--active" : ""}${
                i < step ? " register-wizard-steps__item--done" : ""
              }`}
            >
              <span className="register-wizard-steps__num" aria-hidden>
                {i < step ? "✓" : i + 1}
              </span>
              <span className="register-wizard-steps__label">{label}</span>
            </span>
          ))}
        </nav>

        <form className="stack" onSubmit={step === 2 ? onFinalSubmit : (e) => e.preventDefault()}>
          {step === 0 && (
            <>
              <h2 className="subheading">Step 1 — Account & issuer identity</h2>
              <div className="inst-field">
                <label htmlFor="name">Institution name</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    🏛
                  </span>
                  <input id="name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="organization" />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="internal_id">Internal ID (your reference number)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    🏷
                  </span>
                  <input
                    id="internal_id"
                    value={internalId}
                    onChange={(e) => setInternalId(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="domain_email">Email domain (e.g. uwimona.edu.jm)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    🌐
                  </span>
                  <input
                    id="domain_email"
                    value={domainEmail}
                    onChange={(e) => setDomainEmail(e.target.value)}
                    required
                    autoComplete="off"
                    placeholder="university.edu"
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="contact_email">Contact email (login)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    ✉
                  </span>
                  <input
                    id="contact_email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="password">Password</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    ▣
                  </span>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={8}
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="issuer_wallet">Issuer wallet address (0x…)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    ⧉
                  </span>
                  <input
                    id="issuer_wallet"
                    className="mono"
                    value={issuerWallet}
                    onChange={(e) => setIssuerWallet(e.target.value)}
                    required
                    placeholder="0x..."
                    autoComplete="off"
                  />
                </div>
                <p className="muted-inline small" style={{ marginTop: "0.35rem" }}>
                  Paste your public issuer address only. Never paste a private key or seed phrase anywhere in TruCert.
                </p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="subheading">Step 2 — Institution profile & compliance</h2>
              <p className="muted-inline small">
                These fields are stored on your university profile and may be referenced in issued certificate metadata
                after approval.
              </p>
              <div className="row two-col">
                <div className="inst-field">
                  <label htmlFor="inst_email">Institution contact email</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      ✉
                    </span>
                    <input
                      id="inst_email"
                      type="email"
                      value={institutionContactEmail}
                      onChange={(e) => setInstitutionContactEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="inst-field">
                  <label htmlFor="inst_phone">Institution contact phone</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      ☎
                    </span>
                    <input
                      id="inst_phone"
                      value={institutionContactPhone}
                      onChange={(e) => setInstitutionContactPhone(e.target.value)}
                      required
                    />
                  </div>
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="inst_web">Institution website (https://…)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    🔗
                  </span>
                  <input
                    id="inst_web"
                    value={institutionWebsite}
                    onChange={(e) => setInstitutionWebsite(e.target.value)}
                    required
                    placeholder="https://"
                  />
                </div>
              </div>
              <div className="row two-col">
                <div className="inst-field">
                  <label htmlFor="inst_lic">Institution license ID</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      ▣
                    </span>
                    <input id="inst_lic" value={institutionLicenseId} onChange={(e) => setInstitutionLicenseId(e.target.value)} required />
                  </div>
                </div>
                <div className="inst-field">
                  <label htmlFor="inst_auth">License authority</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      ⚖
                    </span>
                    <input
                      id="inst_auth"
                      value={institutionLicenseAuthority}
                      onChange={(e) => setInstitutionLicenseAuthority(e.target.value)}
                      required
                    />
                  </div>
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="inst_valid">License valid until (YYYY-MM-DD)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    📅
                  </span>
                  <input
                    id="inst_valid"
                    type="date"
                    value={institutionLicenseValidUntil}
                    onChange={(e) => setInstitutionLicenseValidUntil(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="kyc">KYC / notes (optional)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    ✎
                  </span>
                  <textarea id="kyc" rows={3} value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="subheading">Step 3 — Issuance planning & documents</h2>
              <p className="muted-inline small">
                Expected volumes and operating hours help us with capacity and admin review. Uploaded files (PDF or
                images) are for verification and operational monitoring only — they are{" "}
                <strong>not</strong> published as certificate metadata on IPFS or the verify page.
              </p>
              <div className="row two-col">
                <div className="inst-field">
                  <label htmlFor="exp_m">Expected mints per month</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      #
                    </span>
                    <input
                      id="exp_m"
                      type="number"
                      min={0}
                      step={1}
                      value={expectedMintsMonthly}
                      onChange={(e) => setExpectedMintsMonthly(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="inst-field">
                  <label htmlFor="exp_y">Expected mints annually (optional)</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      #
                    </span>
                    <input
                      id="exp_y"
                      type="number"
                      min={0}
                      step={1}
                      value={expectedMintsAnnually}
                      onChange={(e) => setExpectedMintsAnnually(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              <fieldset className="register-fieldset">
                <legend className="register-fieldset__legend">Operating days of week</legend>
                <div className="register-day-grid" role="group" aria-label="Operating weekdays">
                  {WEEKDAYS.map(({ value, label }) => (
                    <label key={value} className="register-day-chip">
                      <input type="checkbox" checked={opDays.has(value)} onChange={() => toggleDay(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="row two-col">
                <div className="inst-field">
                  <label htmlFor="op_s">Operating hours start (24h, optional)</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      🕐
                    </span>
                    <input id="op_s" type="time" value={opStart} onChange={(e) => setOpStart(e.target.value)} />
                  </div>
                </div>
                <div className="inst-field">
                  <label htmlFor="op_e">Operating hours end (24h, optional)</label>
                  <div className="inst-input-wrap">
                    <span className="inst-input-icon" aria-hidden>
                      🕐
                    </span>
                    <input id="op_e" type="time" value={opEnd} onChange={(e) => setOpEnd(e.target.value)} />
                  </div>
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="op_tz">Operating timezone (IANA)</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    🌍
                  </span>
                  <input
                    id="op_tz"
                    list="tz_list"
                    value={opTz}
                    onChange={(e) => setOpTz(e.target.value)}
                    placeholder="e.g. America/Jamaica"
                    autoComplete="off"
                  />
                </div>
                <datalist id="tz_list">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
                <p className="muted-inline small" style={{ marginTop: "0.25rem" }}>
                  Required if you set operating hours above.
                </p>
              </div>

              <div className="stack" style={{ gap: "0.75rem" }}>
                <span className="register-fieldset__legend" style={{ marginBottom: 0 }}>
                  Verification documents (optional)
                </span>
                {docSlots.map((slot, idx) => (
                  <div key={idx} className="register-doc-row">
                    <div className="inst-field">
                      <label htmlFor={`doc_f_${idx}`}>File {idx + 1}</label>
                      <div className="inst-input-wrap">
                        <span className="inst-input-icon" aria-hidden>
                          📎
                        </span>
                        <input
                          id={`doc_f_${idx}`}
                          type="file"
                          accept=".pdf,application/pdf,image/png,image/jpeg,image/webp"
                          onChange={(e) => {
                            const f = e.target.files?.[0] ?? null;
                            setDocSlots((rows) => rows.map((r, j) => (j === idx ? { ...r, file: f } : r)));
                          }}
                        />
                      </div>
                    </div>
                    <div className="inst-field">
                      <label htmlFor={`doc_l_${idx}`}>Document type</label>
                      <div className="inst-input-wrap">
                        <span className="inst-input-icon" aria-hidden>
                          📄
                        </span>
                        <select
                          id={`doc_l_${idx}`}
                          value={slot.label}
                          onChange={(e) =>
                            setDocSlots((rows) =>
                              rows.map((r, j) =>
                                j === idx ? { ...r, label: e.target.value as DocSlot["label"] } : r
                              )
                            )
                          }
                        >
                          {DOC_LABELS.map((l) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {docSlots.length > 1 ? (
                      <button
                        type="button"
                        className="btn-text register-doc-remove"
                        onClick={() => setDocSlots((rows) => rows.filter((_, j) => j !== idx))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                {docSlots.length < 8 ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setDocSlots((rows) => [...rows, { file: null, label: "Other" }])}
                  >
                    Add another document
                  </button>
                ) : null}
              </div>
            </>
          )}

          {err && <div className="error">{err}</div>}
          {ok && <div className="success">{ok}</div>}

          <div className="row register-wizard-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            {step > 0 ? (
              <button type="button" className="btn-secondary" onClick={goBack} disabled={busy}>
                Back
              </button>
            ) : (
              <span />
            )}
            {step < 2 ? (
              <button type="button" onClick={goNext}>
                Next
              </button>
            ) : (
              <button type="submit" disabled={busy} aria-busy={busy}>
                <BusyLabel busy={busy} idle="Submit registration" busyLabel="Submitting…" />
              </button>
            )}
          </div>
        </form>
        <p className="muted-inline">
          <Link to="/login">Back to login</Link>
        </p>
      </section>
    </>
  );
}
