import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page calls the api as /api/... on its OWN origin and Vite forwards it. No CORS to configure,
// and the same page works against the dev stack (3000) and the e2e stack (API_TARGET).
const api = process.env["API_TARGET"] ?? "http://localhost:3000";
// Hosting through a Cloudflare Tunnel (PUBLIC_HOST=noon.example.com): the tunnel reaches only this
// server, so the sync WebSocket rides it too, as /sync, and Vite must accept the public Host header.
// ponytail: Vite's dev server as the public front; a static build behind a real proxy when traffic matters.
const publicHost = process.env["PUBLIC_HOST"];

export default defineConfig({
  plugins: [react()],
  server: {
    ...(publicHost === undefined ? {} : { allowedHosts: [publicHost] }),
    proxy: {
      "/api": { target: api, rewrite: (path) => path.replace(/^\/api/, "") },
      "/sync": { target: "ws://localhost:3001", ws: true, rewrite: (path) => path.replace(/^\/sync/, "") },
    },
  },
});
