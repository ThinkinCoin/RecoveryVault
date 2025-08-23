// Recovery Dex — Vault service (ethers v6)
// All logs/messages in English. Align method names with your ABI if they differ.

import { ethers } from "ethers";
import vaultAbi from "../ui/abi/RecoveryVaultABI.json";

export const ZERO = 0n;
const ONE_DAY = 24n * 60n * 60n; // fallback if ROUND_DELAY() is unavailable

/** Get default provider (BrowserProvider if window.ethereum exists). */
export function getDefaultProvider() {
  try {
    if (typeof window !== "undefined" && window.ethereum) {
      return new ethers.BrowserProvider(window.ethereum);
    }
    return null;
  } catch (err) {
    console.error("[vaultService] getDefaultProvider error:", err);
    return null;
  }
}

/**
 * Sets the fixed USD price (18 decimals) for a supported token.
 * @param {string} token Address of the token
 * @param {string|number} usdPrice18 Fixed price in 1e18 scale (e.g., "500000000000000000" for $0.50)
 * @param {Signer} signer Signer connected to RecoveryVault
 */
export async function setFixedUsdPrice(token, usdPrice18, signer) {
  const contract = getVaultContract(signer);
  const tx = await contract.setFixedUsdPrice(token, usdPrice18);
  return await tx.wait();
}


export async function getUserLimit(user, providerOrSigner) {
  try {
    const prov = providerOrSigner || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const vault = getVaultContract(prov);
    return await vault.getUserLimit(user);
  } catch (err) {
    console.error("[vaultService] getUserLimit error:", err);
    return ZERO;
  }
}


/** Returns RecoveryVault address from env. */
export function getVaultAddress() {
  const addr = import.meta.env.VITE_VAULT_ADDRESS;
  if (!addr) throw new Error("VITE_VAULT_ADDRESS is not set");
  return addr;
}

/** Returns RecoveryVault contract bound to signer/provider. */
export function getVaultContract(signerOrProvider) {
  if (!signerOrProvider) throw new Error("signerOrProvider is required");
  return new ethers.Contract(getVaultAddress(), vaultAbi, signerOrProvider);
}

/**
 * Read helpers
 */
export async function getDailyLimit(providerOrSigner, user) {
  try {
    const prov = providerOrSigner || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const contract = getVaultContract(prov);

    const [limit, remaining, lastRedeem] = await Promise.all([
      (async () => { try { return await contract.dailyLimitUsd(); } catch {} return ZERO; })(),
      (async () => { try { return user ? await contract.getUserLimit(user) : ZERO; } catch {} return ZERO; })(),
      (async () => { try { return user ? await contract.lastRedeemTimestamp(user) : 0n; } catch {} return 0n; })(),
    ]);

    const used = (limit ?? ZERO) > (remaining ?? ZERO) ? (limit - remaining) : ZERO;
    const lastRedeemTime = Number(lastRedeem || 0n);
    const now = Math.floor(Date.now() / 1000);
    const resetSeconds = lastRedeemTime ? Math.max(0, (lastRedeemTime + 86400) - now) : 0;

    return { limit: limit ?? ZERO, used, lastRedeem: lastRedeemTime, resetSeconds };
  } catch (err) {
    console.error("[vaultService] getDailyLimit error:", err);
    return { limit: ZERO, used: ZERO, lastRedeem: 0, resetSeconds: 0 };
  }
}

export async function getFeeTier(provider, user, amount) {
  try {
    const prov = provider || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const vault = getVaultContract(prov);
    try { return Number(await vault.getFeeBps(user, amount)); } catch {}
    return 100; // 1% fallback
  } catch (err) {
    console.error("[vaultService] getFeeTier error:", err);
    return 100;
  }
}

export async function fetchMerkleProof(user) {
  try {
    // TODO: replace with real API when available
    return [];
  } catch (err) {
    console.error("[vaultService] fetchMerkleProof error:", err);
    return [];
  }
}

