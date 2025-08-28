// src/hooks/useWhitelist.js
import { useCallback, useEffect, useRef, useState } from "react";
import {
  preloadProofs,
  checkWhitelist,
  isZeroRoot,
} from "@/services/whitelistService";

/**
 * useWhitelist(address, provider, options?)
 *
 * Faz o carregamento dos proofs (arquivos), lê o merkleRoot on-chain e
 * retorna o status de whitelist do `address` + a proof pronta para uso.
 *
 * Retorno padrão:
 * {
 *   loading,            // boolean
 *   ok,                 // boolean (true => pode prosseguir)
 *   proof,              // bytes32[] (array de hex strings)
 *   chainRoot,          // string|null (0x...)
 *   fileRoot,           // string|null (0x...)
 *   rootMismatch,       // boolean (fileRoot != chainRoot)
 *   error,              // string|undefined
 *   whitelistOn,        // boolean (true se chainRoot != 0x0...)
 *   refresh,            // function para revalidar manualmente
 * }
 *
 * Options:
 * - enabled   (default: true)   -> desliga o hook sem desmontar
 * - intervalMs(default: 0)      -> revalida em intervalo (0 = sem polling)
 */
export default function useWhitelist(address, provider, options = {}) {
  const { enabled = true, intervalMs = 0 } = options;

  const [state, setState] = useState({
    loading: !!enabled,
    ok: false,
    proof: [],
    chainRoot: null,
    fileRoot: null,
    rootMismatch: false,
    error: undefined,
  });

  const timerRef = useRef(null);
  const reqIdRef = useRef(0);

  const run = useCallback(async () => {
    if (!enabled) return;
    const myReq = ++reqIdRef.current;
    try {
      setState((s) => ({ ...s, loading: true, error: undefined }));

      if (!provider || !address) {
        setState((s) => ({
          ...s,
          loading: false,
          ok: false,
          proof: [],
          chainRoot: null,
          fileRoot: null,
          rootMismatch: false,
        }));
        return;
      }

      await preloadProofs();
      const res = await checkWhitelist(provider, address);
      if (reqIdRef.current !== myReq) return; // evita corrida/stale

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
      if (reqIdRef.current !== myReq) return;
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
  }, [enabled, provider, address]);

  useEffect(() => {
    if (!enabled) return;
    run();

    if (intervalMs > 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(run, intervalMs);
      return () => {
        clearInterval(timerRef.current);
        timerRef.current = null;
      };
    }

    return undefined;
  }, [run, enabled, intervalMs]);

  const refresh = useCallback(() => {
    run();
  }, [run]);

  const whitelistOn = !!state.chainRoot && !isZeroRoot(state.chainRoot);

  return { ...state, whitelistOn, refresh };
}
