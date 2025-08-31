import React, { useEffect, useMemo, useState } from "react";
import styles from "../../styles/Global.module.css";
import { FiCopy, FiPower } from "react-icons/fi";

// ✅ Hooks do AppKit React para abrir o modal
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";

// Helpers que você já tem (ainda úteis p/ estado inicial e disconnect)
import {
  getActiveWalletProvider,
  disconnectWallet,
  getAppKitInstance
} from "@/services/appkit";

export default function WalletConnection() {
  const { open } = useAppKit(); 
  const { address: hookedAddress, isConnected: hookedIsConnected } =
    useAppKitAccount({ namespace: "eip155" });

  const [address, setAddress] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // Espelha o estado dos hooks do AppKit (quando disponíveis)
  useEffect(() => {
    if (hookedAddress) setAddress(hookedAddress);
    setIsConnected(Boolean(hookedIsConnected));
  }, [hookedAddress, hookedIsConnected]);

  const short = useMemo(
    () => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""),
    [address]
  );

  async function refreshFromProvider() {
    try {
      const prov = await getActiveWalletProvider();
      if (!prov) {
        setIsConnected(false);
        setAddress("");
        return;
      }
      const accounts = await prov.request({ method: "eth_accounts" }).catch(() => []);
      const next = Array.isArray(accounts) && accounts.length > 0 ? String(accounts[0]) : "";
      setAddress(next);
      setIsConnected(!!next);
    } catch {
      setIsConnected(false);
      setAddress("");
    }
  }

  // Eventos EIP-1193 do provider ativo (opcional, mantém estado em sync mesmo sem os hooks)
  useEffect(() => {
    let detach = () => {};
    (async () => {
      try {
        const prov = await getActiveWalletProvider();
        if (!prov || typeof prov.on !== "function") return;

        const onAccounts = (accs) => {
          const next = Array.isArray(accs) && accs[0] ? String(accs[0]) : "";
          setAddress(next);
          setIsConnected(!!next);
        };
        const onChain = () => refreshFromProvider();
        const onDisconnect = () => { setIsConnected(false); setAddress(""); };

        prov.on("accountsChanged", onAccounts);
        prov.on("chainChanged", onChain);
        prov.on("disconnect", onDisconnect);

        detach = () => {
          const off = prov.removeListener || prov.off;
          off?.call(prov, "accountsChanged", onAccounts);
          off?.call(prov, "chainChanged", onChain);
          off?.call(prov, "disconnect", onDisconnect);
        };
      } finally {
        await refreshFromProvider();
      }
    })();

    return () => { try { detach?.(); } catch {} };
  }, []);

  async function onCopy() {
    try {
      if (!address) return;
      await navigator.clipboard.writeText(address);
      console.log("[Wallet] Address copied to clipboard");
    } catch (err) {
      console.error("[Wallet] Failed to copy address:", err);
    }
  }

  async function onConnect() {
    try {
      // ✅ Abre o modal oficial do AppKit
      open({ view: "Connect", namespace: "eip155" });
      // O hook useAppKitAccount refletirá o estado após a aprovação
    } catch (err) {
      console.error("[Wallet] Connect failed:", err);
    }
  }

  async function onDisconnect() {
    try {
      await disconnectWallet();
    } catch (err) {
      console.error("[Wallet] Disconnect failed:", err);
    } finally {
      setIsConnected(false);
      setAddress("");
    }
  }

  return (
    <div className={styles.row}>
      {isConnected ? (
        <div className={styles.rowSm}>
          <span className={styles.badge} title={address}>{short}</span>
          <button className={styles.ButtonIconClean} onClick={onCopy} title="Copy address">
            <FiCopy size={12} />
          </button>
          <button onClick={onDisconnect} title="Disconnect" className={`${styles.button} ${styles.buttonIcon}`}>
            <FiPower size={16} />
          </button>
        </div>
      ) : (
        <button className={`${styles.button} ${styles.buttonIcon}`} onClick={onConnect} title="Connect wallet">
          <FiPower size={16} />
        </button>
      )}
    </div>
  );
}
