import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../api/client";

type Me = {
  name: string;
  internal_id: string;
  status: string;
  wallet_address: string;
};

export function UniversityPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [tokenId, setTokenId] = useState("");
  const [studentName, setStudentName] = useState("");
  const [degreeTitle, setDegreeTitle] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [gpaHonors, setGpaHonors] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [mintMsg, setMintMsg] = useState<string | null>(null);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [mintBusy, setMintBusy] = useState(false);

  const [claimTid, setClaimTid] = useState("");
  const [studentWallet, setStudentWallet] = useState("");
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);

  const [revokeTid, setRevokeTid] = useState("");
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const loadMe = useCallback(async () => {
    setLoadErr(null);
    try {
      const data = await apiJson<Me>("/api/university/me");
      setMe(data);
    } catch (caught: unknown) {
      setMe(null);
      setLoadErr(caught instanceof Error ? caught.message : "Failed to load profile");
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setMintErr(null);
    setMintMsg(null);
    const tid = Number(tokenId);
    if (!Number.isInteger(tid) || tid < 0) {
      setMintErr("token_id must be a non-negative integer.");
      return;
    }
    setMintBusy(true);
    try {
      const data = await apiJson<{ tx: string; token_id: number; metadata_uri: string }>(
        "/api/university/certificates",
        {
          method: "POST",
          json: {
            token_id: tid,
            student_full_name: studentName,
            degree_title: degreeTitle,
            institution_name: institutionName,
            gpa_honors: gpaHonors,
            issue_date: issueDate,
          },
        }
      );
      setMintMsg(`Minted. Tx: ${data.tx} · metadata_uri: ${data.metadata_uri}`);
    } catch (caught: unknown) {
      setMintErr(caught instanceof Error ? caught.message : "Mint failed");
    } finally {
      setMintBusy(false);
    }
  }

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setClaimErr(null);
    setClaimMsg(null);
    const tid = Number(claimTid);
    if (!Number.isInteger(tid) || tid < 0) {
      setClaimErr("Token ID must be a non-negative integer.");
      return;
    }
    setClaimBusy(true);
    try {
      const data = await apiJson<{ tx: string }>(
        `/api/university/certificates/${tid}/claim`,
        {
          method: "POST",
          json: { student_wallet: studentWallet.trim() },
        }
      );
      setClaimMsg(`Claimed. Tx: ${data.tx}`);
    } catch (caught: unknown) {
      setClaimErr(caught instanceof Error ? caught.message : "Claim failed");
    } finally {
      setClaimBusy(false);
    }
  }

  async function revoke(e: React.FormEvent) {
    e.preventDefault();
    setRevokeErr(null);
    setRevokeMsg(null);
    const tid = Number(revokeTid);
    if (!Number.isInteger(tid) || tid < 0) {
      setRevokeErr("Token ID must be a non-negative integer.");
      return;
    }
    setRevokeBusy(true);
    try {
      const data = await apiJson<{ tx: string }>(`/api/university/certificates/${tid}/revoke`, {
        method: "POST",
      });
      setRevokeMsg(`Revoked. Tx: ${data.tx}`);
    } catch (caught: unknown) {
      setRevokeErr(caught instanceof Error ? caught.message : "Revoke failed");
    } finally {
      setRevokeBusy(false);
    }
  }

  const verified = me?.status === "verified";

  return (
    <>
      <header>
        <h1>University portal</h1>
        <p>Mint certificates to escrow, claim to a student wallet (soulbound), or revoke.</p>
      </header>

      <section className="panel">
        <h2 className="subhead">Profile</h2>
        {loadErr && <div className="error">{loadErr}</div>}
        {me && (
          <div className="grid profile-summary">
            <div className="kv">
              <span>Institution</span>
              <span>{me.name}</span>
            </div>
            <div className="kv">
              <span>Internal ID</span>
              <span>{me.internal_id}</span>
            </div>
            <div className="kv">
              <span>Status</span>
              <span>
                <span className={`status ${me.status}`}>{me.status}</span>
              </span>
            </div>
            <div className="kv">
              <span>Issuer wallet</span>
              <span className="mono small">{me.wallet_address}</span>
            </div>
          </div>
        )}
        {!verified && me && (
          <p className="warn-banner">
            Your institution is not verified yet. Minting and claiming are blocked until an admin
            approves your registration.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="subhead">Mint certificate (escrow)</h2>
        <p className="muted-inline">
          Uploads metadata JSON to Pinata, then calls <code>mintToEscrow</code> with your issuer key.
        </p>
        <form className="stack" onSubmit={mint}>
          <div className="row two-col">
            <div>
              <label htmlFor="mint_tid">Token ID</label>
              <input
                id="mint_tid"
                value={tokenId}
                onChange={(e) => setTokenId(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="issue_date">Issue date</label>
              <input
                id="issue_date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                placeholder="e.g. 2026-04-10"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="student_name">Student full name</label>
            <input
              id="student_name"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="degree">Degree title</label>
            <input
              id="degree"
              value={degreeTitle}
              onChange={(e) => setDegreeTitle(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="inst">Institution name</label>
            <input
              id="inst"
              value={institutionName}
              onChange={(e) => setInstitutionName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="gpa">GPA / Honors</label>
            <input
              id="gpa"
              value={gpaHonors}
              onChange={(e) => setGpaHonors(e.target.value)}
              required
            />
          </div>
          {mintErr && <div className="error">{mintErr}</div>}
          {mintMsg && <div className="success">{mintMsg}</div>}
          <button type="submit" disabled={mintBusy || !verified}>
            {mintBusy ? "Minting…" : "Mint to escrow"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Claim (transfer to student &amp; lock)</h2>
        <form className="stack" onSubmit={claim}>
          <div className="row two-col">
            <div>
              <label htmlFor="claim_tid">Token ID</label>
              <input
                id="claim_tid"
                value={claimTid}
                onChange={(e) => setClaimTid(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="stu">Student wallet (0x…)</label>
              <input
                id="stu"
                className="mono"
                value={studentWallet}
                onChange={(e) => setStudentWallet(e.target.value)}
                required
              />
            </div>
          </div>
          {claimErr && <div className="error">{claimErr}</div>}
          {claimMsg && <div className="success">{claimMsg}</div>}
          <button type="submit" disabled={claimBusy || !verified}>
            {claimBusy ? "Claiming…" : "Claim & lock (soulbound)"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Revoke certificate</h2>
        <form className="stack" onSubmit={revoke}>
          <div>
            <label htmlFor="revoke_tid">Token ID</label>
            <input
              id="revoke_tid"
              value={revokeTid}
              onChange={(e) => setRevokeTid(e.target.value)}
              required
            />
          </div>
          {revokeErr && <div className="error">{revokeErr}</div>}
          {revokeMsg && <div className="success">{revokeMsg}</div>}
          <button type="submit" className="btn-secondary" disabled={revokeBusy || !verified}>
            {revokeBusy ? "Revoking…" : "Revoke on-chain"}
          </button>
        </form>
      </section>
    </>
  );
}
