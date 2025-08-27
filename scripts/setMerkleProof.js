// scripts/setMerkleProof.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// 1) RPC/PK/VAULT via .env
// HARMONY_RPC_URL=https://rpc.ankr.com/harmony
// DEPLOYER_PK=0xSEU_PK
// VAULT_ADDRESS=0x...
const RPC = process.env.VITE_RPC_URL;
const PK = process.env.DEPLOYER_PKEY;
const VAULT = process.env.VITE_VAULT_ADDRESS;
if (!RPC || !PK || !VAULT) throw new Error("Set VITE_RPC_URL, DEPLOYER_PKEY, VITE_VAULT_ADDRESS in .env");

// 2) Carrega o merkleRoot do arquivo certo
// Se você usa o generateMerkle.js mostrado, ele salva:
//   - public/data/merkleRoot.json  (com { merkleRoot: "0x..." })
//   - public/data/proofs.json      (mapa addr->proof, sem root)
// Ajuste o caminho abaixo conforme seu projeto:
const rootPath = path.join(__dirname, "..", "public", "data", "merkleRoot.json");
const rootJson = JSON.parse(fs.readFileSync(rootPath, "utf8"));
const root = rootJson?.merkleRoot;
if (!root) throw new Error("merkleRoot not found in merkleRoot.json");

// 3) ABI mínima só com setMerkleRoot / merkleRoot
const VAULT_ABI = [
  "function setMerkleRoot(bytes32 newRoot) external",
  "function merkleRoot() view returns (bytes32)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 1666600000, name: "harmony" });
  const wallet = new ethers.Wallet(PK, provider);

  console.log("Deployer:", wallet.address);
  console.log("Vault:", VAULT);
  console.log("New merkleRoot:", root);

  const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  // Harmony costuma usar gas legacy; defina gasLimit/gasPrice manualmente
  const tx = await vault.setMerkleRoot(root, {
    gasLimit: 3_000_000,         // ajuste se precisar
    gasPrice: 1_000_000_000n,    // 1 gwei; ajuste conforme rede
  });
  console.log("tx sent:", tx.hash);
  const rc = await tx.wait();
  console.log("status:", rc.status);

  const onchainRoot = await vault.merkleRoot();
  console.log("on-chain merkleRoot:", onchainRoot);
  if (onchainRoot.toLowerCase() !== root.toLowerCase()) {
    throw new Error("On-chain root mismatch");
  }
  console.log("✅ Merkle root set successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
