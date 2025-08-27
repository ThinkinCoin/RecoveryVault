// src/services/feeService.jsx
// Lightweight fee logic: fetch fee tiers from the vault and apply fee locally.
// IMPORTANT: Net USD must be computed outside (UI or redeem flow) using oracle.
//
// Exposed helpers:
//  - getFeeTiers(provider) -> { thresholds:number[], bps:number[] }
//  - selectTierForUsd(usdValue, tiers) -> { tier:number, bps:number, pct:number }
//  - calculateFee(amountIn, bps) -> { feeAmount:bigint, refundAmount:bigint }
//  - applyFeeForUsd(amountIn, usdValue, tiers) -> { feeAmount, refundAmount, bps, tier, pct }

import * as vaultService from "@/services/vaultService";

/**
 * Fetch fee tiers from the contract via vaultService.
 * The vault typically returns { thresholds: bigint[], bpsOut: number[] }.
 * We normalize to simple numbers for UI/logic. Thresholds are integer USD buckets.
 * @param {import("ethers").Provider} provider
 * @returns {Promise<{thresholds:number[], bps:number[]}>}
 */
export async function getFeeTiers(provider) {
  try {
    const raw = await vaultService.getFeeTiers(provider);
    // Accept a few shapes just in case (object or tuple-like)
    const thresholdsRaw = raw?.thresholds ?? raw?.[0] ?? [];
    const bpsRaw = raw?.bpsOut ?? raw?.bps ?? raw?.[1] ?? [];

    const thresholds = Array.from(thresholdsRaw).map((t) => Number(t));
    const bps = Array.from(bpsRaw).map((b) => Number(b));

    if (!bps.length || thresholds.length + 1 !== bps.length) {
      console.warn("[feeService] Unexpected fee tiers shape", { thresholds, bps, raw });
    }

    return { thresholds, bps };
  } catch (e) {
    console.error("[feeService] getFeeTiers error:", e);
    return { thresholds: [], bps: [] };
  }
}

/**
 * Pick active tier given an integer USD value and the tiers.
 * - Selects the first threshold where usdValue <= threshold.
 * - Otherwise, uses the last bucket (bps[last]).
 * @param {number} usdValue Integer USD value (floor-rounded outside)
 * @param {{thresholds:number[], bps:number[]}} tiers
 * @returns {{tier:number, bps:number, pct:number} | null}
 */
export function selectTierForUsd(usdValue, tiers) {
  const thresholds = Array.isArray(tiers?.thresholds) ? tiers.thresholds : [];
  const bps = Array.isArray(tiers?.bps) ? tiers.bps : [];
  if (!bps.length) return null;

  // Default to the last bucket (> highest threshold)
  let idx = bps.length - 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (usdValue <= thresholds[i]) { idx = i; break; }
  }

  const tier = idx + 1;
  const b = Number(bps[idx] ?? 0);
  return { tier, bps: b, pct: b / 100 };
}

/**
 * Apply fee in token units, using basis points.
 * @param {bigint} amountIn Amount in token units (same decimals for fee/refund)
 * @param {number} bps Basis points (e.g., 100 = 1%)
 * @returns {{ feeAmount: bigint, refundAmount: bigint }}
 */
export function calculateFee(amountIn, bps) {
  const amt = BigInt(amountIn ?? 0n);
  const fee = (amt * BigInt(Number(bps || 0))) / 10000n;
  return { feeAmount: fee, refundAmount: amt - fee };
}

/**
 * Convenience: choose tier by USD value, then apply fee to amountIn.
 * @param {bigint} amountIn
 * @param {number} usdValue Integer USD value used to pick tier
 * @param {{thresholds:number[], bps:number[]}} tiers
 * @returns {{ feeAmount: bigint, refundAmount: bigint, bps: number, tier: number, pct: number }}
 */
export function applyFeeForUsd(amountIn, usdValue, tiers) {
  const selected = selectTierForUsd(usdValue, tiers);
  if (!selected) {
    const amt = BigInt(amountIn ?? 0n);
    return { feeAmount: 0n, refundAmount: amt, bps: 0, tier: 0, pct: 0 };
  }
  const { feeAmount, refundAmount } = calculateFee(amountIn, selected.bps);
  return { feeAmount, refundAmount, bps: selected.bps, tier: selected.tier, pct: selected.pct };
}
