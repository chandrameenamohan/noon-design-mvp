// Where the e2e layer's servers listen, and the sandbox pool its sandbox worker owns. Each can move from the
// environment, and scripts/clean-clone.sh moves them all: a `make scenario` in the clone, beside the dev checkout's
// `make e2e`, then neither collides with its servers nor has its teardown sweep the other's sandboxes (noon-cs6.1.1).
const port = (name: string, fallback: number): number => Number(process.env[name] ?? String(fallback));

// api: off 3100 in the clone too, which other projects' dev servers like to hold (noon-njq).
// sandboxProxy: never the dev stack's (20000); the canvas's dev server forwards /preview/ there.
export const PORTS = {
  web: port("E2E_WEB_PORT", 5174),
  api: port("E2E_API_PORT", 3100),
  sync: port("E2E_SYNC_PORT", 3101),
  worker: port("E2E_WORKER_PORT", 3102),
  sync2: port("E2E_SYNC_2_PORT", 3104),
  sandboxProxy: port("E2E_SANDBOX_PROXY_PORT", 20100),
};
/** The sandbox worker's pool: its containers, proxy and networks carry it as a label (teardown.ts removes them by it). */
export const SANDBOX_POOL = process.env["E2E_SANDBOX_POOL"] ?? "noon-e2e";
