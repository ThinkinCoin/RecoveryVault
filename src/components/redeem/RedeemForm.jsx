// src/components/redeem/RedeemForm.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers, formatUnits, parseUnits } from "ethers";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import * as vaultService from "@/services/vaultService";
import * as redeemService from "@/services/redeemService";
import { getFeeTiers, applyFeeForUsd } from "@/services/feeService";
import TokenSelect from "@/components/shared/TokenSelect";
import ReCAPTCHA from "react-google-recaptcha";
import useOnePrice from "@/hooks/useOnePrice";

// (opcional) helper de proof – se não existir, seguimos sem proof
let getProofFor = null;
try { ({ getProofFor } = require("@/helpers/proof")); } catch { /* noop */ }

function dbg(...a){ console.debug("[RedeemForm]", ...a); }

// Helpers defensivos ---------------------------------------------------------
function toArrayBalances(arrOrMap) {
  if (Array.isArray(arrOrMap)) return arrOrMap;
  if (arrOrMap && typeof arrOrMap === "object") return Object.values(arrOrMap);
  return [];
}

function coerceUsdInt(v) {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return 0n;
      return BigInt(Math.floor(v));
    }
    if (typeof v === "string") {
      if (v.trim() === "") return 0n;
      return BigInt(v);
    }
    if (v && typeof v === "object") {
      // tente chaves comuns
      for (const k of ["usd", "value", "amount", "amountUsd", "0"]) {
        if (v[k] != null) return coerceUsdInt(v[k]);
      }
    }
  } catch (_) {}
  return 0n;
}

const ERC20_MINI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];

