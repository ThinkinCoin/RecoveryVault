import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import Footer from "@/ui/layout/footer";
import * as vaultService from "@/services/vaultService";
import { formatUnits } from "ethers";
import { useAppKitAccount } from "@reown/appkit/react";
import WalletConnection from "@/components/wallet/WalletConnection";
import WalletChecker from "@/components/wallet/WalletChecker";
import RedeemForm from "@/components/redeem/RedeemForm";
import ContractFunds from "@/components/shared/ContractFunds";
import StatusRound from "@/components/shared/StatusRound";

const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-");

function HeaderFrame({ address }) {
  return (
    <header className={styles.header}>
      <div className={styles.containerWide}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <img src="/logo.png" alt="Recovery Vault" className={styles.logoImg} />
          </div>
          <div className={styles.headerCenter}></div>
          <div className={styles.headerRight}>
            <div className={styles.headerRightInner}>
              <WalletConnection />
            </div>
            <div className={styles.headerRightInner}>
              <div className="walletLimit">
                {/*<LimitChecker address={address} />*/}
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
  const cls = `${styles.alert} ${
    type === "error" ? styles.error : type === "success" ? styles.success : type === "warning" ? styles.warning : styles.info
  }`;
  return (
    <div role="alert" className={cls}>
      {children}
    </div>
  );
}

export default function Recovery() {
  const { provider, account } = useContractContext();
  const appkitAccount = useAppKitAccount ? useAppKitAccount() : undefined;

  const readProvider = useMemo(() => provider || vaultService.getDefaultProvider?.() || null, [provider]);

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

  // Load vault round/status info using available service methods
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) throw new Error("no provider");
        const info = await vaultService.getRoundInfo(readProvider);
        if (!alive) return;
        const statusText = info.paused ? "Locked" : info.isActive ? "Open" : "Inactive";
        const roundLabel = String(info.roundId ?? 0n);
        setRoundInfo({ loading: false, round: roundLabel, statusText });
      } catch {
        if (alive) setRoundInfo({ loading: false, round: "-", statusText: "Unknown" });
      }
    })();
    return () => { alive = false; };
  }, [readProvider]);

  // Load per-user remaining limit (uses getUserLimit from service)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const addr = account || (appkitAccount && appkitAccount.address);
        if (!addr || !readProvider) {
          if (alive) setUserInfo({ connected: false, address: "", limitText: "-" });
          return;
        }
        const { remainingUSD } = await vaultService.getUserLimit(readProvider, addr);
        const limitText = `${remainingUSD?.toString?.() ?? "0"} USD`;
        if (alive) setUserInfo({ connected: true, address: addr, limitText });
      } catch {
        if (alive) setUserInfo({ connected: Boolean(account), address: account || "", limitText: "-" });
      }
    })();
    return () => { alive = false; };
  }, [account, readProvider, appkitAccount?.address]);

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
      <HeaderFrame
        roundInfo={roundInfo}
        isConnected={userInfo.connected}
        limitText={userInfo.limitText}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
      <ContentFrame>
        <section className={`${styles.grid3}`}>
          <WalletChecker address={userInfo.address || account} onResult={handleEligibility} proofsUrl={PROOFS_URL} />
          <ContractFunds />
          <StatusRound />
        </section>

        {/* ReddemForm */}
        <section className={`${styles.grid3} `}>
          <div></div>
          <RedeemForm address={userInfo.address || account} eligible={eligible} proof={proof} />
          <div></div>
        </section>
      </ContentFrame>
      <Footer className={styles.footer} />
    </div>
  );
}
