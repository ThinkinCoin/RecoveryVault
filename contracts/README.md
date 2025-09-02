# RecoveryVault — Contract Documentation

> **Short summary:** Non–1:1 redeem vault. **Input:** any supported ERC‑20 (or native ONE → auto‑wrapped to wONE). **Output:** only **wONE** or **USDC**. The **fee** is taken in the **input token**; the remaining input is **burned**; the user is paid in the chosen output token at a **USD‑based** conversion. All limits and fee thresholds are expressed in **whole USD** (0 decimals).

---

## Overview (for non‑technical readers)

> Contract Deployed (test): `0x5833d9F946513804fbD18F82Dc95502E5A45239e`

**What you do:**

* Send a supported token to the vault and choose whether you want to receive **wONE** or **USDC** back.

**What happens behind the scenes:**

1. If you sent native ONE, the contract wraps it to **wONE**.
2. The contract checks that you are allowed (whitelist), the round is open, and that you still have daily limit left.
3. A **fee** (percentage) is taken **from your input token**.
4. The remainder of your input token is **burned** (sent to a burn sink), meaning it leaves circulation.
5. The vault pays you in **wONE** or **USDC** (you choose) based on a **USD price**.

   * Because your input paid a fee first, your payout is **proportionally smaller**.

**Why burn?**

* Burning the input token removes it from circulation (or sends it to an irrecoverable sink), making the vault act like a one‑way conversion backed by real tokens.

**Limits & Rounds:**

* You have a **daily USD limit**. When you **reach** that limit, a 24‑hour lock starts.
* Each **round** has **one fixed fee** chosen at round start. It doesn’t change until a new round starts.
* The owner can toggle a **24‑hour “round delay”** between the moment a round is created and when it starts paying out.

---

## 1) Key Properties

* **Non‑1:1 payout**: Users receive **wONE** or **USDC** regardless of the input token.
* **Fee in input token**: The fee is always charged in the incoming token.
* **Burning the input**: After fee, the net input is burned (first trying `burn(uint256)`, otherwise transferred to the universal burn sink `0x000000000000000000000000000000000000dEaD`).
* **USD integer accounting**: Daily limits and fee tiers are expressed in **whole USD** (no decimals), using floor rounding.
* **Round‑fixed fee**: One bps value is chosen at the start of the round and remains constant throughout that round.
* **Round delay toggle**: Owner can enable/disable the 24h start delay.

---

## 2) Valuation & Units

### 2.1 USD Integer (0 decimals)

All consumption and thresholds are tracked in **whole USD**. Floor rounding is applied when converting from token amounts to USD.

### 2.2 Token → USD (\`\_usdValueFor\`)

* **wONE** → via oracle: `price(USD)`, `decimals`.

  * Convert input amount to 18‑decimals, multiply by price, scale down → whole USD (floor).
* **USDC** → 1 USD per unit (uses token decimals, typically 6): `usd = amount / 10^decimals`.
* **Other supported tokens** → **fixedUsdPrice\[token]** (scale **1e18**):

  * `usd = (amount * fixedUsdPrice[token]) / 10^tokenDecimals / 1e18` (floor).

### 2.3 USD → Output Token (\`\_priceOut18\`)

* **USDC** → priceOut18 = `1e18`.
* **wONE** → `priceOut18 = oraclePrice * 1e18 / 10^oracleDecimals`.

### 2.4 Payout Amount

* First, compute net input after fee: `netIn = amountIn − feeTokenIn`.
* Convert **net** to USD: `usdValueNet`.
* Output amount:

  ```
  amountOut = usdValueNet * 1e18 * 10^dec(redeemIn) / priceOut18    // floor
  ```

Because the fee is taken first in the input token, the final `amountOut` is proportionally smaller (\~fee%) than it would be without fees.

---

## 3) Daily Limit Logic

