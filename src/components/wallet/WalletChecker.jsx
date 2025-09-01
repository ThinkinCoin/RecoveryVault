// src/components/wallet/WalletChecker.jsx
// Checks if the connected wallet is whitelisted usando o whitelistService (single-flight).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/Global.module.css";
import { FiCheck, FiX } from "react-icons/fi";
import LimitChecker from "@/components/wallet/LimitChecker";

// ✅ usa a mesma fonte (serviço único)
import { useWhitelist, preloadProofs } from "@/services/whitelistService";
import * as core from "@/services/vaultCore";
import { useContractContext } from "@/contexts/ContractContext";

/** Lightweight hook to read currently connected account (no connect prompt) */
function useConnectedAddress() {
  const [address, setAddress] = useState(null);
  useEffect(() => {
    const { ethereum } = window;
    if (!ethereum) return;
    let mounted = true;

    const init = async () => {
      try {
        const accs = await ethereum.request({ method: "eth_accounts" });
        if (mounted) setAddress(accs?.[0] ?? null);
      } catch (err) {
        console.error("[WalletChecker] Failed to read accounts:", err);
      }
    };

    const onAccountsChanged = (accs) => setAddress(accs?.[0] ?? null);
    init();
    ethereum.on?.("accountsChanged", onAccountsChanged);
    return () => {
      mounted = false;
      try { ethereum.removeListener?.("accountsChanged", onAccountsChanged); } catch {}
    };
  }, []);
  return address;
}

const IconSpinner = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" role="img" style={{ display: "inline", marginRight: 8 }}>
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25" />
    <path d="M22 12a10 10 0 0 0-10-10" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.85">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
    </path>
  </svg>
);

const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

/**
 * Props:
 * - address?: string
 * - compact?: boolean
 * - onResult?: ({address, eligible, proof?: string[]}) => void
 * - className?: string
 */
export default function WalletChecker({ address, compact = false, onResult, className }) {
  const connected = useConnectedAddress();
  const effectiveAddress = useMemo(() => (address || connected || null), [address, connected]);

  // provider compartilhado com o app (e fallback para default RPC)
  const { provider: ctxProvider } = useContractContext();
  const readProvider = useMemo(() => ctxProvider || core.getDefaultProvider?.(), [ctxProvider]);

  // usa a mesma lógica/caches do whitelistService
  const { loading, ok: eligible, proof, error } = useWhitelist(effectiveAddress, readProvider);

  // preload opcional (idempotente, single-flight)
  useEffect(() => { preloadProofs().catch(() => {}); }, []);

  // publicar resultado para o pai (de-dupe)
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const lastRef = useRef({ addr: null, eligible: null });
  const publish = useCallback((eligibleVal, proofVal) => {
    if (lastRef.current.addr === effectiveAddress && lastRef.current.eligible === eligibleVal) return;
    lastRef.current = { addr: effectiveAddress, eligible: eligibleVal };
    onResultRef.current?.({ address: effectiveAddress, eligible: eligibleVal, proof: proofVal || undefined });
    console.info("[WalletChecker] Wallet", eligibleVal ? "is eligible:" : "is not eligible:", effectiveAddress);
  }, [effectiveAddress]);

  useEffect(() => {
    if (!effectiveAddress || !readProvider) return;
    if (loading) return;
    if (eligible) publish(true, proof);
    else publish(false);
  }, [effectiveAddress, readProvider, loading, eligible, proof, publish]);

  // status derivado
  const status = !effectiveAddress
    ? "idle"
    : loading
      ? "checking"
      : eligible
        ? "success"
        : error
          ? "error"
          : "denied";

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
      return <div style={{ opacity: 0.8 }}>Connect your wallet to check eligibility.</div>;
    }
    if (status === "checking") {
      return (
        <div style={{ ...badgeStyle, color: "#0db7e4" }} data-testid="wallet-status-checking" aria-live="polite">
          <IconSpinner /> Verifying wallet… <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)})</span>
        </div>
      );
    }
    if (status === "success") {
      return (
        <div style={{ ...badgeStyle, color: "#0a7f55" }} data-testid="wallet-status-success" aria-live="polite">
          <FiCheck style={{ marginRight: 8 }} /> Success <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)}) is prehacked.</span>
        </div>
      );
    }
    if (status === "denied") {
      return (
        <div style={{ ...badgeStyle, color: "#c0392b" }} data-testid="wallet-status-denied" aria-live="polite">
          <FiX style={{ marginRight: 8 }} /> Denied <span style={{ opacity: 0.7 }}>({shorten(effectiveAddress)})is not prehacked.</span>
        </div>
      );
    }
    if (status === "error") {
      return (
        <div style={{ ...badgeStyle, color: "#8c6d1f" }} data-testid="wallet-status-error" aria-live="polite">
          <FiX style={{ marginRight: 8 }} /> Error <span style={{ opacity: 0.7 }}>({error})</span>
        </div>
      );
    }
    return null;
  }, [effectiveAddress, status, error, badgeStyle]);

  return (
    <div className={`${styles.contractLimitsCard} ${className || ""}`}>
      <LimitChecker address={address} />
      {ui}
      {/* Opcional: detalhes da prova */}
      {/* {status === "success" && <pre className={styles.smallMuted}>{JSON.stringify(proof, null, 2)}</pre>} */}
    </div>
  );
}

// Utilidade programática usando a mesma fonte
export async function isWalletEligible(address) {
  if (!address) return { eligible: false };
  try {
    await preloadProofs();
    // reusa a função de “fast proof” se precisar
    // mas como não temos provider aqui, apenas indicamos elegibilidade via hook no componente
    return { eligible: true }; // use o componente para prova concreta
  } catch (err) {
    console.error("[WalletChecker] isWalletEligible error:", err);
    return { eligible: false, error: err?.message || "Unknown error" };
  }
}
