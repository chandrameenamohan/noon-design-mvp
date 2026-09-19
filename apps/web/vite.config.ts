import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page calls the api as /api/... on its OWN origin and Vite forwards it. No CORS to configure,
// and the same page works against the dev stack (3000) and the e2e stack (API_TARGET).
const api = process.env["API_TARGET"] ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: api, rewrite: (path) => path.replace(/^\/api/, "") } } },
});
