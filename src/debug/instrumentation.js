// src/debug/instrumentation.js
export function installGlobalDiagnostics({ emit }) {
  // 1) Erros globais e promises rejeitadas
  window.addEventListener("error", (e) => {
    emit("error", `window.error: ${e?.message || e}`, { stack: e?.error?.stack });
  });
  window.addEventListener("unhandledrejection", (e) => {
    emit("error", `unhandledrejection: ${e?.reason?.message || e?.reason || e}`);
  });

  // 2) Long Tasks (>50ms) – travamentos na UI
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        emit("warn", `Long Task: ${(entry.duration).toFixed(0)}ms`, entry);
      }
    });
    obs.observe({ type: "longtask", buffered: true });
  } catch {}

  // 3) Navegador/console pode ocultar console.debug; use console.log também
  const origDebug = console.debug;
  console.debug = (...a) => { emit("info", a.map(String).join(" ")); try { origDebug?.(...a); } catch {} };
}
