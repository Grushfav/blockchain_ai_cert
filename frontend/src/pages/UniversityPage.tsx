import { BrowserProvider, Contract, isAddress, parseUnits } from "ethers";
import type { Eip1193Provider } from "ethers";
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiJson, getStoredToken } from "../api/client";
import { TRUCERT_ABI } from "../abi/trucertAbi";

type Me = {
  name: string;
  internal_id: string;
  status: string;
  wallet_address: string;
  contract_address: string;
  chain_id: number;
  logo_uri?: string | null;
  logo_url?: string | null;
  institution_contact_email?: string | null;
  institution_contact_phone?: string | null;
  institution_website?: string | null;
  institution_license_id?: string | null;
  institution_license_authority?: string | null;
  institution_license_valid_until?: string | null;
};

type PreparedMint = {
  metadata_uri: string;
  core_hash: string;
  cert_id: string;
  next_token_id_hint?: number;
  idempotent?: boolean;
};

type BatchRow = {
  id: number;
  row_index: number;
  cert_id: string | null;
  student_email: string | null;
  student_full_name: string | null;
  degree_title: string | null;
  issue_date: string | null;
  row_status: string;
  validation_errors: unknown;
  error_message: string | null;
  token_id: number | null;
  tx_hash: string | null;
};

type ActivityEvent = {
  token_id: number | null;
  action: string;
  tx_hash: string | null;
  block_number: number | null;
  actor: string | null;
  details: Record<string, unknown> | null;
  created_at: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  issued: "issued",
  transferred: "transferred",
  revoked: "revoked",
  burned: "burned",
  reissued: "reissued",
};

