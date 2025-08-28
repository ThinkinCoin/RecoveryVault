// src/debug/fetchPlus.js
import { emit } from "@/debug/logger";

export async function fetchPlus(input, init = {}, { timeoutMs = 15000, tag = "fetch" } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  const started = performance.now();
  let url = typeof input === "string" ? input : (input?.url || "");

  try {
    const res = await fetch(input, { ...init, signal: ctrl.signal, cache: "no-cache" });
    const dur = performance.now() - started;
    const len = Number(res.headers.get("content-length") || 0);
    emit(res.ok ? "info" : "warn", `${tag}: ${res.status} ${res.statusText} ${url} (${dur.toFixed(0)}ms, ~${(len/1024).toFixed(1)}KB)`);
    return res;
  } catch (e) {
    const dur = performance.now() - started;
    emit("error", `${tag}: FAILED ${url} (${dur.toFixed(0)}ms)`, e?.message || e);
    throw e;
  } finally {
    clearTimeout(id);
  }
}

export async function fetchJsonPlus(urls, opts = {}) {
  for (const u of urls) {
    try {
      const res = await fetchPlus(u, {}, { timeoutMs: opts.timeoutMs ?? 15000, tag: "fetchJson" });
      if (!res.ok) continue;
      const started = performance.now();
      const json = await res.json();
      const parseMs = performance.now() - started;
      if (parseMs > 30) emit("warn", `JSON parse slow: ${u} (${parseMs.toFixed(0)}ms)`);
      return json;
    } catch { /* tenta próxima URL */ }
  }
  return null;
}
