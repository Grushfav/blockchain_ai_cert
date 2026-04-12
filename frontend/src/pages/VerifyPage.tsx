import { useMemo, useState } from "react";
import { API_BASE } from "../api/client";

type OnChain = {
  issuer_address: string;
  owner_address: string;
  locked: boolean;
  valid: boolean;
  metadata_uri: string;
};

type VerifyResponse = {
  token_id: number;
  exists: boolean;
  on_chain?: OnChain;
  off_chain_metadata?: Record<string, unknown>;
  error?: string;
};

export function VerifyPage() {
  const [tokenId, setTokenId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = useMemo(() => tokenId.trim().length > 0 && !loading, [tokenId, loading]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setResult(null);
    const id = Number(tokenId.trim());
    if (!Number.isInteger(id) || id < 0) {
      setErr("Enter a valid non-negative integer token ID.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/verify/${id}`);
      const data = (await res.json()) as VerifyResponse & { error?: string };
      if (!res.ok) {
        setErr(data.error || res.statusText || "Verification failed");
        return;
      }
      setResult(data);
    } catch (caught: unknown) {
      setErr(caught instanceof Error ? caught.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <header>
        <h1>Verify certificate</h1>
        <p>
          Enter a certificate token ID to load on-chain facts and IPFS metadata (Polygon Amoy
          testnet).
        </p>
      </header>

      <section className="panel">
        <form onSubmit={verify}>
          <label htmlFor="tid">Token ID</label>
          <div className="row">
            <input
              id="tid"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 1001"
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" disabled={!canSubmit}>
              {loading ? "Checking…" : "Verify"}
            </button>
          </div>
        </form>

        {err && <div className="error">{err}</div>}

        {result && result.exists && result.on_chain && (
          <div className="result">
            <h2>On-chain</h2>
            <div className="grid">
              <div className="kv">
                <span>Issuer</span>
                <span>{result.on_chain.issuer_address}</span>
              </div>
              <div className="kv">
                <span>Owner</span>
                <span>{result.on_chain.owner_address}</span>
              </div>
              <div className="kv">
                <span>Locked (SBT)</span>
                <span>
                  {result.on_chain.locked ? (
                    <span className="badge ok">Yes</span>
                  ) : (
                    <span className="badge bad">No (escrow / transferable)</span>
                  )}
                </span>
              </div>
              <div className="kv">
                <span>Valid</span>
                <span>
                  {result.on_chain.valid ? (
                    <span className="badge ok">Valid</span>
                  ) : (
                    <span className="badge bad">Revoked</span>
                  )}
                </span>
              </div>
              <div className="kv">
                <span>Metadata URI</span>
                <span>{result.on_chain.metadata_uri}</span>
              </div>
            </div>

            {result.off_chain_metadata && (
              <div className="meta-block">
                <h3>Off-chain metadata (IPFS JSON)</h3>
                <pre className="json">{JSON.stringify(result.off_chain_metadata, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {result && !result.exists && (
          <div className="result">
            <p>No certificate exists for this token ID on the configured contract.</p>
          </div>
        )}
      </section>

      <footer>TruCert — UWI capstone · Flask API + Polygon + IPFS (Pinata)</footer>
    </>
  );
}
