// src/services/redeemService.js
// Ethers v6 compatible
import { Contract, Interface, parseUnits } from "ethers";
import {
  getWriteContract,
  allowance,
  fixedUsdPrice,
  wONE as coreWONE,
  usdc as coreUSDC,
  getTokenDecimals as coreGetTokenDecimals,
  oracleLatest as coreOracleLatest,
  getFeeTiers as coreGetFeeTiers,
  USD_SCALE_BI,
  toUsd4,
  toUsd18, // (se precisar no futuro)
} from "@/services/vaultCore";


const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

// Built-in error interface for require/revert strings and panics
const BUILTIN_ERROR_IFACE = new Interface([
  "error Error(string)",
  "error Panic(uint256)",
]);

// Optional: if the Solidity contract migrates to custom errors in the future
const VAULT_ERROR_IFACE = new Interface([
  "error NotWhitelisted()",
  "error ContractLocked()",
  "error RoundNotStarted()",
  "error NoFunds()",
  "error TokenNotSupported()",
  "error InvalidRedeemToken()",
  "error InsufficientLiquidity()",
  "error InvalidOracle()",
  "error UnsupportedValuation()",
  "error UnsupportedRedeemToken()",
  "error DailyLimitExceeded(uint256 remaining, uint256 requested)",
  "error MismatchONEAmount()",
  "error DoNotSendONEWithERC20()",
]);

const TTL = { ADDR: 60_000, DEC: 300_000, ORACLE: 30_000, FEES: 300_000 };
const addrCache = new Map();
const decCache = new Map();
const metaCache = new Map();
const oracleCache = new Map();
const feeTiersCache = new Map();

// Fallback gas limit when estimateGas fails without revert data (Harmony quirk)
const GAS_FALLBACK_LIMIT = BigInt(Number(import.meta.env.VITE_REDEEM_GAS_FALLBACK ?? 500000));

// Resolve vault spender address without relying on getVaultAddress export
async function getVaultSpender(signer) {
  try {
    const v = getWriteContract(signer);
    return v?.target || v?.address || null; // ethers v6 uses .target
  } catch {
    return null;
  }
}

function now() { return Date.now(); }
function isFresh(ts, ttl) { return ts && now() - ts < ttl; }
async function chainKey(provider) {
  try {
    const n = await provider.getNetwork();
    return String(Number(n?.chainId || 0));
  } catch {
    return "0";
  }
}
function scope(map, key) {
  let m = map.get(key);
  if (!m) { m = new Map(); map.set(key, m); }
  return m;
}

function pickMsg(v) {
  return v?.shortMessage || v?.reason || v?.message || String(v ?? "");
}

function extractRevertData(e) {
  return (
    e?.data?.data || // some providers wrap here
    e?.info?.error?.data || // ethers v6 enriched
    e?.error?.data || // MetaMask/original
    e?.data || null
  );
}

function parseWith(iface, data) {
  try {
    if (!data || typeof data !== "string" || !data.startsWith("0x")) return null;
    return iface.parseError(data);
  } catch {
    return null;
  }
}

function decodePanic(codeBn) {
  const c = Number(codeBn ?? 0);
  const map = {
    0x01: "Assertion failed",
    0x11: "Arithmetic overflow/underflow",
    0x12: "Division or modulo by zero",
    0x21: "Enum out of bounds",
    0x22: "Storage byte array out of bounds",
    0x31: "Out of memory",
    0x32: "Uninitialized function pointer",
    0x41: "Assertion failed (assert)",
    0x51: "Pop on empty array",
  };
  return map[c] || `Panic(0x${c.toString(16)})`;
}

