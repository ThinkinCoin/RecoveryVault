import WalletConnection from "../components/wallet/WalletConnection";
import RecoveryRedeemPanel from "../components/recovery/RecoveryRedeemPanel";
import { useContractContext } from "@/contexts/ContractContext";
import { useOnePrice } from "@/hooks/useOnePrice";
import styles from "../styles/Global.module.css";
import ThemeToggle from "@/components/shared/ThemeToggle";


/**
 * Recovery Page
 * - Top-level page that composes WalletConnection and RecoveryRedeemPanel
 * - Displays optional ONE price (if oracle is configured)
 * - All UI texts/logs in English (project standard)
 */
export default function Recovery() {
  const projectName = import.meta.env.VITE_PROJECT_NAME || "Recovery Vault";
  const { provider } = useContractContext() ?? {};
  const onePrice = useOnePrice(provider);

  return (
    <div className={styles.container}>
      <div className={styles.card} role="region" aria-label="Recovery overview">
        <div className={styles.row}>
          <h2>{projectName}</h2>
          <ThemeToggle />
        </div>

        <p className={styles.muted}>Fixed redemption UI for pre-hack wallets on Harmony.</p>
        {typeof onePrice === "number" && (
          <div className={styles.row}>
            <span className={styles.muted}>ONE Price (USD)</span>
            <b>${onePrice.toFixed(4)}</b>
          </div>
        )}
      </div>

      <WalletConnection />

      <RecoveryRedeemPanel />
    </div>
  );
}
