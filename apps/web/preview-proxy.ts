import type { ProxyOptions } from "vite";

/**
 * The running page through the canvas's OWN origin, for when the app is reached through one public URL
 * (a tunnel: noon-l96). The canvas frames https://<public host>/preview/<document>/<token>/noon-preview/,
 * and this forwards every /preview/ request, path unchanged, to the stack's sandbox proxy on this
 * machine's loopback (apps/worker/src/sandbox-proxy.ts). That proxy is the check: without the document's
 * token (minted per container, noon-9gz) it is a bare 404, so this rule needs none of its own.
 * HTTP and the preview's own HMR WebSocket alike. One fixed target: no door to any other port here.
 */
export const previewProxy = (sandboxProxy: string): Record<string, ProxyOptions> => ({
  "^/preview/": { target: sandboxProxy, ws: true },
});
