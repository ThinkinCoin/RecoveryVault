// @/services/redeemService.jsx
// Orquestra o fluxo de redeem: prepara (validações + quote + approvals) e executa (approve -> redeem)
// Depende APENAS do vaultService e de ethers v6.

import { ethers } from "ethers";
import * as vault from "@/services/vaultService";
import VaultArtifact from "@/ui/abi/RecoveryVaultABI.json";

function req(v, msg) { if (!v) throw new Error(msg); return v; }
const b = (v) => BigInt(v ?? 0);
const n = (v) => Number(v ?? 0);
const toAddr = (a) => { try { return ethers.getAddress(a); } catch { return null; } };

// Interface para chamadas low-level
const VAULT_ABI = (VaultArtifact?.abi ?? VaultArtifact);
const iface = new ethers.Interface(VAULT_ABI);

/** Utils **/
export async function getTokenDecimals(provider, token){
  try{
    const erc = new ethers.Contract(token, ["function decimals() view returns (uint8)"], provider);
    return Number(await erc.decimals());
  } catch { return 18; }
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
    const cur = await erc.allowance(owner, spender);
    return b(cur);
  } catch { return 0n; }
}

export async function needsApproval(provider, token, owner, spender, required){
  try{
    const cur = await allowanceOf(provider, token, owner, spender);
    return cur < b(required ?? 0n);
  } catch { return false; }
}

function sanitizeProof(proof){
  if (!Array.isArray(proof)) return [];
  const out = [];
  for (const p of proof){
    try{
      const hx = ethers.hexlify(p);
      out.push(ethers.zeroPadValue(hx, 32));
    } catch {
      console.debug("[redeemService] sanitizeProof: drop invalid element", p);
    }
  }
  return out;
}

async function lowLevelQuote(readProvider, vaultAddr, args){
  const data = iface.encodeFunctionData("quoteRedeem", args);
  console.debug("[redeemService] lowLevelQuote call ->", { to: vaultAddr, dataLen: data.length });
  const raw = await readProvider.call({ to: vaultAddr, data });
  console.debug("[redeemService] lowLevelQuote raw <-", raw?.length || 0);
  if (!raw || raw === "0x"){
    throw new Error("[redeemService] quoteRedeem() returned empty data. Check VITE_VAULT_ADDRESS, chainId, and ABI alignment.");
  }
  const decoded = iface.decodeFunctionResult("quoteRedeem", raw);
  console.debug("[redeemService] lowLevelQuote decoded");
  return decoded;
}

/** Status helpers alinhados ao contrato
 * Paused -> info.paused
 * Locked -> isLocked()
 * On Hold -> now < startTime
 * Active -> now >= startTime && !paused && !locked && hasFunds
 * Inactive -> sem fundos (após startTime)  
 */
function deriveStatus({ paused, locked, startTime, hasFunds }){
  const now = Math.floor(Date.now()/1000);
  if (paused) return { code: "paused", label: "Paused" };
  if (locked) return { code: "locked", label: "Locked" };
  if (startTime && now < startTime) return { code: "hold", label: "On Hold" };
  if (hasFunds) return { code: "active", label: "Active" };
  return { code: "inactive", label: "Inactive" };
}

/**
 * PREPARE: agrega validações + quote + plano de execução
 * @param {ethers.Provider} readProvider
 * @param {{user:string, tokenIn:string, amountHuman:string|number, redeemIn:string, proof?:string[]}} args
 * @returns {Promise<{ ok:boolean, reasons:string[], warnings:string[], steps:any[], amounts:any, display:any, meta:any }>}
 */
