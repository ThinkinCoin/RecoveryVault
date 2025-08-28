import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/Global.module.css";
import { ethers } from "ethers";
import { getDefaultProvider, getSupportedTokens, supportedToken, normalizeAddress } from "@/services/vaultService";
import tokenCatalog from "@/lists/harmony-tokenlist.json"; // tokenlist with logo, name, symbol, decimals, address/contract

/**
 * TokenSelect
 * -------------------------------------------------------------
 * UI-only: shows **logo + symbol** (never the address) on button and list.
 * Only ACTIVE tokens must be listed.
 *
 * Props (compatible with RedeemForm):
 * - `tokens` (optional): array of strings (addresses) OR objects { address, symbol?, logoURI? }
 * - `value`: selected address (string) OR object with `.address`
 * - `onChange(addr: string)`: called with the normalized address of the selected token
 */
export default function TokenSelect({
  tokens,
  value,
  onChange,
  placeholder = "Select token",
  label,
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState([]); // [{ address, symbol, logoURI }]
  const [loading, setLoading] = useState(false);

  const selectedAddr = useMemo(
    () => normalizeAddress(typeof value === "string" ? value : value?.address) || "",
    [value]
  );

  // Read-only provider
  const provider = useMemo(() => {
    try { return getDefaultProvider?.() || null; } catch { return null; }
  }, []);

  const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 1666600000);

  // Index tokenlist by normalized address
  const tokenlistIndex = useMemo(() => {
    try {
      const arr = Array.isArray(tokenCatalog?.tokens)
        ? tokenCatalog.tokens
        : Array.isArray(tokenCatalog)
          ? tokenCatalog
          : [];
      const map = new Map();
      for (const t of arr) {
        const rawAddr = t?.address || t?.contract || t?.contractAddress;
        const addr = normalizeAddress(rawAddr);
        if (!addr) continue;
        if (t?.chainId && Number(t.chainId) !== CHAIN_ID) continue; // chain filter
        const logoURI = t?.logoURI || t?.logo || t?.icon;
        map.set(addr, {
          address: addr,
          symbol: t?.symbol || "TOKEN",
          name: t?.name || t?.symbol || "Token",
          decimals: typeof t?.decimals === "number" ? t.decimals : undefined,
          logoURI,
        });
      }
      return map;
    } catch {
      return new Map();
    }
  }, [CHAIN_ID]);

  async function fetchSymbol(addr) {
    try {
      if (!provider) return "TOKEN";
      const erc = new ethers.Contract(addr, ["function symbol() view returns (string)"], provider);
      const s = await erc.symbol();
      return String(s || "").slice(0, 16) || "TOKEN";
    } catch { return "TOKEN"; }
  }

  // Build the final list:
  // - If props.tokens is provided: normalize & dedupe → validate active via supportedToken(provider, addr) → enrich with symbol/logo.
  // - If not provided: use getSupportedTokens(provider), which already returns active tokens.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // 1) base source (props.tokens or contract)
        let base = tokens;
        if (!base || base.length === 0) {
          const addrs = await getSupportedTokens(provider).catch(() => []);
          base = (addrs || []).map((a) => ({ address: a }));
        }

        // 2) normalize + dedupe
        const seen = new Set();
        const cand = [];
        for (const t of Array.isArray(base) ? base : []) {
          const addr = normalizeAddress(typeof t === "string" ? t : t?.address);
          if (!addr || seen.has(addr)) continue;
          seen.add(addr);
          cand.push(addr);
        }

        // 3) keep only ACTIVE tokens
        let activeAddrs = cand;
        if (tokens && tokens.length > 0) {
          const checks = await Promise.all(
            cand.map(async (addr) => {
              try { return await supportedToken(provider, addr); }
              catch { return false; }
            })
          );
          activeAddrs = cand.filter((addr, i) => checks[i] === true);
        }

        // 4) enrich with symbol/logo (tokenlist first, then symbol() on-chain fallback)
        const items = await Promise.all(
          activeAddrs.map(async (addr) => {
            const meta = tokenlistIndex.get(addr);
            let symbol = meta?.symbol;
            let logoURI = meta?.logoURI;
            if (!symbol) symbol = await fetchSymbol(addr);
            return { address: addr, symbol, logoURI };
          })
        );

        if (!alive) return;
        setList(items);
      } catch {
        if (!alive) return;
        setList([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, tokenlistIndex, JSON.stringify(tokens || [])]);

  // Close on outside click / ESC
  useEffect(() => {
    function handleOutside(e) { if (open && rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
    function handleKey(e) { if (open && e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selected = useMemo(
    () => list.find((t) => normalizeAddress(t.address) === selectedAddr) || null,
    [list, selectedAddr]
  );

  const handleSelect = (t) => {
    setOpen(false);
    onChange?.(t.address);
  };

  return (
    <div ref={rootRef} className={styles.field} style={{ position: "relative" }}>
      {label ? <label className={styles.contractFundsLabel}>{label}</label> : null}

      <button
        type="button"
        className={`${styles.button} ${styles.selectDropdown}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {selected ? (
          <>
            {selected.logoURI ? (
              <img
                src={selected.logoURI}
                alt={selected.symbol || ""}
                onError={(e) => { e.currentTarget.style.display = "none"; }}
                style={{ width: 24, height: 24, borderRadius: "50%", marginRight: 8 }}
              />
            ) : (
              <span
                aria-hidden
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 8,
                  background: "rgba(255,255,255,0.08)",
                  fontSize: 12,
                }}
              >
                {String(selected.symbol || "T").slice(0,1).toUpperCase()}
              </span>
            )}
            <span>{selected.symbol || "Token"}</span>
          </>
        ) : (
          <span>{loading ? "Loading…" : placeholder}</span>
        )}
      </button>

      {open && (
        <ul className={styles.selectorDropdown} role="listbox">
          {list.map((t) => (
            <li
              key={t.address}
              role="option"
              aria-selected={normalizeAddress(t.address) === selectedAddr}
              className={styles.rowSm}
              onClick={() => handleSelect(t)}
              style={{ cursor: "pointer", padding: "6px 4px" }}
            >
              {t.logoURI ? (
                <img
                  src={t.logoURI}
                  alt={t.symbol || ""}
                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                  style={{ width: 22, height: 22, borderRadius: "50%", marginRight: 8 }}
                />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 8,
                    background: "rgba(255,255,255,0.08)",
                    fontSize: 11,
                  }}
                >
                  {String(t.symbol || "T").slice(0,1).toUpperCase()}
                </span>
              )}
              <span>{t.symbol || "Token"}</span>
            </li>
          ))}
          {list.length === 0 && (
            <li className={styles.rowSm} style={{ opacity: 0.7, padding: "6px 4px" }}>
              No tokens
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