function decodeRevert(e) {
  const data = extractRevertData(e);

  // 1) Try future custom errors (no-op if contract uses only require strings)
  const custom = parseWith(VAULT_ERROR_IFACE, data);
  if (custom) {
    switch (custom.name) {
      case "NotWhitelisted": return "Address not whitelisted";
      case "ContractLocked": return "Contract is locked";
      case "RoundNotStarted": return "Round not started";
      case "NoFunds": return "Vault has no funds";
      case "TokenNotSupported": return "Token not supported";
      case "InvalidRedeemToken": return "Redeem token must be wONE or USDC";
      case "InsufficientLiquidity": return "Vault has insufficient funds for the selected output";
      case "InvalidOracle": return "Invalid oracle";
      case "UnsupportedValuation": return "Unsupported valuation";
      case "UnsupportedRedeemToken": return "Unsupported redeem token";
      case "DailyLimitExceeded": {
        const [remaining, requested] = custom.args || [];
        return `Daily limit exceeded (remaining $${remaining} vs requested $${requested})`;
      }
      case "MismatchONEAmount": return "Mismatch ONE amount";
      case "DoNotSendONEWithERC20": return "Do not send ONE with ERC20";
      default: return `${custom.name} (custom error)`;
    }
  }

  // 2) Built-in Error(string) / Panic(uint256)
  const builtin = parseWith(BUILTIN_ERROR_IFACE, data);
  if (builtin) {
    if (builtin.name === "Error") {
      const reason = builtin.args?.[0] || "";
      return String(reason || "Execution reverted");
    }
    if (builtin.name === "Panic") {
      return decodePanic(builtin.args?.[0]);
    }
  }

  // 3) Fallback: try to read reason from thrown message
  const raw = pickMsg(e);
  if (/Exceeds daily limit/i.test(String(raw))) return "Daily limit exceeded (USD×1e4). Reduce the amount.";
  if (/Daily limit locked/i.test(String(raw))) return "Daily limit reached. Please wait for your 24h window to reset.";
  const m = /execution reverted(?::|: )?\s*(.*)$/i.exec(String(raw || ""));
  if (m && m[1]) return m[1].trim();
  return "";
}

export function rpcFriendly(e) {
  const decoded = decodeRevert(e);
  const raw = pickMsg(e);

  if (/Exceeds daily limit/i.test(String(raw))) return "Daily limit exceeded (USD×1e4). Reduce the amount.";
  if (/Daily limit locked/i.test(String(raw))) return "Daily limit reached. Please wait for your 24h window to reset.";
  if (decoded) return decoded;

  const code = e?.code;
  const msg = String(raw).toLowerCase();
  if (code === "ACTION_REJECTED" || code === 4001 || /user rejected|denied|rejected request|eip-1193/.test(msg)) return "Transaction rejected by user";
  if (code === "CALL_EXCEPTION" || /execution reverted|revert/.test(msg)) return "Transaction would revert";
  if (code === "UNPREDICTABLE_GAS_LIMIT" || /cannot estimate gas|gas required exceeds allowance/.test(msg)) return "Gas estimation failed (contract may revert)";
  if (code === -32002 || /request already pending/.test(msg)) return "Wallet request already pending. Please confirm or dismiss it in your wallet";
  if (code === -32000 || /underpriced|invalid input/.test(msg)) return "RPC rejected the request (underpriced or invalid)";
  if (code === -32603 || /internal json-rpc error|internal error/.test(msg)) return "RPC internal error. Try again in a moment";
  if (/providerdisconnected|chaindisconnected|disconnected/.test(msg)) return "Wallet or network disconnected";
  if (/insufficient funds/.test(msg)) return "Insufficient funds for gas or value";
  if (/rate limit|too many requests|status code 429/.test(msg)) return "RPC rate limited. Please retry shortly";
  return raw;
}


async function getWONE(provider) {
  const ck = await chainKey(provider);
  const s = scope(addrCache, ck);
  const c = s.get("wone");
  if (c && isFresh(c.ts, TTL.ADDR)) return c.val;
  const v = await coreWONE(provider).catch(() => null);
  s.set("wone", { ts: now(), val: v });
  return v;
}

