// All texts/logs in English
import { useEffect, useState } from "react";
import { Contract, formatUnits } from "ethers";
import BAND_ABI from "@/ui/abi/BandStdReferenceProxy.json";
import { useContractContext } from "@/contexts/ContractContext";

export default function OracleDebugPanel() {
  const { provider } = useContractContext();
  const band = import.meta.env.VITE_BAND_ADDRESS;
  const [state, setState] = useState({ chainId: null, ok: false, msg: "", rate: null });

  useEffect(() => {
    (async () => {
      try {
        if (!provider) {
          setState(s => ({ ...s, msg: "No provider" }));
          return;
        }
        const net = await provider.getNetwork();
        const chainId = Number(net.chainId);

        let msg = "";
        let rate = null;
        let ok = false;

        try {
          const ref = new Contract(band, BAND_ABI, provider);
          const out = await ref.getReferenceData("ONE", "USD");
          const raw = out?.rate ?? out?.[0];
          if (raw != null) {
            rate = Number(formatUnits(raw, 18));
            ok = true;
            msg = "Band call succeeded";
          } else {
            msg = "Band returned empty rate";
          }
        } catch (e) {
          console.error("[OracleDebugPanel] Band call failed:", e);
          msg = `Band call failed: ${e?.message || e}`;
        }

        setState({ chainId, ok, msg, rate });
      } catch (e) {
        console.error("[OracleDebugPanel] Unexpected error:", e);
        setState(s => ({ ...s, msg: e?.message || String(e) }));
      }
    })();
  }, [provider, band]);

  return (
    <div style={{ border: "1px solid #ccc", padding: 12, borderRadius: 8, marginTop: 12 }}>
      <strong>Oracle Debug</strong>
      <div>ChainId: {state.chainId ?? "…"}</div>
      <div>Band address: {band}</div>
      <div>Status: {state.ok ? "OK" : "ERROR"}</div>
      <div>Message: {state.msg}</div>
      <div>ONE/USD: {state.rate ?? "—"}</div>
    </div>
  );
}
