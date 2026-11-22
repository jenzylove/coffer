import { defineConfig, type Plugin } from "vite";

import react from "@vitejs/plugin-react";

import { fileURLToPath } from "node:url";



const repo = fileURLToPath(new URL("..", import.meta.url));

// /rest: QoreChain REST (sends no CORS headers). /api: the Coffer server, the live one unless COFFER_API says otherwise.

const proxy = {

  "/rest": { target: "https://api-testnet.qore.host", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/rest/, "") },

  "/api": { target: process.env.COFFER_API ?? "https://coffer.jdollar.site", changeOrigin: true },

  // /evm: the server's read only EVM JSON-RPC proxy (the EVM RPC sends no CORS headers either)
  "/evm": { target: process.env.COFFER_API ?? "https://coffer.jdollar.site", changeOrigin: true },

};



// Preload the two Latin font files so the first layout already has them.

const fontPreload: Plugin = {

  name: "coffer-font-preload",

  apply: "build",

  transformIndexHtml: {

    order: "post",

    handler(_html, ctx) {

      const files = Object.keys(ctx.bundle ?? {}).filter((f) => /host-grotesk-latin-wght-normal.*\.woff2$|fragment-mono-latin-400-normal.*\.woff2$/.test(f));

      return files.map((f) => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" }, injectTo: "head" as const }));

    },

  },

};



export default defineConfig({

  plugins: [react(), fontPreload],

  server: {

    port: 5173,

    fs: { allow: [repo] },

    proxy,

  },

  preview: { port: 4173, proxy },

  worker: { format: "es" },

  build: { outDir: "dist", chunkSizeWarningLimit: 2000, target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },

  esbuild: { target: "es2022" },

});

