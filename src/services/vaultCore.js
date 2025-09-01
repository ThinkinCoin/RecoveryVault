// src/services/vaultCore.js
import { Contract, JsonRpcProvider, Interface, getAddress } from "ethers";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";

const VAULT_ABI = VaultArtifact.abi ?? VaultArtifact;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

function b(v){ return BigInt(v); }
function n(v){ return Number(v); }
function bool(v){ return Boolean(v); }

export function getDefaultProvider() {
  try {
    const url = import.meta.env.VITE_RPC_URL;
    if (!url) return undefined;
    return new JsonRpcProvider(url);
  } catch {
    return undefined;
  }
}

export function getVaultAddress() {
  const v = import.meta.env.VITE_VAULT_ADDRESS;
  if (!v) throw new Error("VITE_VAULT_ADDRESS is missing");
  return getAddress(v);
}

export async function getReadContract(provider) {
  if (!provider) throw new Error("provider required");
  const addr = getVaultAddress();
  const code = await provider.getCode(addr);
  if (!code || code === "0x") throw new Error("Vault address has no bytecode");
  return new Contract(addr, VAULT_ABI, provider);
}

export function getWriteContract(signer) {
  if (!signer) throw new Error("signer required");
  const addr = getVaultAddress();
  return new Contract(addr, VAULT_ABI, signer);
}

export async function owner(p){ return await (await getReadContract(p)).owner(); }
export async function devWallet(p){ return await (await getReadContract(p)).devWallet(); }
export async function rmcWallet(p){ return await (await getReadContract(p)).rmcWallet(); }
export async function wONE(p){ return await (await getReadContract(p)).wONE(); }
export async function usdc(p){ return await (await getReadContract(p)).usdc(); }
export async function oracle(p){ return await (await getReadContract(p)).oracle(); }

export async function ROUND_DELAY(p){ return b(await (await getReadContract(p)).ROUND_DELAY()); }
export async function WALLET_RESET_INTERVAL(p){ return b(await (await getReadContract(p)).WALLET_RESET_INTERVAL()); }
export async function currentRound(p){ return b(await (await getReadContract(p)).currentRound()); }
export async function roundStart(p){ return b(await (await getReadContract(p)).roundStart()); }
export async function dailyLimitUsd(p){ return b(await (await getReadContract(p)).dailyLimitUsd()); }
export async function isLocked(p){ return bool(await (await getReadContract(p)).isLocked()); }
export async function merkleRoot(p){ return await (await getReadContract(p)).merkleRoot(); }

export async function fixedUsdPrice(p, token){ return b(await (await getReadContract(p)).fixedUsdPrice(token)); }
export async function supportedToken(p, token){ return bool(await (await getReadContract(p)).supportedToken(token)); }
export async function supportedTokenList(p, i){ return await (await getReadContract(p)).supportedTokenList(i); }
export async function getSupportedTokens(p){ return await (await getReadContract(p)).getSupportedTokens(); }

export async function feeThresholds(p, i){ return b(await (await getReadContract(p)).feeThresholds(i)); }
export async function feeBps(p, i){ return n(await (await getReadContract(p)).feeBps(i)); }
export async function getFeeTiers(p){
  const v = await getReadContract(p);
  const r = await v.getFeeTiers();
  const thresholdsRaw = Array.isArray(r?.[0]) ? r[0] : [];
  const bpsRaw = Array.isArray(r?.[1]) ? r[1] : [];
  const thresholds = thresholdsRaw.map((x) => (typeof x === "bigint" ? x : BigInt(x)));
  const bps = bpsRaw.map((x) => Number(x));
  return { thresholds, bps };
}

export async function getUserLimit(p, wallet){
  const r = await (await getReadContract(p)).getUserLimit(wallet);
  return b(r ?? 0n);
}

export async function getVaultBalances(p){
  const r = await (await getReadContract(p)).getVaultBalances();
  return { woneBalance: b(r[0]), usdcBalance: b(r[1]) };
}

export async function getLastRedeemTimestamp(p, user){
  return b(await (await getReadContract(p)).getLastRedeemTimestamp(user));
}

export async function lastRedeemTimestamp(p, user){
  return b(await (await getReadContract(p)).lastRedeemTimestamp(user));
}

