import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [repo] },
    proxy: {
      "/rest": {
        target: "https://api-testnet.qore.host",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rest/, ""),
      },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000, target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  esbuild: { target: "es2022" },
});
