const hre = require("hardhat");

async function main() {
  const contractAddress = process.env.TRUCERT_CONTRACT_ADDRESS;
  const minterAddress = process.env.TRUCERT_MINTER_ADDRESS;
  if (!contractAddress) {
    throw new Error("Missing TRUCERT_CONTRACT_ADDRESS in environment.");
  }
  if (!minterAddress) {
    throw new Error("Missing TRUCERT_MINTER_ADDRESS in environment.");
  }

  const [owner] = await hre.ethers.getSigners();
  if (!owner) {
    throw new Error(
      "No deployer signer available. Set DEPLOYER_PRIVATE_KEY in your shell environment."
    );
  }

  const TruCert = await hre.ethers.getContractFactory("TruCert");
  const c = TruCert.attach(contractAddress);

  console.log("Owner:", owner.address);
  console.log("Contract:", contractAddress);
  console.log("Setting minter to:", minterAddress);

  const tx = await c.connect(owner).setMinter(minterAddress);
  console.log("Tx:", tx.hash);
  await tx.wait();

  const onchain = await c.minter();
  console.log("On-chain minter:", onchain);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

