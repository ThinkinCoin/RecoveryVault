// src/services/limitsService.js
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";

/** pow10 BigInt seguro */
function p10(n) {
  return 10n ** BigInt(n);
}

/** Normaliza endereço p/ comparação */
function sameAddr(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

/**
 * Lê o restante do limite como USD *1e18 (compat com UI antiga).
 * Usa getUserLimit (que retorna USD inteiro) e converte.
 */
export async function fetchRemainingUsd18(provider, address) {
  if (!provider || !address) return 0n;
  const r = await vaultService.getUserLimit(provider, address).catch(() => null);
  if (!r) return 0n;

  // compat: se algum caller antigo devolver already-in-18
  if (r.remainingUSD18 != null) return BigInt(r.remainingUSD18);
  if (r.remainingUSD != null) return BigInt(r.remainingUSD) * p10(18);

  if (typeof r === "bigint") return r * p10(18);
  return 0n;
}

/** Novo: restante do limite em USD inteiro (exatamente como o contrato usa) */
export async function fetchRemainingUsdInt(provider, address) {
  if (!provider || !address) return 0n;
  const r = await vaultService.getUserLimit(provider, address).catch(() => null);
  if (!r) return 0n;
  if (r.remainingUSD != null) return BigInt(r.remainingUSD);
  // compat caso algum wrapper devolva bigint direto
  if (typeof r === "bigint") return r;
  return 0n;
}

/**
 * Cota USD tanto em *1e18* (UI) quanto *inteiro* (contrato),
 * seguindo a mesma regra do contrato:
 * - wONE: oracle.latestPrice() (USD por ONE, com oracleDecimals)
 * - USDC: amountRaw / 10**usdcDecimals
 * - fixedUsdPrice[token] > 0: (amountRaw * price18) / 10**tokenDecimals
 *
 * @returns { usd18: bigint, usdInt: bigint }
 */
export async function quoteAmountUsd(provider, tokenAddress, amountHuman, tokenDecimals = 18) {
  try {
    if (!provider || !tokenAddress) return { usd18: 0n, usdInt: 0n };
    const dec = Number.isFinite(tokenDecimals) ? Number(tokenDecimals) : 18;
    const amtRaw = ethers.parseUnits(String(amountHuman ?? "0"), dec);
    if (amtRaw <= 0n) return { usd18: 0n, usdInt: 0n };

    // Descobrir endereços de wONE e USDC para a comparação
    const [woneAddr, usdcAddr] = await Promise.all([
      vaultService.wONE(provider).catch(() => null),
      vaultService.usdc(provider).catch(() => null),
    ]);

    // Caso 1: USDC -> USD inteiro é amountRaw / 10**dec; USD18 = usdInt * 1e18
    if (usdcAddr && sameAddr(tokenAddress, usdcAddr)) {
      const usdInt = amtRaw / p10(dec);
      const usd18 = usdInt * p10(18);
      return { usd18, usdInt };
    }

    // Caso 2: wONE -> usar oracle (USD/ONE com oracleDecimals)
    if (woneAddr && sameAddr(tokenAddress, woneAddr)) {
      const { price, decimals: oracleDec } = await vaultService.oracleLatest(provider);
      // one18 = amountRaw normalizado para 1e18 de ONE
      const one18 = (BigInt(amtRaw) * p10(18)) / p10(dec);
      // USD18 = one18 * price / 10**oracleDec
      const usd18 = (one18 * BigInt(price)) / p10(oracleDec);
      const usdInt = usd18 / p10(18);
      return { usd18, usdInt };
    }

    // Caso 3: fixedUsdPrice[token] > 0 -> price em 1e18 USD por 1 token
    const price18 = await vaultService.fixedUsdPrice(provider, tokenAddress).catch(() => 0n);
    if (price18 && price18 > 0n) {
      // USD18 = amtRaw * price18 / 10**tokenDecimals
      const usd18 = (BigInt(amtRaw) * BigInt(price18)) / p10(dec);
      const usdInt = usd18 / p10(18);
      return { usd18, usdInt };
    }

    // Sem forma de avaliar
    return { usd18: 0n, usdInt: 0n };
  } catch {
    return { usd18: 0n, usdInt: 0n };
  }
}

/**
 * Mantém compat: retorna apenas USD 18dps (usado pela UI atual).
 * Internamente usa quoteAmountUsd para alinhar com o contrato.
 */
export async function quoteAmountUsd18(provider, tokenAddress, amountHuman, tokenDecimals = 18) {
  const { usd18 } = await quoteAmountUsd(provider, tokenAddress, amountHuman, tokenDecimals);
  return usd18;
}

/**
 * Pré-checagem contra o limite diário:
 * - Compara usdInt do pedido com remainingUSD (inteiro) do contrato
 * - Retorna também os valores em 18dps para UI
 */
export async function preflightAmountAgainstLimit(
  provider,
  address,
  tokenAddress,
  amountHuman,
  tokenDecimals = 18
) {
  try {
    if (!provider) return { ok: false, reason: "Provider not ready" };
    if (!address) return { ok: false, reason: "No wallet connected" };
    if (!tokenAddress) return { ok: false, reason: "Select a token" };

    const [{ usd18: amountUSD18, usdInt: amountUSDInt }, remainingUSDInt] = await Promise.all([
      quoteAmountUsd(provider, tokenAddress, amountHuman, tokenDecimals),
      fetchRemainingUsdInt(provider, address),
    ]);

    const remainingUSD18 = remainingUSDInt * p10(18);
    const ok = amountUSDInt <= remainingUSDInt;

    return {
      ok,
      // para UI
      amountUSD18,
      remainingUSD18,
      // para comparações exatas com o contrato
      amountUSDInt,
      remainingUSDInt,
      reason: ok ? undefined : "Insufficient remaining daily limit",
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}
