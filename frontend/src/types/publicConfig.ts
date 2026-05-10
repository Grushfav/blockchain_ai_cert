export type PublicKeyEntry = {
  kid: string;
  public_key_base64: string;
  public_key_hex: string;
};

/** Response shape for `GET /api/public/config` (public; no JWT). */
export type PublicConfig = {
  chain_id: number;
  network_name: string;
  contract_address: string | null;
  contract_explorer_url: string | null;
  pinata_gateway_base: string;
  active_signing_kid: string | null;
  trucert_public_keys: PublicKeyEntry[];
  updated_at: string;
  platform_minter_address?: string | null;
  eip712_domain?: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string | null;
  };
};
