// src/components/ContractFunds.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";
import { useOnePrice } from "@/hooks/useOnePrice";
import { getFeeTiers, selectTierForUsd } from "@/services/feeService.jsx";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function formatUSD(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

export default function ContractFunds() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [usdcBalance, setUsdcBalance] = useState(0);
  const [woneBalance, setWoneBalance] = useState(0);
  const [usdcSymbol, setUsdcSymbol] = useState("USDC");
  const [woneSymbol, setWoneSymbol] = useState("wONE");
  const [netUsd, setNetUsd] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Fee tier UI: number (1-based) + pct text
  const [activeTier, setActiveTier] = useState(null);
  const [activePct, setActivePct] = useState(null);

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
  const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS;
  const WONE_ADDRESS = import.meta.env.VITE_WONE_ADDRESS;
  const ONE_USD_OVERRIDE = import.meta.env.VITE_ONE_USD_OVERRIDE;

  // ONE/USD price via Band hook
  const { price: onePriceHook, error: onePriceErr, reload: reloadOnePrice } = useOnePrice();

  const intervalRef = useRef(null);

  const provider = useMemo(() => {
    try {
      if (!RPC_URL) return null;
      return new ethers.JsonRpcProvider(RPC_URL);
    } catch (err) {
      console.error("[ContractFunds] Provider init error:", err);
      return null;
    }
  }, [RPC_URL]);

  const getTokenMeta = useCallback(async (addr) => {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [dec, sym] = await Promise.all([
      c.decimals(),
      c.symbol().catch(() => "TOKEN"),
    ]);
    return { decimals: Number(dec), symbol: sym };
  }, [provider]);

  const fetchBalances = useCallback(async () => {
    if (!provider) throw new Error("Provider not ready");
    if (!VAULT_ADDRESS || !USDC_ADDRESS || !WONE_ADDRESS) throw new Error("Missing env: VAULT/WONE/USDC addresses");

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const wone = new ethers.Contract(WONE_ADDRESS, ERC20_ABI, provider);

    const [rawU, rawW, metaU, metaW] = await Promise.all([
      usdc.balanceOf(VAULT_ADDRESS),
      wone.balanceOf(VAULT_ADDRESS),
      getTokenMeta(USDC_ADDRESS),
      getTokenMeta(WONE_ADDRESS),
    ]);

    const u = Number(ethers.formatUnits(rawU, metaU.decimals));
    const w = Number(ethers.formatUnits(rawW, metaW.decimals));

    setUsdcSymbol(metaU.symbol);
    setWoneSymbol(metaW.symbol);
    setUsdcBalance(u);
    setWoneBalance(w);

    return { usdc: u, wone: w };
  }, [provider, VAULT_ADDRESS, USDC_ADDRESS, WONE_ADDRESS, getTokenMeta]);

  const compute = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      console.log("[ContractFunds] compute: start");

      // 1) saldos
      const { usdc, wone } = await fetchBalances();

      // 2) preço ONE/USD (hook) com fallback para override
      let oneUsd = Number.isFinite(onePriceHook) ? Number(onePriceHook) : NaN;
      if (!Number.isFinite(oneUsd)) {
        const ov = Number(ONE_USD_OVERRIDE);
        if (Number.isFinite(ov) && ov > 0) {
          oneUsd = ov;
        } else {
          oneUsd = 0; // sem oracle => contribui 0 no valor USD
          if (onePriceErr) {
            console.warn("[ContractFunds] ONE price unavailable via hook:", onePriceErr);
          }
        }
      }

      // 3) Net USD (USDC ~ 1:1 + wONE * preço)
      const totalUsd = usdc + wone * oneUsd;
      setNetUsd(totalUsd);

      // 4) Fee Tier baseada no Net USD inteiro (apenas para display)
      try {
        const tiers = await getFeeTiers(provider);
        const selected = selectTierForUsd(Math.floor(totalUsd), tiers);
        if (selected) {
          setActiveTier(selected.tier);
          setActivePct(`${(selected.pct).toFixed(2)}%`);
        } else {
          setActiveTier(null);
          setActivePct(null);
        }
      } catch (e) {
        console.error("[ContractFunds] fee tiers error:", e);
        setActiveTier(null);
        setActivePct(null);
      }

      setLastUpdated(new Date());
    } catch (err) {
      console.error("[ContractFunds] compute error:", err);
      setError(err?.message || "Unexpected error while computing vault funds");
    } finally {
      setIsLoading(false);
    }
  }, [fetchBalances, onePriceHook, onePriceErr, ONE_USD_OVERRIDE, provider]);

  useEffect(() => {
    // primeira carga
    compute();
    // agendamento
    intervalRef.current = setInterval(() => {
      // tenta recarregar preço e recomputar
      try { reloadOnePrice?.(); } catch {}
      compute();
    }, 600_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [compute, reloadOnePrice]);

  return (
    <div className={styles.contractFundsCard}>
      <div className={styles.contractFundsHeader}>
        <span className={styles.contractFundsTitle}>Vault Funds</span>
        <button type="button" className={styles.contractFundsRefreshBtn} onClick={compute} disabled={isLoading}>
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
            <span className={styles.contractFundsLabel}>Net Value</span>
            <span className={styles.contractFundsValue}>{formatUSD(netUsd)}</span>
          </div>

          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>wONE Balance</span>
            <span className={styles.contractFundsValue}>{formatAmount(woneBalance, 4)} </span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>USDC Balance</span>
            <span className={styles.contractFundsValue}>{formatAmount(usdcBalance, 2)} </span>
          </div>

          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Active Fee</span>
            <span className={`${styles.contractFundsPill} ${styles.contractFundsTier}`}>
            {Number.isFinite(activeTier) && activePct && (
              <span title="Fee Tier based on the vault's net USD (display only)">
              
              {`Tier ${activeTier}`} <span className={styles.contractFundsSubValue}>{activePct} </span> 
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
