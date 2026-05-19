const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer signer available. Set DEPLOYER_PRIVATE_KEY in backend/.env or your shell (64-char hex; 0x optional)."
    );
  }
  const nonce = await deployer.getNonce("pending");
  console.log("Deploying with:", deployer.address, "| nonce (pending):", nonce);

  const TrueCert = await hre.ethers.getContractFactory("TrueCert");
  const trueCert = await TrueCert.deploy(deployer.address, { nonce });
  await trueCert.waitForDeployment();

  const address = await trueCert.getAddress();
  console.log("TrueCert deployed to:", address);
  console.log("Owner (platform admin):", deployer.address);

  const minter = process.env.TRUECERT_MINTER_ADDRESS;
  if (minter) {
    const tx = await trueCert.setMinter(minter);
    await tx.wait();
    console.log("Platform minter set to:", minter);
  } else {
    console.log("No TRUECERT_MINTER_ADDRESS — call setMinter(<hot_wallet>) as owner before platform mints.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
