// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import store from "./store";
import { ReownProvider, ensureInit } from "./services/appkit";  
import { ContractProvider } from "./contexts/ContractContext";
import App from "./App";
import "./styles/Global.module.css";
import { BrowserRouter } from "react-router-dom";

import { emit } from "@/debug/logger";
import { installGlobalDiagnostics } from "@/debug/instrumentation";

installGlobalDiagnostics({ emit });
ensureInit();
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Provider store={store}>
      <ReownProvider>
        <ContractProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ContractProvider>
      </ReownProvider>
    </Provider>
  </React.StrictMode>
);
