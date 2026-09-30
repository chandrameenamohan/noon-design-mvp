// Run by init.sh once Gitea's noon user and its token exist (SPEC §2.14: the seed is pushed at bootstrap).
// The secrets come from the environment init.sh loaded from .env; nothing here prints them.
import { bootstrapGitea } from "./gitea.ts";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (run ./init.sh)`);
  return value;
};

await bootstrapGitea({
  url: process.env["GITEA_URL"] ?? "http://localhost:3002",
  user: "noon",
  token: need("GITEA_TOKEN"),
  repo: "sample-app",
  // The api, inside the compose network. Its receiver is E5.3a's; until then a delivery fails, which
  // Gitea does not retry and the git peer's reconcile covers (SPEC §2a).
  webhook: { url: "http://api:3000/webhooks/gitea", secret: need("GITEA_WEBHOOK_SECRET") },
});
