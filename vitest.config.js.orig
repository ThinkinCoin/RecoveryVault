// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

// __dirname em ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    host: true,   // permite acesso via LAN
    port: 3000,   // ajuste se necessário
    strictPort: false,
    open: true
  },
  preview: {
    host: true,
    port: 3001
  },
  // Config do Vitest (usa o mesmo arquivo do Vite)
  test: {
    globals: true,
    include: ["**/*.test.{js,jsx,ts,tsx}"],
    exclude: [
      "test/integration/**",
      "test/integraation/**",
      "hardhat.config.*",
      "scripts/**",
      "node_modules/**",
      "dist/**"
    ],
    // padrão para React
    environment: "jsdom",
    // usa 'node' para testes de serviços/backend-like
    environmentMatchGlobs: [
      ["src/services/**", "node"]
    ],
    passWithNoTests: false
  }
});
