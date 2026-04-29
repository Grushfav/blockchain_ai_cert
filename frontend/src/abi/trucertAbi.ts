export const TRUCERT_ABI = [
  "function nextTokenId() view returns (uint256)",
  "event CertificateMinted(uint256 indexed tokenId, address indexed issuer, string tokenURI, bytes32 coreHash, string certId)",
  "function mintToEscrow(string uri, bytes32 coreHash, string certId) returns (uint256)",
  "function claim(uint256 tokenId, address student)",
  "function revokeCertificate(uint256 tokenId)",
  "function burnCertificate(uint256 tokenId)",
  "function revokeAndReissue(uint256 oldTokenId, string newUri, bytes32 newCoreHash, string newCertId) returns (uint256)",
  "function whitelistedIssuers(address) view returns (bool)",
] as const;
