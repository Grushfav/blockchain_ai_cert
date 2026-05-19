const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TrueCert", function () {
  async function deploy() {
    const [admin, uni, student, other, platform] = await ethers.getSigners();
    const TrueCert = await ethers.getContractFactory("TrueCert");
    const c = await TrueCert.deploy(admin.address);
    await c.waitForDeployment();
    await c.connect(admin).setIssuerWhitelisted(uni.address, true);
    await c.connect(admin).setMinter(platform.address);
    return { c, admin, uni, student, other, platform };
  }

  it("minter mints for whitelisted issuer; token in issuer wallet", async function () {
    const { c, uni, platform } = await deploy();
    const uri = "ipfs://QmTest";
    const coreHash = ethers.keccak256(ethers.toUtf8Bytes("core-1"));
    await c.connect(platform).mintForIssuer(uni.address, uri, coreHash, "CERT-1");
    expect(await c.ownerOf(1n)).to.equal(uni.address);
    expect(await c.issuerOf(1n)).to.equal(uni.address);
    expect(await c.locked(1n)).to.equal(false);
  });

  it("mints with global token ids, claims as soulbound, and blocks transfers", async function () {
    const { c, uni, student, other, platform } = await deploy();
    const uri = "ipfs://QmTest";
    const coreHash = ethers.keccak256(ethers.toUtf8Bytes("core-1"));
    await c.connect(platform).mintForIssuer(uni.address, uri, coreHash, "CERT-1");
    expect(await c.ownerOf(1n)).to.equal(uni.address);
    expect(await c.locked(1n)).to.equal(false);

    await c.connect(uni).claim(1n, student.address);
    expect(await c.ownerOf(1n)).to.equal(student.address);
    expect(await c.locked(1n)).to.equal(true);

    await expect(c.connect(student).transferFrom(student.address, other.address, 1n)).to.be.reverted;
  });

  it("revokes and blocks transfers", async function () {
    const { c, uni, student, platform } = await deploy();
    await c
      .connect(platform)
      .mintForIssuer(uni.address, "ipfs://x", ethers.keccak256(ethers.toUtf8Bytes("core-2")), "CERT-2");
    await c.connect(uni).claim(1n, student.address);
    await c.connect(uni).revokeCertificate(1n);
    expect(await c.valid(1n)).to.equal(false);
    await expect(c.connect(student).transferFrom(student.address, uni.address, 1n)).to.be.reverted;
  });

  it("burns revoked tokens issuer-only", async function () {
    const { c, uni, student, other, platform } = await deploy();
    await c
      .connect(platform)
      .mintForIssuer(uni.address, "ipfs://x", ethers.keccak256(ethers.toUtf8Bytes("core-3")), "CERT-3");
    await c.connect(uni).claim(1n, student.address);
    await c.connect(uni).revokeCertificate(1n);
    await expect(c.connect(other).burnCertificate(1n)).to.be.reverted;
    await c.connect(uni).burnCertificate(1n);
    await expect(c.ownerOf(1n)).to.be.reverted;
  });

  it("reissues by revoking old token and minting a new one (issuer)", async function () {
    const { c, uni, platform } = await deploy();
    await c
      .connect(platform)
      .mintForIssuer(uni.address, "ipfs://old", ethers.keccak256(ethers.toUtf8Bytes("core-old")), "CERT-OLD");
    const tx = await c
      .connect(uni)
      .revokeAndReissue(
        1n,
        "ipfs://new",
        ethers.keccak256(ethers.toUtf8Bytes("core-new")),
        "CERT-NEW"
      );
    await tx.wait();
    expect(await c.valid(1n)).to.equal(false);
    expect(await c.ownerOf(2n)).to.equal(uni.address);
    expect(await c.valid(2n)).to.equal(true);
  });

  it("minter cannot mint for non-whitelisted issuer", async function () {
    const { c, other, platform, admin } = await deploy();
    const coreHash = ethers.keccak256(ethers.toUtf8Bytes("x"));
    await expect(
      c.connect(platform).mintForIssuer(other.address, "ipfs://u", coreHash, "C")
    ).to.be.revertedWithCustomError(c, "NotWhitelistedIssuer");
  });

  it("non-minter cannot call mintForIssuer", async function () {
    const { c, uni, other } = await deploy();
    const coreHash = ethers.keccak256(ethers.toUtf8Bytes("x"));
    await expect(
      c.connect(other).mintForIssuer(uni.address, "ipfs://u", coreHash, "C")
    ).to.be.revertedWithCustomError(c, "NotMinter");
    await expect(
      c.connect(uni).mintForIssuer(uni.address, "ipfs://u", coreHash, "C")
    ).to.be.revertedWithCustomError(c, "NotMinter");
  });
});
