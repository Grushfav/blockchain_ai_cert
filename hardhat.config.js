require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
const fs = require("fs");

/** Load backend/.env so `npx hardhat run` works without manual $env: exports. */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

loadEnvFile(path.join(__dirname, "backend", ".env"));

function normalizePrivateKey(raw) {
  if (!raw) return "";
  const pk = String(raw).trim();
  if (pk.startsWith("0x") || pk.startsWith("0X")) return pk;
  if (/^[0-9a-fA-F]{64}$/.test(pk)) return `0x${pk}`;
  return pk;
}

const deployerKey = normalizePrivateKey(
  process.env.DEPLOYER_PRIVATE_KEY || process.env.CONTRACT_OWNER_PRIVATE_KEY
);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
};