async function getUSDC(provider) {
  const ck = await chainKey(provider);
  const s = scope(addrCache, ck);
  const c = s.get("usdc");
  if (c && isFresh(c.ts, TTL.ADDR)) return c.val;
  const v = await coreUSDC(provider).catch(() => null);
  s.set("usdc", { ts: now(), val: v });
  return v;
}

async function getTokenDecimals(provider, token) {
  const ck = await chainKey(provider);
  const s = scope(decCache, ck);
  const key = String(token).toLowerCase();
  const c = s.get(key);
  if (c && isFresh(c.ts, TTL.DEC)) return c.val;
  const d = await coreGetTokenDecimals(provider, token).catch(() => 18);
  const out = Number(d || 18);
  s.set(key, { ts: now(), val: out });
  return out;
}

async function getOracle(provider) {
  const ck = await chainKey(provider);
  const c = oracleCache.get(ck);
  if (c && isFresh(c.ts, TTL.ORACLE)) return c.val;
  const v = await coreOracleLatest(provider).catch(() => ({ price: 0n, decimals: 18 }));
  oracleCache.set(ck, { ts: now(), val: v });
  return v;
}

async function getFeeTiers(provider) {
  const ck = await chainKey(provider);
  const c = feeTiersCache.get(ck);
  if (c && isFresh(c.ts, TTL.FEES)) return c.val;
  const v = await coreGetFeeTiers(provider).catch(() => ({ thresholds: [], bps: [] }));
  feeTiersCache.set(ck, { ts: now(), val: v });
  return v;
}

export async function getTokenMeta(provider, token) {
  const ck = await chainKey(provider);
  const s = scope(metaCache, ck);
  const key = String(token).toLowerCase();
  const c = s.get(key);
  if (c && isFresh(c.ts, TTL.DEC)) return c.val;
  const erc = new Contract(token, ERC20_ABI, provider);
  let decimals = 18, symbol = "TOKEN";
  try { decimals = Number(await erc.decimals()); } catch {}
  try { symbol = String((await erc.symbol()) || "TOKEN"); } catch {}
  const val = { decimals, symbol };
  s.set(key, { ts: now(), val });
  return val;
}

export async function computeUsd18(provider, tokenIn, amountRaw) {
  const [woneAddr, usdcAddr] = await Promise.all([
    getWONE(provider),
    getUSDC(provider),
  ]);

  const amt = BigInt(amountRaw);

  if (woneAddr && String(tokenIn).toLowerCase() === String(woneAddr).toLowerCase()) {
    const dec = await getTokenDecimals(provider, tokenIn).catch(() => 18);
    const oracle = await getOracle(provider);
    const price = BigInt(oracle?.price ?? 0n);
    const odec = Number(oracle?.decimals ?? 18);
    if (price <= 0n) return { usd18: 0n, oracle: null };
    const one18 = (amt * (10n ** 18n)) / (10n ** BigInt(dec));
    const usd18 = (one18 * price) / (10n ** BigInt(odec));
    return { usd18, usd4: toUsd4(usd18), oracle };
  }

  if (usdcAddr && String(tokenIn).toLowerCase() === String(usdcAddr).toLowerCase()) {
    const usdcDec = await getTokenDecimals(provider, usdcAddr).catch(() => 6);
    const usd18 = (amt * (10n ** 18n)) / (10n ** BigInt(usdcDec));
    return { usd18, usd4: toUsd4(usd18), oracle: null };
  }

  const px18 = await fixedUsdPrice(provider, tokenIn).catch(() => 0n);
  if (px18 <= 0n) return { usd18: 0n, oracle: null };
  const dec = await getTokenDecimals(provider, tokenIn).catch(() => 18);
  const usd18 = (amt * BigInt(px18)) / (10n ** BigInt(dec));
  return { usd18, usd4: toUsd4(usd18), oracle: null };
}

