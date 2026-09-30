import { execFileSync } from "node:child_process";

// The e2e layer shares the dev database, so it sweeps up after itself: every e2e user is named
// e2e-<time>@example.com, and removing their orgs removes the workspaces and documents with them.
// ponytail: through `docker compose exec psql`, like init.sh does. A throwaway schema per run is the
// upgrade, once the api can be pointed at one.
/** @public Playwright loads this file by PATH (playwright.config.ts globalTeardown), which the dead-code check cannot see. */
export default function teardown(): void {
  const sql = "delete from orgs where id in (select m.org_id from memberships m join users u on u.id = m.user_id where u.email like 'e2e-%@example.com'); delete from users where email like 'e2e-%@example.com'";
  const path = `${process.env["PATH"] ?? ""}:/Applications/Docker.app/Contents/Resources/bin`;
  execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "noon", "-d", "noon", "-qc", sql], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  // The e2e sandbox worker's containers (pool noon-e2e, playwright.config.ts): their documents are gone now.
  // Its proxy too, and then their networks (noon-9gz): each holds one of the daemon's few address pools,
  // and one with the proxy still on it cannot be removed.
  const list = (...args: string[]): string[] => execFileSync("docker", args, { env: { ...process.env, PATH: path }, encoding: "utf8" }).split("\n").filter(Boolean);
  const leftovers = [...list("ps", "--all", "--quiet", "--filter", "label=noon.sandbox=noon-e2e"), ...list("ps", "--all", "--quiet", "--filter", "label=noon.proxy-pool=noon-e2e")];
  if (leftovers.length > 0) execFileSync("docker", ["rm", "--force", ...leftovers], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  const networks = list("network", "ls", "--quiet", "--filter", "label=noon.sandbox=noon-e2e");
  if (networks.length > 0) execFileSync("docker", ["network", "rm", ...networks], { env: { ...process.env, PATH: path }, stdio: "ignore" });
  execFileSync("docker", ["compose", "start", "worker", "worker-sandbox"], { env: { ...process.env, PATH: path }, stdio: "ignore" }); // setup.ts stopped them
}