export async function prepareRedeem(readProvider, { user, tokenIn, amountHuman, redeemIn, proof = [] }){
  console.debug("[redeemService] prepareRedeem in", { user, tokenIn, redeemIn, amountHuman, proofLen: Array.isArray(proof) ? proof.length : 0 });
  req(readProvider, "[redeemService] provider is required");
  const userAddr = req(toAddr(user), "[redeemService] user address is invalid");
  const tokenAddr = req(toAddr(tokenIn), "[redeemService] tokenIn address is invalid");
  const redeemAddr = req(toAddr(redeemIn), "[redeemService] redeemIn address is invalid");

  // Contexto do cofre e round
  const [info, locked, woneAddr, usdcAddr] = await Promise.all([
    vault.getRoundInfo(readProvider),
    vault.isLocked(readProvider).catch(() => false),
    vault.wONE(readProvider).catch(() => null),
    vault.usdc(readProvider).catch(() => null),
  ]);

  console.debug("[redeemService] roundInfo", info);

  const paused = Boolean(info?.paused);
  const start = n(info?.startTime);

  // hasFunds via getVaultBalances (não exibimos valores aqui)
  const { woneBalance = 0n, usdcBalance = 0n } = await vault.getVaultBalances(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n }));
  const hasFunds = (woneBalance > 0n) || (usdcBalance > 0n);
  console.debug("[redeemService] balances present?", { w: woneBalance > 0n, u: usdcBalance > 0n });

  // Status derivado para UX
  const status = deriveStatus({ paused, locked, startTime: start, hasFunds });
  console.debug("[redeemService] derived status", status);

  // Valida redeemIn permitido (wONE ou USDC)
  if (redeemAddr !== toAddr(woneAddr) && redeemAddr !== toAddr(usdcAddr)){
    console.debug("[redeemService] invalid redeemIn", { redeemAddr, woneAddr, usdcAddr });
    throw new Error("redeemIn must be wONE or USDC");
  }

  // Token suportado? (tokenIn)
  const supported = await vault.isTokenSupported(readProvider, tokenAddr);
  console.debug("[redeemService] isTokenSupported", supported);
  if (!supported) {
    return {
      ok: false,
      reasons: ["Token not supported"],
      warnings: [],
      steps: [],
      amounts: {},
      display: { statusLabel: status.label, statusCode: status.code },
      meta: { info }
    };
  }

  // Decimals & parse
  const tokenDecimals = await getTokenDecimals(readProvider, tokenAddr);
  const amountIn = parseAmount(amountHuman, tokenDecimals);
  console.debug("[redeemService] decimals & amount", { tokenDecimals, amountIn: amountIn.toString() });
  if (amountIn <= 0n) {
    return { ok: false, reasons: ["Invalid amount"], warnings: [], steps: [], amounts: {}, display: { statusLabel: status.label, statusCode: status.code }, meta: { info } };
  }

  // Checagem rápida de estado do round
  const reasons = [];
  if (paused) reasons.push("Paused");
  if (locked) reasons.push("Locked");
  const now = Math.floor(Date.now()/1000);
  if (start && now < start) reasons.push("On Hold (ROUND_DELAY)");
  if (!hasFunds) reasons.push("No funds available");

  // Quote on-chain (verdade única) com diagnóstico melhorado
  const cleanProof = sanitizeProof(proof);
  console.debug("[redeemService] proof sanitized len", cleanProof.length);

  // contrato do vault + rede
  const v = await vault.getReadContract(readProvider);
  const vaultAddr = v.getAddress ? await v.getAddress() : v.address;
  const net = await readProvider.getNetwork();
  console.debug("[redeemService] network/vault", { chainId: Number(net.chainId), vaultAddr });

  let decoded;
  try{
    decoded = await lowLevelQuote(readProvider, vaultAddr, [userAddr, tokenAddr, amountIn, redeemAddr, cleanProof]);
  } catch (e) {
    console.error("[redeemService] lowLevelQuote error", e);
    try {
      decoded = await v.quoteRedeem(userAddr, tokenAddr, amountIn, redeemAddr, cleanProof);
    } catch (e2) {
      console.error("[redeemService] contract.quoteRedeem error", e2);
      throw e2;
    }
  }

  const r = Array.isArray(decoded) ? decoded : [];
  const q = {
    whitelisted: Boolean(r[0]),
    roundIsActive: Boolean(r[1]),
    feeAmount: b(r[2] || 0n),
    refundAmount: b(r[3] || 0n),
    userLimitUsdBefore: b(r[4] || 0n),
    userLimitUsdAfter: b(r[5] || 0n),
    usdValue: b(r[6] || 0n),
    tokenInDecimals: n(r[7] ?? tokenDecimals),
    redeemInDecimals: n(r[8] ?? 18),
    oraclePrice: b(r[9] || 0n),
    oracleDecimals: n(r[10] ?? 8),
  };
  console.debug("[redeemService] quote decoded", q);

  if (!q.whitelisted) reasons.push("User is not whitelisted");
  if (!q.roundIsActive) reasons.push("Round is not active");
  if (b(q.userLimitUsdAfter) < 0n) reasons.push("Daily limit exceeded");

  const spender = vault.getVaultAddress();
  const needApproval = await needsApproval(readProvider, tokenAddr, userAddr, spender, amountIn);
  console.debug("[redeemService] needsApproval", needApproval);

  const steps = [];
  if (needApproval) steps.push({ kind: "approve", token: tokenAddr, amount: amountIn });
  steps.push({ kind: "redeem", args: { tokenIn: tokenAddr, amountIn, redeemIn: redeemAddr, proof: cleanProof } });

  const ok = reasons.length === 0;
  const display = {
    statusLabel: status.label,
    statusCode: status.code,
    feeText: q?.feeAmount != null ? String(q.feeAmount) : "0",
    refundText: q?.refundAmount != null ? String(q.refundAmount) : "0",
    receiveText: q?.refundAmount != null ? String(q.refundAmount) : "0",
    limitBeforeText: q?.userLimitUsdBefore != null ? String(q.userLimitUsdBefore) : "0",
    limitAfterText: q?.userLimitUsdAfter != null ? String(q.userLimitUsdAfter) : "0",
  };

  console.debug("[redeemService] plan result", { ok, reasonsCount: reasons.length, steps: steps.length });

  return {
    ok,
    reasons,
    warnings: [],
    steps,
    amounts: {
      amountIn,
      fee: b(q.feeAmount),
      refund: b(q.refundAmount),
      usdValue: b(q.usdValue),
      tokenInDecimals: n(q.tokenInDecimals),
      redeemInDecimals: n(q.redeemInDecimals),
      oraclePrice: b(q.oraclePrice),
      oracleDecimals: n(q.oracleDecimals),
    },
    display,
    meta: { info, status }
  };
}

