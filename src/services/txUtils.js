// src/services/txUtils.js
import { Interface } from "ethers";

const FORCE_LEGACY =
  String(import.meta?.env?.VITE_FORCE_LEGACY_GAS || "").toLowerCase() === "true";

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

/** Estimate gas safely; fallback to a default BigInt if it fails */
export async function safeEstimateGas(contract, fnName, args, opts = {}) {
  const fallback = opts?.fallback != null ? BigInt(opts.fallback) : 300000n;
  const overrides = opts?.overrides || {};
  try {
    // aceita assinatura completa: pega só o nome p/ estimateGas
    const nameOnly = String(fnName).includes("(")
      ? String(fnName).slice(0, String(fnName).indexOf("("))
      : String(fnName);

    // ✅ sem TypeError: use o getter da API v6
    const estimator = contract.estimateGas.getFunction(nameOnly);
    const est = await estimator(...(args || []), overrides);
    return est;
  } catch (err) {
    // deixe o warn discreto; vamos cair no fallback
    console.warn("[safeEstimateGas] estimate failed, using fallback");
    return fallback;
  }
}

/** Choose EIP-1559 fees if available, else legacy gasPrice */
export async function buildGasFees(provider) {
  // Harmony: prefira legacy quando forçamos por env
  if (FORCE_LEGACY) {
    try {
      const gasPrice = await provider?.getGasPrice?.();
      return gasPrice ? { gasPrice } : {};
    } catch {
      return {};
    }
  }

  try {
    const fd = await provider?.getFeeData?.();
    if (fd?.maxFeePerGas != null && fd?.maxPriorityFeePerGas != null) {
      return { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas };
    }
    if (fd?.gasPrice != null) return { gasPrice: fd.gasPrice };
  } catch {
    // silenciar erro do eth_maxPriorityFeePerGas ausente
  }

  // fallback final -> legacy
  try {
    const gasPrice = await provider?.getGasPrice?.();
    return gasPrice ? { gasPrice } : {};
  } catch {
    return {};
  }
}
