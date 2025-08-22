import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import Footer from "@/ui/layout/footer.jsx";
import * as vaultService from "@/services/vaultService";
import { formatUnits } from "ethers";
import { useAppKitAccount } from "@reown/appkit/react";
import WalletConnection from "@/components/wallet/WalletConnection.jsx";
import WalletChecker from "@/components/wallet/WalletChecker";
import RedeemForm from "@/components/redeem/RedeemForm";
import ContractFunds from "@/components/shared/ContractFunds";
import StatusRound from "@/components/shared/StatusRound.jsx";




const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-");

function ReCAPTCHAMock({ value, onChange }) {
  return (
    <label className={styles.captchaLabel}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>I am not a robot (placeholder)</span>
    </label>
  );
}

function HeaderFrame({ roundInfo, isConnected, limitText}) {
  return (
    <header className={styles.header}>
      <div className={styles.containerWide}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <img src="/logo.png" alt="Recovery Vault" className={styles.logoImg} />
          </div>
          <div className={styles.headerCenter}>
       
          </div>
          <div className={styles.headerRight}>
            <div className={styles.headerRightInner}>
              <WalletConnection />
            </div>
            <div className={styles.headerRightInner}>  
              <div className="walletLimit">
                {isConnected ? (
                <span className={`${styles.badgeWalletLimit}`}>Available limit: <strong>{limitText ?? "$"}</strong></span>
              ) : null}
              </div>
            </div>

          </div>
        </div>
      </div>
    </header>
  );
}

function ContentFrame({ children }) {
  return (
    <main className={styles.content}>
      <div className={styles.containerWide}>{children}</div>
    </main>
  );
}

function Alert({ type = "info", children }) {
  const cls = `${styles.alert} ${type === "error" ? styles.error : type === "success" ? styles.success : type === "warning" ? styles.warning : styles.info}`;
  return <div role="alert" className={cls}>{children}</div>;
}

export default function Recovery() {
  const { provider, account } = useContractContext();
  const appkitAccount = useAppKitAccount ? useAppKitAccount() : undefined;
  const [roundInfo, setRoundInfo] = useState({ loading: true, round: null, statusText: "Loading" });
  const [userInfo, setUserInfo] = useState({ connected: false, address: "", limitText: "-" });
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const [eligible, setEligible] = useState(null);
  const [proof, setProof] = useState(null);

  // Stable URL to avoid re-fetch loops (cache bust via env version)
  const PROOFS_URL = useMemo(
    () => `/data/proofs.json?v=${import.meta.env.VITE_PROOFS_VERSION || "1.0.0"}`,
    []
  );

  // Stable callback to avoid re-renders/loops in WalletChecker
  const handleEligibility = useCallback(({ eligible, proof }) => {
    setEligible(eligible);
    setProof(proof || null);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [round, locked] = await Promise.all([
          vaultService.getCurrentRound?.(provider),
          vaultService.isLocked?.(provider)
        ]);
        if (!alive) return;
        setRoundInfo({ loading: false, round: round ?? "-", statusText: locked ? "Locked" : "Open" });
      } catch {
        if (alive) setRoundInfo({ loading: false, round: "-", statusText: "Unknown" });
      }
    })();
    return () => { alive = false; };
  }, [provider]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const addr = account || (appkitAccount && appkitAccount.address);
        if (!addr) {
          if (alive) setUserInfo({ connected: false, address: "", limitText: "-" });
          return;
        }
        const limitWei = await vaultService.getLimit?.(addr, provider);
        const limitText = limitWei != null ? `${formatUnits(BigInt(limitWei), 18)} ONE` : "-";
        if (alive) setUserInfo({ connected: true, address: addr, limitText });
      } catch {
        if (alive) setUserInfo({ connected: Boolean(account), address: account || "", limitText: "-" });
      }
    })();
    return () => { alive = false; };
  }, [account, provider, appkitAccount?.address]);

  // Reset eligibility when account changes
  useEffect(() => {
    setEligible(null);
    setProof(null);
  }, [account]);

  const onToggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <div className={styles.page}>
      <HeaderFrame roundInfo={roundInfo} isConnected={userInfo.connected} limitText={userInfo.limitText} theme={theme} onToggleTheme={onToggleTheme} />
      <ContentFrame>

        {/* wallet checker */}
        <section className={styles.grid3}>
          <WalletChecker
            address={userInfo.address || account}
            onResult={handleEligibility}
            proofsUrl={PROOFS_URL}
          />
          <ContractFunds />
          <StatusRound />
        </section>

        {/* ReddemForm */}
        <section className={`${styles.grid1} ${styles.gridInner}`}>
        <RedeemForm 
          address={userInfo.address || account}
          eligible={eligible}
          proof={proof} 
        />
        </section>
      </ContentFrame>
      <Footer className={styles.footer} />
    </div>
  );
}
