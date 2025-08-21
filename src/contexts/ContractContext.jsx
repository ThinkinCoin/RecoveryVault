// src/contexts/ContractContext.jsx
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";

const ContractContext = createContext({
  provider: null,
  signer: null,
  account: null,
  chainId: null,
  connect: async () => {},
  disconnect: () => {}
});

export const useContractContext = () => useContext(ContractContext);
  // ✅ Alias para compatibilidade com componentes antigos
  

// ✅ e exporte o provider (se ainda não tiver)
export function ContractProvider({ children }) {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);

  // pick provider: injected (BrowserProvider) or fallback RPC
  useEffect(() => {
    const rpcUrl = import.meta.env.VITE_RPC_URL_HARMONY;
    const fallback = rpcUrl ? new JsonRpcProvider(rpcUrl, Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000)) : null;

    if (typeof window !== "undefined" && window.ethereum) {
      const injected = new BrowserProvider(window.ethereum);
      setProvider(injected);
      (async () => {
        try {
          const net = await injected.getNetwork();
          setChainId(Number(net.chainId));
        } catch (e) {
          console.error("[ContractContext] getNetwork error:", e);
        }
      })();
    } else if (fallback) {
      setProvider(fallback);
      (async () => {
        try {
          const net = await fallback.getNetwork();
          setChainId(Number(net.chainId));
        } catch (e) {
          console.error("[ContractContext] fallback getNetwork error:", e);
        }
      })();
    } else {
      console.error("[ContractContext] No provider available (no window.ethereum and no VITE_RPC_URL_HARMONY).");
    }
  }, []);

  const connect = useCallback(async () => {
    try {
      if (!provider || !("send" in provider)) {
        console.warn("[ContractContext] connect: provider not injectable, skipping requestAccounts.");
      } else {
        await provider.send("eth_requestAccounts", []);
      }
      const _signer = await provider.getSigner();
      const addr = await _signer.getAddress();
      setSigner(_signer);
      setAccount(addr);
    } catch (e) {
      console.error("[ContractContext] connect error:", e);
    }
  }, [provider]);

  const disconnect = useCallback(() => {
    setSigner(null);
    setAccount(null);
  }, []);

  // handle account / chain changes (if injected)
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const eth = window.ethereum;

    const onAccounts = (accs) => {
      const a = Array.isArray(accs) && accs.length ? accs[0] : null;
      setAccount(a);
      setSigner(null); // force refresh signer on next connect
    };
    const onChain = (hexId) => {
      try { setChainId(parseInt(hexId, 16)); } catch { setChainId(null); }
      setSigner(null);
    };

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const value = useMemo(() => ({
    provider, signer, account, chainId, connect, disconnect
  }), [provider, signer, account, chainId, connect, disconnect]);

  return <ContractContext.Provider value={value}>{children}</ContractContext.Provider>;
}
