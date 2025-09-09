// src/components/wallet/LimitChecker.jsx
import React, { useEffect, useMemo, useState } from "react";
import s from "@/styles/Global.module.css";
import * as core from "@/services/vaultCore";
import { Contract, ethers } from "ethers";
import VAULT_ABI from "@/ui/abi/RecoveryVaultABI.json";

// Minimal read ABI if JSON ABI is empty or incomplete
const READ_ABI = (Array.isArray(VAULT_ABI) && VAULT_ABI.length ? VAULT_ABI : [
  "function dailyLimitUsd() view returns (uint256)",
  "function getUserLimit(address wallet) view returns (uint256)",
  "function WALLET_RESET_INTERVAL() view returns (uint256)",
  "function limitUnlockAt(address) view returns (uint256)",
  "function periodStart(address) view returns (uint256)"
]);

export default function LimitChecker({ address }) {
  const provider = useMemo(
    () =>
      core.getDefaultProvider?.() ||
      core.getReadProvider?.() ||
      core.provider?.() ||
      (typeof window !== "undefined" && window.ethereum
        ? new ethers.BrowserProvider(window.ethereum)
        : null),
    []
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [limitUSD, setLimitUSD] = useState(0);
  const [usedUSD, setUsedUSD] = useState(0);
  const [remainingUSD, setRemainingUSD] = useState(0);
  const [timeLeftSec, setTimeLeftSec] = useState(null);

  const vaultAddress = useMemo(
    () => core?.VAULT_ADDRESS || import.meta.env.VITE_VAULT_ADDRESS,
    []
  );

  const vault = useMemo(() => {
    try {
      if (!provider || !vaultAddress) return null;
      return new Contract(vaultAddress, READ_ABI, provider);
    } catch (e) {
      console.error("[LimitChecker] failed to init contract", e);
      return null;
    }
  }, [provider, vaultAddress]);

  // Tick local countdown every second
  useEffect(() => {
    const id = setInterval(() => {
      setTimeLeftSec((prev) => (typeof prev === "number" && prev > 0 ? prev - 1 : prev));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vault || !address) return;
      setLoading(true);
      setError("");
      try {
        // 1) Read daily (USD18) and remaining (USD18)
        let daily = 0n;
        try { daily = await vault.dailyLimitUsd(); } catch (e) { console.warn("[LimitChecker] dailyLimitUsd() not found"); }

        let remaining = 0n;
        try { remaining = await vault.getUserLimit(address); } catch (e) { console.warn("[LimitChecker] getUserLimit(address) failed", e); }

        // 2) Derive used (USD18)
        let used = 0n;
        if (daily > 0n && remaining >= 0n) {
          used = daily > remaining ? daily - remaining : 0n;
        }

        // 3) Compute time-left ONLY when wallet is hard-locked at daily limit
        let tleft = null;
        try {
          const unlockAt = await (async () => { try { return await vault.limitUnlockAt(address); } catch { return 0n; } })();
          const block = await provider.getBlock("latest");
          const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
          if (unlockAt !== 0n && now < unlockAt) {
            tleft = unlockAt - now;
          } else {
            tleft = null;
          }
        } catch (err) {
          console.warn("[LimitChecker] time-left calc failed", err);
        }

        if (!cancelled) {
          setLimitUSD(parseFloat(ethers.formatUnits(daily, 18)));
          setRemainingUSD(parseFloat(ethers.formatUnits(remaining, 18)));
          setUsedUSD(parseFloat(ethers.formatUnits(used, 18)));
          setTimeLeftSec(tleft == null ? null : Number(tleft));
        }
      } catch (e) {
        console.error("[LimitChecker] load failed", e);
        if (!cancelled) setError(String(e?.shortMessage || e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vault, address, provider]);

  const formatUSD = (n) =>
    Number(n ?? 0).toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const formatDuration = (secs) => {
    if (secs == null) return "—";
    const s = Math.max(0, Math.floor(secs));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return (d > 0 ? `${d}d ` : "") + `${pad(h)}:${pad(m)}:${pad(sec)}`;
  };

  return (
    <div className={`${s.contractLimitsCardInner} ${s.panel}`}>
      <div className={s.contractLimitsHeader}>
        <span className={s.contractLimitsTitle}>Daily Limit</span>
        <span className={s.contractLimitsSubLabel}>
          {loading ? "Loading…" : ""}
        </span>
      </div>

      {error ? (
        <div className={s.contractLimitsErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={s.contractLimitsSep} />

          <div className={s.contractLimitsRow}>
            <span className={s.contractLimitsLabel}>Limit Used</span>
            <span className={s.contractLimitsValue}>{formatUSD(usedUSD)}</span>
          </div>

          <div className={s.contractLimitsRow}>
            <span className={s.contractLimitsLabel}>Daily Limit</span>
            <span className={s.contractLimitsValue}>{formatUSD(limitUSD)}</span>
          </div>

          <div className={s.contractLimitsRow}>
            <span className={s.contractLimitsSubLabel}>Remaining</span>
            <span className={s.contractLimitsSubValue}>{formatUSD(remainingUSD)}</span>
          </div>

          <div className={s.contractLimitsFooter}>
            <span className={s.contractLimitsTimestamp}>
              {timeLeftSec == null
                ? "Locker Status: Redeem avaialable"
                : timeLeftSec === 0
                ? "Locker Status: available now"
                : `Limit reached: Next reset in: ${formatDuration(timeLeftSec)}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
