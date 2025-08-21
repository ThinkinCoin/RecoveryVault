import { useMemo } from 'react';
import { useAppKit, useDisconnect, useAppKitAccount } from '@reown/appkit/react';
import styles from '../../styles/Global.module.css';
import { FiCopy, FiPower } from "react-icons/fi";
/**
 * WalletConnection
 * - Connect/Disconnect wallet using Reown AppKit
 * - Shows short address and a copy-to-clipboard action
 * - English-only texts/logs (project standard)
 */

export default function WalletConnection() {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { isConnected, address } = useAppKitAccount();

  const short = useMemo(() => (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''), [address]);

  async function onCopy() {
    try {
      if (!address) return;
      await navigator.clipboard.writeText(address);
      console.log('[Wallet] Address copied to clipboard');
    } catch (err) {
      console.error('[Wallet] Failed to copy address:', err);
    }
  }

  return (
    
      <div className={styles.row}>

        {isConnected ? (
          <div className={styles.rowSm}>
            <span className={styles.badge} title={address}>{short}</span>
            <button className={styles.ButtonIconClean} onClick={onCopy}><FiCopy size={12} /></button>
            <button onClick={() => disconnect()} className={`${styles.button} ${styles.buttonIcon}`}> <FiPower size={16} /> </button>
          </div>
        ) : (
          <button className={`${styles.button} ${styles.buttonIcon} `} onClick={() => open({ view: 'Connect' })}><FiPower size={16} /></button>
        )}
      </div>
    
  );
}

