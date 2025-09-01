// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import store from "./store";
import { ReownProvider, ensureInit } from "./services/appkit";
import { ContractProvider } from "./contexts/ContractContext";
import App from "./App";
import "./styles/Global.module.css";
import { HashRouter } from "react-router-dom"; // MM mobile lida melhor com hash
import ErrorBoundary from "./ErrorBoundary";

import { emit } from "@/debug/logger";
import { installGlobalDiagnostics } from "@/debug/instrumentation";
import { preloadProofs } from "@/services/whitelistService";

installGlobalDiagnostics({ emit });
ensureInit();

// dispara o preload do merkleRoot/provas sem bloquear o first paint
preloadProofs().catch(() => {});

const app = (
  <ErrorBoundary>
    <Provider store={store}>
      <ReownProvider>
        <ContractProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ContractProvider>
      </ReownProvider>
    </Provider>
  </ErrorBoundary>
);

const root = ReactDOM.createRoot(document.getElementById("root"));
if (import.meta.env.DEV) {
  root.render(<React.StrictMode>{app}</React.StrictMode>);
} else {
  root.render(app);
}
