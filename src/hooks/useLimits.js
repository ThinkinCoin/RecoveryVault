// src/hooks/useLimits.js
import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import * as core from "@/services/vaultCore";

/**
 * Hook simples para ler limites do usuário (USD inteiros, como no LimitChecker).
 * Retorna: { loading, error, limitUSD, remainingUSD, usedUSD, refresh }
 */
export default function useLimits(address, provider) {
  const [state, setState] = useState({
    loading: true,
    error: "",
    limitUSD: 0,
    remainingUSD: 0,
    usedUSD: 0,
  });

  const refresh = useCallback(async () => {
    try {
      setState((s) => ({ ...s, loading: true, error: "" }));

      if (!provider || !address) {
        setState({ loading: false, error: "", limitUSD: 0, remainingUSD: 0, usedUSD: 0 });
        return;
      }

      // Tenta via core; se não houver, faz leitura direta do contrato.
      let limitRaw = 0n;
      const VAULT_ADDRESS =
        core.getVaultAddress?.() || import.meta.env.VITE_VAULT_ADDRESS || "";

      if (typeof core.dailyLimitUsd === "function") {
        limitRaw = await core.dailyLimitUsd(provider).catch(() => 0n);
      } else if (VAULT_ADDRESS) {
        const iface = new ethers.Interface(["function dailyLimitUsd() view returns (uint256)"]);
        const contract = new ethers.Contract(VAULT_ADDRESS, iface, provider);
        limitRaw = await contract.dailyLimitUsd().catch(() => 0n);
      }

      const r = await core.getUserLimit(provider, address).catch(() => ({ remainingUSD: 0n }));

      const limitUSD = Number(limitRaw / 10n**18n);


      let remainingUSD = 0;
      if (r?.remainingUSD != null) {
        remainingUSD = Number(r.remainingUSD);
      } else if (r?.remainingUSD18 != null) {
        // converte 1e18 -> inteiros truncando (compatível com UI atual)
        remainingUSD = Number(core.toUsd4(r.remainingUSD18) / core.USD_SCALE_BI);
      } else if (typeof r === "bigint") {
        remainingUSD = Number(r);
      }

      const usedUSD = Math.max(0, Math.min(limitUSD, limitUSD - remainingUSD));

      setState({
        loading: false,
        error: "",
        limitUSD,
        remainingUSD,
        usedUSD,
      });
    } catch (e) {
      setState({
        loading: false,
        error: e?.message || String(e),
        limitUSD: 0,
        remainingUSD: 0,
        usedUSD: 0,
      });
    }
  }, [provider, address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
