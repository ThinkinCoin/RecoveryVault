// src/components/redeem/RedeemForm.jsx
// Recovery Dex — Redeem flow wired to vaultService (ethers v6)
// UI messages and logs in English. Error handling via try/catch + console.error.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  redeem as redeemTx,
  parseUnitsSafe,
  formatUnitsSafe,
  watchEvents,
} from "@/services/vaultService";
import { ethers } from "ethers";

// Minimal Alert component (replace with your project <Alert /> if available)
function Alert({ type = "info", title, children, onClose }) {
  const colors = {
    success: { bg: "#e8fff4", bd: "#b6f3d6", fg: "#0a7f55" },
    error: { bg: "#ffecec", bd: "#ffb3b3", fg: "#a30000" },
    warning: { bg: "#fff7e6", bd: "#ffe1a3", fg: "#8c6d1f" },
    info: { bg: "#eaf4ff", bd: "#b7dcff", fg: "#09539b" },
  }[type] || { bg: "#eaf4ff", bd: "#b7dcff", fg: "#09539b" };

  return (
    <div style={{
      background: colors.bg,
      border: `1px solid ${colors.bd}`,
      color: colors.fg,
      padding: "10px 12px",
      borderRadius: 12,
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      {title && <strong style={{ fontSize: 14 }}>{title}</strong>}
      <div style={{ fontSize: 13 }}>{children}</div>
      {onClose && (
        <div style={{ textAlign: "right" }}>
          <button type="button" onClick={onClose} style={{ fontSize: 12, cursor: "pointer" }}>Close</button>
        </div>
      )}
    </div>
  );
}

/**
 * Derive a merkle proof array from a generic proof object.
 */
function useMerkleProof(proof) {
  return useMemo(() => {
    if (!proof) return [];
    if (Array.isArray(proof)) return proof; // already array of hashes
    if (Array.isArray(proof?.proof)) return proof.proof;
    if (Array.isArray(proof?.merkleProof)) return proof.merkleProof;
    return [];
  }, [proof]);
}

/**
 * Optionally fetch token decimals using minimal ERC20 interface when token changes.
 */
function useTokenDecimals(tokenAddress) {
  const [decimals, setDecimals] = useState(6); // default to 6 (USDC-like)

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        if (!tokenAddress || !ethers.isAddress(tokenAddress)) return;
        if (!window.ethereum) return;
        const provider = new ethers.BrowserProvider(window.ethereum);
        const erc20 = new ethers.Contract(
          tokenAddress,
          ["function decimals() view returns (uint8)"],
          provider
        );
        const d = await erc20.decimals();
        if (!cancelled) setDecimals(Number(d));
      } catch (err) {
        console.error("[RedeemForm] Failed to fetch token decimals:", err);
        // keep default 6
      }
    };
    run();
    return () => { cancelled = true; };
  }, [tokenAddress]);

  return decimals;
}

/**
 * RedeemForm
 * @param {object} props
 * @param {string} props.address connected wallet address
 * @param {boolean|null} props.eligible eligibility flag
 * @param {object|array} [props.proof] proof payload from WalletChecker (used to extract merkle proof)
 * @param {string} [props.defaultToken] optional default token address
 */
