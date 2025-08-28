// src/services/whitelistService.js
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";

/**
 * Estratégia:
 * 1) Carrega apenas o merkleRoot (rápido).
 * 2) Busca prova sob demanda para o endereço:
 *    - /proofs/<root>/<address>.json           (per-address)
 *    - /proofs/<root>/<shard>.json             (256 shards por 2 hex)
 *    - /proofs/<address>.json                  (per-address legacy)
 *    - /proofs/<shard>.json                    (shard legacy)
 *    - Fallback: proofs.json grande            (como hoje)
 * 3) Cache local em localStorage por root+address.
 */

// -------- config & cache --------
const BASE = (import.meta?.env?.VITE_PROOF_BASE_PATH || "").replace(/\/+$/, "");
const URLS = {
  merkleRoot: [
    `${BASE}/data/merkleRoot.json`,
    `${BASE}/merkleRoot.json`,
  ],
  bigProofs: [
    `${BASE}/data/proofs.json`,
    `${BASE}/proofs.json`,
  ],
};

const SHARD_PREFIX_LEN = 2; // 2 hex = 256 shards
const LS_KEY = (root, addr) => `wl::${root.toLowerCase()}::${addr.toLowerCase()}`;

const CACHE = {
  rootLoaded: false,
  fileRoot: null,
};

// -------- helpers --------
async function fetchJson(url, { timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-cache", signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchFirstOk(urls) {
  for (const u of urls) {
    const j = await fetchJson(u);
    if (j) return j;
  }
  return null;
}

function toBytes32Array(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    try {
      const hx = ethers.hexlify(v);
      out.push(ethers.zeroPadValue(hx, 32));
    } catch { /* ignore */ }
  }
  return out;
}

function addrShard(addr) {
  const low = String(addr || "").toLowerCase();
  // ex.: 0xabc... -> "ab"
  return low.startsWith("0x") ? low.slice(2, 2 + SHARD_PREFIX_LEN) : low.slice(0, SHARD_PREFIX_LEN);
}

async function getChainMerkleRoot(provider) {
  return await vaultService.merkleRoot(provider);
}

function isZeroRoot(root) {
  return !root || root === ethers.ZeroHash;
}

async function loadRootOnce() {
  if (CACHE.rootLoaded) return CACHE.fileRoot || null;
  const j = await fetchFirstOk(URLS.merkleRoot);
  if (j && typeof j.merkleRoot === "string") CACHE.fileRoot = j.merkleRoot;
  CACHE.rootLoaded = true;
  return CACHE.fileRoot || null;
}

// Tenta buscar a prova por vários formatos/locais sem baixar o arquivo gigante
async function tryFetchProofSmart(root, address) {
  const a = String(address).toLowerCase();
  const shard = addrShard(a);

  const candidates = [
    // Prefer per-address (versão com root namespaced)
    `${BASE}/proofs/${root}/${a}.json`,
    // Shards com root
    `${BASE}/proofs/${root}/${shard}.json`,
    `${BASE}/proofs/shards/${root}/${shard}.json`,
    // Per-address legacy (sem root)
    `${BASE}/proofs/${a}.json`,
    // Shards legacy (sem root)
    `${BASE}/proofs/${shard}.json`,
    `${BASE}/data/shards/${shard}.json`,
  ];

  for (const url of candidates) {
    const j = await fetchJson(url);
    if (!j) continue;

    // Formatos aceitos:
    // 1) Arquivo per-address: array puro ["0x...", ...] ou { proof: [...] }
    if (Array.isArray(j)) {
      const proof = toBytes32Array(j);
      if (proof.length) return proof;
    }
    if (j && Array.isArray(j.proof)) {
      const proof = toBytes32Array(j.proof);
      if (proof.length) return proof;
    }

    // 2) Arquivo shard: { "0xaddr": ["0x...", ...], ... }
    if (j && typeof j === "object" && j[a]) {
      const proof = toBytes32Array(j[a]);
      if (proof.length) return proof;
    }

    // 3) Formato antigo gigante: { proofs: { "0xaddr": [...] }, merkleRoot?: "0x..." }
    if (j && j.proofs && typeof j.proofs === "object") {
      const proof = toBytes32Array(j.proofs[a] || []);
      if (proof.length) return proof;
    }
  }

  // Fallback final: arquivo grande
  const big = await fetchFirstOk(URLS.bigProofs);
  if (big) {
    if (Array.isArray(big[a])) return toBytes32Array(big[a]);
    if (big.proofs && typeof big.proofs === "object") {
      return toBytes32Array(big.proofs[a] || []);
    }
  }

  return [];
}

