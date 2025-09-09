import React, { useMemo } from "react";
import styles from "../../styles/Global.module.css";
import { FiCopy, FiPower } from "react-icons/fi";

// Use the ContractContext instead of calling useAppKit() directly.
// This avoids crashes when createAppKit() hasn't run (SSR/misconfig)
// and centralizes provider/events/debounce logic in one place.
import { useContractContext } from "@/contexts/ContractContext";

export default function WalletConnection() {
  const { account, connect, disconnect } = useContractContext();
  const address = account || "";
  const isConnected = Boolean(account);

  const short = useMemo(
    () => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""),
    [address]
  );

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
      const res = await connect?.();
      if (res && res.ok === false) console.warn("[Wallet] Connect warning:", res.error);
    } catch (err) {
      console.error("[Wallet] Connect failed:", err);
    }
  }

  async function onDisconnect() {
    try {
      const res = await disconnect?.();
      if (res && res.ok === false) console.warn("[Wallet] Disconnect warning:", res.error);
    } catch (err) {
      console.error("[Wallet] Disconnect failed:", err);
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
