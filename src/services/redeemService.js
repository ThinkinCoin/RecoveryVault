import { ethers } from "ethers";
import * as vault from "@/services/vaultService";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";
import { buildGasFees, GAS_LIMIT_FALLBACK, ensureLegacyOverrides } from "@/services/txUtils";

const VAULT_ABI = (VaultArtifact?.abi ?? VaultArtifact);
const iface = new ethers.Interface(VAULT_ABI);
const altIface = new ethers.Interface([
  "function quoteRedeem(address tokenIn,uint256 amountIn,address redeemIn,bytes32[] proof) view returns (bool,bool,uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint8,uint256)"
]);

const b = (v) => BigInt(v ?? 0n);
const n = (v) => Number(v ?? 0);
const toAddr = (a) => { try { return ethers.getAddress(a); } catch { return null; } };

export async function getTokenDecimals(provider, token){
  try{
    const erc = new ethers.Contract(token, ["function decimals() view returns (uint8)"], provider);
    return Number(await erc.decimals());
  } catch { return 18; }
}

export async function getTokenMetadata(provider, token){
  try{
    const erc = new ethers.Contract(token, [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ], provider);
    const [name, symbol, decimals] = await Promise.all([
      erc.name().catch(() => ""),
      erc.symbol().catch(() => ""),
      erc.decimals().then(Number).catch(() => 18),
    ]);
    return { address: toAddr(token), name, symbol, decimals };
  } catch {
    return { address: toAddr(token), name: "", symbol: "", decimals: 18 };
  }
}

export function parseAmount(amountHuman, decimals){
  const s = String(amountHuman ?? "0").replace(/,/g, ".");
  return ethers.parseUnits(s === "" ? "0" : s, Math.max(0, Number(decimals || 0)));
}

export function formatAmount(amount, decimals){
  try{ return ethers.formatUnits(b(amount), Math.max(0, Number(decimals||0))); } catch { return String(amount); }
}

export async function allowanceOf(provider, token, owner, spender){
  try{
    const erc = new ethers.Contract(token, ["function allowance(address,address) view returns (uint256)"], provider);
    return b(await erc.allowance(owner, spender));
  } catch { return 0n; }
}

export async function needsApproval(provider, token, owner, spender, required){
  try{
    const cur = await allowanceOf(provider, token, owner, spender);
    return (cur < b(required ?? 0n));
  } catch { return false; }
}

function sanitizeProof(proof){
  if (!Array.isArray(proof)) return [];
  const out = [];
  for (const p of proof){
    try { out.push(ethers.zeroPadValue(ethers.hexlify(p), 32)); } catch {}
  }
  return out;
}

async function callRaw(provider, to, data) {
  try { return await provider.call({ to, data }); }
  catch { return null; }
}

export async function safeQuoteRedeem(provider, vaultAddr, { user, tokenIn, amountIn, redeemIn, proof }) {
  try {
    const dataA = iface.encodeFunctionData("quoteRedeem", [user, tokenIn, amountIn, redeemIn, proof]);
    const rawA = await callRaw(provider, vaultAddr, dataA);
    if (rawA && rawA !== "0x") {
      const outA = iface.decodeFunctionResult("quoteRedeem", rawA);
      return outA;
    }
  } catch {}
  try {
    const dataB = altIface.encodeFunctionData("quoteRedeem", [tokenIn, amountIn, redeemIn, proof]);
    const rawB = await callRaw(provider, vaultAddr, dataB);
    if (rawB && rawB !== "0x") {
      const outB = altIface.decodeFunctionResult("quoteRedeem", rawB);
      return outB;
    }
  } catch {}
  try {
    const net = await provider.getNetwork();
    const code = await provider.getCode(vaultAddr);
    console.error("[redeemService] quoteRedeem EMPTY_RESULT", {
      chainId: Number(net?.chainId), vaultAddr,
      hasCode: code && code !== "0x", codeLen: (code?.length ?? 0)
    });
  } catch {}
  throw new Error("quoteRedeem() returned empty. Verifique: (1) endereço/chain corretos, (2) ABI igual ao contrato implantado, (3) a assinatura correta (com ou sem `user`) no deploy atual.");
}

