// App-level provider for Reown AppKit (WalletConnect) + ethers v6 adapter
// All texts/logs in English

import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);

// Prefer the Harmony var, fall back to generic
const RPC_URL =
  import.meta.env.VITE_RPC_URL_HARMONY ??
  import.meta.env.VITE_RPC_URL ??
  '';

const CAIP_ID = `eip155:${CHAIN_ID}`;

export const harmony = defineChain({
  id: CHAIN_ID,
  caipNetworkId: CAIP_ID,
  chainNamespace: 'eip155',
  name: 'Harmony',
  nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Harmony Explorer', url: 'https://explorer.harmony.one' }
  }
});

// Vite uses import.meta.env, not process.env
const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID || '6ff2ca0616c53aac6bc306fe0b678a8f').trim();
if (!projectId) {
  console.error('[AppKit] Missing VITE_REOWN_PROJECT_ID');
}

const isProd = import.meta.env.PROD;
const pageOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
const appUrl = isProd
  ? (import.meta.env.VITE_REOWN_APP_URL || pageOrigin)
  : pageOrigin;
const appIcon = isProd
  ? (import.meta.env.VITE_REOWN_APP_ICON || `${appUrl}/icon-512.png`)
  : `${pageOrigin}/icon-512.png`;

const metadata = {
  name: import.meta.env.VITE_APP_NAME || 'Recovery Vault',
  description: 'Fixed redemption UI for pre-hack wallets',
  url: appUrl,
  icons: [appIcon]
};

// Important: create the AppKit instance at module scope (outside React trees)
const ethersAdapter = new EthersAdapter();

// Only initialize if we actually have a projectId to avoid 400/403 noise
export const modal = projectId
  ? createAppKit({
      adapters: [ethersAdapter],
      networks: [harmony],
      projectId,
      metadata,

      // Harmony-only UX
      defaultNetwork: harmony,
      enableNetworkSwitch: false,
      allowUnsupportedChain: false,

      // Keep WalletConnect enabled and allow injected wallets if needed
      enableWalletConnect: true,
      enableWallets: true,

      // Hard-pin RPC for Harmony
      customRpcUrls: {
        [CAIP_ID]: [{ url: RPC_URL }]
      },

      // Restrict WC provider strictly to Harmony
      universalProviderConfigOverride: {
        // IMPORTANT: chains must be CAIP strings, not numeric ids
        chains: { eip155: [CAIP_ID] },
        defaultChain: CAIP_ID,
        rpcMap: { [CAIP_ID]: RPC_URL }
      },

      // Helpful while testing
      enableReconnect: true,
      debug: true,

      // Disable extras we don't use
      features: { analytics: false, swaps: false, onramp: false }
    })
  : null;

// Ethers path doesn't need a special React provider wrapper.
// Keep API compatible with the rest of the app.
export function ReownProvider({ children }) {
  if (!projectId) {
    // Render children anyway; just the connect modal is disabled.
    return children;
  }
  return children;
}
