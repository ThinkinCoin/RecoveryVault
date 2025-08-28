// src/debug/logger.js
const listeners = new Set();

export function onLog(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emit(level, msg) {
  const rec = { ts: Date.now(), level, msg: String(msg ?? "") };
  for (const fn of listeners) {
    try { fn(rec); } catch {}
  }
}

export const log  = (m) => emit("info", m);
export const ok   = (m) => emit("ok", m);
export const warn = (m) => emit("warn", m);
export const error= (m) => emit("error", m);