export async function getUsdValue(provider, token, amountIn){
  const [wone, usdc] = await Promise.all([
    vault.wONE(provider).catch(() => null),
    vault.usdc(provider).catch(() => null),
  ]);
  const t = toAddr(token);
  const amt = b(amountIn ?? 0n);
  if (t && wone && toAddr(wone) === t){
    const dec = await getTokenDecimals(provider, t);
    const { price = 0n, decimals = 18 } = await vault.oracleLatest(provider).catch(() => ({ price: 0n, decimals: 18 }));
    if (b(price) <= 0n) return { usd: 0n, kind: "wone/oracle", price: 0n, decimals };
    const usd = (amt * b(price)) / (10n ** BigInt(decimals)) / (10n ** BigInt(dec));
    return { usd, kind: "wone/oracle", price: b(price), decimals };
  }
  if (t && usdc && toAddr(usdc) === t){
    const dec = await getTokenDecimals(provider, t);
    const usd = amt / (10n ** BigInt(dec));
    return { usd, kind: "usdc/face" };
  }
  const fixed = await vault.fixedUsdPrice(provider, t).catch(() => 0n);
  const dec = await getTokenDecimals(provider, t);
  if (fixed > 0n){
    const usd = (amt * fixed) / (10n ** BigInt(dec)) / (10n ** 18n);
    return { usd, kind: "fixed", fixed };
  }
  return { usd: 0n, kind: "unsupported" };
}

export async function getFeeSchedule(provider){
  const raw = await vault.getFeeTiers(provider).catch(() => ({ thresholds: [], bps: [] }));
  const thresholds = Array.from(raw?.thresholds ?? []).map((x) => b(x));
  const bps = Array.from(raw?.bps ?? []).map((x) => n(x));
  return { thresholds, bps };
}

export function pickBps(usdValue, thresholds, bps){
  const usd = b(usdValue);
  for (let i = 0; i < thresholds.length; i++){
    if (usd <= b(thresholds[i])) return n(bps[i] ?? 0);
  }
  return n(bps[(bps.length || 1) - 1] || 0);
}

export async function localQuote(provider, tokenIn, amountIn){
  const { usd } = await getUsdValue(provider, tokenIn, amountIn);
  const { thresholds, bps: bpsList } = await getFeeSchedule(provider);
  const bps = pickBps(usd, thresholds, bpsList);
  const fee = (b(amountIn) * BigInt(bps)) / 10000n;
  const refund = b(amountIn) - fee;
  return { usd, bps, fee, refund };
}

export async function getSupportedTokenInfos(provider){
  const addrs = await vault.getSupportedTokens(provider).catch(() => []);
  const uniq = Array.from(new Set((addrs || []).map(toAddr).filter(Boolean)));
  const metas = await Promise.all(uniq.map((a) => getTokenMetadata(provider, a)));
  return metas;
}

export async function getUserBalances(provider, user){
  const u = toAddr(user);
  if (!u) return {};
  const infos = await getSupportedTokenInfos(provider);
  const out = {};
  await Promise.all(infos.map(async (m) => {
    try{
      const erc = new ethers.Contract(m.address, ["function balanceOf(address) view returns (uint256)"], provider);
      const bal = b(await erc.balanceOf(u));
      out[m.address.toLowerCase()] = { raw: bal, decimals: m.decimals, symbol: m.symbol || "" };
    } catch {
      out[m.address.toLowerCase()] = { raw: 0n, decimals: m.decimals, symbol: m.symbol || "" };
    }
  }));
  return out;
}

