// src/debug/TracedProvider.js
import { JsonRpcProvider } from "ethers";
import  { emit} from "@/debug/logger";

export class TracedProvider extends JsonRpcProvider {
  async send(method, params) {
    const started = performance.now();
    try {
      const out = await super.send(method, params);
      const dur = performance.now() - started;
      if (dur > 400) emit("warn", `RPC slow: ${method} (${dur.toFixed(0)}ms)`, params);
      else emit("info", `RPC: ${method} (${dur.toFixed(0)}ms)`);
      return out;
    } catch (e) {
      const dur = performance.now() - started;
      emit("error", `RPC FAIL: ${method} (${dur.toFixed(0)}ms)`, e?.message || e);
      throw e;
    }
  }
}
