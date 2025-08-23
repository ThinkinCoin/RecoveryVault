import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";

/**
 * ContractFunds.jsx
 * -------------------------------------------------------------
 * Reads RecoveryVault on-chain funds and displays Net USD value
 * (USDC balance + wONE balance * ONE/USD price).
 *
 * Requirements / Assumptions:
 * - Vite envs:
 *   - VITE_RPC_URL            : JSON-RPC endpoint for Harmony
 *   - VITE_VAULT_ADDRESS      : RecoveryVault contract address
 *   - VITE_USDC_ADDRESS       : USDC (or pegged) ERC20 address (6 decimals)
 *   - VITE_WONE_ADDRESS       : wONE ERC20 address (18 decimals)
 *   - VITE_ORACLE_ADDRESS     : (optional) Oracle address providing ONE/USD rate
 *   - VITE_ONE_USD_OVERRIDE   : (optional) string number to override oracle price (e.g., "0.013")
 *
 * - Ethers v6
 * - Minimal ERC20 ABI is used
 * - Oracle fallback strategies:
 *     1) Use VITE_ONE_USD_OVERRIDE if provided
 *     2) Use Band Standard Reference: getReferenceData("ONE","USD") -> rate 1e18
 *
 * UI/UX:
 * - English-only labels
 * - Compact, responsive card
 * - Auto-refresh every 60s with manual Refresh button
 * - Clear error states and console.error logging
 *
 * Notes:
 * - All strings and console logs are in English as requested.
 * -------------------------------------------------------------
 */

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// Band Standard Reference ABI (commonly used across chains)
const BAND_ORACLE_ABI = [
  "function getReferenceData(string base, string quote) external view returns (uint256 rate, uint256 lastUpdatedBase, uint256 lastUpdatedQuote)"
];

// Generic getPrice() ABI (some oracles expose a simple getter)

