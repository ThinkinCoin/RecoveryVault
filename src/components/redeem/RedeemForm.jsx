import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract, formatUnits, parseUnits } from "ethers";
import { useAppKitAccount } from "@reown/appkit/react";
import { getActiveWalletProvider } from "@/services/appkit";
import styles from "@/styles/Global.module.css";
import { useContractContext } from "@/contexts/ContractContext";
import * as core from "@/services/vaultCore";
import * as redeemSvc from "@/services/redeemService";
import TokenSelect from "@/components/shared/TokenSelect";
import ReCAPTCHA from "react-google-recaptcha";
import { preloadProofs, useWhitelist } from "@/services/whitelistService";
import LoadConsole from "@/components/shared/LoadConsole";
import { useOnePrice } from "@/hooks/useOnePrice";
//import OracleDebugPanel from "@/components/OracleDebugPanel";

const ERC20_MINI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const ORACLE_TTL_MS = 30000;
const ROUND_TTL_MS = 15000;
const FEES_TTL_MS = 60000;
const FIXED_TTL_MS = 60000;
const USERLIMIT_TTL_MS = 20000;
const CHAIN_QUOTE_TIMEOUT_MS = Number(import.meta.env.VITE_CHAIN_QUOTE_TIMEOUT_MS ?? 900);

const TOKEN_META_CACHE = new Map();
async function getTokenMetaCached(provider, addr){
  const key = String(addr || "").toLowerCase();
  if (TOKEN_META_CACHE.has(key)) return TOKEN_META_CACHE.get(key);
  try {
    const erc = new Contract(addr, ERC20_MINI, provider);
    const [dec, sym] = await Promise.all([
      erc.decimals().catch(() => 18),
      erc.symbol().catch(() => "TOKEN")
    ]);
    const meta = { decimals: Number(dec) || 18, symbol: String(sym || "TOKEN") };
    TOKEN_META_CACHE.set(key, meta);
    return meta;
  } catch {
    const meta = { decimals: 18, symbol: "TOKEN" };
    TOKEN_META_CACHE.set(key, meta);
    return meta;
  }
}

function rpcFriendly(e){
  const code = e?.code;
  const raw = e?.data?.message || e?.error?.message || e?.shortMessage || e?.reason || e?.message || String(e || "");
  const s = String(raw || "").toLowerCase();
  if (code === 'ACTION_REJECTED' || code === 4001 || s.includes('user rejected') || s.includes('userrejectedrequest')) return "Transaction rejected by user";
  if (code === -32002 || s.includes('request already pending')) return "Request already pending in wallet. Open your wallet and complete or cancel it.";
  if (code === 'UNPREDICTABLE_GAS_LIMIT' || s.includes('unpredictable gas') || s.includes('gas estimation')) return "Gas estimation failed. Try again or adjust the amount.";
  if (code === 'CALL_EXCEPTION' || s.includes('call exception') || s.includes('execution reverted')){
    const i = raw.indexOf(":");
    const tail = i >= 0 ? raw.slice(i+1).trim() : "";
    return tail || "Transaction reverted by contract";
  }
  if (s.includes('providerdisconnected') || s.includes('chaindisconnected') || s.includes('chain disconnected') || code === 'providerDisconnected') return "Wallet/provider disconnected. Reconnect your wallet and try again.";
  if (s.includes("insufficient funds")) return "Insufficient funds (gas or value)";
  if (s.includes("insufficient allowance")) return "Insufficient allowance for selected token";
  if (s.includes("nonce too low")) return "Nonce too low. Try again";
  if (s.includes("replacement transaction underpriced") || s.includes("underpriced") || code === -32000) return "Invalid input or underpriced replacement";
  if (code === 429 || s.includes("rate limit") || s.includes("too many requests")) return "RPC rate limited. Please wait and try again";
  if (code === -32603 || s.includes("internal json-rpc error")) return "RPC error (-32603). Please retry or reconnect your wallet";
  if (s.includes("missing revert data")) return "Execution reverted (no reason)";
  return raw || "Unexpected error";
}

