import { createSlice } from "@reduxjs/toolkit";

/**
 * Recovery slice
 * - Holds UI state for redemption flow
 * - BigInt is used for on-chain amounts (disable serializableCheck in store)
 * - Logs/messages must stay in English (project standard)
 */

const initialState = {
  amount: "",
  preferUSDC: true,
  limit: 0n,
  used: 0n,
  feeBps: 100,
  quote: { outAmount: 0n, isUSDC: true },
  loading: false,
  alert: null
};

const recoverySlice = createSlice({
  name: "recovery",
  initialState,
  reducers: {
    setAmount: (state, action) => { state.amount = action.payload ?? ""; },
    setPreferUSDC: (state, action) => { state.preferUSDC = Boolean(action.payload); },
    setLimitUsed: (state, action) => {
      const { limit, used } = action.payload || {};
      state.limit = typeof limit === "bigint" ? limit : 0n;
      state.used = typeof used === "bigint" ? used : 0n;
    },
    setFeeBps: (state, action) => { state.feeBps = Number(action.payload ?? 100); },
    setQuote: (state, action) => {
      const q = action.payload || {};
      state.quote = {
        outAmount: typeof q.outAmount === "bigint" ? q.outAmount : 0n,
        isUSDC: Boolean(q.isUSDC)
      };
    },
    setLoading: (state, action) => { state.loading = Boolean(action.payload); },
    setAlert: (state, action) => { state.alert = action.payload || null; },
    reset: () => initialState
  }
});

export const {
  setAmount,
  setPreferUSDC,
  setLimitUsed,
  setFeeBps,
  setQuote,
  setLoading,
  setAlert,
  reset
} = recoverySlice.actions;

export default recoverySlice.reducer;

// Selectors
export const selectRecovery = (state) => state.recovery;
export const selectAmount = (state) => state.recovery.amount;
export const selectPreferUSDC = (state) => state.recovery.preferUSDC;
export const selectLimit = (state) => state.recovery.limit;
export const selectUsed = (state) => state.recovery.used;
export const selectFeeBps = (state) => state.recovery.feeBps;
export const selectQuote = (state) => state.recovery.quote;
export const selectLoading = (state) => state.recovery.loading;
export const selectAlert = (state) => state.recovery.alert;
