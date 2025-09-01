// ContractContext bound to Reown AppKit (React/Core) + ethers v6
// Single-chain Harmony; debounced signer rebuild with event-storm guards

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef
} from "react";
import { BrowserProvider } from "ethers";

import {
  readProvider,
  openConnect,
  getActiveWalletProvider,
  disconnectWallet,
  getAppKitInstance,
  CHAIN_ID as EXPORTED_CHAIN_ID
} from "@/services/appkit";
import { useAppKitAccount } from "@reown/appkit/react";

const HARMONY_CHAIN_ID = EXPORTED_CHAIN_ID;
const SIGNER_BUILD_DEBOUNCE_MS = Number(
  import.meta.env.VITE_SIGNER_BUILD_DEBOUNCE_MS ?? 200
); // configurable debounce via env

/**
 * Centralized JSON-RPC error utilities
 */
export function parseRpcError(err) {
  if (!err) return { code: undefined, dataCode: undefined, message: "", dataMessage: "" };
  const code = err.code ?? err?.error?.code;
  const dataCode = err?.data?.code ?? err?.error?.data?.code;
  const message = String(err.message || err?.error?.message || err?.shortMessage || err?.reason || "");
  const dataMessage = String(err?.data?.message || err?.error?.data?.message || "");
  const lower = (message || dataMessage).toLowerCase();
  return { code, dataCode, message, dataMessage, lower };
}

export function rpcErrorMessage(err) {
  const { code, dataCode, message, dataMessage, lower } = parseRpcError(err);
  const txt = (dataMessage || message || "").toString();
  if (code === 4001 || /user rejected|userrejectedrequest|action_rejected/i.test(txt)) return "Request rejected by user";
  if (code === -32002) return "Wallet request already pending. Check your wallet";
  if (/execution reverted|call revert/i.test(txt)) return txt;
  if (/insufficient funds|underpriced|replacement transaction underpriced|fee cap too low/i.test(lower)) return "Insufficient funds or gas/fee underpriced";
  if (/nonce too low|already known|replacement|conflict/i.test(lower)) return "Nonce conflict or replacement transaction issue";
  if (code === -32601 || /method not found/i.test(lower)) return "RPC method not found (check provider and chain)";
  if (/rate limit|429|timeout|network error|gateway timeout/i.test(lower)) return "Network/Rate limit issue. Try again or switch RPC";
  if (/provider\s*disconnected|chain\s*disconnected|network disconnected/i.test(lower)) return "Wallet/provider disconnected";
  if (code === -32603 || dataCode === -32603) return "RPC internal error";
  return txt || "Unexpected error";
}

// --- Provider cache to avoid repeated BrowserProvider constructions ---
const providerCache = new WeakMap();
function getBrowserProvider(p) {
  if (!p) return null;
  let cached = providerCache.get(p);
  if (!cached) {
    cached = new BrowserProvider(p, "any");
    providerCache.set(p, cached);
  }
  return cached;
}

const ContractContext = createContext({
  provider: null,
  signer: null,
  account: null,
  chainId: HARMONY_CHAIN_ID, // initial expected chain
  connect: async () => {},
  disconnect: async () => {}
});

export const useContractContext = () => useContext(ContractContext);

async function buildSigner(p) {
  const bp = getBrowserProvider(p);
  return bp ? await bp.getSigner() : null;
}

// Helper to attach/detach provider listeners safely
function manageProviderListeners(prov, { onAccounts, onChain, onDisconnect }, attach = true) {
  if (!prov || typeof prov.on !== "function") return;
  try {
    const fn = attach ? prov.on.bind(prov) : (prov.removeListener || prov.off)?.bind(prov);
    fn?.("accountsChanged", onAccounts);
    fn?.("chainChanged", onChain);
    fn?.("disconnect", onDisconnect);
  } catch (e) {
    console.warn("[ContractContext] manageProviderListeners failed:", e);
  }
}

