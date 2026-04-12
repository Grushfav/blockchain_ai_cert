const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const TruCert = await hre.ethers.getContractFactory("TruCert");
  const truCert = await TruCert.deploy(deployer.address);
  await truCert.waitForDeployment();

  const address = await truCert.getAddress();
  console.log("TruCert deployed to:", address);
  console.log("Owner (platform admin):", deployer.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
