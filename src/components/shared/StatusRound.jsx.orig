import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";
import * as vaultService from "@/services/vaultService";

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

function toNum(v, d = 0) {
  try {
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
  } catch {}
  return d;
}

export default function StatusRound() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [roundId, setRoundId] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [timeLeftSec, setTimeLeftSec] = useState(0);

  const [statusLabel, setStatusLabel] = useState("Inactive");
  const [statusClass, setStatusClass] = useState("statusStopped");

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const provider = useMemo(() => {
    try {
      return vaultService.getDefaultProvider?.() || (RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null);
    } catch (err) {
      console.error("[StatusRound] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  // --- Local countdown (no chain calls) ---
  const countdownRef = useRef(null);
  const startCountdown = useCallback((targetEpochSec) => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    if (!targetEpochSec) { setTimeLeftSec(0); return; }
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const left = Math.max(0, targetEpochSec - now);
      setTimeLeftSec(left);
      if (left === 0 && countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
  }, []);

  const formatDuration = useCallback((secs) => {
    const s = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }, []);

  // Status per especificação:
  // - Paused: info.paused === true
  // - Locked: isLocked() === true
  // - On Hold: now < startTime (ROUND_DELAY em curso)
  // - Active: now >= startTime && !paused && !locked && hasFunds
  // - Inactive: sem fundos após startTime (e não locked/paused)
  const computeStatus = useCallback(({ paused, locked, start, hasFunds }) => {
    const now = Math.floor(Date.now() / 1000);
    if (paused) return { label: "Paused", cls: "statusPaused" };
    if (locked) return { label: "Locked", cls: "statusPaused" };
    if (start && now < start) return { label: "On Hold", cls: "statusHold" };
    if (hasFunds) return { label: "Active", cls: "statusOpen" };
    return { label: "Inactive", cls: "statusStopped" };
  }, []);

  const fetchState = useCallback(async () => {
    if (!provider) throw new Error("Provider not ready");

    // getRoundInfo: startTime já é o roundStart (após aplicar ROUND_DELAY no startNewRound)
    // também retorna paused e isActive, mas seguiremos a regra explícita acima.
    const [info, balances, locked] = await Promise.all([
      vaultService.getRoundInfo(provider).catch(() => null),
      vaultService.getVaultBalances(provider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
      vaultService.isLocked(provider).catch(() => false),
    ]);

    const rid = toNum(info?.roundId, 0);
    const st = toNum(info?.startTime, 0);
    const paused = Boolean(info?.paused);

    // hasFunds baseado no cofre (não exibimos os valores neste card)
    const w = balances?.woneBalance ?? 0n;
    const u = balances?.usdcBalance ?? 0n;
    const hasFunds = (w > 0n) || (u > 0n);

    setRoundId(rid);
    setStartTime(st);
    setIsLocked(Boolean(locked));
    setIsPaused(paused);

    // Countdown até startTime
    const now = Math.floor(Date.now() / 1000);
    if (st && now < st) startCountdown(st); else setTimeLeftSec(0);

    const derived = computeStatus({ paused, locked, start: st, hasFunds });
    setStatusLabel(derived.label);
    setStatusClass(derived.cls);
  }, [provider, computeStatus, startCountdown]);

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
    const interval = setInterval(refresh, 600_000);
    return () => { clearInterval(interval); if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [refresh]);

  return (
    <div className={styles.contractStatusCard}>
      <div className={styles.contractStatusHeader}>
        <span className={styles.contractStatusTitle}>Round Status</span>
        <button type="button" className={styles.contractStatusRefreshBtn} onClick={refresh} disabled={isLoading}>
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className={styles.contractStatusErrorBox} role="alert">
          <strong>Failed to load:</strong> {error}
        </div>
      ) : (
        <>
          <div className={styles.contractStatusSep} />
          <div className={styles.contractStatusRow}>
            <span className={styles.contractStatusLabel}>Status</span>
            <span className={cx(styles.contractStatusPill, styles[statusClass])}>{statusLabel}</span>
          </div>

          

          <div className={styles.contractStatusRow}>
            <span className={styles.contractStatusSubLabel}>Start Time</span>
            <span className={styles.contractStatusSubValue}>{formatDate(startTime)}</span>
          </div>

          <div className={styles.contractStatusRow}>
            <span className={styles.contractStatusSubLabel}>Round ID</span>
            <span className={styles.contractStatusSubValue}>{Number.isFinite(Number(roundId)) ? Number(roundId).toLocaleString() : "—"}</span>
          </div>

          <div className={styles.contractStatusRow}>
            <span className={styles.contractStatusSubLabel}>Locked</span>
            <span className={styles.contractStatusSubValue}>{isLocked ? "Yes" : "No"}</span>
          </div>

          <div className={styles.contractStatusRow}>
            <span className={styles.contractStatusSubLabel}>Paused</span>
            <span className={styles.contractStatusSubValue}>{isPaused ? "Yes" : "No"}</span>
          </div>

          {timeLeftSec > 0 && (
            <>
              <div className={styles.contractStatusSep} />
              <div className={styles.contractStatusRow}>
                <span className={styles.contractStatusSubLabel}>Round starts in: </span>
                <span className={styles.contractStatusSubValue}>{formatDuration(timeLeftSec)}</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
