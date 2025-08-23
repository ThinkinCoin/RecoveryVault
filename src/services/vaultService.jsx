import { ethers } from "ethers";
import RecoveryVaultABI from "@/ui/abi/RecoveryVaultABI.json";

const VAULT = import.meta.env.VITE_VAULT_ADDRESS;

// Util: instancia contrato
export function getVaultContract(providerOrSigner) {
  if (!providerOrSigner) throw new Error("providerOrSigner ausente");
  return new ethers.Contract(VAULT, RecoveryVaultABI, providerOrSigner);
}

// Ler infos básicas
export async function getRoundInfo(provider) {
  return await getVaultContract(provider).getRoundInfo();
}
export async function getDailyLimitUsd(provider) {
  return await getVaultContract(provider).dailyLimitUsd();
}
export async function getUserLimit(provider, wallet) {
  return await getVaultContract(provider).getUserLimit(wallet);
}
export async function getSupportedTokens(provider) {
  return await getVaultContract(provider).getSupportedTokens();
}
export async function getVaultBalances(provider) {
  return await getVaultContract(provider).getVaultBalances();
}
export async function getVaultAddrs(provider) {
  const c = getVaultContract(provider);
  const [wone, usdc] = await Promise.all([c.wONE(), c.usdc()]);
  return { wone, usdc };
}
export async function isLocked(provider) {
  return await getVaultContract(provider).isLocked();
}
export async function owner(provider) {
  return await getVaultContract(provider).owner();
}

// DECIMALS util
export async function getTokenDecimals(provider, token) {
  if (!token || token === ethers.ZeroAddress) return 18;
  const erc = new ethers.Contract(token, ["function decimals() view returns (uint8)"], provider);
  try { return Number(await erc.decimals()); } catch { return 18; }
}

// Quote (assinatura nova com `user` no 1º arg)
export async function quoteRedeem(provider, user, tokenIn, amountInBN, redeemIn, proof = []) {
  const c = getVaultContract(provider);
  return await c.quoteRedeem(user, tokenIn, amountInBN, redeemIn, proof);
}

// Redeem (payable se tokenIn == address(0))
export async function redeem(signer, tokenIn, amountInBN, redeemIn, proof = []) {
  const c = getVaultContract(signer);
  const overrides = {};
  if (tokenIn === ethers.ZeroAddress) {
    overrides.value = amountInBN; // enviar ONE nativo
  }
  const tx = await c.redeem(tokenIn, amountInBN, redeemIn, proof, overrides);
  return await tx.wait();
}

// Admin (já que você tem AdminDash)
export async function setDailyLimit(amountWholeUsd, signer) {
  const tx = await getVaultContract(signer).setDailyLimit(amountWholeUsd);
  return await tx.wait();
}
export async function setLocked(status, signer) {
  const tx = await getVaultContract(signer).setLocked(status);
  return await tx.wait();
}
export async function startNewRound(roundId, signer) {
  const tx = await getVaultContract(signer).startNewRound(roundId);
  return await tx.wait();
}
export async function setDevWallet(addr, signer) {
  const tx = await getVaultContract(signer).setDevWallet(addr);
  return await tx.wait();
}
export async function setRmcWallet(addr, signer) {
  const tx = await getVaultContract(signer).setRmcWallet(addr);
  return await tx.wait();
}
export async function setOracle(addr, signer) {
  const tx = await getVaultContract(signer).setOracle(addr);
  return await tx.wait();
}
export async function setMerkleRoot(root, signer) {
  const tx = await getVaultContract(signer).setMerkleRoot(root);
  return await tx.wait();
}
export async function setSupportedToken(token, allowed, signer) {
  const tx = await getVaultContract(signer).setSupportedToken(token, allowed);
  return await tx.wait();
}
export async function setFeeTiers(thresholdsBigIntArray, bpsArray, signer) {
  const tx = await getVaultContract(signer).setFeeTiers(thresholdsBigIntArray, bpsArray);
  return await tx.wait();
}
export async function withdrawFunds(token, signer) {
  const tx = await getVaultContract(signer).withdrawFunds(token);
  return await tx.wait();
}
export async function transferOwnership(newOwner, signer) {
  if (!newOwner) throw new Error("newOwner is required");
  const contract = getVaultContract(signer);
  const tx = await contract.transferOwnership(newOwner);
  return await tx.wait();
}

// ===== Fixed USD Price (per supported token) =====
// Read current fixed price (18 decimals) for a token; returns BigInt
export async function getFixedUsdPrice(provider, token) {
  if (!token) throw new Error("token is required");
  return await getVaultContract(provider).fixedUsdPrice(token);
}

// Set fixed USD price with 18 decimals (onlyOwner)
// Example: setFixedUsdPrice(token, ethers.parseUnits("1.23", 18), signer)
export async function setFixedUsdPrice(token, usdPrice18, signer) {
  if (!token) throw new Error("token is required");
  if (usdPrice18 == null) throw new Error("usdPrice18 is required (18 decimals)");
  const tx = await getVaultContract(signer).setFixedUsdPrice(token, usdPrice18);
  return await tx.wait();
}

// Helpers to convert to/from 18-decimal price values
export function toUsdPrice18(n) {
  return ethers.parseUnits(String(n ?? "0"), 18);
}
export function fromUsdPrice18(bn) {
  try { return Number(ethers.formatUnits(bn ?? 0n, 18)); } catch { return 0; }
}
