// App-level provider for Reown AppKit (WalletConnect) + ethers v6 adapter
// All texts/logs in English

import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';
import { BrowserProvider, JsonRpcProvider } from 'ethers';

// -----------------------------
// Environment & constants
// -----------------------------
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000); // Harmony Mainnet
const DEFAULT_RPC_FALLBACK = 'https://api.harmony.one';

// Prefer Harmony-specific RPC first, then generic fallback
const RPC_URL =
  (import.meta.env.VITE_RPC_URL_HARMONY?.trim() ||
    import.meta.env.VITE_RPC_URL?.trim() ||
    DEFAULT_RPC_FALLBACK);

// CAIP format for WalletConnect/AppKit
const CAIP_ID = `eip155:${CHAIN_ID}`;

// Useful hex chain id (MetaMask expects 0x...)
const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`.toLowerCase(); // "0x63564c40"

// -----------------------------
// Chain definition (Harmony only)
// -----------------------------
export const harmony = defineChain({
  id: CHAIN_ID,
  caipNetworkId: CAIP_ID,
  chainNamespace: 'eip155',
  name: 'Harmony',
  nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Harmony Explorer', url: 'https://explorer.harmony.one' }
  },
  testnet: false
});

// -----------------------------
// App metadata
// -----------------------------
const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID || '').trim();
if (!projectId) {
  console.error('[AppKit] Missing VITE_REOWN_PROJECT_ID (WalletConnect project id).');
}

const isProd = import.meta.env.PROD;
const pageOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
const appUrl = isProd
  ? (import.meta.env.VITE_REOWN_APP_URL?.trim() || pageOrigin)
  : pageOrigin;
const appIcon = isProd
  ? (import.meta.env.VITE_REOWN_APP_ICON?.trim() || `${appUrl}/icon-512.png`)
  : `${pageOrigin}/icon-512.png`;

const metadata = {
  name: import.meta.env.VITE_APP_NAME || 'Recovery Vault',
  description: 'Fixed redemption UI for pre-hack wallets (Harmony only)',
  url: appUrl,
  icons: [appIcon]
};

// -----------------------------
// Reown AppKit (Harmony-locked)
// -----------------------------
const ethersAdapter = new EthersAdapter();

// Only initialize if we actually have a WalletConnect Project ID
export const appkit = projectId
  ? createAppKit({
      adapters: [ethersAdapter],
      networks: [harmony],            // <- ONLY Harmony
      defaultNetwork: harmony,
      allowUnsupportedChain: false,   // <- disallow anything else
      enableNetworkSwitch: false,     // <- hide/disable network switcher
      enableReconnect: false,         // <- avoid reusing stale multichain sessions

      // Wallets
      enableWalletConnect: true,
      enableWallets: true,

      // WC/AppKit metadata
      projectId,
      metadata,

      // Hard-pin RPC for Harmony
      customRpcUrls: {
        [CAIP_ID]: [{ url: RPC_URL }]
      },

      // Restrict the Universal Provider (WalletConnect) strictly to Harmony
      // IMPORTANT: values must be CAIP (e.g., 'eip155:1666600000'), not numeric ids
      universalProviderConfigOverride: {
        chains: { eip155: [CAIP_ID] },
        defaultChain: CAIP_ID,
        rpcMap: { [CAIP_ID]: RPC_URL },
        // keep minimal method/event surface
        methods: { eip155: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData'] },
        events: { eip155: ['chainChanged', 'accountsChanged'] }
      },

      // Diagnostics
      debug: true,

      // Turn off extras
      features: { analytics: false, swaps: false, onramp: false }
    })
  : null;

// -----------------------------
// Ethers v6 providers (read/write)
// -----------------------------

/**
 * Read-only provider: always Harmony RPC.
 * Does NOT depend on the connected wallet.
 */
export const readProvider = new JsonRpcProvider(RPC_URL);

/**
 * Ensures the injected provider (e.g., MetaMask) is on Harmony.
 * Tries switch; if chain not added, tries add+switch.
 */
export async function ensureHarmonyNetwork(ethProvider) {
  if (!ethProvider?.request) return;

  const current = await ethProvider.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() === CHAIN_ID_HEX) return;

  try {
    await ethProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CHAIN_ID_HEX }]
    });
  } catch (err) {
    if (err?.code === 4902) {
      // Chain not added
      await ethProvider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'Harmony Mainnet',
          rpcUrls: [RPC_URL],
          nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
          blockExplorerUrls: ['https://explorer.harmony.one/']
        }]
      });
      await ethProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }]
      });
    } else {
      console.error('[Network] Failed to switch to Harmony', err);
      throw err;
    }
  }
}

/**
 * Returns a BrowserProvider bound to the injected wallet,
 * guaranteeing the network is Harmony.
 */
export async function getBrowserProvider() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('Wallet not found');
  }
  await ensureHarmonyNetwork(window.ethereum);
  // 'any' allows hot chain switching without recreating the provider
  return new BrowserProvider(window.ethereum, 'any');
}

/**
 * Returns a signer on Harmony. Throws if wrong network.
 */
export async function getHarmonySigner() {
  const browser = await getBrowserProvider();
  const net = await browser.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error('Wrong network. Please switch to Harmony.');
  }
  return browser.getSigner();
}

// -----------------------------
// React wrapper (kept minimal)
// -----------------------------
export function ReownProvider({ children }) {
  // If projectId is missing we still render the app; only the connect modal is disabled.
  return children;
}

// -----------------------------
// Notes for callers:
// - Always use `readProvider` for safe reads (quotes, views).
// - For writes (redeem/swap), get signer via `getHarmonySigner()`.
// - Fees on Harmony are legacy (type 0 + gasPrice); do NOT try EIP-1559.
//   Ensure your tx utils call `getGasPrice()` and set `{ type: 0, gasPrice }`.
// -----------------------------