export async function quoteRedeem(providerOrSigner, tokenIn, amount, redeemInOrPreferUSDC = true, proof = []) {
  try {
    const prov = providerOrSigner || getDefaultProvider();
    if (!prov) throw new Error("provider not available");

    const signer = prov.getSigner ? await prov.getSigner() : null;
    const user = signer?.getAddress ? await signer.getAddress() : ethers.ZeroAddress;

    const vault = getVaultContract(signer || prov);

    let redeemIn = redeemInOrPreferUSDC;
    if (typeof redeemIn === "boolean" || redeemIn == null) {
      const preferUSDC = redeemIn !== false;
      let usdcAddr = null, woneAddr = null;
      try { usdcAddr = await vault.usdc(); } catch {}
      try { woneAddr = await vault.wONE(); } catch {}
      redeemIn = preferUSDC ? (usdcAddr || ethers.ZeroAddress) : (woneAddr || ethers.ZeroAddress);
    }

    const res = await vault.quoteRedeem(user, tokenIn, amount, redeemIn, proof);
    return {
      whitelisted: Boolean(res?.[0]),
      roundIsActive: Boolean(res?.[1]),
      feeAmount: res?.[2] ?? ZERO,
      refundAmount: res?.[3] ?? ZERO,
      userLimitUsdBefore: res?.[4] ?? ZERO,
      userLimitUsdAfter: res?.[5] ?? ZERO,
      usdValue: res?.[6] ?? ZERO,
      tokenInDecimals: Number(res?.[7] ?? 0),
      redeemInDecimals: Number(res?.[8] ?? 0),
      oraclePrice: res?.[9] ?? ZERO,
      oracleDecimals: Number(res?.[10] ?? 0),
      redeemIn,
    };
  } catch (err) {
    console.error("[vaultService] quoteRedeem error:", err);
    return {
      whitelisted: false,
      roundIsActive: false,
      feeAmount: ZERO,
      refundAmount: ZERO,
      userLimitUsdBefore: ZERO,
      userLimitUsdAfter: ZERO,
      usdValue: ZERO,
      tokenInDecimals: 0,
      redeemInDecimals: 0,
      oraclePrice: ZERO,
      oracleDecimals: 0,
      redeemIn: null,
    };
  }
}


/**
 * Execute redemption. Wrapper that tries common signatures:
 *  - redeem(token, amount, merkleProof)
 *  - redeem(token, amount, receiver, receiveOne, merkleProof)
 *  - redeemWithProof(token, amount, merkleProof)
 * Returns { hash } or null.
 */
export async function redeem(tokenAddress, amount, a3 = null, a4 = null, a5 = null) {
  try {
    // Overloads:
    // (token, amount, proof, signer)
    // (token, amount, redeemIn, proof, signer)
    let redeemIn = null;
    let merkleProof = [];
    let signerOrProvider = null;

    if (Array.isArray(a3)) {
      merkleProof = a3;
      signerOrProvider = a4;
    } else {
      redeemIn = a3;
      merkleProof = Array.isArray(a4) ? a4 : [];
      signerOrProvider = a5;
    }

    let prov = signerOrProvider || getDefaultProvider();
    if (!prov) throw new Error("No provider available");
    const signer = prov.getSigner ? await prov.getSigner() : prov;

    const vault = getVaultContract(signer);

    if (!redeemIn) {
      try { redeemIn = await vault.usdc(); } catch {}
    }

    let tx;
    try {
      // Assinatura do contrato atual
      tx = await vault.redeem(tokenAddress, amount, redeemIn, merkleProof);
    } catch (e) {
      // Fallback para ABIs antigas (3-arg)
      try { tx = await vault.redeem(tokenAddress, amount, merkleProof); } catch {}
      if (!tx) throw e;
    }

    console.info("[vaultService] redeem submitted:", tx.hash);
    const receipt = await tx.wait();
    console.info("[vaultService] redeem confirmed in block:", receipt.blockNumber);
    return { hash: tx.hash };
  } catch (err) {
    console.error("[vaultService] redeem error:", err);
    return null;
  }
}


