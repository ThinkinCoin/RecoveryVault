// src/services/vaultService.jsx
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";
import IWETHABI from "@/ui/abi/IWETH.json";
import IOracleABI from "@/ui/abi/IOracle.json";
import {
  extractRpcRevert,
  safeEstimateGas,
  isActionRejected,
  buildGasFees,
} from "@/services/txUtils";

// ==========================
// Core
// ==========================

const RPC_URL = import.meta.env.VITE_RPC_URL;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
export const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
const VAULT_ABI = VaultArtifact.abi ?? VaultArtifact;

function req(v, msg) {
  if (!v) throw new Error(msg);
  return v;
}

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
  const net = await readProvider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    console.warn(`[vaultService] Unexpected chainId ${net.chainId}; expected ${CHAIN_ID}`);
  }
  const code = await readProvider.getCode(addr);
  if (!code || code === "0x") throw new Error(`[vaultService] ${addr} has no bytecode`);
  return new Contract(addr, VAULT_ABI, readProvider);
}

export async function getWriteContract(signer) {
  req(signer, "[vaultService] signer is required");
  const addr = getVaultAddress();
  return new Contract(addr, VAULT_ABI, signer);
}

// Helpers
function b(v) { return BigInt(v); }
function n(v) { return Number(v); }
function bool(v) { return Boolean(v); }
export function normalizeAddress(addr) { try { return getAddress(addr); } catch { return null; } }
function isDecode0x(err) {
  const msg = String(err?.message || err || "");
  return (
    err?.code === "BAD_DATA" ||
    /could not decode result data/i.test(msg) ||
    /value="?0x"?/i.test(msg)
  );
}
function addrEq(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}
function isZeroBytes32(x) {
  return !x || /^0x0{64}$/i.test(String(x));
}
// Minimal ERC20
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
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

// Aggregated vault status
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

// Quote
export async function quoteRedeem(p, user, tokenIn, amountIn, redeemIn, proof = []) {
  const v = await getReadContract(p);
  const r = await v.quoteRedeem(user, tokenIn, amountIn, redeemIn, proof ?? []);
  return {
    whitelisted: bool(r[0]),
    roundIsActive: bool(r[1]),
    feeAmount: b(r[2]),
    refundAmount: b(r[3]),
    userLimitUsdBefore: b(r[4]),
    userLimitUsdAfter: b(r[5]),
    usdValue: b(r[6]),
    tokenInDecimals: n(r[7]),
    redeemInDecimals: n(r[8]),
    oraclePrice: b(r[9]),
    oracleDecimals: n(r[10]),
  };
}

export async function oracleLatest(p) {
  const o = await oracle(p);
  const c = new Contract(o, IOracleABI.abi ?? IOracleABI, p);
  const r = await c.latestPrice();
  return { price: BigInt(r[0]), decimals: Number(r[1]) };
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
    results[t] = BigInt(await v.fixedUsdPrice(t));
  }
  return results;
}

// ==========================
// Admin (Write)
// ==========================

export async function redeem(signer, tokenIn, amountIn, redeemIn, proof = [], overrides = {}) {
  const v = await getWriteContract(signer);
  if (!Array.isArray(proof)) proof = [];
  return await v.redeem(tokenIn, amountIn, redeemIn, proof, { ...overrides });
}

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
 * Preflight de leitura: valida regras de negócio usando view calls,
 * e retorna motivos amigáveis antes da simulação/tx.
 */
