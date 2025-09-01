// src/services/redeemService.js
import { Contract, parseUnits } from "ethers";
import {
  getVaultAddress,
  getWriteContract,
  allowance,
  fixedUsdPrice,
  wONE as coreWONE,
  usdc as coreUSDC,
  getTokenDecimals as coreGetTokenDecimals,
  oracleLatest as coreOracleLatest,
  getFeeTiers as coreGetFeeTiers,
} from "@/services/vaultCore";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)"
];

const TTL = { ADDR: 60_000, DEC: 300_000, ORACLE: 30_000, FEES: 300_000 };
const addrCache = new Map();
const decCache = new Map();
const metaCache = new Map();
const oracleCache = new Map();
const feeTiersCache = new Map();

function now() { return Date.now(); }
function isFresh(ts, ttl) { return ts && (now() - ts) < ttl; }
async function chainKey(provider){ try{ const n = await provider.getNetwork(); return String(Number(n?.chainId||0)); } catch { return "0"; } }
function scope(map, key){ let m = map.get(key); if(!m){ m = new Map(); map.set(key, m); } return m; }

function pickMsg(v){ return v?.shortMessage || v?.reason || v?.message || String(v ?? ""); }

export function rpcFriendly(e){
  const code = e?.code;
  const msg = pickMsg(e).toLowerCase();
  if (code === "ACTION_REJECTED" || code === 4001 || /user rejected|denied|rejected request|eip-1193/i.test(msg)) return "Transaction rejected by user";
  if (code === "CALL_EXCEPTION" || /execution reverted|revert/i.test(msg)) return "Transaction would revert";
  if (code === "UNPREDICTABLE_GAS_LIMIT" || /cannot estimate gas|gas required exceeds allowance/i.test(msg)) return "Gas estimation failed (contract may revert)";
  if (code === -32002 || /request already pending/i.test(msg)) return "Wallet request already pending. Please confirm or dismiss it in your wallet";
  if (code === -32000 || /underpriced|invalid input/i.test(msg)) return "RPC rejected the request (underpriced or invalid)";
  if (code === -32603 || /internal json-rpc error|internal error/i.test(msg)) return "RPC internal error. Try again in a moment";
  if (/providerdisconnected|chaindisconnected|disconnected/i.test(msg)) return "Wallet or network disconnected";
  if (/insufficient funds/i.test(msg)) return "Insufficient funds for gas or value";
  if (/rate limit|too many requests|status code 429/i.test(msg)) return "RPC rate limited. Please retry shortly";
  return pickMsg(e);
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
    return { usd18, oracle };
  }

  if (usdcAddr && String(tokenIn).toLowerCase() === String(usdcAddr).toLowerCase()) {
    const usdcDec = await getTokenDecimals(provider, usdcAddr).catch(() => 6);
    const usd18 = (amt * (10n ** 18n)) / (10n ** BigInt(usdcDec));
    return { usd18, oracle: null };
  }

  const px18 = await fixedUsdPrice(provider, tokenIn).catch(() => 0n);
  if (px18 <= 0n) return { usd18: 0n, oracle: null };
  const dec = await getTokenDecimals(provider, tokenIn).catch(() => 18);
  const usd18 = (amt * BigInt(px18)) / (10n ** BigInt(dec));
  return { usd18, oracle: null };
}

export async function usd18ToOut(provider, usd18, outToken, opts = {}) {
  const { oracle: oracleSnapshot = null } = opts || {};
  const [woneAddr, usdcAddr] = await Promise.all([getWONE(provider), getUSDC(provider)]);

  if (usdcAddr && String(outToken).toLowerCase() === String(usdcAddr).toLowerCase()) {
    const dec = await getTokenDecimals(provider, usdcAddr).catch(() => 6);
    return (BigInt(usd18) * (10n ** BigInt(dec))) / (10n ** 18n);
  }

  if (woneAddr && String(outToken).toLowerCase() === String(woneAddr).toLowerCase()) {
    const snap = oracleSnapshot || await getOracle(provider);
    const price = BigInt(snap?.price ?? 0n);
    const odec = Number(snap?.decimals ?? 18);
    if (!price || price <= 0n) return 0n;
    const wdec = await getTokenDecimals(provider, woneAddr).catch(() => 18);
    const priceOut18 = (price * (10n ** 18n)) / (10n ** BigInt(odec));
    return (BigInt(usd18) * (10n ** BigInt(wdec))) / priceOut18;
  }

  return 0n;
}

function sanitizeAmountInput(v){
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
  const { usd18, oracle } = await computeUsd18(provider, tokenIn, amountIn);
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
    outRaw
  };
}

export async function localQuote(provider, tokenIn, amountIn) {
  const { usd18 } = await computeUsd18(provider, tokenIn, amountIn);
  const { thresholds = [], bps = [] } = await getFeeTiers(provider).catch(() => ({ thresholds: [], bps: [] }));
  const thr = thresholds;
  const feeBps = bps.map((x) => BigInt(x));
  const usdInt = usd18 / (10n ** 18n);

  let chosenBps = 0n;
  for (let i = 0; i < thr.length; i++) {
    const t = thr[i] ?? 0n;
    if (usdInt <= t) { chosenBps = feeBps[i] ?? 0n; break; }
  }
  if (chosenBps === 0n) chosenBps = feeBps[(feeBps.length || 1) - 1] || 0n;

  const fee    = (BigInt(amountIn) * chosenBps) / 10000n;
  const refund = BigInt(amountIn) - fee;

  return { usd18, usdInt, bps: Number(chosenBps), fee, refund };
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
  const spender = getVaultAddress();
  return await approveIfNeeded(signer, token, owner, spender, amount);
}

export async function redeem(signer, tokenIn, amountIn, redeemIn, proof = [], overrides = {}) {
  const v = getWriteContract(signer);
  const args = [tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : []];
  try {
    await v.redeem.staticCall(...args, { ...(overrides || {}) });
  } catch (e) {
    throw new Error(rpcFriendly(e));
  }
  try {
    const tx = await v.redeem(...args, { ...(overrides || {}) });
    return await tx.wait();
  } catch (e) {
    throw new Error(rpcFriendly(e));
  }
}
