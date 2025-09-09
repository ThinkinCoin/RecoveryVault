// src/hooks/useOnePrice.js
// Fonte única: usa o oracle do Vault via core.oracleLatest(provider)
// (core.oracleLatest já tenta Band Adapter: latestPrice(), Chainlink, Band getReferenceData, etc.)
// Retorna preço de ONE em USD como número (float), sem depender de ABI externo no hook.

import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "ethers";
import { useContractContext } from "@/contexts/ContractContext";
import * as core from "@/services/vaultCore";

/**
 * useOnePrice
 * Lê preço ONE/USD a partir do oracle configurado no contrato (via core.oracleLatest).
 * Retorno: { price: number|null, loading: boolean, error: Error|null, lastUpdated: null, reload: () => Promise<number|null> }
 */
export function useOnePrice() {
  const { provider: walletProvider } = useContractContext() ?? {};
  const readProvider = core.getDefaultProvider?.() || walletProvider;

  const [price, setPrice] = useState(/** @type {number|null} */(null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {Error|null} */(null));
  // Mantemos a chave para compat (não temos timestamp confiável para todos os oracles)
  const lastUpdated = null;

  const load = useCallback(async () => {
    if (!readProvider) return null;

    // Sempre consulta a mesma fonte do app:
    // core.oracleLatest(provider) -> { price: bigint, decimals: number }
    const { price: pRaw, decimals } = await core.oracleLatest(readProvider);
    if (!pRaw || pRaw <= 0n) throw new Error("Oracle returned zero");

    const dec = typeof decimals === "number" ? decimals : 18;
    const num = Number(formatUnits(pRaw, dec));

    // Atualiza estado
    setPrice(Number.isFinite(num) ? num : null);
    return Number.isFinite(num) ? num : null;
  }, [readProvider]);

  useEffect(() => {
    if (!readProvider) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await load();
        if (!cancelled && res == null) {
          setPrice(null);
          setError(new Error("No oracle available or all calls failed."));
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[useOnePrice] load error:", e);
          setError(e instanceof Error ? e : new Error(String(e)));
          setPrice(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [load, readProvider]);

  return { price, loading, error, lastUpdated, reload: load };
}

export default useOnePrice;