export default function RedeemForm({ address: addressProp, debounceMs }) {
  const { provider: ctxProvider, signer: ctxSigner } = useContractContext();
  const { isConnected, address: appkitAddress } = useAppKitAccount({ namespace: "eip155" });
  const { price: oneUsdFloat } = useOnePrice();

  const readProvider = useMemo(() => {
    if (ctxProvider) return ctxProvider;
    try { return core.getDefaultProvider?.(); } catch { return undefined; }
  }, [ctxProvider]);
  const address = useMemo(() => addressProp || appkitAddress || "", [addressProp, appkitAddress]);

  const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
  const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`.toLowerCase();
  const RPC_URL = (import.meta.env.VITE_RPC_URL_HARMONY?.trim() || import.meta.env.VITE_RPC_URL?.trim() || "https://api.harmony.one");
  const INPUT_DEBOUNCE_MS = Number(debounceMs ?? import.meta.env.VITE_INPUT_DEBOUNCE_MS ?? 800);

  async function ensureHarmony() {
    const prov = await getActiveWalletProvider?.();
    if (!prov?.request) return;
    const current = await prov.request({ method: "eth_chainId" }).catch(() => null);
    if (String(current).toLowerCase() === CHAIN_ID_HEX) return;
    try {
      await prov.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (err) {
      if (err?.code === 4902) {
        try {
          await prov.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: "Harmony Mainnet",
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: "ONE", symbol: "ONE", decimals: 18 },
              blockExplorerUrls: ["https://explorer.harmony.one/"]
            }]
          });
        } catch (e) { throw new Error(rpcFriendly(e)); }
        try {
          await prov.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
        } catch (e) { throw new Error(rpcFriendly(e)); }
      } else {
        throw new Error(rpcFriendly(err));
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
  const [debouncedAmount, setDebouncedAmount] = useState("");

  const [balances, setBalances] = useState(new Map());
  const selected = tokenIn ? balances.get(tokenIn.toLowerCase()) : null;
  const selectedBalance = selected?.raw ?? 0n;
  const selectedDecimals = selected?.decimals ?? 18;
  const selectedSymbol = selected?.symbol ?? "";

  const [fixedPriceText, setFixedPriceText] = useState("");

  const [limitUSD18, setLimitUSD18] = useState(0n);
  const [amountUSD18, setAmountUSD18] = useState(0n);

  const [receivePreview, setReceivePreview] = useState(null);

  const [busy, setBusy] = useState(false);
  const [loadingBase, setLoadingBase] = useState(true);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);
  const [bootOpen, setBootOpen] = useState(true);
  const [bootLogs, setBootLogs] = useState([]);
  const [bootStepsDone, setBootStepsDone] = useState(0);
  const addLog = useCallback((msg, level = "info") => { setBootLogs((prev) => [...prev, { ts: Date.now(), msg, level }]); }, []);
  const stepOk   = useCallback((msg) => { addLog(msg, "ok");   setBootStepsDone((s) => s + 1); }, [addLog]);
  const stepWarn = useCallback((msg) => { addLog(msg, "warn"); setBootStepsDone((s) => s + 1); }, [addLog]);
  const stepErr  = useCallback((msg) => { addLog(msg, "error");setBootStepsDone((s) => s + 1); }, [addLog]);

  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  const RECAPTCHA_ENABLED = import.meta.env.VITE_ENABLE_RECAPTCHA === "true";
  const recaptchaRef = useRef(null);

  const oracleCacheRef = useRef({ ts: 0, value: null });
  const roundCacheRef = useRef({ ts: 0, value: null });
  const feeCacheRef = useRef({ ts: 0, value: null });
  const fixedCacheRef = useRef(new Map());
  const userLimitCacheRef = useRef({ ts: 0, value: null });
  const runIdRef = useRef(0);

  const [roundActive, setRoundActive] = useState(false);

  const isValidHuman = useCallback((s) => {
    const str = String(s ?? "");
    if (str === "" || str === ".") return false;
    return /^\d*\.?\d*$/.test(str);
  }, []);

  const parseUnitsSafe = useCallback((s, dec) => {
    try { if (!isValidHuman(s)) return null; return parseUnits(String(s), dec); } catch { return null; }
  }, [isValidHuman]);

 const getCachedOracle = useCallback(async () => {
   // Try hook first (ONE price in USD, 18 dec)
   const n = Number(oneUsdFloat);
   if (Number.isFinite(n) && n > 0) {
     const p18 = BigInt(Math.round(n * 1e18));
     return { price: p18, decimals: 18 };
   }
   // Fallback to core (must also be USD per ONE, 18 dec)
   const now = Date.now();
   if (oracleCacheRef.current.value && now - oracleCacheRef.current.ts < ORACLE_TTL_MS) {
     return oracleCacheRef.current.value;
   }
   const out = await core.oracleLatest(readProvider).catch(() => ({ price: 0n, decimals: 18 }));
   // If core returns inverted (ONE per USD), heuristically invert (>1 means likely inverted)
   try {
     const { price = 0n, decimals = 18 } = out || {};
     if (price > 0n) {
       // normalize to 18-dec USD/ONE
       const p18 = decimals === 18 ? price : (price * 10n ** 18n) / 10n ** BigInt(decimals);
       // If p18 > 1e18 (i.e., > $1), pode estar certo; se p18 ~ 97 (1e18*97): invertido.
       // Para ONE hoje (~$0.01), preço correto deve ser << 1e18. Se for >>, invertamos.
       const isInverted = p18 > 10n ** 18n; 
       const norm = isInverted ? ( (10n ** 36n) / p18 ) : p18; // invert
       const normalized = { price: norm, decimals: 18 };
       oracleCacheRef.current = { ts: now, value: normalized };
       return normalized;
     }
   } catch {}
   oracleCacheRef.current = { ts: now, value: out };
   return out;
 }, [readProvider, oneUsdFloat]);

  const getCachedRoundInfo = useCallback(async () => {
    const now = Date.now();
    if (roundCacheRef.current.value && now - roundCacheRef.current.ts < ROUND_TTL_MS) return roundCacheRef.current.value;
    const out = await core.getRoundInfo(readProvider).catch(() => null);
    roundCacheRef.current = { ts: now, value: out };
    return out;
  }, [readProvider]);

  const getCachedFeeTiers = useCallback(async () => {
    const now = Date.now();
    if (feeCacheRef.current.value && now - feeCacheRef.current.ts < FEES_TTL_MS) return feeCacheRef.current.value;
    const out = await core.getFeeTiers(readProvider).catch(() => ({ thresholds: [], bps: [] }));
    feeCacheRef.current = { ts: now, value: out };
    return out;
  }, [readProvider]);

  const getCachedFixedPrice = useCallback(async (token) => {
    const key = String(token || "").toLowerCase();
    const now = Date.now();
    const hit = fixedCacheRef.current.get(key);
    if (hit && now - (hit.ts || 0) < FIXED_TTL_MS) return hit.value;
    const val = await core.fixedUsdPrice(readProvider, token).catch(() => 0n);
    fixedCacheRef.current.set(key, { ts: now, value: val });
    return val;
  }, [readProvider]);

  const getCachedUserLimit = useCallback(async (wallet) => {
    const now = Date.now();
    if (userLimitCacheRef.current.value && now - userLimitCacheRef.current.ts < USERLIMIT_TTL_MS) return userLimitCacheRef.current.value;
    const val = await core.getUserLimit(readProvider, wallet).catch(() => ({ remainingUSD: 0n }));
    userLimitCacheRef.current = { ts: now, value: val };
    return val;
  }, [readProvider]);

  useEffect(() => { preloadProofs().catch(() => {}); }, []);

  useEffect(() => {
    if (ctxProvider) return;
    try { core.getDefaultProvider(); }
    catch { setUiNotice((n) => n ?? { type: "warning", text: "RPC not configured (VITE_RPC_URL). Connect a wallet or set RPC URL." }); }
  }, [ctxProvider]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amountHuman), INPUT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [amountHuman, INPUT_DEBOUNCE_MS]);

  useEffect(() => {
    let alive = true;
    setBootStepsDone(0);
    setBootLogs([]);
    (async () => {
      try {
        if (!readProvider) return;
        setLoadingBase(true);
        addLog("Initializing vault data…");
        const [sup, w, u, bals] = await Promise.all([
          core.getSupportedTokens?.(readProvider).catch(() => []),
          core.wONE?.(readProvider).catch(() => ""),
          core.usdc?.(readProvider).catch(() => ""),
          core.getVaultBalances?.(readProvider).catch(() => ({ woneBalance: 0n, usdcBalance: 0n })),
        ]);
        if (!alive) return;
        const supArr = [...new Set((Array.isArray(sup) ? sup : []).map(a => a && String(a).toLowerCase()).filter(a => a && a !== '0x0000000000000000000000000000000000000000'))];
        stepOk(`Supported tokens: ${supArr.length}`);
        setSupportedTokens(supArr);
        setWone(w || "");
        setUsdc(u || "");
        setVaultBalances(bals || { woneBalance: 0n, usdcBalance: 0n });
        stepOk("Core addresses/balances loaded");
        if (u) {
          try {
            const erc = new Contract(u, ERC20_MINI, readProvider);
            const d = await erc.decimals();
            if (!alive) return;
            setUsdcDecimals(Number(d) || 6);
          } catch {
            if (!alive) return;
            setUsdcDecimals(6);
            stepWarn("USDC decimals fetch failed: using default 6");
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
        let entries = null;
        if (typeof core.batchBalances === "function") {
          try {
            const map = await core.batchBalances(readProvider, address, supportedTokens);
            if (map && typeof map === 'object') {
              entries = Object.entries(map).map(([addr, info]) => [String(addr).toLowerCase(), info]);
            }
          } catch {}
        }
        if (!entries) {
          const list = await Promise.all(
            supportedTokens.map(async (addr) => {
              try {
                const meta = await getTokenMetaCached(readProvider, addr);
                const erc = new Contract(addr, ERC20_MINI, readProvider);
                const bal = await erc.balanceOf(address).catch(() => 0n);
                return [String(addr).toLowerCase(), { raw: bal ?? 0n, decimals: meta.decimals, symbol: meta.symbol }];
              } catch {
                return [String(addr).toLowerCase(), { raw: 0n, decimals: 18, symbol: "TOKEN" }];
              }
            })
          );
          entries = list;
        }
        if (!alive) return;
        setBalances(new Map(entries));
        stepOk("Balances loaded");
      } finally {
        if (alive) setLoadingBalances(false);
      }
    })();
    return () => { alive = true; };
  }, [readProvider, address, supportedTokens]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setFixedPriceText("");
        if (!readProvider || !tokenIn) return;
        const p = await getCachedFixedPrice(tokenIn).catch(() => 0n);
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
  }, [readProvider, tokenIn, getCachedFixedPrice]);

  const { loading: wlLoading, ok: wlOk, error: wlError, proof: wlProof } = useWhitelist(address, readProvider);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!readProvider) return;
        const ri = await getCachedRoundInfo();
        if (!alive) return;
        setRoundActive(!!ri?.isActive);
      } catch {}
    })();
    return () => { alive = false; };
  }, [readProvider, getCachedRoundInfo]);

  useEffect(() => {
    let cancelled = false;
    const runId = ++runIdRef.current;
    (async () => {
      try {
        setReceivePreview(null);
        setAmountUSD18(0n);

        if (!readProvider || !address || !tokenIn || !redeemIn) return;
        if (!debouncedAmount || Number(debouncedAmount) <= 0) return;
        const amountIn = parseUnitsSafe(debouncedAmount, selectedDecimals);
        if (amountIn == null) {
          if (debouncedAmount) setUiNotice({ type: "warning", text: "Enter a valid amount" });
          return;
        } else if (uiNotice?.type === "warning" && uiNotice?.text === "Enter a valid amount") {
          setUiNotice(null);
        }

        const { remainingUSD: remainingInt } = await getCachedUserLimit(address);
        const remainingUSD18 = BigInt(remainingInt ?? 0n);
        if (!cancelled && runId === runIdRef.current) setLimitUSD18(remainingUSD18);

        const chainPromise = (async () => {
          try {
            const proof = wlProof || [];
            const q = await core.quoteRedeem(readProvider, address, tokenIn, amountIn, redeemIn, proof);
            return q || null;
          } catch { return null; }
        })();

        const first = await Promise.race([
          chainPromise,
          new Promise((res) => setTimeout(() => res("timeout"), CHAIN_QUOTE_TIMEOUT_MS))
        ]);

        const computeLocal = async () => {
          try {
            const tokenIsUSDC = usdc && tokenIn && String(usdc).toLowerCase() === String(tokenIn).toLowerCase();
            const tokenIsONE  = wone && tokenIn && String(wone).toLowerCase() === String(tokenIn).toLowerCase();
            let usd18 = 0n;
            if (tokenIsUSDC) {
              usd18 = amountIn * 10n ** 18n / 10n ** BigInt(usdcDecimals || 6);
            } else if (tokenIsONE) {
              const { price = 0n, decimals = 18 } = await getCachedOracle();
              if (price > 0n) {
                const price18 = price * 10n ** 18n / 10n ** BigInt(decimals);
                usd18 = amountIn * price18 / 10n ** BigInt(selectedDecimals);
              }
            } else {
              const fp = await getCachedFixedPrice(tokenIn).catch(() => 0n);
              if (fp > 0n) usd18 = amountIn * fp / 10n ** BigInt(selectedDecimals);
            }

            const tiers = await getCachedFeeTiers().catch(() => ({ thresholds: [], bps: [] }));
            const pickBps = (u18) => {
              const th = tiers.thresholds || [];
              let bpsArr = (tiers.bps || []).map((x) => Number(x || 0));
              // auto-detect: if every value <= 100, assume PERCENT and convert to BPS
              if (bpsArr.length && bpsArr.every((v) => v <= 100)) {
                bpsArr = bpsArr.map((v) => v * 100); // 1% -> 100 bps
              }
              for (let i = 0; i < th.length; i++) {
                const t = th[i] ?? 0n;
                if (u18 <= t) return Number(bpsArr[i] ?? 0);
              }
              return Number(bpsArr[(bpsArr.length || 1) - 1] || 0);
            };
            const bps = pickBps(usd18);
            const fee = amountIn * BigInt(bps) / 10000n;
            const net = amountIn - fee;
            const usdNet18 = amountIn > 0n ? usd18 * net / amountIn : 0n;

            const outIsUSDC = usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase();
            const outDec = outIsUSDC ? (usdcDecimals || 6) : 18;
            const outSym = outIsUSDC ? "USDC" : "wONE";

            let amountOut = 0n;
            if (outIsUSDC) {
              amountOut = usdNet18 * 10n ** BigInt(outDec) / 10n ** 18n;
            } else {
              const { price = 0n, decimals = 18 } = await getCachedOracle();
              if (price > 0n) {
                const price18 = price * 10n ** 18n / 10n ** BigInt(decimals);
                amountOut = usdNet18 * 10n ** 18n / price18;
              }
            }

            // Compute usdOut18 from the *output* token:
            // - if USDC: scale to 18 decimals
            // - if wONE: multiply by ONE/USD (18-dec), then normalize to 18
            let usdOut18 = 0n;
            if (outIsUSDC) {
              usdOut18 = amountOut * 10n ** 18n / 10n ** BigInt(outDec);
            } else {
              const { price = 0n, decimals = 18 } = await getCachedOracle();
              if (price > 0n) {
                const price18 = price * 10n ** 18n / 10n ** BigInt(decimals); // USD/ONE in 18-dec
                usdOut18 = amountOut * price18 / 10n ** 18n;
              }
            }

            if (!cancelled && runId === runIdRef.current) {
              // Use usdOut18 (output-based) as the amount that consumes the daily limit
              setAmountUSD18(usdOut18);
              setReceivePreview({
                raw: amountOut,
                decimals: outDec,
                symbol: outSym,
                feeAmountInTokenIn: fee,
                burnAmountInTokenIn: 0n,
                maxOut: amountOut,
                roundIsActive: true,
                whitelisted: !!(wlProof && wlProof.length),
                userLimitUsdAfter: null,
                usdOut18 // helpful for debugging/render if you want
              });
            }
          } catch {}
        };

        if (first && first !== "timeout") {
          const q = first;
          const outDec = typeof q.redeemInDecimals === "number"
            ? q.redeemInDecimals
            : (usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase())
              ? usdcDecimals
              : 18;
          const outSym = (usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase()) ? "USDC" : "wONE";
          if (!cancelled && runId === runIdRef.current) {
            // Derive usdOut18 from on-chain amountOut
            let usdOut18 = 0n;
            const amountOut = BigInt(q.amountOutRedeemToken ?? 0n);
            const outIsUSDC = usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase();
            if (outIsUSDC) {
              usdOut18 = amountOut * 10n ** 18n / 10n ** BigInt(outDec);
            } else {
              const { price = 0n, decimals = 18 } = await getCachedOracle();
              if (price > 0n) {
                const price18 = price * 10n ** 18n / 10n ** BigInt(decimals);
                usdOut18 = amountOut * price18 / 10n ** 18n;
              }
            }

            // Prefer on-chain userLimitUsdAfter; fallback to remaining - usdOut18
            const onChainAfter = q.userLimitUsdAfter != null ? BigInt(q.userLimitUsdAfter) : null;
            const after = onChainAfter != null ? onChainAfter
                        : (remainingUSD18 > usdOut18 ? (remainingUSD18 - usdOut18) : 0n);

            setAmountUSD18(usdOut18);
            setLimitUSD18(BigInt(q.userLimitUsdBefore ?? remainingUSD18));
            setReceivePreview({
              raw: amountOut,
              decimals: outDec,
              symbol: outSym,
              feeAmountInTokenIn: q.feeAmountInTokenIn ?? 0n,
              burnAmountInTokenIn: q.burnAmountInTokenIn ?? 0n,
              maxOut: amountOut,
              roundIsActive: !!q.roundIsActive,
              whitelisted: !!q.whitelisted,
              userLimitUsdAfter: after,
              usdOut18
            });
          }
        } else {
          await computeLocal();
          const qLater = await chainPromise;
          if (qLater && !cancelled && runId === runIdRef.current) {
            const outDec = typeof qLater.redeemInDecimals === "number"
              ? qLater.redeemInDecimals
              : (usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase())
                ? usdcDecimals
                : 18;
            const outSym = (usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase()) ? "USDC" : "wONE";
            let usdOut18 = 0n;
            const amountOut = BigInt(qLater.amountOutRedeemToken ?? 0n);
            const outIsUSDC = usdc && redeemIn && String(usdc).toLowerCase() === String(redeemIn).toLowerCase();
            if (outIsUSDC) {
              usdOut18 = amountOut * 10n ** 18n / 10n ** BigInt(outDec);
            } else {
              const { price = 0n, decimals = 18 } = await getCachedOracle();
              if (price > 0n) {
                const price18 = price * 10n ** 18n / 10n ** BigInt(decimals);
                usdOut18 = amountOut * price18 / 10n ** 18n;
              }
            }
            const onChainAfter = qLater.userLimitUsdAfter != null ? BigInt(qLater.userLimitUsdAfter) : null;
            const after = onChainAfter != null ? onChainAfter
                        : (remainingUSD18 > usdOut18 ? (remainingUSD18 - usdOut18) : 0n);

            setAmountUSD18(usdOut18);
            setLimitUSD18(BigInt(qLater.userLimitUsdBefore ?? remainingUSD18));
            setReceivePreview({
              raw: amountOut,
              decimals: outDec,
              symbol: outSym,
              feeAmountInTokenIn: qLater.feeAmountInTokenIn ?? 0n,
              burnAmountInTokenIn: qLater.burnAmountInTokenIn ?? 0n,
              maxOut: amountOut,
              roundIsActive: !!qLater.roundIsActive,
              whitelisted: !!qLater.whitelisted,
              userLimitUsdAfter: after,
              usdOut18
            });
          }
        }
      } catch {
        if (!cancelled && runId === runIdRef.current) setReceivePreview(null);
      }
    })();
    return () => { cancelled = true; };
  }, [readProvider, address, tokenIn, redeemIn, debouncedAmount, selectedDecimals, wlProof, usdc, usdcDecimals, wone, getCachedOracle, uiNotice, getCachedFixedPrice, getCachedFeeTiers, getCachedUserLimit]);

  const onMax = useCallback(async () => {
    try {
      const bal = BigInt(selectedBalance ?? 0n);
      const dec = BigInt(selectedDecimals ?? 18);
      const remain = BigInt(limitUSD18 ?? 0n);
      if (!tokenIn || remain <= 0n) {
        setAmountHuman(formatUnits(bal, Number(dec)));
        return;
      }
      const tokenIsUSDC = usdc && tokenIn && String(usdc).toLowerCase() === String(tokenIn).toLowerCase();
      const tokenIsONE  = wone && tokenIn && String(wone).toLowerCase() === String(tokenIn).toLowerCase();
      let price18 = 0n;
      if (tokenIsUSDC) {
        price18 = 10n ** 18n;
      } else if (tokenIsONE) {
        const { price = 0n, decimals = 18 } = await getCachedOracle();
        if (price > 0n) price18 = price * 10n ** 18n / 10n ** BigInt(decimals);
      } else {
        const fp = await getCachedFixedPrice(tokenIn).catch(() => 0n);
        if (fp > 0n) price18 = fp;
      }
      let byLimit = 0n;
      if (price18 > 0n) byLimit = remain * 10n ** dec / price18;
      const maxTok = byLimit > 0n ? (bal < byLimit ? bal : byLimit) : bal;
      const human = formatUnits(maxTok, Number(dec));
      setAmountHuman(human);
    } catch {}
  }, [selectedBalance, selectedDecimals, limitUSD18, tokenIn, usdc, wone, getCachedOracle, getCachedFixedPrice]);

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
      if (!isValidHuman(amountHuman)) throw new Error("Enter a valid amount");
      if (!wlLoading && !wlOk) throw new Error(wlError || "Address not whitelisted");

      if (RECAPTCHA_ENABLED && recaptchaSiteKey && recaptchaRef.current) {
        let tok = null;
        try { tok = await recaptchaRef.current.executeAsync(); } finally { recaptchaRef.current.reset(); }
        if (!tok) throw new Error("reCAPTCHA validation failed");
      }

      const amountIn = parseUnitsSafe(amountHuman, selectedDecimals);
      if (amountIn == null) throw new Error("Enter a valid amount");
      if (selectedBalance != null && BigInt(amountIn) > BigInt(selectedBalance)) {
        throw new Error("Insufficient balance for selected token");
      }

      const ri = await getCachedRoundInfo();
      if (!ri?.isActive) throw new Error("Round is not active");

      if (!receivePreview || receivePreview.raw === 0n) {
        throw new Error("Quote not available");
      }

      const proof = wlProof || [];
      await redeemSvc.approveForVaultIfNeeded(ctxSigner, tokenIn, address, amountIn);
      const rc = await redeemSvc.redeem(ctxSigner, tokenIn, amountIn, redeemIn, proof, {});
      setUiNotice({ type: "success", text: `Redeem confirmed in block ${rc?.blockNumber}` });
      setAmountHuman("");
      setReceivePreview(null);

      try {
        userLimitCacheRef.current = { ts: 0, value: null };
        const { remainingUSD } = await getCachedUserLimit(address);
        setLimitUSD18(BigInt(remainingUSD ?? 0n));
        setAmountUSD18(0n);
        oracleCacheRef.current = { ts: 0, value: null };
        roundCacheRef.current = { ts: 0, value: null };
        const ri2 = await getCachedRoundInfo();
        setRoundActive(!!ri2?.isActive);
      } catch {}

      try {
        if (readProvider && address && supportedTokens.length > 0) {
          let refreshed = null;
          if (typeof core.batchBalances === "function") {
            try {
              const map = await core.batchBalances(readProvider, address, supportedTokens);
              if (map && typeof map === 'object') {
                refreshed = Object.entries(map).map(([addr, info]) => [String(addr).toLowerCase(), info]);
              }
            } catch {}
          }
          if (!refreshed) {
            refreshed = await Promise.all(
              supportedTokens.map(async (addr) => {
                try {
                  const meta = await getTokenMetaCached(readProvider, addr);
                  const erc2 = new Contract(addr, ERC20_MINI, readProvider);
                  const bal = await erc2.balanceOf(address).catch(() => 0n);
                  return [String(addr).toLowerCase(), { raw: bal ?? 0n, decimals: meta.decimals, symbol: meta.symbol }];
                } catch {
                  return [String(addr).toLowerCase(), { raw: 0n, decimals: 18, symbol: "TOKEN" }];
                }
              })
            );
          }
          setBalances(new Map(refreshed));
        }
      } catch {}
    } catch (e) {
      setUiNotice({ type: "error", text: rpcFriendly(e) });
    } finally {
      setBusy(false);
    }
  }, [readProvider, ctxSigner, isConnected, address, tokenIn, redeemIn, amountHuman, selectedDecimals, selectedBalance, wlOk, wlError, wlLoading, wlProof, supportedTokens, receivePreview, getCachedRoundInfo, isValidHuman, parseUnitsSafe, getCachedUserLimit]);

  const hasWone = (vaultBalances?.woneBalance ?? 0n) > 0n;
  const hasUsdc = (vaultBalances?.usdcBalance ?? 0n) > 0n;

  const confirmDisabled = useMemo(() => {
    if (busy) return true;
    if (!isConnected || !address || !ctxSigner || !tokenIn || !redeemIn) return true;
    if (!debouncedAmount || Number(debouncedAmount) <= 0) return true;
    if (!isValidHuman(debouncedAmount)) return true;
    if (!wlLoading && !wlOk) return true;
    if (!roundActive) return true;
    if (!receivePreview || receivePreview.raw === 0n) return true;
    if (receivePreview?.userLimitUsdAfter != null) {
      const after = BigInt(receivePreview.userLimitUsdAfter);
      if (after <= 0n) return true;
    } else {
      if (amountUSD18 === 0n) return true;
      if (limitUSD18 !== 0n && amountUSD18 >= limitUSD18) return true;
    }
    return false;
  }, [busy, isConnected, address, ctxSigner, tokenIn, redeemIn, debouncedAmount, wlLoading, wlOk, amountUSD18, limitUSD18, receivePreview, isValidHuman, roundActive]);

  const isLoading = loadingBase || loadingBalances;
  const bootBusy = loadingBase || loadingBalances || wlLoading;
  const pendingSteps = (loadingBase ? 1 : 0) + (loadingBalances ? 1 : 0) + (wlLoading ? 1 : 0);
  const totalStepsDynamic = bootStepsDone + pendingSteps;
  const bootProgress = totalStepsDynamic > 0 ? Math.min(100, Math.round((bootStepsDone / totalStepsDynamic) * 100)) : null;

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
          <input className={styles.input} type="text" inputMode="decimal" placeholder="e.g. 100" value={amountHuman} onChange={(e) => setAmountHuman(e.target.value)} disabled={busy} />
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
            <span className={styles.contractRedeemValue}>{(() => {
              const afterOnChain = receivePreview?.userLimitUsdAfter;
              if (afterOnChain != null) {
                return `$${Number(formatUnits(BigInt(afterOnChain), 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
              }
              const before = limitUSD18 ?? 0n;
              const amt = amountUSD18 ?? 0n;
              const after = before > amt ? (before - amt) : 0n;
              return `$${Number(formatUnits(after, 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
            })()}</span>
          </div>
          {(receivePreview.burnAmountInTokenIn ?? 0n) > 0n && (
            <div className={styles.contractRedeemRow}>
              <span className={styles.contractRedeemLabel}>Amount burned</span>
              <span className={styles.contractRedeemValue}>{formatUnits(receivePreview.burnAmountInTokenIn ?? 0n, selectedDecimals)} {selectedSymbol}</span>
            </div>
          )}
        </div>
      )}
      {RECAPTCHA_ENABLED && recaptchaSiteKey && <ReCAPTCHA ref={recaptchaRef} size="invisible" sitekey={recaptchaSiteKey} />}
    </div>
  );
}
