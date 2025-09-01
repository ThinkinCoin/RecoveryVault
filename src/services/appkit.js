// services/appkit.js
import { createAppKit } from '@reown/appkit/react';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';
import { JsonRpcProvider } from 'ethers';

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);
const DEFAULT_RPC_FALLBACK = 'https://api.harmony.one';

function safeRpcUrl() {
  const cands = [
    import.meta.env.VITE_RPC_URL_HARMONY?.trim(),
    import.meta.env.VITE_RPC_URL?.trim(),
    DEFAULT_RPC_FALLBACK
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const u = new URL(c);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch {}
  }
  return DEFAULT_RPC_FALLBACK;
}

function toHttps(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') url.protocol = 'https:';
    return url.toString();
  } catch {
    return u;
  }
}

export const RPC_URL = safeRpcUrl();
export const PROJECT_ID = (import.meta.env.VITE_REOWN_PROJECT_ID || '').trim();
export const CAIP_ID = `eip155:${CHAIN_ID}`;

export const harmony = defineChain({
  id: CHAIN_ID,
  caipNetworkId: CAIP_ID,
  chainNamespace: 'eip155',
  name: 'Harmony',
  nativeCurrency: { name: 'ONE', symbol: 'ONE', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Harmony Explorer', url: 'https://explorer.harmony.one' } },
  testnet: false
});

const isProd = import.meta.env.PROD;
const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
const appUrl = isProd ? (import.meta.env.VITE_REOWN_APP_URL?.trim() || origin) : origin;
const appIconRaw = isProd ? (import.meta.env.VITE_REOWN_APP_ICON?.trim() || `${appUrl}/icon-512.png`) : `${origin}/icon-512.png`;
const appIcon = isProd ? toHttps(appIconRaw) : appIconRaw;

const metadata = {
  name: import.meta.env.VITE_PROJECT_NAME || import.meta.env.VITE_APP_NAME || 'Recovery Vault',
  description: 'Fixed redemption UI for pre-hack wallets (Harmony only)',
  url: appUrl,
  icons: [appIcon]
};

let _readProvider = /** @type {JsonRpcProvider|null} */ (null);
export function getReadProvider() {
  if (_readProvider) return _readProvider;
  try {
    _readProvider = new JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'harmony' });
  } catch (e) {
    console.error('[appkit] JsonRpcProvider creation failed:', e);
    _readProvider = null;
  }
  return _readProvider;
}
export const readProvider = getReadProvider();

let appkit = /** @type {import('@reown/appkit/react').AppKit | null} */(null);

export function ensureInit() {
  if (appkit || !PROJECT_ID) return appkit;

  const ethersAdapter = new EthersAdapter();

  const debugFlag = String(import.meta.env.VITE_APPKIT_DEBUG ?? (import.meta.env.DEV ? 'true' : 'false')) === 'true';

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
      connectMethodsOrder: ['wallet', 'qrcode']
    },

    customRpcUrls: { [CAIP_ID]: [{ url: RPC_URL }] },
    debug: debugFlag,
    metadata
  });

  return appkit;
}

export function ReownProvider({ children }) {
  try { ensureInit(); } catch (e) { console.error('[appkit] init failed:', e); }
  return children;
}

export function getAppKitInstance() {
  return ensureInit();
}

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

// Exported JSON-RPC debug wrapper to aid diagnosing RPC errors
// Wraps any EIP-1193 compatible provider.request and logs method/params on failures
export function attachRpcDebug(provider, label = 'wallet') {
  try {
    if (!provider || typeof provider.request !== 'function') return provider;

    // Avoid double wrapping (e.g., HMR)
    const FLAG = '__rvRpcDebugWrapped__';
    if (provider[FLAG]) return provider;

    const original = provider.request.bind(provider);
    Object.defineProperty(provider, FLAG, { value: true, enumerable: false });

    provider.request = async (args) => {
      try {
        return await original(args);
      } catch (e) {
        console.error('[RPC DEBUG]', label, args?.method, args?.params, e);
        throw e;
      }
    };
  } catch {}
  return provider;
}