export async function getRedeemRatios(provider){
  const [wone, usdc, infos] = await Promise.all([
    vault.wONE(provider).catch(() => null),
    vault.usdc(provider).catch(() => null),
    getSupportedTokenInfos(provider),
  ]);
  const one = toAddr(wone);
  const u = toAddr(usdc);
  let onePrice = 0;
  try {
    const ol = await vault.oracleLatest(provider);
    onePrice = Number(ol?.price ?? 0n) / 10 ** Number(ol?.decimals ?? 8);
  } catch {}
  const ratios = {};
  for (const m of infos){
    let priceTokenUSD = 0;
    try {
      if (one && m.address === one) priceTokenUSD = onePrice;
      else if (u && m.address === u) priceTokenUSD = 1;
      else {
        const fp = await vault.fixedUsdPrice(provider, m.address).catch(() => 0n);
        priceTokenUSD = Number(fp) / 1e18;
      }
    } catch {}
    const toWone = (onePrice > 0) ? (priceTokenUSD / onePrice) : null;
    const toUsdc = (priceTokenUSD > 0) ? (priceTokenUSD / 1) : null;
    ratios[m.address] = { toWone, toUsdc };
  }
  return { wone: one, usdc: u, ratios };
}

export async function computeMaxAmount(provider, user, token){
  const u = toAddr(user);
  const t = toAddr(token);
  if (!u || !t) return { balance: 0n, byLimit: 0n, maxToken: 0n, decimals: 18 };
  const dec = await getTokenDecimals(provider, t);
  const bal = await (async () => {
    try{ const erc = new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)"], provider); return b(await erc.balanceOf(u)); } catch { return 0n; }
  })();
  const { remainingUSD } = await vault.getUserLimit(provider, u).catch(() => ({ remainingUSD: 0n }));
  const [wone, usdc] = await Promise.all([ vault.wONE(provider).catch(() => null), vault.usdc(provider).catch(() => null) ]);
  let byLimit = 0n;
  if (toAddr(wone) === t){
    const ol = await vault.oracleLatest(provider).catch(() => ({ price: 0n, decimals: 8 }));
    if (ol.price > 0n){
      byLimit = (b(remainingUSD) * (10n ** BigInt(dec)) * (10n ** BigInt(ol.decimals))) / b(ol.price);
    }
  } else if (toAddr(usdc) === t){
    byLimit = b(remainingUSD) * (10n ** BigInt(dec));
  } else {
    const fp = await vault.fixedUsdPrice(provider, t).catch(() => 0n);
    if (fp > 0n){
      byLimit = (b(remainingUSD) * (10n ** BigInt(dec)) * (10n ** 18n)) / fp;
    }
  }
  const maxToken = (byLimit === 0n) ? 0n : (bal < byLimit ? bal : byLimit);
  return { balance: bal, byLimit, maxToken, decimals: dec };
}

