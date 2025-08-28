// src/components/limit/LimitChecker.jsx
import React, { useMemo } from "react";
import s from "@/styles/Global.module.css";
import * as vaultService from "@/services/vaultService";
import { ethers } from "ethers";
import useLimits from "@/hooks/useLimits";


export default function LimitChecker({ address }) {
  const provider = useMemo(
    () => vaultService.getDefaultProvider?.() || null,
    []
  );

  const { loading, error, limitUSD, usedUSD, remainingUSD, timeLeftSec } =
    useLimits(address, provider);

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
        {/* botão refresh pode ser removido (o hook já atualiza countdown); se quiser, recarregue trocando uma key */}
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
