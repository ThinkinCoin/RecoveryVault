// ContractContext bound to Reown AppKit provider (WalletConnect) + ethers v6
// - Single-chain: Harmony (from env)
// - Never touches window.ethereum (prevents MetaMask from hijacking flow)
// - Connect/Disconnect routed through AppKit modal
// - English-only logs

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";
import { useAppKitProvider, useAppKitAccount, useAppKit, useDisconnect } from "@reown/appkit/react";

const HARMONY_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
const RPC_URL =
  import.meta.env.VITE_RPC_URL_HARMONY ??
  import.meta.env.VITE_RPC_URL ??
  "";

const ContractContext = createContext({
  provider: null,
  signer: null,
  account: null,
  chainId: HARMONY_CHAIN_ID,
  connect: async () => {},
  disconnect: () => {}
});

export const useContractContext = () => useContext(ContractContext);

export function ContractProvider({ children }) {
  // IMPORTANT: namespace hooks to EVM (eip155)
  const { walletProvider } = useAppKitProvider("eip155"); // EIP-1193 from AppKit (WC, multisig, etc.)
  const { isConnected, address } = useAppKitAccount({ namespace: "eip155" }); // Account state from AppKit
  const { open } = useAppKit();                           // Controls the AppKit modal
  const { disconnect: wcDisconnect } = useDisconnect();   // AppKit-aware disconnect

  const [signer, setSigner] = useState(null);

  // Only allow signing when AppKit delivered a walletProvider AND we are connected
  const canSign = useMemo(() => Boolean(walletProvider && isConnected), [walletProvider, isConnected]);

  // Build read/write provider:
  // - If connected via AppKit: Wrap AppKit's walletProvider with ethers BrowserProvider (writes)
  // - Else: use public RPC as JsonRpcProvider (reads)
  const provider = useMemo(() => {
    try {
      if (canSign) {
        return new BrowserProvider(walletProvider);
      }
      if (RPC_URL) {
        return new JsonRpcProvider(RPC_URL, HARMONY_CHAIN_ID);
      }
      console.error("[ContractContext] Missing RPC_URL for fallback provider.");
      return null;
    } catch (e) {
      console.error("[ContractContext] Provider init error:", e);
      return null;
    }
  }, [walletProvider, canSign]);

  // Keep signer in sync with walletProvider (avoid getSigner() on JsonRpcProvider)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!canSign || !walletProvider) {
        setSigner(null);
        return;
      }
      try {
        const writable = new BrowserProvider(walletProvider);
        const s = await writable.getSigner();
        if (!cancelled) setSigner(s);
      } catch (e) {
        console.error("[ContractContext] getSigner error:", e);
        if (!cancelled) setSigner(null);
      }
    })();
    return () => { cancelled = true; };
  }, [walletProvider, canSign]);

  // AppKit-based connect (opens modal in EVM namespace)
  const connect = useCallback(async () => {
    try {
      await open({ view: "Connect", namespace: "eip155" });
    } catch (e) {
      console.error("[ContractContext] connect error:", e);
    }
  }, [open]);

  // AppKit-based disconnect
  const disconnect = useCallback(() => {
    try {
      wcDisconnect();
    } catch (e) {
      console.error("[ContractContext] disconnect error:", e);
    } finally {
      setSigner(null);
    }
  }, [wcDisconnect]);

  const value = useMemo(() => ({
    provider,
    signer,
    account: address || null,
    chainId: HARMONY_CHAIN_ID, // single-chain locked by AppKit config
    connect,
    disconnect
  }), [provider, signer, address, connect, disconnect]);

  return <ContractContext.Provider value={value}>{children}</ContractContext.Provider>;
}
