import { Link, useSearchParams } from "react-router-dom";
import { BrowserProvider, Contract, isAddress, parseUnits, type Signer } from "ethers";
import { BatchMintProgressStepper } from "../components/BatchMintProgressStepper";
import { BrandedLoader } from "../components/BrandedLoader";
import { BusyLabel } from "../components/LoadingSpinner";
import type { Eip1193Provider } from "ethers";
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, ApiHttpError, apiFormData, apiJson, getStoredToken } from "../api/client";
import { TRUCERT_ABI } from "../abi/trucertAbi";
import {
  InstitutionBottomNav,
  institutionPortalHref,
  type InstitutionNavKey,
} from "../components/InstitutionBottomNav";
import { institutionLogoDisplayUrl } from "../utils/institutionLogo";
import {
  getInjectedProvider,
  INJECTED_WALLET_SYNC_EVENT,
  readIssuerReadyAddress,
} from "../utils/browserWallet";
import { TablePagination } from "../components/TablePagination";
import { usePagination } from "../hooks/usePagination";
import {
  Tag,
  CalendarDays,
  User,
  UploadCloud,
  GraduationCap,
  Mail,
  Phone,
  Globe,
  BadgeCheck,
  Wallet,
  ShieldCheck,
  Sparkles,
  Hash,
} from "lucide-react";

type Me = {
  name: string;
  internal_id: string;
  status: string;
  is_frozen?: boolean;
  frozen_reason?: string | null;
  frozen_at?: string | null;
  wallet_address: string;
  contract_address: string;
  chain_id: number;
  eip712_nonce?: number;
  eip712_domain?: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  } | null;
  logo_uri?: string | null;
  logo_url?: string | null;
  institution_contact_email?: string | null;
  institution_contact_phone?: string | null;
  institution_website?: string | null;
  institution_license_id?: string | null;
  institution_license_authority?: string | null;
  institution_license_valid_until?: string | null;
  expected_mints_monthly?: number | null;
  expected_mints_annually?: number | null;
  operating_days_of_week?: number[];
  operating_hours_start?: string | null;
  operating_hours_end?: string | null;
  operating_timezone?: string | null;
  institution_documents?: Array<{
    label: string;
    filename: string;
    uri: string;
    url: string;
    mime?: string;
    uploaded_at?: string;
  }>;
};

