// src/services/vaultService.jsx
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";
import IWETHABI from "@/ui/abi/IWETH.json";
import {
  extractRpcRevert,
  isActionRejected,
  buildGasFees,
  GAS_LIMIT_FALLBACK,
  ensureLegacyOverrides,
} from "@/services/txUtils";

import { TracedProvider } from "@/debug/TracedProvider";

import { log, ok, warn, error as logError } from "@/debug/logger";

// ==========================
// Core
// ==========================
const RPC_URL = import.meta.env.VITE_RPC_URL;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
export const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
const VAULT_ABI = VaultArtifact.abi ?? VaultArtifact;
const DEV = !!import.meta.env?.DEV;

function req(v, msg) { if (!v) throw new Error(msg); return v; }

export function getDefaultProvider() {
  req(RPC_URL, "[vaultService] VITE_RPC_URL is missing");
  return new JsonRpcProvider(RPC_URL);
}

export function getVaultAddress() {
  return req(VAULT_ADDRESS, "[vaultService] VITE_VAULT_ADDRESS is missing");
}

export async function getReadContract(readProvider) {
  req(readProvider, "[vaultService] readProvider is required");
  const addr = getVaultAddress();
  const code = await readProvider.getCode(addr);
  if (!code || code === "0x") throw new Error(`[vaultService] ${addr} has no bytecode`);
  return new Contract(addr, VAULT_ABI, readProvider);
}

export async function getWriteContract(signer) {
  req(signer, "[vaultService] signer is required");
  const addr = getVaultAddress();
  return new Contract(addr, VAULT_ABI, signer);
}

async function assertHarmonySigner(signer) {
  const net = await signer.provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error(`Wrong network: ${net.chainId}. Switch to Harmony (${CHAIN_ID}).`);
  }
}

// ==========================
// Helpers
// ==========================
function b(v) { return typeof v === "bigint" ? v : BigInt(v); }
function n(v) { return Number(v); }
function bool(v) { return Boolean(v); }
export function normalizeAddress(addr) { try { return getAddress(addr); } catch { return null; } }
function addrEq(a, b) { return String(a||"").toLowerCase() === String(b||"").toLowerCase(); }
function isZeroBytes32(x) { return !x || /^0x0{64}$/i.test(String(x)); }
function isDecode0x(err) {
  const msg = String(err?.message || err || "");
  return err?.code === "BAD_DATA" || /could not decode result data/i.test(msg) || /value="?0x"?/i.test(msg);
}
function decimalToBigInt(value, decimals) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error("Invalid override");
  const [i, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

// Minimal ERC20 (inclui decimals!)
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ==========================
// Info (Read-only)
// ==========================
export async function owner(p){ return await (await getReadContract(p)).owner(); }
export async function oracle(p){ return await (await getReadContract(p)).oracle(); }
export async function devWallet(p){ return await (await getReadContract(p)).devWallet(); }
export async function rmcWallet(p){ return await (await getReadContract(p)).rmcWallet(); }
export async function wONE(p){ return await (await getReadContract(p)).wONE(); }
export async function usdc(p){ return await (await getReadContract(p)).usdc(); }
export async function merkleRoot(p){ return await (await getReadContract(p)).merkleRoot(); }

export async function ROUND_DELAY(p){ return b(await (await getReadContract(p)).ROUND_DELAY()); }
export async function WALLET_RESET_INTERVAL(p){ return b(await (await getReadContract(p)).WALLET_RESET_INTERVAL()); }
export async function currentRound(p){ return b(await (await getReadContract(p)).currentRound()); }
export async function roundStart(p){ return b(await (await getReadContract(p)).roundStart()); }
export async function dailyLimitUsd(p){ return b(await (await getReadContract(p)).dailyLimitUsd()); }
export async function isLocked(p){ return bool(await (await getReadContract(p)).isLocked()); }

export async function fixedUsdPrice(p, token){ return b(await (await getReadContract(p)).fixedUsdPrice(token)); }
export async function supportedToken(p, token){ return bool(await (await getReadContract(p)).supportedToken(token)); }
export async function supportedTokenList(p, i){ return await (await getReadContract(p)).supportedTokenList(i); }

export async function feeThresholds(p, i){ return b(await (await getReadContract(p)).feeThresholds(i)); }
export async function feeBps(p, i){ return n(await (await getReadContract(p)).feeBps(i)); }
export async function redeemedInRound(p, roundId, wallet){ return b(await (await getReadContract(p)).redeemedInRound(roundId, wallet)); }

export async function getFeeTiers(p) {
  const v = await getReadContract(p);
  const r = await v.getFeeTiers();
  return { thresholds: r[0].map(b), bps: r[1].map(n) };
}

export async function getSupportedTokens(p){ return await (await getReadContract(p)).getSupportedTokens(); }

export async function getUserLimit(p, wallet){
  const r = await (await getReadContract(p)).getUserLimit(wallet);
  return { remainingUSD: b(r) };
}

export async function getVaultBalances(p){
  const r = await (await getReadContract(p)).getVaultBalances();
  return { woneBalance: b(r[0]), usdcBalance: b(r[1]) };
}

export async function getLastRedeemTimestamp(p, user){
  return b(await (await getReadContract(p)).getLastRedeemTimestamp(user));
}

export async function getRoundInfo(p){
  const r = await (await getReadContract(p)).getRoundInfo();
  return { roundId: b(r[0]), startTime: b(r[1]), isActive: bool(r[2]), paused: bool(r[3]), limitUsd: b(r[4]) };
}

// Agregado
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
    balances: { wone: b(balances[0]), usdc: b(balances[1]) },
    feeThresholds: feeTiers[0].map(b),
    feeBps: feeTiers[1].map(n),
  };
}

