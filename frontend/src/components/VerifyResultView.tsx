import { useMemo, useState } from "react";

export type FieldVerifyResponse = {
  matched: boolean;
  token_id?: number;
  core_hash?: string;
  chain_id?: number;
  contract_address?: string;
  on_chain?: {
    issuer_address?: string;
    owner_address?: string;
    locked?: boolean;
    valid?: boolean;
    metadata_uri?: string;
    core_hash?: string | null;
    exists?: boolean;
  };
  off_chain_metadata?: Record<string, unknown>;
  error?: string;
};

const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs";
const EMPTY_META: Record<string, unknown> = {};

const KNOWN_META_KEYS: { key: string; label: string }[] = [
  { key: "student_full_name", label: "Student name" },
  { key: "degree_title", label: "Degree" },
  { key: "issue_date", label: "Issue date" },
  { key: "cert_id", label: "Certificate ID" },
  { key: "institution_name", label: "Institution" },
  { key: "institution_contact_email", label: "Institution contact email" },
  { key: "institution_contact_phone", label: "Institution contact phone" },
  { key: "institution_website", label: "Institution website" },
  { key: "institution_license_id", label: "License ID" },
  { key: "institution_license_authority", label: "License authority" },
  { key: "institution_license_valid_until", label: "License valid until" },
  { key: "format", label: "Format" },
  { key: "name", label: "Name" },
  { key: "description", label: "Description" },
  { key: "verification_method", label: "Verification method" },
];

const SIG_FIELD_KEYS = new Set([
  "trucert_sig_v",
  "trucert_sig_kid",
  "trucert_sig_alg",
  "trucert_sig",
]);

function normHash(h: string | null | undefined): string {
  return (h || "").toLowerCase().replace(/^0x/i, "");
}

function ipfsUriToHttp(uri: string): string {
  const u = uri.trim();
  if (!u.startsWith("ipfs://")) return u;
  const rest = u.slice("ipfs://".length);
  const slash = rest.indexOf("/");
  const cid = slash === -1 ? rest : rest.slice(0, slash);
  const subpath = slash === -1 ? "" : rest.slice(slash);
  return `${IPFS_GATEWAY}/${cid}${subpath}`;
}