export async function getRoundInfo(p){
  const r = await (await getReadContract(p)).getRoundInfo();
  return { roundId: b(r[0]), startTime: b(r[1]), isActive: bool(r[2]), paused: bool(r[3]), limitUsd: b(r[4]) };
}

export async function redeemedInRound(p, roundId, wallet){
  return b(await (await getReadContract(p)).redeemedInRound(roundId, wallet));
}

export async function quoteRedeem(p, user, tokenIn, amountIn, redeemIn, proof = []) {
  const v = await getReadContract(p);
  const r = await v.quoteRedeem(user, tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : []);
  return {
    whitelisted:        bool(r[0]),
    roundIsActive:      bool(r[1]),
    feeAmountInTokenIn: b(r[2]),
    burnAmountInTokenIn:b(r[3]),
    userLimitUsdBefore: b(r[4]),
    userLimitUsdAfter:  b(r[5]),
    usdValueIn:         b(r[6]),
    tokenInDecimals:    n(r[7]),
    redeemInDecimals:   n(r[8]),
    oraclePrice:        b(r[9]),
    oracleDecimals:     n(r[10]),
    amountOutRedeemToken: b(r[11]),
  };
}

export async function getTokenDecimals(provider, token) {
  const erc = new Contract(token, ERC20_ABI, provider);
  try { return Number(await erc.decimals()); } catch { return 18; }
}

export async function allowance(provider, token, owner, spender) {
  const erc = new Contract(token, ERC20_ABI, provider);
  try { return BigInt(await erc.allowance(owner, spender)); } catch { return 0n; }
}

export async function isTokenSupported(p, token){
  try { return await supportedToken(p, token); } catch {}
  try {
    const list = await getSupportedTokens(p);
    const set = new Set((list||[]).map((x) => String(x||"").toLowerCase()));
    return set.has(String(token||"").toLowerCase());
  } catch { return false; }
}

export async function getAllFixedPrices(p, tokens) {
  const v = await getReadContract(p);
  const out = {};
  for (const t of tokens || []) {
    try { out[t] = BigInt(await v.fixedUsdPrice(t)); } catch { out[t] = 0n; }
  }
  return out;
}

export function getEventTopics() {
  const iface = new Interface(VAULT_ABI);
  return {
    BurnToken: iface.getEventTopic("BurnToken"),
    FeeTiersUpdated: iface.getEventTopic("FeeTiersUpdated"),
    NewRoundStarted: iface.getEventTopic("NewRoundStarted"),
    OwnershipTransferred: iface.getEventTopic("OwnershipTransferred"),
    RedeemProcessed: iface.getEventTopic("RedeemProcessed"),
    SupportedTokenUpdated: iface.getEventTopic("SupportedTokenUpdated"),
    VaultPaused: iface.getEventTopic("VaultPaused"),
  };
}

const oracleCache = new WeakMap();
const ORACLE_TTL_MS = Number(import.meta.env.VITE_ORACLE_TTL_MS ?? 10000);



