import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Toggled via env vars so the learning test can flip these without rebuilding
// the docker image (just restart the container with different -e flags).
const useHost = process.env.VITE_TEST_HOST !== "0"; // default: server.host = true
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT
  ? Number(process.env.VITE_HMR_CLIENT_PORT)
  : undefined;
const usePolling = process.env.VITE_USE_POLLING === "1";

export default defineConfig({
  plugins: [react()],
  server: {
    host: useHost ? true : "localhost",
    port: 5173,
    strictPort: true,
    watch: usePolling ? { usePolling: true, interval: 100 } : undefined,
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : true,
  },
});
