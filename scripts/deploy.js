const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer signer available. Set DEPLOYER_PRIVATE_KEY in your shell environment."
    );
  }
  console.log("Deploying with:", deployer.address);

  const TruCert = await hre.ethers.getContractFactory("TruCert");
  const truCert = await TruCert.deploy(deployer.address);
  await truCert.waitForDeployment();

  const address = await truCert.getAddress();
  console.log("TruCert deployed to:", address);
  console.log("Owner (platform admin):", deployer.address);

  const minter = process.env.TRUCERT_MINTER_ADDRESS;
  if (minter) {
    const tx = await truCert.setMinter(minter);
    await tx.wait();
    console.log("Platform minter set to:", minter);
  } else {
    console.log("No TRUCERT_MINTER_ADDRESS — call setMinter(<hot_wallet>) as owner before platform mints.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
