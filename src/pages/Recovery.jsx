import React, { useCallback, useEffect, useState } from "react";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import Footer from "@/ui/layout/footer.jsx";
import * as vaultService from "@/services/vaultService";
import * as tokenService from "@/services/tokenService";
import { parseUnits, formatUnits } from "ethers";
import { useAppKitAccount } from "@reown/appkit/react";
import WalletConnection from "@/components/wallet/WalletConnection.jsx";
import { FiSun, FiMoon } from "react-icons/fi";

const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-");

function ReCAPTCHAMock({ value, onChange }) {
  return (
    <label className={styles.captchaLabel}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>I am not a robot (placeholder)</span>
    </label>
  );
}

function HeaderFrame({ roundInfo, isConnected, limitText, theme, onToggleTheme }) {
  return (
    <header className={styles.header}>
      <div className={styles.containerWide}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <img src="/logo.png" alt="Recovery Vault" className={styles.logoImg} />
          </div>
          <div className={styles.headerCenter}>
            <div className={styles.subtle}>Current Round</div>
            <div className={styles.roundNumber}>{roundInfo.loading ? "…" : roundInfo.round ?? "-"}</div>
            <div className={styles.statusLine}>
              <span className={`${styles.statusDot} ${roundInfo.statusText === "Locked" ? styles.statusLocked : styles.statusOpen}`} />
              <span>{roundInfo.statusText ?? "—"}</span>
            </div>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.headerRightInner}>
              <WalletConnection />
            </div>
            <div className={styles.headerRightInner}>  
              <button
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                title={theme === "dark" ? "Light mode" : "Dark mode"}
                onClick={onToggleTheme}
                className={`${styles.ButtonIconClean}`}>
                {theme === "dark" ? <FiSun size={16} /> : <FiMoon size={16} />}
              </button>

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

function RedeemForm() {
  const { provider, signer, account } = useContractContext();
  const [supportedAssets, setSupportedAssets] = useState([]);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [assetBalance, setAssetBalance] = useState("0");
  const [payout, setPayout] = useState("wONE");
  const [balanceWONE, setBalanceWONE] = useState("0");
  const [balanceUSDC, setBalanceUSDC] = useState("0");
  const [amount, setAmount] = useState("");
  const [eligible, setEligible] = useState(null);
  const [tierInfo, setTierInfo] = useState({ tier: "-", feeRate: 0 });
  const [captchaOk, setCaptchaOk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await vaultService.getSupportedAssets?.(provider);
        if (!alive) return;
        const mapped = (list || []).map((t) => ({ address: t.address, symbol: t.symbol, decimals: Number(t.decimals ?? 18), logoURI: t.logoURI }));
        setSupportedAssets(mapped);
        setSelectedAsset(mapped[0] || null);
      } catch {
        setSupportedAssets([]);
      }
    })();
    return () => { alive = false; };
  }, [provider]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (account && selectedAsset) {
          const bal = await tokenService.getBalance?.(account, selectedAsset.address, provider);
          if (alive) setAssetBalance(bal ?? "0");
        } else if (alive) {
          setAssetBalance("0");
        }
        if (account) {
          const [bw, bu] = await Promise.all([
            tokenService.getBalance?.(account, tokenService.tokens?.wONE, provider),
            tokenService.getBalance?.(account, tokenService.tokens?.USDC, provider)
          ]);
          if (alive) {
            setBalanceWONE(bw ?? "0");
            setBalanceUSDC(bu ?? "0");
          }
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [account, provider, selectedAsset]);

  const checkEligibility = useCallback(async () => {
    if (!account) return;
    try {
      setError("");
      const isOk = await vaultService.isAuthorized?.(account, provider);
      setEligible(Boolean(isOk));
    } catch {
      setEligible(false);
      setError("Eligibility check failed. Please try again.");
    }
  }, [account, provider]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!selectedAsset || !amount) {
          if (alive) setTierInfo({ tier: "-", feeRate: 0 });
          return;
        }
        const decimals = selectedAsset.decimals || 18;
        const amountWei = parseUnits(amount || "0", decimals);
        const info = await vaultService.getFeeInfo?.({ amount: amountWei, provider });
        if (alive) setTierInfo({ tier: info?.tier ?? "-", feeRate: Number(info?.feeRate ?? 0) });
      } catch {
        if (alive) setTierInfo({ tier: "-", feeRate: 0 });
      }
    })();
    return () => { alive = false; };
  }, [amount, selectedAsset, provider]);

  const onMax = useCallback(() => {
    if (!selectedAsset) return;
    try {
      const decimals = selectedAsset.decimals || 18;
      const formatted = formatUnits(BigInt(assetBalance || 0), decimals);
      setAmount(formatted);
    } catch {}
  }, [assetBalance, selectedAsset]);

  const submitRedeem = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      setTxHash("");
      if (!provider || !signer || !account) throw new Error("Wallet not connected");
      if (!selectedAsset) throw new Error("Select an asset to redeem");
      if (!amount) throw new Error("Enter an amount");
      if (!captchaOk) throw new Error("Please complete the CAPTCHA");
      if (eligible !== true) throw new Error("Wallet not eligible (Merkle whitelist)");
      const decimals = selectedAsset.decimals || 18;
      const amountWei = parseUnits(amount, decimals);
      const res = await vaultService.redeem?.({ signer, assetIn: selectedAsset.address, amount: amountWei, payoutToken: payout });
      if (res?.hash) setTxHash(res.hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [provider, signer, account, selectedAsset, amount, payout, captchaOk, eligible]);

  return (
    <div className={styles.grid1}>
      {error && <Alert type="error">{error}</Alert>}
      {txHash && <Alert type="success">Redeem submitted. Tx Hash: <code>{txHash}</code></Alert>}
      <section className={styles.card}>
        <h3 className={styles.h3}>Eligibility</h3>
        <p className={styles.pMuted}>Check if your wallet is in the pre-hacked whitelist (Merkle proof).</p>
        <div className={styles.rowSm}>
          <button className={styles.button} onClick={checkEligibility}>Check eligibility</button>
          <span>Status: {eligible === null ? "Unknown" : eligible ? "Eligible" : "Not eligible"}</span>
        </div>
      </section>
      <section className={styles.card}>
        <h3 className={styles.h3}>Redeem</h3>
        <div className={styles.grid2}>
          <div className={styles.stack}>
            <label className={styles.field}>
              <span>Asset to burn</span>
              <select className={styles.select} value={selectedAsset?.address || ""} onChange={(e) => {
                const t = supportedAssets.find((x) => x.address === e.target.value) || null;
                setSelectedAsset(t);
              }}>
                {supportedAssets.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </select>
              <small className={styles.smallMuted}>Balance: {selectedAsset ? formatUnits(BigInt(assetBalance || 0), selectedAsset.decimals) : "0"}</small>
            </label>
            <label className={styles.field}>
              <span>Amount</span>
              <div className={styles.rowSm}>
                <input className={`${styles.input} ${styles.flex1}`} type="number" inputMode="decimal" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
                <button className={styles.button} type="button" onClick={onMax}>MAX</button>
              </div>
            </label>
            <div className={styles.stack}>
              <span>Payout</span>
              <div className={styles.rowSm}>
                <button type="button" className={`${styles.button} ${payout === "wONE" ? styles.buttonActive : ""}`} onClick={() => setPayout("wONE")}>
                  wONE ({formatUnits(BigInt(balanceWONE || 0), 18)})
                </button>
                <button type="button" className={`${styles.button} ${payout === "USDC" ? styles.buttonActive : ""}`} onClick={() => setPayout("USDC")}>
                  USDC ({formatUnits(BigInt(balanceUSDC || 0), 6)})
                </button>
              </div>
            </div>
          </div>
          <div className={styles.stack}>
            <div className={styles.stack}>
              <span>Tier & Fee</span>
              <div className={styles.rowSm}>
                <div>
                  <small className={styles.smallMuted}>Tier</small>
                  <div><strong>{tierInfo.tier}</strong></div>
                </div>
                <div>
                  <small className={styles.smallMuted}>Fee Rate</small>
                  <div><strong>{tierInfo.feeRate}%</strong></div>
                </div>
              </div>
            </div>
            <div className={styles.stack}>
              <span>Bot Protection</span>
              <ReCAPTCHAMock value={captchaOk} onChange={setCaptchaOk} />
            </div>
            <div>
              <button className={`${styles.button} ${styles.buttonBlock} ${styles.buttonAccent}`} disabled={loading} onClick={submitRedeem}>
                {loading ? "Processing…" : "Redeem"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Recovery() {
  const { provider, account } = useContractContext();
  const appkitAccount = useAppKitAccount ? useAppKitAccount() : undefined;
  const [roundInfo, setRoundInfo] = useState({ loading: true, round: null, statusText: "Loading" });
  const [userInfo, setUserInfo] = useState({ connected: false, address: "", limitText: "-" });
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");

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

  const onToggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <div className={styles.page}>
      <HeaderFrame roundInfo={roundInfo} isConnected={userInfo.connected} limitText={userInfo.limitText} theme={theme} onToggleTheme={onToggleTheme} />
      <ContentFrame>
        <RedeemForm />
      </ContentFrame>
      <Footer className={styles.footer} />
    </div>
  );
}
