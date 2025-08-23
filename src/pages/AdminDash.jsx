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

function AdminAlert({ type = "info", children }) {
  const map = {
    info: styles.info,
    success: styles.success,
    warning: styles.warning,
    error: styles.error,
  };
  return (
    <div role="alert" className={cls(styles.alert, map[type] || styles.info)}>
      {children}
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <section className={styles.card} style={{ padding: 16 }}>
      <div className={styles.contractFundsHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>{title}</h3>
        <div>{right}</div>
      </div>
      <div className={styles.stack}>
        {children}
      </div>
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
            <div className={styles.headerRightInner}>
              <WalletConnection />
            </div>
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

  // Forms state
  const [dailyLimit, setDailyLimit] = useState("");
  const [locked, setLocked] = useState(false);
  const [roundId, setRoundId] = useState("");

  // Tx states
  const [busy, setBusy] = useState({ daily: false, lock: false, round: false });
  const [notice, setNotice] = useState(null); // {type, msg}

  const provider = useMemo(() => {
    return ctxProvider || vaultService.getDefaultProvider?.() || null;
  }, [ctxProvider]);

  // Resolve connected account (context or appkit)
  useEffect(() => {
    const addr = ctxAccount || appkitAccount?.address || "";
    setAccount(addr);
  }, [ctxAccount, appkitAccount?.address]);

  // Load owner and round info
  const loadBasics = useCallback(async () => {
    if (!provider) return;
    setLoadingOwner(true);
    try {
      const contract = vaultService.getVaultContract(provider);
      const [ownerAddr, gi] = await Promise.all([
        contract.owner(),
        (async () => { try { return await contract.getRoundInfo(); } catch { return null; } })(),
      ]);

      setOwner(ownerAddr);
      setIsOwner(toLower(ownerAddr) === toLower(account));

      if (gi) {
        const [roundId, startTime, isActive, paused, limitUsd] = gi;
        setRoundInfo({
          roundId: roundId ?? 0n,
          startTime: startTime ?? 0n,
          isActive: Boolean(isActive),
          paused: Boolean(paused),
          limitUsd: limitUsd ?? 0n,
        });
        setLocked(Boolean(paused));
      }
    } catch (err) {
      console.error("[AdminDash] loadBasics error:", err);
      setNotice({ type: "error", msg: "Failed to load owner or round info." });
    } finally {
      setLoadingOwner(false);
    }
  }, [provider, account]);

  useEffect(() => { loadBasics(); }, [loadBasics]);

  const requireOwnerAndSigner = useCallback(async () => {
    if (!provider) throw new Error("Provider not available");
    const signer = provider.getSigner ? await provider.getSigner() : null;
    if (!signer) throw new Error("Connect a wallet to proceed");
    const signerAddr = await signer.getAddress();
    if (toLower(signerAddr) !== toLower(owner)) throw new Error("Only the owner can perform this action");
    return { signer };
  }, [provider, owner]);

  // --- Actions ---
  const onSetDailyLimit = useCallback(async () => {
    setBusy((b) => ({ ...b, daily: true }));
    setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      // dailyLimit is USD inteiro; permitir números com virgula/ponto e floor
      const parsed = Math.floor(Number(String(dailyLimit).replace(/,/g, ".")));
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid amount");

      let tx;
      if (typeof vaultService.setDailyLimit === "function") {
        tx = await vaultService.setDailyLimit(parsed, signer);
      } else {
        const contract = vaultService.getVaultContract(signer);
        tx = await contract.setDailyLimit(parsed);
      }
      const receipt = await tx.wait();
      setNotice({ type: "success", msg: `Daily limit updated. Tx: ${receipt.hash}` });
      setDailyLimit("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setDailyLimit error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to set daily limit" });
    } finally {
      setBusy((b) => ({ ...b, daily: false }));
    }
  }, [dailyLimit, requireOwnerAndSigner, loadBasics]);

  const onToggleLocked = useCallback(async () => {
    setBusy((b) => ({ ...b, lock: true }));
    setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      let tx;
      if (typeof vaultService.setLocked === "function") {
        tx = await vaultService.setLocked(!locked, signer);
      } else {
        const contract = vaultService.getVaultContract(signer);
        tx = await contract.setLocked(!locked);
      }
      const receipt = await tx.wait();
      setNotice({ type: "success", msg: `Lock status updated. Tx: ${receipt.hash}` });
      setLocked((v) => !v);
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] setLocked error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to update lock status" });
    } finally {
      setBusy((b) => ({ ...b, lock: false }));
    }
  }, [locked, requireOwnerAndSigner, loadBasics]);

  const onStartNewRound = useCallback(async () => {
    setBusy((b) => ({ ...b, round: true }));
    setNotice(null);
    try {
      const { signer } = await requireOwnerAndSigner();
      const parsed = BigInt(Math.floor(Number(String(roundId).replace(/,/g, ""))));
      if (parsed <= 0n) throw new Error("Invalid round id");

      let tx;
      if (typeof vaultService.startNewRound === "function") {
        tx = await vaultService.startNewRound(parsed, signer);
      } else {
        const contract = vaultService.getVaultContract(signer);
        tx = await contract.startNewRound(parsed);
      }
      const receipt = await tx.wait();
      setNotice({ type: "success", msg: `New round scheduled. Tx: ${receipt.hash}` });
      setRoundId("");
      await loadBasics();
    } catch (err) {
      console.error("[AdminDash] startNewRound error:", err);
      setNotice({ type: "error", msg: err?.message || "Failed to start new round" });
    } finally {
      setBusy((b) => ({ ...b, round: false }));
    }
  }, [roundId, requireOwnerAndSigner, loadBasics]);

  // --- UI ---
  const notOwnerUI = !loadingOwner && !isOwner;
  const disabled = !isOwner || busy.daily || busy.lock || busy.round;

  const roundStartText = useMemo(() => {
    const ts = Number(roundInfo.startTime || 0n) * 1000;
    if (!ts) return "–";
    try { return new Date(ts).toLocaleString(); } catch { return String(roundInfo.startTime); }
  }, [roundInfo.startTime]);

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
                <div className={styles.row}>
                  <strong>Round</strong>
                </div>
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel}>ID</span>
                  <span className={styles.contractFundsValue}>{String(roundInfo.roundId)}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel}>Start</span>
                  <span className={styles.contractFundsSubValue}>{roundStartText}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel}>Active</span>
                  <span className={styles.contractFundsSubValue}>{roundInfo.isActive ? "Yes" : "No"}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel}>Locked</span>
                  <span className={styles.contractFundsSubValue}>{roundInfo.paused ? "Yes" : "No"}</span>
                </div>
                <div className={styles.row}>
                  <span className={styles.contractFundsLabel}>Daily Limit (USD)</span>
                  <span className={styles.contractFundsValue}>{String(roundInfo.limitUsd)}</span>
                </div>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.stackSm}>
                <div className={styles.row}>
                  <button type="button" className={styles.button} onClick={loadBasics}>Refresh</button>
                </div>
                <div className={styles.smallMuted}>
                  Owner: {owner || "—"}
                </div>
                <div className={styles.smallMuted}>
                  Account: {account || "—"}
                </div>
              </div>
            </div>
          </section>

          {/* Admin Controls */}
          <section className={cls(styles.grid3, styles.gridInner)}>
            {/* Daily Limit */}
            <Section title="Daily Limit (USD)" right={null}>
              <div className={styles.field}>
                <label className={styles.smallMuted}>New Limit (whole USD)</label>
                <input
                  className={styles.input}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="e.g. 100"
                  value={dailyLimit}
                  onChange={(e) => setDailyLimit(e.target.value)}
                  disabled={!isOwner || busy.daily}
                />
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={cls(styles.button, styles.buttonAccent)}
                  onClick={onSetDailyLimit}
                  disabled={!isOwner || busy.daily}
                >
                  {busy.daily ? "Updating…" : "Set Daily Limit"}
                </button>
              </div>
            </Section>

            {/* Lock / Unlock */}
            <Section title="Lock Status" right={null}>
              <div className={styles.row}>
                <label className={styles.smallMuted} style={{ marginRight: 12 }}>Locked?</label>
                <input
                  type="checkbox"
                  checked={locked}
                  onChange={() => { /* noop, use button */ }}
                  disabled
                />
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={onToggleLocked}
                  disabled={!isOwner || busy.lock}
                >
                  {busy.lock ? "Updating…" : locked ? "Unlock" : "Lock"}
                </button>
              </div>
            </Section>

            {/* Start New Round */}
            <Section title="Start New Round" right={null}>
              <div className={styles.field}>
                <label className={styles.smallMuted}>Round ID</label>
                <input
                  className={styles.input}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="e.g. 2"
                  value={roundId}
                  onChange={(e) => setRoundId(e.target.value)}
                  disabled={!isOwner || busy.round}
                />
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={onStartNewRound}
                  disabled={!isOwner || busy.round}
                >
                  {busy.round ? "Scheduling…" : "Start New Round"}
                </button>
              </div>
            </Section>
          </section>

          {/* TODO: Advanced sections (owner-only placeholders) */}
          <section className={cls(styles.grid2, styles.gridInner)}>
            <Section title="Wallets (Dev / RMC)">
              <AdminAlert type="info">Coming soon: setDevWallet / setRmcWallet</AdminAlert>
            </Section>
            <Section title="Oracle & Merkle">
              <AdminAlert type="info">Coming soon: setOracle / setMerkleRoot</AdminAlert>
            </Section>
          </section>

          <section className={cls(styles.grid2, styles.gridInner)}>
            <Section title="Supported Tokens">
              <AdminAlert type="info">Coming soon: setSupportedToken(address,bool)</AdminAlert>
            </Section>
            <Section title="Fee Tiers">
              <AdminAlert type="info">Coming soon: setFeeTiers(uint256[] thresholds, uint16[] bps)</AdminAlert>
            </Section>
          </section>

          <section className={cls(styles.grid1, styles.gridInner)}>
            <Section title="Withdraw Funds">
              <AdminAlert type="info">Coming soon: withdrawFunds(address token)</AdminAlert>
            </Section>
          </section>

        </div>
      </main>
      <Footer className={styles.footer} />
    </div>
  );
}
