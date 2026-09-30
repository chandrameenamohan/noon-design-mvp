import { defaultAllowedOrigins, type CorsOptions, type ProxyOptions } from "vite";

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

/**
 * Vite answers every preflight itself, BEFORE its proxy, by its own origin rule (localhost only). A module
 * request of the preview (origin "null") that is preflighted, because a tunnel adds a header of its own,
 * got a 204 with no Access-Control-Allow-Origin, and a blank frame. Whether "null" may read the preview is
 * the sandbox's decision (its CORS lock): so the preflight goes on, to the proxy. Vite's origin rule is kept,
 * so the canvas's own files stay closed to other sites.
 */
export const previewCors: CorsOptions = { origin: defaultAllowedOrigins, preflightContinue: true };