/**
 * EXECUTE: executa o plano (approve -> redeem)
 * @param {ethers.Signer} signer
 * @param {ReturnType<typeof prepareRedeem>} plan
 * @param {{ onProgress?:(stage:string)=>void }} opts
 */
export async function executeRedeem(signer, plan, opts = {}){
  req(signer, "[redeemService] signer is required");
  req(plan, "[redeemService] plan is required");
  const emit = (s) => { try { opts.onProgress?.(s); } catch {} };

  const results = { approvals: [], redeem: null, receipts: { approvals: [], redeem: null }, events: {} };
  const provider = signer.provider;
  console.debug("[redeemService] executeRedeem start", { steps: plan?.steps?.length || 0 });

  for (const step of plan.steps || []){
    if (step.kind === "approve"){
      emit("approving");
      const token = step.token;
      const erc = new ethers.Contract(token, ["function approve(address,uint256) returns (bool)"], signer);
      const spender = vault.getVaultAddress();
      console.debug("[redeemService] approve", { token, spender, amount: step.amount?.toString?.() });
      const tx = await erc.approve(spender, step.amount);
      console.debug("[redeemService] approve tx", tx?.hash);
      const rc = await tx.wait();
      console.debug("[redeemService] approve rc status", rc?.status);
      results.approvals.push(tx);
      results.receipts.approvals.push(rc);
    }
  }

  const redeemStep = (plan.steps || []).find(s => s.kind === "redeem");
  if (!redeemStep) throw new Error("[redeemService] missing redeem step");

  emit("redeeming");
  const { tokenIn, amountIn, redeemIn, proof } = redeemStep.args;
  console.debug("[redeemService] redeem call", { tokenIn, redeemIn, amount: amountIn?.toString?.(), proofLen: Array.isArray(proof) ? proof.length : 0 });
  const tx = await vault.redeem(signer, tokenIn, amountIn, redeemIn, Array.isArray(proof) ? proof : [], {});
  console.debug("[redeemService] redeem tx", tx?.hash);
  const rc = await tx.wait();
  console.debug("[redeemService] redeem rc status", rc?.status);
  results.redeem = tx;
  results.receipts.redeem = rc;

  // Sinaliza se houve RedeemProcessed pelo tópico (sem decodificar)
  try{
    const topics = vault.getEventTopics?.();
    const topic = topics?.RedeemProcessed;
    if (topic && rc?.logs?.length){
      const hit = rc.logs.find((l) => (l?.topics?.[0] || "").toLowerCase() === String(topic).toLowerCase());
      if (hit) {
        results.events.RedeemProcessed = hit;
        console.debug("[redeemService] RedeemProcessed found");
      }
    }
  } catch (e) { console.debug("[redeemService] event scan error", e); }

  emit("done");
  console.debug("[redeemService] executeRedeem done");
  return results;
}

/** Ajudantes para o formulário **/
export async function dryRun(readProvider, params){
  // Alias de prepareRedeem para semântica no Form
  return prepareRedeem(readProvider, params);
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
