import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers, formatUnits, parseUnits } from "ethers";
import { buildGasFees, GAS_LIMIT_FALLBACK, ensureLegacyOverrides } from "@/services/txUtils";
import * as redeemService from "@/services/redeemService";
import { useAppKitAccount } from "@reown/appkit/react";
import { getActiveWalletProvider } from "@/services/appkit";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import * as vaultService from "@/services/vaultService";
import TokenSelect from "@/components/shared/TokenSelect";
import ReCAPTCHA from "react-google-recaptcha";
import { preloadProofs, useWhitelist } from "@/services/whitelistService";
import { preflightAmountAgainstLimit, quoteAmountUsd18, fetchRemainingUsd18 } from "@/services/limitsService";
import LoadConsole from "@/components/shared/LoadConsole";
import { log as debugLog, ok as debugOk, warn as debugWarn, error as debugError } from "@/debug/logger";
import OracleDebugPanel from "@/components/OracleDebugPanel";

const FN_REDEEM_CANDIDATES = ["redeem(address,uint256,address,bytes32[])"];

function friendlySimError(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("address not whitelisted")) return "Address not whitelisted";
  if (
    t.includes("exceeds daily limit") ||
    t.includes("insufficient remaining daily limit") ||
    t.includes("amount exceeds daily limit")
  ) return "Insufficient remaining daily limit";
  if (t.includes("missing revert data")) return "Execution reverted (no reason). Check args/signature.";
  if (t.includes("execution reverted")) return "Execution reverted";
  return text || "Simulation failed";
}

const ERC20_MINI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];

const VAULT_READ_ABI = ["function fixedUsdPrice(address token) view returns (uint256)"];

