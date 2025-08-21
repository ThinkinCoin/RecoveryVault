import React, { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/styles/Global.module.css"; // ensure this exists and contains base classes
import { useContractContext } from "@/contexts/ContractContext";
import Footer from "@/ui/layout/footer.jsx";
import { parseUnits, formatUnits } from "ethers";
// Services (expected in your project structure)
import * as vaultService from "@/services/vaultService";
import * as tokenService from "@/services/tokenService";
import WalletConnection from "@/components/wallet/WalletConnection.jsx";
import { useAppKitAccount } from "@reown/appkit/react";

/**
 * Recovery.jsx
 *
 * Three-frame responsive layout for Recovery Vault:
 * - HEADER: logo + description (left), current round & status (center), user data (right)
 * - CONTENT: Redeem area, whitelist check (Merkle), payout selector (wONE/USDC) with balances,
 *            Tier Fee and current fee value, reCAPTCHA guard, supportedAssets selector
 * - FOOTER: '@/ui/layout/footer.jsx' anchored to the bottom
 *
 * All logs and UI strings are in English as requested.
 */

/** @typedef {{address: string, symbol: string, decimals: number, logoURI?: string}} TokenMeta */

/** Helper: shorten address for UI */
const shorten = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-");

/** Helper: copy to clipboard */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    console.log("[Header] Address copied to clipboard");
  } catch (err) {
    console.error("[Header] Clipboard error:", err);
  }
}

/** Simple placeholder reCAPTCHA (replace with real widget later) */
function ReCAPTCHAMock({ value, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>I am not a robot (placeholder)</span>
    </label>
  );
}

