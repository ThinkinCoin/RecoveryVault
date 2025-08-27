// @/helpers/tokenMath.js
// Deterministic math helpers mirroring the contract's integer-USD logic.
// All conversions use BigInt and FLOOR semantics (via integer division),
// matching the RecoveryVault.sol calculations.

/** Safe 10^n for BigInt */
export function pow10(n) {
  const i = Number(n ?? 0);
  if (!Number.isFinite(i) || i < 0) throw new Error("pow10 expects non-negative integer");
  return 10n ** BigInt(i);
}

/** Coerce to BigInt */
export function b(v) {
  try { return BigInt(v ?? 0); } catch { return 0n; }
}

/**
 * Convert token amount to INTEGER USD using a fixed USD price (1e18 scale).
 * Formula (floor): usd = amountIn * fixed1e18 / 10^decimals / 1e18
 * @param {bigint} amountIn  - token units
 * @param {number} tokenDecimals
 * @param {bigint} fixed1e18 - 1e18 = $1.00
 * @returns {bigint} usd (integer)
 */
export function toUSDFromFixed(amountIn, tokenDecimals, fixed1e18) {
  const amt = b(amountIn);
  const fp = b(fixed1e18);
  if (fp <= 0n) return 0n;
  const denom = pow10(tokenDecimals) * pow10(18);
  return (amt * fp) / denom; // floor
}

/**
 * Convert INTEGER USD to token amount using a fixed USD price (1e18 scale).
 * Formula (floor): amount = usd * 10^dec * 1e18 / fixed1e18
 * @param {bigint} usd       - integer USD
 * @param {number} tokenDecimals
 * @param {bigint} fixed1e18 - 1e18 = $1.00
 * @returns {bigint} token amount (units)
 */
export function usdToTokenFromFixed(usd, tokenDecimals, fixed1e18) {
  const u = b(usd);
  const fp = b(fixed1e18);
  if (fp <= 0n) return 0n;
  const numer = u * pow10(tokenDecimals) * pow10(18);
  return numer / fp; // floor
}

/**
 * Convert INTEGER USD to USDC amount (face value 1 USDC = $1.00).
 * @param {bigint} usd - integer USD
 * @param {number} usdcDecimals - default 6
 * @returns {bigint}
 */
export function usdToUSDC(usd, usdcDecimals = 6) {
  return b(usd) * pow10(usdcDecimals);
}

/**
 * Convert INTEGER USD to wONE amount using ONE/USD price in 1e18 scale.
 * Formula (floor): amount = usd * 10^oneDec * 1e18 / onePrice1e18
 * @param {bigint} usd
 * @param {bigint} onePrice1e18 - Band oracle price (1e18 = $1.00)
 * @param {number} oneDecimals - default 18
 * @returns {bigint}
 */
export function usdToWONE(usd, onePrice1e18, oneDecimals = 18) {
  const u = b(usd);
  const p = b(onePrice1e18);
  if (p <= 0n) return 0n;
  const numer = u * pow10(oneDecimals) * pow10(18);
  return numer / p; // floor
}

/**
 * Convert token amount to INTEGER USD using ONE/USD (1e18) — utility for wONE.
 * usd = amount * price / 10^oneDec / 1e18
 */
export function woneToUSD(amountIn, oneDecimals, onePrice1e18) {
  const amt = b(amountIn);
  const p = b(onePrice1e18);
  if (p <= 0n) return 0n;
  const denom = pow10(oneDecimals) * pow10(18);
  return (amt * p) / denom; // floor
}

/**
 * Convert USDC amount to INTEGER USD (face value).
 */
export function usdcToUSD(amountIn, usdcDecimals = 6) {
  const amt = b(amountIn);
  const dec = pow10(usdcDecimals);
  return amt / dec; // floor
}

export default {
  pow10,
  b,
  toUSDFromFixed,
  usdToTokenFromFixed,
  usdToUSDC,
  usdToWONE,
  woneToUSD,
  usdcToUSD,
};
