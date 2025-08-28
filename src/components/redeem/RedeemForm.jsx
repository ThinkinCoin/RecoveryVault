// src/components/redeem/RedeemForm.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers, formatUnits, parseUnits } from "ethers";
import { useAppKitAccount } from "@reown/appkit/react";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import * as vaultService from "@/services/vaultService";
import TokenSelect from "@/components/shared/TokenSelect";
import ReCAPTCHA from "react-google-recaptcha";
import { preloadProofs, checkWhitelist, useWhitelist } from "@/services/whitelistService";
import { preflightAmountAgainstLimit, quoteAmountUsd18, fetchRemainingUsd18 } from "@/services/limitsService";

const FN_REDEEM_CANDIDATES = ["redeem(address,uint256,address,bytes32[])"];

function friendlySimError(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("address not whitelisted")) return "Address not whitelisted";
  if (t.includes("insufficient remaining daily limit")) return "Insufficient remaining daily limit";
  if (t.includes("amount exceeds daily limit")) return "Insufficient remaining daily limit";
  if (t.includes("missing revert data")) return "Execution reverted (no reason). Check args/signature.";
  if (t.includes("execution reverted")) return "Execution reverted";
  return text || "Simulation failed";
}

function dbg(...a) {
  console.debug("[RedeemForm]", ...a);
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
  const { provider: ctxProvider } = useContractContext();
  const { isConnected, address: appkitAddress } = useAppKitAccount();

  const readProvider = useMemo(() => vaultService.getDefaultProvider?.() || null, []);
  const address = useMemo(() => addressProp || appkitAddress || "", [addressProp, appkitAddress]);

  // Vault data
  const [supportedTokens, setSupportedTokens] = useState([]);
  const [wone, setWone] = useState("");
  const [usdc, setUsdc] = useState("");
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [vaultBalances, setVaultBalances] = useState({ woneBalance: 0n, usdcBalance: 0n });

  // Form
  const [tokenIn, setTokenIn] = useState("");
  const [redeemIn, setRedeemIn] = useState("");
  const [amountHuman, setAmountHuman] = useState("");

  // Wallet token meta
  const [balances, setBalances] = useState(new Map());
  const selected = tokenIn ? balances.get(tokenIn.toLowerCase()) : null;
  const selectedBalance = selected?.raw ?? 0n;
  const selectedDecimals = selected?.decimals ?? 18;
  const selectedSymbol = selected?.symbol ?? "";

  // Preço fixo (texto)
  const [fixedPriceText, setFixedPriceText] = useState("");

  // USD em 18 decimais (contrato)
  const [limitUSD18, setLimitUSD18] = useState(0n);
  const [amountUSD18, setAmountUSD18] = useState(0n);

  // UI
  const [busy, setBusy] = useState(false);
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);

  // reCAPTCHA
  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const RECAPTCHA_ENABLED = import.meta.env.VITE_ENABLE_RECAPTCHA === "true";
  const recaptchaRef = useRef(null);

  useEffect(() => {
    preloadProofs().catch(() => {});
  }, []);

  // Base load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) return;
        setLoadingBase(true);

        const [sup, w, u, bals] = await Promise.all([
          vaultService.getSupportedTokens?.(readProvider).catch(() => []),
          vaultService.wONE?.(readProvider).catch(() => ""),
          vaultService.usdc?.(readProvider).catch(() => ""),
          vaultService.getVaultBalances?.(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
        ]);

        if (!alive) return;

        const supArr = Array.isArray(sup) ? sup.filter(Boolean) : [];
        setSupportedTokens(supArr);
        setWone(w || "");
        setUsdc(u || "");
        setVaultBalances(bals || { woneBalance: 0n, usdcBalance: 0n });

        if (u) {
          try {
            const erc = new ethers.Contract(u, ERC20_MINI, readProvider);
            const d = await erc.decimals();
            setUsdcDecimals(Number(d) || 6);
          } catch {
            setUsdcDecimals(6);
          }
        }

        if (!redeemIn) {
          if ((bals?.woneBalance ?? 0n) > 0n) setRedeemIn(w || "");
          else if ((bals?.usdcBalance ?? 0n) > 0n) setRedeemIn(u || "");
          else setRedeemIn(w || u || "");
        }
        if (!tokenIn && supArr[0]) setTokenIn(supArr[0]);
      } catch (e) {
        console.warn("[RedeemForm] base load error:", e);
      } finally {
        if (alive) setLoadingBase(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [readProvider]);


  // Wallet balances
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address || supportedTokens.length === 0) return;

        setLoadingBalances(true);

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
      } catch (e) {
        console.warn("[RedeemForm] wallet balances load error:", e);
      } finally {
        if (alive) setLoadingBalances(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [readProvider, address, supportedTokens]);

  // Metadata for newly picked token
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
      } catch {
        /* ignore */
      }
    })();
  }, [readProvider, address, tokenIn, balances]);

  // Fixed price display
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
    return () => {
      alive = false;
    };
  }, [readProvider, tokenIn]);

  // Whitelist hook
  const { loading: wlLoading, ok: wlOk, error: wlError, proof: wlProof } = useWhitelist(address, readProvider);

  // Limite diário restante (USD 18dps) - alinhado com vaultService/LimitChecker
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider || !address) return;
        const rem = await fetchRemainingUsd18(readProvider, address);
        if (alive) setLimitUSD18(rem);
      } catch {
        if (alive) setLimitUSD18(0n);
      }
    })();
    return () => {
      alive = false;
    };
  }, [readProvider, address]);

  // USD do pedido (USD 18dps)
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

  const onMax = useCallback(() => {
    try {
      const human = formatUnits(selectedBalance ?? 0n, selectedDecimals ?? 18);
      setAmountHuman(human);
    } catch (e) {
      console.warn("[RedeemForm] onMax error:", e);
    }
  }, [selectedBalance, selectedDecimals]);

  const onConfirm = useCallback(async () => {
    try {
      setUiNotice(null);
      setBusy(true);

      if (!readProvider) throw new Error("Provider not ready");
      if (!isConnected || !address) throw new Error("Connect a wallet");
      if (!tokenIn) throw new Error("Select a token");
      if (!redeemIn) throw new Error("Select wONE or USDC");
      if (!amountHuman || Number(amountHuman) <= 0) throw new Error("Enter an amount");

      // reCAPTCHA
      if (RECAPTCHA_ENABLED && recaptchaSiteKey && recaptchaRef.current) {
        let tok = null;
        try {
          tok = await recaptchaRef.current.executeAsync();
        } catch {
          throw new Error("reCAPTCHA timed out. Please try again.");
        } finally {
          recaptchaRef.current.reset();
        }
        if (!tok) throw new Error("reCAPTCHA validation failed");
      } else {
        console.log("[reCAPTCHA] dev bypass token");
      }

      // amount do token
      const amountIn = parseUnits(String(amountHuman), selectedDecimals);

      // Guard: saldo
      if (selectedBalance != null && BigInt(amountIn) > BigInt(selectedBalance)) {
        throw new Error("Insufficient balance for selected token");
      }

      // Pré-checagem fresh contra limite (mesma lógica do serviço/LimitChecker)
      const pre = await preflightAmountAgainstLimit(readProvider, address, tokenIn, amountHuman, selectedDecimals);
      // Atualiza preview com leitura fresh
      if (pre?.amountUSD18 != null) setAmountUSD18(pre.amountUSD18);
      if (pre?.remainingUSD18 != null) setLimitUSD18(pre.remainingUSD18);

      if (!pre.ok || (pre.amountUSD18 ?? 0n) >= (pre.remainingUSD18 ?? 0n)) {
        throw new Error("Insufficient remaining daily limit");
      }

      // Vault address
      let vaultAddr = vaultService.getVaultAddress?.() || import.meta.env.VITE_VAULT_ADDRESS || "";
      if (typeof vaultAddr !== "string" || !vaultAddr) throw new Error("Vault address not configured");
      vaultAddr = ethers.getAddress(vaultAddr);

      // Whitelist
      if (!wlOk) throw new Error(wlError || "Address not whitelisted");
      const proof = wlProof || [];

      // Approve se necessário
      const erc = new ethers.Contract(tokenIn, ERC20_MINI, readProvider);
      const allowance = await erc.allowance(address, vaultAddr);
      if (allowance < amountIn) {
        const signerA = await ctxProvider?.getSigner?.();
        if (!signerA) throw new Error("Connect a wallet to approve");
        const txA = await erc.connect(signerA).approve(vaultAddr, amountIn);
        await txA.wait();
      }

      // Envio
      const signer = await ctxProvider?.getSigner?.();
      if (!signer) throw new Error("Connect a wallet to proceed");

      let lastReason = "";
      for (const sig of FN_REDEEM_CANDIDATES) {
        let args;
        switch (sig) {
          case "redeem(address,uint256,address,bytes32[])":
            args = [tokenIn, amountIn, redeemIn, proof];
            break;
          case "redeem(address,uint256,address)":
            args = [tokenIn, amountIn, redeemIn];
            break;
          case "redeem(uint256,address)":
            args = [amountIn, redeemIn];
            break;
          default:
            continue;
        }

        // simulate-first
        const sim = await vaultService.preflightRedeem(readProvider, {
          fn: sig,
          args,
          context: { user: address, tokenIn, amountIn, redeemIn, proof },
        });

        if (!sim.ok) {
          lastReason = sim.reason || "";
          console.warn(`[RedeemForm] simulate fail on ${sig}:`, lastReason);
          continue;
        }

        // send
        const sent = await vaultService.submitRedeem(signer, { fn: sig, args });
        if (!sent.ok) {
          if (sent.rejected) {
            setUiNotice({ type: "warning", text: "Transaction rejected by user" });
            return;
          }
          lastReason = sent.reason || "";
          console.warn(`[RedeemForm] send fail on ${sig}:`, lastReason);
          continue;
        }

        setUiNotice({ type: "success", text: `Redeem submitted. Tx: ${sent.tx.hash}` });
        await sent.tx.wait();
        setUiNotice({ type: "success", text: "Redeem confirmed." });
        setAmountHuman("");

        // refresh balances
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

      setUiNotice({ type: "error", text: friendlySimError(lastReason || "Redeem failed") });
    } catch (e) {
      console.error("[RedeemForm] onConfirm error:", e);
      setUiNotice({ type: "error", text: friendlySimError(e?.shortMessage || e?.reason || e?.message || String(e)) });
    } finally {
      setBusy(false);
    }
  }, [
    readProvider,
    ctxProvider,
    isConnected,
    address,
    tokenIn,
    redeemIn,
    amountHuman,
    recaptchaSiteKey,
    selectedDecimals,
    supportedTokens,
    selectedBalance,
    wlOk,
    wlError,
    wlProof,
  ]);

  const hasWone = (vaultBalances?.woneBalance ?? 0n) > 0n;
  const hasUsdc = (vaultBalances?.usdcBalance ?? 0n) > 0n;

  const confirmDisabled = useMemo(() => {
    if (busy) return true;
    if (!isConnected || !address || !tokenIn || !redeemIn) return true;
    if (!amountHuman || Number(amountHuman) <= 0) return true;
    if (!wlLoading && !wlOk) return true;
    // usa >= para alinhar com o contrato/rounding
    if (amountUSD18 !== 0n && limitUSD18 !== 0n && amountUSD18 >= limitUSD18) return true;
    return false;
  }, [busy, isConnected, address, tokenIn, redeemIn, amountHuman, wlLoading, wlOk, amountUSD18, limitUSD18]);

  const isLoading = loadingBase || loadingBalances;

  const limitUsdText = useMemo(() => formatUnits(limitUSD18 ?? 0n, 18), [limitUSD18]);
  const amountUsdText = useMemo(() => formatUnits(amountUSD18 ?? 0n, 18), [amountUSD18]);

  return (
    <div className={styles.contractRedeemCard}>
      <div className={styles.contractRedeemHeader}>
        <h3 className={styles.h3} style={{ margin: 0 }}>Redeem</h3>
      </div>

      {isLoading && (
        <div className={`${styles.alert} ${styles.info}`} style={{ marginBottom: 12 }}>
          Loading vault data{loadingBalances ? " & balances" : ""}…
        </div>
      )}

      {uiNotice && (
        <div
          className={`${styles.alert} ${
            uiNotice.type === "error"
              ? styles.error
              : uiNotice.type === "warning"
              ? styles.warning
              : uiNotice.type === "success"
              ? styles.success
              : styles.info
          }`}
        >
          {uiNotice.text}
        </div>
      )}

      {!wlLoading && !wlOk && (
        <div className={`${styles.alert} ${styles.warning}`} style={{ marginBottom: 12 }}>
          {wlError || "Address not whitelisted"}
        </div>
      )}

      {(limitUSD18 !== 0n || amountUSD18 !== 0n) && (
        <div className={styles.card} style={{ marginTop: 8 }}>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>Remaining daily limit</span>
            <span className={styles.contractRedeemValue}>
              ${Number(formatUnits(limitUSD18 ?? 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
          </div>
          <div className={styles.contractRedeemRow}>
            <span className={styles.contractRedeemLabel}>This request</span>
            <span className={styles.contractRedeemValue}>
              ${Number(formatUnits(amountUSD18 ?? 0n, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </span>
          </div>
          {amountUSD18 !== 0n && limitUSD18 !== 0n && amountUSD18 >= limitUSD18 && (
            <div className={`${styles.alert} ${styles.warning}`} style={{ marginTop: 8 }}>
              Insufficient remaining daily limit
            </div>
          )}
        </div>
      )}

      <div className={styles.grid2}>
        {/* Token In */}
        <div className={styles.field}>
          <label className={styles.smallMuted}>Token In</label>
          <TokenSelect
            tokens={supportedTokens}
            value={tokenIn}
            onChange={(v) => {
              dbg("TokenSelect onChange", v);
              setTokenIn(v);
            }}
            placeholder="Select token to redeem"
          />
          {!!tokenIn && selected && (
            <div className={styles.smallMuted}>
              Balance: {formatUnits(selectedBalance, selectedDecimals)} {selectedSymbol}
            </div>
          )}
          {!!fixedPriceText && <div className={styles.smallMuted}>Fixed price (USD): {fixedPriceText}</div>}
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
            {!hasWone && !hasUsdc && <span className={styles.smallMuted}>Vault has no funds available.</span>}
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
          <button
            type="button"
            className={styles.button}
            onClick={onMax}
            disabled={!isConnected || !address || !tokenIn || busy}
          >
            Max
          </button>
        </div>
      </div>

      {/* Action */}
      <div className={styles.contractRedeemRow} style={{ marginTop: 12, marginBottom: 12 }}>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonConfirm} ${styles.buttonAccent}`}
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          {busy ? "Processing…" : "Confirm"}
        </button>
      </div>

      {/* Invisible reCAPTCHA */}
      {RECAPTCHA_ENABLED && recaptchaSiteKey && <ReCAPTCHA ref={recaptchaRef} size="invisible" sitekey={recaptchaSiteKey} />}
    </div>
  );
}
