// @/hooks/useTokenAllowance.jsx

import { useEffect, useMemo, useState, useCallback } from "react";
import { ethers, isAddress } from "ethers";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export default function useTokenAllowance(provider, tokenAddress, owner, spender) {
  const [allowance, setAllowance] = useState(0n);
  const [decimals, setDecimals] = useState(18);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const token = useMemo(() => {
    try {
      if (!provider || !tokenAddress || !isAddress(tokenAddress)) return null;
      return new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    } catch (err) {
      console.error("[useTokenAllowance] Failed to create token contract:", err);
      return null;
    }
  }, [provider, tokenAddress]);

  const canQuery = !!token && isAddress(owner || "") && isAddress(spender || "");

  const read = useCallback(async () => {
    if (!canQuery) {
      setAllowance(0n);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [a, d] = await Promise.all([
        token.allowance(owner, spender),
        token.decimals().catch(() => 18),
      ]);
      setAllowance(a);
      setDecimals(Number(d));
    } catch (err) {
      console.error("[useTokenAllowance] allowance error:", err);
      setAllowance(0n);
      setError(err?.message || "Allowance read failed");
    } finally {
      setLoading(false);
    }
  }, [canQuery, token, owner, spender]);

  useEffect(() => {
    let active = true;
    (async () => {
      await read();
    })();
    return () => { active = false; };
  }, [read]);

  return { allowance, decimals, loading, error, refresh: read };
}
