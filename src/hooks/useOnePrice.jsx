import { useCallback, useEffect, useState } from "react";
import { Contract, isAddress, formatUnits } from "ethers";
import ORACLE_ABI from "@/ui/abi/Oracle.json"; // usado para Band e Oracle por enquanto
import { useContractContext } from "@/contexts/ContractContext";

export function useOnePrice() {
  const { provider } = useContractContext();
  const band = import.meta.env.VITE_BAND_ADDRESS;
  const oracle = import.meta.env.VITE_ORACLE_ADDRESS;
  const oracleDecimals = Number(import.meta.env.VITE_ORACLE_DECIMALS ?? 8);

  const [price, setPrice] = useState(null);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!provider) return null;

    // 1) Band StdReference
    if (isAddress(band)) {
      try {
        const code = await provider.getCode(band);
        if (code !== "0x") {
          const ref = new Contract(band, ORACLE_ABI, provider);
          if (typeof ref.getReferenceData === "function") {
            try {
              const out = await ref.getReferenceData("ONE", "USD");
              const rate = Array.isArray(out) ? out[0] : out?.rate;
              if (rate != null) {
                const p = Number(formatUnits(rate, 18)); // Band normalmente 1e18
                return { price: p, source: "band" };
              }
            } catch (e) {
              console.error("[useOnePrice] Band getReferenceData error:", e);
            }
          }
        }
      } catch (e) {
        console.error("[useOnePrice] Band path failed:", e);
      }
    }

    // 2) Custom Oracle
    if (isAddress(oracle)) {
      try {
        const code = await provider.getCode(oracle);
        if (code !== "0x") {
          const c = new Contract(oracle, ORACLE_ABI, provider);

          // 🚫 NÃO use c[fn]. Use detecção explícita:
          let raw = null;
          if (typeof c.getPrice === "function") raw = await c.getPrice();
          else if (typeof c.latestOnePrice === "function") raw = await c.latestOnePrice();
          else if (typeof c.latestAnswer === "function") raw = await c.latestAnswer();
          else if (typeof c.price === "function") raw = await c.price();
          else {
            console.warn("[useOnePrice] Oracle ABI has no compatible price function. Check your ABI.");
          }

          if (raw != null) {
            const val = typeof raw === "bigint" ? raw : BigInt(raw.toString());
            const p = Number(formatUnits(val, oracleDecimals));
            return { price: p, source: "oracle" };
          }
        } else {
          console.warn("[useOnePrice] Oracle address has no code:", oracle);
        }
      } catch (e) {
        console.error("[useOnePrice] oracle path error:", e);
      }
    }

    // 3) Nothing worked
    return null;
  }, [provider, band, oracle, oracleDecimals]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await load();

        if (!cancelled) {
          if (result) {
            setPrice(result.price);
            setSource(result.source);
          } else {
            // Log de diagnóstico adicional
            console.warn("[useOnePrice] No oracle available. Env & code probe:", {
              band,
              oracle,
            });
            setPrice(null);
            setSource(null);
            setError(new Error("No oracle available or all calls failed."));
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e);
          setPrice(null);
          setSource(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  return { price, source, loading, error, reload: load };
}

export default useOnePrice;
