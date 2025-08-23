// src/components/redeem/RedeemForm.jsx
// Recovery Dex — Redeem flow wired directly to contract (ethers v6)
// UI messages and logs in English. Error handling via try/catch + console.error.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";
import styles from "@/styles/Global.module.css";
import ReCAPTCHA from "react-google-recaptcha";

// Minimal Alert using project styles
function Alert({ type = "info", children }) {
  const map = { info: styles.info, success: styles.success, warning: styles.warning, error: styles.error };
  return <div role="alert" className={[styles.alert, map[type] || styles.info].join(" ")}>{children}</div>;
}

function shorten(addr) { return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—"; }

// Number helpers
function parseUnitsSafe(str, decimals = 18) {
  try {
    const s = String(str ?? "").replace(/,/g, ".").trim();
    if (!s) return 0n;
    return ethers.parseUnits(s, Number.isFinite(decimals) ? decimals : 18);
  } catch {
    return 0n;
  }
}

// Minimal ERC20 iface
const ERC20_IFACE = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

// Minimal Vault read ABI (avoid stale full ABI issues)
const VAULT_MIN_ABI = [
  "function getSupportedTokens() view returns (address[])",
  "function wONE() view returns (address)",
  "function usdc() view returns (address)",
  "function getUserLimit(address wallet) view returns (uint256 remainingUSD)",
  // quoteRedeem returns 11 values in the current contract
  "function quoteRedeem(address user,address tokenIn,uint256 amountIn,address redeemIn,bytes32[] proof) view returns (bool,bool,uint256,uint256,uint256,uint256,uint256,uint8,uint8,uint256,uint8)"
];

export default function RedeemForm({ address, eligible, proof, defaultToken }) {
  // Providers
  const RPC_URL = import.meta.env.VITE_RPC_URL;
  const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS;
  const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY || import.meta.env.RECAPTCHA_SITE_KEY;

  const readProvider = useMemo(() => {
    try { return vaultService.getDefaultProvider?.() || (RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null); }
    catch { return null; }
  }, [RPC_URL]);

  const getSigner = useCallback(async () => {
    if (window?.ethereum) {
      const bp = new ethers.BrowserProvider(window.ethereum);
      return bp.getSigner();
    }
    return null;
  }, []);

  // Contract (read)
  const vaultRead = useMemo(() => {
    try {
      if (!VAULT_ADDRESS || !readProvider) return null;
      return new ethers.Contract(VAULT_ADDRESS, VAULT_MIN_ABI, readProvider);
    } catch {
      return null;
    }
  }, [VAULT_ADDRESS, readProvider]);

  // State: tokens & balances
  const [supported, setSupported] = useState([]); // [{address,symbol,decimals,balance}]
  const [tokenIn, setTokenIn] = useState(defaultToken || "");
  const [tokenInInfo, setTokenInInfo] = useState({ symbol: "", decimals: 18, balance: 0n });
  const [woneAddr, setWoneAddr] = useState(ethers.ZeroAddress);
  const [usdcAddr, setUsdcAddr] = useState(ethers.ZeroAddress);

  // State: output token options (wONE / USDC)
  const [outOptions, setOutOptions] = useState([]); // [{address, symbol, decimals}]
  const [tokenOut, setTokenOut] = useState("");

  // State: amounts & limit
  const [amount, setAmount] = useState("");
  const [remainingUSD, setRemainingUSD] = useState(0n);
  const [usdValue, setUsdValue] = useState(0n);
  const [exceeds, setExceeds] = useState(false);

  // Pending state
  const [pending, setPending] = useState(false);

  // reCAPTCHA
  const [captchaToken, setCaptchaToken] = useState("");

  // Alerts
  const [notice, setNotice] = useState(null); // {type,msg}

  // Load supported tokens + out options
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!vaultRead) return;
        const [tokens, wAddr, uAddr] = await Promise.all([
          vaultRead.getSupportedTokens(),
          (async () => { try { return await vaultRead.wONE(); } catch { return ethers.ZeroAddress; } })(),
          (async () => { try { return await vaultRead.usdc(); } catch { return ethers.ZeroAddress; } })(),
        ]);

        // Build supported list with symbol/decimals/balance
        const filled = [];
        for (const t of tokens || []) {
          try {
            const erc = new ethers.Contract(t, ERC20_IFACE, readProvider);
            const [sym, dec, bal] = await Promise.all([
              erc.symbol().catch(() => "TOKEN"),
              erc.decimals().catch(() => 18),
              address ? erc.balanceOf(address).catch(() => 0n) : 0n,
            ]);
            filled.push({ address: t, symbol: String(sym), decimals: Number(dec), balance: BigInt(bal) });
          } catch {}
        }
        if (!alive) return;
        setSupported(filled);
        const initialIn = defaultToken || filled[0]?.address || "";
        setTokenIn((prev) => prev || initialIn);

        // Out options (wONE/USDC)
        const out = [];
        if (wAddr && wAddr !== ethers.ZeroAddress) {
          try {
            const erc = new ethers.Contract(wAddr, ERC20_IFACE, readProvider);
            const [sym, dec] = await Promise.all([
              erc.symbol().catch(() => "wONE"), erc.decimals().catch(() => 18)
            ]);
            out.push({ address: wAddr, symbol: String(sym), decimals: Number(dec) });
          } catch { out.push({ address: wAddr, symbol: "wONE", decimals: 18 }); }
        }
        if (uAddr && uAddr !== ethers.ZeroAddress) {
          try {
            const erc = new ethers.Contract(uAddr, ERC20_IFACE, readProvider);
            const [sym, dec] = await Promise.all([
              erc.symbol().catch(() => "USDC"), erc.decimals().catch(() => 6)
            ]);
            out.push({ address: uAddr, symbol: String(sym), decimals: Number(dec) });
          } catch { out.push({ address: uAddr, symbol: "USDC", decimals: 6 }); }
        }
        if (!alive) return;
        setOutOptions(out);
        setTokenOut((prev) => prev || out[0]?.address || "");
        setWoneAddr(wAddr || ethers.ZeroAddress);
        setUsdcAddr(uAddr || ethers.ZeroAddress);
      } catch (err) {
        console.error("[RedeemForm] load supported/out options error:", err);
      }
    })();
    return () => { alive = false; };
  }, [vaultRead, readProvider, address, defaultToken]);

  // Refresh tokenIn info (symbol/decimals/balance)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!tokenIn || !ethers.isAddress(tokenIn) || !readProvider) return;
        const erc = new ethers.Contract(tokenIn, ERC20_IFACE, readProvider);
        const [sym, dec, bal] = await Promise.all([
          erc.symbol().catch(() => "TOKEN"),
          erc.decimals().catch(() => 18),
          address ? erc.balanceOf(address).catch(() => 0n) : 0n,
        ]);
        if (!alive) return;
        setTokenInInfo({ symbol: String(sym), decimals: Number(dec), balance: BigInt(bal) });
      } catch (err) {
        console.error("[RedeemForm] tokenIn info error:", err);
        if (alive) setTokenInInfo({ symbol: "TOKEN", decimals: 18, balance: 0n });
      }
    })();
    return () => { alive = false; };
  }, [tokenIn, address, readProvider]);

  // Load remaining USD limit
  const loadRemaining = useCallback(async () => {
    try {
      if (!vaultRead || !address) return 0n;
      const rem = await vaultRead.getUserLimit(address); // uint USD (no decimals)
      setRemainingUSD(BigInt(rem || 0n));
      return BigInt(rem || 0n);
    } catch (err) {
      console.error("[RedeemForm] getUserLimit error:", err);
      setRemainingUSD(0n);
      return 0n;
    }
  }, [vaultRead, address]);

  useEffect(() => { loadRemaining(); }, [loadRemaining]);

  // Quote on amount/token changes
  const quote = useCallback(async (amtStr) => {
    try {
      if (!vaultRead || !address || !tokenIn || !tokenOut || !proof) { setUsdValue(0n); setExceeds(false); return; }
      const am = String(amtStr ?? amount).trim();
      if (!am) { setUsdValue(0n); setExceeds(false); return; }
      const parsed = parseUnitsSafe(am, tokenInInfo.decimals);
      if (parsed <= 0n) { setUsdValue(0n); setExceeds(false); return; }

      const res = await vaultRead.quoteRedeem(address, tokenIn, parsed, tokenOut, Array.isArray(proof) ? proof : (proof?.proof || proof?.merkleProof || []));
      // Ethers v6 returns array-like; map by position
      const usd = BigInt(res?.[6] ?? 0n); // usdValue
      setUsdValue(usd);

      const remaining = await loadRemaining();
      setExceeds(usd > remaining);
    } catch (err) {
      // If reverted due to limit/whitelist, we may land here
      if (/Exceeds daily limit/i.test(err?.message || "")) {
        const remaining = await loadRemaining();
        setUsdValue(remaining + 1n);
        setExceeds(true);
      } else {
        console.error("[RedeemForm] quote error:", err);
        setUsdValue(0n); setExceeds(false);
      }
    }
  }, [vaultRead, address, tokenIn, tokenOut, tokenInInfo.decimals, proof, amount, loadRemaining]);

  useEffect(() => { quote(amount); }, [amount, tokenIn, tokenOut, quote]);

  // Actions
  const onMax = useCallback(() => {
    try {
      const val = ethers.formatUnits(tokenInInfo.balance || 0n, tokenInInfo.decimals || 18);
      setAmount(val);
    } catch { setAmount(""); }
  }, [tokenInInfo.balance, tokenInInfo.decimals]);

  // 1:1 enforcement note (contract currently requires redeemIn == tokenIn)
  const oneToOneOk = useMemo(() => {
    if (!tokenIn || !tokenOut) return false;
    return tokenIn.toLowerCase() === tokenOut.toLowerCase();
  }, [tokenIn, tokenOut]);

  const canSubmit = useMemo(() => {
    const am = Number(amount);
    return Boolean(
      address && eligible === true && ethers.isAddress(tokenIn) && ethers.isAddress(tokenOut) && am > 0 && !exceeds && captchaToken && oneToOneOk && !pending
    );
  }, [address, eligible, tokenIn, tokenOut, amount, exceeds, captchaToken, oneToOneOk, pending]);

  const onRedeem = useCallback(async () => {
    try {
      if (!canSubmit) return;
      setNotice(null);
      setPending(true);
      const signer = await getSigner();
      if (!signer) throw new Error("Connect a wallet to submit");

      const amountUnits = parseUnitsSafe(amount, tokenInInfo.decimals);
      const proofArr = Array.isArray(proof) ? proof : (proof?.proof || proof?.merkleProof || []);

      // Ensure allowance for ERC20 path
      if (tokenIn !== ethers.ZeroAddress) {
        const erc = new ethers.Contract(tokenIn, ERC20_IFACE, signer);
        const ownerAddr = await signer.getAddress();
        const spender = vaultService.getVaultAddress ? vaultService.getVaultAddress() : VAULT_ADDRESS;
        const cur = await erc.allowance(ownerAddr, spender);
        if (cur < amountUnits) {
          const txA = await erc.approve(spender, amountUnits);
          await txA.wait();
        }
      }

      // Use service to handle payable override if ever using native ONE
      const rc = await vaultService.redeem(
        signer,
        tokenIn,
        amountUnits,
        tokenOut,
        proofArr
      );

      setNotice({ type: "success", msg: `Redeem submitted. Tx: ${rc?.hash || "(pending)"}` });
      setAmount("");
      await loadRemaining();
    } catch (err) {
      console.error("[RedeemForm] redeem error:", err);
      setNotice({ type: "error", msg: err?.message || "Redeem failed" });
    } finally {
      setPending(false);
    }
  }, [canSubmit, getSigner, tokenIn, tokenOut, amount, tokenInInfo.decimals, proof, loadRemaining]);

  // Formatting helpers
  const fmt = useCallback((n, d = 2) => {
    try { return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
    catch { return String(n); }
  }, []);

  const balanceText = useMemo(() => {
    try { return ethers.formatUnits(tokenInInfo.balance || 0n, tokenInInfo.decimals || 18); }
    catch { return "0"; }
  }, [tokenInInfo.balance, tokenInInfo.decimals]);

  return (
    <div className={[styles.card, styles.stack].join(" ")}>      
      <div className={styles.h3}>Redeem</div>

      {/* Token In */}
      <div className={styles.field}>
        <label className={styles.smallMuted}>Token to redeem (supported by vault)</label>
        <select className={styles.select} value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>
          <option value="">— Select token —</option>
          {supported.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol} · {shorten(t.address)}
            </option>
          ))}
        </select>
        <div className={styles.smallMuted}>Balance: {fmt(balanceText, 4)} {tokenInInfo.symbol}</div>
      </div>

      {/* Amount In */}
      <div className={styles.field}>
        <label className={styles.smallMuted}>Amount</label>
        <div className={styles.row}>
          <input
            className={styles.input}
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button type="button" className={styles.button} onClick={onMax} disabled={pending}>Max</button>
        </div>
        {exceeds && (
          <Alert type="warning">
            Amount exceeds your daily remaining limit. Quote USD: {fmt(usdValue)} / Remaining USD: {fmt(remainingUSD)}
          </Alert>
        )}
      </div>

      {/* Token Out */}
      <div className={styles.field}>
        <label className={styles.smallMuted}>Receive token</label>
        <select className={styles.select} value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>
          <option value="">— Select output —</option>
          {outOptions.map((o) => (
            <option key={o.address} value={o.address}>{o.symbol} · {shorten(o.address)}</option>
          ))}
        </select>
        {!oneToOneOk && tokenIn && tokenOut && (
          <Alert type="info">Currently the contract supports 1:1 redeem only (receive token must match the input token).</Alert>
        )}
      </div>

      {/* Recaptcha */}
      {SITE_KEY ? (
        <div className={styles.field}>
          <label className={styles.smallMuted}>Human check</label>
          <ReCAPTCHA sitekey={SITE_KEY} onChange={(tok) => setCaptchaToken(tok || "")} />
        </div>
      ) : (
        <Alert type="warning">reCAPTCHA site key missing. Set VITE_RECAPTCHA_SITE_KEY in your .env</Alert>
      )}

      {/* Submit */}
      <div className={styles.row}>
        <button type="button" className={[styles.button, styles.buttonAccent].join(" ")} disabled={!canSubmit} onClick={onRedeem}>
          {pending ? "Submitting..." : "Redeem"}
        </button>
        <button type="button" className={styles.button} onClick={() => setAmount("")} disabled={pending}>Clear</button>
      </div>

      {notice && <Alert type={notice.type}>{notice.msg}</Alert>}

      {/* Dev info */}
      <div className={styles.smallMuted}>
        USD Quote: {fmt(usdValue)} · Remaining: {fmt(remainingUSD)}
      </div>
    </div>
  );
}