// -------- API pública --------
export async function preloadProofs() {
  // Agora, apenas garante que root de arquivo (se existir) está cacheado.
  await loadRootOnce();
  return true;
}

export async function getFileMerkleRoot() {
  return await loadRootOnce();
}

export async function getChainRoot(provider) {
  return await getChainMerkleRoot(provider);
}

/** Busca a prova de forma rápida, com cache local por root+address */
export async function getProofFast(provider, address) {
  if (!provider || !address) return [];

  const chainRoot = await getChainMerkleRoot(provider);
  if (isZeroRoot(chainRoot)) return []; // whitelist OFF

  // Cache local
  try {
    const cached = localStorage.getItem(LS_KEY(chainRoot, address));
    if (cached) {
      const arr = JSON.parse(cached);
      const proof = toBytes32Array(arr);
      if (proof.length) return proof;
    }
  } catch { /* ignore */ }

  // Busca “smart”
  const proof = await tryFetchProofSmart(chainRoot, address);

  // Cachea se achou
  if (proof.length) {
    try { localStorage.setItem(LS_KEY(chainRoot, address), JSON.stringify(proof)); } catch {}
  }

  return proof;
}

export async function hasFileProof(provider, address) {
  const p = await getProofFast(provider, address);
  return p.length > 0;
}

export async function checkWhitelist(provider, address) {
  const chainRoot = await getChainMerkleRoot(provider);
  const fileRoot  = await loadRootOnce();
  const haveRoot  = !isZeroRoot(chainRoot);

  if (!haveRoot) {
    return { ok: true, proof: [], chainRoot, fileRoot, rootMismatch: false };
  }

  const proof = await getProofFast(provider, address);
  const rootMismatch =
    !!fileRoot && !!chainRoot && String(fileRoot).toLowerCase() !== String(chainRoot).toLowerCase();

  if (!proof.length) {
    return {
      ok: false,
      reason: "Address not whitelisted (proof not found for this wallet)",
      proof,
      chainRoot,
      fileRoot,
      rootMismatch,
    };
  }

  return { ok: true, proof, chainRoot, fileRoot, rootMismatch };
}

export async function ensureWhitelistedOrThrow(provider, address) {
  const r = await checkWhitelist(provider, address);
  if (!r.ok) throw new Error(r.reason || "Address not whitelisted");
  return r.proof;
}

// -------- Hook para UI (inalterado na interface) --------
import { useEffect, useState } from "react";
export function useWhitelist(address, provider) {
  const [state, setState] = useState({
    loading: true,
    ok: false,
    proof: [],
    chainRoot: null,
    fileRoot: null,
    rootMismatch: false,
    error: undefined,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setState((s) => ({ ...s, loading: true, error: undefined }));
        if (!provider || !address) {
          if (alive) setState((s) => ({ ...s, loading: false, ok: false, proof: [] }));
          return;
        }
        await preloadProofs(); // só carrega root (rápido)
        const res = await checkWhitelist(provider, address);
        if (!alive) return;
        setState({
          loading: false,
          ok: res.ok,
          proof: res.proof,
          chainRoot: res.chainRoot,
          fileRoot: res.fileRoot,
          rootMismatch: res.rootMismatch,
          error: res.ok ? undefined : res.reason,
        });
      } catch (e) {
        if (!alive) return;
        setState({
          loading: false,
          ok: false,
          proof: [],
          chainRoot: null,
          fileRoot: null,
          rootMismatch: false,
          error: e?.message || String(e),
        });
      }
    })();
    return () => { alive = false; };
  }, [address, provider]);

  return state;
}
