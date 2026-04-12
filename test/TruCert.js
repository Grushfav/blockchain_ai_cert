const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TruCert", function () {
  async function deploy() {
    const [admin, uni, student, other] = await ethers.getSigners();
    const TruCert = await ethers.getContractFactory("TruCert");
    const c = await TruCert.deploy(admin.address);
    await c.waitForDeployment();
    await c.connect(admin).setIssuerWhitelisted(uni.address, true);
    return { c, admin, uni, student, other };
  }

  it("mints to escrow, claims as soulbound, and blocks transfers", async function () {
    const { c, admin, uni, student, other } = await deploy();
    const uri = "ipfs://QmTest";
    await c.connect(uni).mintToEscrow(1001n, uri);
    expect(await c.ownerOf(1001n)).to.equal(uni.address);
    expect(await c.locked(1001n)).to.equal(false);

    await c.connect(uni).claim(1001n, student.address);
    expect(await c.ownerOf(1001n)).to.equal(student.address);
    expect(await c.locked(1001n)).to.equal(true);

    await expect(c.connect(student).transferFrom(student.address, other.address, 1001n)).to.be
      .reverted;
  });

  it("revokes and blocks transfers", async function () {
    const { c, uni, student } = await deploy();
    await c.connect(uni).mintToEscrow(2002n, "ipfs://x");
    await c.connect(uni).claim(2002n, student.address);
    await c.connect(uni).revokeCertificate(2002n);
    expect(await c.valid(2002n)).to.equal(false);
    await expect(
      c.connect(student).transferFrom(student.address, uni.address, 2002n)
    ).to.be.reverted;
  });
});
