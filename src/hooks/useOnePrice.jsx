// src/hooks/useOnePrice.jsx
// Single-source oracle: **Band StdReferenceProxy** only
// All UI/console texts in English. Ethers v6.

import { useCallback, useEffect, useState } from "react";
import { Contract, isAddress, formatUnits } from "ethers";
import BAND_ABI from "@/ui/abi/BandStdReferenceProxy.json"; // must expose getReferenceData(string,string)
import { useContractContext } from "@/contexts/ContractContext";

/**
 * useOnePrice
 * Reads ONE/USD using Band StdReferenceProxy contract.
 * - Env: VITE_BAND_ADDRESS (proxy address)
 * - Band returns 18-decimal rate (1e18)
 * - No fallback to other oracles (as requested)
 */
export function useOnePrice() {
  const { provider } = useContractContext() ?? {};
  const band = import.meta.env.VITE_BAND_ADDRESS;

  const [price, setPrice] = useState(/** @type {number|null} */(null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {Error|null} */(null));
  const [lastUpdated, setLastUpdated] = useState(/** @type {{ base: number, quote: number }|null} */(null));

  const load = useCallback(async () => {
    if (!provider || typeof provider.getCode !== "function") {
      console.warn("[useOnePrice] Provider not ready or invalid");
      return null;
    }
    if (!isAddress(band)) throw new Error("VITE_BAND_ADDRESS is invalid or missing");

    const ref = new Contract(band, BAND_ABI, provider);

    // Band: function getReferenceData(string base, string quote)
    // returns (int256 rate, uint256 lastUpdatedBase, uint256 lastUpdatedQuote)
    const out = await ref.getReferenceData("ONE", "USD");

    // tuple or object support
    const rate = out?.rate ?? out?.[0];
    const baseTs = out?.lastUpdatedBase ?? out?.[1] ?? 0n;
    const quoteTs = out?.lastUpdatedQuote ?? out?.[2] ?? 0n;

    if (rate == null) throw new Error("Band oracle returned empty rate");

    // Band uses 18 decimals
    const p = Number(formatUnits(rate, 18));

    // Update state
    setPrice(Number.isFinite(p) ? p : null);
    setLastUpdated({
      base: typeof baseTs === "bigint" ? Number(baseTs) : Number(baseTs || 0),
      quote: typeof quoteTs === "bigint" ? Number(quoteTs) : Number(quoteTs || 0)
    });

    return p;
  }, [provider, band]);

  useEffect(() => {
    if (!provider || typeof provider.getCode !== "function") return; // wait for a valid provider

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const p = await load();
        if (!cancelled) {
          if (p == null) {
            setPrice(null);
            setLastUpdated(null);
            setError(new Error("No oracle available or all calls failed."));
          }
          // when p is valid, state was already set inside load()
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[useOnePrice] load error:", e);
          setError(e instanceof Error ? e : new Error(String(e)));
          setPrice(null);
          setLastUpdated(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, provider]);

  return { price, loading, error, lastUpdated, reload: load };
}

export default useOnePrice;