* **State:** `redeemedInRound[round][user]` (USD integer consumed in the current round), `limitUnlockAt[user]` (timestamp until which the user is locked at the daily limit).
* **Flow:**

  1. If `now < limitUnlockAt[user]`, the user is **locked** and cannot redeem (limit is treated as 0).
  2. On redeem, compute `usdValueIn` and ensure `usdValueIn ≤ remaining`.
  3. Update `used = used + usdValueIn`. If `used == dailyLimitUsd`, set `limitUnlockAt[user] = now + 24h` (the **lock window starts when the user hits the limit**).
  4. When `now ≥ limitUnlockAt[user]`, the next interaction resets usage and clears the lock.

> **Note:** The contract does not allow redeem attempts that would exceed the remaining limit. Users either stay below the limit or hit it exactly and trigger the 24h lock.

---

## 4) Rounds & Round‑Fixed Fee

* The owner starts a round with `startNewRound(roundId)`.
* **Delay:** If `roundDelayEnabled` is true (default), the round starts after 24 hours (`ROUND_DELAY`). Otherwise it starts immediately.
* **Fee locking:** At round start, the contract computes the vault’s USD value (`wONE` via oracle + `USDC`) and selects a **single tier** via `feeThresholds` and `feeBps`. This bps is stored in `roundBps` and used for every redeem in the round.
* Changing `feeThresholds` mid‑round won’t affect the **current** round’s fixed `roundBps`; it applies to future rounds only.

**Events:**

* `NewRoundStarted(roundId, woneBalance, usdcBalance, startTime)`
* `RoundFeeLocked(roundId, bps, basisUsd)`

**Status helper:** `getRoundInfo()` returns current round data (including if delay is enabled and which bps is locked).

---

## 5) Whitelist

* Users must be included in a Merkle allowlist.
* The `onlyWhitelisted(proof)` modifier is applied to `redeem`.
* `quoteRedeem` will revert with `"Exceeds daily limit"` if the wallet is currently locked (so UI behavior matches on‑chain rules).

---

## 6) Fees

### 6.1 Tier Selection

* `feeThresholds` (USD integers) and `feeBps` (basis points) define the schedule.
* Selection is the **first** tier where `usd ≤ threshold`, otherwise the **last bps**.
* The selected bps is **locked for the entire round** in `roundBps`.

### 6.2 Charging

* Fee is charged **in the input token**.
* `feeTokenIn = amountIn * roundBps / 10_000`.
* The fee is transferred to `devWallet`.

---

## 7) Burn Mechanism

* After taking the fee, the **net input** is burned:

  1. Try calling `burn(uint256)` on the token (works for standard Burnable tokens).
  2. If the call fails, transfer to the universal burn sink `0x000000000000000000000000000000000000dEaD`.

> **Why not `address(0)`?** Most ERC‑20 implementations **revert** transfers to `address(0)`. The `0x…dEaD` sink is universally used to remove tokens from circulation.

---

## 8) Admin Interface (Owner)

* **Whitelist root**

  * `setMerkleRoot(bytes32 root)`
* **Supported tokens & fixed price**

  * `setSupportedToken(address token, bool allowed)`
  * `setFixedUsdPrice(address token, uint256 usdPrice18)` // `1e18 = $1.00`
* **Fees** (for future rounds)

  * `setFeeTiers(uint256[] thresholdsUsd, uint16[] bps)` // `bps.length == thresholds.length + 1`
* **Limits & wallets & oracle**

  * `setDailyLimit(uint256 usdInteger)`
  * `setDevWallet(address wallet)`
  * `setRmcWallet(address wallet)` // kept for withdraws of payout tokens
  * `setOracle(address oracle)`
* **Operations**

  * `setLocked(bool)` // global pause/unpause
  * `setRoundDelayEnabled(bool)` // toggle 24h delay for next `startNewRound`
  * `startNewRound(uint256 roundId)` // picks and locks `roundBps` for the round
  * `withdrawFunds(address token)` // only `wONE` or `USDC` (payout liquidity)

---

## 9) Public Views & Helpers

