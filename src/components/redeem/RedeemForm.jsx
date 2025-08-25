import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import useRedeem from "@/hooks/useRedeem";
import * as vaultService from "@/services/vaultService";
import ReCAPTCHA from "react-google-recaptcha";
import TokenSelect from "@/components/shared/TokenSelect";

export default function RedeemForm({ address, eligible = null, proof = [] }) {
  // --- debug helper ---
  const dbg = (...args) => console.debug("[RedeemForm]", ...args);

  const { provider: ctxProvider } = useContractContext();
  const readProvider = useMemo(() => {
    const p = ctxProvider || vaultService.getDefaultProvider?.() || null;
    console.debug("[RedeemForm] readProvider memo ->", !!p);
    return p;
  }, [ctxProvider]);

  const {
    state, plan, display, reasons, warnings,
    prepare, execute, canPrepare, canExecute,
    progress, receipts, error: hookError, reset
  } = useRedeem(readProvider);

  // Tokens e addresses do cofre
  const [supportedTokens, setSupportedTokens] = useState([]); // [{address, symbol?}]
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");

  // Form state
  const [tokenIn, setTokenIn] = useState("");
  const [redeemIn, setRedeemIn] = useState("");
  const [amountHuman, setAmountHuman] = useState("");

  // reCAPTCHA
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const recaptchaRef = useRef(null);
  const [recaptchaToken, setRecaptchaToken] = useState("");

  // Round hold state (ROUND_DELAY)
  const [holdInfo, setHoldInfo] = useState({ isHold: false, startTime: 0, now: Math.floor(Date.now()/1000) });
  const [uiNotice, setUiNotice] = useState(null);

  // --- lifecycle debug ---
  useEffect(() => {
    dbg("mount", { address, eligible, proofLen: Array.isArray(proof) ? proof.length : 0 });
    return () => dbg("unmount");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { dbg("provider changed", !!readProvider); }, [readProvider]);
  useEffect(() => { dbg("state", state); }, [state]);
  useEffect(() => { if (plan) dbg("plan updated", { ok: plan.ok, steps: plan.steps?.length || 0 }); }, [plan]);
  useEffect(() => { if (display) dbg("display updated", display); }, [display]);
  useEffect(() => { if (reasons?.length) dbg("reasons", reasons); }, [reasons]);
  useEffect(() => { if (warnings?.length) dbg("warnings", warnings); }, [warnings]);
  useEffect(() => { if (hookError) dbg("hookError", hookError); }, [hookError]);
  useEffect(() => { if (progress) dbg("progress", progress); }, [progress]);
  useEffect(() => { if (state === 'success') dbg("success receipts", receipts); }, [state, receipts]);
  useEffect(() => { dbg("tokenIn", tokenIn); }, [tokenIn]);
  useEffect(() => { dbg("redeemIn", redeemIn); }, [redeemIn]);
  useEffect(() => { dbg("amountHuman", amountHuman); }, [amountHuman]);

  // Carregar dados do contrato para preencher selects
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        dbg("load supported tokens: start", { hasProvider: !!readProvider });
        if (!readProvider) return;
        const [list, w, u] = await Promise.all([
          vaultService.getSupportedTokens(readProvider).catch(() => []),
          vaultService.wONE(readProvider).catch(() => ""),
          vaultService.usdc(readProvider).catch(() => ""),
        ]);
        if (!alive) return;
        dbg("load supported tokens: done", { count: (list || []).length, w, u });
        setSupportedTokens((list || []).map((addr) => ({ address: addr })));
        setWone(w || "");
        setUsdc(u || "");
        // Defaults
        if (!redeemIn && (w || u)) setRedeemIn(w || u);
        if (!tokenIn && list && list[0]) setTokenIn(list[0]);
      } catch (e) {
        console.warn("[RedeemForm] load supported tokens error:", e);
      }
    })();
    return () => { alive = false; };
  }, [readProvider]);

  // Detecta se o round está em HOLD (ROUND_DELAY ainda em curso)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!readProvider) return;
      try {
        const info = await vaultService.getRoundInfo(readProvider);
        const now = Math.floor(Date.now() / 1000);
        const startTime = Number(info?.startTime || 0);
        const paused = Boolean(info?.paused);
        const locked = await vaultService.isLocked(readProvider).catch(() => false);
        const isHold = !paused && !locked && !!startTime && now < startTime;
        dbg("hold check", { now, startTime, paused, locked, isHold });
        if (alive) setHoldInfo({ isHold, startTime, now });
      } catch (e) {
        console.warn("[RedeemForm] hold check error:", e);
        if (alive) setHoldInfo((h) => ({ ...h, isHold: false }));
      }
    })();
    return () => { alive = false; };
  }, [readProvider]);

  // Elegibilidade/whitelist — apenas informativo; o contrato valida de novo na quote
  const eligibilityMsg = useMemo(() => {
    const msg = eligible === true
      ? { type: "success", text: "You are eligible to redeem." }
      : eligible === false
        ? { type: "warning", text: "Wallet not found in whitelist. You may not proceed." }
        : null;
    dbg("eligibilityMsg", msg);
    return msg;
  }, [eligible]);

  const user = address || "";

  const onPreview = useCallback(async () => {
    dbg("onPreview click", { user, tokenIn, amountHuman, redeemIn, proofLen: Array.isArray(proof) ? proof.length : 0, hold: holdInfo.isHold });
    setUiNotice(null);
    if (holdInfo.isHold) {
      const when = holdInfo.startTime ? new Date(holdInfo.startTime * 1000).toLocaleString() + " UTC" : "—";
      const text = `Round is On Hold until ${when}.`;
      dbg("onPreview blocked by hold", { when });
      setUiNotice({ type: "warning", text });
      return;
    }
    if (!canPrepare) { dbg("onPreview blocked: canPrepare=false"); return; }
    const r = await prepare({ user, tokenIn, amountHuman, redeemIn, proof });
    dbg("onPreview result", { ok: r?.ok, reasons: r?.reasons?.length || 0 });
  }, [canPrepare, prepare, user, tokenIn, amountHuman, redeemIn, proof, holdInfo]);

  const onConfirm = useCallback(async () => {
    dbg("onConfirm click", { canExecute, state, hold: holdInfo.isHold });
    if (holdInfo.isHold) {
      const when = holdInfo.startTime ? new Date(holdInfo.startTime * 1000).toLocaleString() + " UTC" : "—";
      setUiNotice({ type: "warning", text: `Round is On Hold until ${when}.` });
      return;
    }
    // Se site key está configurada, exige reCAPTCHA
    if (recaptchaSiteKey && recaptchaRef.current) {
      try {
        dbg("recaptcha: executing");
        const token = await recaptchaRef.current.executeAsync();
        setRecaptchaToken(token || "");
        recaptchaRef.current.reset();
        dbg("recaptcha: token", token ? (token.length + " chars") : "<empty>");
        if (!token) throw new Error("reCAPTCHA validation failed");
      } catch (e) {
        console.error("[RedeemForm] reCAPTCHA error:", e);
        alert(e?.message || "reCAPTCHA error");
        return;
      }
    }

    try {
      const signer = await ctxProvider?.getSigner?.();
      dbg("execute: signer present?", !!signer);
      if (!signer) throw new Error("Connect a wallet to proceed");
      const res = await execute(signer);
      dbg("execute: finished", { hasRes: !!res });
    } catch (e) {
      console.error("[RedeemForm] execute error:", e);
    }
  }, [execute, ctxProvider, recaptchaSiteKey, canExecute, state, holdInfo]);

  const isBusy = useMemo(() => ["preparing", "approving", "redeeming"].includes(state), [state]);

  return (
    <div className={styles.card} style={{ padding: 16 }}>
      <div className={styles.contractFundsHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>Redeem</h3>
      </div>

      {/* Aviso de HOLD */}
      {holdInfo.isHold && (
        <div className={`${styles.alert} ${styles.warning}`}>
          Round is <strong>On Hold</strong> until {new Date(holdInfo.startTime * 1000).toLocaleString()} UTC.
        </div>
      )}

      {/* Elegibilidade */}
      {eligibilityMsg && (
        <div className={`${styles.alert} ${eligibilityMsg.type === 'success' ? styles.success : styles.warning}`}>
          {eligibilityMsg.text}
        </div>
      )}

      {/* Mensagens locais */}
      {uiNotice && (
        <div className={`${styles.alert} ${uiNotice.type === 'error' ? styles.error : uiNotice.type === 'warning' ? styles.warning : styles.info}`}>
          {uiNotice.text}
        </div>
      )}

      {/* Campos */}
      <div className={styles.grid2}>
        {/* Token de Entrada */}
        <div className={styles.field}>
          <label className={styles.smallMuted}>Token In</label>
          <TokenSelect
            tokens={supportedTokens}
            value={tokenIn}
            onChange={setTokenIn}
            placeholder="Select token to redeem"
          />
        </div>

        {/* Token de Saída (redeemIn) */}
        <div className={styles.field}>
          <label className={styles.smallMuted}>Receive In</label>
          <select className={styles.select} value={redeemIn} onChange={(e) => setRedeemIn(e.target.value)}>
            <option value="">— Select —</option>
            {wone && <option value={wone}>wONE</option>}
            {usdc && <option value={usdc}>USDC</option>}
          </select>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.smallMuted}>Amount</label>
        <input
          className={styles.input}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          placeholder="e.g. 100"
          value={amountHuman}
          onChange={(e) => setAmountHuman(e.target.value)}
          disabled={isBusy}
        />
      </div>

      {/* Preview & Status */}
      {display && (
        <div className={styles.stackSm}>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Status</span>
            <span className={`${styles.contractFundsPill} ${display.statusCode === 'active' ? styles.statusOpen : display.statusCode === 'hold' ? styles.statusDelay : styles.statusPaused}`}>{display.statusLabel}</span>
          </div>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Fee</span>
            <span className={styles.contractFundsValue}>{display.feeText}</span>
          </div>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsLabel}>Will Receive</span>
            <span className={styles.contractFundsValue}>{display.receiveText}</span>
          </div>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Limit Before</span>
            <span className={styles.contractFundsSubValue}>{display.limitBeforeText}</span>
          </div>
          <div className={styles.contractFundsRow}>
            <span className={styles.contractFundsSubLabel}>Limit After</span>
            <span className={styles.contractFundsSubValue}>{display.limitAfterText}</span>
          </div>
        </div>
      )}

      {/* Razões de bloqueio */}
      {!!reasons?.length && (
        <div className={`${styles.alert} ${styles.warning}`}>
          <strong>Cannot proceed:</strong>
          <ul style={{ margin: '8px 0 0 16px' }}>
            {reasons.map((r, i) => (<li key={i}>{r}</li>))}
          </ul>
        </div>
      )}

      {/* Erro do hook */}
      {hookError && (
        <div className={`${styles.alert} ${styles.error}`}>{hookError}</div>
      )}

      {/* Ações */}
      <div className={styles.row}>
        <button type="button" className={styles.button} onClick={onPreview} disabled={!canPrepare || isBusy || !user || !tokenIn || !redeemIn || !amountHuman || holdInfo.isHold}>
          {state === 'preparing' ? 'Checking…' : 'Check'}
        </button>
        <button type="button" className={`${styles.button} ${styles.buttonAccent}`} onClick={onConfirm} disabled={!canExecute || isBusy || holdInfo.isHold}>
          {state === 'approving' ? 'Approving…' : state === 'redeeming' ? 'Redeeming…' : 'Confirm'}
        </button>
      </div>

      {/* reCAPTCHA invisível opcional */}
      {recaptchaSiteKey && (
        <ReCAPTCHA
          ref={recaptchaRef}
          size="invisible"
          sitekey={recaptchaSiteKey}
          onChange={(tok) => { setRecaptchaToken(tok || ""); dbg("recaptcha onChange", tok ? (tok.length + " chars") : "<empty>"); }}
        />
      )}

      {/* Resultado */}
      {state === 'success' && (
        <div className={`${styles.alert} ${styles.success}`}>
          Redeem submitted successfully.<br/>
          {receipts?.redeem?.transactionHash && (
            <span className={styles.smallMuted}>Tx: {receipts.redeem.transactionHash}</span>
          )}
        </div>
      )}
    </div>
  );
}
