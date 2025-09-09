# RecoveryVault — Technical Documentation (Public README)

> **TL;DR for non-technical readers**
>
> * You send a **supported token** to the Vault and choose to receive **wONE or USDC**.
> * A **small fee** is taken from your input token. The rest is **burned** (or sent to a burn sink), and you receive the corresponding amount of wONE/USDC **based on USD prices**.
> * There’s a **per-wallet daily limit** in USD (with **4 decimals** of precision) and an optional **round delay** (a round is a time window configured by the owner).
> * You must be **whitelisted**. The app shows a **non-reverting quote** that explains what you’ll get and how much limit you still have.
> * Everything is protected by **reentrancy guards**, input **validations first, transfers later**, and **oracle checks** for price safety.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [Lifecycle & Flow](#lifecycle--flow)
4. [Math, Units & Rounding](#math-units--rounding)
5. [Public Interface](#public-interface)

   * [Events](#events)
   * [User Functions](#user-functions)
   * [View Functions](#view-functions)
   * [Admin Functions](#admin-functions)
6. [Pricing & Limits](#pricing--limits)
7. [Security Considerations](#security-considerations)
8. [Integration Guide (dApp / SDK)](#integration-guide-dapp--sdk)
9. [Operational Notes](#operational-notes)
10. [Glossary](#glossary)

---

## Overview

**RecoveryVault** lets users **redeem** various supported tokens into **wONE or USDC** at a **USD-based rate**:

* Input token is **charged a fee** (in tokenIn), the net amount is **burned** (or sent to a sink address), and the user receives the **output token** (wONE/USDC).
* **Prices**:

  * **ONE** is priced from an **oracle** (USD/ONE with oracle-provided decimals).
  * **USDC** is treated as \$1.
  * Other supported tokens can optionally use a **fixed USD price** set by the owner (18-decimals scale).
* **Per-wallet daily limit** enforced in **USD4** (USD with 4 decimal places).
* **Rounds**: the owner starts “rounds” and can enable a **24h delay** before a round becomes active. A round also **locks a fee tier** based on the Vault’s USD balance at round start.
* **Whitelist**: users must provide a valid **Merkle proof**.
* **User experience**: `quoteRedeem` **never reverts** for normal “not allowed yet” situations; it returns flags and zero values so UIs can explain why a user cannot redeem yet.

---

## Core Concepts

* **Supported input tokens**: ERC-20 tokens approved by the owner. Native ONE is supported via **wONE**; when users send native ONE, the contract wraps it **only after all validations pass**.
* **Output tokens**: **wONE** or **USDC** only.
* **Fee tiers (bps)**: configurable thresholds in **whole USD units** that select the fee rate. When a round starts, **one fee tier** is **locked** for the entire round.
* **USD precision**:

  * Internal pricing uses **USD18** (USD × 1e18) for precise math.
  * **Daily limit / usage** uses **USD4** (USD × 1e4) for user-facing budgets with decimal tolerance.
* **Rolling 24h window**:

  * Each wallet has an anchor `periodStart`. If **24h elapse**, usage resets.
  * If the user **hits** the daily limit exactly, the wallet is **locked** until the end of the current 24h window.

---

## Lifecycle & Flow

### 1) Round set-up (admin)

* Admin deposits wONE/USDC into the Vault.
* Admin calls `startNewRound(roundId)`. If **delay** is enabled, the round starts after `ROUND_DELAY` (24h).
* The contract reads the oracle, computes the vault’s USD value, **picks and locks a fee tier** (`roundBps`) for this round, and emits `RoundFeeLocked` and `NewRoundStarted`.

### 2) User quote (read-only)

* Frontend calls:

  * `getUserLimit(user)` → remaining **USD4**.
  * `quoteRedeem(user, tokenIn, amountIn, redeemIn, proof)` → flags + precise amounts.
* If conditions aren’t met (e.g., not whitelisted, limit exceeded, round inactive), the function **returns flags and zeros** instead of reverting, so the UI can show “why”.

### 3) Redeem (state-changing)

* **All validations first**:

  * Whitelist check.
  * Round active & vault funded.
  * Token supported / output is wONE or USDC.
  * Daily limit not time-locked.
  * USD valuation passes limit check (using USD4).
  * Fee calculation (bps from locked tier).
  * Output amount computed and **liquidity** confirmed.
* **Only then**, funds move:

  * If `tokenIn == address(0)`: assert `msg.value == amountIn`, wrap to wONE.
  * Else: pull ERC-20 via `safeTransferFrom`.
* **Post-move**:

  * Fee → `devWallet`.
  * Net → `_burnOrSink(tokenIn, netIn)` (try `burn`; fallback to sink).
  * Output token → user.
  * Update usage / locks; emit `BurnToken` and `RedeemProcessed`.

---

## Math, Units & Rounding

* **Oracle**: returns `(price, decimals)` for **USD/ONE**.
* **Scales**:

  * **USD18**: 1.00 USD = `1e18`. Used for calculations (`usdIn18`, `usdNet18`).
  * **USD4**: 1.0000 USD = `1e4`. Used for **daily limit** configuration and accounting.
  * **fixedUsdPrice\[token]**: **USD18 per 1 token** (18-decimals).
* **Rounding**:

  * USD valuations for **policy** (limit/tiers) use **floor** conversion from USD18 → USD4.
  * Token output is derived from **USD18** math and scaled to token decimals; result is floored by integer division.
* **Decimals caching**:

  * `WONE_DECIMALS` and `USDC_DECIMALS` are **immutables** loaded in the constructor to save gas.

---

## Public Interface

### Events

* `BurnToken(address tokenIn, uint256 amountIn, address outputToken, uint256 amountOut)`
  Emitted on each redeem; `outputToken` is the **redeem token** (wONE/USDC).
* `RedeemProcessed(address user, address tokenIn, uint256 amountIn, uint256 amountOut)`
  Convenience event for indexers/analytics.
* `NewRoundStarted(uint256 roundId, uint256 woneBalance, uint256 usdcBalance, uint256 startTime)`
* `RoundFeeLocked(uint256 roundId, uint16 bps, uint256 basisUsd)`
  `basisUsd` is the **whole USD** basis used to select the tier at round start.
* `VaultPaused(bool isPaused)`
* `SupportedTokenUpdated(address token, bool allowed)`
* `FeeTiersUpdated(uint256[] thresholds, uint16[] bps)`
* `RoundDelayToggled(bool enabled)`

---

### User Functions

#### `redeem(address tokenIn, uint256 amountIn, address redeemIn, bytes32[] proof)`

Redeems `amountIn` of `tokenIn` into `redeemIn` (**wONE** or **USDC**).
If `tokenIn == address(0)`, the caller must send `msg.value == amountIn` (native ONE), which is wrapped to wONE **after** validations pass.

* **Reverts** on:

  * Not whitelisted / round not active / vault empty.
  * Input token not supported / invalid output token.
  * Oracle invalid.
  * Exceeds daily limit (USD4).
  * Insufficient output liquidity.

---

### View Functions

#### `quoteRedeem(address user, address tokenIn, uint256 amountIn, address redeemIn, bytes32[] proof) → ( … )`

Returns a **non-reverting** quote + status flags:

* `whitelisted` — user is on the Merkle allowlist.
* `roundIsActive` — current round has started and vault is not locked.
* `feeAmountInTokenIn` — fee in the input token units.
* `burnAmountInTokenIn` — net input (what will be burned/sent to sink).
* `userLimitUsdBefore` / `userLimitUsdAfter` — remaining **USD4** before/after this request (0 if blocked).
* `usdValueIn` — input **USD** amount used for policy (**USD4**).
* `tokenInDecimals` / `redeemInDecimals`
* `oraclePrice` / `oracleDecimals`
* `amountOutRedeemToken` — output token units to receive.

> If the action is blocked (e.g., over limit, time-locked), the function **returns zeros** for the numeric fields so UIs can display the reason/timer, not a revert.

#### `getUserLimit(address wallet) → uint256 remainingUSD4`

Remaining per-wallet daily limit in **USD4**.

#### `getRoundInfo() → (roundId, startTime, isActive, paused, limitUsd4, delayEnabled, roundFeeBps, roundFeeBasisUsd)`

Round and configuration snapshot. `limitUsd4` is the **daily limit** in **USD4**.

#### Other views

* `getVaultBalances() → (woneBalance, usdcBalance)`
* `getSupportedTokens() → address[]`
* `getFeeTiers() → (uint256[] thresholds, uint16[] bps)`
* `getLastRedeemTimestamp(address user) → uint256`

---

### Admin Functions

* `setMerkleRoot(bytes32 root)`
* `setSupportedToken(address token, bool allowed)`
* `setLocked(bool status)` — global pause.
* `setDailyLimit(uint256 usd4)` — **USD4** (e.g., `$100.1234` → `1_001_234`).
* `setOracle(address oracle)` — must expose `latestPrice() → (int256 price, uint8 decimals)` for USD/ONE.
* `setDevWallet(address wallet)`
* `setRmcWallet(address wallet)`
* `setFeeTiers(uint256[] thresholdsUSD, uint16[] bps)` — `bps.length = thresholds.length + 1`. Thresholds are **whole USD** (no decimals).
* `setFixedUsdPrice(address token, uint256 usd18PerToken)` — 18-dec USD per 1 token.
* `setRoundDelayEnabled(bool enabled)` — toggles 24h round delay.
* `withdrawFunds(address token)` — only **wONE** or **USDC**.
* `startNewRound(uint256 roundId)` — `roundId` must strictly increase.

---

## Pricing & Limits

* **ONE**: valued via oracle `(price, decimals)` as **USD/ONE**.
* **USDC**: `1 USDC = $1`.
* **Other tokens**: if `fixedUsdPrice[token] > 0`, use that **USD18** price; otherwise the redemption is **unsupported** (reverts).
* **Fee selection**:

  * If a round is active with a locked fee, use that **roundBps**.
  * Otherwise, the fee is selected by current **USD4/whole USD** thresholds.
* **Daily limit**:

  * Configured and accounted in **USD4**.
  * Enforced on **input USD value** (`usdIn18 → usd4`).
  * Rolling 24h behavior with **lock** when the limit is exactly reached.

---

## Security Considerations

* **Validation-first** design: all checks (supported token, round state, oracle reading, limit window, fee, liquidity) run **before** any transfer or wrapping. This prevents “funds stuck in vault” on later reverts.
* **Reentrancy**: `nonReentrant` guard on state-changing `redeem`.
* **Whitelist**: Merkle proof validated on both `quoteRedeem` (for UX) and `redeem`.
* **Oracle**: `latestPrice()` must be **positive**; otherwise the call reverts.
* **Burn or sink**: `_burnOrSink` first attempts `IERC20Burnable(token).burn(amount)` in `try/catch`; if it fails, it safely transfers to a known **burn sink**.
* **Native ONE**: wrapping only happens **after** validations; `msg.value` must equal `amountIn`.
* **Owner withdrawals**: restricted to **wONE/USDC** only; no arbitrary tokens.
* **Cached decimals**: `WONE_DECIMALS` / `USDC_DECIMALS` cached as `immutable` to reduce external calls.

---

## Integration Guide (dApp / SDK)

**Quoting flow (frontend):**

1. Read **supported tokens**, **vault balances**, and **round info**.
2. Check user **whitelist** (Merkle proof).
3. Call `getUserLimit(user)` (USD4) for budget display.
4. Call `quoteRedeem(user, tokenIn, amountIn, redeemIn, proof)`.

   * If blocked: show `roundIsActive`, `whitelisted`, and any time left until unlock.
   * If allowed: display fee / net / expected output.

**Execution flow:**

1. For ERC-20 inputs: ensure **allowance** for the Vault.
2. For native ONE inputs: set `tokenIn = address(0)`, send `msg.value = amountIn`.
3. Call `redeem(tokenIn, amountIn, redeemIn, proof)`.

**Ethers example (ERC-20 input):**

```js
const v = new ethers.Contract(vaultAddr, VaultABI, signer);
const proof = [...];                 // Merkle proof bytes32[]
const tokenIn = SOME_ERC20;
const amountIn = ethers.parseUnits("123.45", inDecimals);
const redeemIn = USDC;               // or wONE

// 1) Optional: non-reverting quote
const q = await v.quoteRedeem(user, tokenIn, amountIn, redeemIn, proof);

// 2) Approve if needed
await erc20.connect(signer).approve(vaultAddr, amountIn);

// 3) Redeem
const tx = await v.redeem(tokenIn, amountIn, redeemIn, proof);
await tx.wait();
```

**Ethers example (native ONE):**

```js
const tokenIn = ethers.ZeroAddress;           // native
const amountIn = ethers.parseEther("50");
const redeemIn = wONE; // or USDC

const tx = await v.redeem(tokenIn, amountIn, redeemIn, proof, { value: amountIn });
await tx.wait();
```

---

## Glossary

* **USD18**: USD value scaled by `1e18`.
* **USD4**: USD value scaled by `1e4` (four decimals; improves UX tolerance).
* **Round**: a configured period where a single fee tier is locked and (optionally) starts after a delay.
* **wONE**: wrapped ONE (ERC-20).
* **Burn sink**: a known address where tokens are irretrievably sent if `burn()` is not available.

---

**License:** MIT

**Audits:** *Contract verified on explorer and its opensource to be audited by everyONE.*

**Contacts:** *[Mauricio F](https://t.me/mzfshark). | [ Think in Coin](https://t.me/thinkincoin) channel*
