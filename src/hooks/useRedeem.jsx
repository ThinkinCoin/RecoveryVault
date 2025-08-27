// @/hooks/useRedeem.js
// Hook fino para orquestrar o fluxo de redeem usando o redeemService
// Estados: idle → preparing → ready|blocked → approving → redeeming → success|error
//
// Extra: aceita um callback opcional `onAllowanceRefresh` em `execute(signer, { onAllowanceRefresh })`
// que será chamado assim que todas as aprovações forem confirmadas — imediatamente antes do
// estágio de `redeeming`. Use para integrar com `useTokenAllowance(...).refresh()` e atualizar a UI.

import { useCallback, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import * as redeemService from "@/services/redeemService";

/**
 * @param {ethers.AbstractProvider|null} readProvider - provider somente leitura (pode vir do contexto ou do vaultService.getDefaultProvider)
 * @returns {{
 *   state: string,
 *   error: string|null,
 *   plan: any|null,
 *   display: any|null,
 *   reasons: string[],
 *   warnings: string[],
 *   progress: string|null,
 *   receipts: { approvals: any[], redeem: any|null },
 *   prepare: (params: { user:string, tokenIn:string, amountHuman:string|number, redeemIn:string, proof?:string[] }) => Promise<any>,
 *   execute: (signer: ethers.Signer, opts?: { onAllowanceRefresh?: () => Promise<any> | any }) => Promise<any>,
 *   reset: () => void,
 *   canPrepare: boolean,
 *   canExecute: boolean,
 *   isBlocked: boolean,
 *   isReady: boolean,
 * }}
 */
export default function useRedeem(readProvider){
  const [state, setState] = useState("idle");
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const [display, setDisplay] = useState(null);
  const [reasons, setReasons] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [progress, setProgress] = useState(null);
  const [receipts, setReceipts] = useState({ approvals: [], redeem: null });

  const aliveRef = useRef(true);
  const lastPrepareParamsRef = useRef(null);

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
    setPlan(null);
    setDisplay(null);
    setReasons([]);
    setWarnings([]);
    setProgress(null);
    setReceipts({ approvals: [], redeem: null });
  }, []);

  // Cleanup em unmount
  const setSafe = useCallback((fn) => {
    if (!aliveRef.current) return;
    fn();
  }, []);

  // prepare → monta plano (approve → redeem) + preview
  const prepare = useCallback(async (params) => {
    if (!readProvider) {
      setSafe(() => { setState("error"); setError("Provider not ready"); });
      return null;
    }
    setSafe(() => { setState("preparing"); setError(null); setProgress(null); });
    lastPrepareParamsRef.current = params;
    try{
      const p = await redeemService.prepareRedeem(readProvider, params);
      setSafe(() => {
        setPlan(p);
        setDisplay(p?.display || null);
        setWarnings(p?.warnings || []);
        setReasons(p?.reasons || []);
        setState(p?.ok ? "ready" : "blocked");
      });
      return p;
    } catch (e){
      const msg = normalizeErr(e);
      setSafe(() => { setError(msg); setState("error"); });
      return null;
    }
  }, [readProvider, setSafe]);

  // execute → executa plano (approve(s) → redeem)
  const execute = useCallback(async (signer, opts = {}) => {
    if (!plan) { setSafe(() => { setError("No plan to execute"); setState("error"); }); return null; }
    if (!plan.ok) { setSafe(() => { setError("Plan is blocked"); setState("blocked"); }); return null; }
    if (!signer) { setSafe(() => { setError("Signer required"); setState("error"); }); return null; }

    const onProgress = (stage) => {
      setSafe(() => {
        setProgress(stage);
        if (stage === "approving") setState("approving");
        if (stage === "redeeming") setState("redeeming");
      });
      // Chama refresh assim que entrarmos no estágio "redeeming",
      // isto é, após aprovações confirmadas e imediatamente antes do redeem.
      if (stage === "redeeming" && typeof opts.onAllowanceRefresh === "function"){
        try { Promise.resolve(opts.onAllowanceRefresh()).catch(() => {}); } catch {}
      }
    };

    try {
      const res = await redeemService.executeRedeem(signer, plan, { onProgress });
      setSafe(() => {
        setReceipts({ approvals: res.receipts?.approvals || [], redeem: res.receipts?.redeem || null });
        setState("success");
        setProgress("done");
      });
      return res;
    } catch (e){
      const msg = normalizeErr(e);
      setSafe(() => { setError(msg); setState("error"); setProgress(null); });
      return null;
    }
  }, [plan, setSafe]);

  const canPrepare = useMemo(() => ["idle", "blocked", "ready", "error"].includes(state), [state]);
  const canExecute = useMemo(() => state === "ready" && plan?.ok, [state, plan]);
  const isBlocked = useMemo(() => state === "blocked", [state]);
  const isReady = useMemo(() => state === "ready", [state]);

  // manage lifecycle
  useMemo(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  return { state, error, plan, display, reasons, warnings, progress, receipts, prepare, execute, reset, canPrepare, canExecute, isBlocked, isReady };
}

function normalizeErr(e){
  try{
    // ethers v6 error shapes
    const short = e?.shortMessage || e?.reason || e?.message;
    if (!short) return "Unexpected error";

    // Mapeia reverts comuns para UX
    const s = String(short);
    if (/Round not started/i.test(s)) return "Round ainda não começou (ROUND_DELAY em curso).";
    if (/No funds/i.test(s)) return "Cofre sem fundos para este round.";
    if (/Contract is locked/i.test(s)) return "Contrato está bloqueado (Locked).";
    if (/User is not whitelisted/i.test(s)) return "Carteira não está na whitelist.";
    if (/insufficient allowance/i.test(s)) return "Allowance insuficiente para o token selecionado.";
    if (/insufficient funds/i.test(s)) return "Saldo insuficiente para gas/valor.";
    if (/execution reverted/i.test(s)) return "Transação revertida pelo contrato.";
    return s;
  } catch { return "Unexpected error"; }
}