export default function RedeemForm({ address: addressProp }) {
  const { provider: ctxProvider, signer: ctxSigner } = useContractContext();
  const { isConnected, address: appkitAddress } = useAppKitAccount({ namespace: "eip155" });

  const readProvider = useMemo(() => ctxProvider || vaultService.getDefaultProvider?.(), [ctxProvider]);
  const address = useMemo(() => addressProp || appkitAddress || "", [addressProp, appkitAddress]);

  const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
  const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`.toLowerCase();
  const RPC_URL = (import.meta.env.VITE_RPC_URL_HARMONY?.trim() || import.meta.env.VITE_RPC_URL?.trim() || "https://api.harmony.one");

  async function ensureHarmony() {
    const prov = await getActiveWalletProvider?.();
    if (!prov?.request) return;
    const current = await prov.request({ method: "eth_chainId" }).catch(() => null);
    if (String(current).toLowerCase() === CHAIN_ID_HEX) return;
    try {
      await prov.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (err) {
      if (err?.code === 4902) {
        await prov.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_ID_HEX, chainName: "Harmony Mainnet", rpcUrls: [RPC_URL], nativeCurrency: { name: "ONE", symbol: "ONE", decimals: 18 }, blockExplorerUrls: ["https://explorer.harmony.one/"] }] });
        await prov.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
      } else {
        throw new Error("Please switch your wallet to Harmony network and try again.");
      }
    }
  }

  const [supportedTokens, setSupportedTokens] = useState([]);
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [vaultBalances, setVaultBalances] = useState({ woneBalance: 0n, usdcBalance: 0n });

  const [tokenIn, setTokenIn] = useState("");
  const [redeemIn, setRedeemIn] = useState("");
  const [amountHuman, setAmountHuman] = useState("");

  const [balances, setBalances] = useState(new Map());
  const selected = tokenIn ? balances.get(tokenIn.toLowerCase()) : null;
  const selectedBalance = selected?.raw ?? 0n;
  const selectedDecimals = selected?.decimals ?? 18;
  const selectedSymbol = selected?.symbol ?? "";

  const [fixedPriceText, setFixedPriceText] = useState("");

  const [limitUSD18, setLimitUSD18] = useState(0n);
  const [limitLoaded, setLimitLoaded] = useState(false);
  const [amountUSD18, setAmountUSD18] = useState(0n);

  const [receivePreview, setReceivePreview] = useState(null);

  const [busy, setBusy] = useState(false);
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);
  const [bootOpen, setBootOpen] = useState(true);
  const [bootLogs, setBootLogs] = useState([]);
  const [bootStepsDone, setBootStepsDone] = useState(0);
  const TOTAL_STEPS = 6;
  const addLog = useCallback((msg, level = "info") => { setBootLogs((prev) => [...prev, { ts: Date.now(), msg, level }]); }, []);
  const stepOk = useCallback((msg) => { addLog(msg, "ok"); setBootStepsDone((s) => s + 1); }, [addLog]);
  const stepWarn = useCallback((msg) => { addLog(msg, "warn"); setBootStepsDone((s) => s + 1); }, [addLog]);
  const stepErr = useCallback((msg) => { addLog(msg, "error"); setBootStepsDone((s) => s + 1); }, [addLog]);

  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const RECAPTCHA_ENABLED = import.meta.env.VITE_ENABLE_RECAPTCHA === "true";
  const recaptchaRef = useRef(null);

  useEffect(() => { preloadProofs().catch(() => {}); }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) return;
        setLoadingBase(true);
        addLog("Initializing vault data…");
        addLog("Fetching supported tokens…");
        debugLog("RedeemForm: fetching supported tokens…");
        const [sup, w, u, bals] = await Promise.all([
          vaultService.getSupportedTokens?.(readProvider).catch(() => []),
          vaultService.wONE?.(readProvider).catch(() => ""),
          vaultService.usdc?.(readProvider).catch(() => ""),
          vaultService.getVaultBalances?.(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
        ]);
        if (!alive) return;
        const supArr = Array.isArray(sup) ? sup.filter(Boolean) : [];
        stepOk(`Supported tokens: ${Array.isArray(sup) ? sup.length : 0}`);
        debugOk(`RedeemForm: supported tokens loaded (${supArr.length})`);
        setSupportedTokens(supArr);
        setWone(w || "");
        setUsdc(u || "");
        setVaultBalances(bals || { woneBalance: 0n, usdcBalance: 0n });
        stepOk("Core addresses/balances loaded");
        if (u) {
          try {
            const erc = new ethers.Contract(u, ERC20_MINI, readProvider);
            const d = await erc.decimals();
            setUsdcDecimals(Number(d) || 6);
          } catch {
            setUsdcDecimals(6);
            stepWarn("USDC decimals fetch failed: using default 6");
            debugWarn("USDC decimals fetch failed: defaulting to 6");
          }
        }
        if (!redeemIn) {
          if ((bals?.woneBalance ?? 0n) > 0n) setRedeemIn(w || "");
          else if ((bals?.usdcBalance ?? 0n) > 0n) setRedeemIn(u || "");
          else setRedeemIn(w || u || "");
        }
        if (!tokenIn && supArr[0]) setTokenIn(supArr[0]);
      } catch (e) {
        stepErr(`Base load error: ${e?.message || String(e)}`);
        debugError(`Base load error: ${e.message}`);
      } finally {
        if (alive) setLoadingBase(false);
      }
    })();
    return () => { alive = false; };
  }, [readProvider]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address || supportedTokens.length === 0) return;
        setLoadingBalances(true);
        addLog("Loading your token balances…");
        const entries = await Promise.all(
          supportedTokens.map(async (addr) => {
            try {
              const erc = new ethers.Contract(addr, ERC20_MINI, readProvider);
              const [dec, sym, bal] = await Promise.all([
                erc.decimals(),
                erc.symbol().catch(() => "TOKEN"),
                erc.balanceOf(address).catch(() => 0n),
              ]);
              return [addr.toLowerCase(), { raw: bal ?? 0n, decimals: Number(dec) || 18, symbol: String(sym || "TOKEN") }];
            } catch {
              return [addr.toLowerCase(), { raw: 0n, decimals: 18, symbol: "TOKEN" }];
            }
          })
        );
        if (!alive) return;
        setBalances(new Map(entries));
        stepOk("Balances loaded");
      } finally {
        if (alive) setLoadingBalances(false);
      }
    })();
    return () => { alive = false; };
  }, [readProvider, address, supportedTokens]);

  useEffect(() => {
    (async () => {
      if (!readProvider || !address || !tokenIn) return;
      const key = tokenIn.toLowerCase();
      if (balances.has(key)) return;
      try {
        const erc = new ethers.Contract(tokenIn, ERC20_MINI, readProvider);
        const [dec, sym, bal] = await Promise.all([
          erc.decimals(),
          erc.symbol().catch(() => "TOKEN"),
          erc.balanceOf(address).catch(() => 0n),
        ]);
        setBalances((prev) => {
          const copy = new Map(prev);
          copy.set(key, { raw: bal ?? 0n, decimals: Number(dec) || 18, symbol: String(sym || "TOKEN") });
          return copy;
        });
      } catch {}
    })();
  }, [readProvider, address, tokenIn, balances]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setFixedPriceText("");
        if (!readProvider || !tokenIn) return;
        const vaultAddr = vaultService.getVaultAddress?.() || import.meta.env.VITE_VAULT_ADDRESS || "";
        if (!vaultAddr) return;
        const c = new ethers.Contract(vaultAddr, VAULT_READ_ABI, readProvider);
        const p = await c.fixedUsdPrice(tokenIn).catch(() => 0n);
        const txt = formatUnits(p ?? 0n, 18);
        if (!alive) return;
        if (p && p !== 0n) {
          const num = Number(txt);
          setFixedPriceText(Number.isFinite(num) ? `$${num.toFixed(6)}` : `$${txt}`);
        } else {
          setFixedPriceText("");
        }
      } catch {
        if (alive) setFixedPriceText("");
      }
    })();
    return () => { alive = false; };
  }, [readProvider, tokenIn]);

  const { loading: wlLoading, ok: wlOk, error: wlError, proof: wlProof } = useWhitelist(address, readProvider);
  const bootBusy = loadingBase || loadingBalances || wlLoading || (!limitLoaded && !!address);
  const bootProgress = Math.min(100, Math.round((bootStepsDone / TOTAL_STEPS) * 100));

  useEffect(() => {
    if (!address || !readProvider) return;
    if (wlLoading) addLog("Checking whitelist status…");
    else if (wlOk) stepOk("Whitelist: OK");
    else if (wlError) stepWarn(`Whitelist: ${wlError}`);
  }, [wlLoading, wlOk, wlError, address, readProvider]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address) return;
        addLog("Fetching remaining daily limit…");
        const rem = await fetchRemainingUsd18(readProvider, address);
        if (alive) setLimitUSD18(rem);
        if (alive) stepOk("Limit loaded");
      } catch {
        if (alive) setLimitUSD18(0n);
        stepWarn("Unable to fetch remaining limit");
      } finally {
        if (alive) setLimitLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [readProvider, address]);

  useEffect(() => {
    (async () => {
      try {
        if (!readProvider || !tokenIn || !amountHuman || Number(amountHuman) <= 0) {
          setAmountUSD18(0n);
          return;
        }
        const usd18 = await quoteAmountUsd18(readProvider, tokenIn, amountHuman, selectedDecimals);
        setAmountUSD18(usd18);
      } catch {
        setAmountUSD18(0n);
      }
    })();
  }, [readProvider, tokenIn, amountHuman, selectedDecimals]);

  // ------ Preview (on-chain quando possível; senão, fallback local) ------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setReceivePreview(null);
        if (!readProvider || !address || !tokenIn || !redeemIn) return;
        if (!amountHuman || Number(amountHuman) <= 0) return;

        const amountIn = parseUnits(String(amountHuman), selectedDecimals);

        // 1) On-chain SE whitelist ok
        let done = false;
        if (wlOk) {
          const proof = wlProof || [];
          const q = await vaultService
            .quoteRedeem(readProvider, address, tokenIn, amountIn, redeemIn, proof)
            .catch(() => null);
          if (alive && q) {
            const outDec = typeof q.redeemInDecimals === "number"
              ? q.redeemInDecimals
              : (redeemIn && usdc && redeemIn.toLowerCase() === usdc.toLowerCase())
                ? usdcDecimals
                : 18;
            const outSym = (redeemIn && usdc && redeemIn.toLowerCase() === usdc.toLowerCase()) ? "USDC" : "wONE";
            setReceivePreview({
              raw: q.amountOutRedeemToken ?? 0n,
              decimals: outDec,
              symbol: outSym,
              feeAmountInTokenIn: q.feeAmountInTokenIn ?? 0n,
              burnAmountInTokenIn: q.burnAmountInTokenIn ?? 0n,
              maxOut: q.amountOutRedeemToken ?? 0n,
            });
            done = true;
          }
        }

        // 2) Fallback local (preview) se não rolou on-chain
        if (!done && alive) {
          const { usd, fee, refund } = await redeemService
            .localQuote(readProvider, tokenIn, amountIn)
            .catch(() => ({ usd: 0n, fee: 0n, refund: 0n }));
          const outIsUSDC = (redeemIn && usdc && redeemIn.toLowerCase() === usdc.toLowerCase());
          const outDec = outIsUSDC ? (usdcDecimals || 6) : 18;
          const outSym = outIsUSDC ? "USDC" : "wONE";

          // USD líquido proporcional após taxa (apenas informativo)
          let usdNet = 0n;
          if (amountIn > 0n && usd > 0n) {
            usdNet = (usd * refund) / amountIn;
          }

          let amountOut = 0n;
          if (outIsUSDC) {
            amountOut = usdNet * (10n ** BigInt(outDec));
          } else {
            const { price = 0n, decimals = 18 } = await vaultService.oracleLatest(readProvider).catch(() => ({ price: 0n, decimals: 18 }));
            if (price > 0n && usdNet > 0n) {
              amountOut = (usdNet * (10n ** BigInt(decimals)) * (10n ** 18n)) / price;
            }
          }

          if (!alive) return;
          setReceivePreview({
            raw: amountOut,                // informativo
            decimals: outDec,
            symbol: outSym,
            feeAmountInTokenIn: fee ?? 0n, // informativo; contrato calcula de verdade
            burnAmountInTokenIn: 0n,
            maxOut: amountOut,
          });
        }
      } catch {
        if (alive) setReceivePreview(null);
      }
    })();
    return () => { alive = false; };
  }, [readProvider, address, tokenIn, redeemIn, amountHuman, selectedDecimals, wlProof, usdc, usdcDecimals, wlOk]);

  const onMax = useCallback(() => {
    try {
      const human = formatUnits(selectedBalance ?? 0n, selectedDecimals ?? 18);
      setAmountHuman(human);
    } catch {}
  }, [selectedBalance, selectedDecimals]);

  const onConfirm = useCallback(async () => {
    try {
      setUiNotice(null);
      setBusy(true);
      if (!readProvider) throw new Error("Provider not ready");
      if (!isConnected || !address) throw new Error("Connect a wallet");
      if (!ctxSigner) throw new Error("Connect a wallet to proceed");
      await ensureHarmony();
      if (!tokenIn) throw new Error("Select a token");
      if (!redeemIn) throw new Error("Select wONE or USDC");
      if (!amountHuman || Number(amountHuman) <= 0) throw new Error("Enter an amount");
      if (RECAPTCHA_ENABLED && recaptchaSiteKey && recaptchaRef.current) {
        let tok = null;
        try { tok = await recaptchaRef.current.executeAsync(); } finally { recaptchaRef.current.reset(); }
        if (!tok) throw new Error("reCAPTCHA validation failed");
      }
      const amountIn = parseUnits(String(amountHuman), selectedDecimals);
      if (selectedBalance != null && BigInt(amountIn) > BigInt(selectedBalance)) {
        throw new Error("Insufficient balance for selected token");
      }
      const pre = await preflightAmountAgainstLimit(readProvider, address, tokenIn, amountHuman, selectedDecimals);
      if (pre?.amountUSD18 != null) setAmountUSD18(pre.amountUSD18);
      if (pre?.remainingUSD18 != null) setLimitUSD18(pre.remainingUSD18);
      if (!pre.ok || (pre.amountUSD18 ?? 0n) >= (pre.remainingUSD18 ?? 0n)) {
        throw new Error("Insufficient remaining daily limit");
      }
      let vaultAddr = vaultService.getVaultAddress?.() || import.meta.env.VITE_VAULT_ADDRESS || "";
      if (typeof vaultAddr !== "string" || !vaultAddr) throw new Error("Vault address not configured");
      vaultAddr = ethers.getAddress(vaultAddr);
      if (!wlOk) throw new Error(wlError || "Address not whitelisted");
      const proof = wlProof || [];
      const erc = new ethers.Contract(tokenIn, ERC20_MINI, readProvider);
      const allowance = await erc.allowance(address, vaultAddr);
      if (allowance < amountIn) {
        const fee = await buildGasFees(ctxSigner.provider);
        const approveOverrides = ensureLegacyOverrides({ ...fee, gasLimit: GAS_LIMIT_FALLBACK });
        const txA = await erc.connect(ctxSigner).approve(vaultAddr, amountIn, approveOverrides);
        await txA.wait();
      }
      const signer = ctxSigner;
      let lastReason = "";
      for (const sig of FN_REDEEM_CANDIDATES) {
        let args;
        switch (sig) {
          case "redeem(address,uint256,address,bytes32[])":
            args = [tokenIn, amountIn, redeemIn, proof];
            break;
          default:
            continue;
        }
        const sent = await vaultService.submitRedeem(
          signer,
          { fn: sig, args },
          { fallbackGas: GAS_LIMIT_FALLBACK }
        );
        if (!sent.ok) {
          if (sent.rejected) { setUiNotice({ type: "warning", text: "Transaction rejected by user" }); return; }
          lastReason = sent.reason || "";
          continue;
        }
        setUiNotice({ type: "success", text: `Redeem submitted. Tx: ${sent.tx.hash}` });
        await sent.tx.wait();
        setUiNotice({ type: "success", text: "Redeem confirmed." });
        setAmountHuman("");
        try {
          if (readProvider && address && supportedTokens.length > 0) {
            const refreshed = await Promise.all(
              supportedTokens.map(async (addr) => {
                try {
                  const erc2 = new ethers.Contract(addr, ERC20_MINI, readProvider);
                  const [dec, sym, bal] = await Promise.all([
                    erc2.decimals(),
                    erc2.symbol().catch(() => "TOKEN"),
                    erc2.balanceOf(address).catch(() => 0n),
                  ]);
                  return [addr.toLowerCase(), { raw: bal ?? 0n, decimals: Number(dec) || 18, symbol: String(sym || "TOKEN") }];
                } catch {
                  return [addr.toLowerCase(), { raw: 0n, decimals: 18, symbol: "TOKEN" }];
                }
              })
            );
            setBalances(new Map(refreshed));
          }
        } catch {}
        return;
      }
      setUiNotice({ type: "error", text: friendlySimError(lastReason || "Redeem not possible at the moment") });
    } catch (e) {
      const raw = e?.data?.message || e?.error?.message || e?.shortMessage || e?.reason || e?.message || String(e);
      setUiNotice({ type: "error", text: friendlySimError(raw) });
    } finally {
      setBusy(false);
    }
  }, [readProvider, ctxSigner, isConnected, address, tokenIn, redeemIn, amountHuman, recaptchaSiteKey, selectedDecimals, supportedTokens, selectedBalance, wlOk, wlError, wlProof]);

  const hasWone = (vaultBalances?.woneBalance ?? 0n) > 0n;
  const hasUsdc = (vaultBalances?.usdcBalance ?? 0n) > 0n;

  const confirmDisabled = useMemo(() => {
    if (busy) return true;
    if (!isConnected || !address || !ctxSigner || !tokenIn || !redeemIn) return true;
    if (!amountHuman || Number(amountHuman) <= 0) return true;
    if (!wlLoading && !wlOk) return true;
    if (amountUSD18 !== 0n && limitUSD18 !== 0n && amountUSD18 >= limitUSD18) return true;
    return false;
  }, [busy, isConnected, address, ctxSigner, tokenIn, redeemIn, amountHuman, wlLoading, wlOk, amountUSD18, limitUSD18]);

  const isLoading = loadingBase || loadingBalances;

  return (
    <div className={styles.contractRedeemCard}>
      <LoadConsole
        open={bootOpen && (bootBusy || bootLogs.length > 0)}
        title="Preparing Vault"
        logs={bootLogs}
        busy={bootBusy}
        progress={bootBusy ? bootProgress : null}
        onClose={() => setBootOpen(false)}
      />
      <div className={styles.contractRedeemHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>Redeem</h3>
      </div>
      {isLoading && (
        <div className={`${styles.alert} ${styles.info}`} style={{ marginBottom: 12 }}>
          Loading vault data{loadingBalances ? " & balances" : ""}…
        </div>
      )}
      {uiNotice && (
        <div className={`${styles.alert} ${uiNotice.type === "error" ? styles.error : uiNotice.type === "warning" ? styles.warning : uiNotice.type === "success" ? styles.success : styles.info}`}>{uiNotice.text}</div>
      )}
      {!wlLoading && !wlOk && (
        <div className={`${styles.alert} ${styles.warning}`} style={{ marginBottom: 12 }}>
          {wlError || "Address not whitelisted"}
        </div>
      )}
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label className={styles.smallMuted}>Token In</label>
          <TokenSelect tokens={supportedTokens} value={tokenIn} onChange={setTokenIn} placeholder="Select token to redeem" />
          {!!tokenIn && selected && (
            <div className={styles.smallMuted}>Balance: {formatUnits(selectedBalance, selectedDecimals)} {selectedSymbol}</div>
          )}
        </div>
        <div className={styles.field}>
          <label className={styles.smallMuted}>Receive In</label>
          <div className={styles.row}>
            {wone && (
              <button type="button" className={`${styles.button} ${redeemIn === wone ? styles.buttonActive : ""}`} onClick={() => setRedeemIn(wone)} disabled={!hasWone} title={!hasWone ? "Vault has no wONE available" : undefined}>wONE</button>
            )}
            {usdc && (
              <button type="button" className={`${styles.button} ${redeemIn === usdc ? styles.buttonActive : ""}`} onClick={() => setRedeemIn(usdc)} disabled={!hasUsdc} title={!hasUsdc ? "Vault has no USDC available" : undefined}>USDC</button>
            )}
            {!hasWone && !hasUsdc && <span className={styles.smallMuted}>Vault has no funds available.</span>}
          </div>
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.smallMuted}>Amount</label>
        <div className={styles.row}>
          <input className={styles.input} type="number" min={0} step="any" inputMode="decimal" placeholder="e.g. 100" value={amountHuman} onChange={(e) => setAmountHuman(e.target.value)} disabled={busy} />
          <button type="button" className={styles.button} onClick={onMax} disabled={!isConnected || !address || !tokenIn || busy}>Max</button>
        </div>
      </div>
      <div className={styles.contractRedeemButtonRow}>
        <button type="button" className={`${styles.button} ${styles.buttonConfirm} ${styles.buttonAccent} ${confirmDisabled ? styles.buttonDisabled : ""}`} onClick={onConfirm} disabled={confirmDisabled}>{busy ? "Processing…" : "Confirm"}</button>
      </div>
      {receivePreview && (
        <div className={styles.contractRedeemCardInner}>
          <h4 className={styles.contractRedeemTitle}>Operation preview</h4>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Will receive</span>
            <span className={styles.contractRedeemValue}>{formatUnits(receivePreview.raw, receivePreview.decimals)} {receivePreview.symbol}</span>
          </div>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Fee amount</span>
            <span className={styles.contractRedeemValue}>{formatUnits(receivePreview.feeAmountInTokenIn ?? 0n, selectedDecimals)} {selectedSymbol}</span>
          </div>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Max receive</span>
            <span className={styles.contractRedeemValue}>{formatUnits(receivePreview.maxOut ?? receivePreview.raw, receivePreview.decimals)} {receivePreview.symbol}</span>
          </div>
          {!!fixedPriceText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Fixed price</span>
              <span className={styles.contractRedeemValue}>{fixedPriceText}</span>
            </div>
          )}
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Daily limit after</span>
            <span className={styles.contractRedeemValue}>{(() => { const rem = limitUSD18 ?? 0n; const amt = amountUSD18 ?? 0n; const after = rem > amt ? (rem - amt) : 0n; return `$${Number(formatUnits(after, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}`; })()}</span>
          </div>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Amount burned</span>
            <span className={styles.contractRedeemValue}>{formatUnits(receivePreview.burnAmountInTokenIn ?? 0n, selectedDecimals)} {selectedSymbol}</span>
          </div>
        </div>
      )}
      <OracleDebugPanel />
      {RECAPTCHA_ENABLED && recaptchaSiteKey && <ReCAPTCHA ref={recaptchaRef} size="invisible" sitekey={recaptchaSiteKey} />}
    </div>
  );
}