export async function preflightReadChecks(vault, provider, ctx) {
  try {
    const { user, tokenIn, amountIn, redeemIn, proof } = ctx || {};
    if (!user)  return { ok: false, reason: "Connect a wallet" };
    if (!tokenIn) return { ok: false, reason: "Select a token" };
    if (!redeemIn) return { ok: false, reason: "Select wONE or USDC" };
    if (!amountIn || BigInt(amountIn) <= 0n) return { ok: false, reason: "Enter an amount" };

    // Leitura base
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
    const start    = BigInt(roundInfo[1]);

    if (locked) return { ok: false, reason: "Vault is locked" };
    if (paused) return { ok: false, reason: "Vault is paused" };
    if (!isActive) return { ok: false, reason: "No active round" };

    // ROUND_DELAY
    const delay  = BigInt(await vault.ROUND_DELAY().catch(() => 0n));
    const latest = await provider.getBlock("latest");
    const now    = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000));
    if (delay && start && now < (start + delay)) {
      const secs = Number((start + delay) - now);
      const mins = Math.ceil(secs / 60);
      return { ok: false, reason: `Round delay in effect. Try again in ~${mins} min` };
    }

    // Whitelist obrigatória se root != 0
    if (!isZeroBytes32(root)) {
      const hasProof = Array.isArray(proof) && proof.length > 0;
      if (!hasProof) {
        return { ok: false, reason: "Address not whitelisted (missing proof)" };
      }
    }

    // Tente usar quoteRedeem (se existir). Se vier 0x/BAD_DATA, fazemos fallback.
    if (typeof vault.quoteRedeem === "function") {
      try {
        const q = await vault.quoteRedeem(user, tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : []);
        const whitelisted     = Boolean(q[0]);
        const roundIsActive   = Boolean(q[1]);
        const userLimitBefore = BigInt(q[4]);
        const usdValue        = BigInt(q[6]);
        if (!isZeroBytes32(root) && !whitelisted) {
          return { ok: false, reason: "Address not whitelisted (invalid or wrong proof)" };
        }
        if (!roundIsActive) return { ok: false, reason: "Round is not active" };
        if (usdValue === 0n) return { ok: false, reason: "Price unavailable for selected token" };
        if (userLimitBefore < usdValue) {
          return { ok: false, reason: "Insufficient remaining daily limit" };
        }
        // tudo certo com quote
        return { ok: true };
      } catch (err) {
        if (!isDecode0x(err)) {
          // erro real com motivo decodificável
          const reason = extractRpcRevert(err, vault.interface);
          return { ok: false, reason: reason || "quote failed" };
        }
        console.warn("[vaultService] quoteRedeem returned 0x/BAD_DATA; using fallback checks");
        // segue para fallback abaixo
      }
    } else {
      console.warn("[vaultService] quoteRedeem missing on-chain; using fallback checks");
    }

    // ---------- FALLBACK (sem quoteRedeem) ----------
    // Exigir preço on-chain para o token de entrada
    const price18 = BigInt(await vault.fixedUsdPrice(tokenIn).catch(() => 0n));
    if (price18 === 0n) {
      return { ok: false, reason: "Price unavailable for selected token" };
    }
    // USD da entrada (18d)
    const usdValue = (BigInt(amountIn) * price18) / 10n**18n;

    // Limite diário do usuário
    try {
      const rem = await vault.getUserLimit(user).catch(() => null);
      const remainingUSD = rem ? BigInt(rem) : null;
      if (remainingUSD !== null && remainingUSD < usdValue) {
        return { ok: false, reason: "Insufficient remaining daily limit" };
      }
    } catch {/* ignora se função ausente */}

    // Liquidez do cofre (checagens leves)
    try {
      const bals = await vault.getVaultBalances();
      const woneBal = BigInt(bals[0]);
      const usdcBal = BigInt(bals[1]);

      if (addrEq(redeemIn, usdcAddr)) {
        // Para USDC, um sanity check simples: precisa haver algum saldo
        if (usdcBal === 0n) return { ok: false, reason: "Vault has no USDC available" };
      } else if (addrEq(redeemIn, woneAddr)) {
        if (woneBal === 0n) return { ok: false, reason: "Vault has no wONE available" };
      }
    } catch {/* sem bloqueio duro se não conseguir ler */}

    return { ok: true, note: "fallback" };
  } catch (err) {
    return { ok: false, reason: err?.message || "Preflight checks failed" };
  }
}


/**
 * Simulação de redeem: roda preflight, faz eth_call com value=0
 * e não tenta decodificar retorno (função não tem outputs).
 */
export async function preflightRedeem(readProvider, { fn, args, context }) {
  const vault = await getReadContract(readProvider);

  const checks = await preflightReadChecks(vault, readProvider, context);
  if (!checks.ok) return checks;

  try {
    const iface = new Interface(VAULT_ABI);
    const frag  = iface.getFunction(fn);
    const data  = iface.encodeFunctionData(frag, args);

    const to =
      (typeof vault.getAddress === "function" ? await vault.getAddress() : null) ||
      vault.target ||
      getVaultAddress();

    await readProvider.call({ to, data, from: context?.user, value: 0n });
    return { ok: true };
  } catch (err) {
    try {
      const reason = extractRpcRevert(err, vault.interface);
      return { ok: false, reason: reason || "Execution reverted (no reason)" };
    } catch {
      return { ok: false, reason: "Execution reverted (no reason)" };
    }
  }
}

/**
 * Envia a transação após simulação aprovada.
 * Suporta EIP-1559/legacy e para limpo em ACTION_REJECTED (4001).
 */
export async function submitRedeem(signerContract, { fn, args }, opts = {}) {
  try {
    const vault = await getWriteContract(signerContract);
    const provider = signerContract?.provider;

    const feeOverrides = await buildGasFees(provider);

    const gasLimit = await safeEstimateGas(vault, fn, args, {
      fallback: opts.fallbackGas ?? 300000n,
      overrides: { value: 0n },
    });

    const overrides = {
      ...feeOverrides,
      gasLimit,
      value: 0n,
      ...(opts.overrides || {}),
    };

    const tx = await vault.getFunction(fn)(...args, overrides);
    return { ok: true, tx };
  } catch (err) {
    if (isActionRejected(err)) {
      return { ok: false, rejected: true, reason: "User rejected" };
    }
    try {
      const v = await getWriteContract(signerContract);
      const reason = extractRpcRevert(err, v.interface);
      return { ok: false, reason: reason || err?.message || "send failed" };
    } catch {
      return { ok: false, reason: err?.message || "send failed" };
    }
  }
}

/**
 * Fluxo completo para uma assinatura específica (simulate → send).
 * Para imediatamente se o usuário rejeitar.
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

  if (!sim.ok) {
    return { ok: false, stage: "simulate", reason: sim.reason };
  }

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