function shortenHexAddr(addr: string): string {
  const a = addr.trim();
  if (!a.startsWith("0x") || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function shortenMiddle(s: string, head = 12, tail = 10): string {
  const t = s.trim();
  if (t.length <= head + tail + 1) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

async function copyText(text: string, setHint: (s: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setHint("Copied");
    setTimeout(() => setHint(""), 1600);
  } catch {
    setHint("Copy failed");
    setTimeout(() => setHint(""), 2000);
  }
}

function CopyChip({ value, label }: { value: string; label: string }) {
  const [hint, setHint] = useState("");
  if (!value) return null;
  return (
    <span className="copy-chip-wrap">
      <button
        type="button"
        className="copy-chip"
        title={`Copy ${label}`}
        onClick={() => void copyText(value, setHint)}
      >
        Copy
      </button>
      {hint && <span className="copy-hint">{hint}</span>}
    </span>
  );
}

function AddrLine({ label, address }: { label: string; address: string }) {
  if (!address) return null;
  return (
    <div className="verify-addr-line">
      <span className="verify-addr-label">{label}</span>
      <code className="mono small" title={address}>
        {shortenHexAddr(address)}
      </code>
      <CopyChip value={address} label={label} />
    </div>
  );
}

type SigStatus = { ok: boolean; reason?: string | null; kid?: unknown };

export function VerifyResultView({ result }: { result: FieldVerifyResponse }) {
  const [showRaw, setShowRaw] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [jsonCopyHint, setJsonCopyHint] = useState("");

  const meta = result.off_chain_metadata ?? EMPTY_META;
  const metaErr = typeof meta._error === "string" ? meta._error : null;
  const sig = meta._signature as SigStatus | undefined;

  const chainId = result.chain_id ?? 80002;
  const contract = (result.contract_address || "").trim();
  const tokenId = result.token_id;

  const coreSubmitted = normHash(result.core_hash);
  const coreOnChain = normHash(result.on_chain?.core_hash ?? undefined);
  const coreMatch =
    coreSubmitted && coreOnChain
      ? coreSubmitted === coreOnChain
      : result.matched
        ? true
        : null;

  const sigBadge = useMemo(() => {
    if (metaErr) return { label: "Not checked", className: "badge neutral" as const };
    if (!sig || typeof sig.ok !== "boolean") return { label: "Missing", className: "badge neutral" as const };
    if (sig.ok) return { label: "Verified", className: "badge ok" as const };
    return { label: "Failed", className: "badge bad" as const };
  }, [metaErr, sig]);

  const onChainValid = result.on_chain?.valid === true;
  const onChainRevoked = result.on_chain?.valid === false;
  const locked = result.on_chain?.locked === true;

  const imageMain = asString(meta.image);
  const imageInst = asString(meta.institution_logo);
  const certImageUri = imageMain || imageInst;
  const certImageUrl = certImageUri.startsWith("ipfs://") ? ipfsUriToHttp(certImageUri) : certImageUri;
  const imageInstUrl = imageInst.startsWith("ipfs://") ? ipfsUriToHttp(imageInst) : imageInst;
  const showInstThumb =
    Boolean(imageInst) &&
    imageInst !== imageMain &&
    (imageInstUrl.startsWith("http") || imageInst.startsWith("ipfs://"));

  const metadataUri = (result.on_chain?.metadata_uri || "").trim();
  const ipfsLink = metadataUri.startsWith("ipfs://") ? ipfsUriToHttp(metadataUri) : metadataUri;

  const polygonscanToken =
    contract && tokenId !== undefined
      ? `https://amoy.polygonscan.com/token/${contract}/${tokenId}`
      : "";
  const polygonscanContract = contract ? `https://amoy.polygonscan.com/address/${contract}` : "";

  const extraKeys = useMemo(() => {
    const known = new Set(KNOWN_META_KEYS.map((k) => k.key));
    known.add("image");
    known.add("institution_logo");
    SIG_FIELD_KEYS.forEach((k) => known.add(k));
    return Object.keys(meta).filter(
      (k) => k !== "_signature" && k !== "_error" && !known.has(k)
    );
  }, [meta]);

  const jsonPayload = useMemo(() => JSON.stringify(result, null, 2), [result]);

  return (
    <div className="verify-result">
      <div className="verify-summary-card">
        <div className="verify-thumb-row">
          {certImageUrl ? (
            <a href={certImageUrl} target="_blank" rel="noreferrer" className="verify-thumb-link">
              <img src={certImageUrl} alt="" className="verify-thumb" />
              <span className="verify-thumb-cap">{imageMain ? "Certificate image" : "Institution image"}</span>
            </a>
          ) : (
            <div className="verify-thumb-placeholder">No image</div>
          )}
          {showInstThumb ? (
            <a href={imageInstUrl} target="_blank" rel="noreferrer" className="verify-thumb-link">
              <img src={imageInstUrl} alt="" className="verify-thumb verify-thumb-inst" />
              <span className="verify-thumb-cap">Institution logo</span>
            </a>
          ) : null}
        </div>
        <div className="verify-summary-text">
          <h3 className="verify-summary-title">{asString(meta.student_full_name) || "Certificate"}</h3>
          <p className="verify-summary-sub">{asString(meta.degree_title)}</p>
          <p className="verify-summary-sub muted">{asString(meta.institution_name)}</p>
          <p className="verify-summary-meta">
            <span>
              Cert ID: <strong>{asString(meta.cert_id) || "—"}</strong>
            </span>
            <span>
              Issued: <strong>{asString(meta.issue_date) || "—"}</strong>
            </span>
          </p>
        </div>
      </div>

      <div className="verify-badges">
        <span className={onChainValid ? "badge ok" : onChainRevoked ? "badge bad" : "badge neutral"}>
          On-chain: {onChainValid ? "Valid" : onChainRevoked ? "Revoked" : "Unknown"}
        </span>
        <span className={locked ? "badge ok" : "badge neutral"}>SBT locked: {locked ? "Yes" : "No"}</span>
        <span
          className={
            coreMatch === true ? "badge ok" : coreMatch === false ? "badge bad" : "badge neutral"
          }
          title={coreSubmitted ? `Submitted hash: 0x${coreSubmitted}` : undefined}
        >
          Core hash: {coreMatch === true ? "Pass" : coreMatch === false ? "Fail" : "Not checked"}
        </span>
        <span className={sigBadge.className} title={sig?.reason ? String(sig.reason) : undefined}>
          TruCert signature: {sigBadge.label}
        </span>
      </div>

      <div className="verify-section">
        <h4 className="verify-section-title">On-chain status</h4>
        <div className="verify-kv-grid">
          <AddrLine label="Issuer" address={result.on_chain?.issuer_address || ""} />
          <AddrLine label="Owner" address={result.on_chain?.owner_address || ""} />
        </div>
      </div>

      <div className="verify-section">
        <h4 className="verify-section-title">Proof &amp; links</h4>
        <div className="verify-kv-grid">
          <div className="kv kv-wide">
            <span>Token ID</span>
            <span>{tokenId !== undefined ? String(tokenId) : "—"}</span>
          </div>
          <div className="kv kv-wide">
            <span>Chain</span>
            <span>Polygon Amoy ({chainId})</span>
          </div>
          {contract ? (
            <div className="kv kv-wide">
              <span>Contract</span>
              <span className="verify-link-row">
                <code className="mono small" title={contract}>
                  {shortenHexAddr(contract)}
                </code>
                <CopyChip value={contract} label="contract address" />
                {polygonscanContract ? (
                  <a href={polygonscanContract} target="_blank" rel="noreferrer">
                    Polygonscan
                  </a>
                ) : null}
              </span>
            </div>
          ) : null}
          {polygonscanToken ? (
            <div className="kv kv-wide">
              <span>Token</span>
              <span>
                <a href={polygonscanToken} target="_blank" rel="noreferrer">
                  View on Polygonscan
                </a>
              </span>
            </div>
          ) : null}
          {ipfsLink ? (
            <div className="kv kv-wide">
              <span>Metadata</span>
              <span className="verify-link-row">
                <a href={ipfsLink} target="_blank" rel="noreferrer">
                  Open via IPFS gateway
                </a>
                {metadataUri.startsWith("ipfs://") ? (
                  <CopyChip value={metadataUri} label="metadata URI" />
                ) : null}
              </span>
            </div>
          ) : null}
          {result.core_hash ? (
            <div className="kv kv-wide">
              <span>Core hash</span>
              <span className="verify-link-row">
                <code
                  className="mono small"
                  title={result.core_hash.startsWith("0x") ? result.core_hash : `0x${result.core_hash}`}
                >
                  {shortenMiddle(result.core_hash.startsWith("0x") ? result.core_hash : `0x${result.core_hash}`)}
                </code>
                <CopyChip
                  value={result.core_hash.startsWith("0x") ? result.core_hash : `0x${result.core_hash}`}
                  label="core hash"
                />
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {metaErr ? (
        <div className="verify-metadata-error">
          <strong>Metadata could not be loaded</strong>
          <p>{metaErr}</p>
        </div>
      ) : null}

      {!metaErr && (
        <div className="verify-section">
          <h4 className="verify-section-title">Certificate details</h4>
          <div className="verify-kv-grid">
            {KNOWN_META_KEYS.map(({ key, label }) => {
              if (!(key in meta)) return null;
              const val = asString(meta[key]);
              if (!val) return null;
              const isUrl = /^https?:\/\//i.test(val);
              return (
                <div key={key} className="kv kv-wide">
                  <span>{label}</span>
                  <span>
                    {isUrl ? (
                      <a href={val} target="_blank" rel="noreferrer">
                        {val}
                      </a>
                    ) : (
                      val
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {extraKeys.length > 0 && (
        <div className="verify-section">
          <button type="button" className="btn-secondary verify-collapse-btn" onClick={() => setExtraOpen((o) => !o)}>
            {extraOpen ? "Hide" : "Show"} additional fields ({extraKeys.length})
          </button>
          {extraOpen && (
            <div className="verify-kv-grid verify-extra">
              {extraKeys.map((k) => (
                <div key={k} className="kv kv-wide">
                  <span>{k}</span>
                  <span className="mono small">{asString(meta[k])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="verify-raw-toggle-row">
        <button type="button" className="btn-secondary" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Hide" : "View"} raw metadata JSON
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void copyText(jsonPayload, setJsonCopyHint)}
        >
          Copy full verification JSON
        </button>
        {jsonCopyHint ? <span className="copy-hint">{jsonCopyHint}</span> : null}
      </div>
      {showRaw && (
        <pre className="json verify-raw-json">{JSON.stringify(meta, null, 2)}</pre>
      )}
    </div>
  );
}
