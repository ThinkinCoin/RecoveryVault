import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";
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
  const USD_DECIMALS = Number(import.meta.env.VITE_USD_DECIMALS ?? 0);

  const provider = useMemo(() => {
    try {
      return vaultService.getDefaultProvider?.() || (RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null);
    } catch (err) {
      console.error("[LimitChecker] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  // No local iface: we call vaultService.getDailyLimit to stay ABI-agnostic.

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
    const prov = provider || vaultService.getDefaultProvider?.();
    if (!prov) throw new Error("Provider not ready");
    if (!user) throw new Error("No wallet connected");

    const { limit, used } = await vaultService.getDailyLimit(prov, user);
    // Raw BigInt values (expected USD integers if contract is correct)
    let rawLimit = limit ?? 0n;
    let rawUsed  = used  ?? 0n;

    // Heuristic: if decimals=0 (USD integer) but value looks mis-scaled (>1e12), assume it was stored * 1e18 and normalize for display only
    if (USD_DECIMALS === 0 && rawLimit > 1_000_000_000_000n) {
      console.warn("[LimitChecker] Large dailyLimitUsd detected; displaying normalized value (÷1e18). Fix on-chain via setDailyLimit(100).");
      rawLimit = rawLimit / 1_000_000_000_000_000_000n; // ÷ 1e18
      rawUsed  = rawUsed  / 1_000_000_000_000_000_000n;
    }

    const rawRemaining = rawLimit > rawUsed ? (rawLimit - rawUsed) : 0n;

    const limitNum     = Number(ethers.formatUnits(rawLimit,     USD_DECIMALS));
    const usedNum      = Number(ethers.formatUnits(rawUsed,      USD_DECIMALS));
    const remainingNum = Number(ethers.formatUnits(rawRemaining, USD_DECIMALS));

    return { used: usedNum, limit: limitNum, remaining: remainingNum };
  }, [USD_DECIMALS, provider]);

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
    <div className={`${s.walletLimit} ${s.badgeWalletLimit}`}>


      {error ? (
        <div className={s.contractFundsErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={s.contractFundsRow}>
            <span className={s.contractFundsLabel}>Daily Limit</span>
            <span className={s.contractFundsValue} data-testid="daily-limit">{formatUSD(limitUsd)}</span>
          </div>

          <div className={s.contractFundsRow}>
            <span className={s.contractFundsSubLabel}>Remaining</span>
            <span className={s.contractFundsSubValue} data-testid="remaining-limit">{formatUSD(remainingUsd)}</span>
          </div>
        </>
      )}
    </div>
  );
}