* `quoteRedeem(user, tokenIn, amountIn, redeemIn, proof)` → simulation

  * Returns: whitelist/round status, `feeAmountInTokenIn`, `burnAmountInTokenIn`, `userLimitUsdBefore/After`, `usdValueIn`, decimals, oracle data, and `amountOutRedeemToken`.
* `getUserLimit(address wallet)` → remaining daily USD (0 if locked until `limitUnlockAt`).
* `getVaultBalances()` → current wONE & USDC balances.
* `getRoundInfo()` → `(roundId, startTime, isActive, paused, dailyLimitUsd, delayEnabled, roundFeeBps, roundFeeBasisUsd)`.
* `getSupportedTokens()`, `getFeeTiers()`
* `getLastRedeemTimestamp(address user)`

---

## 10) Security Notes

* `ReentrancyGuard` on state‑changing functions.
* `SafeERC20` for all token operations.
* Oracle dependency is **only for wONE**. For every other token, the owner must set a fixed USD price.
* Burning uses the safest approach available per token.

---

## 11) Integration Tips (Frontend / Services)

* Always call `quoteRedeem` before `redeem` to:

  * Check whitelist/round/lock status and remaining daily limit.
  * Display the **exact** `amountOut` in the chosen output token.
  * Show the **fee in input token** and the **net burned amount**.
* For new tokens, ensure both:

  * `setSupportedToken(token, true)` and `setFixedUsdPrice(token, usdPrice18)` are configured.
* After `startNewRound`, read `getRoundInfo()` to show the **locked fee** for the round.

---

## 12) Example Flow

1. **User** wants USDC back and sends 10 XYZ tokens (XYZ is supported with fixed price = \$2.00, i.e., `2e18`).
2. **Valuation**: 10 × \$2.00 = **\$20** (USD integer = 20).
3. **Daily limit**: remaining ≥ 20 → OK.
4. **Round fee**: suppose roundBps = 100 (1%). Fee = 0.1 XYZ. Net = 9.9 XYZ.
5. **Net USD**: 9.9 × \$2.00 = **\$19.8** (USD integer = 19).
6. **Payout**: redeemIn = USDC, priceOut18 = 1e18. USDC has 6 decimals → `amountOut = 19 × 1e18 × 10^6 / 1e18 = 19e6` (19.000000 USDC).
7. **Transfers**: 0.1 XYZ → `devWallet`; 9.9 XYZ → burned; 19 USDC → user.
8. **Usage**: user adds 20 USD to their daily usage.
9. If the user **hits** the daily limit exactly, they are locked for 24h.

> Numbers above illustrate floor rounding at USD integer steps.

---

## 13) Testing Checklist

* **ONE native path** (wrap → wONE).
* **Valuation** across wONE, USDC, and fixed‑price tokens.
* **Daily limit** accumulation, hitting the limit, lock timing, and automatic reset.
* **Round fee locking**: fee stays constant during the round despite balance changes.
* **Burn path**: token with `burn()` and token without (fallback to `0x…dEaD`).
* **Liquidity checks**: insufficient and sufficient cases for both wONE and USDC payouts.
* **Whitelist** acceptance/rejection.
* **Quote vs Redeem parity**: outputs consistent with on‑chain behavior.

---

## 14) Changelog Notes (Conceptual)

* Removed 1:1 constraint; output restricted to wONE/USDC.
* Fee taken in input token; payout in chosen token via USD conversion of **net**.
* Net input is burned (try `burn()`, else sink `0x…dEaD`).
* Daily limit lock starts **when the wallet reaches the limit**; lock lasts 24h.
* Fee is **locked per round** at `startNewRound`.
* Round delay (24h) is **toggleable**.

---

## 15) Glossary

* **USD integer**: whole‑number US dollars (no cents). All accounting uses floor rounding to the nearest whole USD.
* **bps**: basis points. 100 bps = 1%.
* **Burn**: permanently remove tokens from circulation or send to an unrecoverable sink.
* **wONE**: wrapped ONE (ERC‑20 representation of native ONE).

---

*This document reflects the current contract in the repository (`RecoveryVault.sol`).*
