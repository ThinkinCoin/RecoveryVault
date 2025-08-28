// src/components/shared/LoadConsole.jsx
import React, { useEffect, useRef } from "react";

export default function LoadConsole({
  open = true,
  title = "Loading…",
  logs = [],                // [{ ts: number, msg: string, level?: 'info'|'ok'|'warn'|'error' }]
  busy = false,
  onClose,
  progress = null,          // 0..100 or null (indeterminate)
}) {
  if (!open) return null;

  const boxRef = useRef(null);
  useEffect(() => {
    // auto-scroll para o fim quando novas linhas chegam
    try {
      const el = boxRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } catch {}
  }, [logs]);

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <div>
          <strong>{title}</strong>
          {typeof progress === "number" && (
            <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>
              {Math.max(0, Math.min(100, progress)).toFixed(0)}%
            </span>
          )}
        </div>
        <div>
          {busy && <span style={styles.dot} title="working…" />}
          <button style={styles.btn} onClick={onClose} aria-label="Close log">×</button>
        </div>
      </div>

      {typeof progress === "number" && (
        <div style={styles.progressOuter}>
          <div style={{ ...styles.progressInner, width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}

      <div ref={boxRef} style={styles.box} role="log" aria-live="polite">
        {logs.length === 0 && (
          <div style={{ opacity: 0.7 }}>initializing…</div>
        )}
        {logs.map((l, i) => {
          const time = new Date(l.ts || Date.now()).toLocaleTimeString();
          const color =
            l.level === "error" ? "#ff6b6b" :
            l.level === "warn"  ? "#f1c40f" :
            l.level === "ok"    ? "#2ecc71" :
                                  "#bdc3c7";
          return (
            <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ color, marginRight: 6 }}>[{time}]</span>
              <span>{String(l.msg || "")}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  wrap: {
    position: "fixed",
    right: 12,
    bottom: 12,
    width: 420,
    maxWidth: "90vw",
    background: "rgba(20,22,26,0.95)",
    color: "white",
    borderRadius: 12,
    boxShadow: "0 8px 30px rgba(0,0,0,.35)",
    border: "1px solid rgba(255,255,255,0.08)",
    zIndex: 9999,
    backdropFilter: "blur(6px)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    fontSize: 14,
  },
  box: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, Monaco, monospace",
    fontSize: 12,
    lineHeight: "18px",
    maxHeight: 220,
    overflow: "auto",
    padding: 10,
  },
  btn: {
    appearance: "none",
    background: "transparent",
    color: "white",
    border: "none",
    fontSize: 18,
    cursor: "pointer",
    padding: 2,
  },
  progressOuter: {
    height: 3,
    background: "rgba(255,255,255,0.12)",
    margin: "0 10px",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressInner: {
    height: "100%",
    background: "linear-gradient(90deg, #6ab7ff, #5ee7df)",
    transition: "width .25s ease",
  },
  dot: {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#5ee7df",
    marginRight: 8,
    animation: "pulse 1s infinite",
  },
};
