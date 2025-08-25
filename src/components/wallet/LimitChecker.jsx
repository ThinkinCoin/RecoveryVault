import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";
import s from "@/styles/Global.module.css";

/**
 * LimitChecker.jsx (RecoveryVault-specific)
 * -------------------------------------------------------------
 * Lê diretamente do contrato (view):
 * - function dailyLimitUsd() view returns (uint256)
 * - function getUserLimit(address wallet) view returns (uint256 remainingUSD)
 * - function WALLET_RESET_INTERVAL() view returns (uint256)
 * - function getLastRedeemTimestamp(address user) view returns (uint256)
 *
 * Exibe: "LimitUsed / dailyLimitUsd", Remaining e um countdown para o próximo reset.
 *
 * Env (Vite):
 * - VITE_RPC_URL (fallback de leitura quando não há BrowserProvider)
 * - VITE_VAULT_ADDRESS (obrigatório)
 *
 * Notas:
 * - Ethers v6
 */
export default function LimitChecker({ address }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [account, setAccount] = useState("");
  const [limitUsd, setLimitUsd] = useState(0);
  const [usedUsd, setUsedUsd] = useState(0);
  const [remainingUsd, setRemainingUsd] = useState(0);

  // Countdown state (segundos restantes até o próximo reset)
  const [timeLeftSec, setTimeLeftSec] = useState(null);
  const [nextResetAt, setNextResetAt] = useState(0); // epoch seconds

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;

  const provider = useMemo(() => {
    try {
      // Prefer fallback público (leitura) — componente não realiza writes
      return vaultService.getDefaultProvider?.() || (RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null);
    } catch (err) {
      console.error("[LimitChecker] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  const VAULT_IFACE = useMemo(
    () =>
      new ethers.Interface([
        "function dailyLimitUsd() view returns (uint256)",
        "function getUserLimit(address wallet) view returns (uint256 remainingUSD)",
      ]),
    []
  );

  const formatUSD = useCallback((val) => {
    const n = Number(val ?? 0);
    if (!Number.isFinite(n)) return "$0.00";
    return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, []);

  const formatDuration = useCallback((secs) => {
    if (secs == null) return "—";
    const s = Math.max(0, Math.floor(secs));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }, []);

  const resolveAccount = useCallback(async () => {
    if (address) return address;
    try {
      if (window?.ethereum?.request) {
        const accs = await window.ethereum.request({ method: "eth_accounts" });
        if (accs && accs[0]) return accs[0];
      }
    } catch (err) {
      console.error("[LimitChecker] eth_accounts failed:", err);
    }
    return "";
  }, [address]);

  const fetchLimits = useCallback(
    async (user) => {
      if (!VAULT_ADDRESS) throw new Error("Missing env VITE_VAULT_ADDRESS");
      const prov = provider || vaultService.getDefaultProvider?.();
      if (!prov) throw new Error("Provider not ready");
      if (!user) throw new Error("No wallet connected");

      const contract = new ethers.Contract(VAULT_ADDRESS, VAULT_IFACE, prov);

      // Leitura direta do contrato (USD inteiros)
      const [limitRaw, remainingRaw] = await Promise.all([
        contract.dailyLimitUsd(),
        contract.getUserLimit(user),
      ]);

      // BigInt -> Number (USD inteiros; assumimos faixa segura p/ Number)
      const limit = Number(limitRaw ?? 0n);
      const remaining = Number(remainingRaw ?? 0n);
      const used = Math.max(0, Math.min(limit, limit - remaining));

      return { used, limit, remaining };
    },
    [provider, VAULT_ADDRESS, VAULT_IFACE]
  );

  // Busca metadados do reset: intervalo (seg) e timestamp do último redeem
  const fetchResetMeta = useCallback(
    async (user) => {
      const prov = provider || vaultService.getDefaultProvider?.();
      if (!prov) throw new Error("Provider not ready");
      if (!user) throw new Error("No wallet connected");

      const [intervalRaw, lastRaw] = await Promise.all([
        vaultService.WALLET_RESET_INTERVAL(prov).catch(() => 0n),
        vaultService.getLastRedeemTimestamp(prov, user).catch(() => 0n),
      ]);

      const intervalSec = Number(intervalRaw ?? 0n) || 0;
      const lastSec = Number(lastRaw ?? 0n) || 0;
      const nextAt = lastSec && intervalSec ? lastSec + intervalSec : 0; // 0 → nunca fez redeem
      return { intervalSec, lastSec, nextAt };
    },
    [provider]
  );

  const setupCountdown = useCallback((targetEpochSec) => {
    // Limpa timer antigo
    if (setupCountdown._timer) {
      clearInterval(setupCountdown._timer);
      setupCountdown._timer = null;
    }

    if (!targetEpochSec || targetEpochSec <= 0) {
      setTimeLeftSec(null);
      setNextResetAt(0);
      return;
    }

    setNextResetAt(targetEpochSec);
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const left = Math.max(0, targetEpochSec - now);
      setTimeLeftSec(left);
      if (left <= 0 && setupCountdown._timer) {
        clearInterval(setupCountdown._timer);
        setupCountdown._timer = null;
      }
    };
    // Primeira execução imediata + intervalo de 1s
    tick();
    setupCountdown._timer = setInterval(tick, 1000);
  }, []);

  // compute: carrega limites + (novo) countdown de reset
  const compute = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const acc = await resolveAccount();
      setAccount(acc);
      if (!acc) throw new Error("Connect your wallet to view your daily limit");

      const [{ used, limit, remaining }, { nextAt }] = await Promise.all([
        fetchLimits(acc),
        fetchResetMeta(acc),
      ]);

      setUsedUsd(used);
      setLimitUsd(limit);
      setRemainingUsd(remaining);
      setupCountdown(nextAt);
    } catch (err) {
      console.error("[LimitChecker] compute error:", err);
      setError(err?.message || "Unexpected error while fetching limits");
      setUsedUsd(0);
      setLimitUsd(0);
      setRemainingUsd(0);
      setupCountdown(0);
    } finally {
      setIsLoading(false);
    }
  }, [fetchLimits, fetchResetMeta, resolveAccount, setupCountdown]);

  // Refresh automático (limites) a cada 60s
  const intervalRef = useRef(null);
  useEffect(() => {
    compute();
    intervalRef.current = setInterval(compute, 600_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (setupCountdown._timer) clearInterval(setupCountdown._timer);
    };
  }, [compute, setupCountdown]);

  return (
    <div className={s.contractFundsCardInner}>
      <div className={s.contractFundsHeader}>
        <span className={s.contractFundsTitle}>Daily Limit</span>
        <button type="button" className={s.contractFundsRefreshBtn} onClick={compute} disabled={isLoading}>
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className={s.contractFundsErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={s.contractFundsSep} />

          <div className={s.contractFundsRow}>
            <span className={s.contractFundsLabel}>Limit Used</span>
            <span className={s.contractFundsValue} data-testid="limit-used">{formatUSD(usedUsd)}</span>
          </div>

          <div className={s.contractFundsRow}>
            <span className={s.contractFundsLabel}>Daily Limit</span>
            <span className={s.contractFundsValue} data-testid="daily-limit">{formatUSD(limitUsd)}</span>
          </div>

          <div className={s.contractFundsRow}>
            <span className={s.contractFundsSubLabel}>Remaining</span>
            <span className={s.contractFundsSubValue} data-testid="remaining-limit">{formatUSD(remainingUsd)}</span>
          </div>

          <div className={s.contractFundsFooter}>
            <span className={s.contractFundsTimestamp}>
              {timeLeftSec == null
                ? "Next reset: —"
                : timeLeftSec === 0
                ? "Next reset: available now"
                : `Next reset in: ${formatDuration(timeLeftSec)}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