export function UniversityPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [logoMsg, setLogoMsg] = useState<string | null>(null);

  const [studentName, setStudentName] = useState("");
  const [degreeType, setDegreeType] = useState("");
  const [certId, setCertId] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [profileContactEmail, setProfileContactEmail] = useState("");
  const [profileContactPhone, setProfileContactPhone] = useState("");
  const [profileWebsite, setProfileWebsite] = useState("");
  const [profileLicenseId, setProfileLicenseId] = useState("");
  const [profileLicenseAuthority, setProfileLicenseAuthority] = useState("");
  const [profileLicenseValidUntil, setProfileLicenseValidUntil] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
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

  const [burnTid, setBurnTid] = useState("");
  const [burnMsg, setBurnMsg] = useState<string | null>(null);
  const [burnErr, setBurnErr] = useState<string | null>(null);
  const [burnBusy, setBurnBusy] = useState(false);

  const [reissueOldTid, setReissueOldTid] = useState("");
  const [reissueStudentName, setReissueStudentName] = useState("");
  const [reissueDegreeType, setReissueDegreeType] = useState("");
  const [reissueCertId, setReissueCertId] = useState("");
  const [reissueIssueDate, setReissueIssueDate] = useState("");
  const [reissueMsg, setReissueMsg] = useState<string | null>(null);
  const [reissueErr, setReissueErr] = useState<string | null>(null);
  const [reissueBusy, setReissueBusy] = useState(false);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [eventsErr, setEventsErr] = useState<string | null>(null);
  const [eventsBusy, setEventsBusy] = useState(false);

  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null);
  const [batchSummary, setBatchSummary] = useState<{
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    status: string;
  } | null>(null);
  const [invalidPreview, setInvalidPreview] = useState<BatchRow[]>([]);
  const [queueRows, setQueueRows] = useState<BatchRow[]>([]);
  const [batchMintBusy, setBatchMintBusy] = useState(false);
  const [batchMintErr, setBatchMintErr] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    setLoadErr(null);
    try {
      const data = await apiJson<Me>("/api/university/me");
      setMe(data);
      setProfileContactEmail(data.institution_contact_email || "");
      setProfileContactPhone(data.institution_contact_phone || "");
      setProfileWebsite(data.institution_website || "");
      setProfileLicenseId(data.institution_license_id || "");
      setProfileLicenseAuthority(data.institution_license_authority || "");
      setProfileLicenseValidUntil(data.institution_license_valid_until || "");
    } catch (caught: unknown) {
      setMe(null);
      setLoadErr(caught instanceof Error ? caught.message : "Failed to load profile");
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const canUseChain = useMemo(() => {
    if (!me || me.status !== "verified" || !walletAddress) return false;
    return walletAddress.toLowerCase() === me.wallet_address.toLowerCase();
  }, [me, walletAddress]);

  function friendlyWalletError(caught: unknown): string {
    const raw = caught instanceof Error ? caught.message : String(caught ?? "Wallet transaction failed");
    const lower = raw.toLowerCase();
    if (lower.includes("rate limited") || lower.includes("too many requests")) {
      return (
        "Wallet RPC is rate-limited on Polygon Amoy. In MetaMask, open Polygon Amoy network settings " +
        "and switch RPC URL to https://polygon-amoy-bor-rpc.publicnode.com, then retry."
      );
    }
    return raw;
  }

  async function ensureAmoyNetwork(ethereum: Eip1193Provider, chainId: number) {
    const chainHex = `0x${chainId.toString(16)}`;
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
      return;
    } catch {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: "Polygon Amoy",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: [
              "https://polygon-amoy-bor-rpc.publicnode.com",
              "https://rpc-amoy.polygon.technology",
            ],
            blockExplorerUrls: ["https://amoy.polygonscan.com"],
          },
        ],
      });
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    }
  }

  async function getSignerContract(): Promise<{ contract: Contract; provider: BrowserProvider }> {
    if (!me?.contract_address) {
      throw new Error("Contract address is not configured on backend.");
    }
    const ethereum = (window as { ethereum?: Eip1193Provider }).ethereum;
    if (!ethereum) {
      throw new Error("No injected wallet (window.ethereum). Install MetaMask or a compatible wallet.");
    }
    await ethereum.request({ method: "eth_requestAccounts" });
    await ensureAmoyNetwork(ethereum, me.chain_id);
    const provider = new BrowserProvider(ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== me.chain_id) {
      throw new Error(
        `Wrong network (chainId ${network.chainId}). Switch the wallet to Polygon Amoy (chain ${me.chain_id}).`
      );
    }
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    setWalletAddress(address);
    if (address.toLowerCase() !== me.wallet_address.toLowerCase()) {
      throw new Error(
        "Connected wallet does not match your approved issuer address. Connect the wallet you registered as issuer."
      );
    }
    return { contract: new Contract(me.contract_address, TRUCERT_ABI, signer), provider };
  }

  async function amoyFeeOverrides(provider: BrowserProvider): Promise<{
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
  }> {
    const minTip = parseUnits("30", "gwei");
    const feeData = await provider.getFeeData();
    const block = await provider.getBlock("latest");
    const suggestedPriority = feeData.maxPriorityFeePerGas ?? 0n;
    const priority = suggestedPriority > minTip ? suggestedPriority : minTip;
    const baseFee = block?.baseFeePerGas ?? parseUnits("30", "gwei");
    return {
      maxPriorityFeePerGas: priority,
      maxFeePerGas: baseFee * 2n + priority,
    };
  }

  async function connectWallet() {
    setWalletErr(null);
    try {
      await getSignerContract();
    } catch (caught: unknown) {
      setWalletErr(friendlyWalletError(caught));
    }
  }

  async function refreshActivity() {
    setEventsErr(null);
    setEventsBusy(true);
    try {
      const data = await apiJson<{ events: ActivityEvent[] }>("/api/university/activity/basic?limit=120");
      setEvents(data.events);
    } catch (caught: unknown) {
      setEventsErr(caught instanceof Error ? caught.message : "Failed to load activity");
    } finally {
      setEventsBusy(false);
    }
  }

  async function syncAndRefreshActivity() {
    setEventsErr(null);
    try {
      await apiJson<{ synced_events: number; latest_block: number }>("/api/university/activity/sync", {
        method: "POST",
      });
    } catch {
      // best-effort; basic endpoint is the primary source for UI
    }
    await refreshActivity();
  }

  async function refreshInvalidPreview(bid?: number | null) {
    const id = bid ?? activeBatchId;
    if (!id) return;
    try {
      const data = await apiJson<{ rows: BatchRow[] }>(
        `/api/university/mint-batches/${id}/rows?status=invalid&limit=100`
      );
      setInvalidPreview(data.rows);
    } catch {
      setInvalidPreview([]);
    }
  }

  async function refreshQueueRows(bid?: number | null) {
    const id = bid ?? activeBatchId;
    if (!id) {
      setQueueRows([]);
      return;
    }
    try {
      const data = await apiJson<{ rows: BatchRow[] }>(
        `/api/university/mint-batches/${id}/rows?limit=500`
      );
      setQueueRows(data.rows);
    } catch {
      setQueueRows([]);
    }
  }

  async function refreshBatchMeta(bid?: number | null) {
    const id = bid ?? activeBatchId;
    if (!id) return;
    try {
      const b = await apiJson<{
        total_rows: number;
        valid_rows: number;
        invalid_rows: number;
        status: string;
      }>(`/api/university/mint-batches/${id}`);
      setBatchSummary({
        total_rows: b.total_rows,
        valid_rows: b.valid_rows,
        invalid_rows: b.invalid_rows,
        status: b.status,
      });
    } catch {
      /* ignore */
    }
  }

  async function uploadMintBatch() {
    setBatchErr(null);
    setBatchMsg(null);
    if (!batchFile) {
      setBatchErr("Choose a UTF-8 CSV file.");
      return;
    }
    setBatchBusy(true);
    try {
      const token = getStoredToken();
      const fd = new FormData();
      fd.append("file", batchFile);
      const res = await fetch(`${API_BASE}/api/university/mint-batches`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as {
        batch_id?: number;
        summary?: { total_rows: number; valid_rows: number; invalid_rows: number; status: string };
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "Upload failed");
      const bid = body.batch_id ?? null;
      setActiveBatchId(bid);
      setBatchSummary(body.summary ?? null);
      setBatchMsg(`Batch #${body.batch_id} uploaded.`);
      setBatchFile(null);
      if (bid != null) {
        await refreshInvalidPreview(bid);
        await refreshQueueRows(bid);
        await refreshBatchMeta(bid);
      }
    } catch (caught: unknown) {
      setBatchErr(caught instanceof Error ? caught.message : "Batch upload failed");
    } finally {
      setBatchBusy(false);
    }
  }

  function nextRowToMint(rows: BatchRow[]): BatchRow | null {
    const ok = new Set(["pending_validation", "prepared", "mint_failed"]);
    const cand = rows.filter((r) => ok.has(r.row_status)).sort((a, b) => a.row_index - b.row_index);
    return cand[0] ?? null;
  }

  async function mintNextBatchRow() {
    setBatchMintErr(null);
    setBatchMsg(null);
    if (!activeBatchId || !queueRows.length) {
      setBatchMintErr("Upload a batch first.");
      return;
    }
    const next = nextRowToMint(queueRows);
    if (!next) {
      setBatchMsg("Nothing left to mint in this batch (all valid rows minted or blocked).");
      return;
    }
    setBatchMintBusy(true);
    try {
      const prepared = await apiJson<PreparedMint>(
        `/api/university/mint-batches/${activeBatchId}/rows/${next.id}/prepare`,
        { method: "POST" }
      );
      const { contract, provider } = await getSignerContract();
      const tx = await contract.mintToEscrow(
        prepared.metadata_uri,
        prepared.core_hash,
        prepared.cert_id,
        await amoyFeeOverrides(provider)
      );
      const receipt = await tx.wait();
      if (!receipt) throw new Error("No transaction receipt");
      let tokenId: number | null = null;
      const addr = (me?.contract_address || "").toLowerCase();
      for (const lg of receipt.logs) {
        if (lg.address.toLowerCase() !== addr) continue;
        try {
          const ev = contract.interface.parseLog({ topics: [...lg.topics], data: lg.data });
          if (ev?.name === "CertificateMinted") {
            tokenId = Number(ev.args.tokenId);
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (tokenId == null && prepared.next_token_id_hint != null) {
        tokenId = prepared.next_token_id_hint;
      }
      if (tokenId == null) throw new Error("Could not determine token ID from receipt");
      await apiJson<{ message: string }>(
        `/api/university/mint-batches/${activeBatchId}/rows/${next.id}/confirm-mint`,
        {
          method: "POST",
          json: { tx_hash: receipt.hash, token_id: tokenId },
        }
      );
      setBatchMsg(`Minted row ${next.row_index + 1} as token ${tokenId}. Tx: ${receipt.hash}`);
      await refreshQueueRows();
      await refreshInvalidPreview();
      await refreshBatchMeta();
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setBatchMintErr(friendlyWalletError(caught));
    } finally {
      setBatchMintBusy(false);
    }
  }

  async function downloadBatchErrorCsv() {
    if (!activeBatchId) return;
    const token = getStoredToken();
    const res = await fetch(`${API_BASE}/api/university/mint-batches/${activeBatchId}/export-errors`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      setBatchErr("Could not download error report.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `batch-${activeBatchId}-errors.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    if (me?.status === "verified") {
      void syncAndRefreshActivity();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.status]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setMintErr(null);
    setMintMsg(null);
    setMintBusy(true);
    try {
      const prepared = await apiJson<PreparedMint>(
        "/api/university/certificates/prepare-mint",
        {
          method: "POST",
          json: {
            student_name: studentName,
            degree_type: degreeType,
            cert_id: certId,
            issue_date: issueDate,
          },
        }
      );
      const { contract, provider } = await getSignerContract();
      const tx = await contract.mintToEscrow(
        prepared.metadata_uri,
        prepared.core_hash,
        prepared.cert_id,
        await amoyFeeOverrides(provider)
      );
      const receipt = await tx.wait();
      setMintMsg(`Minted on-chain. Tx: ${receipt.hash}`);
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setMintErr(friendlyWalletError(caught));
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
      if (!isAddress(studentWallet.trim())) {
        throw new Error("Student wallet must be a valid 0x address.");
      }
      const { contract, provider } = await getSignerContract();
      const tx = await contract.claim(tid, studentWallet.trim(), await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setClaimMsg(`Claimed. Tx: ${receipt.hash}`);
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setClaimErr(friendlyWalletError(caught));
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
      const { contract, provider } = await getSignerContract();
      const tx = await contract.revokeCertificate(tid, await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setRevokeMsg(`Revoked. Tx: ${receipt.hash}`);
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setRevokeErr(friendlyWalletError(caught));
    } finally {
      setRevokeBusy(false);
    }
  }

  async function burn(e: React.FormEvent) {
    e.preventDefault();
    setBurnErr(null);
    setBurnMsg(null);
    const tid = Number(burnTid);
    if (!Number.isInteger(tid) || tid < 0) {
      setBurnErr("Token ID must be a non-negative integer.");
      return;
    }
    setBurnBusy(true);
    try {
      const { contract, provider } = await getSignerContract();
      const tx = await contract.burnCertificate(tid, await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setBurnMsg(`Burned. Tx: ${receipt.hash}`);
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setBurnErr(friendlyWalletError(caught));
    } finally {
      setBurnBusy(false);
    }
  }

  async function reissue(e: React.FormEvent) {
    e.preventDefault();
    setReissueErr(null);
    setReissueMsg(null);
    const oldTokenId = Number(reissueOldTid);
    if (!Number.isInteger(oldTokenId) || oldTokenId < 0) {
      setReissueErr("Old token ID must be a non-negative integer.");
      return;
    }
    setReissueBusy(true);
    try {
      const prepared = await apiJson<PreparedMint>(
        `/api/university/certificates/prepare-reissue/${oldTokenId}`,
        {
          method: "POST",
          json: {
            student_name: reissueStudentName,
            degree_type: reissueDegreeType,
            cert_id: reissueCertId,
            issue_date: reissueIssueDate,
          },
        }
      );
      const { contract, provider } = await getSignerContract();
      const tx = await contract.revokeAndReissue(
        oldTokenId,
        prepared.metadata_uri,
        prepared.core_hash,
        prepared.cert_id,
        await amoyFeeOverrides(provider)
      );
      const receipt = await tx.wait();
      setReissueMsg(`Reissued. Tx: ${receipt.hash}`);
      await syncAndRefreshActivity();
    } catch (caught: unknown) {
      setReissueErr(friendlyWalletError(caught));
    } finally {
      setReissueBusy(false);
    }
  }

  const verified = me?.status === "verified";

  async function saveInstitutionProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileErr(null);
    setProfileMsg(null);
    setProfileBusy(true);
    try {
      await apiJson<{ message: string }>("/api/university/profile", {
        method: "PUT",
        json: {
          institution_contact_email: profileContactEmail,
          institution_contact_phone: profileContactPhone,
          institution_website: profileWebsite,
          institution_license_id: profileLicenseId,
          institution_license_authority: profileLicenseAuthority,
          institution_license_valid_until: profileLicenseValidUntil,
        },
      });
      setProfileMsg("Institution profile updated.");
      await loadMe();
    } catch (caught: unknown) {
      setProfileErr(caught instanceof Error ? caught.message : "Profile update failed");
    } finally {
      setProfileBusy(false);
    }
  }

  async function uploadLogo() {
    setLogoErr(null);
    setLogoMsg(null);
    if (!logoFile) {
      setLogoErr("Choose an image file first.");
      return;
    }
    if (!logoFile.type.startsWith("image/")) {
      setLogoErr("Logo must be an image file.");
      return;
    }
    if (logoFile.size > 2 * 1024 * 1024) {
      setLogoErr("Logo exceeds 2MB limit.");
      return;
    }
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", logoFile);
      const token = localStorage.getItem("trucert_token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_BASE}/api/university/logo`, { method: "POST", headers, body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(body.error || "Logo upload failed");
      setLogoMsg(body.message || "Logo uploaded.");
      setLogoFile(null);
      await loadMe();
    } catch (caught: unknown) {
      setLogoErr(caught instanceof Error ? caught.message : "Logo upload failed");
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <>
      <header>
        <h1>University portal</h1>
        <p>
          Mint, claim, revoke, burn, and reissue using your approved issuer wallet only. Connect
          MetaMask (or any injected wallet) on Polygon Amoy — private keys are never entered or sent
          to this app.
        </p>
      </header>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="subhead" style={{ margin: 0 }}>Profile</h2>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowProfileEditor((v) => !v)}
            disabled={!verified}
          >
            {showProfileEditor ? "Hide details editor" : "Edit institution details"}
          </button>
        </div>
        {loadErr && <div className="error">{loadErr}</div>}
        {me && (
          <div className="grid profile-summary">
            <div className="kv">
              <span>Institution</span>
              <span className="institution-identity">
                {me.logo_url ? (
                  <img src={me.logo_url} alt="Institution logo" className="institution-avatar" />
                ) : (
                  <span className="institution-avatar-placeholder" aria-hidden>
                    {me.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <span>{me.name}</span>
              </span>
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
              <span>Approved issuer wallet</span>
              <span className="mono small">{me.wallet_address}</span>
            </div>
            <div className="kv">
              <span>Contract</span>
              <span className="mono small">{me.contract_address}</span>
            </div>
            <div className="kv">
              <span>Expected chain</span>
              <span>Amoy ({me.chain_id})</span>
            </div>
            <div className="kv">
              <span>Contact email</span>
              <span>{me.institution_contact_email || "—"}</span>
            </div>
            <div className="kv">
              <span>Contact phone</span>
              <span>{me.institution_contact_phone || "—"}</span>
            </div>
            <div className="kv">
              <span>Website</span>
              <span>{me.institution_website || "—"}</span>
            </div>
            <div className="kv">
              <span>License ID</span>
              <span>{me.institution_license_id || "—"}</span>
            </div>
            <div className="kv">
              <span>License authority</span>
              <span>{me.institution_license_authority || "—"}</span>
            </div>
            <div className="kv">
              <span>License valid until</span>
              <span>{me.institution_license_valid_until || "—"}</span>
            </div>
          </div>
        )}
        {!verified && me && (
          <p className="warn-banner">
            Your institution is not verified yet. Minting and claiming are blocked until an admin
            approves your registration.
          </p>
        )}
        <div className="stack" style={{ marginTop: "0.85rem" }}>
          <p className="muted-inline" style={{ marginTop: 0 }}>
            Use the same wallet address you submitted at registration. Claim is signed by the issuer
            (you); only the student address is passed as the recipient.
          </p>
          <div className="row">
            <button type="button" onClick={() => void connectWallet()} disabled={!verified}>
              Connect issuer wallet
            </button>
            <span className="muted-inline">
              Connected: <span className="mono small">{walletAddress || "not connected"}</span>
            </span>
          </div>
        </div>
        {!canUseChain && verified && (
          <p className="warn-banner">
            Chain actions are blocked until MetaMask is on Polygon Amoy and the connected account
            matches your approved issuer wallet.
          </p>
        )}
        {walletErr && <div className="error">{walletErr}</div>}
        {showProfileEditor && (
          <>
            <p className="muted-inline">
              These fields are stored on your university profile and automatically included in
              mint/reissue metadata.
            </p>
            <form className="stack" onSubmit={saveInstitutionProfile}>
              <div>
                <label htmlFor="logo_file">Institution logo (png/jpeg/webp/gif, max 2MB)</label>
                <input
                  id="logo_file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
                  disabled={!verified}
                />
                <div className="row" style={{ marginTop: "0.45rem" }}>
                  <button type="button" onClick={() => void uploadLogo()} disabled={!verified || logoBusy}>
                    {logoBusy ? "Uploading…" : "Upload logo"}
                  </button>
                  {logoMsg && <span className="muted-inline">{logoMsg}</span>}
                </div>
                {logoErr && <div className="error">{logoErr}</div>}
              </div>
              <div className="row two-col">
                <div>
                  <label htmlFor="profile_email">Institution contact email</label>
                  <input
                    id="profile_email"
                    type="email"
                    value={profileContactEmail}
                    onChange={(e) => setProfileContactEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="profile_phone">Institution contact phone</label>
                  <input
                    id="profile_phone"
                    value={profileContactPhone}
                    onChange={(e) => setProfileContactPhone(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="row two-col">
                <div>
                  <label htmlFor="profile_web">Institution website</label>
                  <input
                    id="profile_web"
                    value={profileWebsite}
                    onChange={(e) => setProfileWebsite(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="profile_lic_id">Institution license ID</label>
                  <input
                    id="profile_lic_id"
                    value={profileLicenseId}
                    onChange={(e) => setProfileLicenseId(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="row two-col">
                <div>
                  <label htmlFor="profile_lic_auth">Institution license authority</label>
                  <input
                    id="profile_lic_auth"
                    value={profileLicenseAuthority}
                    onChange={(e) => setProfileLicenseAuthority(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="profile_lic_valid">License valid until</label>
                  <input
                    id="profile_lic_valid"
                    type="date"
                    value={profileLicenseValidUntil}
                    onChange={(e) => setProfileLicenseValidUntil(e.target.value)}
                    required
                  />
                </div>
              </div>
              {profileErr && <div className="error">{profileErr}</div>}
              {profileMsg && <div className="success">{profileMsg}</div>}
              <button type="submit" disabled={profileBusy || !verified}>
                {profileBusy ? "Saving…" : "Save institution details"}
              </button>
            </form>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="subhead">Mint certificate (escrow)</h2>
        <p className="muted-inline">
          Backend pins metadata (JWT); your wallet signs <code>mintToEscrow</code> with the returned{" "}
          <code>metadata_uri</code>, <code>core_hash</code>, and <code>cert_id</code>.
        </p>
        <form className="stack" onSubmit={mint}>
          <div className="row two-col">
            <div>
              <label htmlFor="cert_id">Certificate ID (global unique)</label>
              <input id="cert_id" value={certId} onChange={(e) => setCertId(e.target.value)} required />
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
            <label htmlFor="student_name">Student name</label>
            <input
              id="student_name"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="degree">Degree type</label>
            <input
              id="degree"
              value={degreeType}
              onChange={(e) => setDegreeType(e.target.value)}
              required
            />
          </div>
          {mintErr && <div className="error">{mintErr}</div>}
          {mintMsg && <div className="success">{mintMsg}</div>}
          <button type="submit" disabled={mintBusy || !verified || !canUseChain}>
            {mintBusy ? "Minting…" : "Mint to escrow"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Batch mint (CSV)</h2>
        <p className="muted-inline small">
          UTF-8 CSV with headers:{" "}
          <code>
            cert_id,student_internal_id,student_email,student_full_name,degree_title,issue_date
          </code>
          . Optional: <code>image_ipfs_uri</code>. Max 500 rows. Student email and internal ID are stored
          only in the database — they are never pinned to IPFS.
        </p>
        <div className="stack" style={{ marginTop: "0.65rem" }}>
          <div>
            <label htmlFor="batch_csv">CSV file</label>
            <input
              id="batch_csv"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setBatchFile(e.target.files?.[0] || null)}
              disabled={!verified || batchBusy}
            />
          </div>
          <div className="row">
            <button type="button" onClick={() => void uploadMintBatch()} disabled={!verified || batchBusy}>
              {batchBusy ? "Uploading…" : "Upload & validate batch"}
            </button>
            {activeBatchId != null && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void refreshQueueRows()}
                disabled={!verified || batchBusy}
              >
                Refresh rows
              </button>
            )}
          </div>
          {batchSummary && (
            <p className="muted-inline" style={{ marginTop: 0 }}>
              Batch #{activeBatchId}: status <strong>{batchSummary.status}</strong> — total{" "}
              {batchSummary.total_rows}, valid {batchSummary.valid_rows}, invalid {batchSummary.invalid_rows}
            </p>
          )}
          {batchErr && <div className="error">{batchErr}</div>}
          {batchMsg && <div className="success">{batchMsg}</div>}
        </div>
        {invalidPreview.length > 0 && (
          <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
            <p className="muted-inline small">Invalid rows (sample)</p>
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>cert_id</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {invalidPreview.map((r) => (
                  <tr key={r.id}>
                    <td>{r.row_index + 1}</td>
                    <td className="mono small">{r.cert_id || "—"}</td>
                    <td className="mono small">
                      {Array.isArray(r.validation_errors)
                        ? r.validation_errors.join("; ")
                        : String(r.validation_errors ?? "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="stack" style={{ marginTop: "1rem" }}>
          <p className="muted-inline small" style={{ marginTop: 0 }}>
            Mint one row at a time: prepare on server → MetaMask signs <code>mintToEscrow</code> → confirm on
            server. Only one row may be in <code>prepared</code> state at a time.
          </p>
          {batchSummary && batchSummary.valid_rows > 0 && (
            <p className="muted-inline small">
              Progress:{" "}
              {
                queueRows.filter((r) =>
                  ["mint_confirmed", "email_sent", "email_failed"].includes(r.row_status)
                ).length
              }{" "}
              / {batchSummary.valid_rows} valid rows minted
            </p>
          )}
          {batchMintErr && <div className="error">{batchMintErr}</div>}
          <div className="row">
            <button
              type="button"
              onClick={() => void mintNextBatchRow()}
              disabled={!verified || !canUseChain || batchMintBusy || activeBatchId == null}
            >
              {batchMintBusy ? "Minting…" : "Mint next in batch"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void downloadBatchErrorCsv()}
              disabled={!verified || activeBatchId == null}
            >
              Download error report (CSV)
            </button>
          </div>
          {queueRows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>cert_id</th>
                    <th>Student</th>
                    <th>Status</th>
                    <th>Token</th>
                  </tr>
                </thead>
                <tbody>
                  {queueRows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.row_index + 1}</td>
                      <td className="mono small">{r.cert_id || "—"}</td>
                      <td>{r.student_full_name || "—"}</td>
                      <td>
                        <span className={`status ${r.row_status}`}>{r.row_status}</span>
                      </td>
                      <td className="mono small">{r.token_id ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <h2 className="subhead">Claim (transfer to student &amp; lock)</h2>
        <p className="muted-inline">
          You must be connected as the issuer; the student address is only the recipient parameter.
        </p>
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
          <button type="submit" disabled={claimBusy || !verified || !canUseChain}>
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
          <button
            type="submit"
            className="btn-secondary"
            disabled={revokeBusy || !verified || !canUseChain}
          >
            {revokeBusy ? "Revoking…" : "Revoke on-chain"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Burn revoked certificate</h2>
        <form className="stack" onSubmit={burn}>
          <div>
            <label htmlFor="burn_tid">Token ID</label>
            <input
              id="burn_tid"
              value={burnTid}
              onChange={(e) => setBurnTid(e.target.value)}
              required
            />
          </div>
          {burnErr && <div className="error">{burnErr}</div>}
          {burnMsg && <div className="success">{burnMsg}</div>}
          <button type="submit" className="btn-secondary" disabled={burnBusy || !verified || !canUseChain}>
            {burnBusy ? "Burning…" : "Burn token"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Reissue certificate (revoke + new token)</h2>
        <form className="stack" onSubmit={reissue}>
          <div className="row two-col">
            <div>
              <label htmlFor="reissue_old">Old token ID</label>
              <input
                id="reissue_old"
                value={reissueOldTid}
                onChange={(e) => setReissueOldTid(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="reissue_cert_id">New cert ID</label>
              <input
                id="reissue_cert_id"
                value={reissueCertId}
                onChange={(e) => setReissueCertId(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="row two-col">
            <div>
              <label htmlFor="reissue_student">Student name</label>
              <input
                id="reissue_student"
                value={reissueStudentName}
                onChange={(e) => setReissueStudentName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="reissue_degree">Degree type</label>
              <input
                id="reissue_degree"
                value={reissueDegreeType}
                onChange={(e) => setReissueDegreeType(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="reissue_date">Issue date</label>
            <input
              id="reissue_date"
              value={reissueIssueDate}
              onChange={(e) => setReissueIssueDate(e.target.value)}
              placeholder="e.g. 2026-04-10"
              required
            />
          </div>
          {reissueErr && <div className="error">{reissueErr}</div>}
          {reissueMsg && <div className="success">{reissueMsg}</div>}
          <button type="submit" disabled={reissueBusy || !verified || !canUseChain}>
            {reissueBusy ? "Reissuing…" : "Revoke and reissue"}
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="subhead">Activity log</h2>
        <div className="row">
          <button type="button" onClick={() => void syncAndRefreshActivity()} disabled={eventsBusy || !verified}>
            {eventsBusy ? "Refreshing…" : "Sync and refresh"}
          </button>
        </div>
        {eventsErr && <div className="error">{eventsErr}</div>}
        {!eventsErr && events.length === 0 && <p className="muted-inline">No activity yet.</p>}
        {events.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Token</th>
                  <th>Time</th>
                  <th>Transaction</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={`${ev.token_id ?? "x"}-${ev.created_at ?? ""}-${ev.action}-${i}`}>
                    <td>{ACTION_LABELS[ev.action] || ev.action}</td>
                    <td>{ev.token_id ?? "—"}</td>
                    <td>{ev.created_at ? new Date(ev.created_at).toLocaleString() : "—"}</td>
                    <td className="mono small">
                      {ev.tx_hash ? (
                        <a
                          href={`https://amoy.polygonscan.com/tx/${ev.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          title={ev.tx_hash}
                        >
                          {`${ev.tx_hash.slice(0, 10)}...${ev.tx_hash.slice(-8)}`}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono small">{JSON.stringify(ev.details || {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
