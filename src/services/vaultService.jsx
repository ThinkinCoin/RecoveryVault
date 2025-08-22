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
export async function getDailyLimit(provider, user) {
  try {
    const prov = provider || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const vault = getVaultContract(prov);
    const [limit, used] = await Promise.all([
      (async () => { try { return await vault.dailyLimit(user); } catch {} try { return await vault.dailyLimitUsd(); } catch {} return ZERO; })(),
      (async () => { try { return await vault.dailyUsed(user); } catch {} return ZERO; })(),
    ]);
    return { limit: limit ?? ZERO, used: used ?? ZERO };
  } catch (err) {
    console.error("[vaultService] getDailyLimit error:", err);
    return { limit: ZERO, used: ZERO };
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

export async function quoteRedeem(provider, tokenIn, amount, preferUSDC = true) {
  try {
    const prov = provider || getDefaultProvider();
    if (!prov) throw new Error("provider not available");
    const vault = getVaultContract(prov);
    const result = await vault.quoteRedeem(tokenIn, amount, preferUSDC);
    if (Array.isArray(result)) {
      const [outAmount, isUSDC] = result;
      return { outAmount: outAmount ?? ZERO, isUSDC: Boolean(isUSDC) };
    }
    if (typeof result === "object" && result) {
      const outAmount = result.outAmount ?? result[0] ?? ZERO;
      const isUSDC = result.isUSDC ?? result[1] ?? preferUSDC;
      return { outAmount, isUSDC: Boolean(isUSDC) };
    }
    return { outAmount: ZERO, isUSDC: preferUSDC };
  } catch (err) {
    console.error("[vaultService] quoteRedeem error:", err);
    return { outAmount: ZERO, isUSDC: preferUSDC };
  }
}

/**
 * Execute redemption. Wrapper that tries common signatures:
 *  - redeem(token, amount, merkleProof)
 *  - redeem(token, amount, receiver, receiveOne, merkleProof)
 *  - redeemWithProof(token, amount, merkleProof)
 * Returns { hash } or null.
 */
export async function redeem(tokenAddress, amount, merkleProof = [], signerOrProvider) {
  try {
    // Resolve signer
    let provider = signerOrProvider;
    if (!provider) provider = getDefaultProvider();
    if (!provider) throw new Error("No provider available");
    const signer = provider.getSigner ? await provider.getSigner() : provider;

    const vault = getVaultContract(signer);
    let tx;

    if (typeof vault.redeem === "function") {
      // Try simple 3-arg first
      try {
        tx = await vault.redeem(tokenAddress, amount, merkleProof);
      } catch (e1) {
        // Try extended signature with receiver + flag
        try {
          const to = await signer.getAddress();
          tx = await vault.redeem(tokenAddress, amount, to, false, merkleProof);
        } catch (e2) {
          throw e2;
        }
      }
    } else if (typeof vault.redeemWithProof === "function") {
      tx = await vault.redeemWithProof(tokenAddress, amount, merkleProof);
    } else {
      throw new Error("Redeem function not found in ABI");
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