export default function RedeemForm({ address, eligible, proof, defaultToken }) {
  const [tokenAddress, setTokenAddress] = useState(defaultToken || "");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState(null); // { type, title, message }
  const [events, setEvents] = useState([]); // latest event logs

  const merkleProof = useMerkleProof(proof);
  const decimals = useTokenDecimals(tokenAddress);

  // Subscribe to on-chain events in real time
  useEffect(() => {
    const unsubscribe = watchEvents({
      onBurnToken: (log) => {
        setEvents((prev) => [{ type: "BurnToken", ...log }, ...prev].slice(0, 5));
      },
      onRedeemProcessed: (log) => {
        setEvents((prev) => [{ type: "RedeemProcessed", ...log }, ...prev].slice(0, 5));
      },
      onNewRoundStarted: (log) => {
        setEvents((prev) => [{ type: "NewRoundStarted", ...log }, ...prev].slice(0, 5));
      },
    });
    return unsubscribe;
  }, []);

  const canSubmit = useMemo(() => {
    const am = Number(amount);
    return !!address && eligible === true && merkleProof.length > 0 && ethers.isAddress(tokenAddress) && am > 0 && !loading;
  }, [address, eligible, merkleProof, tokenAddress, amount, loading]);

  const onRedeem = useCallback(async () => {
    try {
      if (!canSubmit) return;
      setLoading(true);
      setAlert(null);

      const amountUnits = parseUnitsSafe(amount, decimals);
      const tx = await redeemTx(tokenAddress, amountUnits, merkleProof);

      if (!tx?.hash) throw new Error("Transaction not submitted");

      setAlert({
        type: "success",
        title: "Redeem submitted",
        message: `TxHash: ${tx.hash}`,
      });
      console.info("[RedeemForm] redeem submitted:", tx.hash);
      setAmount("");
    } catch (err) {
      console.error("[RedeemForm] redeem error:", err);
      setAlert({ type: "error", title: "Redeem failed", message: err?.message || "Unknown error" });
    } finally {
      setLoading(false);
    }
  }, [canSubmit, tokenAddress, amount, merkleProof, decimals]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>Redeem</div>

      {/* Token address */}
      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Token address</span>
        <input
          type="text"
          placeholder="0x..."
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value.trim())}
          style={{ padding: 10, borderRadius: 10, border: "1px solid #e6e6e6" }}
        />
      </label>
      <div style={{ fontSize: 12, opacity: 0.6 }}>Token decimals: {decimals}</div>

      {/* Amount */}
      <label style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 12, opacity: 0.8 }}>Amount</span>
        <input
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ padding: 10, borderRadius: 10, border: "1px solid #e6e6e6" }}
        />
      </label>

      {/* Eligibility gate */}
      {eligible === false && (
        <Alert type="warning" title="Wallet not eligible">
          This wallet is not on the whitelist. Please contact support if you believe this is a mistake.
        </Alert>
      )}

      {/* Proof preview (dev) */}
      {merkleProof.length > 0 && (
        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: "pointer", opacity: 0.8 }}>Show Merkle proof (dev)</summary>
          <pre style={{ marginTop: 6, fontSize: 12, maxWidth: "100%", overflowX: "auto" }}>{JSON.stringify(merkleProof, null, 2)}</pre>
        </details>
      )}

      {/* Submit */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onRedeem}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #0db7e4",
            background: canSubmit ? "#0db7e4" : "#bfefff",
            color: canSubmit ? "#fff" : "#4a7f91",
            cursor: canSubmit ? "pointer" : "not-allowed",
            fontWeight: 600,
          }}
        >
          {loading ? "Processing..." : "Redeem"}
        </button>
        <button
          type="button"
          onClick={() => setAmount("")}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #e6e6e6", background: "#fff" }}
        >
          Clear
        </button>
      </div>

      {/* Alerts */}
      {alert && (
        <Alert type={alert.type} title={alert.title} onClose={() => setAlert(null)}>
          {alert.message}
        </Alert>
      )}

      {/* Live events */}
      <section>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Live events</div>
        {events.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.6 }}>Waiting for events…</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
            {events.map((ev, idx) => (
              <li key={idx} style={{ fontSize: 12, padding: 8, borderRadius: 10, border: "1px solid #eee", background: "#fafafa" }}>
                <div><strong>{ev.type}</strong></div>
                <div style={{ opacity: 0.8 }}>tx: {ev.txHash}</div>
                {typeof ev.blockNumber !== "undefined" && (
                  <div style={{ opacity: 0.6 }}>block: {ev.blockNumber}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
