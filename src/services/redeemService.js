// src/components/redeem/RedeemForm.jsx
// All logs/messages in English only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers, formatUnits, parseUnits } from "ethers";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import * as vaultService from "@/services/vaultService";
import * as redeemService from "@/services/redeemService";
import TokenSelect from "@/components/shared/TokenSelect";
import ReCAPTCHA from "react-google-recaptcha";
import useOnePrice from "@/hooks/useOnePrice";

// Optional proof helper – if not present, we proceed without proof
let getProofFor = null;
try { ({ getProofFor } = require("@/helpers/proof")); } catch { /* noop */ }

function dbg(...a) { console.debug("[RedeemForm]", ...a); }

// Convert array or map to an array
function toArrayBalances(arrOrMap) {
  if (Array.isArray(arrOrMap)) return arrOrMap;
  if (arrOrMap && typeof arrOrMap === "object") return Object.values(arrOrMap);
  return [];
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

  // Vault base data
  const [supportedTokens, setSupportedTokens] = useState([]); // [{address,decimals,symbol}]
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [vaultBalances, setVaultBalances] = useState({ woneBalance: 0n, usdcBalance: 0n });

  // Form
  const [tokenIn, setTokenIn] = useState("");
  const [redeemIn, setRedeemIn] = useState("");
  const [amountHuman, setAmountHuman] = useState("");

  // User balances map by address (lowercased)
  const [balances, setBalances] = useState(new Map());
  const selected = tokenIn ? balances.get(tokenIn.toLowerCase()) : null;
  const selectedBalance = selected?.raw ?? 0n;
  const selectedDecimals = selected?.decimals ?? 18;
  const selectedSymbol = selected?.symbol ?? "";

  // Tiers from contract
  const [tiers, setTiers] = useState({ thresholds: [], bps: [] });

  // ONE/USD (for wONE preview only)
  const { price: oneUsd, loading: oneLoading } = useOnePrice();

  // Captcha
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const recaptchaRef = useRef(null);

  // Summary (light preview)
  const [summary, setSummary] = useState({
    priceText: "",
    feeText: "",
    receiveText: "",
    tierText: "",
  });

  // Component state
  const [busy, setBusy] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);
  const [loadingBase, setLoadingBase] = useState(true);

  // Load vault base
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) return;

        const [infos, w, u, bals, t] = await Promise.all([
          redeemService.getSupportedTokenInfos(readProvider).catch(() => []),
          vaultService.wONE(readProvider).catch(() => ""),
          vaultService.usdc(readProvider).catch(() => ""),
          vaultService.getVaultBalances?.(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
          redeemService.getFeeTiers(readProvider),
        ]);

        if (!alive) return;

        setSupportedTokens(infos || []);
        setWone(w || "");
        setUsdc(u || "");
        setVaultBalances(bals || { woneBalance: 0n, usdcBalance: 0n });
        setTiers(t || { thresholds: [], bps: [] });

        if (u) {
          try {
            const erc = new ethers.Contract(u, ERC20_MINI, readProvider);
            const d = await erc.decimals();
            setUsdcDecimals(Number(d));
          } catch { setUsdcDecimals(6); }
        }

        // Default redeemIn according to available vault balances
        if (!redeemIn) {
          if ((bals?.woneBalance ?? 0n) > 0n) setRedeemIn(w || "");
          else if ((bals?.usdcBalance ?? 0n) > 0n) setRedeemIn(u || "");
          else setRedeemIn(w || u || "");
        }

        // Default tokenIn to first supported
        if (!tokenIn && infos && infos[0]?.address) setTokenIn(infos[0].address);
      } catch (e) {
        console.warn("[RedeemForm] load base error:", e);
      } finally {
        if (alive) setLoadingBase(false);
      }
    })();
    return () => { alive = false; };
  }, [readProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load user balances
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address) return;
        const arr = await redeemService.getUserBalances(readProvider, address);
        if (!alive) return;
        const map = new Map(arr.map(i => [String(i.address).toLowerCase(), i]));
        setBalances(map);
      } catch (e) {
        console.warn("[RedeemForm] user balances error:", e);
      }
    })();
    return () => { alive = false; };
  }, [readProvider, address]);

  // Max
  const onMax = useCallback(() => {
    try {
      const human = formatUnits(selectedBalance ?? 0n, selectedDecimals ?? 18);
      setAmountHuman(human);
    } catch (e) {
      console.warn("[RedeemForm] onMax error:", e);
    }
  }, [selectedBalance, selectedDecimals]);

  // Summary preview: on-chain USD + on-chain fee tiers (locally applied),
  // USDC receive exact; wONE receive uses external price (hook) for preview only.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setSummary({ priceText: "", feeText: "", receiveText: "", tierText: "" });

        if (!readProvider || !tokenIn || !redeemIn) return;
        if (!amountHuman || Number(amountHuman) <= 0) return;

        const decIn = selectedDecimals;
        const amountIn = parseUnits(String(amountHuman), decIn);

        // USD before fee (whole USD)
        const usdBefore = await redeemService.getUsdValue(readProvider, tokenIn, amountIn);
        if (usdBefore === 0n) {
          setSummary((s) => ({ ...s, priceText: "Price unavailable" }));
          return;
        }

        // Fee (in token) by tiers from contract
        const { feeAmount, refundAmount, bps } = redeemService.applyFeeForUsd(amountIn, Number(usdBefore), tiers);

        // Price per token (USD)
        let priceText = "";
        const humanIn = Number(formatUnits(amountIn, decIn));
        if (humanIn > 0) {
          const usdPerToken = Number(usdBefore) / humanIn;
          if (Number.isFinite(usdPerToken)) {
            priceText = `Price: ~${usdPerToken.toFixed(4)} USD per ${selectedSymbol || "TOKEN"}`;
          }
        }

        // Will Receive
        let receiveText = "";
        if (redeemIn && wone && redeemIn.toLowerCase() === wone.toLowerCase()) {
          if (!oneLoading && oneUsd && Number(oneUsd) > 0) {
            const onePerUsd = 1 / Number(oneUsd);
            // USD after fee equals USD value of refundAmount
            const usdAfter = await redeemService.getUsdValue(readProvider, tokenIn, refundAmount);
            const recvOneFloat = Number(usdAfter) * onePerUsd;
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
          // Convert whole USD to USDC (10^usdcDecimals)
          const usdAfter = await redeemService.getUsdValue(readProvider, tokenIn, refundAmount);
          const recvUsdcRaw = BigInt(usdAfter) * (10n ** BigInt(usdcDecimals));
          receiveText = `${formatUnits(recvUsdcRaw, usdcDecimals)} USDC`;
        }

        const feeText = `${formatUnits(feeAmount, decIn)} ${selectedSymbol || "TOKEN"}`;
        const tierText = `Fee Tier: ${(bps / 100).toFixed(2)}%`;

        if (!alive) return;
        setSummary({ priceText, feeText, receiveText, tierText });
      } catch (e) {
        console.warn("[RedeemForm] summary error:", e);
        if (alive) setSummary({ priceText: "", feeText: "", receiveText: "", tierText: "" });
      }
    })();
    return () => { alive = false; };
  }, [readProvider, tokenIn, redeemIn, amountHuman, selectedDecimals, selectedSymbol, tiers, wone, usdc, usdcDecimals, oneUsd, oneLoading]);

  // Confirm: CAPTCHA -> approve if needed -> redeem
  const onConfirm = useCallback(async () => {
    try {
      setUiNotice(null);
      setBusy(true);

      if (!readProvider) throw new Error("Provider not ready");
      if (!address) throw new Error("Connect a wallet");
      if (!tokenIn) throw new Error("Select a token");
      if (!redeemIn) throw new Error("Select wONE or USDC");
      if (!amountHuman || Number(amountHuman) <= 0) throw new Error("Enter an amount");

      // reCAPTCHA (if configured)
      if (recaptchaSiteKey && recaptchaRef.current) {
        const tok = await recaptchaRef.current.executeAsync();
        recaptchaRef.current.reset();
        if (!tok) throw new Error("reCAPTCHA validation failed");
      }

      // Optional merkle proof
      const proof = typeof getProofFor === "function" ? (await getProofFor(address)) : [];

      // Amount
      const decIn = selectedDecimals;
      const amountIn = parseUnits(String(amountHuman), decIn);

      // Vault address
      let vaultAddr =
        (await vaultService.address?.(readProvider)) ||
        (await vaultService.getAddress?.(readProvider)) ||
        vaultService.VAULT_ADDRESS ||
        import.meta.env.VITE_VAULT_ADDRESS ||
        "";
      if (typeof vaultAddr !== "string" || !vaultAddr) {
        throw new Error("Vault address not configured");
      }
      vaultAddr = ethers.getAddress(vaultAddr);

      // Approve if needed
      const erc = new ethers.Contract(tokenIn, ERC20_MINI, readProvider);
      const allowance = await erc.allowance(address, vaultAddr);
      if (BigInt(allowance) < BigInt(amountIn)) {
        const signer = await ctxProvider?.getSigner?.();
        if (!signer) throw new Error("Connect a wallet to approve");
        const txA = await erc.connect(signer).approve(vaultAddr, amountIn);
        await txA.wait();
      }

      // Execute redeem (use service entrypoint if vaultService isn't exposing one)
      const signer = await ctxProvider?.getSigner?.();
      if (!signer) throw new Error("Connect a wallet to proceed");

      if (typeof vaultService.redeem === "function") {
        await vaultService.redeem(signer, { user: address, tokenIn, amount: amountIn, redeemIn, proof });
      } else {
        // Fallback direct
        // Try: redeem(tokenIn, redeemIn, amount, proof)
        const ABI1 = [
          "function redeem(address tokenIn, address redeemIn, uint256 amount, bytes32[] proof) external",
        ];
        const vault1 = new ethers.Contract(vaultAddr, ABI1, signer);
        try {
          const tx = await vault1.redeem(tokenIn, redeemIn, amountIn, proof);
          await tx.wait();
        } catch {
          // Try: redeem(user, tokenIn, amount, redeemIn, proof)
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

      // Refresh balances silently
      try {
        const arr = await redeemService.getUserBalances(readProvider, address);
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

  // Redeem-in availability flags
  const hasWone = (vaultBalances?.woneBalance ?? 0n) > 0n;
  const hasUsdc = (vaultBalances?.usdcBalance ?? 0n) > 0n;

  // Confirm disabled
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

      {/* Pre-loader while base info mounts */}
      {loadingBase && (
        <div className={`${styles.alert} ${styles.info}`}>Loading redeem data…</div>
      )}

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

      {/* Lightweight preview (no "Source" box anymore) */}
      {(summary.priceText || summary.feeText || summary.receiveText || summary.tierText) && !loadingBase && (
        <div className={styles.card} style={{ marginTop: 8 }}>
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
        </div>
      )}

      {/* Action */}
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

      {/* Invisible reCAPTCHA */}
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