export async function oracleLatest(p) {
  const o = await oracle(p);
  const code = await p.getCode(o);
  if (!code || code === "0x") throw new Error("Oracle address has no bytecode");

  // cache key per provider+chain+oracle
  const net = await p.getNetwork().catch(() => null);
  const chainId = Number(net?.chainId ?? 0);
  let map = oracleCache.get(p);
  if (!map) { map = new Map(); oracleCache.set(p, map); }
  const key = `${chainId}:${String(o).toLowerCase()}`;
  const now = Date.now();
  const hit = map.get(key);
  if (hit && now - hit.t < ORACLE_TTL_MS) return hit.v;

  // env flags
  const invertEnv = String(import.meta.env.VITE_ORACLE_INVERT || "").toLowerCase() === "true";
  const ORACLE_BASE = String(import.meta.env.VITE_ORACLE_BASE || "ONE");
  const ORACLE_QUOTE = String(import.meta.env.VITE_ORACLE_QUOTE || "USD");

  // Normalize to USD/ONE with 18 decimals, regardless of underlying oracle format
  const normalize = (rawPrice, rawDecimals, opts = {}) => {
    const price = BigInt(rawPrice ?? 0);
    const decimals = Number(rawDecimals ?? 18);
    const invert = !!opts.invert;
    if (price <= 0n) return null;
    if (invert) {
      // If oracle returns ONE/USD with D decimals, invert to USD/ONE in 1e18
      const num = (10n ** 18n) * (10n ** BigInt(decimals));
      const val = num / price; // safe because price > 0
      return { price: val, decimals: 18 };
    }
    // If oracle returns USD/ONE with D decimals, scale to 1e18
    const val = (price * (10n ** 18n)) / (10n ** BigInt(decimals));
    return { price: val, decimals: 18 };
  };

  // 1) Band Protocol: getReferenceData(base, quote) -> rate (1e18)
  try {
    const abi = [{
      inputs: [{ name: "base", type: "string" }, { name: "quote", type: "string" }],
      name: "getReferenceData",
      outputs: [
        { name: "rate", type: "uint256" },
        { name: "lastUpdatedBase", type: "uint256" },
        { name: "lastUpdatedQuote", type: "uint256" }
      ],
      stateMutability: "view", type: "function"
    }];
    const c = new Contract(o, abi, p);
    const r = await c.getReferenceData(ORACLE_BASE, ORACLE_QUOTE);
    const out = normalize(BigInt(r[0]), 18, { invert: false });
    if (out) { map.set(key, { t: now, v: out }); return out; }
  } catch {}

  // 2) Custom: latestPrice() -> (price, decimals). Assume USD/ONE unless inverted by env.
  try {
    const abi = [{
      inputs: [], name: "latestPrice",
      outputs: [{ name: "price", type: "int256" }, { name: "decimals", type: "uint8" }],
      stateMutability: "view", type: "function"
    }];
    const c = new Contract(o, abi, p);
    const r = await c.latestPrice();
    const out = normalize(BigInt(r[0]), Number(r[1]), { invert: invertEnv });
    if (out) { map.set(key, { t: now, v: out }); return out; }
  } catch {}

  // 3) Chainlink-style: latestAnswer()/decimals(). Assume USD/ONE unless inverted by env.
  try {
    const abi = [
      { inputs: [], name: "latestAnswer", outputs: [{ type: "int256" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" }
    ];
    const c = new Contract(o, abi, p);
    const [ans, dec] = await Promise.all([c.latestAnswer(), c.decimals()]);
    const out = normalize(BigInt(ans), Number(dec), { invert: invertEnv });
    if (out) { map.set(key, { t: now, v: out }); return out; }
  } catch {}

  // 4) Chainlink-style: latestRoundData(int256)/decimals()
  try {
    const abi = [
      { inputs: [], name: "latestRoundData", outputs: [
        { type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }
      ], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" }
    ];
    const c = new Contract(o, abi, p);
    const data = await c.latestRoundData();
    const dec = await c.decimals();
    const out = normalize(BigInt(data[1]), Number(dec), { invert: invertEnv });
    if (out) { map.set(key, { t: now, v: out }); return out; }
  } catch {}

  // 5) Chainlink-style: latestRoundData(uint256)/decimals()
  try {
    const abi = [
      { inputs: [], name: "latestRoundData", outputs: [
        { type: "uint80" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }
      ], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" }
    ];
    const c = new Contract(o, abi, p);
    const data = await c.latestRoundData();
    const dec = await c.decimals();
    const out = normalize(BigInt(data[1]), Number(dec), { invert: invertEnv });
    if (out) { map.set(key, { t: now, v: out }); return out; }
  } catch {}

  throw new Error("Oracle read failed");
}

export async function getVaultStatus(p) {
  const v = await getReadContract(p);
  const [ri, locked, balances, feeTiers] = await Promise.all([
    v.getRoundInfo(),
    v.isLocked(),
    v.getVaultBalances(),
    v.getFeeTiers(),
  ]);

  return {
    roundId: b(ri[0]),
    startTime: b(ri[1]),
    isActive: bool(ri[2]),
    paused: bool(ri[3]),
    limitUsd: b(ri[4]),
    locked: bool(locked),
    balances: { wone: BigInt(balances[0]), usdc: BigInt(balances[1]) },
    feeThresholds: feeTiers[0].map(b),
    feeBps: feeTiers[1].map(n),
  };
}
