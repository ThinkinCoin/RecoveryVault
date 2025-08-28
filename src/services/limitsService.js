// src/services/limitsService.js
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";

/**
 * Converte o restante do limite para USD em 1e18.
 * Aceita tanto o retorno { remainingUSD18 } quanto { remainingUSD } do vaultService.
 */
export async function fetchRemainingUsd18(provider, address) {
  if (!provider || !address) return 0n;
  const r = await vaultService.getUserLimit(provider, address).catch(() => null);
  if (!r) return 0n;

  if (r.remainingUSD18 != null) {
    return BigInt(r.remainingUSD18);
  }
  if (r.remainingUSD != null) {
    return BigInt(r.remainingUSD) * (10n ** 18n);
  }
  // fallback compatível com retornos BigInt diretamente
  if (typeof r === "bigint") return r * (10n ** 18n);
  return 0n;
}

/**
 * Cota um valor em USD (18 decimais) para uma quantidade humana de um token.
 * amountHuman: string/number (ex.: "123.45")
 * tokenDecimals: decimais do token (ex.: 18)
 */
export async function quoteAmountUsd18(provider, tokenAddress, amountHuman, tokenDecimals = 18) {
  if (!provider || !tokenAddress) return 0n;

  const price18 = await vaultService.fixedUsdPrice(provider, tokenAddress).catch(() => 0n);
  if (!price18 || price18 === 0n) return 0n;

  const dec = Number.isFinite(tokenDecimals) ? Number(tokenDecimals) : 18;
  const amtRaw = ethers.parseUnits(String(amountHuman ?? "0"), dec);
  // USD 18dps = amountRaw * price18 / 10^tokenDecimals
  const usd18 = (BigInt(amtRaw) * BigInt(price18)) / (10n ** BigInt(dec));
  return usd18;
}

/**
 * Pré-checagem: compara a cotação do pedido (USD 18dps) com o limite restante (USD 18dps).
 */
export async function preflightAmountAgainstLimit(provider, address, tokenAddress, amountHuman, tokenDecimals = 18) {
  try {
    if (!provider) return { ok: false, reason: "Provider not ready" };
    if (!address) return { ok: false, reason: "No wallet connected" };
    if (!tokenAddress) return { ok: false, reason: "Select a token" };

    const [amountUSD18, remainingUSD18] = await Promise.all([
      quoteAmountUsd18(provider, tokenAddress, amountHuman, tokenDecimals),
      fetchRemainingUsd18(provider, address),
    ]);

    const ok = amountUSD18 <= remainingUSD18;
    return { ok, amountUSD18, remainingUSD18 };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}