export async function usd18ToOut(provider, usd18, outToken, opts = {}) {
  const { oracle: oracleSnapshot = null } = opts || {};
  const [woneAddr, usdcAddr] = await Promise.all([getWONE(provider), getUSDC(provider)]);

  if (usdcAddr && String(outToken).toLowerCase() === String(usdcAddr).toLowerCase()) {
    const dec = await getTokenDecimals(provider, usdcAddr).catch(() => 6);
    return (BigInt(usd18) * (10n ** BigInt(dec))) / (10n ** 18n);
  }

  if (woneAddr && String(outToken).toLowerCase() === String(woneAddr).toLowerCase()) {
    const snap = oracleSnapshot || (await getOracle(provider));
    const price = BigInt(snap?.price ?? 0n);
    const odec = Number(snap?.decimals ?? 18);
    if (!price || price <= 0n) return 0n;
    const wdec = await getTokenDecimals(provider, woneAddr).catch(() => 18);
    const priceOut18 = (price * (10n ** 18n)) / (10n ** BigInt(odec));
    return (BigInt(usd18) * (10n ** BigInt(wdec))) / priceOut18;
  }

  return 0n;
}

function sanitizeAmountInput(v) {
  const raw = String(v ?? "").trim().replace(/,/g, ".");
  if (!/^\d*(\.\d*)?$/.test(raw)) return null;
  if (raw === "" || raw === ".") return null;
  return raw;
}

export async function buildQuote(provider, tokenIn, amountHuman, outToken) {
  if (!provider || !tokenIn || !outToken) return { ok: false };
  const { decimals: inDec, symbol: inSym } = await getTokenMeta(provider, tokenIn);
  const sanitized = sanitizeAmountInput(amountHuman);
  if (sanitized == null) return { ok: false };
  let amountIn;
  try { amountIn = parseUnits(sanitized, inDec); } catch { return { ok: false }; }
  if (amountIn <= 0n) return { ok: false };
  const { usd18, usd4, oracle } = await computeUsd18(provider, tokenIn, amountIn);
  if (usd18 <= 0n) return { ok: false };
  const outRaw = await usd18ToOut(provider, usd18, outToken, { oracle });
  if (outRaw <= 0n) return { ok: false };
  const [woneAddr, usdcAddr] = await Promise.all([getWONE(provider), getUSDC(provider)]);
  const outDec = await getTokenDecimals(provider, outToken);
  const outSym = String(outToken).toLowerCase() === String(usdcAddr).toLowerCase() ? "USDC" : "wONE";
  return {
    ok: true,
    amountIn,
    tokenIn: { address: tokenIn, decimals: inDec, symbol: inSym },
    tokenOut: { address: outToken, decimals: outDec, symbol: outSym },
    usd18,
    usd4,
    outRaw,
  };
}

export async function localQuote(provider, tokenIn, amountIn) {
  const { usd18, usd4 } = await computeUsd18(provider, tokenIn, amountIn);
  const { thresholds = [], bps = [] } = await getFeeTiers(provider).catch(() => ({ thresholds: [], bps: [] }));
  const thr = thresholds;
  const feeBps = bps.map((x) => BigInt(x));
  const usd4Thr = thr.map((t) => BigInt(t ?? 0n) * USD_SCALE_BI);
  let chosenBps = 0n;
  for (let i = 0; i < usd4Thr.length; i++) {
    const t4 = usd4Thr[i] ?? 0n;
    if (usd4 <= t4) { chosenBps = feeBps[i] ?? 0n; break; }
  }
  if (chosenBps === 0n) chosenBps = feeBps[(feeBps.length || 1) - 1] || 0n;  

  const fee = (BigInt(amountIn) * chosenBps) / 10000n;
  const refund = BigInt(amountIn) - fee;
  return {
      usd18,
      usd4,                 // USD * 1e4 (mesma granularidade do contrato)
      usdInt: usd18 / (10n ** 18n), // mantemos se alguém no UI ainda usa inteiro
      bps: Number(chosenBps),
      fee,
      refund
    };
}

