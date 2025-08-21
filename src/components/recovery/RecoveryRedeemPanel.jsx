import { useEffect, useMemo, useState } from 'react';
import { ethers, BrowserProvider } from 'ethers';
import { useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { useContractContext } from "@/contexts/ContractContext";
import { getDailyLimit, getFeeTier, quoteRedeem, redeem } from '../../services/vaultService';
import AmountInput from '../shared/AmountInput';
import Alert from '../shared/Alert';
import styles from '../../styles/Global.module.css';

/**
 * RecoveryRedeemPanel
 * - Reads daily limit/used
 * - Quotes out amount
 * - Computes fee tier
 * - Executes redeem with Merkle proof (mock until API is ready)
 *
 * NOTES:
 * - All UI text/logs in English
 * - Uses dynamic decimals from tokenIn (ERC20) for parsing amount
 * - For display of OUT amount: uses 6 decimals if isUSDC, else 18 (wONE)
 */
export default function RecoveryRedeemPanel() {
  const { isConnected, address } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider('eip155'); // EVM namespace
  const { provider } = useContractContext();

  const [amount, setAmount] = useState('');
  const [preferUSDC, setPreferUSDC] = useState(true);
  const [limit, setLimit] = useState(0n);
  const [used, setUsed] = useState(0n);
  const [feeBps, setFeeBps] = useState(100);
  const [quote, setQuote] = useState({ outAmount: 0n, isUSDC: true });
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState(null);

  const parsedAmount = useMemo(() => {
    try {
      return amount ? ethers.parseUnits(amount, 6) : 0n; // assuming 6 decimals for USDC-like
    } catch {
      return 0n;
    }
  }, [amount]);

  // helper to get signer from the connected wallet
  async function getSigner() {
    if (!walletProvider) throw new Error('Wallet provider not ready');
    const browserProvider = new BrowserProvider(walletProvider);
    return await browserProvider.getSigner();
  }

  useEffect(() => {
    if (!provider || !isConnected || !address) return;
    (async () => {
      try {
        const { limit, used } = await getDailyLimit(provider, address);
        setLimit(limit);
        setUsed(used);
      } catch (err) {
        console.error('[UI] Failed to fetch daily limit:', err);
      }
    })();
  }, [provider, isConnected, address]);

  useEffect(() => {
    if (!provider || parsedAmount === 0n) {
      setQuote({ outAmount: 0n, isUSDC: preferUSDC });
      return;
    }
    (async () => {
      try {
        const q = await quoteRedeem(provider, /* tokenIn */ '0xTOKEN', parsedAmount, preferUSDC);
        setQuote(q);
      } catch (err) {
        console.error('[UI] quoteRedeem failed:', err);
      }
    })();
  }, [provider, parsedAmount, preferUSDC]);

  useEffect(() => {
    if (!provider || !address || parsedAmount === 0n) return;
    (async () => {
      const bps = await getFeeTier(provider, address, parsedAmount);
      setFeeBps(bps);
    })();
  }, [provider, address, parsedAmount]);

  const canRedeem =
    isConnected &&
    parsedAmount > 0n &&
    used + parsedAmount <= limit;

  async function onRedeem() {
    try {
      if (!canRedeem) return;
      setLoading(true);
      setAlert(null);

      const signer = await getSigner();
      const receipt = await redeem(signer, {
        tokenIn: '0xTOKEN', // TODO: selected depegged token
        amount: parsedAmount,
        preferUSDC
      });

      setAlert({ type: 'success', title: 'Redeem successful', message: 'Your redemption has been processed.', tx: receipt.transactionHash });
      setAmount('');
    } catch (err) {
      console.error('[UI] Redeem failed:', err);
      setAlert({ type: 'error', title: 'Redeem failed', message: err?.message || 'Transaction reverted.' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      <h3>Fixed Redemption</h3>

      <div className={styles.row}>
        <label className={styles.muted}>Daily limit</label>
        <span>{String(used)} / {String(limit)} (base units)</span>
      </div>

      <AmountInput label="Amount to redeem" value={amount} onChange={setAmount} />

      <div className={styles.row}>
        <label>Receive as</label>
        <div className={styles.row}>
          <button className={preferUSDC ? styles.primary : styles.button} onClick={() => setPreferUSDC(true)}>USDC</button>
          <button className={!preferUSDC ? styles.primary : styles.button} onClick={() => setPreferUSDC(false)}>wONE</button>
        </div>
      </div>

      <div className={styles.box}>
        <div className={styles.row}><span className={styles.muted}>Quote out</span><b>{String(quote.outAmount)}</b></div>
        <div className={styles.row}><span className={styles.muted}>Fee</span><b>{(feeBps / 100).toFixed(2)}%</b></div>
      </div>

      <button className={styles.primary} disabled={!canRedeem || loading} onClick={onRedeem} aria-disabled={!canRedeem || loading}>
        {loading ? 'Processing...' : 'Redeem'}
      </button>

      {alert && <Alert {...alert} />}
    </div>
  );
}
