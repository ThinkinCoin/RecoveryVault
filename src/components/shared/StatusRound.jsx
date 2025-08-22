import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";

/**
 * StatusRound.jsx
 * -------------------------------------------------------------
 * Reads RecoveryVault round status and shows a color-coded badge:
 * - Open = Green
 * - Paused = Grey
 * - On Delay Time = Yellow
 * - Stopped / Finished = Red
 *
 * Expected Vite envs:
 * - VITE_RPC_URL
 * - VITE_VAULT_ADDRESS
 * - VITE_BAND_ADDRESS (optional, not required here)
 * - VITE_ROUND_LOOKBACK_BLOCKS (optional, default 200000)
 *
 * Contract API used (ethers v6):
 * - function currentRound() view returns (uint256)
 * - function isLocked() view returns (bool)
 * - function paused() view returns (bool)  // if Pausable; handled with try/catch
 * - event NewRoundStarted(uint256 roundId, uint256 startTime)
 * - event VaultPaused(bool isPaused)       // optional decoding; not required if paused() exists
 *
 * All logs and UI strings are in English.
 * -------------------------------------------------------------
 */

const VAULT_IFACE = new ethers.Interface([
  "function currentRound() view returns (uint256)",
  "function isLocked() view returns (bool)",
  "function paused() view returns (bool)",
  "event NewRoundStarted(uint256 roundId, uint256 startTime)",
  "event VaultPaused(bool isPaused)"
]);

// Log scan tuning
const DEFAULT_LOOKBACK = 200_000; // blocks
const LOGS_CHUNK_DEFAULT = 1_000; // blocks per query window (will be reduced on RPC error)
const LOGS_CHUNK_MIN = 128; // minimum window size to try


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
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
  const LOOKBACK = Number(import.meta.env.VITE_ROUND_LOOKBACK_BLOCKS ?? DEFAULT_LOOKBACK);
  const LOGS_CHUNK = Number(import.meta.env.VITE_LOGS_CHUNK ?? LOGS_CHUNK_DEFAULT);

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

  // Bounded, chunked log scanner to avoid RPC limits like "GetLogs query must be smaller than size 1024"
  const findLastLog = useCallback(async (topicHash) => {
    if (!provider) throw new Error("Provider not ready");
    const latest = await provider.getBlockNumber();
    const from = Math.max(0, latest - LOOKBACK);

    let end = latest;
    let chunk = Math.max(LOGS_CHUNK_MIN, LOGS_CHUNK);

    while (end >= from) {
      const start = Math.max(from, end - chunk + 1);
      try {
        const logs = await provider.getLogs({ address: VAULT_ADDRESS, fromBlock: start, toBlock: end, topics: [topicHash] });
        if (logs && logs.length) {
          return logs[logs.length - 1];
        }
        end = start - 1; // move window backward
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        if (err?.code === -32000 || msg.includes('smaller than size') || msg.includes('query must be smaller')) {
          // shrink the window and retry
          const next = Math.max(LOGS_CHUNK_MIN, Math.floor(chunk / 2));
          if (next === chunk) {
            // can't shrink further: step back and continue
            end = Math.max(from, end - chunk);
          }
          chunk = next;
          continue;
        }
        throw err; // non-range error
      }
    }
    return null;
  }, [LOGS_CHUNK, LOOKBACK, VAULT_ADDRESS, provider]);

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
    if (!VAULT_ADDRESS) throw new Error("Missing env VITE_VAULT_ADDRESS");

    const contract = new ethers.Contract(VAULT_ADDRESS, VAULT_IFACE, provider);

    // Read simple states first
    const [crRaw, lockedRaw] = await Promise.all([
      contract.currentRound().catch((e) => { console.error("[StatusRound] currentRound() failed", e); return 0n; }),
      contract.isLocked().catch((e) => { console.error("[StatusRound] isLocked() failed", e); return false; })
    ]);

    const cr = Number(crRaw ?? 0n);
    const locked = Boolean(lockedRaw);

    // paused() may not exist in some builds; handle gracefully
    let paused = false;
    try {
      paused = await contract.paused();
    } catch (e) {
      try {
        const pausedEv = VAULT_IFACE.getEvent("VaultPaused").topicHash;
        const lastPausedLog = await findLastLog(pausedEv);
        if (lastPausedLog) {
          const parsed = VAULT_IFACE.parseLog(lastPausedLog);
          if (parsed?.args && typeof parsed.args[0] !== 'undefined') {
            paused = Boolean(parsed.args[0]);
          }
        }
      } catch (ee) {
        console.error("[StatusRound] paused() not available; unable to infer from VaultPaused logs", ee);
      }
    }

    // Find last NewRoundStarted for roundId / startTime
    let rid = cr;
    let st = 0;
    try {
      const newRoundEv = VAULT_IFACE.getEvent("NewRoundStarted").topicHash;
      const lastNewRoundLog = await findLastLog(newRoundEv);
      if (lastNewRoundLog) {
        const parsed = VAULT_IFACE.parseLog(lastNewRoundLog);
        if (parsed?.args) {
          const evRoundId = Number(parsed.args[0] ?? 0);
          const evStart = Number(parsed.args[1] ?? 0);
          rid = Number.isFinite(evRoundId) && evRoundId > 0 ? evRoundId : cr;
          st = Number.isFinite(evStart) ? evStart : 0;
        }
      }
    } catch (e) {
      console.error("[StatusRound] NewRoundStarted log scan failed", e);
    }
    const derived = computeStatus(paused, locked, (rid ?? 0) > 0);

    setCurrentRound(cr);
    setRoundId(rid);
    setStartTime(st);
    setIsLocked(locked);
    setIsPaused(paused);
    setStatusLabel(derived.label);
    setStatusClass(derived.cls);
    setLastUpdated(new Date());
  }, [LOOKBACK, VAULT_ADDRESS, computeStatus, provider]);

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
            <span className={styles.contractFundsSubLabel}>Round ID</span>
            <span className={styles.contractFundsSubValue}>{Number.isFinite(Number(roundId)) ? Number(roundId).toLocaleString() : "—"}</span>
          </div>

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
