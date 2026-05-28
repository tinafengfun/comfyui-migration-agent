import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      Expires: "0",
      Pragma: "no-cache"
    },
    host: "0.0.0.0",
    proxy: {
      "/api": apiProxyTarget
    }
  },
  build: {
    outDir: "dist/client"
  }
});
