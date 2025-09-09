// src/services/whitelistService.js
import { ethers } from "ethers";
import * as core from "@/services/vaultCore";
import { fetchJsonPlus } from "@/debug/fetchPlus";
import { log, ok, warn, error } from "@/debug/logger";

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
  rootPromise: null,
};
// Single-flight caches
let rootInflight = null;                     // mantido para compat; não usado diretamente
const proofInflight = new Map();             // chave: LS_KEY(root,address) -> Promise<bytes32[]>

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
  return await fetchJsonPlus(urls, { timeoutMs: 20000 });
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
  return await core.merkleRoot(provider);
}

export function isZeroRoot(root) {
  return !root || root === ethers.ZeroHash;
}

async function loadRootOnce() {
  // fast path: já temos o valor
  if (CACHE.fileRoot) return CACHE.fileRoot;

  // se já tem promessa em voo, reusa
  if (CACHE.rootPromise) return CACHE.rootPromise;

  // dispara apenas uma vez
  CACHE.rootPromise = (async () => {
    const j = await fetchFirstOk(URLS.merkleRoot);
    const root = (j && typeof j.merkleRoot === "string") ? j.merkleRoot : null;
    CACHE.fileRoot = root;
    CACHE.rootLoaded = true;
    return root;
  })();

  try {
    return await CACHE.rootPromise;
  } finally {
    // libera a promise (mesmo se der erro) — próximos calls podem tentar de novo
    CACHE.rootPromise = null;
  }
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

// --- merkle verification helpers (OZ-compatible) ---
function normHex32(x) {
  return ethers.zeroPadValue(ethers.hexlify(x), 32);
}

function leafForAddress(addr) {
  // keccak256(abi.encodePacked(address))
  return ethers.solidityPackedKeccak256(["address"], [addr]);
}

function hashPair(aHex, bHex) {
  // aHex, bHex: 0x… (32 bytes)
  return ethers.keccak256(ethers.concat([aHex, bHex]));
}

function processProofSorted(leafHex, proof32) {
  // OpenZeppelin MerkleProof: pares ordenados (a <= b) antes de concatenar
  let computed = leafHex;
  for (const sib of proof32) {
    const a = computed.toLowerCase();
    const b = sib.toLowerCase();
    computed = (a <= b) ? hashPair(computed, sib) : hashPair(sib, computed);
  }
  return computed;
}

function processProofUnsorted(leafHex, proof32) {
  // Fallback para árvores sem sort nos pares (dependendo de como a árvore foi gerada)
  let computed = leafHex;
  for (const sib of proof32) {
    computed = hashPair(computed, sib);
  }
  return computed;
}

/** Verifica proof contra root. Tenta modo sorted (OZ) e, se falhar, unsorted */
function verifyMerkleProof(address, proofArr, rootHex) {
  if (!Array.isArray(proofArr) || !proofArr.length) return false;
  if (!rootHex) return false;

  const proof32 = proofArr.map(normHex32);
  const leafHex = leafForAddress(address);
  const root = ethers.hexlify(rootHex).toLowerCase();

  const sortedComputed   = processProofSorted(leafHex, proof32).toLowerCase();
  if (sortedComputed === root) return true;

  const unsortedComputed = processProofUnsorted(leafHex, proof32).toLowerCase();
  return unsortedComputed === root;
}

// -------- API pública --------
export async function preloadProofs() {
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

  // 1) lê o root on-chain (whitelist desativada? retorna vazio)
  const chainRoot = await getChainMerkleRoot(provider);
  if (isZeroRoot(chainRoot)) return [];

  // 2) cache em localStorage
  const lsKey = LS_KEY(chainRoot, address);
  try {
    const cached = localStorage.getItem(lsKey);
    if (cached) {
      const arr = JSON.parse(cached);
      const proof = toBytes32Array(arr);
      if (proof.length) return proof;
    }
  } catch { /* ignore */ }

  // 3) single-flight por root+address
  if (proofInflight.has(lsKey)) {
    try { return await proofInflight.get(lsKey); } catch { /* cai para baixo */ }
  }

  const promise = (async () => {
    // Busca “smart” (per-address, shard, legacy, fallback gigante)
    const proof = await tryFetchProofSmart(chainRoot, address);

    // Cacheia se achou
    if (proof.length) {
      try { localStorage.setItem(lsKey, JSON.stringify(proof)); } catch {}
    }
    return proof;
  })();

  proofInflight.set(lsKey, promise);

  try {
    return await promise;
  } finally {
    proofInflight.delete(lsKey); // libera slot
  }
}

export async function hasFileProof(provider, address) {
  const p = await getProofFast(provider, address);
  return p.length > 0;
}

export function invalidateWhitelistCaches() {
  CACHE.rootLoaded = false;
  CACHE.fileRoot = null;
  rootInflight = null;
  proofInflight.clear();
  // se quiser, limpe localStorage seletivamente por prefixo "wl::"
  // for (const k of Object.keys(localStorage)) { if (k.startsWith('wl::')) localStorage.removeItem(k); }
}

export async function checkWhitelist(provider, address) {
  const chainRoot = await getChainMerkleRoot(provider);
  const fileRoot  = await loadRootOnce();
  const haveRoot  = !isZeroRoot(chainRoot);

  // Quando a whitelist estiver desativada on-chain (root zero), não aprove por padrão.
  if (!haveRoot) {
    return {
      ok: false,
      reason: "Whitelist disabled on-chain (merkleRoot is zero)",
      proof: [],
      chainRoot,
      fileRoot,
      rootMismatch: false
    };
  }

  const proof = await getProofFast(provider, address);
  const rootMismatch =
    !!fileRoot && !!chainRoot && String(fileRoot).toLowerCase() !== String(chainRoot).toLowerCase();

  if (!proof.length) {
    return {
      ok: false,
      reason: "",
      proof,
      chainRoot,
      fileRoot,
      rootMismatch,
    };
  }

  // ✅ valida a proof contra o root on-chain
  const valid = verifyMerkleProof(address, proof, chainRoot);
  if (!valid) {
    return {
      ok: false,
      reason: "Invalid Merkle proof for this wallet (root mismatch)",
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
        ok("Whitelist: proofs loaded");
      } catch (e) {
        error(`Whitelist: ${e?.message || e}`);
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