export async function prepareRedeem(provider, { user, tokenIn, amountHuman, redeemIn, proof = [] }){
  if (!provider) throw new Error("Provider not ready");
  const userAddr   = toAddr(user);
  const tokenAddr  = toAddr(tokenIn);
  const redeemAddr = toAddr(redeemIn);
  if (!userAddr) throw new Error("User address invalid");
  if (!tokenAddr) throw new Error("tokenIn address invalid");
  if (!redeemAddr) throw new Error("redeemIn address invalid");
  const [info, locked, woneAddr, usdcAddr] = await Promise.all([
    vault.getRoundInfo(provider),
    vault.isLocked(provider).catch(() => false),
    vault.wONE(provider).catch(() => null),
    vault.usdc(provider).catch(() => null),
  ]);
  const paused = Boolean(info?.paused);
  const start  = n(info?.startTime || 0);
  const now    = Math.floor(Date.now()/1000);
  const isW = woneAddr && toAddr(woneAddr) === redeemAddr;
  const isU = usdcAddr && toAddr(usdcAddr) === redeemAddr;
  if (!isW && !isU) throw new Error("redeemIn must be wONE or USDC");
  const supported = await vault.isTokenSupported(provider, tokenAddr);
  if (!supported){
    return {
      ok: false, reasons: ["Token not supported"], warnings: [], steps: [], amounts: {},
      display: { statusLabel: paused ? "Paused" : (locked ? "Locked" : "Inactive"), statusCode: paused ? "paused" : (locked ? "locked" : "inactive") },
      meta: { info }
    };
  }
  const tokenDecimals = await getTokenDecimals(provider, tokenAddr);
  const amountIn = parseAmount(amountHuman, tokenDecimals);
  if (amountIn <= 0n) {
    return { ok: false, reasons: ["Invalid amount"], warnings: [], steps: [], amounts: {}, display: null, meta: { info } };
  }
  const { woneBalance = 0n, usdcBalance = 0n } = await vault.getVaultBalances(provider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n }));
  const hasFunds = (woneBalance > 0n) || (usdcBalance > 0n);
  const status = (() => {
    if (paused) return { code:"paused", label:"Paused" };
    if (locked) return { code:"locked", label:"Locked" };
    if (start && now < start) return { code:"hold", label:"On Hold" };
    if (hasFunds) return { code:"active", label:"Active" };
    return { code:"inactive", label:"Inactive" };
  })();
  const cleanProof = sanitizeProof(proof);
  const v = await vault.getReadContract(provider);
  const vaultAddr = (typeof v.getAddress === "function" ? await v.getAddress() : (v.target || v.address));
  let q = null;
  try {
    const decoded = await safeQuoteRedeem(provider, vaultAddr, { user: userAddr, tokenIn: tokenAddr, amountIn, redeemIn: redeemAddr, proof: cleanProof });
    const r = Array.isArray(decoded) ? decoded : [];
    q = {
      whitelisted: Boolean(r[0]),
      roundIsActive: Boolean(r[1]),
      feeAmount: b(r[2] || 0n),
      refundAmount: b(r[3] || 0n),
      userLimitUsdBefore: b(r[4] || 0n),
      userLimitUsdAfter:  b(r[5] || 0n),
      usdValue: b(r[6] || 0n),
      tokenInDecimals: n(r[7] ?? tokenDecimals),
      redeemInDecimals: n(r[8] ?? 18),
      oraclePrice: b(r[9] || 0n),
      oracleDecimals: n(r[10] ?? 18),
      amountOut: b(r[11] || 0n),
      source: "onchain"
    };
  } catch {
    const { usd, kind, price, decimals: odec } = await getUsdValue(provider, tokenAddr, amountIn);
    const { thresholds, bps: bpsList } = await getFeeSchedule(provider);
    const bps = pickBps(usd, thresholds, bpsList);
    const fee = (amountIn * BigInt(bps)) / 10000n;
    const refund = amountIn - fee;
    const ul = await vault.getUserLimit(provider, userAddr).catch(() => ({ remainingUSD: 0n }));
    const before = b(ul?.remainingUSD ?? 0n);
    const after  = before - b(usd);
    q = {
      whitelisted: cleanProof.length > 0,
      roundIsActive: (!paused && !locked && (!start || now >= start) && hasFunds),
      feeAmount: fee,
      refundAmount: refund,
      userLimitUsdBefore: before,
      userLimitUsdAfter: after,
      usdValue: b(usd),
      tokenInDecimals: tokenDecimals,
      redeemInDecimals: isW ? 18 : await getTokenDecimals(provider, redeemAddr),
      oraclePrice: b(kind === "wone/oracle" ? (price ?? 0n) : 0n),
      oracleDecimals: n(kind === "wone/oracle" ? (odec ?? 18) : 18),
      amountOut: 0n,
      source: "local"
    };
  }
  const reasons = [];
  if (!q.whitelisted) reasons.push("User is not whitelisted");
  if (!q.roundIsActive) {
    if (paused) reasons.push("Paused");
    if (locked) reasons.push("Locked");
    if (start && now < start) reasons.push("On Hold (ROUND_DELAY)");
    if (!hasFunds) reasons.push("No funds available");
  }
  if (q.userLimitUsdAfter < 0n) reasons.push("Daily limit exceeded");
  const spender = vault.getVaultAddress();
  let needApproval = false;
  try {
    const cur = await allowanceOf(provider, tokenAddr, userAddr, spender);
    needApproval = (cur < amountIn);
  } catch {}
  const steps = [];
  if (needApproval) steps.push({ kind: "approve", token: tokenAddr, amount: amountIn });
  steps.push({ kind: "redeem", args: { tokenIn: tokenAddr, amountIn, redeemIn: redeemAddr, proof: cleanProof } });
  const ok = reasons.length === 0;
  const display = {
    statusLabel: status.label,
    statusCode: status.code,
    feeText:   String(q.feeAmount),
    receiveText: String(q.amountOut || q.refundAmount),
    limitBeforeText: String(q.userLimitUsdBefore),
    limitAfterText:  String(q.userLimitUsdAfter),
    source: q.source
  };
  return {
    ok, reasons, warnings: [],
    steps,
    amounts: {
      amountIn,
      fee: q.feeAmount,
      refund: q.refundAmount,
      usdValue: q.usdValue,
      tokenInDecimals: q.tokenInDecimals,
      redeemInDecimals: q.redeemInDecimals,
      oraclePrice: q.oraclePrice,
      oracleDecimals: q.oracleDecimals,
      amountOut: q.amountOut
    },
    display,
    meta: { info, status }
  };
}