export async function approveIfNeeded(signer, token, owner, spender, amount) {
  if (!signer || !signer.provider) throw new Error("Wallet/provider not ready");
  const amt = BigInt(amount ?? 0n);
  if (amt === 0n) return null;
  let cur;
  try {
    cur = await allowance(signer.provider, token, owner, spender);
  } catch (e) {
    throw new Error(rpcFriendly(e));
  }
  const MAX = (2n ** 256n) - 1n;
  if (cur >= amt) return null;
  if (amt === MAX && cur === MAX) return null;
  const erc = new Contract(token, ERC20_ABI, signer);
  try {
    const tx = await erc.approve(spender, amt);
    return await tx.wait();
  } catch (e) {
    throw new Error(rpcFriendly(e));
  }
}

export async function approveForVaultIfNeeded(signer, token, owner, amount) {
  // Native ONE path: no ERC20 allowance needed
  if (!token || /^0x0{40}$/i.test(String(token))) return null;
  const spender = await getVaultSpender(signer);
  if (!spender) throw new Error("Vault contract not configured");
  return await approveIfNeeded(signer, token, owner, spender, amount);
}

export async function redeem(signer, tokenIn, amountIn, redeemIn, proof = [], overrides = {}) {
  const v = getWriteContract(signer);
  const args = [tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : []];
  const from = await signer.getAddress?.();
  const baseOverrides = { from, ...(overrides || {}) };
  // Native ONE path (contract expects msg.value == amountIn)
  if (!tokenIn || /^0x0{40}$/i.test(String(tokenIn))) {
    baseOverrides.value = BigInt(amountIn);
  }

  // 0) Extra preflight via view: quoteRedeem (best-effort; some RPCs return 0x and break decoding)
  try {
    if (v.quoteRedeem && typeof v.quoteRedeem.staticCall === "function") {
      try {
        await v.quoteRedeem.staticCall(
          from,
          tokenIn,
          amountIn,
          redeemIn,
          Array.isArray(proof) ? proof : [],
          baseOverrides
        );
      } catch (pre) {
        const code = pre?.code;
        const msg = (pickMsg(pre) || "").toLowerCase();
        if (code === "BAD_DATA" || /could not decode result data|^0x$/.test(msg)) {
          console.warn("[redeem.quoteRedeem] skipping preflight due to BAD_DATA/empty 0x", pre);
        } else {
          console.error("[redeem.quoteRedeem] revert", pre);
          throw pre;
        }
      }
    }
  } catch (e) {
    throw new Error(rpcFriendly(e));
  }

  // 1) Static check (captures revert reasons via eth_call)
  try {
    await v.redeem.staticCall(...args, baseOverrides);
  } catch (e) {
    console.error("[redeem.staticCall] revert", e);
    throw new Error(rpcFriendly(e));
  }

  // 2) Estimate gas (second opinion). Some Harmony RPCs fail with missing revert data; tolerate & fallback.
  let useFallbackGas = false;
  try {
    await v.redeem.estimateGas(...args, baseOverrides);
  } catch (e) {
    console.warn("[redeem.estimateGas] fallback gasLimit due to:", e);
    const decoded = decodeRevert(e);
    if (decoded) {
      // A real revert reason was decoded -> surface it
      throw new Error(decoded);
    }
    const txt = (pickMsg(e) || "").toLowerCase();
    if (/missing revert data|call exception|internal json-rpc error|execution reverted/.test(txt)) {
      useFallbackGas = true; // proceed with a conservative gas limit
    } else {
      throw new Error(rpcFriendly(e));
    }
  }

  // 3) Send transaction (optionally with fallback gas limit)
  try {
    const sendOpts = { ...baseOverrides };
    if (useFallbackGas && sendOpts.gasLimit == null) {
      sendOpts.gasLimit = GAS_FALLBACK_LIMIT; // e.g. 500,000 gas
    }
    const tx = await v.redeem(...args, sendOpts);
    return await tx.wait();
  } catch (e) {
    console.error("[redeem.send] revert", e);
    const decoded = decodeRevert(e);
    if (decoded) throw new Error(decoded);
    throw new Error(rpcFriendly(e));
  }
}
