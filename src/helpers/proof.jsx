// src/helpers/proof.js
// Carrega e serve Merkle proofs (whitelist) do lado do front.
// Espera encontrar os arquivos estáticos gerados pelos scripts:
//   - public/data/proofs.json        (mapa: { "0xaddr": ["0x..","0x..", ...] })
//   - public/data/merkleRoot.json    ({ "merkleRoot": "0x..." })
// Fallbacks: /proofs.json e /merkleRoot.json na raiz pública.
// Requer: ethers v6 (para zeroPad/hexlify)

import { ethers } from "ethers";

// Opcional: prefixo custom de caminho (ex.: "/assets" ou "https://cdn.exemplo.com")
// Se não definir, usamos a raiz do app ("/").
const BASE = (import.meta?.env?.VITE_PROOF_BASE_PATH || "").replace(/\/+$/, "");

// Candidatos de URL em ordem de preferência
const URLS = {
  proofs: [ `${BASE}/data/proofs.json`, `${BASE}/proofs.json` ],
  root:   [ `${BASE}/data/merkleRoot.json`, `${BASE}/merkleRoot.json` ],
};

const CACHE = {
  loaded: false,
  addrMap: /** @type {Record<string, string[]>} */ ({}), // addrLower -> bytes32[] (sanitizadas)
  merkleRoot: /** @type {string|null} */ (null),
};

// -------- utils fetch --------
async function fetchFirstOk(urls){
  for (const u of urls){
    try {
      const res = await fetch(u, { cache: "no-cache" });
      if (!res.ok) continue;
      return await res.json();
    } catch { /* tenta o próximo */ }
  }
  return null;
}

// -------- sanitizer --------
function toBytes32Array(arr){
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr){
    try {
      const hx = ethers.hexlify(v);
      out.push(ethers.zeroPadValue(hx, 32));
    } catch {
      // ignora entradas inválidas
    }
  }
  return out;
}

// -------- loader --------
async function loadOnce(){
  if (CACHE.loaded) return CACHE;

  // 1) proofs.json
  const proofsJson = await fetchFirstOk(URLS.proofs);
  if (proofsJson && typeof proofsJson === "object"){
    // duas formas suportadas:
    // (A) { "0xaddr": ["0x...", ...], ... }
    // (B) { "merkleRoot": "0x...", "proofs": { "0xaddr": ["0x...", ...] } }
    let mapRaw = proofsJson;
    if (proofsJson.proofs && typeof proofsJson.proofs === "object"){
      mapRaw = proofsJson.proofs;
      // se vier o root junto
      if (typeof proofsJson.merkleRoot === "string") {
        CACHE.merkleRoot = proofsJson.merkleRoot;
      }
    }

    // Normaliza para addrLower -> bytes32[]
    for (const [addr, proofArr] of Object.entries(mapRaw)){
      const key = String(addr).toLowerCase();
      CACHE.addrMap[key] = toBytes32Array(proofArr);
    }
  }

  // 2) merkleRoot.json (caso ainda não tenhamos)
  if (!CACHE.merkleRoot){
    const rootJson = await fetchFirstOk(URLS.root);
    if (rootJson && typeof rootJson.merkleRoot === "string"){
      CACHE.merkleRoot = rootJson.merkleRoot;
    }
  }

  CACHE.loaded = true;
  return CACHE;
}

// -------- API pública --------

/**
 * Precarrega proofs e root em cache (opcional).
 */
export async function preloadProofs(){
  await loadOnce();
  return true;
}

/**
 * Retorna a Merkle root (hex) ou null, se não encontrada.
 */
export async function getMerkleRoot(){
  await loadOnce();
  return CACHE.merkleRoot || null;
}

/**
 * Retorna a proof (bytes32[]) para um endereço (case-insensitive).
 * Se ausente, retorna [].
 * @param {string} address
 */
export async function getProofFor(address){
  if (!address) return [];
  await loadOnce();
  const key = String(address).toLowerCase();
  return Array.from(CACHE.addrMap[key] || []);
}

/**
 * Retorna true se o endereço possui proof conhecida (no arquivo).
 * @param {string} address
 */
export async function hasProof(address){
  if (!address) return false;
  await loadOnce();
  const key = String(address).toLowerCase();
  const arr = CACHE.addrMap[key];
  return Array.isArray(arr) && arr.length > 0;
}

// export default opcional
export default {
  preloadProofs,
  getMerkleRoot,
  getProofFor,
  hasProof,
};