// ==========================
// Quote 
// ==========================
export async function quoteRedeem(p, user, tokenIn, amountIn, redeemIn, proof = []) {
  const v = await getReadContract(p);
  const r = await v.quoteRedeem(user, tokenIn, amountIn, redeemIn, proof ?? []);
  return {
    whitelisted:        Boolean(r[0]),
    roundIsActive:      Boolean(r[1]),
    feeAmountInTokenIn: BigInt(r[2]),
    burnAmountInTokenIn:BigInt(r[3]),
    userLimitUsdBefore: BigInt(r[4]),
    userLimitUsdAfter:  BigInt(r[5]),
    usdValueIn:         BigInt(r[6]),
    tokenInDecimals:    Number(r[7]),
    redeemInDecimals:   Number(r[8]),
    oraclePrice:        BigInt(r[9]),
    oracleDecimals:     Number(r[10]),
    amountOutRedeemToken: BigInt(r[11]),
  };
}

export async function oracleLatest(p) {
  const o = await oracle(p);
  const code = await p.getCode(o);
  if (!code || code === "0x") throw new Error(`Oracle address has no bytecode (${o})`);

  try {
    const ovRaw = import.meta.env.VITE_ONE_USD_OVERRIDE;
    if (ovRaw != null && String(ovRaw).trim() !== "") {
      return { price: decimalToBigInt(String(ovRaw), 18), decimals: 18 };
    }
  } catch {}

  try {
    const abiA = [{
      inputs: [], name: "latestPrice",
      outputs: [{type:"uint256",name:"price"},{type:"uint8",name:"decimals"}],
      stateMutability:"view", type:"function"
    }];
    const cA = new Contract(o, abiA, p);
    const r = await cA.latestPrice();
    const price = b(r[0]); const decimals = n(r[1]);
    if (price > 0n) return { price, decimals };
  } catch {}

  try {
    const abiB = [{
      inputs: [], name: "latestPrice",
      outputs: [{type:"int256",name:"price"},{type:"uint8",name:"decimals"}],
      stateMutability:"view", type:"function"
    }];
    const cB = new Contract(o, abiB, p);
    const r = await cB.latestPrice();
    const price = b(r[0]); const decimals = n(r[1]);
    if (price > 0n) return { price, decimals };
  } catch {}

  try {
    const abiC = [{
      inputs: [{name:"base",type:"string"},{name:"quote",type:"string"}],
      name: "getReferenceData",
      outputs: [
        {name:"rate",type:"uint256"},
        {name:"lastUpdatedBase",type:"uint256"},
        {name:"lastUpdatedQuote",type:"uint256"}
      ],
      stateMutability:"view", type:"function"
    }];
    const cC = new Contract(o, abiC, p);
    const r = await cC.getReferenceData("ONE","USD");
    const price = b(r[0]);
    if (price > 0n) return { price, decimals: 18 };
  } catch {}

  try {
    const abiD = [
      { inputs: [], name: "latestAnswer", outputs: [{type:"int256"}], stateMutability:"view", type:"function" },
      { inputs: [], name: "decimals",     outputs: [{type:"uint8"}],  stateMutability:"view", type:"function" }
    ];
    const cD = new Contract(o, abiD, p);
    const [ans, dec] = await Promise.all([cD.latestAnswer(), cD.decimals()]);
    const price = b(ans); const decimals = n(dec);
    if (price > 0n) return { price, decimals };
  } catch {}

  try {
    const abiE = [
      { inputs: [], name: "latestRoundData",
        outputs: [{type:"uint80"},{type:"int256"},{type:"uint256"},{type:"uint256"},{type:"uint80"}],
        stateMutability:"view", type:"function" },
      { inputs: [], name: "decimals", outputs: [{type:"uint8"}], stateMutability:"view", type:"function" }
    ];
    const cE = new Contract(o, abiE, p);
    const data = await cE.latestRoundData();
    const dec  = await cE.decimals();
    const price = b(data[1]); const decimals = n(dec);
    if (price > 0n) return { price, decimals };
  } catch {}

  try {
    const abiF = [
      { inputs: [], name: "latestRoundData",
        outputs: [{type:"uint80"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint80"}],
        stateMutability:"view", type:"function" },
      { inputs: [], name: "decimals", outputs: [{type:"uint8"}], stateMutability:"view", type:"function" }
    ];
    const cF = new Contract(o, abiF, p);
    const data = await cF.latestRoundData();
    const dec  = await cF.decimals();
    const price = b(data[1]); const decimals = n(dec);
    if (price > 0n) return { price, decimals };
  } catch {}

  throw new Error("Oracle read failed: no supported interface (Band/Chainlink) matched");
}




export async function isTokenSupported(p, token){
  const t = normalizeAddress(token);
  if (!t) return false;
  try {
    const ok = await supportedToken(p, t);
    if (typeof ok === "boolean") return ok;
  } catch {}
  try {
    const list = await getSupportedTokens(p);
    const set = new Set(list.map(normalizeAddress).filter(Boolean));
    return set.has(t);
  } catch {
    return false;
  }
}

export async function getAllFixedPrices(p, tokens) {
  const v = await getReadContract(p);
  const results = {};
  for (const t of tokens) {
    results[t] = await v.fixedUsdPrice(t);
  }
  return results;
}

// ==========================
// Admin (Write)
// ==========================

export async function setDailyLimit(signer, usdAmount){ return await (await getWriteContract(signer)).setDailyLimit(usdAmount); }
export async function setDevWallet(signer, wallet){ return await (await getWriteContract(signer)).setDevWallet(wallet); }
export async function setFeeTiers(signer, thresholds, bps){ return await (await getWriteContract(signer)).setFeeTiers(thresholds, bps); }
export async function setFixedUsdPrice(signer, token, usdPrice18){ return await (await getWriteContract(signer)).setFixedUsdPrice(token, usdPrice18); }
export async function setLocked(signer, status){ return await (await getWriteContract(signer)).setLocked(status); }
export async function setMerkleRoot(signer, root){ return await (await getWriteContract(signer)).setMerkleRoot(root); }
export async function setOracle(signer, addr){ return await (await getWriteContract(signer)).setOracle(addr); }
export async function setRmcWallet(signer, wallet){ return await (await getWriteContract(signer)).setRmcWallet(wallet); }
export async function setSupportedToken(signer, token, allowed){ return await (await getWriteContract(signer)).setSupportedToken(token, allowed); }

export async function startNewRound(signer, roundId){ return await (await getWriteContract(signer)).startNewRound(roundId); }
export async function transferOwnership(signer, newOwner){ return await (await getWriteContract(signer)).transferOwnership(newOwner); }
export async function renounceOwnership(signer){ return await (await getWriteContract(signer)).renounceOwnership(); }
export async function withdrawFunds(signer, token){ return await (await getWriteContract(signer)).withdrawFunds(token); }

// ==========================
// Utils
// ==========================
export async function wrapNativeToWONE(signer, amount) {
  const provider = signer.provider;
  const v = await getReadContract(provider);
  const w = await v.wONE();
  const c = new Contract(w, IWETHABI.abi ?? IWETHABI, signer);
  return await c.deposit({ value: amount });
}

export function getEventTopics() {
  const iface = new Interface(VAULT_ABI);
  return {
    BurnToken: iface.getEventTopic("BurnToken"),
    NewRoundStarted: iface.getEventTopic("NewRoundStarted"),
    RedeemProcessed: iface.getEventTopic("RedeemProcessed"),
    SupportedTokenUpdated: iface.getEventTopic("SupportedTokenUpdated"),
    FeeTiersUpdated: iface.getEventTopic("FeeTiersUpdated"),
    VaultPaused: iface.getEventTopic("VaultPaused"),
    OwnershipTransferred: iface.getEventTopic("OwnershipTransferred"),
  };
}

// ==========================
// Redeem – simulate-first & robust send
// ==========================
/**
 * Preflight de leitura: valida regras de negócio com views.
 * Usa quoteRedeem quando possível. Fallback cobre wONE/usdc/fixedUsdPrice
 * e também estima amountOut + liquidez.
 */
export async function preflightReadChecks(vault, provider, ctx) {
  try {
    log("Vault: preflight checks start");
    const { user, tokenIn, amountIn, redeemIn, proof } = ctx || {};
    if (!user)  return { ok: false, reason: "Connect a wallet" };
    if (!tokenIn) return { ok: false, reason: "Select a token" };
    if (!redeemIn) return { ok: false, reason: "Select wONE or USDC" };
    if (!amountIn || BigInt(amountIn) <= 0n) return { ok: false, reason: "Enter an amount" };

    const [woneAddr, usdcAddr, roundInfo, locked, root, supported] = await Promise.all([
      vault.wONE(),
      vault.usdc(),
      vault.getRoundInfo(),
      vault.isLocked(),
      vault.merkleRoot(),
      vault.supportedToken(tokenIn).catch(() => false),
    ]);

    if (!supported) return { ok: false, reason: "Token not supported by the vault" };
    if (!addrEq(redeemIn, woneAddr) && !addrEq(redeemIn, usdcAddr)) {
      return { ok: false, reason: "Invalid receive token (must be wONE or USDC)" };
    }

    const isActive = Boolean(roundInfo[2]);
    const paused   = Boolean(roundInfo[3]);
    const start    = b(roundInfo[1]);

    if (locked) return { ok: false, reason: "Vault is locked" };
    if (paused) return { ok: false, reason: "Vault is paused" };
    if (!isActive) {
      try {
        const latest = await provider.getBlock("latest");
        const now    = b(latest?.timestamp ?? Math.floor(Date.now() / 1000));
        if (start && now < start) {
          const secs = Number(start - now);
          const mins = Math.ceil(secs / 60);
          return { ok: false, reason: `Round starts in ~${mins} min` };
        }
      } catch {}
      return { ok: false, reason: "No active round" };
    }

    if (!isZeroBytes32(root)) {
      const hasProof = Array.isArray(proof) && proof.length > 0;
      if (!hasProof) return { ok: false, reason: "Address not whitelisted (missing proof)" };
    }

    if (typeof vault.quoteRedeem === "function") {
      try {
        const q = await vault.quoteRedeem(user, tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : []);
        ok("Vault: quoteRedeem ok");
        const whitelisted     = Boolean(q[0]);
        const roundIsActive   = Boolean(q[1]);
        const userLimitBefore = b(q[4]);
        const usdValueIn      = b(q[6]);
        const amountOut       = b(q[11]);

        if (!isZeroBytes32(root) && !whitelisted) return { ok: false, reason: "Address not whitelisted (invalid or wrong proof)" };
        if (!roundIsActive) return { ok: false, reason: "Round is not active" };
        if (usdValueIn === 0n) return { ok: false, reason: "Price unavailable for selected token" };
        if (userLimitBefore < usdValueIn) return { ok: false, reason: "Insufficient remaining daily limit" };

        try {
          const bals = await vault.getVaultBalances();
          const woneBal = b(bals[0]);
          const usdcBal = b(bals[1]);
          if (addrEq(redeemIn, usdcAddr) && usdcBal < amountOut) return { ok: false, reason: "Insufficient liquidity" };
          if (addrEq(redeemIn, woneAddr) && woneBal < amountOut) return { ok: false, reason: "Insufficient liquidity" };
        } catch {}

        return { ok: true };
      } catch (err) {
        if (!isDecode0x(err)) {
          const reason = extractRpcRevert(err, vault.interface);
          logError(`Vault: quoteRedeem revert: ${reason || err?.message || "unknown"}`);
          return { ok: false, reason: reason || "quote failed" };
        }
        warn("Vault: quoteRedeem BAD_DATA; falling back to local pricing & limits");
      }
    } else if (DEV) {
      console.warn("[vaultService] quoteRedeem missing on-chain; using fallback checks");
    }

    const one = 10n ** 18n;

    async function tokenDecimals(addr) {
      try {
        const erc = new Contract(addr, ERC20_ABI, provider);
        return b(await erc.decimals());
      } catch {
        return 18n;
      }
    }

    async function usdValueInt(token, amount) {
      if (addrEq(token, woneAddr)) {
        const dec = await tokenDecimals(token);
        const or  = await oracleLatest(provider);
        const amount1e18 = (b(amount) * one) / (10n ** dec);
        return ((amount1e18 * or.price) / (10n ** b(or.decimals))) / one;
      } else if (addrEq(token, usdcAddr)) {
        const udec = await tokenDecimals(usdcAddr);
        return b(amount) / (10n ** udec);
      } else {
        const px18 = b(await vault.fixedUsdPrice(token).catch(() => 0n));
        if (px18 === 0n) throw new Error("Price unavailable for selected token");
        const dec = await tokenDecimals(token);
        return (b(amount) * px18) / (10n ** dec) / one;
      }
    }

    async function priceOut18(token) {
      if (addrEq(token, usdcAddr)) return one;
      if (addrEq(token, woneAddr)) {
        const or = await oracleLatest(provider);
        return (b(or.price) * one) / (10n ** b(or.decimals));
      }
      throw new Error("Unsupported redeem token");
    }


    function calcFeeTokenIn(amountInBN, usdInt, thresholdsBN, bpsArr) {
      for (let i = 0; i < thresholdsBN.length; i++) {
        if (usdInt <= thresholdsBN[i]) {
          return (amountInBN * b(bpsArr[i])) / 10000n;
        }
      }
      return (amountInBN * b(bpsArr[bpsArr.length - 1])) / 10000n;
    }

    const usdIn = await usdValueInt(tokenIn, amountIn);

    try {
      const remaining = b(await vault.getUserLimit(user));
      if (usdIn > remaining) return { ok: false, reason: "Insufficient remaining daily limit" };
    } catch {}

    let feeTokenIn = 0n;
    try {
      const ft = await vault.getFeeTiers();
      const thresholdsBN = ft[0].map((x) => b(x));
      const bpsArr = ft[1].map((x) => n(x));
      feeTokenIn = calcFeeTokenIn(b(amountIn), b(usdIn), thresholdsBN, bpsArr);
    } catch {
      feeTokenIn = (b(amountIn) * 10n) / 10000n;
    }
    const netIn = b(amountIn) - feeTokenIn;
    const usdNet = await usdValueInt(tokenIn, netIn);

    const redeemDec = await (async () => {
      try {
        const erc = new Contract(redeemIn, ERC20_ABI, provider);
        return b(await erc.decimals());
      } catch { return 18n; }
    })();
    const pOut18 = await priceOut18(redeemIn);
    const amountOut = (usdNet * one * (10n ** redeemDec)) / pOut18;

    try {
      const bals = await vault.getVaultBalances();
      const woneBal = b(bals[0]);
      const usdcBal = b(bals[1]);
      if (addrEq(redeemIn, usdcAddr) && usdcBal < amountOut) return { ok: false, reason: "Insufficient liquidity" };
      if (addrEq(redeemIn, woneAddr) && woneBal < amountOut) return { ok: false, reason: "Insufficient liquidity" };
    } catch {}

    return { ok: true, note: "fallback" };
  } catch (err) {
    return { ok: false, reason: err?.message || "Preflight checks failed" };
  }
}

/**
 * Simulação (eth_call)
 */
export async function preflightRedeem(readProvider, { fn, args, context }) {
  const vault = await getReadContract(readProvider);
  try {
    const iface = new Interface(VAULT_ABI);
    const frag  = iface.getFunction(fn);
    const data  = iface.encodeFunctionData(frag, args);
    const to =
      (typeof vault.getAddress === "function" ? await vault.getAddress() : null) ||
      vault.target ||
      getVaultAddress();
    await readProvider.call({ to, data });
    return { ok: true };
  } catch (err) {
    try {
      const reason = extractRpcRevert(err, vault.interface);
      return { ok: false, reason: reason || "Execution reverted" };
    } catch {
      return { ok: false, reason: "Execution reverted" };
    }
  }
}

/**
 * Envio da tx (com fallbacks de gas e estimate)
 */
export async function submitRedeem(signer, { fn, args }, opts = {}) {
  try {
    await assertHarmonySigner(signer);
    const vault = await getWriteContract(signer);
    const fee = await buildGasFees(signer.provider);

    try {
      await vault.getFunction(fn).staticCall(...args);
    } catch (err) {
      const reason = extractRpcRevert(err, vault.interface);
      return { ok: false, stage: "simulate", reason: reason || "Redeem will revert" };
    }
    const gasLimit = BigInt(opts.fallbackGas ?? GAS_LIMIT_FALLBACK);
    const overrides = ensureLegacyOverrides({ ...fee, gasLimit });

    const tx = await vault.getFunction(fn)(...args, overrides);
    return { ok: true, tx };
  } catch (err) {
    if (isActionRejected(err)) return { ok: false, rejected: true, reason: "User rejected" };
    try {
      const v = await getWriteContract(signer);
      const reason = extractRpcRevert(err, v.interface);
      return { ok: false, reason: reason || err?.message || "send failed" };
    } catch {
      return { ok: false, reason: err?.message || "send failed" };
    }
  }
}


/**
 * Variante única (simulate → send)
 */
export async function redeemVariantFlow({
  signer,
  readProvider,
  fn,
  args,
  user,
  tokenIn,
  amountIn,
  redeemIn,
  proof,
}) {
  const sim = await preflightRedeem(readProvider, {
    fn,
    args,
    context: { user, tokenIn, amountIn, redeemIn, proof },
  });

  if (!sim.ok) return { ok: false, stage: "simulate", reason: sim.reason };

  const sent = await submitRedeem(signer, { fn, args });
  if (!sent.ok) {
    return {
      ok: false,
      stage: sent.rejected ? "rejected" : "send",
      reason: sent.reason,
      rejected: !!sent.rejected,
    };
  }

  return { ok: true, tx: sent.tx };
}

export async function redeem(
  signer,
  tokenIn,
  amountIn,          // bigint ou string numérica
  redeemIn,
  proof = [],
  overrides = {}
) {
  await assertHarmonySigner(signer);
  const v = await getWriteContract(signer);
  const fee = await buildGasFees(signer.provider);

  // Normaliza a prova para bytes32[]
  const normalizedProof = Array.isArray(proof)
    ? proof.map(p => (typeof p === 'string' ? p : ethers.hexlify(p)))
    : [];

  const args = [tokenIn, amountIn, redeemIn, normalizedProof];

  // Use SEMPRE os mesmos overrides em todas as chamadas
  const mergedOverrides = {
    value: overrides?.value ?? 0n,     // padrão: não enviar ONE nativo
    gasPrice: fee.gasPrice,
    ...overrides,
  };

  // (Opcional, mas útil) sanity checks antes da simulação
  const me = await signer.getAddress();
  const [round, isSupported] = await Promise.all([
    v.getRoundInfo(),                  // { roundId, startTime, isActive, paused, limitUsd }
    v.supportedToken(tokenIn),
  ]);
  if (!isSupported) throw new Error('tokenIn não suportado pelo vault');
  if (!round.isActive || round.paused) throw new Error('round inativa ou vault pausado');

  // Garante whitelist/limite e preço > 0
  const q = await v.quoteRedeem(me, tokenIn, amountIn, redeemIn, normalizedProof);
  if (!q.whitelisted) throw new Error('prova inválida ou wallet fora da whitelist');
  if (!q.roundIsActive) throw new Error('round não está ativa');
  if (q.oraclePrice === 0n && (await v.fixedUsdPrice(tokenIn)) === 0n)
    throw new Error('preço do tokenIn indisponível');

  try {
    // Simula com os MESMOS overrides
    await v.redeem.staticCall(...args, mergedOverrides);
  } catch (err) {
    const reason = extractRpcRevert(err, v.interface);
    throw new Error(`Redeem vai reverter: ${reason}`);
  }
  const gasLimit = GAS_LIMIT_FALLBACK;
  const finalOverrides = ensureLegacyOverrides({ ...mergedOverrides, gasLimit });
  return v.redeem(...args, finalOverrides);

}
