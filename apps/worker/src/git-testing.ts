import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { generate } from "@noon/codegen";
import type { Doc } from "@noon/contracts";
import { manifest } from "@noon/design-system";

// Shared by the integration tests of the git peer and Ship: a local bare repo stands in for Gitea (git fetches and
// pushes a path as it does a URL), and a clone of it is where "an engineer" commits and pushes.
export const exec = promisify(execFile);
const who = { GIT_AUTHOR_NAME: "eng", GIT_AUTHOR_EMAIL: "eng@localhost", GIT_COMMITTER_NAME: "eng", GIT_COMMITTER_EMAIL: "eng@localhost" };
export const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd, env: { ...process.env, ...who } })).stdout.trim();

export type LocalOrigin = {
  root: string;
  origin: string;
  work: string;
  /** Writes the files, commits and pushes to `branch` (forced with `force`): what an engineer does. Resolves with the new commit. */
  commit: (files: Record<string, string>, message: string, branch: string, force?: boolean) => Promise<string>;
  remove: () => void;
};

/** A fresh origin with one commit (a README) on main, in a temp directory of its own. */
export async function localOrigin(prefix: string): Promise<LocalOrigin> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  await exec("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  await exec("git", ["clone", "--quiet", origin, work]);
  async function commit(files: Record<string, string>, message: string, branch: string, force = false): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), content);
    }
    await git(work, "add", "--all");
    await git(work, "commit", "--quiet", "--allow-empty", "-m", message);
    await git(work, "push", "--quiet", ...(force ? ["--force"] : []), "origin", `HEAD:refs/heads/${branch}`);
    return git(work, "rev-parse", "HEAD");
  }
  await commit({ "README.md": "seed\n" }, "seed", "main");
  return { root, origin, work, commit, remove: () => { rmSync(root, { recursive: true, force: true }); } };
}

/** The page file of a document, exactly as codegen (and so Ship) writes it. */
export function fileOf(page: Doc): string {
  const generated = generate(page, manifest);
  if (!generated.ok) throw new Error(generated.reason);
  return generated.tsx;
}
