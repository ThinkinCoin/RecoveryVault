// src/services/txUtils.js
// All logs/messages in English
import { Interface, isHexString  } from "ethers";

// Optional env switch; but on Harmony we will force legacy regardless.
const FORCE_LEGACY_ENV =
  String(import.meta?.env?.VITE_FORCE_LEGACY_GAS || "").toLowerCase() === "true";

// Harmony chain id (mainnet). Add testnet if you need.
const HARMONY_CHAIN_ID = 1666600000n;

// ----- ENV helpers -----
function parseDecimalToBigInt(str, decimals) {
  const s = String(str ?? "").trim();
  if (!s) return null;
  const [i, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export const GAS_LIMIT_FALLBACK =
  (() => {
    try {
      const raw = import.meta?.env?.VITE_GAS_LIMIT;
      const v = BigInt(raw);
      return v > 0n ? v : 5_000_000n;
    } catch { return 5_000_000n; }
  })();

export const GAS_PRICE_LEGACY =
  (() => {
    try {
      const raw = import.meta?.env?.VITE_GAS_PRICE_GWEI;
      const v = parseDecimalToBigInt(raw, 9); // gwei → wei
      return (v != null && v > 0n) ? v : null;
    } catch { return null; }
  })();

// -----------------------------
// Helpers
// -----------------------------
async function getChainId(provider) {
  try {
    const net = await provider?.getNetwork?.();
    // ethers v6 returns bigint
    if (net?.chainId != null) return BigInt(net.chainId);
  } catch (_) {}
  return null;
}

async function mustUseLegacy(provider) {
  // Force legacy by env OR when on Harmony chain
  if (FORCE_LEGACY_ENV) return true;
  const cid = await getChainId(provider);
  if (cid === HARMONY_CHAIN_ID) return true;
  // Default false elsewhere
  return false;
}

async function getGasPriceOrFallback(provider) {
  try {
    const gp = await provider?.getGasPrice?.(); // bigint
    if (gp && gp > 0n) return gp;
  } catch (_) {}
  // Fallback 1 gwei (adjust if needed)
  return 5_000_000_000n;
}

/**
 * Ensure overrides are legacy if gasPrice is present.
 * Strips any EIP-1559 fields and sets type:0.
 */
export function ensureLegacyOverrides(overrides = {}) {
  const out = { ...(overrides || {}) };
  if (out.gasPrice != null) {
    delete out.maxFeePerGas;
    delete out.maxPriorityFeePerGas;
    out.type = 0;
  }
  return out;
}

// -----------------------------
// Public API
// -----------------------------

/** USD must be integer (no decimals) */
export function normalizeUsdInt(value) {
  if (typeof value === "string") value = value.trim().replace(",", ".");
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Invalid USD value");
  if (!Number.isInteger(n)) throw new Error("USD must be integer (no decimals)");
  if (n < 0) throw new Error("USD must be positive");
  return n;
}

/** Try to decode revert from RPC error (custom errors or Error(string)) */
export function extractRpcRevert(err, iface) {
  try {
    const data = err?.data ?? err?.error?.data ?? err?.info?.error?.data ?? err?.value?.data;
    if (data && isHexString(data)) {
      try { return iface.parseError(data)?.name || "Execution reverted"; } catch {}
      try {
        const std = new Interface(["error Error(string)"]);
        const parsed = std.parseError(data);
        if (parsed?.args?.length) return String(parsed.args[0]);
      } catch {}
    }
  } catch {}
  return err?.shortMessage || err?.reason || err?.message || "Execution reverted";
}

/** Detect user rejection (ACTION_REJECTED / 4001) */
export function isActionRejected(err) {
  const c = err?.code ?? err?.data?.code;
  return c === 4001 || c === "ACTION_REJECTED";
}

/**
 * Estimate gas safely; fallback to a default BigInt if it fails.
 * Always injects legacy overrides when gasPrice is present.
 */
export async function safeEstimateGas(_c, _f, _a, { fallback = 5_000_000n } = {}) {
  return fallback;
}

/**
 * Build fee overrides for the current network.
 * - Forçado (ou Harmony): retorna SEMPRE legacy com gasPrice do .env (se existir)
 *   ou do provider como fallback. Nunca tenta EIP-1559
 *
 * IMPORTANT: On Harmony this NEVER calls getFeeData() to avoid
 * eth_maxPriorityFeePerGas (-32601) errors.
 */
export async function buildGasFees(provider) {
  const legacy = await mustUseLegacy(provider);
  if (legacy) {
    const gp = GAS_PRICE_LEGACY ?? (await getGasPriceOrFallback(provider));
    return ensureLegacyOverrides({ gasPrice: gp });
  }
  // Se algum dia não for legacy, ainda assim preferimos legacy em Harmony
  const gp = GAS_PRICE_LEGACY ?? (await getGasPriceOrFallback(provider));
  return ensureLegacyOverrides({ gasPrice: gp });
}
