import { useMemo } from 'react';
import { useAppKit, useDisconnect, useAppKitAccount } from '@reown/appkit/react';
import styles from '../../styles/Global.module.css';
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
          <div className={styles.row}>
            <span className={styles.badge} title={address}>{short}</span>
            <button className={styles.button} onClick={onCopy}>Copy</button>
            <button className={styles.button} onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <button className={styles.primary} onClick={() => open({ view: 'Connect' })}>Connect Wallet</button>
        )}
      </div>
    
  );
}

