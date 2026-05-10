/** Prefer gateway URL for <img>; fall back from ipfs:// to a public gateway if needed. */
export function institutionLogoDisplayUrl(
  logoUrl: string | null | undefined,
  logoUri: string | null | undefined
): string | null {
  const gateway = (logoUrl && logoUrl.trim()) || "";
  if (gateway.startsWith("http://") || gateway.startsWith("https://")) return gateway;

  const uri = (logoUri && logoUri.trim()) || "";
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const path = uri.replace(/^ipfs:\/\//, "");
    return `https://gateway.pinata.cloud/ipfs/${path}`;
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return null;
}
