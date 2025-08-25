import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";
import IWETHABI from "@/ui/abi/IWETH.json";
import IOracleABI from "@/ui/abi/IOracle.json";

const RPC_URL = import.meta.env.VITE_RPC_URL;
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;

const VAULT_ABI = VaultArtifact.abi ?? VaultArtifact;

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
  const net = await readProvider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) console.warn(`[vaultService] Unexpected chainId ${net.chainId}; expected ${CHAIN_ID}`);
  const code = await readProvider.getCode(addr);
  if (!code || code === "0x") throw new Error(`[vaultService] ${addr} has no bytecode`);
  return new Contract(addr, VAULT_ABI, readProvider);
}

export async function getWriteContract(signer) {
  req(signer, "[vaultService] signer is required");
  const addr = getVaultAddress();
  return new Contract(addr, VAULT_ABI, signer);
}

function b(v){ return BigInt(v); }
function n(v){ return Number(v); }
function bool(v){ return Boolean(v); }

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
export async function lastRedeemTimestamp(p, wallet){ return b(await (await getReadContract(p)).lastRedeemTimestamp(wallet)); }
export async function supportedToken(p, token){ return bool(await (await getReadContract(p)).supportedToken(token)); }
export async function supportedTokenList(p, i){ return await (await getReadContract(p)).supportedTokenList(i); }
export async function feeThresholds(p, i){ return b(await (await getReadContract(p)).feeThresholds(i)); }
export async function feeBps(p, i){ return Number(await (await getReadContract(p)).feeBps(i)); }
export async function redeemedInRound(p, roundId, wallet){ return b(await (await getReadContract(p)).redeemedInRound(roundId, wallet)); }

export async function getFeeTiers(p){
  const v = await getReadContract(p);
  const r = await v.getFeeTiers();
  return { thresholds: r[0].map(b), bpsOut: r[1].map(n) };
}

export async function getSupportedTokens(p){ return await (await getReadContract(p)).getSupportedTokens(); }
export async function getUserLimit(p, wallet){ const r = await (await getReadContract(p)).getUserLimit(wallet); return { remainingUSD: b(r) }; }
export async function getVaultBalances(p){ const r = await (await getReadContract(p)).getVaultBalances(); return { woneBalance: b(r[0]), usdcBalance: b(r[1]) }; }
export async function getLastRedeemTimestamp(p, user){ return b(await (await getReadContract(p)).getLastRedeemTimestamp(user)); }
export async function getRoundInfo(p){ const r = await (await getReadContract(p)).getRoundInfo(); return { roundId: b(r[0]), startTime: b(r[1]), isActive: bool(r[2]), paused: bool(r[3]), limitUsd: b(r[4]) }; }

export async function quoteRedeem(p, user, tokenIn, amountIn, redeemIn, proof = []){
  const v = await getReadContract(p);
  const r = await v.quoteRedeem(user, tokenIn, amountIn, redeemIn, proof ?? []);
  return { whitelisted: bool(r[0]), roundIsActive: bool(r[1]), feeAmount: b(r[2]), refundAmount: b(r[3]), userLimitUsdBefore: b(r[4]), userLimitUsdAfter: b(r[5]), usdValue: b(r[6]), tokenInDecimals: n(r[7]), redeemInDecimals: n(r[8]), oraclePrice: b(r[9]), oracleDecimals: n(r[10]) };
}

export async function redeem(signer, tokenIn, amountIn, redeemIn, proof = [], overrides = {}){
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
export async function withdrawFunds(signer, token){ return await (await getWriteContract(signer)).withdrawFunds(token); }
export async function renounceOwnership(signer){ return await (await getWriteContract(signer)).renounceOwnership(); }

export async function oracleLatest(p){
  const o = await oracle(p);
  const c = new Contract(o, IOracleABI.abi ?? IOracleABI, p);
  const r = await c.latestPrice();
  return { price: BigInt(r[0]), decimals: Number(r[1]) };
}

export async function wrapNativeToWONE(signer, amount){
  const provider = signer.provider;
  const v = await getReadContract(provider);
  const w = await v.wONE();
  const c = new Contract(w, IWETHABI.abi ?? IWETHABI, signer);
  return await c.deposit({ value: amount });
}

export function getEventTopics(){
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

export function normalizeAddress(addr){ try { return getAddress(addr); } catch { return null; } }

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
