import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

// Shared by the integration tests that run real sandboxes.
export const DOCKER = existsSync("/Applications/Docker.app/Contents/Resources/bin/docker") ? "/Applications/Docker.app/Contents/Resources/bin/docker" : "docker";
// `docker build` pulls the base image through a credential helper that lives next to the CLI.
export const dockerEnv = { ...process.env, PATH: `${process.env["PATH"] ?? ""}:${dirname(DOCKER)}` };
export const IMAGE = "noon-sandbox:dev";
/** Each test file's own pool: a reaper, the compose stack's or another file's, never sweeps it. */
export const testPool = (): string => `test-${randomUUID().slice(0, 8)}`;
const REPO = new URL("../../../", import.meta.url).pathname;

export const docker = async (...args: string[]): Promise<string> => (await promisify(execFile)(DOCKER, args, { timeout: 60_000, env: dockerEnv })).stdout.trim();

/** Cached after the first build, which takes minutes: it installs the sample app's dependencies. */
export async function buildImage(): Promise<void> {
  await promisify(execFile)(DOCKER, ["build", "--quiet", "--tag", IMAGE, "--file", "apps/worker/sandbox/Dockerfile", "seed/sample-app"], { cwd: REPO, timeout: 900_000, env: dockerEnv });
}