export async function executeRedeem(signer, plan, opts = {}){
  if (!signer) throw new Error("Signer is required");
  if (!plan) throw new Error("Plan is required");
  if (!plan.ok) throw new Error("Plan is blocked");
  const emit = (s) => { try { opts.onProgress?.(s); } catch {} };
  const results = { approvals: [], redeem: null, receipts: { approvals: [], redeem: null }, events: {} };
  const provider = signer.provider;
  const net = await provider.getNetwork();
  const expected = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
  if (Number(net.chainId) !== expected) throw new Error(`Wrong network. Please switch to chainId ${expected}.`);
  for (const step of plan.steps || []){
    if (step.kind === "approve"){
      emit("approving");
      const token = step.token;
      const erc = new ethers.Contract(token, ["function approve(address,uint256) returns (bool)","function estimateGas.approve(address,uint256) view returns (uint256)"], signer);
      const spender = vault.getVaultAddress();
      const fee = await buildGasFees(provider);
      const overrides = ensureLegacyOverrides({ ...fee, gasLimit: GAS_LIMIT_FALLBACK });
      const tx = await erc.approve(spender, step.amount, overrides);
      
      const rc = await tx.wait();
      results.approvals.push(tx);
      results.receipts.approvals.push(rc);
    }
  }
  const redeemStep = (plan.steps || []).find(s => s.kind === "redeem");
  if (!redeemStep) throw new Error("Missing redeem step");
  emit("redeeming");
  const { tokenIn, amountIn, redeemIn, proof } = redeemStep.args;
  const vRead = await vault.getReadContract(provider);
  const vaultAddr = (typeof vRead.getAddress === "function" ? await vRead.getAddress() : (vRead.target || vRead.address));
  const vWrite = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
  const fee = await buildGasFees(provider);
  const overrides = ensureLegacyOverrides({ ...fee, gasLimit: GAS_LIMIT_FALLBACK });
  try {
    await vWrite.redeem.staticCall(tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : [], overrides);
  } catch (e) {
    throw new Error(e?.reason || e?.shortMessage || e?.message || "Redeem will revert");
  }
  const tx = await vWrite.redeem(tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : [], overrides);
   
  const rc = await tx.wait();
  results.redeem = tx;
  results.receipts.redeem = rc;
  try{
    const topics = vault.getEventTopics?.();
    const topic = topics?.RedeemProcessed;
    if (topic && rc?.logs?.length){
      const hit = rc.logs.find((l) => (l?.topics?.[0] || "").toLowerCase() === String(topic).toLowerCase());
      if (hit) results.events.RedeemProcessed = hit;
    }
  } catch {}
  emit("done");
  return results;
}

export async function getUsdPerToken(provider, token){
  const dec = await getTokenDecimals(provider, token);
  const oneToken = 10n ** BigInt(dec);
  const { usd } = await getUsdValue(provider, token, oneToken);
  return usd;
}

export function statusBadgeColor(code){
  switch(code){
    case "active": return "green";
    case "hold": return "yellow";
    case "paused":
    case "locked": return "red";
    default: return "gray";
  }
}
