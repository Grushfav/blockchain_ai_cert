// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TruCert
 * @notice Academic certificates as ERC-721 tokens with escrow (university-held) and soulbound (locked) states.
 * @dev Minimal on-chain facts: issuer, ownership, locked, validity, metadata URI. Details live off-chain (IPFS JSON).
 */
contract TruCert is ERC721, ERC721URIStorage, Ownable {
    uint256 public nextTokenId = 1;

    /// @notice Original issuing university wallet (set at mint, immutable).
    mapping(uint256 tokenId => address issuer) public issuerOf;
    mapping(uint256 tokenId => bytes32 coreHashOf) public coreHashOf;

    /// @notice After the student claims, the token becomes non-transferable (soulbound).
    mapping(uint256 tokenId => bool locked) public locked;

    /// @notice False after revokeCertificate — blocks transfers and marks credential invalid.
    mapping(uint256 tokenId => bool valid) public valid;

    /// @notice Only these addresses may mint (verified universities).
    mapping(address issuer => bool) public whitelistedIssuers;

    error Soulbound();
    error NotWhitelistedIssuer();
    error InvalidToken();
    error NotIssuer();

    event IssuerWhitelisted(address indexed issuer);
    event IssuerRemoved(address indexed issuer);
    event CertificateMinted(
        uint256 indexed tokenId,
        address indexed issuer,
        string tokenURI,
        bytes32 coreHash,
        string certId
    );
    event CertificateClaimed(
        uint256 indexed tokenId,
        address indexed from,
        address indexed student
    );
    event CertificateRevoked(uint256 indexed tokenId);
    event CertificateBurned(uint256 indexed tokenId, address indexed issuer);
    event CertificateReissued(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        address indexed issuer
    );

    constructor(address initialOwner) ERC721("TruCert Certificate", "TCERT") Ownable(initialOwner) {}

    function setIssuerWhitelisted(address issuer, bool allowed) external onlyOwner {
        whitelistedIssuers[issuer] = allowed;
        if (allowed) emit IssuerWhitelisted(issuer);
        else emit IssuerRemoved(issuer);
    }

    /**
     * @notice Mint into escrow: token is held by the university (`msg.sender`) until `claim`.
     * @param uri Metadata URI (IPFS gateway path or ipfs:// CID).
     * @param coreHash Hash of canonical academic fields.
     */
    function mintToEscrow(
        string calldata uri,
        bytes32 coreHash,
        string calldata certId
    ) external returns (uint256 tokenId) {
        if (!whitelistedIssuers[msg.sender]) revert NotWhitelistedIssuer();
        tokenId = nextTokenId;
        nextTokenId += 1;
        issuerOf[tokenId] = msg.sender;
        coreHashOf[tokenId] = coreHash;
        valid[tokenId] = true;
        locked[tokenId] = false;
        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
        emit CertificateMinted(tokenId, msg.sender, uri, coreHash, certId);
    }

    /**
     * @notice Student provides a wallet; university moves the token and locks it (soulbound).
     */
    function claim(uint256 tokenId, address student) external {
        address issuer = issuerOf[tokenId];
        if (issuer == address(0)) revert InvalidToken();
        if (ownerOf(tokenId) != msg.sender) revert InvalidToken();
        if (locked[tokenId]) revert Soulbound();
        _transfer(msg.sender, student, tokenId);
        locked[tokenId] = true;
        emit CertificateClaimed(tokenId, msg.sender, student);
    }

    /**
     * @notice Revoke validity — issuer only.
     */
    function revokeCertificate(uint256 tokenId) external {
        address issuer = issuerOf[tokenId];
        if (issuer == address(0)) revert InvalidToken();
        if (msg.sender != issuer) revert NotIssuer();
        valid[tokenId] = false;
        emit CertificateRevoked(tokenId);
    }

    /**
     * @notice Burn a credential from escrow/student wallet after revocation.
     */
    function burnCertificate(uint256 tokenId) external {
        address issuer = issuerOf[tokenId];
        if (issuer == address(0)) revert InvalidToken();
        if (msg.sender != issuer) revert NotIssuer();
        if (valid[tokenId]) revert InvalidToken();
        _burn(tokenId);
        emit CertificateBurned(tokenId, msg.sender);
    }

    /**
     * @notice Revoke old token and issue corrected token with fresh metadata.
     */
    function revokeAndReissue(
        uint256 oldTokenId,
        string calldata newUri,
        bytes32 newCoreHash,
        string calldata newCertId
    ) external returns (uint256 newTokenId) {
        address issuer = issuerOf[oldTokenId];
        if (issuer == address(0)) revert InvalidToken();
        if (msg.sender != issuer) revert NotIssuer();
        valid[oldTokenId] = false;
        emit CertificateRevoked(oldTokenId);

        newTokenId = nextTokenId;
        nextTokenId += 1;
        issuerOf[newTokenId] = msg.sender;
        coreHashOf[newTokenId] = newCoreHash;
        valid[newTokenId] = true;
        locked[newTokenId] = false;
        _safeMint(msg.sender, newTokenId);
        _setTokenURI(newTokenId, newUri);
        emit CertificateMinted(newTokenId, msg.sender, newUri, newCoreHash, newCertId);
        emit CertificateReissued(oldTokenId, newTokenId, msg.sender);
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (!valid[tokenId]) revert InvalidToken();
            if (locked[tokenId]) revert Soulbound();
        }
        return super._update(to, tokenId, auth);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
