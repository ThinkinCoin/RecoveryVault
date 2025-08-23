import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import Footer from "@/ui/layout/footer";
import WalletConnection from "@/components/wallet/WalletConnection";
import { useAppKitAccount } from "@reown/appkit/react";
import * as vaultService from "@/services/vaultService";
import { ethers } from "ethers";

// --- Helpers ---
const cls = (...cx) => cx.filter(Boolean).join(" ");
const toLower = (x) => (x || "").toString().toLowerCase();
const isAddr = (a) => ethers.isAddress(a || "");
const isBytes32 = (h) => ethers.isHexString((h || "").trim(), 32);

function AdminAlert({ type = "info", children }) {
  const map = { info: styles.info, success: styles.success, warning: styles.warning, error: styles.error };
  return (<div role="alert" className={cls(styles.alert, map[type] || styles.info)}>{children}</div>);
}

function Section({ title, children, right }) {
  return (
    <section className={styles.card} style={{ padding: 16 }}>
      <div className={styles.contractFundsHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>{title}</h3>
        <div>{right}</div>
      </div>
      <div className={styles.stack}>{children}</div>
    </section>
  );
}

function HeaderFrame() {
  return (
    <header className={styles.header}>
      <div className={styles.containerWide}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <img src="/logo.png" alt="Recovery Vault" className={styles.logoImg} />
            <div>
              <div className={styles.brandText} style={{ fontWeight: 700 }}>RecoveryVault</div>
              <div className={styles.smallMuted}>Admin Dashboard</div>
            </div>
          </div>
          <div className={styles.headerCenter} />
          <div className={styles.headerRight}>
            <div className={styles.headerRightInner}><WalletConnection /></div>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function AdminDash() {
  const { provider: ctxProvider, account: ctxAccount } = useContractContext();
  const appkitAccount = useAppKitAccount ? useAppKitAccount() : undefined;

  const [owner, setOwner] = useState("");
  const [account, setAccount] = useState("");
  const [isOwner, setIsOwner] = useState(false);
  const [loadingOwner, setLoadingOwner] = useState(true);
  const [roundInfo, setRoundInfo] = useState({ roundId: 0n, startTime: 0n, isActive: false, paused: false, limitUsd: 0n });

  // Contract data / env
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");
  const [woneDec, setWoneDec] = useState(18);
  const [usdcDec, setUsdcDec] = useState(6);
  const [balances, setBalances] = useState({ w: 0n, u: 0n });

  // Supported tokens
  const [supportedTokens, setSupportedTokens] = useState([]); // list of addresses
  const [tokenSel, setTokenSel] = useState("");
  const [tokenAllowed, setTokenAllowed] = useState(true);
  const [tokenInput, setTokenInput] = useState("");

  // Wallets / oracle / merkle
  const [devWallet, setDevWallet] = useState("");
  const [rmcWallet, setRmcWallet] = useState("");
  const [oracleAddr, setOracleAddr] = useState("");
  const [merkleRoot, setMerkleRoot] = useState("");

  // Fee tiers
  const [feeThresholds, setFeeThresholds] = useState(["100000", "250000", "1000000"]);
  const [feeBps, setFeeBps] = useState(["100", "50", "25", "10"]);

  // Forms state (basic)
  const [dailyLimit, setDailyLimit] = useState("");
  const [locked, setLocked] = useState(false);
  const [roundId, setRoundId] = useState("");

  // Tx states
  const [busy, setBusy] = useState({ daily: false, lock: false, round: false, dev: false, rmc: false, oracle: false, merkle: false, token: false, fee: false, wd: false });
  const [notice, setNotice] = useState(null); // {type, msg}

  const provider = useMemo(() => ctxProvider || vaultService.getDefaultProvider?.() || null, [ctxProvider]);

  // Resolve connected account (context or appkit)
  useEffect(() => { setAccount(ctxAccount || appkitAccount?.address || ""); }, [ctxAccount, appkitAccount?.address]);

  const fetchDecimals = useCallback(async (addr) => {
    if (!addr || !provider) return 18;
    try {
      const erc = new ethers.Contract(addr, ["function decimals() view returns (uint8)"], provider);
      const d = await erc.decimals();
      return Number(d || 18);
    } catch { return 18; }
  }, [provider]);

  // Load owner and main info
  const loadBasics = useCallback(async () => {
    if (!provider) return;
    setLoadingOwner(true);
    try {
      const c = vaultService.getVaultContract(provider);
      const [ownerAddr, gi, wAddr, uAddr, sup, fee, dv, rv, orc, mrk, bal] = await Promise.all([
        c.owner(),
        (async () => { try { return await c.getRoundInfo(); } catch { return null; } })(),
        (async () => { try { return await c.wONE(); } catch { return ethers.ZeroAddress; } })(),
        (async () => { try { return await c.usdc(); } catch { return ethers.ZeroAddress; } })(),
        (async () => { try { return await c.getSupportedTokens(); } catch { return []; } })(),
        (async () => { try { return await c.getFeeTiers(); } catch { return null; } })(),
        (async () => { try { return await c.devWallet(); } catch { return ""; } })(),
        (async () => { try { return await c.rmcWallet(); } catch { return ""; } })(),
        (async () => { try { return await c.oracle(); } catch { return ""; } })(),
        (async () => { try { return await c.merkleRoot(); } catch { return ""; } })(),
        (async () => { try { return await c.getVaultBalances(); } catch { return [0n,0n]; } })(),
      ]);

      setOwner(ownerAddr);
      setIsOwner(toLower(ownerAddr) === toLower(account));

      if (gi) {
        const [rid, startTime, isActive, paused, limitUsd] = gi;
        setRoundInfo({ roundId: rid ?? 0n, startTime: startTime ?? 0n, isActive: Boolean(isActive), paused: Boolean(paused), limitUsd: limitUsd ?? 0n });
        setLocked(Boolean(paused));
      }

      setWone(wAddr); setUsdc(uAddr);
      const [dW, dU] = await Promise.all([fetchDecimals(wAddr), fetchDecimals(uAddr)]);
      setWoneDec(dW); setUsdcDec(dU);

      setSupportedTokens(Array.isArray(sup) ? sup : []);
      setTokenSel((prev) => prev || (Array.isArray(sup) && sup[0]) || "");
      setDevWallet(dv || "");
      setRmcWallet(rv || "");
      setOracleAddr(orc || "");
      setMerkleRoot(mrk || "");

      if (fee && Array.isArray(fee[0]) && Array.isArray(fee[1])) {
        setFeeThresholds(fee[0].map((x) => String(x)));
        setFeeBps(fee[1].map((x) => String(x)));
      }

      setBalances({ w: bal?.[0] ?? 0n, u: bal?.[1] ?? 0n });

      // preload allowed for selected token
      try { if (sup?.length) { const allowed = await c.supportedToken(sup[0]); setTokenAllowed(Boolean(allowed)); } } catch {}
    } catch (err) {
      console.error("[AdminDash] loadBasics error:", err);
      setNotice({ type: "error", msg: "Failed to load owner or round info." });
    } finally { setLoadingOwner(false); }
  }, [provider, account, fetchDecimals]);

  useEffect(() => { loadBasics(); }, [loadBasics]);

  // Refresh token allowed when selection changes
  useEffect(() => {
    (async () => {
      if (!provider || !tokenSel) return;
      try { const c = vaultService.getVaultContract(provider); const allowed = await c.supportedToken(tokenSel); setTokenAllowed(Boolean(allowed)); }
      catch {}
    })();
  }, [provider, tokenSel]);

  const requireOwnerAndSigner = useCallback(async () => {
    if (!provider) throw new Error("Provider not available");
    const signer = provider.getSigner ? await provider.getSigner() : null;
    if (!signer) throw new Error("Connect a wallet to proceed");
    const signerAddr = await signer.getAddress();
    if (toLower(signerAddr) !== toLower(owner)) throw new Error("Only the owner can perform this action");
    return { signer };
  }, [provider, owner]);

  // --- Basic actions ---
  const onSetDailyLimit = useCallback(async () => {
    setBusy((b) => ({ ...b, daily: true })); setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const parsed = Math.floor(Number(String(dailyLimit).replace(/,/g, ".")));
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid amount");
      const tx = typeof vaultService.setDailyLimit === "function" ? await vaultService.setDailyLimit(parsed, signer) : await vaultService.getVaultContract(signer).setDailyLimit(parsed);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Daily limit updated. Tx: ${rc.hash}` }); setDailyLimit(""); await loadBasics();
    } catch (err) { console.error("[AdminDash] setDailyLimit error:", err); setNotice({ type: "error", msg: err?.message || "Failed to set daily limit" }); }
    finally { setBusy((b) => ({ ...b, daily: false })); }
  }, [dailyLimit, requireOwnerAndSigner, loadBasics]);

  const onToggleLocked = useCallback(async () => {
    setBusy((b) => ({ ...b, lock: true })); setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setLocked === "function" ? await vaultService.setLocked(!locked, signer) : await vaultService.getVaultContract(signer).setLocked(!locked);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Lock status updated. Tx: ${rc.hash}` }); setLocked((v) => !v); await loadBasics();
    } catch (err) { console.error("[AdminDash] setLocked error:", err); setNotice({ type: "error", msg: err?.message || "Failed to update lock status" }); }
    finally { setBusy((b) => ({ ...b, lock: false })); }
  }, [locked, requireOwnerAndSigner, loadBasics]);

  const onStartNewRound = useCallback(async () => {
    setBusy((b) => ({ ...b, round: true })); setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const parsed = BigInt(Math.floor(Number(String(roundId).replace(/,/g, ""))));
      if (parsed <= 0n) throw new Error("Invalid round id");
      const tx = typeof vaultService.startNewRound === "function" ? await vaultService.startNewRound(parsed, signer) : await vaultService.getVaultContract(signer).startNewRound(parsed);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `New round scheduled. Tx: ${rc.hash}` }); setRoundId(""); await loadBasics();
    } catch (err) { console.error("[AdminDash] startNewRound error:", err); setNotice({ type: "error", msg: err?.message || "Failed to start new round" }); }
    finally { setBusy((b) => ({ ...b, round: false })); }
  }, [roundId, requireOwnerAndSigner, loadBasics]);

  // --- Advanced actions ---
  const onSetDevWallet = useCallback(async () => {
    setBusy((b) => ({ ...b, dev: true })); setNotice(null);
    try {
      if (!isAddr(devWallet)) throw new Error("Invalid dev wallet address");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setDevWallet === "function" ? await vaultService.setDevWallet(devWallet, signer) : await vaultService.getVaultContract(signer).setDevWallet(devWallet);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Dev wallet updated. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] setDevWallet error:", err); setNotice({ type: "error", msg: err?.message || "Failed to set dev wallet" }); }
    finally { setBusy((b) => ({ ...b, dev: false })); }
  }, [devWallet, requireOwnerAndSigner, loadBasics]);

  const onSetRmcWallet = useCallback(async () => {
    setBusy((b) => ({ ...b, rmc: true })); setNotice(null);
    try {
      if (!isAddr(rmcWallet)) throw new Error("Invalid RMC wallet address");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setRmcWallet === "function" ? await vaultService.setRmcWallet(rmcWallet, signer) : await vaultService.getVaultContract(signer).setRmcWallet(rmcWallet);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `RMC wallet updated. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] setRmcWallet error:", err); setNotice({ type: "error", msg: err?.message || "Failed to set RMC wallet" }); }
    finally { setBusy((b) => ({ ...b, rmc: false })); }
  }, [rmcWallet, requireOwnerAndSigner, loadBasics]);

  const onSetOracle = useCallback(async () => {
    setBusy((b) => ({ ...b, oracle: true })); setNotice(null);
    try {
      if (!isAddr(oracleAddr)) throw new Error("Invalid oracle address");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setOracle === "function" ? await vaultService.setOracle(oracleAddr, signer) : await vaultService.getVaultContract(signer).setOracle(oracleAddr);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Oracle updated. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] setOracle error:", err); setNotice({ type: "error", msg: err?.message || "Failed to set oracle" }); }
    finally { setBusy((b) => ({ ...b, oracle: false })); }
  }, [oracleAddr, requireOwnerAndSigner, loadBasics]);

  const onSetMerkleRoot = useCallback(async () => {
    setBusy((b) => ({ ...b, merkle: true })); setNotice(null);
    try {
      if (!isBytes32(merkleRoot)) throw new Error("Invalid merkle root (bytes32 hex)");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setMerkleRoot === "function" ? await vaultService.setMerkleRoot(merkleRoot, signer) : await vaultService.getVaultContract(signer).setMerkleRoot(merkleRoot);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Merkle root updated. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] setMerkleRoot error:", err); setNotice({ type: "error", msg: err?.message || "Failed to set merkle root" }); }
    finally { setBusy((b) => ({ ...b, merkle: false })); }
  }, [merkleRoot, requireOwnerAndSigner, loadBasics]);

  const onUpdateSupportedToken = useCallback(async () => {
    setBusy((b) => ({ ...b, token: true })); setNotice(null);
    try {
      const target = tokenInput || tokenSel;
      if (!isAddr(target)) throw new Error("Invalid token address");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setSupportedToken === "function" ? await vaultService.setSupportedToken(target, tokenAllowed, signer) : await vaultService.getVaultContract(signer).setSupportedToken(target, tokenAllowed);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Supported token updated. Tx: ${rc.hash}` }); setTokenInput(""); await loadBasics();
    } catch (err) { console.error("[AdminDash] setSupportedToken error:", err); setNotice({ type: "error", msg: err?.message || "Failed to update supported token" }); }
    finally { setBusy((b) => ({ ...b, token: false })); }
  }, [tokenSel, tokenInput, tokenAllowed, requireOwnerAndSigner, loadBasics]);

  const onSaveFeeTiers = useCallback(async () => {
    setBusy((b) => ({ ...b, fee: true })); setNotice(null);
    try {
      const th = feeThresholds.map((s) => {
        const v = BigInt(String(s).trim() || "0");
        if (v < 0n) throw new Error("Invalid threshold value");
        return v;
      });
      const bps = feeBps.map((s) => {
        const v = Number(String(s).trim() || "0");
        if (!Number.isFinite(v) || v < 0 || v > 10000) throw new Error("Invalid BPS value");
        return v;
      });
      if (bps.length !== th.length + 1) throw new Error("BPS must be thresholds.length + 1");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.setFeeTiers === "function" ? await vaultService.setFeeTiers(th, bps, signer) : await vaultService.getVaultContract(signer).setFeeTiers(th, bps);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Fee tiers updated. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] setFeeTiers error:", err); setNotice({ type: "error", msg: err?.message || "Failed to update fee tiers" }); }
    finally { setBusy((b) => ({ ...b, fee: false })); }
  }, [feeThresholds, feeBps, requireOwnerAndSigner, loadBasics]);

  const onWithdrawFunds = useCallback(async () => {
    setBusy((b) => ({ ...b, wd: true })); setNotice(null);
    try {
      const token = tokenSel || wone || usdc;
      if (!isAddr(token)) throw new Error("Select a token");
      // Contract only allows wONE or USDC
      if (toLower(token) !== toLower(wone) && toLower(token) !== toLower(usdc)) throw new Error("Token not allowed");
      const { signer } = await requireOwnerAndSigner();
      const tx = typeof vaultService.withdrawFunds === "function" ? await vaultService.withdrawFunds(token, signer) : await vaultService.getVaultContract(signer).withdrawFunds(token);
      const rc = await tx.wait(); setNotice({ type: "success", msg: `Withdraw submitted. Tx: ${rc.hash}` }); await loadBasics();
    } catch (err) { console.error("[AdminDash] withdrawFunds error:", err); setNotice({ type: "error", msg: err?.message || "Failed to withdraw funds" }); }
    finally { setBusy((b) => ({ ...b, wd: false })); }
  }, [tokenSel, wone, usdc, requireOwnerAndSigner, loadBasics]);

  // --- UI helpers ---
  const notOwnerUI = !loadingOwner && !isOwner;
  const roundStartText = useMemo(() => { const ts = Number(roundInfo.startTime || 0n) * 1000; if (!ts) return "–"; try { return new Date(ts).toLocaleString(); } catch { return String(roundInfo.startTime); } }, [roundInfo.startTime]);
  const fmt = (n, d=0) => { try { return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); } catch { return String(n); } };

  const wBal = useMemo(() => { try { return ethers.formatUnits(balances.w || 0n, woneDec); } catch { return "0"; } }, [balances.w, woneDec]);
  const uBal = useMemo(() => { try { return ethers.formatUnits(balances.u || 0n, usdcDec); } catch { return "0"; } }, [balances.u, usdcDec]);

  return (
    <div className={styles.page}>
      <HeaderFrame />
      <main className={styles.content}>
        <div className={styles.containerWide}>

          {notice && <AdminAlert type={notice.type}>{notice.msg}</AdminAlert>}

          {loadingOwner ? (
            <AdminAlert type="info">Loading owner and round info…</AdminAlert>
          ) : notOwnerUI ? (
            <AdminAlert type="warning">
              This page is restricted to the contract owner.<br/>
              <span className={styles.smallMuted}>Connected: {account || "—"}</span><br/>
              <span className={styles.smallMuted}>Owner: {owner || "—"}</span>
            </AdminAlert>
          ) : null}

          {/* Round summary */}
          <section className={cls(styles.grid2, styles.gridInner)}>
            <div className={styles.card}>
              <div className={styles.stackSm}>
                <div className={styles.row}><strong>Round</strong></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>ID</span><span className={styles.contractFundsValue}>{String(roundInfo.roundId)}</span></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>Start</span><span className={styles.contractFundsSubValue}>{roundStartText}</span></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>Active</span><span className={styles.contractFundsSubValue}>{roundInfo.isActive ? "Yes" : "No"}</span></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>Locked</span><span className={styles.contractFundsSubValue}>{roundInfo.paused ? "Yes" : "No"}</span></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>Daily Limit (USD)</span><span className={styles.contractFundsValue}>{String(roundInfo.limitUsd)}</span></div>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.stackSm}>
                <div className={styles.row}><button type="button" className={styles.button} onClick={loadBasics}>Refresh</button></div>
                <div className={styles.smallMuted}>Owner: {owner || "—"}</div>
                <div className={styles.smallMuted}>Account: {account || "—"}</div>
                <div className={styles.smallMuted}>wONE: {wone || "—"}</div>
                <div className={styles.smallMuted}>USDC: {usdc || "—"}</div>
                <div className={styles.smallMuted}>Vault balances → wONE: {wBal} / USDC: {uBal}</div>
              </div>
            </div>
          </section>

          {/* Admin Controls */}
          <section className={cls(styles.grid3, styles.gridInner)}>
            {/* Daily Limit */}
            <Section title="Daily Limit (USD)" right={null}>
              <div className={styles.field}>
                <label className={styles.smallMuted}>New Limit (whole USD)</label>
                <input className={styles.input} type="number" min={0} inputMode="numeric" placeholder="e.g. 100" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} disabled={!isOwner || busy.daily} />
              </div>
              <div className={styles.row}>
                <button type="button" className={cls(styles.button, styles.buttonAccent)} onClick={onSetDailyLimit} disabled={!isOwner || busy.daily}>{busy.daily ? "Updating…" : "Set Daily Limit"}</button>
              </div>
            </Section>

            {/* Lock / Unlock */}
            <Section title="Lock Status" right={null}>
              <div className={styles.row}>
                <label className={styles.smallMuted} style={{ marginRight: 12 }}>Locked?</label>
                <input type="checkbox" checked={locked} onChange={() => {}} disabled />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onToggleLocked} disabled={!isOwner || busy.lock}>{busy.lock ? "Updating…" : locked ? "Unlock" : "Lock"}</button>
              </div>
            </Section>

            {/* Start New Round */}
            <Section title="Start New Round" right={null}>
              <div className={styles.field}>
                <label className={styles.smallMuted}>Round ID</label>
                <input className={styles.input} type="number" min={0} inputMode="numeric" placeholder="e.g. 2" value={roundId} onChange={(e) => setRoundId(e.target.value)} disabled={!isOwner || busy.round} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onStartNewRound} disabled={!isOwner || busy.round}>{busy.round ? "Scheduling…" : "Start New Round"}</button>
              </div>
            </Section>
          </section>

          {/* Advanced sections */}
          <section className={cls(styles.grid2, styles.gridInner)}>
            {/* Wallets */}
            <Section title="Wallets (Dev / RMC)">
              <div className={styles.field}>
                <label className={styles.smallMuted}>Dev Wallet</label>
                <input className={styles.input} placeholder="0x..." value={devWallet} onChange={(e) => setDevWallet(e.target.value)} disabled={!isOwner || busy.dev} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onSetDevWallet} disabled={!isOwner || busy.dev}>{busy.dev ? "Updating…" : "Set Dev Wallet"}</button>
              </div>
              <div className={styles.field}>
                <label className={styles.smallMuted}>RMC Wallet</label>
                <input className={styles.input} placeholder="0x..." value={rmcWallet} onChange={(e) => setRmcWallet(e.target.value)} disabled={!isOwner || busy.rmc} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onSetRmcWallet} disabled={!isOwner || busy.rmc}>{busy.rmc ? "Updating…" : "Set RMC Wallet"}</button>
              </div>
            </Section>

            {/* Oracle & Merkle */}
            <Section title="Oracle & Merkle">
              <div className={styles.field}>
                <label className={styles.smallMuted}>Oracle Address</label>
                <input className={styles.input} placeholder="0x..." value={oracleAddr} onChange={(e) => setOracleAddr(e.target.value)} disabled={!isOwner || busy.oracle} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onSetOracle} disabled={!isOwner || busy.oracle}>{busy.oracle ? "Updating…" : "Set Oracle"}</button>
              </div>
              <div className={styles.field}>
                <label className={styles.smallMuted}>Merkle Root (bytes32)</label>
                <input className={styles.input} placeholder="0x...32bytes" value={merkleRoot} onChange={(e) => setMerkleRoot(e.target.value)} disabled={!isOwner || busy.merkle} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onSetMerkleRoot} disabled={!isOwner || busy.merkle}>{busy.merkle ? "Updating…" : "Set Merkle Root"}</button>
              </div>
            </Section>
          </section>

          <section className={cls(styles.grid2, styles.gridInner)}>
            {/* Supported Tokens */}
            <Section title="Supported Tokens">
              <div className={styles.field}>
                <label className={styles.smallMuted}>Select token</label>
                <select className={styles.select} value={tokenSel} onChange={(e) => setTokenSel(e.target.value)} disabled={!isOwner || busy.token}>
                  <option value="">—</option>
                  {supportedTokens.map((t) => (<option key={t} value={t}>{t}</option>))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.smallMuted}>Or type address</label>
                <input className={styles.input} placeholder="0x..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} disabled={!isOwner || busy.token} />
              </div>
              <div className={styles.row}>
                <label className={styles.smallMuted} style={{ marginRight: 12 }}>Allowed</label>
                <input type="checkbox" checked={tokenAllowed} onChange={(e) => setTokenAllowed(e.target.checked)} disabled={!isOwner || busy.token} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onUpdateSupportedToken} disabled={!isOwner || busy.token}>{busy.token ? "Updating…" : "Update Supported Token"}</button>
              </div>
            </Section>

            {/* Fee Tiers */}
            <Section title="Fee Tiers">
              <div className={styles.smallMuted}>Thresholds are in whole USD. BPS must be thresholds.length + 1.</div>
              <div className={styles.stackSm}>
                {feeThresholds.map((th, i) => (
                  <div key={i} className={styles.row}>
                    <span className={styles.contractFundsLabel} style={{ width: 120 }}>≤ Threshold {i+1}</span>
                    <input className={styles.input} style={{ maxWidth: 200 }} value={th} onChange={(e) => setFeeThresholds((arr) => arr.map((v, idx) => idx === i ? e.target.value : v))} disabled={!isOwner || busy.fee} />
                    <span className={styles.contractFundsLabel} style={{ width: 120 }}>BPS {i+1}</span>
                    <input className={styles.input} style={{ maxWidth: 120 }} value={feeBps[i] || ""} onChange={(e) => setFeeBps((arr) => arr.map((v, idx) => idx === i ? e.target.value : v))} disabled={!isOwner || busy.fee} />
                    <button type="button" className={styles.button} onClick={() => { setFeeThresholds((arr) => arr.filter((_, idx) => idx !== i)); setFeeBps((arr) => arr.filter((_, idx) => idx !== i)); }} disabled={!isOwner || busy.fee}>Remove</button>
                  </div>
                ))}
                {/* Last BPS (default) */}
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel} style={{ width: 120 }}>Default BPS</span>
                  <input className={styles.input} style={{ maxWidth: 120 }} value={feeBps[feeThresholds.length] || ""} onChange={(e) => setFeeBps((arr) => { const copy = [...arr]; copy[feeThresholds.length] = e.target.value; return copy; })} disabled={!isOwner || busy.fee} />
                  <button type="button" className={styles.button} onClick={() => { setFeeThresholds((arr) => [...arr, "0"]); setFeeBps((arr) => [...arr, "0"]); }} disabled={!isOwner || busy.fee}>Add Row</button>
                </div>
              </div>
              <div className={styles.row}>
                <button type="button" className={cls(styles.button, styles.buttonAccent)} onClick={onSaveFeeTiers} disabled={!isOwner || busy.fee}>{busy.fee ? "Saving…" : "Save Fee Tiers"}</button>
              </div>
            </Section>
          </section>

          <section className={cls(styles.grid1, styles.gridInner)}>
            {/* Withdraw */}
            <Section title="Withdraw Funds">
              <div className={styles.row}>
                <label className={styles.smallMuted} style={{ width: 120 }}>Token</label>
                <select className={styles.select} style={{ maxWidth: 380 }} value={tokenSel} onChange={(e) => setTokenSel(e.target.value)} disabled={!isOwner || busy.wd}>
                  <option value="">—</option>
                  {wone && <option value={wone}>wONE ({fmt(wBal)})</option>}
                  {usdc && <option value={usdc}>USDC ({fmt(uBal)})</option>}
                </select>
                <button type="button" className={styles.button} onClick={onWithdrawFunds} disabled={!isOwner || busy.wd || !tokenSel}>{busy.wd ? "Withdrawing…" : "Withdraw"}</button>
              </div>
            </Section>
          </section>

        </div>
      </main>
      <Footer className={styles.footer} />
    </div>
  );
}