type PreparedMint = {
  metadata_uri: string;
  core_hash: string;
  cert_id: string;
  next_token_id_hint?: number;
  idempotent?: boolean;
  mint_request_id?: string;
  eip712?: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
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
  prepare_to_mint_ms?: number | null;
  platform_mint_ms?: number | null;
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

type StudentClaimReqRow = {
  id: number;
  token_id: number;
  cert_id: string | null;
  student_internal_id: string;
  student_email: string;
  wallet_address: string;
  status: string;
  rejection_reason: string | null;
  created_at: string | null;
  student_full_name: string | null;
  degree_title: string | null;
  claim_tx_hash: string | null;
};

const AMOY_PUBLIC_RPC = "https://polygon-amoy-bor-rpc.publicnode.com";

const ACTION_LABELS: Record<string, string> = {
  issued: "issued",
  transferred: "transferred",
  revoked: "revoked",
  burned: "burned",
  reissued: "reissued",
};

/** Modes allowed in `?mode=` on `/university` (risk dashboard: `/university/risk`, not in bottom nav). */
const URL_MODE_KEYS = new Set<InstitutionNavKey>(["mint", "batch", "actions", "request", "wallet", "settings"]);

const SETTINGS_WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
];

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${(s / 60).toFixed(1)} min`;
}

function modeFromSearch(raw: string | null): InstitutionNavKey | null {
  if (!raw) return null;
  if (raw === "audit") return "actions";
  return URL_MODE_KEYS.has(raw as InstitutionNavKey) ? (raw as InstitutionNavKey) : null;
}

export function UniversityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setModeState] = useState<InstitutionNavKey>(() => {
    const initial =
      typeof window !== "undefined"
        ? modeFromSearch(new URLSearchParams(window.location.search).get("mode"))
        : null;
    return initial ?? "mint";
  });
  const [me, setMe] = useState<Me | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [logoMsg, setLogoMsg] = useState<string | null>(null);

  const [studentName, setStudentName] = useState("");
  const [studentInternalId, setStudentInternalId] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
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
  const [opMonthly, setOpMonthly] = useState("");
  const [opAnnual, setOpAnnual] = useState("");
  const [opDays, setOpDays] = useState<Set<number>>(() => new Set());
  const [opStart, setOpStart] = useState("");
  const [opEnd, setOpEnd] = useState("");
  const [opTz, setOpTz] = useState("");
  const [opBusy, setOpBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);
  const [opMsg, setOpMsg] = useState<string | null>(null);
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [docUploadLabel, setDocUploadLabel] = useState("Accreditation");
  const [docBusy, setDocBusy] = useState(false);
  const [docErr, setDocErr] = useState<string | null>(null);
  const [docMsg, setDocMsg] = useState<string | null>(null);
  const [mintMsg, setMintMsg] = useState<string | null>(null);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [mintBusy, setMintBusy] = useState(false);

  const [claimTid, setClaimTid] = useState("");
  const [studentWallet, setStudentWallet] = useState("");
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);

  const [studentClaimReqs, setStudentClaimReqs] = useState<StudentClaimReqRow[]>([]);
  const [studentClaimReqBusy, setStudentClaimReqBusy] = useState(false);
  const [studentClaimReqErr, setStudentClaimReqErr] = useState<string | null>(null);

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
  const [rpcCopied, setRpcCopied] = useState(false);

  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchDropzoneKey, setBatchDropzoneKey] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchMsg, setBatchMsg] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null);
  const [batchSummary, setBatchSummary] = useState<{
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    status: string;
    timing?: { last_execute_chunk_wall_ms: number | null; cumulative_execute_wall_ms: number | null };
  } | null>(null);
  const [invalidPreview, setInvalidPreview] = useState<BatchRow[]>([]);
  const [queueRows, setQueueRows] = useState<BatchRow[]>([]);
  const [batchMintErr, setBatchMintErr] = useState<string | null>(null);
  const [batchSignBusy, setBatchSignBusy] = useState(false);
  const [batchExecBusy, setBatchExecBusy] = useState(false);
  const [batchPrepAllBusy, setBatchPrepAllBusy] = useState(false);

  const [batchAiRowId, setBatchAiRowId] = useState<number | null>(null);
  const [batchAiQuestion, setBatchAiQuestion] = useState("");
  const [batchAiBusy, setBatchAiBusy] = useState(false);
  const [batchAiErr, setBatchAiErr] = useState<string | null>(null);
  const [batchAiText, setBatchAiText] = useState<string | null>(null);
  const [batchAiModel, setBatchAiModel] = useState<string | null>(null);

  const invalidPg = usePagination(invalidPreview, 10, `${activeBatchId ?? "none"}-invalid`);
  const queuePg = usePagination(queueRows, 10, `${activeBatchId ?? "none"}-queue`);
  const eventsPg = usePagination(events, 10);

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
      setOpMonthly(data.expected_mints_monthly != null ? String(data.expected_mints_monthly) : "");
      setOpAnnual(data.expected_mints_annually != null ? String(data.expected_mints_annually) : "");
      setOpDays(new Set(Array.isArray(data.operating_days_of_week) ? data.operating_days_of_week : []));
      setOpStart(data.operating_hours_start || "");
      setOpEnd(data.operating_hours_end || "");
      setOpTz(data.operating_timezone || "");
    } catch (caught: unknown) {
      setMe(null);
      setLoadErr(caught instanceof Error ? caught.message : "Failed to load profile");
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const syncIssuerWalletFromInjected = useCallback(async () => {
    if (!me || me.status !== "verified") {
      setWalletAddress(null);
      return;
    }
    const addr = await readIssuerReadyAddress(me);
    setWalletAddress(addr);
  }, [me]);

  useEffect(() => {
    void syncIssuerWalletFromInjected();
  }, [syncIssuerWalletFromInjected]);

  useEffect(() => {
    const eth = getInjectedProvider();
    if (!eth?.on || !eth.removeListener) return;
    const bump = () => void syncIssuerWalletFromInjected();
    eth.on("accountsChanged", bump);
    eth.on("chainChanged", bump);
    return () => {
      eth.removeListener!("accountsChanged", bump);
      eth.removeListener!("chainChanged", bump);
    };
  }, [syncIssuerWalletFromInjected]);

  useEffect(() => {
    const bump = () => void syncIssuerWalletFromInjected();
    window.addEventListener(INJECTED_WALLET_SYNC_EVENT, bump);
    return () => window.removeEventListener(INJECTED_WALLET_SYNC_EVENT, bump);
  }, [syncIssuerWalletFromInjected]);

  useEffect(() => {
    const m = modeFromSearch(searchParams.get("mode"));
    setModeState(m ?? "mint");
  }, [searchParams]);

  useEffect(() => {
    const ct = searchParams.get("claimToken");
    const cw = searchParams.get("claimWallet");
    if (ct?.trim() && cw?.trim()) {
      setClaimTid(ct.trim());
      setStudentWallet(decodeURIComponent(cw.trim()));
    }
  }, [searchParams]);

  const loadStudentClaimRequests = useCallback(async () => {
    const tok = getStoredToken();
    if (!tok) return;
    setStudentClaimReqBusy(true);
    setStudentClaimReqErr(null);
    try {
      const data = await apiJson<{ requests: StudentClaimReqRow[] }>("/api/university/student-claim-requests");
      setStudentClaimReqs(data.requests || []);
    } catch (caught: unknown) {
      setStudentClaimReqErr(caught instanceof Error ? caught.message : "Failed to load student claim requests");
      setStudentClaimReqs([]);
    } finally {
      setStudentClaimReqBusy(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "request") return;
    void loadStudentClaimRequests();
  }, [mode, loadStudentClaimRequests]);

  const setMode = useCallback(
    (next: InstitutionNavKey) => {
      setModeState(next);
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === "mint") p.delete("mode");
          else p.set("mode", next);
          return p;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const canUseChain = useMemo(() => {
    if (!me || me.status !== "verified" || !walletAddress) return false;
    return walletAddress.toLowerCase() === me.wallet_address.toLowerCase();
  }, [me, walletAddress]);

  const accountFrozen = Boolean(me?.is_frozen);

  function walletErrorHaystack(caught: unknown): string {
    const parts: string[] = [];
    const walk = (e: unknown, depth: number) => {
      if (e == null || depth > 6) return;
      if (typeof e === "string") {
        parts.push(e);
        return;
      }
      if (e instanceof Error) {
        parts.push(e.message);
        const x = e as Error & {
          shortMessage?: string;
          reason?: string;
          code?: string;
          info?: { error?: { message?: string } };
        };
        if (x.shortMessage) parts.push(String(x.shortMessage));
        if (x.reason) parts.push(String(x.reason));
        if (x.code) parts.push(String(x.code));
        if (x.info?.error?.message) parts.push(String(x.info.error.message));
        walk((e as Error & { error?: unknown }).error, depth + 1);
      } else if (typeof e === "object") {
        const o = e as Record<string, unknown>;
        for (const k of ["message", "reason", "data"]) {
          if (typeof o[k] === "string") parts.push(o[k] as string);
        }
        if (o.error) walk(o.error, depth + 1);
      }
    };
    walk(caught, 0);
    return parts.join(" ").toLowerCase();
  }

  function friendlyWalletError(caught: unknown): string {
    const raw = caught instanceof Error ? caught.message : String(caught ?? "Wallet transaction failed");
    const hay = `${raw} ${walletErrorHaystack(caught)}`.toLowerCase();
    if (hay.includes("insufficient funds")) {
      return (
        "This wallet does not have enough Amoy POL to pay gas. Send a small amount of test POL from a Polygon Amoy faucet " +
        "(e.g. https://faucet.polygon.technology/ ) to your issuer address, wait for it to confirm, then retry."
      );
    }
    if (hay.includes("rate limited") || hay.includes("too many requests")) {
      return (
        "Wallet RPC is rate-limited on Polygon Amoy. In MetaMask, open Polygon Amoy network settings " +
        "and switch RPC URL to https://polygon-amoy-bor-rpc.publicnode.com, then retry."
      );
    }
    if (
      hay.includes("maxpriorityfeepergas") ||
      hay.includes("maxfeepergas") ||
      hay.includes("eth_maxpriorityfeepergas")
    ) {
      return (
        "Your RPC or wallet rejected EIP-1559 fee fields. In MetaMask → Polygon Amoy → use RPC " +
        "https://polygon-amoy-bor-rpc.publicnode.com (or rpc-amoy.polygon.technology), then retry."
      );
    }
    if (hay.includes("call_exception") && hay.includes("estimategas")) {
      return (
        "Gas estimation failed (no revert data from the RPC). Common causes: issuer wallet has no Amoy POL for gas; " +
        "connected wallet is not the current NFT owner; or the token is already locked. Fund POL from an Amoy faucet, " +
        "confirm token ownership on Polygonscan, then retry."
      );
    }
    if (hay.includes("nonce mismatch")) {
      return (
        "Your EIP-712 signing nonce did not match what the server expected — usually because the authorization " +
        "payload was stale, or (on older servers) a single mint and a batch sign shared one counter. Click " +
        "“Sign batch authorization” or “Generate credential” again with a fresh payload. Use the wallet that " +
        "matches your registered issuer address."
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
            rpcUrls: [AMOY_PUBLIC_RPC, "https://rpc-amoy.polygon.technology"],
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

  function normalizeEip712Message(
    primaryType: string,
    message: Record<string, unknown>
  ): Record<string, string | bigint> {
    if (primaryType === "MintAuthorization") {
      return {
        issuer: String(message.issuer),
        commitment: String(message.commitment),
        nonce: BigInt(String(message.nonce)),
        expiry: BigInt(String(message.expiry)),
      };
    }
    if (primaryType === "BatchMintAuthorization") {
      return {
        issuer: String(message.issuer),
        batchId: BigInt(String(message.batchId)),
        commitment: String(message.commitment),
        nonce: BigInt(String(message.nonce)),
        expiry: BigInt(String(message.expiry)),
      };
    }
    return message as Record<string, string | bigint>;
  }

  async function signEip712Envelope(
    signer: Signer,
    envelope: NonNullable<PreparedMint["eip712"]>
  ): Promise<string> {
    const primary = envelope.primaryType;
    const fields = envelope.types[primary];
    if (!fields) throw new Error(`EIP-712 missing type ${primary}`);
    const types = { [primary]: fields };
    const domain = {
      name: envelope.domain.name,
      version: envelope.domain.version,
      chainId: BigInt(envelope.domain.chainId),
      verifyingContract: envelope.domain.verifyingContract,
    };
    const message = normalizeEip712Message(primary, envelope.message);
    return signer.signTypedData(domain, types, message);
  }

  async function amoyFeeOverrides(
    provider: BrowserProvider
  ): Promise<{ maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } | { gasPrice: bigint }> {
    const minTip = parseUnits("30", "gwei");
    try {
      const feeData = await provider.getFeeData();
      const block = await provider.getBlock("latest");
      const suggestedPriority = feeData.maxPriorityFeePerGas ?? 0n;
      const suggestedMax = feeData.maxFeePerGas ?? 0n;
      if (suggestedMax > 0n && suggestedPriority > 0n) {
        const priority = suggestedPriority > minTip ? suggestedPriority : minTip;
        const baseFee = block?.baseFeePerGas ?? parseUnits("30", "gwei");
        return {
          maxPriorityFeePerGas: priority,
          maxFeePerGas: baseFee * 2n + priority,
        };
      }
    } catch {
      // Some RPCs / wallets do not implement eth_maxPriorityFeePerGas; fall back to legacy gas price.
    }
    try {
      const hex = (await provider.send("eth_gasPrice", [])) as string;
      const gasPrice = BigInt(hex);
      return { gasPrice: gasPrice > minTip ? gasPrice : minTip };
    } catch {
      return { gasPrice: parseUnits("35", "gwei") };
    }
  }

  async function connectWallet() {
    setWalletErr(null);
    try {
      await getSignerContract();
    } catch (caught: unknown) {
      setWalletErr(friendlyWalletError(caught));
    }
  }

  async function copyAmoyRpcUrl() {
    try {
      await navigator.clipboard.writeText(AMOY_PUBLIC_RPC);
      setRpcCopied(true);
      setTimeout(() => setRpcCopied(false), 2000);
    } catch {
      setWalletErr("Could not copy to clipboard. Copy the RPC URL from the hint below manually.");
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
      setBatchErr("Could not refresh batch rows. Check backend is running and you are logged in.");
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
        timing?: { last_execute_chunk_wall_ms: number | null; cumulative_execute_wall_ms: number | null };
      }>(`/api/university/mint-batches/${id}`);
      setBatchSummary({
        total_rows: b.total_rows,
        valid_rows: b.valid_rows,
        invalid_rows: b.invalid_rows,
        status: b.status,
        timing: b.timing,
      });
    } catch {
      setBatchErr("Could not refresh batch summary. Check backend is reachable.");
    }
  }

  async function uploadMintBatch() {
    setBatchErr(null);
    setBatchMsg(null);
    if (!batchFile) {
      setBatchErr("Choose a UTF-8 CSV file.");
      return;
    }
    if (
      !window.confirm(
        `Upload and validate "${batchFile.name}"?\n\nThis creates a batch on the server and validates each row. Continue?`
      )
    ) {
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

  async function clearBatchRowPrepare(batchId: number, rowId: number) {
    setBatchMintErr(null);
    setBatchMsg(null);
    if (!window.confirm("Clear prepared state for this row? You can prepare it again afterwards.")) {
      return;
    }
    try {
      await apiJson<{ message: string }>(
        `/api/university/mint-batches/${batchId}/rows/${rowId}/reset-prepare`,
        { method: "POST" }
      );
      setBatchMsg("Prepare cleared for that row.");
      await refreshQueueRows();
      await refreshBatchMeta(batchId);
    } catch (caught: unknown) {
      setBatchMintErr(caught instanceof Error ? caught.message : "Could not clear prepare");
    }
  }

  async function clearPrepareForActiveBatchRow(rowId: number) {
    if (!activeBatchId) return;
    await clearBatchRowPrepare(activeBatchId, rowId);
  }

  async function prepareAllBatchRows() {
    setBatchMintErr(null);
    setBatchMsg(null);
    if (!activeBatchId || !queueRows.length) {
      setBatchMintErr("Upload a batch first.");
      return;
    }
    setBatchPrepAllBusy(true);
    try {
      // Prepare all rows that still need server-side preparation.
      const targets = [...queueRows]
        .filter((r) => ["pending_validation", "mint_failed"].includes(r.row_status))
        .sort((a, b) => a.row_index - b.row_index);

      if (targets.length === 0) {
        setBatchMsg("All valid rows are already prepared (or minted/invalid).");
        return;
      }

      if (
        !window.confirm(
          `Prepare all ${targets.length} remaining row(s) on the server?\n\nThis may take a while and pins metadata for each row.`
        )
      ) {
        return;
      }

      const token = getStoredToken();
      let preparedCount = 0;
      for (const r of targets) {
        setBatchMsg(`Preparing row ${r.row_index + 1}… (${preparedCount}/${targets.length})`);
        const resP = await fetch(
          `${API_BASE}/api/university/mint-batches/${activeBatchId}/rows/${r.id}/prepare`,
          { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} }
        );
        const prepBody = (await resP.json()) as PreparedMint & { error?: string };
        if (!resP.ok) throw new Error(prepBody.error || `Prepare failed for row ${r.row_index + 1}`);
        preparedCount += 1;
      }
      setBatchMsg(`Prepared ${preparedCount} row(s). You can now sign batch authorization.`);
      await refreshQueueRows();
      await refreshInvalidPreview();
      await refreshBatchMeta();
    } catch (caught: unknown) {
      setBatchMintErr(friendlyWalletError(caught));
    } finally {
      setBatchPrepAllBusy(false);
    }
  }

  async function signBatchMintAuthorization() {
    setBatchMintErr(null);
    setBatchMsg(null);
    if (!activeBatchId) {
      setBatchMintErr("No active batch.");
      return;
    }
    if (
      !window.confirm(
        "Sign the batch EIP-712 authorization in your wallet?\n\nThis authorizes the platform minter to mint all prepared rows. No gas is paid by you for this signature."
      )
    ) {
      return;
    }
    setBatchSignBusy(true);
    try {
      const maxRounds = 2;
      for (let round = 0; round < maxRounds; round += 1) {
        if (round > 0) {
          setBatchMsg(
            "Signing nonce changed — another authorization may have completed. Loaded a fresh batch payload; approve the wallet prompt again."
          );
        }
        const data = await apiJson<{
          eip712: NonNullable<PreparedMint["eip712"]>;
          error?: string;
        }>(`/api/university/mint-batches/${activeBatchId}/eip712`);
        const { provider } = await getSignerContract();
        const signer = await provider.getSigner();
        const sig = await signEip712Envelope(signer, data.eip712);
        try {
          await apiJson<{ message: string }>(
            `/api/university/mint-batches/${activeBatchId}/submit-authorization`,
            { method: "POST", json: { signature: sig } }
          );
          setBatchMsg(
            "Batch authorization signed. Run “Execute batch mints” to submit on-chain mints (gas paid by platform minter)."
          );
          await refreshBatchMeta();
          await loadMe();
          return;
        } catch (submitErr: unknown) {
          const retry =
            round < maxRounds - 1 &&
            submitErr instanceof ApiHttpError &&
            submitErr.errorCode === "eip712_nonce_mismatch";
          if (retry) continue;
          throw submitErr;
        }
      }
    } catch (caught: unknown) {
      setBatchMintErr(friendlyWalletError(caught));
    } finally {
      setBatchSignBusy(false);
    }
  }

  async function executeBatchMints() {
    setBatchMintErr(null);
    setBatchMsg(null);
    if (!activeBatchId) {
      setBatchMintErr("No active batch.");
      return;
    }
    if (
      !window.confirm(
        "Execute on-chain batch mints now?\n\nThe platform minter will submit transactions for prepared rows. This cannot be undone for each minted token."
      )
    ) {
      return;
    }
    setBatchExecBusy(true);
    try {
      let remaining = -1;
      for (let guard = 0; guard < 200; guard += 1) {
        const res = await apiJson<{
          remaining_rows: number;
          minted: {
            token_id: number;
            row_id?: number;
            timing?: { prepare_to_mint_ms: number | null; platform_mint_ms: number };
          }[];
          timing?: { chunk_wall_ms: number };
          error?: string;
        }>(`/api/university/mint-batches/${activeBatchId}/execute`, { method: "POST", json: { max_mints: 40 } });
        remaining = res.remaining_rows;
        await refreshQueueRows();
        await refreshBatchMeta();
        if (res.minted?.length) {
          const chunkMs = res.timing?.chunk_wall_ms;
          const plat = res.minted
            .map((m) => m.timing?.platform_mint_ms)
            .filter((x): x is number => typeof x === "number" && x >= 0);
          const avgPlat = plat.length ? Math.round(plat.reduce((a, b) => a + b, 0) / plat.length) : null;
          let line = `Minted ${res.minted.length} certificate(s) this chunk. ${remaining} row(s) remaining.`;
          if (chunkMs != null) line += ` Chunk (server): ${formatDurationMs(chunkMs)}.`;
          if (avgPlat != null) line += ` Avg platform mint/row: ${formatDurationMs(avgPlat)}.`;
          setBatchMsg(line);
        }
        if (remaining === 0) {
          setBatchMsg("Batch minting complete.");
          break;
        }
      }
    } catch (caught: unknown) {
      setBatchMintErr(friendlyWalletError(caught));
    } finally {
      setBatchExecBusy(false);
    }
    void (async () => {
      await syncAndRefreshActivity();
      await loadMe();
    })();
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

  async function runBatchRowAi() {
    if (!activeBatchId || batchAiRowId == null) return;
    setBatchAiErr(null);
    setBatchAiText(null);
    setBatchAiModel(null);
    setBatchAiBusy(true);
    try {
      const data = await apiJson<{ model?: string; text?: string }>(
        `/api/university/mint-batches/${activeBatchId}/rows/${batchAiRowId}/ai-qa`,
        { method: "POST", json: { question: batchAiQuestion.trim() || undefined } }
      );
      setBatchAiText((data.text || "").trim() || "No response text.");
      setBatchAiModel((data.model || "").trim() || null);
    } catch (caught: unknown) {
      setBatchAiErr(caught instanceof Error ? caught.message : "AI request failed");
    } finally {
      setBatchAiBusy(false);
    }
  }

  useEffect(() => {
    if (me?.status === "verified") {
      void syncAndRefreshActivity();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.status]);

  useEffect(() => {
    setBatchAiRowId(null);
    setBatchAiText(null);
    setBatchAiErr(null);
    setBatchAiModel(null);
    setBatchAiQuestion("");
  }, [activeBatchId]);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setMintErr(null);
    setMintMsg(null);
    if (
      !window.confirm(
        `Mint credential on-chain?\n\nStudent: ${studentName}\nCert ID: ${certId}\nInternal ID: ${studentInternalId}\nEmail: ${studentEmail}\n\nYou will sign an EIP-712 authorization in your wallet, then the platform minter submits the mint.`
      )
    ) {
      return;
    }
    setMintBusy(true);
    try {
      const mintBody = {
        student_name: studentName,
        student_internal_id: studentInternalId,
        student_email: studentEmail,
        degree_type: degreeType,
        cert_id: certId,
        issue_date: issueDate,
      };
      const maxRounds = 2;
      for (let round = 0; round < maxRounds; round += 1) {
        if (round > 0) {
          setMintMsg(
            "Signing nonce changed — preparing a fresh mint authorization. Approve the next wallet prompt(s) again."
          );
        }
        const prepared = await apiJson<PreparedMint>("/api/university/certificates/prepare-mint", {
          method: "POST",
          json: mintBody,
        });
        if (!prepared.eip712 || !prepared.mint_request_id) {
          throw new Error("Server did not return EIP-712 authorization data.");
        }
        const { provider } = await getSignerContract();
        const signer = await provider.getSigner();
        const sig = await signEip712Envelope(signer, prepared.eip712);
        try {
          const out = await apiJson<{
            token_id: number;
            tx_hash: string;
            timing?: { prepare_to_complete_ms: number | null; platform_mint_ms: number };
          }>("/api/university/certificates/submit-authorization", {
            method: "POST",
            json: { mint_request_id: prepared.mint_request_id, signature: sig },
          });
          const t = out.timing;
          const timingNote =
            t && (t.prepare_to_complete_ms != null || t.platform_mint_ms != null)
              ? ` Timing: ${formatDurationMs(t.prepare_to_complete_ms ?? undefined)} from prepare to done (includes wallet signing); platform mint + receipt: ${formatDurationMs(t.platform_mint_ms)}.`
              : "";
          setMintMsg(`Minted on-chain as token ${out.token_id}. Minter tx: ${out.tx_hash}.${timingNote}`);
          break;
        } catch (submitErr: unknown) {
          const retry =
            round < maxRounds - 1 &&
            submitErr instanceof ApiHttpError &&
            submitErr.errorCode === "eip712_nonce_mismatch";
          if (retry) continue;
          throw submitErr;
        }
      }
    } catch (caught: unknown) {
      setMintErr(friendlyWalletError(caught));
    } finally {
      setMintBusy(false);
    }
    void (async () => {
      await syncAndRefreshActivity();
      await loadMe();
    })();
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
    if (!isAddress(studentWallet.trim())) {
      setClaimErr("Student wallet must be a valid 0x address.");
      return;
    }
    if (
      !window.confirm(
        `Claim token #${tid} to the student wallet and lock (soulbound)?\n\nRecipient: ${studentWallet.trim()}\n\nYou will submit an on-chain transaction.`
      )
    ) {
      return;
    }
    setClaimBusy(true);
    try {
      const { contract, provider } = await getSignerContract();
      const tx = await contract.claim(tid, studentWallet.trim(), await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setClaimMsg(`Claimed. Tx: ${receipt.hash}`);
    } catch (caught: unknown) {
      setClaimErr(friendlyWalletError(caught));
    } finally {
      setClaimBusy(false);
    }
    void (async () => {
      await syncAndRefreshActivity();
      await loadStudentClaimRequests();
    })();
  }

  async function approveStudentClaimRequest(reqId: number) {
    if (!window.confirm("Approve this student’s transfer request? You will still submit the on-chain claim from your issuer wallet.")) {
      return;
    }
    try {
      await apiJson(`/api/university/student-claim-requests/${reqId}/approve`, { method: "POST", json: {} });
      await loadStudentClaimRequests();
    } catch (caught: unknown) {
      window.alert(caught instanceof Error ? caught.message : "Approve failed");
    }
  }

  async function rejectStudentClaimRequest(reqId: number) {
    const reason = window.prompt("Optional rejection reason (shown only in your records):") || "";
    try {
      await apiJson(`/api/university/student-claim-requests/${reqId}/reject`, {
        method: "POST",
        json: { reason: reason.trim() || undefined },
      });
      await loadStudentClaimRequests();
    } catch (caught: unknown) {
      window.alert(caught instanceof Error ? caught.message : "Reject failed");
    }
  }

  async function completeStudentClaimRequest(reqId: number) {
    const txh = window.prompt("Paste claim transaction hash (0x…), or leave blank to mark complete without hash:") || "";
    try {
      await apiJson(`/api/university/student-claim-requests/${reqId}/complete`, {
        method: "POST",
        json: { claim_tx_hash: txh.trim() || undefined },
      });
      await loadStudentClaimRequests();
    } catch (caught: unknown) {
      window.alert(caught instanceof Error ? caught.message : "Update failed");
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
    if (
      !window.confirm(
        `Revoke certificate for token #${tid} on-chain?\n\nVerifiers will see this credential as invalid. This action is serious — continue?`
      )
    ) {
      return;
    }
    setRevokeBusy(true);
    try {
      const { contract, provider } = await getSignerContract();
      const tx = await contract.revokeCertificate(tid, await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setRevokeMsg(`Revoked. Tx: ${receipt.hash}`);
    } catch (caught: unknown) {
      setRevokeErr(friendlyWalletError(caught));
    } finally {
      setRevokeBusy(false);
    }
    void syncAndRefreshActivity();
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
    if (
      !window.confirm(
        `Permanently burn token #${tid}?\n\nThis destroys the NFT on-chain. Only do this for revoked credentials. This cannot be undone.`
      )
    ) {
      return;
    }
    setBurnBusy(true);
    try {
      const { contract, provider } = await getSignerContract();
      const tx = await contract.burnCertificate(tid, await amoyFeeOverrides(provider));
      const receipt = await tx.wait();
      setBurnMsg(`Burned. Tx: ${receipt.hash}`);
    } catch (caught: unknown) {
      setBurnErr(friendlyWalletError(caught));
    } finally {
      setBurnBusy(false);
    }
    void syncAndRefreshActivity();
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
    if (
      !window.confirm(
        `Reissue certificate from old token #${oldTokenId}?\n\nNew cert ID: ${reissueCertId}\nStudent: ${reissueStudentName}\n\nThis revokes the old token and mints a replacement — you will submit an on-chain transaction.`
      )
    ) {
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
    } catch (caught: unknown) {
      setReissueErr(friendlyWalletError(caught));
    } finally {
      setReissueBusy(false);
    }
    void syncAndRefreshActivity();
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

  function toggleSettingDay(d: number) {
    setOpDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function saveOperatingProfile(e: React.FormEvent) {
    e.preventDefault();
    setOpErr(null);
    setOpMsg(null);
    setOpBusy(true);
    try {
      const hasStart = Boolean(opStart.trim());
      const hasEnd = Boolean(opEnd.trim());
      if (hasStart !== hasEnd) {
        setOpErr("Provide both operating start and end, or leave both empty.");
        return;
      }
      if (hasStart && hasEnd) {
        if (!opTz.trim()) {
          setOpErr("Operating timezone is required when hours are set.");
          return;
        }
        if (opDays.size === 0) {
          setOpErr("Select at least one operating day when hours are set.");
          return;
        }
      }
      const monthly = opMonthly.trim() === "" ? null : Number.parseInt(opMonthly.trim(), 10);
      if (monthly !== null && (Number.isNaN(monthly) || monthly < 0)) {
        setOpErr("Expected mints per month must be a non-negative integer or empty.");
        return;
      }
      let annually: number | null = null;
      if (opAnnual.trim() !== "") {
        annually = Number.parseInt(opAnnual.trim(), 10);
        if (Number.isNaN(annually) || annually < 0) {
          setOpErr("Expected mints annually must be a non-negative integer or empty.");
          return;
        }
      }
      await apiJson<{ message: string }>("/api/university/me", {
        method: "PATCH",
        json: {
          expected_mints_monthly: monthly,
          expected_mints_annually: annually,
          operating_days_of_week: [...opDays].sort((a, b) => a - b),
          operating_hours_start: opStart.trim() || null,
          operating_hours_end: opEnd.trim() || null,
          operating_timezone: opTz.trim() || null,
        },
      });
      setOpMsg("Operating expectations updated.");
      await loadMe();
    } catch (caught: unknown) {
      setOpErr(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setOpBusy(false);
    }
  }

  async function uploadInstitutionDocument() {
    setDocErr(null);
    setDocMsg(null);
    if (!docUploadFile) {
      setDocErr("Choose a PDF or image file.");
      return;
    }
    setDocBusy(true);
    try {
      const fd = new FormData();
      fd.append("documents", docUploadFile);
      fd.append("document_labels", docUploadLabel);
      await apiFormData<{ message: string }>("/api/university/documents", fd);
      setDocMsg("Document uploaded.");
      setDocUploadFile(null);
      await loadMe();
    } catch (caught: unknown) {
      setDocErr(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setDocBusy(false);
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

  // For batch signing we require every non-invalid, non-minted row to be in `prepared` state.
  // Backend rejects batch auth if any row is still pending_validation (or mint_failed).
  const batchRowsNeedingPreparation = queueRows.filter((r) => {
    const skip = ["invalid", "mint_confirmed", "email_sent", "email_failed"].includes(r.row_status);
    return !skip;
  });
  const batchAllReadyForSigning =
    batchRowsNeedingPreparation.length > 0 &&
    batchRowsNeedingPreparation.every((r) => r.row_status === "prepared");
  const batchCanSign = Boolean(verified && activeBatchId != null && canUseChain && batchAllReadyForSigning);

  const batchStatus = batchSummary?.status ?? "";
  const batchStepPrepared =
    batchRowsNeedingPreparation.length === 0 ||
    batchRowsNeedingPreparation.every((r) => r.row_status === "prepared");
  const batchStepSigned = ["authorized", "executing", "completed"].includes(batchStatus);
  const batchStepExecuted = batchStatus === "completed";

  const batchWorkspaceHasContent =
    activeBatchId != null ||
    batchFile != null ||
    batchSummary != null ||
    invalidPreview.length > 0 ||
    queueRows.length > 0 ||
    batchErr != null ||
    batchMsg != null ||
    batchMintErr != null;

  function clearBatchWorkspace() {
    if (!batchWorkspaceHasContent) return;
    if (
      !window.confirm(
        "Clear this batch from the mint workspace?\n\n" +
          "The batch and rows stay on the server for your records. This only resets the file picker, summary, row tables, and messages here so you can work on another upload."
      )
    ) {
      return;
    }
    setActiveBatchId(null);
    setBatchSummary(null);
    setQueueRows([]);
    setInvalidPreview([]);
    setBatchFile(null);
    setBatchDropzoneKey((k) => k + 1);
    setBatchErr(null);
    setBatchMsg(null);
    setBatchMintErr(null);
    setBatchAiRowId(null);
    setBatchAiQuestion("");
    setBatchAiErr(null);
    setBatchAiText(null);
    setBatchAiModel(null);
  }

  const identityLogoSrc = institutionLogoDisplayUrl(me?.logo_url, me?.logo_uri);

  return (
    <>
      <header>
        <h1>UNIVERSITY PORTAL</h1>
        <p>
          Mint, claim, revoke, burn, and reissue using your approved issuer wallet only. Connect MetaMask (or any
          injected wallet) on Polygon Amoy. Your private keys are never shared with the platform.
        </p>
         <p className="uni-dashboard-link-row">
  <Link to="/university/overview">Institution Dashboard</Link>
  {" · "}
  Monitor issuance activity, batch results, and recent updates.
</p>
      </header>

      <div className="inst-portal">
      {me && (
        <section className="uni-status-strip" aria-label="Portal status">
          <div className="uni-status-strip__main">
            <span className="uni-status-strip__name">{me.name}</span>
            <span className={`status ${me.status}`}>{me.status}</span>
          </div>
          <div className="uni-status-strip__meta">
            <span>
              Amoy · chain {me.chain_id}
            </span>
            {verified && walletAddress && canUseChain && (
              <span className="uni-status-strip__ok">Issuer wallet ready</span>
            )}
            {verified && walletAddress && !canUseChain && (
              <span className="uni-status-strip__warn">Switch network or connect issuer wallet</span>
            )}
            {verified && !walletAddress && <span className="muted">Wallet not connected</span>}
            {!verified && <span className="muted">Awaiting admin approval to mint</span>}
          </div>
        </section>
      )}

      {me && (
        <section className="panel inst-identity-card" aria-label="Institution identity">
          <div className="inst-card-head">
            <h2 className="inst-card-title">Institution Identity</h2>
            <button
              type="button"
              className="inst-card-action"
              onClick={() => {
                setMode("settings");
              }}
              disabled={!verified}
            >
              Edit profile
            </button>
          </div>
          <div className="inst-identity-row">
            {identityLogoSrc ? (
              <img src={identityLogoSrc} alt="" className="inst-identity-avatar" />
            ) : (
              <span className="inst-identity-avatar inst-identity-avatar--ph" aria-hidden>
                {me.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="inst-identity-text">
              <p className="inst-identity-name">{me.name}</p>
              <p className="inst-identity-sub mono">{me.internal_id}</p>
            </div>
          </div>
          {loadErr && <div className="error">{loadErr}</div>}
          <div className="inst-identity-grid">
            <div className="inst-identity-kv">
              <span>Institution ID</span>
              <strong className="mono">{me.internal_id}</strong>
            </div>
            <div className="inst-identity-kv">
              <span>Smart contract</span>
              <strong className="mono">{me.contract_address ? `${me.contract_address.slice(0, 6)}…${me.contract_address.slice(-4)}` : "—"}</strong>
            </div>
            <div className="inst-identity-kv">
              <span>Wallet address</span>
              <strong className="mono">{me.wallet_address ? `${me.wallet_address.slice(0, 6)}…${me.wallet_address.slice(-4)}` : "—"}</strong>
            </div>
            <div className="inst-identity-kv">
              <span>Contact email</span>
              <strong>{me.institution_contact_email || "—"}</strong>
            </div>
          </div>
          {!verified && (
            <div className="warn-banner" style={{ marginTop: "0.85rem" }}>
              Your institution is not verified yet. Minting and claiming are blocked until an admin approves your registration.
            </div>
          )}
        </section>
      )}

      {mode === "wallet" && (
        <section className="panel">
          <div className="inst-card-head">
            <h2 className="inst-card-title">Wallet</h2>
          </div>
          <p className="muted-inline" style={{ marginTop: 0 }}>
            Use the same wallet address you submitted at registration. Claim is signed by the issuer (you); only the student
            address is passed as the recipient.
          </p>
          <div className="row">
            <button type="button" onClick={() => void connectWallet()} disabled={!verified}>
              Connect issuer wallet
            </button>
            <button type="button" className="btn-secondary" onClick={() => void copyAmoyRpcUrl()} disabled={!verified}>
              {rpcCopied ? "Copied" : "Copy Amoy RPC URL"}
            </button>
            <span className="muted-inline">
              Connected: <span className="mono small">{walletAddress || "not connected"}</span>
            </span>
          </div>
          {verified && (
            <p className="muted-inline small" style={{ marginTop: "0.55rem" }}>
              If you see “rate limited” when sending transactions: MetaMask → <strong>Settings</strong> → <strong>Networks</strong> →
              select <strong>Polygon Amoy</strong> → set <strong>RPC URL</strong> to{" "}
              <code className="mono small">{AMOY_PUBLIC_RPC}</code> (or use <strong>Copy Amoy RPC URL</strong> above).
            </p>
          )}
          {!canUseChain && verified && (
            <div className="warn-banner">
              Chain actions are blocked until MetaMask is on Polygon Amoy and the connected account matches your approved issuer wallet.
            </div>
          )}
          {walletErr && <div className="error">{walletErr}</div>}
        </section>
      )}

      {mode === "settings" && (
        <section className="panel">
          <div className="inst-card-head">
            <h2 className="inst-card-title">Settings</h2>
          </div>
          <p className="muted-inline" style={{ marginTop: 0 }}>
            These fields are stored on your university profile and automatically included in mint/reissue metadata.
          </p>
          <form className="stack" onSubmit={saveInstitutionProfile}>
            <div className="inst-field">
              <label htmlFor="logo_file">Institution logo (png/jpeg/webp/gif, max 2MB)</label>
              <input
                id="logo_file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
                disabled={!verified}
              />
              <div className="row" style={{ marginTop: "0.45rem" }}>
                <button
                  type="button"
                  onClick={() => void uploadLogo()}
                  disabled={!verified || logoBusy || accountFrozen}
                  aria-busy={logoBusy}
                >
                  <BusyLabel busy={logoBusy} idle="Upload logo" busyLabel="Uploading…" />
                </button>
                {logoMsg && <span className="muted-inline">{logoMsg}</span>}
              </div>
              {logoErr && <div className="error">{logoErr}</div>}
            </div>
            <div className="row two-col">
              <div className="inst-field">
                <label htmlFor="profile_email">Contact email</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <Mail size={18} />
                  </span>
                  <input
                    id="profile_email"
                    type="email"
                    value={profileContactEmail}
                    onChange={(e) => setProfileContactEmail(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="profile_phone">Contact phone</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <Phone size={18} />
                  </span>
                  <input
                    id="profile_phone"
                    value={profileContactPhone}
                    onChange={(e) => setProfileContactPhone(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>
            <div className="row two-col">
              <div className="inst-field">
                <label htmlFor="profile_web">Website</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <Globe size={18} />
                  </span>
                  <input id="profile_web" value={profileWebsite} onChange={(e) => setProfileWebsite(e.target.value)} required />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="profile_lic_id">License ID</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <BadgeCheck size={18} />
                  </span>
                  <input id="profile_lic_id" value={profileLicenseId} onChange={(e) => setProfileLicenseId(e.target.value)} required />
                </div>
              </div>
            </div>
            <div className="row two-col">
              <div className="inst-field">
                <label htmlFor="profile_lic_auth">License authority</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <ShieldCheck size={18} />
                  </span>
                  <input
                    id="profile_lic_auth"
                    value={profileLicenseAuthority}
                    onChange={(e) => setProfileLicenseAuthority(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="inst-field">
                <label htmlFor="profile_lic_valid">License valid until</label>
                <div className="inst-input-wrap">
                  <span className="inst-input-icon" aria-hidden>
                    <CalendarDays size={18} />
                  </span>
                  <input
                    id="profile_lic_valid"
                    type="date"
                    value={profileLicenseValidUntil}
                    onChange={(e) => setProfileLicenseValidUntil(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>
            {profileErr && <div className="error">{profileErr}</div>}
            {profileMsg && <div className="success">{profileMsg}</div>}
            <button type="submit" disabled={profileBusy || !verified || accountFrozen} aria-busy={profileBusy}>
              <BusyLabel busy={profileBusy} idle="Save changes" busyLabel="Saving…" />
            </button>
          </form>

          <h3 className="subheading" style={{ marginTop: "1.75rem" }}>
            Operating expectations
          </h3>
          <p className="muted-inline small">
            Used for admin review and capacity planning. Not shown on the public verify page or in student-facing
            certificate fields.
          </p>
          <form className="stack" onSubmit={saveOperatingProfile} style={{ marginTop: "0.75rem" }}>
            <div className="row two-col">
              <div className="inst-field">
                <label htmlFor="op_monthly">Expected mints / month</label>
                <input
                  id="op_monthly"
                  type="number"
                  min={0}
                  step={1}
                  value={opMonthly}
                  onChange={(e) => setOpMonthly(e.target.value)}
                />
              </div>
              <div className="inst-field">
                <label htmlFor="op_annual">Expected mints / year (optional)</label>
                <input
                  id="op_annual"
                  type="number"
                  min={0}
                  step={1}
                  value={opAnnual}
                  onChange={(e) => setOpAnnual(e.target.value)}
                />
              </div>
            </div>
            <fieldset className="register-fieldset">
              <legend className="register-fieldset__legend">Operating days</legend>
              <div className="register-day-grid" role="group" aria-label="Operating weekdays">
                {SETTINGS_WEEKDAYS.map(({ value, label }) => (
                  <label key={value} className="register-day-chip">
                    <input type="checkbox" checked={opDays.has(value)} onChange={() => toggleSettingDay(value)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="row two-col">
              <div className="inst-field">
                <label htmlFor="op_st">Hours start (optional)</label>
                <input id="op_st" type="time" value={opStart} onChange={(e) => setOpStart(e.target.value)} />
              </div>
              <div className="inst-field">
                <label htmlFor="op_en">Hours end (optional)</label>
                <input id="op_en" type="time" value={opEnd} onChange={(e) => setOpEnd(e.target.value)} />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="op_tz_set">IANA timezone</label>
              <input
                id="op_tz_set"
                value={opTz}
                onChange={(e) => setOpTz(e.target.value)}
                placeholder="e.g. America/Jamaica"
              />
            </div>
            {opErr && <div className="error">{opErr}</div>}
            {opMsg && <div className="success">{opMsg}</div>}
            <button type="submit" disabled={opBusy || accountFrozen} aria-busy={opBusy}>
              <BusyLabel busy={opBusy} idle="Save operating profile" busyLabel="Saving…" />
            </button>
          </form>

          <h3 className="subheading" style={{ marginTop: "1.75rem" }}>
            Verification documents
          </h3>
          <p className="muted-inline small">
            Append PDF or image files for admin review (same rules as registration). Existing files are listed below.
          </p>
          {me?.institution_documents && me.institution_documents.length > 0 ? (
            <ul className="kv-list">
              {me.institution_documents.map((d, i) => (
                <li key={`${d.uri}-${i}`}>
                  <strong>{d.label}</strong> — {d.filename}{" "}
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="home-link">
                      Open
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-inline small">No documents on file yet.</p>
          )}
          <div className="inst-field" style={{ marginTop: "0.65rem" }}>
            <label htmlFor="doc_up">Add document</label>
            <input
              id="doc_up"
              type="file"
              accept=".pdf,application/pdf,image/png,image/jpeg,image/webp"
              onChange={(e) => setDocUploadFile(e.target.files?.[0] || null)}
            />
          </div>
          <div className="inst-field">
            <label htmlFor="doc_lab">Type</label>
            <select id="doc_lab" value={docUploadLabel} onChange={(e) => setDocUploadLabel(e.target.value)}>
              <option value="Accreditation">Accreditation</option>
              <option value="Authorization letter">Authorization letter</option>
              <option value="Other">Other</option>
            </select>
          </div>
          {docErr && <div className="error">{docErr}</div>}
          {docMsg && <div className="success">{docMsg}</div>}
          <button
            type="button"
            onClick={() => void uploadInstitutionDocument()}
            disabled={docBusy || accountFrozen}
            aria-busy={docBusy}
          >
            <BusyLabel busy={docBusy} idle="Upload document" busyLabel="Uploading…" />
          </button>
        </section>
      )}

      {mode === "mint" && (
      <section className="panel panel-busy-anchor">
        {mintBusy && (
          <div className="panel-busy-overlay" role="status" aria-live="polite" aria-busy="true">
            <BrandedLoader size="md" />
            <span className="panel-busy-overlay__text">Authorizing / minting…</span>
          </div>
        )}
        <h2 className="subhead">Mint certificate </h2>
        <ol className="uni-flow-steps" aria-label="Typical mint sequence">
          <li className="uni-flow-steps__item">
            <span>1</span> Enter certificate details
          </li>
          <li className="uni-flow-steps__item">
            <span>2</span> Sign EIP-712 in your wallet
          </li>
          <li className="uni-flow-steps__item">
            <span>3</span> Platform submits mint on-chain
          </li>
        </ol>
        {/* <p className="muted-inline">
          Backend pins Ed25519-signed metadata to IPFS, then you sign an <strong>EIP-712 authorization</strong> in
          MetaMask (no gas). TruCert&apos;s platform minter wallet submits <code>mintForIssuer</code>; the NFT is
          minted to your issuer address.
        </p> */}
        <form className="stack" onSubmit={mint}>
          <div className="row two-col">
            <div className="inst-field">
              <label htmlFor="cert_id">Certificate ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Tag size={18} />
                </span>
                <input
                  id="cert_id"
                  value={certId}
                  onChange={(e) => setCertId(e.target.value)}
                  placeholder="e.g. MU-2024-001"
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="issue_date">Issue date</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <CalendarDays size={18} />
                </span>
                <input
                  id="issue_date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  placeholder="YYYY-MM-DD"
                  required
                />
              </div>
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="student_internal_id">Student internal ID</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                <Hash size={18} />
              </span>
              <input
                id="student_internal_id"
                value={studentInternalId}
                onChange={(e) => setStudentInternalId(e.target.value)}
                placeholder="Institution student ID"
                maxLength={128}
                required
              />
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="student_email">Student email</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                <Mail size={18} />
              </span>
              <input
                id="student_email"
                type="email"
                value={studentEmail}
                onChange={(e) => setStudentEmail(e.target.value)}
                placeholder="student@school.edu"
                required
              />
            </div>
          </div>
          
          <div className="inst-field">
            <label htmlFor="student_name">Student full name</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                <User size={18} />
              </span>
              <input
                id="student_name"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                placeholder="e.g. Alex Rivera"
                required
              />
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="degree">Degree program</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                <GraduationCap size={18} />
              </span>
              <input
                id="degree"
                value={degreeType}
                onChange={(e) => setDegreeType(e.target.value)}
                placeholder="e.g. B.Sc. Computer Science"
                required
              />
            </div>
          </div>
          {mintErr && <div className="error">{mintErr}</div>}
          {mintMsg && <div className="success">{mintMsg}</div>}
          <button
            type="submit"
            className="inst-submit-wide"
            disabled={mintBusy || !verified || !canUseChain || accountFrozen}
            aria-busy={mintBusy}
          >
            <BusyLabel busy={mintBusy} idle="Generate credential" busyLabel="Authorizing / minting…" />
          </button>
        </form>
      </section>
      )}

      {mode === "batch" && (
      <section className="panel panel-busy-anchor">
        {(batchExecBusy || batchPrepAllBusy) && (
          <div className="panel-busy-overlay" role="status" aria-live="polite">
            <BrandedLoader size="md" />
            <span className="panel-busy-overlay__text">
              {batchExecBusy ? "Executing batch mints…" : "Preparing all rows…"}
            </span>
          </div>
        )}
        <h2 className="subhead">Batch mint (CSV)</h2>
        <p className="muted-inline small">
          UTF-8 CSV with headers:{" "}
          <code>
            cert_id,student_internal_id,student_email,student_full_name,degree_title,issue_date
          </code>
          . Optional: <code>image_ipfs_uri</code>. Max 500 rows. Student email and internal ID are stored
          only in the database — they are never pinned to IPFS.
        </p>
        <ol className="uni-flow-steps" aria-label="Typical batch mint sequence">
          <li className="uni-flow-steps__item">
            <span>1</span> Upload &amp; validate student list
          </li>
          <li className="uni-flow-steps__item">
            <span>2</span> Prepare all rows (IPFS + index)
          </li>
          <li className="uni-flow-steps__item">
            <span>3</span> Sign batch EIP-712 &amp; execute mints on-chain
          </li>
        </ol>
        <div className="stack" style={{ marginTop: "0.65rem" }}>
          <div className="inst-field">
            <label htmlFor="batch_csv">Student list (CSV)</label>
            <div
              className="inst-dropzone"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const f = e.dataTransfer.files?.[0];
                if (!f) return;
                if (f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv" || f.type === "application/vnd.ms-excel") {
                  setBatchFile(f);
                }
              }}
            >
              <input
                key={batchDropzoneKey}
                id="batch_csv"
                className="inst-dropzone-input"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setBatchFile(e.target.files?.[0] || null)}
                disabled={!verified || batchBusy || accountFrozen}
              />
              <div className="inst-dropzone-ui">
                <span className="inst-dropzone-icon" aria-hidden>
                  <UploadCloud />
                </span>
                <p>Click or drag to upload student list</p>
                <p className="inst-dropzone-hint muted">
                  UTF-8 · max 500 rows ·{" "}
                  <a href="/samples/batch-mint-example.csv" download className="home-link">
                    Download CSV template
                  </a>
                </p>
              </div>
            </div>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => void uploadMintBatch()}
              disabled={!verified || batchBusy || accountFrozen}
              aria-busy={batchBusy}
            >
              <BusyLabel busy={batchBusy} idle="Upload & validate batch" busyLabel="Uploading…" />
            </button>
            {activeBatchId != null && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void refreshQueueRows()}
                disabled={!verified || batchBusy || accountFrozen}
              >
                Refresh rows
              </button>
            )}
            {batchWorkspaceHasContent && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => clearBatchWorkspace()}
                disabled={
                  !verified ||
                  batchBusy ||
                  batchPrepAllBusy ||
                  batchSignBusy ||
                  batchExecBusy ||
                  batchAiBusy
                }
              >
                Clear batch
              </button>
            )}
          </div>
          {batchSummary && (
            <p className="muted-inline" style={{ marginTop: 0 }}>
              Batch #{activeBatchId}: status <strong>{batchSummary.status}</strong> — total{" "}
              {batchSummary.total_rows}, valid {batchSummary.valid_rows}, invalid {batchSummary.invalid_rows}
              {batchSummary.timing?.cumulative_execute_wall_ms != null && batchSummary.timing.cumulative_execute_wall_ms > 0 ? (
                <>
                  {" "}
                  — execute wall total <strong>{formatDurationMs(batchSummary.timing.cumulative_execute_wall_ms)}</strong>
                  {batchSummary.timing.last_execute_chunk_wall_ms != null ? (
                    <>
                      {" "}
                      (last chunk {formatDurationMs(batchSummary.timing.last_execute_chunk_wall_ms)})
                    </>
                  ) : null}
                </>
              ) : null}
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
                {invalidPg.pageItems.map((r) => (
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
            <TablePagination
              page={invalidPg.page}
              pageSize={invalidPg.pageSize}
              totalPages={invalidPg.totalPages}
              total={invalidPg.total}
              from={invalidPg.from}
              to={invalidPg.to}
              onPageChange={invalidPg.setPage}
              onPageSizeChange={invalidPg.setPageSize}
            />
          </div>
        )}
        <div className="stack" style={{ marginTop: "1rem" }}>
          <p className="muted-inline small" style={{ marginTop: 0 }}>
            Use <strong>Prepare all rows</strong> to pin metadata on the server (IPFS + index) for every row that still
            needs it. When every non-invalid row is <code>prepared</code>, sign one <strong>batch EIP-712</strong>{" "}
            authorization (no gas), then run <strong>Execute batch mints</strong> so the platform minter submits one chain
            transaction per row.
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
          {!batchCanSign && activeBatchId != null && batchRowsNeedingPreparation.length > 0 && (
            <div className="warn-banner">
              Batch signing requires that all non-invalid rows are <strong>prepared</strong>. Run{" "}
              <strong>Prepare all rows</strong> until every row shows <code>prepared</code>.
            </div>
          )}
          {activeBatchId != null && (
            <BatchMintProgressStepper
              prepared={batchStepPrepared}
              signed={batchStepSigned}
              executed={batchStepExecuted}
              prepareBusy={batchPrepAllBusy}
              signBusy={batchSignBusy}
              executeBusy={batchExecBusy}
            />
          )}
          <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => void prepareAllBatchRows()}
              disabled={!verified || batchPrepAllBusy || activeBatchId == null || accountFrozen}
              title="Prepare all remaining rows sequentially (IPFS + index per row)"
              aria-busy={batchPrepAllBusy}
            >
              <BusyLabel busy={batchPrepAllBusy} idle="Prepare all rows" busyLabel="Preparing all…" />
            </button>
            <button
              type="button"
              onClick={() => void signBatchMintAuthorization()}
              disabled={!batchCanSign || batchSignBusy || activeBatchId == null || accountFrozen}
              aria-busy={batchSignBusy}
            >
              <BusyLabel busy={batchSignBusy} idle="Sign batch authorization" busyLabel="Signing…" />
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void executeBatchMints()}
              disabled={!verified || batchExecBusy || activeBatchId == null || accountFrozen}
              aria-busy={batchExecBusy}
            >
              <BusyLabel busy={batchExecBusy} idle="Execute batch mints" busyLabel="Executing…" />
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void downloadBatchErrorCsv()}
              disabled={!verified || activeBatchId == null || accountFrozen}
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
                    <th>Timing</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queuePg.pageItems.map((r) => (
                    <tr key={r.id}>
                      <td>{r.row_index + 1}</td>
                      <td className="mono small">{r.cert_id || "—"}</td>
                      <td>{r.student_full_name || "—"}</td>
                      <td>
                        <span className={`status ${r.row_status}`}>{r.row_status}</span>
                      </td>
                      <td className="mono small">{r.token_id ?? "—"}</td>
                      <td className="muted-inline small">
                        {r.prepare_to_mint_ms != null || r.platform_mint_ms != null ? (
                          <>
                            prep→mint {formatDurationMs(r.prepare_to_mint_ms ?? undefined)}
                            <br />
                            platform {formatDurationMs(r.platform_mint_ms ?? undefined)}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                          <button
                            type="button"
                            className="btn-text"
                            onClick={() => {
                              setBatchAiRowId(r.id);
                              setBatchAiText(null);
                              setBatchAiErr(null);
                              setBatchAiModel(null);
                            }}
                          >
                            AI QA
                          </button>
                          {r.row_status === "prepared" ? (
                            <button
                              type="button"
                              className="btn-text"
                              onClick={() => void clearPrepareForActiveBatchRow(r.id)}
                              disabled={batchPrepAllBusy || accountFrozen}
                            >
                              Clear prepare
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <TablePagination
                page={queuePg.page}
                pageSize={queuePg.pageSize}
                totalPages={queuePg.totalPages}
                total={queuePg.total}
                from={queuePg.from}
                to={queuePg.to}
                onPageChange={queuePg.setPage}
                onPageSizeChange={queuePg.setPageSize}
              />
              {activeBatchId != null && batchAiRowId != null && (
                <div className="ai-summary" style={{ marginTop: "1rem" }}>
                  <div className="ai-summary__details" style={{ cursor: "default" }}>
                    <div className="ai-summary__summary" style={{ cursor: "default", marginBottom: "0.35rem" }}>
                      <span className="ai-summary__title">
                        <span className="ai-summary__title-icon" aria-hidden>
                          <Sparkles size={16} />
                        </span>{" "}
                        Batch row QA (AI)
                      </span>
                      <span className="ai-summary__badge">AI · ADVISORY</span>
                    </div>
                    <p className="ai-summary__disclaimer" style={{ marginTop: 0 }}>
                      <em>
                        Advisory only. TruCert validation and on-chain rules are authoritative. Email and internal student IDs are
                        not sent to the model.
                      </em>
                    </p>
                    {(() => {
                      const sel = queueRows.find((x) => x.id === batchAiRowId);
                      if (!sel) {
                        return <p className="muted-inline small">Row not loaded — refresh rows.</p>;
                      }
                      return (
                        <div className="panel" style={{ margin: "0 0 0.75rem", padding: "0.65rem 0.75rem" }}>
                          <p className="muted-inline small" style={{ margin: 0 }}>
                            Row <strong>{sel.row_index + 1}</strong> · <span className="mono small">{sel.cert_id || "—"}</span> ·{" "}
                            <span className={`status ${sel.row_status}`}>{sel.row_status}</span>
                          </p>
                          <p className="muted-inline small" style={{ margin: "0.35rem 0 0" }}>
                            {sel.student_full_name || "—"} · {sel.degree_title || "—"} · issued {sel.issue_date || "—"}
                          </p>
                        </div>
                      );
                    })()}
                    <label htmlFor="batch_ai_q" className="muted-inline small" style={{ display: "block", marginBottom: "0.35rem" }}>
                      Optional question (e.g. &quot;Does this date look wrong?&quot;)
                    </label>
                    <textarea
                      id="batch_ai_q"
                      className="inst-field"
                      style={{ width: "100%", minHeight: "4rem", marginBottom: "0.65rem" }}
                      value={batchAiQuestion}
                      onChange={(e) => setBatchAiQuestion(e.target.value)}
                      maxLength={500}
                      placeholder="Optional — leave blank for a general consistency check"
                    />
                    <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                      <button
                        type="button"
                        onClick={() => void runBatchRowAi()}
                        disabled={batchAiBusy || !verified || accountFrozen}
                        aria-busy={batchAiBusy}
                      >
                        <BusyLabel busy={batchAiBusy} idle="Run AI check" busyLabel="Checking…" />
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setBatchAiRowId(null);
                          setBatchAiText(null);
                          setBatchAiErr(null);
                          setBatchAiModel(null);
                        }}
                      >
                        Close
                      </button>
                    </div>
                    {batchAiErr && <div className="error" style={{ marginTop: "0.65rem" }}>{batchAiErr}</div>}
                    {batchAiText && (
                      <div className="ai-summary__body" style={{ marginTop: "0.75rem", borderTop: "1px solid rgba(58, 74, 110, 0.35)", paddingTop: "0.65rem" }}>
                        <p className="ai-summary__text" style={{ margin: 0 }}>
                          {batchAiText}
                        </p>
                        {batchAiModel && (
                          <p className="ai-summary__meta" style={{ marginTop: "0.65rem" }}>
                            Model: <code>{batchAiModel}</code>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      )}

      {mode === "request" && (
      <section className="panel">
        <h2 className="subhead">Student claim requests</h2>
        <p className="muted-inline">
          Students submit from the public <Link to="/claim">Claim</Link> page. Approve after you verify their identity
          out-of-band, then use <strong>Actions</strong> → Claim to submit the on-chain transfer (or &quot;Fill claim form&quot;
          after approval).
        </p>
        {studentClaimReqBusy && <p className="muted-inline">Loading requests…</p>}
        {studentClaimReqErr && <div className="error">{studentClaimReqErr}</div>}
        {!studentClaimReqBusy && studentClaimReqs.length === 0 ? (
          <p className="muted-inline">No requests yet.</p>
        ) : (
          <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Student</th>
                  <th>Email</th>
                  <th>Token</th>
                  <th>Wallet</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {studentClaimReqs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">{r.created_at ? r.created_at.slice(0, 19).replace("T", " ") : "—"}</td>
                    <td>
                      {r.student_full_name || "—"}
                      <div className="muted-inline small">ID: {r.student_internal_id}</div>
                    </td>
                    <td className="small">{r.student_email}</td>
                    <td className="mono small">#{r.token_id}</td>
                    <td className="mono small" title={r.wallet_address}>
                      {r.wallet_address.slice(0, 6)}…{r.wallet_address.slice(-4)}
                    </td>
                    <td>
                      <span className="badge neutral">{r.status}</span>
                      {r.rejection_reason ? (
                        <div className="muted-inline small" title={r.rejection_reason}>
                          {r.rejection_reason.slice(0, 48)}
                          {r.rejection_reason.length > 48 ? "…" : ""}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: "wrap", gap: "0.35rem" }}>
                        {r.status === "pending" ? (
                          <>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => void approveStudentClaimRequest(r.id)}
                              disabled={accountFrozen}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => void rejectStudentClaimRequest(r.id)}
                              disabled={accountFrozen}
                            >
                              Reject
                            </button>
                          </>
                        ) : null}
                        {r.status === "approved" ? (
                          <>
                            <Link
                              className={`btn-secondary${accountFrozen ? " disabled" : ""}`}
                              style={{
                                textDecoration: "none",
                                display: "inline-flex",
                                alignItems: "center",
                                pointerEvents: accountFrozen ? "none" : undefined,
                                opacity: accountFrozen ? 0.5 : undefined,
                              }}
                              to={`/university?mode=actions&claimToken=${r.token_id}&claimWallet=${encodeURIComponent(r.wallet_address)}`}
                              aria-disabled={accountFrozen}
                              onClick={(e) => {
                                if (accountFrozen) e.preventDefault();
                              }}
                            >
                              Fill claim form
                            </Link>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => void completeStudentClaimRequest(r.id)}
                              disabled={accountFrozen}
                            >
                              Mark transferred
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {mode === "actions" && (
      <>
      <section className="panel">
        <h2 className="subhead">Claim (transfer to student &amp; lock)</h2>
        <p className="muted-inline">
          You must be connected as the issuer; the student address is only the recipient parameter.
        </p>
        <p className="muted-inline small" style={{ marginTop: "0.35rem" }}>
          The issuer wallet pays gas on Amoy — it needs a small POL balance (testnet faucet). If MetaMask shows a vague
          “estimateGas” error, check POL balance and that this wallet still owns the token.
        </p>
        <form className="stack" onSubmit={claim}>
          <div className="row two-col">
            <div className="inst-field">
              <label htmlFor="claim_tid">Token ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  #
                </span>
                <input
                  id="claim_tid"
                  value={claimTid}
                  onChange={(e) => setClaimTid(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="stu">Recipient wallet</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Wallet size={20} />
                </span>
                <input
                  id="stu"
                  className="mono"
                  value={studentWallet}
                  onChange={(e) => setStudentWallet(e.target.value)}
                  placeholder="0x…"
                  required
                />
              </div>
            </div>
          </div>
          {claimErr && <div className="error">{claimErr}</div>}
          {claimMsg && <div className="success">{claimMsg}</div>}
          <button type="submit" disabled={claimBusy || !verified || !canUseChain || accountFrozen} aria-busy={claimBusy}>
            <BusyLabel busy={claimBusy} idle="Claim & lock (soulbound)" busyLabel="Claiming…" />
          </button>
        </form>
      </section>

      <div className="inst-revoke-burn-row">
        <section className="panel">
          <h2 className="subhead">Revoke certificate</h2>
          <form className="stack" onSubmit={revoke}>
            <div className="inst-field">
              <label htmlFor="revoke_tid">Token ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Hash />
                </span>
                <input
                  id="revoke_tid"
                  value={revokeTid}
                  onChange={(e) => setRevokeTid(e.target.value)}
                  required
                />
              </div>
            </div>
            {revokeErr && <div className="error">{revokeErr}</div>}
            {revokeMsg && <div className="success">{revokeMsg}</div>}
            <button
              type="submit"
              className="btn-secondary"
              disabled={revokeBusy || !verified || !canUseChain || accountFrozen}
              aria-busy={revokeBusy}
            >
              <BusyLabel busy={revokeBusy} idle="Revoke on-chain" busyLabel="Revoking…" />
            </button>
          </form>
        </section>

        <section className="panel">
          <h2 className="subhead">Burn revoked certificate</h2>
          <form className="stack" onSubmit={burn}>
            <div className="inst-field">
              <label htmlFor="burn_tid">Token ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Hash />
                </span>
                <input
                  id="burn_tid"
                  value={burnTid}
                  onChange={(e) => setBurnTid(e.target.value)}
                  required
                />
              </div>
            </div>
            {burnErr && <div className="error">{burnErr}</div>}
            {burnMsg && <div className="success">{burnMsg}</div>}
            <button
              type="submit"
              className="btn-secondary"
              disabled={burnBusy || !verified || !canUseChain || accountFrozen}
              aria-busy={burnBusy}
            >
              <BusyLabel busy={burnBusy} idle="Burn token" busyLabel="Burning…" />
            </button>
          </form>
        </section>
      </div>

      <section className="panel">
        <h2 className="subhead">Reissue certificate (revoke + new token)</h2>
        <form className="stack" onSubmit={reissue}>
          <div className="row two-col">
            <div className="inst-field">
              <label htmlFor="reissue_old">Old token ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Hash />
                </span>
                <input
                  id="reissue_old"
                  value={reissueOldTid}
                  onChange={(e) => setReissueOldTid(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="reissue_cert_id">New certificate ID</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <Tag size={18} />
                </span>
                <input
                  id="reissue_cert_id"
                  value={reissueCertId}
                  onChange={(e) => setReissueCertId(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>
          <div className="row two-col">
            <div className="inst-field">
              <label htmlFor="reissue_student">Student full name</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <User size={18} />
                </span>
                <input
                  id="reissue_student"
                  value={reissueStudentName}
                  onChange={(e) => setReissueStudentName(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="inst-field">
              <label htmlFor="reissue_degree">Degree program</label>
              <div className="inst-input-wrap">
                <span className="inst-input-icon" aria-hidden>
                  <GraduationCap size={18} />
                </span>
                <input
                  id="reissue_degree"
                  value={reissueDegreeType}
                  onChange={(e) => setReissueDegreeType(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>
          <div className="inst-field">
            <label htmlFor="reissue_date">Issue date</label>
            <div className="inst-input-wrap">
              <span className="inst-input-icon" aria-hidden>
                <CalendarDays size={18} />
              </span>
              <input
                id="reissue_date"
                value={reissueIssueDate}
                onChange={(e) => setReissueIssueDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                required
              />
            </div>
          </div>
          {reissueErr && <div className="error">{reissueErr}</div>}
          {reissueMsg && <div className="success">{reissueMsg}</div>}
          <button type="submit" disabled={reissueBusy || !verified || !canUseChain || accountFrozen} aria-busy={reissueBusy}>
            <BusyLabel busy={reissueBusy} idle="Revoke and reissue" busyLabel="Reissuing…" />
          </button>
        </form>
      </section>

      <section className="panel panel-busy-anchor">
        {eventsBusy && (
          <div className="panel-busy-overlay" role="status" aria-live="polite">
            <BrandedLoader size="md" />
            <span className="panel-busy-overlay__text">Syncing on-chain activity…</span>
          </div>
        )}
        <h2 className="subhead">Activity log</h2>
        <div className="row">
          <button
            type="button"
            onClick={() => void syncAndRefreshActivity()}
            disabled={eventsBusy || !verified || accountFrozen}
            aria-busy={eventsBusy}
          >
            <BusyLabel busy={eventsBusy} idle="Sync and refresh" busyLabel="Refreshing…" />
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
                {eventsPg.pageItems.map((ev, i) => (
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
            <TablePagination
              page={eventsPg.page}
              pageSize={eventsPg.pageSize}
              totalPages={eventsPg.totalPages}
              total={eventsPg.total}
              from={eventsPg.from}
              to={eventsPg.to}
              onPageChange={eventsPg.setPage}
              onPageSizeChange={eventsPg.setPageSize}
            />
          </div>
        )}
      </section>
      </>
      )}

      </div>

      <InstitutionBottomNav active={mode} hrefFor={institutionPortalHref} />
    </>
  );
}
