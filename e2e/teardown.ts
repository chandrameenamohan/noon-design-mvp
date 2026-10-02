import { execFileSync } from "node:child_process";
import { SANDBOX_POOL } from "./ports.ts";

// The e2e layer shares the dev database, so it sweeps up after itself: every e2e user is named
// e2e-<time>@example.com, and removing their orgs removes the workspaces and documents with them.
// ponytail: through `docker compose exec psql`, like init.sh does. A throwaway schema per run is the
// upgrade, once the api can be pointed at one.
/** @public Playwright loads this file by PATH (playwright.config.ts globalTeardown), which the dead-code check cannot see. */
export default function teardown(): void {
  const sql = "delete from orgs where id in (select m.org_id from memberships m join users u on u.id = m.user_id where u.email like 'e2e-%@example.com'); delete from users where email like 'e2e-%@example.com'";
  const path = `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin`;
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-qc", sql], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  // The e2e sandbox worker's containers (its pool, e2e/ports.ts): their documents are gone now.
  // Its proxy too, and then their networks (noon-9gz): each holds one of the daemon's few address pools,
  // and one with the proxy still on it cannot be removed.
  const docker = (...args: string[]): void => { execFileSync("docker", args, { env: { ...process.env, PATH: path }, stdio: "ignore" }); };
  const list = (...args: string[]): string[] => execFileSync("docker", args, { env: { ...process.env, PATH: path }, encoding: "utf8" }).split("\n").filter(Boolean);
  const networks = (): string[] => list("network", "ls", "--quiet", "--filter", `label=noon.sandbox=${SANDBOX_POOL}`);
  try {
    // The e2e sandbox worker is still up here (Playwright stops its servers after this) and may be starting or reaping
    // a sandbox: a network it has just put a container on cannot be removed, so look again, a few times. It failed
    // the run once with all 44 specs green, and left the compose workers stopped.
    for (let pass = 0; pass < 5 && (pass === 0 || networks().length > 0); pass++) {
      const leftovers = [...list("ps", "--all", "--quiet", "--filter", `label=noon.sandbox=${SANDBOX_POOL}`), ...list("ps", "--all", "--quiet", "--filter", `label=noon.proxy-pool=${SANDBOX_POOL}`)];
      if (leftovers.length > 0) docker("rm", "--force", ...leftovers);
      for (const network of networks()) try { docker("network", "rm", network); } catch { /* still in use: the next pass */ }
    }
    if (networks().length > 0) throw new Error(`e2e sandbox networks could not be removed: ${networks().join(" ")}`);
  } finally {
    docker("compose", "start", "worker", "worker-sandbox", "worker-git", "worker-ship"); // setup.ts stopped them
  }
}
