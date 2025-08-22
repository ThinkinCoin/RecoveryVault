// src/components/wallet/WalletChecker.jsx
// Description: Checks if the connected wallet address is enabled (whitelisted)
// by looking up /data/proofs.json. Shows a loader while verifying,
// then displays Success or Denied. All UI texts and logs are in English.
// Patched: stable onResult (ref + dedupe), avoids verify loops with React StrictMode.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/Global.module.css";
import { TfiReload } from "react-icons/tfi";
import { FiCheck, FiX } from "react-icons/fi";

/**
 * Lightweight hook to get the currently connected EIP-1193 account
 * without triggering a connection request. It listens to `accountsChanged`.
 * Falls back to null if no provider or not connected.
 */
function useConnectedAddress() {
  const [address, setAddress] = useState(null);

  useEffect(() => {
    const { ethereum } = window;
    if (!ethereum) return;

    let isMounted = true;

    const init = async () => {
      try {
        const accounts = await ethereum.request({ method: "eth_accounts" });
        if (isMounted) setAddress(accounts?.[0] ?? null);
      } catch (err) {
        console.error("[WalletChecker] Failed to read accounts:", err);
      }
    };

    const onAccountsChanged = (accs) => {
      setAddress(accs?.[0] ?? null);
    };

    init();
    ethereum.on?.("accountsChanged", onAccountsChanged);

    return () => {
      isMounted = false;
      try {
        ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      } catch (_) {}
    };
  }, []);

  return address;
}

/**
 * Try to find an address inside various possible shapes of proofs.json.
 * Supports:
 *  - Array<string>: ["0xabc...", ...]
 *  - { claims: { [address]: {...proof} } }
 *  - { proofs: { [address]: {...proof} } }
 *  - { [address]: {...proof} }
 *  - { addresses: ["0x..."] }
 */
function findAddressInProofs(addr, proofsData) {
  if (!addr || !proofsData) return null;
  const target = String(addr).toLowerCase();

  // Array format
  if (Array.isArray(proofsData)) {
    const hit = proofsData.map((x) => String(x).toLowerCase());
    return hit.includes(target) ? true : null;
  }

  // { addresses: [...] }
  if (Array.isArray(proofsData?.addresses)) {
    const hit = proofsData.addresses.map((x) => String(x).toLowerCase());
    return hit.includes(target) ? true : null;
  }

  // { claims: { [addr]: obj } }
  if (proofsData?.claims && typeof proofsData.claims === "object") {
    const keys = Object.keys(proofsData.claims).reduce((acc, k) => {
      acc[k.toLowerCase()] = proofsData.claims[k];
      return acc;
    }, {});
    return keys[target] ?? null;
  }

  // { proofs: { [addr]: obj } }
  if (proofsData?.proofs && typeof proofsData.proofs === "object") {
    const keys = Object.keys(proofsData.proofs).reduce((acc, k) => {
      acc[k.toLowerCase()] = proofsData.proofs[k];
      return acc;
    }, {});
    return keys[target] ?? null;
  }

  // Flat object { [addr]: obj }
  if (!Array.isArray(proofsData) && typeof proofsData === "object") {
    const keys = Object.keys(proofsData).reduce((acc, k) => {
      acc[k.toLowerCase()] = proofsData[k];
      return acc;
    }, {});
    if (Object.prototype.hasOwnProperty.call(keys, target)) return keys[target];
  }

  return null;
}

