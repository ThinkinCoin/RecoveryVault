// services/appkit.js
import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';
import { JsonRpcProvider } from 'ethers';

const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
const DEFAULT_RPC_FALLBACK = 'https://api.harmony.one';
const RPC_URL =
  (import.meta.env.VITE_RPC_URL_HARMONY?.trim() ||
   import.meta.env.VITE_RPC_URL?.trim() ||
   DEFAULT_RPC_FALLBACK);

const PROJECT_ID = (import.meta.env.VITE_REOWN_PROJECT_ID || '').trim();
const CAIP_ID = `eip155:${CHAIN_ID}`;

export const harmony = defineChain({
  id: CHAIN_ID,
  caipNetworkId: CAIP_ID,
  chainNamespace: 'eip155',
  name: 'Harmony',
  nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Harmony Explorer', url: 'https://explorer.harmony.one' } },
  testnet: false
});

const isProd = import.meta.env.PROD;
const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
const appUrl = isProd ? (import.meta.env.VITE_REOWN_APP_URL?.trim() || origin) : origin;
const appIcon = isProd ? (import.meta.env.VITE_REOWN_APP_ICON?.trim() || `${appUrl}/icon-512.png`) : `${origin}/icon-512.png`;

const metadata = {
  name: import.meta.env.VITE_APP_NAME || 'Recovery Vault',
  description: 'Fixed redemption UI for pre-hack wallets (Harmony only)',
  url: appUrl,
  icons: [appIcon]
};

export const readProvider = new JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'harmony' });

// ---------- AppKit singleton ----------
let appkit = /** @type {import('@reown/appkit/react').AppKit | null} */(null);

export function ensureInit() {
  if (appkit || !PROJECT_ID) return appkit;

  const ethersAdapter = new EthersAdapter(); // habilita tiles de carteiras injetadas (EIP-6963)

  appkit = createAppKit({
    projectId: PROJECT_ID,
    adapters: [ethersAdapter],

    networks: [harmony],
    defaultNetwork: harmony,
    allowUnsupportedChain: false,
    enableNetworkSwitch: true,

    enableWallets: true,
    enableWalletConnect: true,

    features: {
      analytics: false,
      swaps: false,
      onramp: false,
      connectMethodsOrder: ['wallet', 'qrcode', 'social', 'email']
    },

    customRpcUrls: { [CAIP_ID]: [{ url: RPC_URL }] },
    debug: true,
    metadata
  });

  return appkit;
}

// ✅ inicializa imediatamente, antes de qualquer hook useAppKit()
ensureInit();

export function ReownProvider({ children }) {
  // já inicializado; nada a fazer aqui
  return children;
}

export function getAppKitInstance() {
  return ensureInit();
}

// Helpers
export async function openConnect() {
  ensureInit()?.open?.({ view: 'Connect', namespace: 'eip155' });
}
export async function closeConnect() {
  appkit?.close?.();
}
export async function disconnectWallet() {
  try { await appkit?.disconnect?.(); } catch {}
}
export async function getActiveWalletProvider() {
  return ensureInit()?.getWalletProvider?.() || null;
}