function formatUSD(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Safe helpers to avoid BigInt issues in formatting
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
  const [lastUpdated, setLastUpdated] = useState(null);

  const [usdcSymbol, setUsdcSymbol] = useState("USDC");
  const [woneSymbol, setWoneSymbol] = useState("wONE");
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [woneDecimals, setWoneDecimals] = useState(18);

  const [usdcBalance, setUsdcBalance] = useState(0); // in token units (float)
  const [woneBalance, setWoneBalance] = useState(0); // in token units (float)
  const [oneUsdPrice, setOneUsdPrice] = useState(null); // in USD (float)

  const [netUsd, setNetUsd] = useState(0);

  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
  const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS;
  const WONE_ADDRESS = import.meta.env.VITE_WONE_ADDRESS;
  const BAND_ADDRESS = import.meta.env.VITE_BAND_ADDRESS;
  const ONE_USD_OVERRIDE = import.meta.env.VITE_ONE_USD_OVERRIDE;

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

  const requireEnv = useCallback(() => {
    const missing = [];
    if (!RPC_URL) missing.push("VITE_RPC_URL");
    if (!VAULT_ADDRESS) missing.push("VITE_VAULT_ADDRESS");
    if (!USDC_ADDRESS) missing.push("VITE_USDC_ADDRESS");
    if (!WONE_ADDRESS) missing.push("VITE_WONE_ADDRESS");
    if (missing.length) {
      const msg = `Missing env vars: ${missing.join(", ")}`;
      setError(msg);
      console.error("[ContractFunds]", msg);
      return false;
    }
    return true;
  }, [RPC_URL, VAULT_ADDRESS, USDC_ADDRESS, WONE_ADDRESS]);

  const fetchOraclePrice = useCallback(async () => {
    // 1) Override via env
    if (ONE_USD_OVERRIDE && !Number.isNaN(Number(ONE_USD_OVERRIDE))) {
      return Number(ONE_USD_OVERRIDE);
    }

    if (!BAND_ADDRESS || !provider) return null;

    // 2) Try Band getReferenceData("ONE","USD") with 1e18 scale
    try {
      const band = new ethers.Contract(BAND_ADDRESS, BAND_ORACLE_ABI, provider);
      const { rate } = await band.getReferenceData("ONE", "USD");
      // Band usually returns 18 decimals. Convert to float USD.
      const price = Number(ethers.formatUnits(rate, 18));
      if (Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      console.error("[ContractFunds] Band oracle failed, fallback to simple getPrice():", err);
    }

    return null;
  }, [ONE_USD_OVERRIDE, BAND_ADDRESS, provider]);

  const fetchTokenMeta = useCallback(async (addr) => {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [dec, sym] = await Promise.all([
      c.decimals(),
      c.symbol().catch(() => "TOKEN")
    ]);
    return { dec: Number(dec), sym };
  }, [provider]);

  const fetchBalances = useCallback(async () => {
    if (!provider) throw new Error("Provider not ready");

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const wone = new ethers.Contract(WONE_ADDRESS, ERC20_ABI, provider);

    const [usdcBalRaw, woneBalRaw, usdcMeta, woneMeta] = await Promise.all([
      usdc.balanceOf(VAULT_ADDRESS),
      wone.balanceOf(VAULT_ADDRESS),
      fetchTokenMeta(USDC_ADDRESS),
      fetchTokenMeta(WONE_ADDRESS)
    ]);

    const usdcBal = Number(ethers.formatUnits(usdcBalRaw, usdcMeta.dec));
    const woneBal = Number(ethers.formatUnits(woneBalRaw, woneMeta.dec));

    setUsdcDecimals(Number(usdcMeta.dec));
    setWoneDecimals(Number(woneMeta.dec));
    setUsdcSymbol(usdcMeta.sym);
    setWoneSymbol(woneMeta.sym);
    setUsdcBalance(usdcBal);
    setWoneBalance(woneBal);

    return { usdcBal, woneBal };
  }, [USDC_ADDRESS, WONE_ADDRESS, VAULT_ADDRESS, provider, fetchTokenMeta]);

  const compute = useCallback(async () => {
    if (!requireEnv()) return;
    if (!provider) {
      setError("Provider not ready");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const [{ usdcBal, woneBal }, price] = await Promise.all([
        fetchBalances(),
        fetchOraclePrice()
      ]);

      setOneUsdPrice(price);

      const usdcUsd = usdcBal; // peg 1:1 USD
      const woneUsd = price ? woneBal * price : 0;
      const totalUsd = usdcUsd + woneUsd;

      setNetUsd(totalUsd);
      setLastUpdated(new Date());
    } catch (err) {
      console.error("[ContractFunds] compute error:", err);
      setError(err?.message || "Unexpected error while computing vault funds");
    } finally {
      setIsLoading(false);
    }
  }, [fetchBalances, fetchOraclePrice, provider, requireEnv]);

  useEffect(() => {
    // initial fetch
    compute();

    // auto refresh each 60s
    intervalRef.current = setInterval(() => {
      compute();
    }, 60_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [compute]);

  const hasFunds = (netUsd ?? 0) > 0.0;

  return (
    <div className={styles.contractFundsCard}>
      <div className={styles.contractFundsHeader}>
        <span className={styles.contractFundsTitle}>Vault Funds</span>
        <button
          type="button"
          onClick={compute}
          disabled={isLoading}
          className={styles.contractFundsRefreshBtn}
          aria-label="Refresh balances"
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
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Net USD</span>
            <span className={styles.contractFundsValue} data-testid="net-usd">{formatUSD(netUsd)}</span>
          </div>

          <div className={styles.contractFundsSep} />

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>{usdcSymbol} Balance</span>
            <span className={styles.contractFundsSubValue}>
              {formatAmount(usdcBalance, Math.min(usdcDecimals ?? 6, 8))} 
              <span className={styles.contractFundsMuted}> ({formatUSD(usdcBalance)})</span>
            </span>
          </div>

          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>{woneSymbol} Balance</span>
            <span className={styles.contractFundsSubValue}>
              {formatAmount(woneBalance, Math.min(woneDecimals ?? 18, 8))}
              <span className={styles.contractFundsMuted}> ({oneUsdPrice ? formatUSD(woneBalance * oneUsdPrice) : "USD price unavailable"})</span>
            </span>
          </div>

          <div className={styles.contractFundsFooter}> 
            <span className={styles.contractFundsPill} aria-live="polite">{hasFunds ? "Funds available" : "No funds"}</span>
            <span className={styles.contractFundsTimestamp}>
              {lastUpdated ? `Last updated: ${lastUpdated.toLocaleString()}` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