/** Subscribe to on-chain events. Returns an unsubscribe fn. */
export function watchEvents(cb = {}, provider) {
  let prov = provider || getDefaultProvider();
  if (!prov) {
    console.error("[vaultService] watchEvents: provider not available");
    return () => {};
  }
  const contract = getVaultContract(prov);
  const off = [];
  try {
    if (cb.onBurnToken) {
      const h = (...args) => cb.onBurnToken?.(normalizeEvent(args));
      contract.on("BurnToken", h);
      off.push(() => contract.off("BurnToken", h));
    }
    if (cb.onRedeemProcessed) {
      const h = (...args) => cb.onRedeemProcessed?.(normalizeEvent(args));
      contract.on("RedeemProcessed", h);
      off.push(() => contract.off("RedeemProcessed", h));
    }
    if (cb.onNewRoundStarted) {
      const h = (...args) => cb.onNewRoundStarted?.(normalizeEvent(args));
      contract.on("NewRoundStarted", h);
      off.push(() => contract.off("NewRoundStarted", h));
    }
  } catch (err) {
    console.error("[vaultService] watchEvents error:", err);
  }
  return () => { off.forEach((fn) => { try { fn(); } catch {} }); };
}

function normalizeEvent(args) {
  const evt = args?.[args.length - 1];
  const data = Array.isArray(args) ? args.slice(0, -1) : [];
  return {
    data,
    txHash: evt?.log?.transactionHash || evt?.transactionHash,
    blockNumber: evt?.log?.blockNumber || evt?.blockNumber,
    log: evt,
  };
}

/** Utilities */
export function parseUnitsSafe(value, decimals = 18) {
  try {
    return ethers.parseUnits(String(value ?? "0"), decimals);
  } catch (err) {
    console.error("[vaultService] parseUnitsSafe error:", err);
    return 0n;
  }
}

export function formatUnitsSafe(value, decimals = 18) {
  try {
    return ethers.formatUnits(value ?? 0n, decimals);
  } catch (err) {
    console.error("[vaultService] formatUnitsSafe error:", err);
    return "0";
  }
}

// --- Admin helpers ---
export async function setDailyLimit(amount, signer) {
  const c = getVaultContract(signer);
  return c.setDailyLimit(amount);
}
export async function setLocked(status, signer) {
  const c = getVaultContract(signer);
  return c.setLocked(status);
}
export async function startNewRound(roundId, signer) {
  const c = getVaultContract(signer);
  return c.startNewRound(roundId);
}
export async function setDevWallet(addr, signer) {
  const c = getVaultContract(signer);
  return c.setDevWallet(addr);
}
export async function setRmcWallet(addr, signer) {
  const c = getVaultContract(signer);
  return c.setRmcWallet(addr);
}
export async function setOracle(addr, signer) {
  const c = getVaultContract(signer);
  return c.setOracle(addr);
}
export async function setMerkleRoot(root, signer) {
  const c = getVaultContract(signer);
  return c.setMerkleRoot(root);
}
export async function setSupportedToken(addr, allowed, signer) {
  const c = getVaultContract(signer);
  return c.setSupportedToken(addr, allowed);
}
export async function setFeeTiers(thresholds, bps, signer) {
  const c = getVaultContract(signer);
  return c.setFeeTiers(thresholds, bps);
}
export async function withdrawFunds(token, signer) {
  const c = getVaultContract(signer);
  return c.withdrawFunds(token);
}

/** High-level vault status */
export async function getVaultStatus(provider) {
  try {
    const prov = provider || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const vault = getVaultContract(prov);
    const [paused, locked, roundStart, roundFunds, roundDelay] = await Promise.all([
      (async () => { try { return Boolean(await vault.paused()); } catch { return false; } })(),
      (async () => { try { return Boolean(await vault.isLocked()); } catch { return false; } })(),
      (async () => { try { return await vault.roundStart(); } catch { return 0n; } })(),
      (async () => { try { return await vault.roundFunds(); } catch { return 0n; } })(),
      (async () => { try { return await vault.ROUND_DELAY(); } catch { return ONE_DAY; } })(),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const nextUnlockAt = locked ? roundStart : 0n;
    const roundActive = Boolean(!paused && !locked && now >= roundStart && roundFunds > 0n);
    const roundEnd = 0n; // not exposed

    return { paused, locked, roundActive, nextUnlockAt, roundStart, roundEnd, roundFunds, roundDelay };
  } catch (err) {
    console.error("[vaultService] getVaultStatus error:", err);
    return { paused: false, locked: false, roundActive: false, nextUnlockAt: 0n, roundStart: 0n, roundEnd: 0n, roundFunds: 0n, roundDelay: ONE_DAY };
  }
}
