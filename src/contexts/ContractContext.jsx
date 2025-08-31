// ContractContext bound to Reown AppKit (React/Core) + ethers v6
// - Single-chain: Harmony (from env)
// - WC-first: NÃO toca window.ethereum aqui (injetadas aparecem no modal do AppKit)
// - Conecta/Desconecta via helpers do services/appkit
// - EN logs

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback
} from "react";
import { BrowserProvider } from "ethers";

import {
  readProvider,              // ethers JsonRpcProvider (read-only, Harmony)
  openConnect,               // abre modal (tiles injected + QR)
  getActiveWalletProvider,   // provider EIP-1193 ativo (WC ou injected via AppKit)
  disconnectWallet,          // encerra sessão ativa
  getAppKitInstance          // opcional: acesso direto à instância para subscribeProvider, se houver
} from "@/services/appkit";
import { useAppKitAccount } from "@reown/appkit/react";

const HARMONY_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);

const ContractContext = createContext({
  provider: null,   // ethers Provider (writes se conectado; caso contrário read-only)
  signer: null,     // ethers Signer (null se não conectado)
  account: null,    // checksummed address ou null
  chainId: HARMONY_CHAIN_ID,
  connect: async () => {},
  disconnect: async () => {}
});

export const useContractContext = () => useContext(ContractContext);

export function ContractProvider({ children }) {
  const [wcProvider, setWcProvider] = useState(null); // EIP-1193 vindo do AppKit
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const { address: kitAddress, isConnected: kitConnected } =
    useAppKitAccount({ namespace: "eip155" });

  // Provider ethers:
  // - se WC/injected via AppKit estiver ativo: BrowserProvider (read+write)
  // - caso contrário: read-only provider fixo
  const provider = useMemo(() => {
    try {
      if (wcProvider) return new BrowserProvider(wcProvider, "any");
      return readProvider;
    } catch (e) {
      console.error("[ContractContext] provider build error:", e);
      return readProvider;
    }
  }, [wcProvider]);

  // puxa estado inicial do AppKit (se já há sessão)
  const refreshFromAppKit = useCallback(async () => {
    try {
      const prov = await getActiveWalletProvider();
      if (!prov) {
        console.log("[ContractContext] no active AppKit provider");
        setWcProvider(null);
        setAccount(null);
        setSigner(null);
        return;
      }

      console.log("[ContractContext] got AppKit provider:", prov);

      let accounts = await prov.request?.({ method: "eth_accounts" }).catch(() => []);
      if ((!accounts || accounts.length === 0) && prov.request) {
        // Alguns providers só expõem a conta após request explícito
        try {
          accounts = await prov.request({ method: "eth_requestAccounts" });
        } catch {}
      }

      const addr = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null;

      setWcProvider(prov);
      setAccount(addr);
      console.log("[ContractContext] accounts:", accounts);

      if (addr) {
        try {
          const bp = new BrowserProvider(prov, "any");
          const s = await bp.getSigner();
          setSigner(s);
        } catch (e) {
          console.warn("[ContractContext] getSigner failed:", e);
          setSigner(null);
        }
      } else {
        setSigner(null);
      }
    } catch (err) {
      console.warn("[ContractContext] refreshFromAppKit failed:", err);
      setWcProvider(null);
      setAccount(null);
      setSigner(null);
    }
  }, []);

  // Util: attach/detach EIP-1193 events (accountsChanged/chainChanged/disconnect)
  useEffect(() => {
    if (!wcProvider || typeof wcProvider.on !== "function") return;

    const onAccounts = (accs) => {
      const addr = Array.isArray(accs) && accs[0] ? String(accs[0]) : null;
      console.log("[ContractContext] accountsChanged:", accs);
      setAccount(addr || null);

      if (addr) {
        new BrowserProvider(wcProvider, "any")
          .getSigner()
          .then(setSigner)
          .catch((e) => {
            console.warn("[ContractContext] getSigner on accountsChanged failed:", e);
            setSigner(null);
          });
      } else {
        setSigner(null);
      }
    };

    const onChain = (cid) => {
      console.log("[ContractContext] chainChanged:", cid);
      // single-chain; apenas refaz signer se necessário
      if (account) {
        new BrowserProvider(wcProvider, "any")
          .getSigner()
          .then(setSigner)
          .catch((e) => {
            console.warn("[ContractContext] getSigner on chainChanged failed:", e);
            setSigner(null);
          });
      }
    };

    const onDisconnect = (ev) => {
      console.log("[ContractContext] disconnect:", ev);
      setSigner(null);
      setAccount(null);
      setWcProvider(null);
    };

    try {
      wcProvider.on("accountsChanged", onAccounts);
      wcProvider.on("chainChanged", onChain);
      wcProvider.on("disconnect", onDisconnect);
    } catch {}

    return () => {
      try {
        const off = wcProvider.removeListener || wcProvider.off;
        off?.call(wcProvider, "accountsChanged", onAccounts);
        off?.call(wcProvider, "chainChanged", onChain);
        off?.call(wcProvider, "disconnect", onDisconnect);
      } catch {}
    };
  }, [wcProvider, account]);

  // (Opcional) subscribe via AppKit instance, se disponível
  useEffect(() => {
    let unsubscribe = () => {};
    (async () => {
      try {
        const inst = getAppKitInstance?.();
        if (inst && typeof inst.subscribeProvider === "function") {
          unsubscribe = inst.subscribeProvider((evt) => {
            // evt: { address?, chainId?, isConnected?, provider?, providerType? }
            console.log("[ContractContext] AppKit subscribeProvider evt:", evt);
            if (evt?.provider) setWcProvider(evt.provider);
            if (typeof evt?.address === "string") setAccount(evt.address || null);

            if (evt?.provider && evt?.address) {
              new BrowserProvider(evt.provider, "any")
                .getSigner()
                .then(setSigner)
                .catch((e) => {
                  console.warn("[ContractContext] getSigner on subscribeProvider failed:", e);
                  setSigner(null);
                });
            } else if (!evt?.address) {
              setSigner(null);
            }
          });
        }
      } catch {
        // ignore
      } finally {
        await refreshFromAppKit();
      }
    })();

    return () => {
      try { unsubscribe?.(); } catch {}
    };
  }, [refreshFromAppKit]);

    // ✅ Sincroniza com o AppKit: quando conectar/desconectar, atualiza o contexto
  useEffect(() => {
    if (!kitConnected) {
      setSigner(null);
      setAccount(null);
      setWcProvider(null);
      return;
    }
    // Conectado: busca o provider/signature atuais do AppKit
    refreshFromAppKit();
  }, [kitConnected, kitAddress, refreshFromAppKit]);

  // connect via modal AppKit
  const connect = useCallback(async () => {
    try {
      await openConnect();
      await refreshFromAppKit();
    } catch (e) {
      console.error("[ContractContext] connect error:", e);
    }
  }, [refreshFromAppKit]);

  // disconnect via AppKit
  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } catch (e) {
      console.error("[ContractContext] disconnect error:", e);
    } finally {
      setSigner(null);
      setAccount(null);
      setWcProvider(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      provider,
      signer,
      account,
      chainId: HARMONY_CHAIN_ID,
      connect,
      disconnect
    }),
    [provider, signer, account, connect, disconnect]
  );

  return <ContractContext.Provider value={value}>{children}</ContractContext.Provider>;
}
