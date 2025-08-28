// src/services/redeemService.js
import { Contract, ethers } from "ethers";
import * as vaultService from "@/services/vaultService";

const ERC20_MINI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];

function asAddr(x){ try { return ethers.getAddress(x); } catch { return null; } }

// --- Metadados dos tokens suportados (para o TokenSelect) ---
export async function getSupportedTokenInfos(provider) {
  const vTokens = await vaultService.getSupportedTokens(provider);
  const infos = [];
  for (const t of vTokens || []) {
    try {
      const erc = new Contract(t, ERC20_MINI, provider);
      const [dec, sym] = await Promise.all([erc.decimals(), erc.symbol()]);
      infos.push({ address: asAddr(t), decimals: Number(dec), symbol: String(sym || "") });
    } catch { /* ignora token problemático */ }
  }
  return infos;
}

// --- Tiers de fee direto do contrato (já existem no vaultService; mantemos aqui p/ compat) ---
export async function getFeeTiers(provider) {
  return await vaultService.getFeeTiers(provider);
}

/**
 * USD inteiro do *input* conforme o contrato:
 * - wONE: oracle.latestPrice()
 * - USDC: divide por 10**usdcDecimals
 * - fixedUsdPrice[token] (escala 1e18)
 */
export async function getUsdValue(provider, tokenIn, amountIn) {
  if (!provider || !tokenIn || !amountIn) return 0n;

  const [wone, usdc] = await Promise.all([
    vaultService.wONE(provider).catch(() => null),
    vaultService.usdc(provider).catch(() => null),
  ]);

  // wONE via oracle
  if (wone && tokenIn.toLowerCase() === String(wone).toLowerCase()) {
    try {
      const erc = new Contract(tokenIn, ERC20_MINI, provider);
      const dec = BigInt(await erc.decimals());
      const { price, decimals } = await vaultService.oracleLatest(provider);
      if (!price || price <= 0n) return 0n;
      const one18 = (BigInt(amountIn) * 10n**18n) / (10n**dec);
      // usdInt = (one18 * price) / 10**oracleDec / 1e18
      const usd = (one18 * BigInt(price)) / (10n ** BigInt(decimals)) / 10n**18n;
      return usd;
    } catch { return 0n; }
  }

  // USDC por decimais
  if (usdc && tokenIn.toLowerCase() === String(usdc).toLowerCase()) {
    try {
      const erc = new Contract(usdc, ERC20_MINI, provider);
      const usdcDec = BigInt(await erc.decimals());
      return BigInt(amountIn) / (10n ** usdcDec);
    } catch { return 0n; }
  }

  // fixedUsdPrice (1e18) para demais tokens
  try {
    const price18 = await vaultService.fixedUsdPrice(provider, tokenIn);
    if (!price18 || price18 === 0n) return 0n;
    const erc = new Contract(tokenIn, ERC20_MINI, provider);
    const dec = BigInt(await erc.decimals());
    // usdInt = amount * price18 / 10**dec / 1e18
    const usd = (BigInt(amountIn) * BigInt(price18)) / (10n ** dec) / 10n**18n;
    return usd;
  } catch {
    return 0n;
  }
}

/**
 * Aplica a fee por tiers (mesma regra do contrato: _calculateFee)
 * amountIn: em unidades do tokenIn (raw)
 * usdInt: USD inteiro do input (pré-fee)
 * tiers: { thresholds: uint256[], bps: uint16[] } com bps.length = thresholds.length + 1
 */
export function applyFeeForUsd(amountIn, usdInt, tiers) {
  const thresholds = Array.isArray(tiers?.thresholds) ? tiers.thresholds.map(BigInt) : [];
  const bpsArr = Array.isArray(tiers?.bps) ? tiers.bps.map((x) => Number(x)) : [];
  if (bpsArr.length !== thresholds.length + 1) {
    return { feeAmount: 0n, refundAmount: BigInt(amountIn ?? 0n), bps: 0 };
  }

  let chosenBps = bpsArr[bpsArr.length - 1] || 0; // fallback
  for (let i = 0; i < thresholds.length; i++) {
    if (BigInt(usdInt) <= BigInt(thresholds[i])) {
      chosenBps = bpsArr[i] || 0;
      break;
    }
  }

  const fee = (BigInt(amountIn) * BigInt(chosenBps)) / 10000n;
  const refund = BigInt(amountIn) - fee;
  return { feeAmount: fee, refundAmount: refund, bps: chosenBps };
}

/**
 * Saldos do usuário para os tokens suportados.
 * Retorna [{ address, raw, decimals, symbol }]
 */
export async function getUserBalances(provider, user) {
  if (!provider || !user) return [];
  const infos = await getSupportedTokenInfos(provider);
  const out = [];
  await Promise.all(infos.map(async (info) => {
    try {
      const erc = new Contract(info.address, ERC20_MINI, provider);
      const bal = await erc.balanceOf(user);
      out.push({
        address: info.address,
        raw: BigInt(bal),
        decimals: info.decimals,
        symbol: info.symbol,
      });
    } catch { /* ignora token com erro */ }
  }));
  return out;
}
