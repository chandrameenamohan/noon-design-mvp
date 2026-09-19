import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // host: true = listen on 0.0.0.0. Inside a container the default (localhost) is unreachable from outside.
  server: { host: true, port: 5173, strictPort: true },
  test: { include: ["src/**/*.test.tsx"] },
});