/** Fetch /data/proofs.json (from public folder) with cache-busting disabled. */
async function fetchProofsJson(url = "/data/proofs.json") {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load proofs.json: ${res.status}`);
  return res.json();
}

/** Minimal inline SVG spinner (no external CSS animations required) */
const IconSpinner = () => (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    role="img"
    style={{ display: "inline", marginRight: 8 }}
  >
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25" />
    <path d="M22 12a10 10 0 0 0-10-10" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.85">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
    </path>
  </svg>
);

/** Shorten 0x address like 0x1234…abcd */
const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

/**
 * Component Props
 * @param {string} [address] Optional: force an address; if omitted, uses the connected wallet
 * @param {string} [proofsUrl] Optional: custom URL for proofs JSON (default: "/data/proofs.json")
 * @param {boolean} [compact] Optional: tighter layout
 * @param {(result: { address: string, eligible: boolean, proof?: any })=>void} [onResult] Optional callback when verification finishes
 * @param {string} [className] Optional className
 */
export default function WalletChecker({ address, proofsUrl = "/data/proofs.json", compact = false, onResult, className }) {
  const connected = useConnectedAddress();
  const effectiveAddress = useMemo(() => (address || connected || null), [address, connected]);

  const [status, setStatus] = useState("idle"); // idle | checking | success | denied | error
  const [error, setError] = useState("");
  const [proof, setProof] = useState(null);
  const mountedRef = useRef(true);

  // Stable onResult + last published result to avoid duplicate emits/logs
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const lastRef = useRef({ addr: null, eligible: null });

  const publish = useCallback((eligible, proofVal) => {
    if (lastRef.current.addr === effectiveAddress && lastRef.current.eligible === eligible) return;
    lastRef.current = { addr: effectiveAddress, eligible };
    onResultRef.current?.({ address: effectiveAddress, eligible, proof: proofVal });
    console.info("[WalletChecker] Wallet", eligible ? "is eligible:" : "is not eligible:", effectiveAddress);
  }, [effectiveAddress]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const verify = useCallback(async () => {
    if (!effectiveAddress) {
      setStatus("idle");
      setProof(null);
      return;
    }
    setStatus("checking");
    setError("");
    setProof(null);

    try {
      const data = await fetchProofsJson(proofsUrl);
      const result = findAddressInProofs(effectiveAddress, data);

      if (!mountedRef.current) return;

      if (result) {
        setStatus((s) => (s === "success" ? s : "success"));
        const pv = result === true ? undefined : result;
        setProof(pv || null);
        publish(true, pv);
      } else {
        setStatus((s) => (s === "denied" ? s : "denied"));
        publish(false);
      }
    } catch (err) {
      console.error("[WalletChecker] Verification error:", err);
      if (!mountedRef.current) return;
      setStatus("error");
      setError(err?.message || "Unknown error");
      publish(false);
    }
  }, [effectiveAddress, proofsUrl, publish]);

  // Auto-verify whenever the effective address changes
  useEffect(() => {
    verify();
  }, [verify]);

  const badgeStyle = useMemo(() => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: compact ? "6px 10px" : "10px 14px",
    borderRadius: 12,
    fontSize: compact ? 13 : 14,
    fontWeight: 600,
  }), [compact]);

  const ui = useMemo(() => {
    if (!effectiveAddress) {
      return (
        <div style={{ opacity: 0.8 }}>Connect your wallet to check eligibility.</div>
      );
    }

    if (status === "checking") {
      return (
        <div style={{ ...badgeStyle, background: "#0db7e422", color: "#0db7e4" }} data-testid="wallet-status-checking" aria-live="polite">
          <IconSpinner /> Verifying wallet… <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)})</span>
        </div>
      );
    }

    if (status === "success") {
      return (
        <div style={{ ...badgeStyle, background: "#5befc233", color: "#0a7f55" }} data-testid="wallet-status-success" aria-live="polite">
          <FiCheck style={{ marginRight: 8 }} /> Success <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)}) is prehacked.</span>
        </div>
      );
    }

    if (status === "denied") {
      return (
        <div style={{ ...badgeStyle, background: "#ff6b6b22", color: "#c0392b" }} data-testid="wallet-status-denied" aria-live="polite">
          <FiX style={{ marginRight: 8 }} /> Denied <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)})is not prehacked.</span>
        </div>
      );
    }

    if (status === "error") {
      return (
        <div style={{ ...badgeStyle, background: "#ffd16633", color: "#8c6d1f" }} data-testid="wallet-status-error" aria-live="polite">
          <FiX style={{ marginRight: 8 }} /> Error <span style={{ opacity: 0.7 }}>({error})</span>
        </div>
      );
    }

    return null;
  }, [effectiveAddress, status, error, badgeStyle]);

  return (
    <div className={styles.contractFundsCard}>
      <span className={styles.contractFundsTitle}>Wallet eligibility</span>
      {ui}

      {/* Optional proof details (hidden unless available). Helpful for debug / contract calls. */}
      {status === "success"}

      {/* Manual re-check button */}
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          onClick={verify}
          className={`${styles.button} ${styles.but}`}
          title="Re-check eligibility"
        >
          <TfiReload size={12} />
        </button>
      </div>
    </div>
  );
}

// Utility: a programmatic checker you can import elsewhere if needed
export async function isWalletEligible(address, proofsUrl = "/data/proofs.json") {
  if (!address) return { eligible: false };
  try {
    const data = await fetchProofsJson(proofsUrl);
    const result = findAddressInProofs(address, data);
    return { eligible: !!result, proof: result === true ? undefined : result };
  } catch (err) {
    console.error("[WalletChecker] isWalletEligible error:", err);
    return { eligible: false, error: err?.message || "Unknown error" };
  }
}
