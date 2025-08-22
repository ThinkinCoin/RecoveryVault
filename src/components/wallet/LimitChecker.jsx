import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import s from "@/styles/Global.module.css";

/**
 * LimitChecker.jsx (RecoveryVault-specific)
 * -------------------------------------------------------------
 * Uses the provided ABI details:
 * - function dailyLimitUsd() view returns (uint256)
 * - function getUserLimit(address wallet) view returns (uint256 remainingUSD)
 *
 * UI shows: "LimitUsed / dailyLimitUsd" and Remaining.
 *
 * Env (Vite):
 * - VITE_RPC_URL
 * - VITE_VAULT_ADDRESS
 * - VITE_USD_DECIMALS (optional, default 6)
 *
 * Notes:
 * - All strings and logs in English
 * - Ethers v6
 */
export default function LimitChecker({ address }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [account, setAccount] = useState("");
  const [limitUsd, setLimitUsd] = useState(0);
  const [usedUsd, setUsedUsd] = useState(0);
  const [remainingUsd, setRemainingUsd] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
  const USD_DECIMALS = Number(import.meta.env.VITE_USD_DECIMALS ?? 6);

  const provider = useMemo(() => {
    try {
      if (!RPC_URL) return null;
      return new ethers.JsonRpcProvider(RPC_URL);
    } catch (err) {
      console.error("[LimitChecker] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  const VAULT_IFACE = useMemo(() => new ethers.Interface([
    "function dailyLimitUsd() view returns (uint256)",
    "function getUserLimit(address wallet) view returns (uint256 remainingUSD)",
  ]), []);

  const formatUSD = useCallback((val) => {
    const n = Number(val ?? 0);
    if (!Number.isFinite(n)) return "$0.00";
    return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  const fetchLimits = useCallback(async (user) => {
    if (!provider) throw new Error("Provider not ready");
    if (!VAULT_ADDRESS) throw new Error("Missing env VITE_VAULT_ADDRESS");
    if (!user) throw new Error("No wallet connected");

    const contract = new ethers.Contract(VAULT_ADDRESS, VAULT_IFACE, provider);

    const [limitRaw, remainingRaw] = await Promise.all([
      contract.dailyLimitUsd(),
      contract.getUserLimit(user)
    ]);

    const limit = Number(ethers.formatUnits(limitRaw ?? 0n, USD_DECIMALS));
    const remaining = Number(ethers.formatUnits(remainingRaw ?? 0n, USD_DECIMALS));

    // Derive used = limit - remaining (clamped to [0, limit])
    const used = Math.max(0, Math.min(limit, limit - remaining));

    return { used, limit, remaining };
  }, [USD_DECIMALS, VAULT_ADDRESS, VAULT_IFACE, provider]);

  const compute = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const acc = await resolveAccount();
      setAccount(acc);
      if (!acc) throw new Error("Connect your wallet to view your daily limit");

      const { used, limit, remaining } = await fetchLimits(acc);
      setUsedUsd(used);
      setLimitUsd(limit);
      setRemainingUsd(remaining);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("[LimitChecker] compute error:", err);
      setError(err?.message || "Unexpected error while fetching limits");
      setUsedUsd(0);
      setLimitUsd(0);
      setRemainingUsd(0);
    } finally {
      setIsLoading(false);
    }
  }, [fetchLimits, resolveAccount]);

  const intervalRef = useRef(null);
  useEffect(() => {
    compute();
    intervalRef.current = setInterval(compute, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [compute]);

  return (
    <div className={s.contractFundsCard}>
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
          <div className={s.contractFundsRow}>
            <span className={s.contractFundsLabel}>Wallet</span>
            <span className={s.contractFundsSubValue}>{account || "—"}</span>
          </div>

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
              {lastUpdated ? `Last updated: ${lastUpdated.toLocaleString()}` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
