// src/services/txUtils.js
// All logs/messages in English
import { Interface } from "ethers";

// Optional env switch; but on Harmony we will force legacy regardless.
const FORCE_LEGACY_ENV =
  String(import.meta?.env?.VITE_FORCE_LEGACY_GAS || "").toLowerCase() === "true";

// Harmony chain id (mainnet). Add testnet if you need.
const HARMONY_CHAIN_ID = 1666600000n;

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
  return 1_000_000_000n;
}

/**
 * Ensure overrides are legacy if gasPrice is present.
 * Strips any EIP-1559 fields and sets type:0.
 */
function ensureLegacyOverrides(overrides = {}) {
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
    const data =
      err?.data ??
      err?.error?.data ??
      err?.info?.error?.data ??
      err?.error?.error?.data ??
      err?.transaction?.revert ??
      null;

    if (data) {
      try {
        const parsed = iface?.parseError?.(data);
        if (parsed) {
          const args = (parsed.args ?? []).map(String).join(", ");
          return args ? `${parsed.name}: ${args}` : parsed.name;
        }
      } catch (_) {}

      try {
        const std = new Interface(["error Error(string)"]);
        const parsedStd = std.parseError(data);
        if (parsedStd?.name === "Error" && parsedStd?.args?.length) {
          return String(parsedStd.args[0]);
        }
      } catch (_) {}
    }

    const msg =
      err?.shortMessage ||
      err?.reason ||
      err?.message ||
      "Execution reverted";

    if (/could not decode result data/i.test(String(msg))) return "Execution reverted (no reason)";
    if (/missing revert data/i.test(String(msg))) return "Execution reverted (no reason)";
    return msg;
  } catch (_) {}

  return err?.shortMessage || err?.reason || err?.message || "Execution reverted";
}

/** Detect user rejection (ACTION_REJECTED / 4001) */
export function isActionRejected(err) {
  const c = err?.code ?? err?.error?.code ?? err?.info?.error?.code;
  return c === 4001 || c === "ACTION_REJECTED";
}

/**
 * Estimate gas safely; fallback to a default BigInt if it fails.
 * Always injects legacy overrides when gasPrice is present.
 */
export async function safeEstimateGas(contract, fnName, args, opts = {}) {
  const fallback = opts?.fallback != null ? BigInt(opts.fallback) : 300000n;
  const rawOverrides = opts?.overrides || {};
  const overrides = ensureLegacyOverrides(rawOverrides);

  try {
    // Accept fully-qualified signature; extract the function name for estimateGas
    const nameOnly = String(fnName).includes("(")
      ? String(fnName).slice(0, String(fnName).indexOf("("))
      : String(fnName);

    const estimator = contract.estimateGas.getFunction(nameOnly);
    const est = await estimator(...(args || []), overrides);
    return est;
  } catch (err) {
    console.warn("[safeEstimateGas] estimate failed, using fallback");
    return fallback;
  }
}

/**
 * Build fee overrides for the current network.
 * - On Harmony (or when forced), ALWAYS returns legacy: { type:0, gasPrice }
 * - Else, tries EIP-1559 via getFeeData(); if missing, falls back to legacy.
 *
 * IMPORTANT: On Harmony this NEVER calls getFeeData() to avoid
 * eth_maxPriorityFeePerGas (-32601) errors.
 */
export async function buildGasFees(provider) {
  const legacy = await mustUseLegacy(provider);

  if (legacy) {
    const gasPrice = await getGasPriceOrFallback(provider);
    return { type: 0, gasPrice };
  }

  // Non-Harmony path: try EIP-1559 then legacy
  try {
    const fd = await provider?.getFeeData?.();
    if (fd?.maxFeePerGas != null && fd?.maxPriorityFeePerGas != null) {
      return { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas, type: 2 };
    }
    if (fd?.gasPrice != null) return { type: 0, gasPrice: fd.gasPrice };
  } catch (_) {
    // Silently ignore if getFeeData is not supported
  }

  const gasPrice = await getGasPriceOrFallback(provider);
  return { type: 0, gasPrice };
}
