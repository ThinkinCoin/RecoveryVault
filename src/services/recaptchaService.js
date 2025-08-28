// src/services/recaptchaService.js
// Dev bypass + production-safe token retrieval

/**
 * In dev OR when VITE_ENABLE_RECAPTCHA !== "true", bypass and return a stub token.
 * In production, call grecaptcha.execute on explicit user action (e.g., button click).
 */
export async function getRecaptchaToken(action = "redeem") {
  const enable = import.meta.env.VITE_ENABLE_RECAPTCHA === "true";
  if (import.meta.env.DEV || !enable) {
    console.log("[reCAPTCHA] dev bypass token");
    return "dev-bypass-token";
  }

  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (!siteKey) throw new Error("Missing VITE_RECAPTCHA_SITE_KEY");

  // Important: ensure grecaptcha is loaded and only execute on user interaction
  if (typeof window === "undefined" || !window.grecaptcha) {
    throw new Error("reCAPTCHA not available");
  }
  await window.grecaptcha.ready();
  return await window.grecaptcha.execute(siteKey, { action });
}
