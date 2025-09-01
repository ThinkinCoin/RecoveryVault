// src/services/vaultAdmin.js
import { getWriteContract } from "@/services/vaultCore";

export async function setDailyLimit(signer, usdAmount){
  const v = getWriteContract(signer);
  const tx = await v.setDailyLimit(usdAmount);
  return await tx.wait();
}

export async function setDevWallet(signer, wallet){
  const v = getWriteContract(signer);
  const tx = await v.setDevWallet(wallet);
  return await tx.wait();
}

export async function setFeeTiers(signer, thresholds, bpsArr){
  const v = getWriteContract(signer);
  const tx = await v.setFeeTiers(thresholds, bpsArr);
  return await tx.wait();
}

export async function setFixedUsdPrice(signer, token, usdPrice18){
  const v = getWriteContract(signer);
  const tx = await v.setFixedUsdPrice(token, usdPrice18);
  return await tx.wait();
}

export async function setLocked(signer, status){
  const v = getWriteContract(signer);
  const tx = await v.setLocked(status);
  return await tx.wait();
}

export async function setMerkleRoot(signer, root){
  const v = getWriteContract(signer);
  const tx = await v.setMerkleRoot(root);
  return await tx.wait();
}

export async function setOracle(signer, addr){
  const v = getWriteContract(signer);
  const tx = await v.setOracle(addr);
  return await tx.wait();
}

export async function setRmcWallet(signer, wallet){
  const v = getWriteContract(signer);
  const tx = await v.setRmcWallet(wallet);
  return await tx.wait();
}

export async function setSupportedToken(signer, token, allowed){
  const v = getWriteContract(signer);
  const tx = await v.setSupportedToken(token, allowed);
  return await tx.wait();
}

export async function startNewRound(signer, roundId){
  const v = getWriteContract(signer);
  const tx = await v.startNewRound(roundId);
  return await tx.wait();
}

export async function transferOwnership(signer, newOwner){
  const v = getWriteContract(signer);
  const tx = await v.transferOwnership(newOwner);
  return await tx.wait();
}

export async function renounceOwnership(signer){
  const v = getWriteContract(signer);
  const tx = await v.renounceOwnership();
  return await tx.wait();
}

export async function withdrawFunds(signer, token){
  const v = getWriteContract(signer);
  const tx = await v.withdrawFunds(token);
  return await tx.wait();
}