export default function RedeemForm({ address }) {
  const { provider: ctxProvider } = useContractContext();
  const readProvider = useMemo(() => ctxProvider || vaultService.getDefaultProvider?.() || null, [ctxProvider]);

  // dados do cofre
  const [supportedTokens, setSupportedTokens] = useState([]); // [{address,decimals,symbol,fixedUsdPrice,oracleDecimals}]
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [vaultBalances, setVaultBalances] = useState({ woneBalance: 0n, usdcBalance: 0n });

  // formulário
  const [tokenIn, setTokenIn] = useState("");
  const [redeemIn, setRedeemIn] = useState("");
  const [amountHuman, setAmountHuman] = useState("");

  // saldos do usuário
  const [balances, setBalances] = useState(new Map());
  const selected = tokenIn ? balances.get(tokenIn.toLowerCase()) : null;
  const selectedBalance = selected?.raw ?? 0n;
  const selectedDecimals = selected?.decimals ?? 18;
  const selectedSymbol = selected?.symbol ?? "";

  // fee tiers
  const [tiers, setTiers] = useState({ thresholds: [], bps: [] });

  // preço ONE/USD (Band via hook)
  const { price: oneUsd, loading: oneLoading } = useOnePrice();

  // reCAPTCHA
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const recaptchaRef = useRef(null);

  // resumo local
  const [summary, setSummary] = useState({
    priceText: "",
    feeText: "",
    receiveText: "",
    tierText: "",
    limitText: "",
    sourceText: "",
  });

  // estado/erros
  const [busy, setBusy] = useState(false);
  const [uiNotice, setUiNotice] = useState(null); // {type:'error'|'warning'|'info'|'success',text:string}

  // carregar base do cofre
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) return;

        const [infos, w, u, bals, loadedTiers] = await Promise.all([
          redeemService.getSupportedTokenInfos(readProvider).catch(() => []),
          vaultService.wONE(readProvider).catch(() => ""),
          vaultService.usdc(readProvider).catch(() => ""),
          vaultService.getVaultBalances?.(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
          getFeeTiers(readProvider),
        ]);

        if (!alive) return;

        setSupportedTokens(infos || []);
        setWone(w || "");
        setUsdc(u || "");
        setVaultBalances(bals || { woneBalance: 0n, usdcBalance: 0n });
        setTiers(loadedTiers || { thresholds: [], bps: [] });

        if (u) {
          try {
            const erc = new ethers.Contract(u, ERC20_MINI, readProvider);
            const d = await erc.decimals();
            setUsdcDecimals(Number(d));
          } catch { setUsdcDecimals(6); }
        }

        if (!redeemIn) {
          if ((bals?.woneBalance ?? 0n) > 0n) setRedeemIn(w || "");
          else if ((bals?.usdcBalance ?? 0n) > 0n) setRedeemIn(u || "");
          else setRedeemIn(w || u || "");
        }
        if (!tokenIn && infos && infos[0]?.address) setTokenIn(infos[0].address);
      } catch (e) {
        console.warn("[RedeemForm] load base error:", e);
      }
    })();
    return () => { alive = false; };
  }, [readProvider]);

  // carregar saldos do usuário
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address) return;
        const raw = await redeemService.getUserBalances(readProvider, address);
        const arr = toArrayBalances(raw);
        if (!alive) return;
        const map = new Map(arr.map(i => [String(i.address).toLowerCase(), i]));
        setBalances(map);
      } catch (e) {
        console.warn("[RedeemForm] user balances error:", e);
      }
    })();
    return () => { alive = false; };
  }, [readProvider, address]);

  // “Max”: usa saldo do token selecionado
  const onMax = useCallback(() => {
    try {
      const human = formatUnits(selectedBalance ?? 0n, selectedDecimals ?? 18);
      setAmountHuman(human);
    } catch (e) {
      console.warn("[RedeemForm] onMax error:", e);
    }
  }, [selectedBalance, selectedDecimals]);

  // Atualiza o resumo (USD via serviço, aplica fee, converte para wONE/USDC)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setSummary({ priceText:"", feeText:"", receiveText:"", tierText:"", limitText:"", sourceText:"" });

        if (!readProvider || !tokenIn || !redeemIn) return;
        if (!amountHuman || Number(amountHuman) <= 0) return;

        const decIn = selectedDecimals;
        const amountIn = parseUnits(String(amountHuman), decIn);

        // USD inteiro antes da fee
        const usdBeforeRaw = await redeemService.getUsdValue(readProvider, tokenIn, amountIn);
        const usdBeforeFee = coerceUsdInt(usdBeforeRaw);
        if (usdBeforeFee === 0n) {
          setSummary((s) => ({ ...s, priceText: "Price unavailable" }));
          return;
        }

        // aplica fee ao amountIn (em tokenIn), escolhendo tier por USD
        const { feeAmount, refundAmount, bps } = applyFeeForUsd(amountIn, Number(usdBeforeFee), tiers);

        // USD depois da fee
        const usdAfterRaw = await redeemService.getUsdValue(readProvider, tokenIn, refundAmount);
        const usdAfterFee = coerceUsdInt(usdAfterRaw);

        // textos
        const feeText = `${formatUnits(feeAmount, decIn)} ${selectedSymbol || "TOKEN"}`;

        // preço aproximado (USD por token)
        let priceText = "";
        const humanIn = Number(formatUnits(amountIn, decIn));
        if (humanIn > 0) {
          const usdPerToken = Number(usdBeforeFee) / humanIn;
          if (Number.isFinite(usdPerToken)) {
            priceText = `Price: ~${usdPerToken.toFixed(4)} USD per ${selectedSymbol || "TOKEN"}`;
          }
        }

        // Will Receive
        let receiveText = "";
        if (redeemIn && wone && redeemIn.toLowerCase() === wone.toLowerCase()) {
          if (!oneLoading && oneUsd && Number(oneUsd) > 0) {
            const onePerUsd = 1 / Number(oneUsd);
            const recvOneFloat = Number(usdAfterFee) * onePerUsd;
            if (Number.isFinite(recvOneFloat)) {
              const recvOneRaw = BigInt(Math.floor(recvOneFloat * 1e18));
              receiveText = `${formatUnits(recvOneRaw, 18)} wONE`;
            } else {
              receiveText = "wONE amount: waiting price…";
            }
          } else {
            receiveText = "wONE amount: waiting price…";
          }
        } else if (redeemIn && usdc && redeemIn.toLowerCase() === usdc.toLowerCase()) {
          const recvUsdcRaw = usdAfterFee * (10n ** BigInt(usdcDecimals));
          receiveText = `${formatUnits(recvUsdcRaw, usdcDecimals)} USDC`;
        }

        const tierText = `Fee Tier: ${(bps/100).toFixed(2)}%`;
        const sourceText = "Quote: local (fixed prices + fee tier)";

        if (!alive) return;
        setSummary({ priceText, feeText, receiveText, tierText, limitText: "", sourceText });
      } catch (e) {
        console.warn("[RedeemForm] summary error:", e);
        if (alive) setSummary({ priceText:"", feeText:"", receiveText:"", tierText:"", limitText:"", sourceText:"" });
      }
    })();
    return () => { alive = false; };
  }, [readProvider, tokenIn, redeemIn, amountHuman, selectedDecimals, selectedSymbol, tiers, wone, usdc, usdcDecimals, oneUsd, oneLoading]);

  // Confirm: reCAPTCHA -> approve (se necessário) -> redeem
  const onConfirm = useCallback(async () => {
    try {
      setUiNotice(null);
      setBusy(true);

      if (!readProvider) throw new Error("Provider not ready");
      if (!address) throw new Error("Connect a wallet");
      if (!tokenIn) throw new Error("Select a token");
      if (!redeemIn) throw new Error("Select wONE or USDC");
      if (!amountHuman || Number(amountHuman) <= 0) throw new Error("Enter an amount");

      // reCAPTCHA (se configurado)
      if (recaptchaSiteKey && recaptchaRef.current) {
        const tok = await recaptchaRef.current.executeAsync();
        recaptchaRef.current.reset();
        if (!tok) throw new Error("reCAPTCHA validation failed");
      }

      // prova (se existir helper); senão vazio
      const proof = typeof getProofFor === "function" ? (await getProofFor(address)) : [];

      // amountIn
      const decIn = selectedDecimals;
      const amountIn = parseUnits(String(amountHuman), decIn);

      // endereço do cofre
      let vaultAddr =
        (await vaultService.address?.(readProvider)) ||
        (await vaultService.getAddress?.(readProvider)) ||
        vaultService.VAULT_ADDRESS ||
        import.meta.env.VITE_VAULT_ADDRESS ||
        "";
      if (typeof vaultAddr !== "string" || !vaultAddr) {
        throw new Error("Vault address not configured");
      }
      vaultAddr = ethers.getAddress(vaultAddr); // checksum/validação

      // approve se necessário
      const erc = new ethers.Contract(tokenIn, ERC20_MINI, readProvider);
      const allowance = await erc.allowance(address, vaultAddr);
      if (allowance < amountIn) {
        const signer = await ctxProvider?.getSigner?.();
        if (!signer) throw new Error("Connect a wallet to approve");
        const txA = await erc.connect(signer).approve(vaultAddr, amountIn);
        await txA.wait();
      }

      // executar redeem via vaultService (se disponível) ou fallback direto
      const signer = await ctxProvider?.getSigner?.();
      if (!signer) throw new Error("Connect a wallet to proceed");

      if (typeof vaultService.redeem === "function") {
        await vaultService.redeem(signer, { user: address, tokenIn, amount: amountIn, redeemIn, proof });
      } else {
        // Fallback direto no contrato – tente duas assinaturas possíveis
        // 1) redeem(tokenIn, redeemIn, amount, proof)
        const ABI1 = [
          "function redeem(address tokenIn, address redeemIn, uint256 amount, bytes32[] proof) external",
        ];
        const vault1 = new ethers.Contract(vaultAddr, ABI1, signer);
        try {
          const tx = await vault1.redeem(tokenIn, redeemIn, amountIn, proof);
          await tx.wait();
        } catch (e1) {
          // 2) redeem(user, tokenIn, amount, redeemIn, proof)
          const ABI2 = [
            "function redeem(address user, address tokenIn, uint256 amount, address redeemIn, bytes32[] proof) external",
          ];
          const vault2 = new ethers.Contract(vaultAddr, ABI2, signer);
          const tx2 = await vault2.redeem(address, tokenIn, amountIn, redeemIn, proof);
          await tx2.wait();
        }
      }

      setUiNotice({ type: "success", text: "Redeem submitted successfully." });
      setAmountHuman("");

      // refresh saldos
      try {
        const raw = await redeemService.getUserBalances(readProvider, address);
        const arr = toArrayBalances(raw);
        const map = new Map(arr.map(i => [String(i.address).toLowerCase(), i]));
        setBalances(map);
      } catch {}
    } catch (e) {
      console.error("[RedeemForm] onConfirm error:", e);
      setUiNotice({ type: "error", text: e?.shortMessage || e?.reason || e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [readProvider, ctxProvider, address, tokenIn, redeemIn, amountHuman, recaptchaSiteKey, selectedDecimals]);

  // flags de botão redeemIn
  const hasWone = (vaultBalances?.woneBalance ?? 0n) > 0n;
  const hasUsdc = (vaultBalances?.usdcBalance ?? 0n) > 0n;

  // disabled do Confirm
  const confirmDisabled = useMemo(() => {
    if (busy) return true;
    if (!address || !tokenIn || !redeemIn) return true;
    if (!amountHuman || Number(amountHuman) <= 0) return true;
    return false;
  }, [busy, address, tokenIn, redeemIn, amountHuman]);

  return (
    <div className={styles.contractRedeemCard}>
      <div className={styles.contractRedeemHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>Redeem</h3>
      </div>

      {uiNotice && (
        <div className={`${styles.alert} ${
          uiNotice.type === "error"
            ? styles.error
            : uiNotice.type === "warning"
            ? styles.warning
            : uiNotice.type === "success"
            ? styles.success
            : styles.info
        }`}>
          {uiNotice.text}
        </div>
      )}

      <div className={styles.grid2}>
        {/* Token In */}
        <div className={styles.field}>
          <label className={styles.smallMuted}>Token In</label>
          <TokenSelect
            tokens={supportedTokens}
            value={tokenIn}
            onChange={(v) => { dbg("TokenSelect onChange", v); setTokenIn(v); }}
            placeholder="Select token to redeem"
          />
          {!!tokenIn && selected && (
            <div className={styles.smallMuted}>
              Balance: {formatUnits(selectedBalance, selectedDecimals)} {selectedSymbol}
            </div>
          )}
        </div>

        {/* Receive In */}
        <div className={styles.field}>
          <label className={styles.smallMuted}>Receive In</label>
          <div className={styles.row}>
            {wone && (
              <button
                type="button"
                className={`${styles.button} ${redeemIn === wone ? styles.buttonActive : ""}`}
                onClick={() => setRedeemIn(wone)}
                disabled={!hasWone}
                title={!hasWone ? "Vault has no wONE available" : undefined}
              >
                wONE
              </button>
            )}
            {usdc && (
              <button
                type="button"
                className={`${styles.button} ${redeemIn === usdc ? styles.buttonActive : ""}`}
                onClick={() => setRedeemIn(usdc)}
                disabled={!hasUsdc}
                title={!hasUsdc ? "Vault has no USDC available" : undefined}
              >
                USDC
              </button>
            )}
            {(!hasWone && !hasUsdc) && (
              <span className={styles.smallMuted}>Vault has no funds available.</span>
            )}
          </div>
        </div>
      </div>

      {/* Amount + Max */}
      <div className={styles.field}>
        <label className={styles.smallMuted}>Amount</label>
        <div className={styles.row}>
          <input
            className={styles.input}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            placeholder="e.g. 100"
            value={amountHuman}
            onChange={(e) => setAmountHuman(e.target.value)}
            disabled={busy}
          />
          <button type="button" className={styles.button} onClick={onMax} disabled={!address || !tokenIn || busy}>
            Max
          </button>
        </div>
      </div>

      {/* Resumo/preview local */}
      {(summary.priceText || summary.feeText || summary.receiveText || summary.tierText || summary.limitText || summary.sourceText) && (
        <div className={styles.card} style={{ marginTop: 8 }}>
          {summary.sourceText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemSubLabel}>Source</span>
              <span className={styles.contractRedeemSubValue}>{summary.sourceText}</span>
            </div>
          )}
          {summary.priceText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Price</span>
              <span className={styles.contractRedeemValue}>{summary.priceText}</span>
            </div>
          )}
          {summary.tierText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Fee Tier</span>
              <span className={styles.contractRedeemValue}>{summary.tierText}</span>
            </div>
          )}
          {summary.feeText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Fee</span>
              <span className={styles.contractRedeemValue}>{summary.feeText}</span>
            </div>
          )}
          {summary.receiveText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Will Receive</span>
              <span className={styles.contractRedeemValue}>{summary.receiveText}</span>
            </div>
          )}
          {summary.limitText && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemSubLabel}>User Limit</span>
              <span className={styles.contractRedeemSubValue}>{summary.limitText}</span>
            </div>
          )}
        </div>
      )}

      {/* Ação */}
      <div className={`${styles.contractRedeemRow}`} style={{ marginTop: 12, marginBottom: 12 }}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonAccent}`}
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {busy ? "Processing…" : "Confirm"}
        </button>
      </div>

      {/* reCAPTCHA invisível */}
      {recaptchaSiteKey && (
        <ReCAPTCHA
          ref={recaptchaRef}
          size="invisible"
          sitekey={recaptchaSiteKey}
        />
      )}
    </div>
  );
}
