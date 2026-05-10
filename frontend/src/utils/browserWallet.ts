import { BrowserProvider, type Eip1193Provider } from "ethers";
import { apiJson } from "../api/client";

export const AMOY_PUBLIC_RPC = "https://polygon-amoy-bor-rpc.publicnode.com";

/** MetaMask and other injected wallets expose event subscriptions beyond EIP-1193 typings. */
export type InjectedEthereum = Eip1193Provider & {
  on?(event: "accountsChanged", handler: (accounts: string[]) => void): void;
  on?(event: "chainChanged", handler: () => void): void;
  removeListener?(event: "accountsChanged", handler: (accounts: string[]) => void): void;
  removeListener?(event: "chainChanged", handler: () => void): void;
};

export function getInjectedProvider(): InjectedEthereum | null {
  const eth = (window as { ethereum?: InjectedEthereum }).ethereum;
  return eth ?? null;
}

export function friendlyWalletError(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught ?? "Wallet request failed");
  const lower = raw.toLowerCase();
  if (lower.includes("rate limited") || lower.includes("too many requests")) {
    return (
      "Wallet RPC is rate-limited on Polygon Amoy. In MetaMask, open Polygon Amoy network settings " +
      "and switch RPC URL to https://polygon-amoy-bor-rpc.publicnode.com, then retry."
    );
  }
  return raw;
}

export async function ensureChain(ethereum: Eip1193Provider, chainId: number): Promise<void> {
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

type UniMe = { wallet_address: string; chain_id: number; status: string };

/**
 * Request accounts via the injected wallet. For university sessions, switches to the
 * institution chain and ensures the active account matches the registered issuer address.
 */
export async function connectInjectedWallet(universityIssuerMode: boolean): Promise<{ address: string; chainId: bigint }> {
  const ethereum = getInjectedProvider();
  if (!ethereum) {
    throw new Error("No injected wallet found. Install MetaMask or another compatible wallet.");
  }
  await ethereum.request({ method: "eth_requestAccounts" });

  if (universityIssuerMode) {
    const me = await apiJson<UniMe>("/api/university/me");
    await ensureChain(ethereum, me.chain_id);
    const provider = new BrowserProvider(ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== me.chain_id) {
      throw new Error(`Wrong network. Switch the wallet to chain ${me.chain_id} (Polygon Amoy).`);
    }
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    if (address.toLowerCase() !== me.wallet_address.toLowerCase()) {
      throw new Error("Connected wallet does not match your registered issuer address.");
    }
    return { address, chainId: network.chainId };
  }

  const provider = new BrowserProvider(ethereum);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  return { address, chainId: network.chainId };
}

export async function readConnectedAddress(): Promise<string | null> {
  const ethereum = getInjectedProvider();
  if (!ethereum) return null;
  try {
    const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}
