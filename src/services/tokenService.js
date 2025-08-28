// src/services/tokenService.jsx
import { Contract, isAddress, MaxUint256 } from "ethers";
import ERC20_ABI from "@/ui/abi/ERC20.json";
import tokenList from "@/lists/harmony-tokenlist.json";

export async function ensureAllowance(signer, token, owner, spender, minAmount) {
  if (![token, owner, spender].every(isAddress)) {
    throw new Error(`Invalid address param(s): token=${token} owner=${owner} spender=${spender}`);
  }
  const want = typeof minAmount === "bigint" ? minAmount : BigInt(minAmount ?? 0);
  const erc = new Contract(token, ERC20_ABI, signer);
  let current = await erc.allowance(owner, spender);
  if (current >= want) return current;
  const tx = await erc.approve(spender, MaxUint256);
  await tx.wait();
  current = await erc.allowance(owner, spender);
  return current;
}

export function getTokens() {
  return Array.isArray(tokenList?.tokens) ? tokenList.tokens : [];
}

export function findTokenBySymbol(symbol) {
  return getTokens().find((t) => t?.symbol === symbol) || null;
}

export function isTokenInList(address) {
  if (!isAddress(address)) return false;
  const addr = address.toLowerCase();
  return getTokens().some((t) => (t?.address || "").toLowerCase() === addr);
}

