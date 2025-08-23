import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";
import * as vaultService from "@/services/vaultService";

/**
 * StatusRound.jsx (refactor to use vaultService)
 * -------------------------------------------------------------
 * Keeps the original legacy structure and styles (contractFunds*),
 * but replaces on-chain reads with vaultService helpers.
 *
 * Expected Vite envs:
 * - VITE_RPC_URL
 * - VITE_VAULT_ADDRESS
 * - VITE_ROUND_LOOKBACK_BLOCKS (no longer used here, kept for compatibility)
 *
 * Contract API via vaultService (ethers v6):
 * - getRoundInfo(provider)              // returns struct/tuple with round metadata
 * - isLocked(provider)                  // returns bool
 * - getVaultContract(provider).paused() // (try/catch) optional if Pausable
 * -------------------------------------------------------------
 */

function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

function formatDate(tsSeconds) {
  if (!tsSeconds) return "—";
  const n = Number(tsSeconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  try {
    return new Date(n * 1000).toLocaleString();
  } catch { return "—"; }
}

// Safe number extraction from possible struct/tuple
function toNum(v, d = 0) {
  try {
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
  } catch {}
  return d;
}

function firstNum(obj, keys, d = 0) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = toNum(obj[k], undefined);
      if (Number.isFinite(n)) return n;
    }
  }
  return d;
}

export default function StatusRound() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [currentRound, setCurrentRound] = useState(0);
  const [roundId, setRoundId] = useState(0);
  const [startTime, setStartTime] = useState(0); // seconds
  const [isLocked, setIsLocked] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const [statusLabel, setStatusLabel] = useState("Stopped / Finished");
  const [statusClass, setStatusClass] = useState("statusStopped");
  const [lastUpdated, setLastUpdated] = useState(null);

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const provider = useMemo(() => {
    try {
      if (!RPC_URL) return null;
      return new ethers.JsonRpcProvider(RPC_URL);
    } catch (err) {
      console.error("[StatusRound] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  const intervalRef = useRef(null);

  const computeStatus = useCallback((paused, locked, hasRound) => {
    if (paused) {
      return { label: "Paused", cls: "statusPaused" };
    }
    if (locked) {
      return { label: "On Delay Time", cls: "statusDelay" };
    }
    if (hasRound) {
      return { label: "Open", cls: "statusOpen" };
    }
    return { label: "Stopped / Finished", cls: "statusStopped" };
  }, []);

  const fetchState = useCallback(async () => {
    if (!provider) throw new Error("Provider not ready");

    // 1) Round info via vaultService (structure may vary by contract build)
    let info = null;
    try {
      info = await vaultService.getRoundInfo(provider);
    } catch (e) {
      console.error("[StatusRound] getRoundInfo() failed", e);
    }

    // Extract roundId / currentRound / startTime from struct or tuple
    // Common keys tried: roundId, currentRound, id, startTime, redeemStartsAt
    let rid = 0;
    let cr = 0;
    let st = 0;

    if (info && typeof info === "object") {
      rid = firstNum(info, ["roundId", "currentRound", "id", "round", 0], 0);
      cr  = firstNum(info, ["currentRound", "roundId", "id", "round", 0], rid);
      st  = firstNum(info, ["redeemStartsAt", "startTime", 1], 0);

      // Tuples (arrays) fallback
      if (Array.isArray(info)) {
        // Typically [roundId, startTime, ...]
        rid = toNum(info[0], rid);
        st  = toNum(info[1], st);
      }
    }

    // 2) Locked flag
    let locked = false;
    try {
      locked = Boolean(await vaultService.isLocked(provider));
    } catch (e) {
      console.error("[StatusRound] isLocked() failed", e);
    }

    // 3) Paused flag (optional)
    let paused = false;
    try {
      const c = vaultService.getVaultContract(provider);
      if (c && typeof c.paused === "function") {
        paused = Boolean(await c.paused());
      }
    } catch (e) {
      // If not Pausable, ignore
    }

    const derived = computeStatus(paused, locked, (rid ?? 0) > 0 || (cr ?? 0) > 0);

    setCurrentRound(cr || rid || 0);
    setRoundId(rid || cr || 0);
    setStartTime(st || 0);
    setIsLocked(locked);
    setIsPaused(paused);
    setStatusLabel(derived.label);
    setStatusClass(derived.cls);
    setLastUpdated(new Date());
  }, [computeStatus, provider]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      await fetchState();
    } catch (err) {
      console.error("[StatusRound] refresh error:", err);
      setError(err?.message || "Unexpected error while fetching round status");
    } finally {
      setIsLoading(false);
    }
  }, [fetchState]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refresh]);

  return (
    <div className={styles.contractFundsCard}>
      <div className={styles.contractFundsHeader}>
        <span className={styles.contractFundsTitle}>Round Status</span>
        <button type="button" className={styles.contractFundsRefreshBtn} onClick={refresh} disabled={isLoading}>
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className={styles.contractFundsErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Status</span>
            <span className={cx(styles.contractFundsPill, styles[statusClass])}>{statusLabel}</span>
          </div>

          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Start Time</span>
            <span className={styles.contractFundsSubValue}>{formatDate(startTime)}</span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Current Round</span>
            <span className={styles.contractFundsSubValue}>{Number.isFinite(Number(currentRound)) ? Number(currentRound).toLocaleString() : "—"}</span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Locked</span>
            <span className={styles.contractFundsSubValue}>{isLocked ? "Yes" : "No"}</span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Paused</span>
            <span className={styles.contractFundsSubValue}>{isPaused ? "Yes" : "No"}</span>
          </div>
{/*
          <div className={styles.contractFundsFooter}>
            <span className={styles.contractFundsTimestamp}>
              {lastUpdated ? `Last updated: ${lastUpdated.toLocaleString()}` : ""}
            </span>
          </div>
*/}
        </>
      )}
    </div>
  );
}
