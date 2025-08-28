// src/services/whitelistService.js
import { ethers } from "ethers";
import * as vaultService from "@/services/vaultService";
import { useEffect, useState } from "react";

// -------- config & cache --------
const BASE = (import.meta?.env?.VITE_PROOF_BASE_PATH || "").replace(/\/+$/, "");
const URLS = {
  proofs: [`${BASE}/data/proofs.json`, `${BASE}/proofs.json`],
  root: [`${BASE}/data/merkleRoot.json`, `${BASE}/merkleRoot.json`],
};

const CACHE = {
  loaded: false,
  addrMap: {}, // addrLower -> bytes32[]
  fileRoot: null,
};

// -------- helpers --------
async function fetchFirstOk(urls) {
  for (const u of urls) {
    try {
      const res = await fetch(u, { cache: "no-cache" });
      if (!res.ok) continue;
      return await res.json();
    } catch {
      /* next */
    }
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
    } catch {
      // ignore invalid entries
    }
  }
  return out;
}

async function loadOnce() {
  if (CACHE.loaded) return CACHE;

  const proofsJson = await fetchFirstOk(URLS.proofs);
  if (proofsJson && typeof proofsJson === "object") {
    // A: { "0xaddr": ["0x..."] }
    // B: { "merkleRoot": "0x...", "proofs": { "0xaddr": ["0x..."] } }
    let mapRaw = proofsJson;
    if (proofsJson.proofs && typeof proofsJson.proofs === "object") {
      mapRaw = proofsJson.proofs;
      if (typeof proofsJson.merkleRoot === "string") {
        CACHE.fileRoot = proofsJson.merkleRoot;
      }
    }
    for (const [addr, proofArr] of Object.entries(mapRaw)) {
      const key = String(addr).toLowerCase();
      CACHE.addrMap[key] = toBytes32Array(proofArr);
    }
  }

  if (!CACHE.fileRoot) {
    const rootJson = await fetchFirstOk(URLS.root);
    if (rootJson && typeof rootJson.merkleRoot === "string") {
      CACHE.fileRoot = rootJson.merkleRoot;
    }
  }

  CACHE.loaded = true;
  return CACHE;
}

export async function preloadProofs() {
  await loadOnce();
  return true;
}

export async function getFileMerkleRoot() {
  await loadOnce();
  return CACHE.fileRoot || null;
}

export async function getFileProof(address) {
  await loadOnce();
  if (!address) return [];
  return Array.from(CACHE.addrMap[String(address).toLowerCase()] || []);
}

export async function hasFileProof(address) {
  const p = await getFileProof(address);
  return p.length > 0;
}

export async function getChainMerkleRoot(provider) {
  return await vaultService.merkleRoot(provider);
}

export function isZeroRoot(root) {
  return !root || root === ethers.ZeroHash;
}

/**
 * Checa whitelist combinando root on-chain e arquivos locais.
 * - root on-chain zero => whitelist OFF => ok: true
 * - root on-chain != zero e não há proof local => ok: false
 * - se fileRoot != chainRoot => rootMismatch: true (útil p/ alerta na UI)
 */
export async function checkWhitelist(provider, address) {
  await loadOnce();

  const chainRoot = await getChainMerkleRoot(provider);
  const fileRoot = CACHE.fileRoot || null;
  const haveRoot = !isZeroRoot(chainRoot);

  if (!haveRoot) {
    return { ok: true, proof: [], chainRoot, fileRoot, rootMismatch: false };
  }

  const proof = await getFileProof(address);
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

/** Lança erro se não estiver whitelisted */
export async function ensureWhitelistedOrThrow(provider, address) {
  const r = await checkWhitelist(provider, address);
  if (!r.ok) throw new Error(r.reason || "Address not whitelisted");
  return r.proof;
}

// -------- Hook opcional (para UI) --------
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
        await preloadProofs();
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
    return () => {
      alive = false;
    };
  }, [address, provider]);

  return state;
}
