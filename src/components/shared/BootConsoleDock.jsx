// src/components/shared/BootConsoleDock.jsx
import React, { useEffect, useState } from "react";
import LoadConsole from "./LoadConsole";
import { onLog } from "@/debug/logger";

export default function BootConsoleDock() {
  const [logs, setLogs] = useState([]);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const off = onLog((rec) => {
      setLogs((prev) => [...prev, rec].slice(-200));
      if (rec.level !== "error") {
        clearTimeout(BootConsoleDock._idle);
        BootConsoleDock._idle = setTimeout(() => setBusy(false), 2000);
      } else {
        setBusy(false);
      }
    });
    return () => { off(); clearTimeout(BootConsoleDock._idle); };
  }, []);

  if (!open) return null;
  return (
    <LoadConsole
      open={open}
      title="App boot logs"
      logs={logs.map(l => ({ ts: l.ts, level: l.level === "log" ? "info" : l.level, msg: l.msg }))}
      busy={busy}
      progress={null}
      onClose={() => setOpen(false)}
    />
  );
}