/** Header frame */
function HeaderFrame({ roundInfo, userInfo, onDisconnect, ConnectButton }) {
  const containerStyle = useMemo(
    () => ({ maxWidth: 1170, width: "100%", margin: "0 auto", padding: "16px" }),
    []
  );
  const gridStyle = useMemo(
    () => ({
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      alignItems: "center",
      gap: 16,
    }),
    []
  );

  return (
    <header style={{ borderBottom: "1px solid #5befc2", background: "#0b1324" }}>
      <div style={containerStyle}>
        <div style={gridStyle}>
          {/* Left: Logo + Description */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img
              src="/logo.png" // ensure public/logo.png exists
              alt="Recovery Vault"
              height={70}
              style={{ borderRadius: 8 }}
            />
            
          </div>

          {/* Center: Round & Status */}
          <div style={{ textAlign: "center", color: "#e5f4ff" }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Current Round</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {roundInfo.loading ? "…" : roundInfo.round ?? "-"}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: roundInfo.statusColor || "#5befc2",
                  display: "inline-block",
                }}
              />
              <span>{roundInfo.statusText ?? "—"}</span>
            </div>
          </div>

          {/* Right: User data */}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, alignItems: "center" }}>
            {userInfo.connected ? (
              <div style={{ textAlign: "right", color: "#e5f4ff" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
                  <code style={{ fontSize: 13 }}>{shorten(userInfo.address)}</code>
                  <button
                    aria-label="Copy address"
                    onClick={() => copyToClipboard(userInfo.address)}
                    className={styles.button}
                    style={{ padding: "4px 8px" }}
                  >
                    Copy
                  </button>
                  <button
                    onClick={onDisconnect}
                    className={styles.button}
                    style={{ padding: "4px 8px", background: "#0db7e4" }}
                  >
                    Disconnect
                  </button>
                </div>
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  <span style={{ opacity: 0.8 }}>Available limit:</span>{" "}
                  <strong>{userInfo.limitText ?? "-"}</strong>
                </div>
              </div>
            ) : (
              ConnectButton ? <ConnectButton /> : <div style={{ color: "#e5f4ff" }}>Connect your wallet</div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Content frame */
function ContentFrame({ children }) {
  const containerStyle = useMemo(
    () => ({ maxWidth: 1170, width: "100%", margin: "0 auto", padding: "16px" }),
    []
  );
  return (
    <main style={{ flex: 1 }}>
      <div style={containerStyle}>{children}</div>
    </main>
  );
}

/** Simple alert */
function Alert({ type = "info", children }) {
  const bg = type === "error" ? "#ffe5e5" : type === "success" ? "#e5ffe9" : "#e6f3ff";
  const color = type === "error" ? "#9b1c1c" : type === "success" ? "#0f5132" : "#084298";
  return (
    <div role="alert" style={{ background: bg, color, padding: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,0.06)" }}>
      {children}
    </div>
  );
}

/** Redeem form */
function RedeemForm() {
  const { provider, signer, account } = useContractContext();

  const [supportedAssets, setSupportedAssets] = useState(/** @type {TokenMeta[]} */([]));
  const [selectedAsset, setSelectedAsset] = useState(/** @type {TokenMeta|null} */(null));
  const [assetBalance, setAssetBalance] = useState("0");

  const [payout, setPayout] = useState("wONE"); // "wONE" | "USDC"
  const [balanceWONE, setBalanceWONE] = useState("0");
  const [balanceUSDC, setBalanceUSDC] = useState("0");

  const [amount, setAmount] = useState("");
  const [eligible, setEligible] = useState(null); // null | true | false
  const [tierInfo, setTierInfo] = useState({ tier: "-", feeRate: 0 });
  const [captchaOk, setCaptchaOk] = useState(false);

  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  // Load supported assets
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await vaultService.getSupportedAssets?.(provider);
        if (!alive) return;
        const mapped = (list || []).map((t) => ({
          address: t.address,
          symbol: t.symbol,
          decimals: Number(t.decimals ?? 18),
          logoURI: t.logoURI,
        }));
        setSupportedAssets(mapped);
        setSelectedAsset(mapped[0] || null);
      } catch (e) {
        console.error("[Redeem] getSupportedAssets error:", e);
        setSupportedAssets([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider]);

  // Load balances for selected asset and payout tokens
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (account && selectedAsset) {
          const bal = await tokenService.getBalance?.(account, selectedAsset.address, provider);
          if (alive) setAssetBalance(bal ?? "0");
        } else if (alive) {
          setAssetBalance("0");
        }

        if (account) {
          const [bw, bu] = await Promise.all([
            tokenService.getBalance?.(account, tokenService.tokens?.wONE, provider),
            tokenService.getBalance?.(account, tokenService.tokens?.USDC, provider),
          ]);
          if (alive) {
            setBalanceWONE(bw ?? "0");
            setBalanceUSDC(bu ?? "0");
          }
        }
      } catch (e) {
        console.error("[Redeem] balances error:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, provider, selectedAsset]);

  // Eligibility check (Merkle)
  const checkEligibility = useCallback(async () => {
    if (!account) return;
    try {
      setError("");
      const isOk = await vaultService.isAuthorized?.(account, provider);
      setEligible(Boolean(isOk));
      console.log("[Redeem] Eligibility:", isOk);
    } catch (e) {
      console.error("[Redeem] eligibility error:", e);
      setEligible(false);
      setError("Eligibility check failed. Please try again.");
    }
  }, [account, provider]);

  // Update fee tier info whenever amount changes
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!selectedAsset || !amount) {
          if (alive) setTierInfo({ tier: "-", feeRate: 0 });
          return;
        }
        const decimals = selectedAsset.decimals || 18;
        const amountWei = parseUnits(amount || "0", decimals);
        const info = await vaultService.getFeeInfo?.({ amount: amountWei, provider });
        if (alive) {
          setTierInfo({ tier: info?.tier ?? "-", feeRate: Number(info?.feeRate ?? 0) });
        }
      } catch (e) {
        console.error("[Redeem] fee info error:", e);
        if (alive) setTierInfo({ tier: "-", feeRate: 0 });
      }
    })();
    return () => {
      alive = false;
    };
  }, [amount, selectedAsset, provider]);

  const onMax = useCallback(() => {
    if (!selectedAsset) return;
    try {
      const decimals = selectedAsset.decimals || 18;
      const formatted = formatUnits(BigInt(assetBalance || 0), decimals);
      setAmount(formatted);
    } catch (e) {
      console.error("[Redeem] max parse error:", e);
    }
  }, [assetBalance, selectedAsset]);

  const submitRedeem = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      setTxHash("");

      if (!provider || !signer || !account) throw new Error("Wallet not connected");
      if (!selectedAsset) throw new Error("Select an asset to redeem");
      if (!amount) throw new Error("Enter an amount");
      if (!captchaOk) throw new Error("Please complete the CAPTCHA");

      // Optional: require eligibility first
      if (eligible !== true) throw new Error("Wallet not eligible (Merkle whitelist)");

      const decimals = selectedAsset.decimals || 18;
      const amountWei = parseUnits(amount, decimals);

      console.log("[Redeem] Submitting redeem", { asset: selectedAsset.symbol, payout, amount });

      const res = await vaultService.redeem?.({
        signer,
        assetIn: selectedAsset.address,
        amount: amountWei,
        payoutToken: payout, // "wONE" or "USDC"
      });

      if (res?.hash) {
        setTxHash(res.hash);
        console.log("[Redeem] tx:", res.hash);
      }
    } catch (e) {
      console.error("[Redeem] submit error:", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [provider, signer, account, selectedAsset, amount, payout, captchaOk, eligible]);

  const cardStyle = useMemo(
    () => ({
      background: "#0b1324",
      color: "#e5f4ff",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 16,
      padding: 16,
    }),
    []
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      {error && <Alert type="error">{error}</Alert>}
      {txHash && (
        <Alert type="success">
          Redeem submitted. Tx Hash: <code>{txHash}</code>
        </Alert>
      )}

      {/* Eligibility card */}
      <section style={cardStyle}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Eligibility</h3>
        <p style={{ marginTop: 0, opacity: 0.9 }}>
          Check if your wallet is in the pre-hacked whitelist (Merkle proof).
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button className={styles.button} onClick={checkEligibility}>Check eligibility</button>
          <span>
            Status:{" "}
            {eligible === null ? "Unknown" : eligible ? "Eligible" : "Not eligible"}
          </span>
        </div>
      </section>

      {/* Redeem card */}
      <section style={cardStyle}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Redeem</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Left column */}
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Asset to burn</span>
              <select
                value={selectedAsset?.address || ""}
                onChange={(e) => {
                  const t = supportedAssets.find((x) => x.address === e.target.value) || null;
                  setSelectedAsset(t);
                }}
              >
                {supportedAssets.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                  </option>
                ))}
              </select>
              <small style={{ opacity: 0.8 }}>
                Balance: {selectedAsset ? formatUnits(BigInt(assetBalance || 0), selectedAsset.decimals) : "0"}
              </small>
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <span>Amount</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.0"
                  style={{ flex: 1 }}
                />
                <button className={styles.button} type="button" onClick={onMax}>
                  MAX
                </button>
              </div>
            </label>

            <div style={{ display: "grid", gap: 6 }}>
              <span>Payout</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setPayout("wONE")}
                  style={{ background: payout === "wONE" ? "#0db7e4" : undefined }}
                >
                  wONE ({formatUnits(BigInt(balanceWONE || 0), 18)})
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setPayout("USDC")}
                  style={{ background: payout === "USDC" ? "#0db7e4" : undefined }}
                >
                  USDC ({formatUnits(BigInt(balanceUSDC || 0), 6)})
                </button>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 6 }}>
              <span>Tier & Fee</span>
              <div style={{ display: "flex", gap: 12 }}>
                <div>
                  <small style={{ opacity: 0.8 }}>Tier</small>
                  <div style={{ fontWeight: 700 }}>{tierInfo.tier}</div>
                </div>
                <div>
                  <small style={{ opacity: 0.8 }}>Fee Rate</small>
                  <div style={{ fontWeight: 700 }}>{tierInfo.feeRate}%</div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <span>Bot Protection</span>
              <ReCAPTCHAMock value={captchaOk} onChange={setCaptchaOk} />
            </div>

            <div>
              <button
                className={styles.button}
                disabled={loading}
                onClick={submitRedeem}
                style={{ width: "100%", padding: 12, background: "#5befc2", color: "#0b1324", fontWeight: 700 }}
              >
                {loading ? "Processing…" : "Redeem"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Recovery() {
  const { provider, signer, account, disconnect } = useContractContext();
  const appkitAccount = useAppKitAccount ? useAppKitAccount() : undefined;
  const [roundInfo, setRoundInfo] = useState({ loading: true, round: null, statusText: "Loading", statusColor: "#fbbf24" });
  const [userInfo, setUserInfo] = useState({ connected: false, address: "", limitText: "-" });

  // Load round + status
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [round, locked] = await Promise.all([
          vaultService.getCurrentRound?.(provider),
          vaultService.isLocked?.(provider),
        ]);
        if (!alive) return;
        setRoundInfo({
          loading: false,
          round: round ?? "-",
          statusText: locked ? "Locked" : "Open",
          statusColor: locked ? "#f97316" : "#5befc2",
        });
      } catch (e) {
        console.error("[Header] round/status error:", e);
        if (alive) setRoundInfo({ loading: false, round: "-", statusText: "Unknown", statusColor: "#94a3b8" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [provider]);

  // Load user info + limit
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const addr = account || (appkitAccount && appkitAccount.address);
        if (!addr) {
          if (alive) setUserInfo({ connected: false, address: "", limitText: "-" });
          return;
        }
        const limitWei = await vaultService.getLimit?.(addr, provider);
        const limitText = limitWei != null ? `${formatUnits(BigInt(limitWei), 18)} ONE` : "-"; // adjust decimals if needed
        if (alive) setUserInfo({ connected: true, address: addr, limitText });
      } catch (e) {
        console.error("[Header] limit error:", e);
        if (alive) setUserInfo({ connected: Boolean(addr), address: addr || "", limitText: "-" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [account, provider]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0b0f1a" }}>
      <HeaderFrame roundInfo={roundInfo} userInfo={userInfo} onDisconnect={disconnect} ConnectButton={WalletConnection} />
      <ContentFrame>
        <RedeemForm />
      </ContentFrame>
      <Footer />
    </div>
  );
}
