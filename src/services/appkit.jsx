// App-level provider for Reown AppKit (WalletConnect rebrand) + ethers v6 adapter
// All texts/logs in 

import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 1666600000);

export const harmony = {
  id: CHAIN_ID,
  name: 'Harmony',
  nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL] } },
  blockExplorers: {
    default: { name: 'Explorer', url: 'https://explorer.harmony.one' }
  }
};

const projectId = process.env.VITE_REOWN_PROJECT_ID;
if (!projectId) console.error('[AppKit] Missing VITE_REOWN_PROJECT_ID');

const metadata = {
  name: process.env.VITE_PROJECT_NAME || 'Recovery Dex',
  description: 'Fixed redemption UI for pre-hack wallets',
  url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  icons: [typeof window !== 'undefined' ? `${window.location.origin}/icon.png` : '']
};

// Important: create the AppKit instance at module scope (outside React trees)
const ethersAdapter = new EthersAdapter();

export const modal = createAppKit({
  adapters: [ethersAdapter],
  networks: [harmony],
  projectId,
  metadata,
  features: { analytics: true } // optional, also configurable no dashboard
});

// Ethers path doesn't need a special React provider wrapper.
// Keep API compatible with the rest of the app.
export function ReownProvider({ children }) {
  return children;
}