export function ContractProvider({ children }) {
  const [wcProvider, setWcProvider] = useState(null);
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [chainId, setChainId] = useState(HARMONY_CHAIN_ID); // expose actual chainId from provider

  const prevAccountRef = useRef(null);
  const prevChainIdRef = useRef(null);
  const buildTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const { isConnected: kitConnected } = useAppKitAccount({ namespace: "eip155" });

  const provider = useMemo(() => {
    try {
      if (wcProvider) return getBrowserProvider(wcProvider) || readProvider;
    } catch (e) {
      console.error("[ContractContext] provider build error:", e);
    }
    return readProvider;
  }, [wcProvider]);

  const clearBuildTimer = useCallback(() => {
    if (buildTimerRef.current) {
      clearTimeout(buildTimerRef.current);
      buildTimerRef.current = null;
    }
  }, []);

  // Debounced signer build. Accepts optional override delay for adaptive behavior.
  const scheduleSignerBuild = useCallback(async (prov, delayMs = SIGNER_BUILD_DEBOUNCE_MS) => {
    clearBuildTimer();
    buildTimerRef.current = setTimeout(async () => {
      try {
        if (unmountedRef.current) return;
        const s = await buildSigner(prov);
        if (!unmountedRef.current) setSigner(s);
      } catch (e) {
        console.warn("[ContractContext] getSigner (debounced) failed:", e);
        if (!unmountedRef.current) setSigner(null);
      }
    }, Math.max(0, Number(delayMs) || 0));
  }, []); // stable; do not capture changing deps

  const refreshFromAppKit = useCallback(async () => {
    try {
      const prov = await getActiveWalletProvider();
      if (!prov) {
        if (wcProvider !== null) setWcProvider(null);
        setAccount(null);
        setSigner(null);
        prevAccountRef.current = null;
        prevChainIdRef.current = null;
        setChainId(HARMONY_CHAIN_ID);
        return;
      }

      // Safe read-only accounts query; avoids wallet popup
      let accounts = [];
      try {
        accounts = await prov.request?.({ method: "eth_accounts" });
      } catch (rqErr) {
        console.warn("[ContractContext] eth_accounts failed:", rqErr);
        accounts = [];
      }

      // Try reading current chain id from provider when available
      try {
        const hex = await prov.request?.({ method: "eth_chainId" });
        const parsed = typeof hex === "string" ? parseInt(hex, 16) : Number(hex);
        if (!Number.isNaN(parsed) && parsed !== prevChainIdRef.current) {
          prevChainIdRef.current = parsed;
          setChainId(parsed);
        }
      } catch (cidErr) {
        // Non-fatal: keep previous chainId
        console.warn("[ContractContext] eth_chainId failed:", cidErr);
      }

      const addr = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null;

      if (wcProvider !== prov) setWcProvider(prov);
      if (addr !== prevAccountRef.current) {
        prevAccountRef.current = addr || null;
        setAccount(addr || null);
        if (addr) await scheduleSignerBuild(prov);
        else setSigner(null);
      }
    } catch (err) {
      console.error("[ContractContext] refreshFromAppKit error:", err, rpcErrorMessage(err));
      if (wcProvider !== null) setWcProvider(null);
      setAccount(null);
      setSigner(null);
      prevAccountRef.current = null;
      prevChainIdRef.current = null;
      setChainId(HARMONY_CHAIN_ID);
    }
  }, [scheduleSignerBuild, wcProvider]);

  // Keep latest functions in refs to allow stable connect/disconnect
  const refreshRef = useRef(refreshFromAppKit);
  const clearRef = useRef(clearBuildTimer);
  useEffect(() => { refreshRef.current = refreshFromAppKit; }, [refreshFromAppKit]);
  useEffect(() => { clearRef.current = clearBuildTimer; }, [clearBuildTimer]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearBuildTimer();
    };
  }, [clearBuildTimer]);

  useEffect(() => {
    if (!wcProvider) return;

    const onAccounts = async (accs) => {
      const addr = Array.isArray(accs) && accs[0] ? String(accs[0]) : null;
      if (addr === prevAccountRef.current) return;
      prevAccountRef.current = addr || null;
      setAccount(addr || null);
      if (addr) await scheduleSignerBuild(wcProvider);
      else setSigner(null);
    };

    const onChain = async (chainIdHex) => {
      const hex = typeof chainIdHex === "string" ? chainIdHex : "";
      const parsed = hex ? parseInt(hex, 16) : null;
      if (parsed != null) {
        if (parsed !== prevChainIdRef.current) {
          prevChainIdRef.current = parsed;
          setChainId(parsed);
        }
      }
      // Rebuild signer even if account did not change — chain context affects gas/nonce
      await scheduleSignerBuild(wcProvider, 100); // slightly faster rebuild on chain switch
    };

    const onDisconnect = () => {
      clearBuildTimer();
      setSigner(null);
      setAccount(null);
      if (wcProvider) providerCache.delete(wcProvider); // explicit invalidation
      setWcProvider(null);
      prevAccountRef.current = null;
      prevChainIdRef.current = null;
      setChainId(HARMONY_CHAIN_ID);
    };

    manageProviderListeners(wcProvider, { onAccounts, onChain, onDisconnect }, true);
    return () => manageProviderListeners(wcProvider, { onAccounts, onChain, onDisconnect }, false);
  }, [wcProvider, scheduleSignerBuild, clearBuildTimer]);

  useEffect(() => {
    let unsubscribe = () => {};
    (async () => {
      try {
        const inst = getAppKitInstance?.();
        if (inst && typeof inst.subscribeProvider === "function") {
          unsubscribe = inst.subscribeProvider(async (evt) => {
            if (evt?.provider && wcProvider !== evt.provider) setWcProvider(evt.provider);
            if (typeof evt?.address === "string" && evt.address !== prevAccountRef.current) {
              prevAccountRef.current = evt.address || null;
              setAccount(evt.address || null);
            }
            if (evt?.chainId != null) {
              const cid = typeof evt.chainId === "string" ? parseInt(evt.chainId, 16) : Number(evt.chainId);
              if (!Number.isNaN(cid) && cid !== prevChainIdRef.current) {
                prevChainIdRef.current = cid;
                setChainId(cid);
              }
            }
            if (evt?.provider && (evt?.address || evt?.chainId != null)) await scheduleSignerBuild(evt.provider);
            if (!evt?.address) setSigner(null);
          });
        }
      } catch (subErr) {
        console.warn("[ContractContext] subscribeProvider failed:", subErr);
      } finally {
        await refreshFromAppKit();
      }
    })();
    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, [refreshFromAppKit, scheduleSignerBuild, wcProvider]);

  useEffect(() => {
    if (!kitConnected) {
      clearBuildTimer();
      setSigner(null);
      setAccount(null);
      if (wcProvider) providerCache.delete(wcProvider); // explicit invalidation
      setWcProvider(null);
      prevAccountRef.current = null;
      prevChainIdRef.current = null;
      setChainId(HARMONY_CHAIN_ID);
      return;
    }
    refreshFromAppKit();
  }, [kitConnected, refreshFromAppKit, clearBuildTimer, wcProvider]);

  // Stable connect/disconnect (no deps) using refs to latest functions
  const connect = useCallback(async () => {
    try {
      await openConnect();
      await refreshRef.current?.();
      return { ok: true };
    } catch (e) {
      const msg = rpcErrorMessage(e);
      console.error("[ContractContext] connect error:", e);
      return { ok: false, error: msg };
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
      return { ok: true };
    } catch (e) {
      const msg = rpcErrorMessage(e);
      console.error("[ContractContext] disconnect error:", e);
      return { ok: false, error: msg };
    } finally {
      clearRef.current?.();
      setSigner(null);
      setAccount(null);
      if (wcProvider) providerCache.delete(wcProvider); // explicit invalidation
      setWcProvider(null);
      prevAccountRef.current = null;
      prevChainIdRef.current = null;
      setChainId(HARMONY_CHAIN_ID);
    }
  }, [wcProvider]);

  const value = useMemo(
    () => ({ provider, signer, account, chainId, connect, disconnect }),
    [provider, signer, account, chainId]
  );

  return <ContractContext.Provider value={value}>{children}</ContractContext.Provider>;
}
