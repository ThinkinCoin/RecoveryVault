// src/ui/layout/footer.jsx
// Recovery Dex — Footer with working ToggleTheme
// Notes:
// - All UI texts and logs are in English
// - Persists theme in localStorage (key: rdx:theme)
// - Applies theme via document.documentElement.dataset.theme = 'light' | 'dark'
// - Syncs across tabs and with system preference (if user has no manual choice)

import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/styles/Global.module.css";
import { FiSun, FiMoon } from "react-icons/fi";
import { FaInstagram, FaGithub, FaTwitter, FaYoutube} from "react-icons/fa"

const THEME_KEY = "rdx:theme";

function getInitialTheme() {
  try {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  } catch (err) {
    console.error("[Footer] getInitialTheme error:", err);
    return "light";
  }
}

function applyTheme(theme) {
  try {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.theme = theme; // Your CSS should style via :root[data-theme="dark|light"]
    root.setAttribute("color-scheme", theme); // helps native form controls
  } catch (err) {
    console.error("[Footer] applyTheme error:", err);
  }
}

export default function Footer() {
  const [theme, setTheme] = useState(getInitialTheme);

  // Stable label and icon
  const isDark = theme === "dark";
  const nextTheme = isDark ? "light" : "dark";

  // Apply + persist on change
  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
      // notify listeners that the theme has changed
      window.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
    } catch (err) {
      console.error("[Footer] persist theme error:", err);
    }
  }, [theme]);

  // Sync when user changes system preference (only if user hasn't manually chosen)
  useEffect(() => {
    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mql) return;

    const stored = () => {
      try { return window.localStorage.getItem(THEME_KEY); } catch { return null; }
    };

    const onSystemChange = (e) => {
      if (stored() == null) setTheme(e.matches ? "dark" : "light");
    };

    try { mql.addEventListener("change", onSystemChange); } catch { mql.addListener?.(onSystemChange); }
    return () => {
      try { mql.removeEventListener("change", onSystemChange); } catch { mql.removeListener?.(onSystemChange); }
    };
  }, []);

  // Sync across tabs
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === THEME_KEY && (e.newValue === "light" || e.newValue === "dark")) {
        if (e.newValue !== theme) setTheme(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <footer className={`${styles.footer}`}>
        <div className={styles.credits}>
          <div className={styles.copyright}>
            © {new Date().getFullYear()} {" "}
              <a href="https://t.me/thinkincoin" target="_blank" rel="noopener noreferrer" className={`${styles.textsm} hover:underline`}>| Built by Think in Coin |</a>
          </div>
          <div className={`${styles.socialIcons} `}>
{/*             
            <a href="https://instagram.com/thinkincoin" target="_blank" rel="noopener noreferrer"><FaInstagram /></a>
            <a href="https://youtube.com/@thinkincoin" target="_blank" rel="noopener noreferrer"><FaYoutube /></a>
            <a href="https://twitter.com/thinkincoin" target="_blank" rel="noopener noreferrer"><FaTwitter /></a>
*/}
            <a href="https://github.com/thinkincoin/recoveryvault" target="_blank" rel="noopener noreferrer"><FaGithub size={12} /></a>
        </div>
       </div>

      <div className={styles.themeToggle}>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
          className={`${styles.ButtonIconClean}`}>
          {isDark ? <FiSun size={16} /> : <FiMoon size={16} />}
        </button>
      </div>
    </footer>
  );
}

// Optional: named helpers if other parts of the app need them
export function getTheme() {
  try { return window.localStorage.getItem(THEME_KEY) || getInitialTheme(); } catch { return getInitialTheme(); }
}
export function setTheme(theme) {
  try {
    if (theme !== "light" && theme !== "dark") return;
    window.localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    window.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  } catch (err) {
    console.error("[Footer] setTheme error:", err);
  }
}
