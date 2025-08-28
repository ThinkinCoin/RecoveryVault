// src/services/txUtils.js
import { Interface } from "ethers";

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
    // no final de extractRpcRevert(...)
    const msg =
      err?.shortMessage ||
      err?.reason ||
      err?.message ||
      "Execution reverted";

    if (/could not decode result data/i.test(String(msg))) {
      return "Execution reverted (no reason)"; // evita mensagem confusa
    }
    if (/missing revert data/i.test(String(msg))) {
      return "Execution reverted (no reason)";
    }
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
    // aceita assinatura completa: pega só o nome para estimateGas
    const nameOnly = String(fnName).includes("(")
      ? String(fnName).slice(0, String(fnName).indexOf("("))
      : String(fnName);
    const est = await contract.estimateGas[nameOnly](...args, overrides);
    return est;
  } catch (err) {
    console.warn("[safeEstimateGas] estimate failed, using fallback", err);
    return fallback;
  }
}



/** Choose EIP-1559 fees if available, else legacy gasPrice */
export async function buildGasFees(provider) {
  try {
    const fd = await provider?.getFeeData?.();
    const fees = {};
    if (fd?.maxFeePerGas != null && fd?.maxPriorityFeePerGas != null) {
      fees.maxFeePerGas = fd.maxFeePerGas;
      fees.maxPriorityFeePerGas = fd.maxPriorityFeePerGas;
    } else if (fd?.gasPrice != null) {
      fees.gasPrice = fd.gasPrice;
    }
    return fees;
  } catch (err) {
    console.warn("[buildGasFees] feeData unavailable", err);
    return {};
  }
}
