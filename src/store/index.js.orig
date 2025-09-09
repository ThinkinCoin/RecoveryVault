import { configureStore } from "@reduxjs/toolkit";
import recoveryReducer from "./recoverySlice";

/**
 * Root store for RecoveryVault UI
 * - serializableCheck disabled to allow BigInt in state
 * - Add more reducers here as the app grows
 */
export const store = configureStore({
  reducer: {
    recovery: recoveryReducer
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false
    }),
  devTools: true
});

export default store;
