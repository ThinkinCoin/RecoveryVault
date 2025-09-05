// src/components/ContractFunds.jsx
import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import styles from "@/styles/Global.module.css";
import { useOnePrice } from "@/hooks/useOnePrice";
import { getVaultStatus, getFeeTiers, getDefaultProvider } from "@/services/vaultCore";
import { ethers } from "ethers";

// ---------- Format helpers ----------
function formatUSD(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function clamp(num, min, max) {
  const n = Number(num);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function formatAmount(val, maxFractionDigits = 6) {
  const n = Number(val ?? 0);
  const mfd = clamp(maxFractionDigits, 0, 20);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: mfd });
}

// Compute active fee tier in "cap mode":
// thresholds = [cap1, cap2, cap3] USD integers (ascending or not)
// rule: pick the first threshold >= netUsd; if none, pick the last
function computeActiveTierCapMode(netUsd, thresholds = [], bps = []) {
  if (!Array.isArray(thresholds) || !Array.isArray(bps)) return { tier: null, pctText: null };
  if (thresholds.length === 0 || bps.length === 0) return { tier: null, pctText: null };

  // Normalize and sort by threshold ASC
  const pairs = thresholds
    .map((t, i) => ({ t: Number(t), b: Number(bps[i] ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.b))
    .sort((a, b) => a.t - b.t);

  if (pairs.length === 0) return { tier: null, pctText: null };

  // Cap-mode: first cap >= netUsd; else last
  let idx = pairs.findIndex((p) => netUsd <= p.t);
  if (idx === -1) idx = pairs.length - 1;

  const tierNumber = idx + 1; // 1-based
  const pctText = `${(pairs[idx].b / 100).toFixed(2)}%`; // bps → %
  return { tier: tierNumber, pctText };
}


// Compute active tier given netUsd and tiers arrays
function computeActiveTier(netUsd, thresholds = [], bps = []) {
  if (!Array.isArray(thresholds) || !Array.isArray(bps)) return { tier: null, pctText: null };
  if (thresholds.length === 0 || bps.length === 0) return { tier: null, pctText: null };

  // Pair and sort by threshold ASC to avoid ordering issues
  const pairs = thresholds
    .map((t, i) => ({ t: Number(t), b: Number(bps[i] ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.b))
    .sort((a, b) => a.t - b.t);

  if (pairs.length === 0) return { tier: null, pctText: null };

  let activeIndex = null;
  for (let i = 0; i < pairs.length; i++) {
    if (netUsd >= pairs[i].t) {
      activeIndex = i; // keep highest match
    }
  }
  if (activeIndex === null) return { tier: null, pctText: null };

  const tierNumber = activeIndex + 1; // 1-based
  const pctText = `${(pairs[activeIndex].b / 100).toFixed(2)}%`; // bps -> %
  return { tier: tierNumber, pctText };
}

export default function ContractFunds() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [usdcBalance, setUsdcBalance] = useState(0);
  const [woneBalance, setWoneBalance] = useState(0);
  const [netUsd, setNetUsd] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Fee tier UI: number (1-based) + pct text
  const [activeTier, setActiveTier] = useState(null);
  const [activePct, setActivePct] = useState(null);

  const ONE_USD_OVERRIDE = import.meta.env.VITE_ONE_USD_OVERRIDE;

  // ONE/USD price via Band hook
  const { price: onePriceHook, error: onePriceErr, reload: reloadOnePrice } = useOnePrice();

  // Refs to avoid loops and race conditions
  const oneUsdRef = useRef(0);
  const isMountedRef = useRef(false);
  const isBusyRef = useRef(false);
  const reloadRef = useRef(reloadOnePrice);
  const intervalRef = useRef(null);

  // Keep the latest reload function without retriggering effects
  useEffect(() => {
    reloadRef.current = reloadOnePrice;
  }, [reloadOnePrice]);

  // Keep the latest ONE price (override has priority)
  useEffect(() => {
    let next = Number.isFinite(onePriceHook) ? Number(onePriceHook) : NaN;
    const ov = Number(ONE_USD_OVERRIDE);
    if (Number.isFinite(ov) && ov > 0) {
      next = ov;
    }
    if (!Number.isFinite(next)) {
      next = 0;
      if (onePriceErr) {
        console.warn("[ContractFunds] ONE price unavailable via hook:", onePriceErr);
      }
    }
    oneUsdRef.current = next;
  }, [onePriceHook, onePriceErr, ONE_USD_OVERRIDE]);

  const compute = useCallback(async () => {
    if (isBusyRef.current) return;
    isBusyRef.current = true;

    setIsLoading(true);
    setError("");

    try {
      console.log("[ContractFunds] compute via vaultService");

      // Read-only provider for contract reads
      const provider = useMemo(() => {
        try { return getDefaultProvider?.() || null; } catch { return null; }
      }, []);

      // 1) Get current balances and base status
      const status = await getVaultStatus(provider);
      if (!isMountedRef.current) return;

      const u = Number(status?.balances?.usdc ?? 0n) / 1e6;   // USDC 6 decimals
      const w = Number(status?.balances?.wone ?? 0n) / 1e18;  // wONE 18 decimals
      const oneUsd = oneUsdRef.current;

      setUsdcBalance(u);
      setWoneBalance(w);

      const totalUsd = u + w * oneUsd;
      setNetUsd(totalUsd);

      // 2) Fetch fee tiers explicitly (refactor-safe)
      // ---------- Active Fee Tier ----------
      // Use getFeeTiers(provider) to avoid relying on old status fields
      let thresholds = [];
      let bps = [];
      try {
        const tiers = await getFeeTiers(provider);
        thresholds = Array.isArray(tiers?.thresholds) ? tiers.thresholds : tiers?.feeThresholds;
        bps        = Array.isArray(tiers?.bps)        ? tiers.bps        : tiers?.feeBps;
      } catch (e) {
        console.warn("[ContractFunds] getFeeTiers() failed, will fallback to status if present", e);
      }

      // Fallback to status (legacy) if tiers not returned
      if ((!thresholds || thresholds.length === 0) && status?.feeThresholds?.length) {
        thresholds = status.feeThresholds;
        bps        = status.feeBps ?? [];
      }

      if (thresholds?.length && bps?.length) {
        // Contract works with integer USD; align by flooring netUsd
        const netUsdInt = Math.floor(totalUsd);
        const { tier, pctText } = computeActiveTierCapMode(netUsdInt, thresholds, bps);
        setActiveTier(tier);
        setActivePct(pctText);
      } else {
        setActiveTier(null);
        setActivePct(null);
      }


      setLastUpdated(new Date());
    } catch (err) {
      console.error("[ContractFunds] compute error:", err);
      if (isMountedRef.current) {
        setError(err?.message || "Unexpected error while computing vault funds");
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
      isBusyRef.current = false;
    }
  }, []); // ✅ stable reference; no loop from hook deps

  useEffect(() => {
    isMountedRef.current = true;
    compute(); // run once on mount

    // Single interval (10min). Does not re-run when hook changes.
    intervalRef.current = setInterval(() => {
      try {
        reloadRef.current?.(); // refresh price source lazily
      } catch {}
      compute();
    }, 600_000);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [compute]); // compute is stable

  return (
    <div className={styles.contractFundsCard}>
      <div className={styles.contractFundsHeader}>
        <span className={styles.contractFundsTitle}>Vault Funds</span>
        <button
          type="button"
          className={styles.contractFundsRefreshBtn}
          onClick={compute}
          disabled={isLoading}
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className={styles.contractFundsErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Net Value</span>
            <span className={styles.contractFundsValue}>{formatUSD(netUsd)}</span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>wONE Balance</span>
            <span className={styles.contractFundsValue}>{formatAmount(woneBalance, 4)}</span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>USDC Balance</span>
            <span className={styles.contractFundsValue}>{formatAmount(usdcBalance, 2)}</span>
          </div>

          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Active Fee</span>
            <span className={`${styles.contractFundsPill} ${styles.contractFundsTier}`}>
              {Number.isFinite(activeTier) && activePct && (
                <span title="Fee Tier based on the vault's net USD (from contract)">
                  {`Tier ${activeTier}`}{" "}
                  <span className={styles.contractFundsSubValue}>{activePct}</span>
                </span>
              )}
            </span>
          </div>

          <div className={styles.contractFundsFooter}>
            <span className={styles.contractFundsTimestamp}>
              {lastUpdated ? `Last updated: ${lastUpdated.toLocaleString()}` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
