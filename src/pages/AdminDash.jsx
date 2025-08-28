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

// --- Tx helpers ---
function txHashOf(x){ try { return x?.hash ?? x?.transactionHash ?? (typeof x === "string" ? x : ""); } catch { return ""; } }
async function waitReceipt(tx, signerOrProvider){
  try{
    if (tx && typeof tx.wait === "function") return await tx.wait();
    const hash = txHashOf(tx);
    const prov = signerOrProvider?.provider ?? signerOrProvider;
    if (hash && prov && typeof prov.waitForTransactionReceipt === "function") return await prov.waitForTransactionReceipt(hash);
    if (hash && prov && typeof prov.waitForTransaction === "function") return await prov.waitForTransaction(hash);
    return { hash: hash || "" };
  } catch(e){ console.warn("[waitReceipt] fallback", e); return { hash: txHashOf(tx) }; }
}

function Badge({ ok, textTrue = "Active", textFalse = "Inactive" }) {
  return (
    <span
      className={styles.contractFundsPill}
      style={{
        background: ok ? "rgba(91,239,194,0.12)" : "rgba(239,68,68,0.12)",
        borderColor: "rgba(255,255,255,0.12)",
      }}
    >
      {ok ? textTrue : textFalse}
    </span>
  );
}
function tsToUTC(tsSec) {
  const ts = Number(tsSec || 0);
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

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
            <a href="/"><img src="/logo.png" alt="Recovery Vault" className={styles.logoImg} /></a>
          </div>
          <div className={styles.headerCenter} >
            <div className={styles.brandText} style={{ fontWeight: 700 }}>Admin Dashboard</div>
          </div>
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
  const [supportedTokens, setSupportedTokens] = useState([]);
  const [tokenSymbols, setTokenSymbols] = useState({});
  const [tokenSel, setTokenSel] = useState("");
  const [tokenAllowed, setTokenAllowed] = useState(true);
  const [tokenInput, setTokenInput] = useState("");
  const [fixedPrice, setFixedPrice] = useState("");

  // Wallets / oracle / merkle
  const [devWallet, setDevWallet] = useState("");
  const [rmcWallet, setRmcWallet] = useState("");
  const [oracleAddr, setOracleAddr] = useState("");
  const [merkleRoot, setMerkleRoot] = useState("");
  const [newOwner, setNewOwner] = useState("");

  // Fee tiers (agora iniciam vazios e serão preenchidos do contrato)
  const [feeThresholds, setFeeThresholds] = useState([]);
  const [feeBps, setFeeBps] = useState([]);

  // Forms state (basic)
  const [dailyLimit, setDailyLimit] = useState("");
  const [locked, setLocked] = useState(false);
  const [roundId, setRoundId] = useState("");

  // Tx states
  const [busy, setBusy] = useState({ daily: false, lock: false, round: false, dev: false, rmc: false, oracle: false, merkle: false, token: false, tokenPrice: false, fee: false, wd: false, ownerXfer: false });
  const [notice, setNotice] = useState(null);

  const provider = useMemo(() => ctxProvider || vaultService.getDefaultProvider?.() || null, [ctxProvider]);

  // --- Load basics from contract ---
  const loadBasics = useCallback(async () => {
    try {
      setLoadingOwner(true);
      if (!provider) throw new Error("Provider not available");
      const c = await vaultService.getReadContract(provider);

      // Resolve connected account (wallet)
      let acc = "";
      try {
        if (appkitAccount?.address) acc = appkitAccount.address;
        else if (ctxAccount) acc = ctxAccount;
        else if (provider.getSigner) acc = await (await provider.getSigner()).getAddress();
      } catch {}

      // Parallel fetch from contract
      const [own, ri, wAddr, uAddr, dev, rmc, ora, mroot, sup, feesRaw] = await Promise.all([
        c.owner(),
        c.getRoundInfo(),
        c.wONE(),
        c.usdc(),
        c.devWallet(),
        c.rmcWallet(),
        c.oracle(),
        c.merkleRoot(),
        c.getSupportedTokens().catch(() => []),
        c.getFeeTiers().catch(() => null),
      ]);

      // Set round info (tuple)
      const round = {
        roundId: ri?.roundId ?? ri?.[0] ?? 0n,
        startTime: ri?.startTime ?? ri?.[1] ?? 0n,
        isActive: Boolean(ri?.isActive ?? ri?.[2]),
        paused: Boolean(ri?.paused ?? ri?.[3]),
        limitUsd: ri?.limitUsd ?? ri?.[4] ?? 0n,
      };

      // Fetch balances & decimals
      let wdec = 18, udec = 6, wb = 0n, ub = 0n;
      try {
        const bals = await c.getVaultBalances();
        wb = bals?.woneBalance ?? bals?.[0] ?? 0n;
        ub = bals?.usdcBalance ?? bals?.[1] ?? 0n;
      } catch {}

      try {
        if (ethers.isAddress(wAddr)) {
          const ercW = new ethers.Contract(wAddr, ["function decimals() view returns (uint8)"], provider);
          wdec = Number(await ercW.decimals());
        }
      } catch {}
      try {
        if (ethers.isAddress(uAddr)) {
          const ercU = new ethers.Contract(uAddr, ["function decimals() view returns (uint8)"], provider);
          udec = Number(await ercU.decimals());
        }
      } catch {}

      // Token symbols (para select de supportedTokens)
      const symEntries = await Promise.all(
        (Array.isArray(sup) ? sup : []).map(async (addr) => {
          if (!ethers.isAddress(addr)) return [addr, addr];
          try {
            const erc = new ethers.Contract(addr, ["function symbol() view returns (string)"], provider);
            const sym = await erc.symbol();
            return [addr, sym];
          } catch {
            return [addr, addr];
          }
        })
      );
      const symbols = Object.fromEntries(symEntries);

      // Fee tiers (suporta tanto tuple [thresholds, bps] quanto objeto {thresholds, bps} / {thresholds, bpsOut})
      if (feesRaw) {
        let thresholdsArr = [];
        let bpsArr = [];
        if (Array.isArray(feesRaw) && feesRaw.length >= 2) {
          thresholdsArr = feesRaw[0] ?? [];
          bpsArr = feesRaw[1] ?? [];
        } else if (feesRaw.thresholds && (feesRaw.bps || feesRaw.bpsOut)) {
          thresholdsArr = feesRaw.thresholds;
          bpsArr = feesRaw.bps ?? feesRaw.bpsOut;
        }
        setFeeThresholds((thresholdsArr || []).map((x) => x.toString()));
        setFeeBps((bpsArr || []).map((x) => x.toString()));
      } else {
        // Se a chamada falhar, mantém arrays atuais (vazios) para evitar hardcode.
        setFeeThresholds((prev) => prev.length ? prev : []);
        setFeeBps((prev) => prev.length ? prev : []);
      }

      setOwner(own);
      setAccount(acc);
      setIsOwner(toLower(acc) === toLower(own));
      setRoundInfo(round);
      setWone(wAddr);
      setUsdc(uAddr);
      setWoneDec(wdec);
      setUsdcDec(udec);
      setBalances({ w: wb, u: ub });
      setDevWallet(dev);
      setRmcWallet(rmc);
      setOracleAddr(ora);
      setMerkleRoot(mroot);
      setSupportedTokens(Array.isArray(sup) ? sup : []);
      setTokenSymbols(symbols);
      setLocked(round.paused);
    } catch (e) {
      console.warn("[AdminDash] loadBasics error:", e);
    } finally {
      setLoadingOwner(false);
    }
  }, [provider, appkitAccount?.address, ctxAccount]);

  // Initial load + when provider/account changes
  useEffect(() => { if (provider) { loadBasics(); } }, [provider, loadBasics]);

  useEffect(() => {
    (async () => {
      if (!provider || !tokenSel) return;
      try {
        const c = await vaultService.getReadContract(provider);
        const allowed = await c.supportedToken(tokenSel);
        setTokenAllowed(Boolean(allowed));
      } catch {}
    })();
  }, [provider, tokenSel]);

  // Load fixed USD price (18 decimals on-chain) for the selected token
  useEffect(() => {
    (async () => {
      if (!provider || !tokenSel || !ethers.isAddress(tokenSel)) { setFixedPrice(""); return; }
      try {
        const c = await vaultService.getReadContract(provider);
        const p = await c.fixedUsdPrice(tokenSel);
        const norm = ethers.formatUnits(p || 0n, 18);
        // Hide zeros for UX; user can type 0 to clear
        setFixedPrice((norm === "0.0" || norm === "0") ? "" : norm);
      } catch {
        setFixedPrice("");
      }
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
      const tx = await vaultService.setDailyLimit(signer, parsed);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Daily limit updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      setDailyLimit("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setDailyLimit error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set daily limit" });
    } finally { setBusy((b) => ({ ...b, daily: false })); }
  }, [dailyLimit, requireOwnerAndSigner, loadBasics]);

  const onToggleLocked = useCallback(async () => {
    setBusy((b) => ({ ...b, lock: true })); setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setLocked(signer, !locked);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Lock status updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      setLocked((v) => !v);
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setLocked error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to update lock status" });
    } finally { setBusy((b) => ({ ...b, lock: false })); }
  }, [locked, requireOwnerAndSigner, loadBasics]);

  const onStartNewRound = useCallback(async () => {
    setBusy((b) => ({ ...b, round: true })); setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const parsed = BigInt(Math.floor(Number(String(roundId).replace(/,/g, ""))));
      if (parsed <= 0n) throw new Error("Invalid round id");
      const tx = await vaultService.startNewRound(signer, parsed);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `New round scheduled. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      setRoundId("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] startNewRound error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to start new round" });
    } finally { setBusy((b) => ({ ...b, round: false })); }
  }, [roundId, requireOwnerAndSigner, loadBasics]);

  // --- Advanced actions ---
  const onSetDevWallet = useCallback(async () => {
    setBusy((b) => ({ ...b, dev: true })); setNotice(null);
    try {
      if (!isAddr(devWallet)) throw new Error("Invalid dev wallet address");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setDevWallet(signer, devWallet);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Dev wallet updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setDevWallet error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set dev wallet" });
    } finally { setBusy((b) => ({ ...b, dev: false })); }
  }, [devWallet, requireOwnerAndSigner, loadBasics]);

  const onSetRmcWallet = useCallback(async () => {
    setBusy((b) => ({ ...b, rmc: true })); setNotice(null);
    try {
      if (!isAddr(rmcWallet)) throw new Error("Invalid RMC wallet address");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setRmcWallet(signer, rmcWallet);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `RMC wallet updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setRmcWallet error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set RMC wallet" });
    } finally { setBusy((b) => ({ ...b, rmc: false })); }
  }, [rmcWallet, requireOwnerAndSigner, loadBasics]);

  const onSetOracle = useCallback(async () => {
    setBusy((b) => ({ ...b, oracle: true })); setNotice(null);
    try {
      if (!isAddr(oracleAddr)) throw new Error("Invalid oracle address");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setOracle(signer, oracleAddr);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Oracle updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setOracle error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set oracle" });
    } finally { setBusy((b) => ({ ...b, oracle: false })); }
  }, [oracleAddr, requireOwnerAndSigner, loadBasics]);

  const onSetMerkleRoot = useCallback(async () => {
    setBusy((b) => ({ ...b, merkle: true })); setNotice(null);
    try {
      if (!isBytes32(merkleRoot)) throw new Error("Invalid merkle root (bytes32 hex)");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setMerkleRoot(signer, merkleRoot);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Merkle root updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setMerkleRoot error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set merkle root" });
    } finally { setBusy((b) => ({ ...b, merkle: false })); }
  }, [merkleRoot, requireOwnerAndSigner, loadBasics]);

  const onTransferOwnership = useCallback(async () => {
    setBusy((b) => ({ ...b, ownerXfer: true })); setNotice(null);
    try {
      if (!isAddr(newOwner)) throw new Error("Invalid new owner address");
      if (toLower(newOwner) === toLower(ethers.ZeroAddress)) throw new Error("New owner cannot be zero address");
      const { signer } = await requireOwnerAndSigner();
      const rc = await (async () => {
        const tx = await vaultService.transferOwnership(signer, newOwner);
        return await waitReceipt(tx, signer);
      })();
      setNotice({ type: "success", msg: `Ownership transferred. Tx: ${txHashOf(rc)}` });
      setNewOwner("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] transferOwnership error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to transfer ownership" });
    } finally { setBusy((b) => ({ ...b, ownerXfer: false })); }
  }, [newOwner, requireOwnerAndSigner, loadBasics]);

  const onUpdateSupportedToken = useCallback(async () => {
    setBusy((b) => ({ ...b, token: true })); setNotice(null);
    try {
      const target = tokenInput || tokenSel;
      if (!isAddr(target)) throw new Error("Invalid token address");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setSupportedToken(signer, target, tokenAllowed);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Supported token updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      setTokenInput("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setSupportedToken error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to update supported token" });
    } finally { setBusy((b) => ({ ...b, token: false })); }
  }, [tokenSel, tokenInput, tokenAllowed, requireOwnerAndSigner, loadBasics]);

  // Set per-token fixed USD price (18 decimals on-chain)
  const onSetFixedUsdPrice = useCallback(async () => {
    setBusy((b) => ({ ...b, tokenPrice: true })); setNotice(null);
    try {
      const target = tokenInput || tokenSel;
      if (!isAddr(target)) throw new Error("Select or enter a token address");
      const valStr = (fixedPrice ?? "").trim();
      if (valStr === "") throw new Error("Enter a price (use 0 to clear)");
      const price18 = ethers.parseUnits(valStr, 18);
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.setFixedUsdPrice(signer, target, price18);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Fixed USD price updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setFixedUsdPrice error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set fixed USD price" });
    } finally { setBusy((b) => ({ ...b, tokenPrice: false })); }
  }, [fixedPrice, tokenSel, tokenInput, requireOwnerAndSigner, loadBasics]);

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
      const tx = await vaultService.setFeeTiers(signer, th, bps);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Fee tiers updated. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setFeeTiers error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to update fee tiers" });
    } finally { setBusy((b) => ({ ...b, fee: false })); }
  }, [feeThresholds, feeBps, requireOwnerAndSigner, loadBasics]);

  const onWithdrawFunds = useCallback(async () => {
    setBusy((b) => ({ ...b, wd: true })); setNotice(null);
    try {
      const token = tokenSel || wone || usdc;
      if (!isAddr(token)) throw new Error("Select a token");
      if (toLower(token) !== toLower(wone) && toLower(token) !== toLower(usdc)) throw new Error("Token not allowed");
      const { signer } = await requireOwnerAndSigner();
      const tx = await vaultService.withdrawFunds(signer, token);
      const rc = await waitReceipt(tx, signer);
      setNotice({ type: "success", msg: `Withdraw submitted. Tx: ${txHashOf(rc) || txHashOf(tx)}` });
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] withdrawFunds error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to withdraw funds" });
    } finally { setBusy((b) => ({ ...b, wd: false })); }
  }, [tokenSel, wone, usdc, requireOwnerAndSigner, loadBasics]);

  // --- UI helpers ---
  const roundStartText = useMemo(() => {
    const ts = Number(roundInfo.startTime || 0n);
    if (!ts) return "–";
    return tsToUTC(ts);
  }, [roundInfo.startTime]);

  const fmt = (n, d=0) => { try { return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); } catch { return String(n); } };
  const wBal = useMemo(() => { try { return ethers.formatUnits(balances.w || 0n, woneDec); } catch { return "0"; } }, [balances.w, woneDec]);
  const uBal = useMemo(() => { try { return ethers.formatUnits(balances.u || 0n, usdcDec); } catch { return "0"; } }, [balances.u, usdcDec]);

  const notOwnerUI = !loadingOwner && !isOwner;

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
                <div className={styles.row}><span className={styles.contractFundsLabel}>Active</span><Badge ok={roundInfo.isActive} textTrue="Active" textFalse="Inactive" /></div>
                <div className={styles.row}><span className={styles.contractFundsLabel}>Locked</span><Badge ok={roundInfo.paused} textTrue="Locked" textFalse="Unlocked" /></div>
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

          {/* Transfer Ownership */}
          <section className={cls(styles.grid1, styles.gridInner)}>
            <Section title="Transfer Ownership">
              <div className={styles.field}>
                <label className={styles.smallMuted}>New Owner Address</label>
                <input className={styles.input} placeholder="0x..." value={newOwner} onChange={(e) => setNewOwner(e.target.value)} disabled={!isOwner || busy.ownerXfer} />
              </div>
              <div className={styles.row}>
                <button type="button" className={`${styles.button} ${styles.buttonWarn}`} onClick={onTransferOwnership} disabled={!isOwner || busy.ownerXfer}>
                  {busy.ownerXfer ? "Transferring…" : "Transfer Ownership"}
                </button>
              </div>
              <div className={styles.smallMuted}>Only the current owner can transfer. New owner must not be the zero address.</div>
            </Section>
          </section>

          <section className={cls(styles.grid2, styles.gridInner)}>
            {/* Supported Tokens */}
            <Section title="Supported Tokens">
              <div className={styles.field}>
                <label className={styles.smallMuted}>Select token</label>
                <select className={styles.select} value={tokenSel} onChange={(e) => setTokenSel(e.target.value)} disabled={!isOwner || busy.token || busy.tokenPrice}>
                  <option value="">—</option>
                  {supportedTokens.map((t) => (
                    <option key={t} value={t}>
                      {tokenSymbols[t] ? `${tokenSymbols[t]} (${t})` : t}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.smallMuted}>Or type address</label>
                <input className={styles.input} placeholder="0x..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} disabled={!isOwner || busy.token || busy.tokenPrice} />
              </div>
              <div className={styles.row}>
                <label className={styles.smallMuted} style={{ marginRight: 12 }}>Allowed</label>
                <input type="checkbox" checked={tokenAllowed} onChange={(e) => setTokenAllowed(e.target.checked)} disabled={!isOwner || busy.token || busy.tokenPrice} />
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onUpdateSupportedToken} disabled={!isOwner || busy.token}>{busy.token ? "Updating…" : "Update Supported Token"}</button>
              </div>

              <div className={styles.contractFundsSep} />

              <div className={styles.field}>
                <label className={styles.smallMuted}>Fixed Price (USD)</label>
                <input className={styles.input} type="number" step="any" inputMode="decimal" placeholder="e.g. 1.00 (0 to clear)" value={fixedPrice} onChange={(e) => setFixedPrice(e.target.value)} disabled={!isOwner || busy.tokenPrice} />
                <div className={styles.smallMuted}>Stored on-chain as 18 decimals. Applies only to tokens where fixed pricing is used.</div>
              </div>
              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={onSetFixedUsdPrice} disabled={!isOwner || busy.tokenPrice || !(tokenSel || tokenInput)}>{busy.tokenPrice ? "Saving…" : "Set Fixed USD Price"}</button>
              </div>
            </Section>

            {/* Fee Tiers */}
            <Section title="Fee Tiers">
              <div className={styles.smallMuted}>Thresholds are in whole USD. BPS must be thresholds.length + 1.</div>
              <div className={styles.stackSm}>
                {feeThresholds.map((th, i) => (
                  <div key={i} className={styles.row}>
                    <span className={styles.contractFundsLabel} style={{ width: 100 }}>≤ Threshold {i+1}</span>
                    <input className={styles.input} style={{ maxWidth: 120 }} value={th} onChange={(e) => setFeeThresholds((arr) => arr.map((v, idx) => idx === i ? e.target.value : v))} disabled={!isOwner || busy.fee} />
                    <span className={styles.contractFundsLabel} style={{ width: 100 }}>BPS {i+1}</span>
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
