# The sandbox: the sample app's own dev server, one container per document working branch.
# Built with the SAMPLE APP as the context (`make sandbox-image`), so nothing of the monorepo is in it.
#
# node_modules is BAKED here, at build time: first HTTP 200 in about 0.35 s, against 10-18 s when
# installed at container start (learning-tests/sandbox FINDINGS 6). It is also installed INSIDE
# Linux, which matters: Vite's bundler ships a native binary per platform, so a host's
# node_modules copied in would not run.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9.15.4 && mkdir /app && chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace

# The seed repository, as a bare repo inside the image: the "remote" each container clones from
# until Gitea exists. ponytail: epic 5 points SEED_REPO at Gitea and deletes these lines.
COPY --chown=node:node . /tmp/seed
RUN cd /tmp/seed && git init -q -b main && git add -A \
 && git -c user.name=noon -c user.email=noon@localhost commit -qm "seed" \
 && git clone -q --bare /tmp/seed /home/node/seed.git && rm -rf /tmp/seed
ENV SEED_REPO=/home/node/seed.git

# The container's OWN clone, on the document's working branch, checked out over the baked
# node_modules (git refuses to clone into a non-empty directory; init + fetch + checkout does not
# mind, and node_modules is in the seed's .gitignore). Only on the FIRST start: a restarted container
# keeps its working tree, which is the whole point of restarting rather than recreating it.
#
# One command per line, NOT an `a && b && c` chain: `set -e` ignores a failure anywhere in such a
# chain except its last command, so a clone that failed went on to start a dev server with no
# source (caught by the sandbox integration test). "Cloned" means HEAD resolves, not ".git exists":
# a clone killed halfway leaves a .git behind, and the next start must try again, not serve it.
# BRANCH (noon/<document id>) and PAGE are set by the worker, which has already checked the uuid inside them.
#
# Then the PREVIEW, on every start: an entry of our own that renders the document's page (the
# customer's own main.tsx renders their app, not our page). It lives in noon-preview/, which is
# git-excluded, so it is never part of the working branch that ship pushes. The page file itself IS
# part of it: that is the one file the document owns (keystone 8). Until the first push it holds a
# page that renders nothing, so the entry never imports a file that is not there.
COPY <<'EOF' /home/node/preview/index.html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Preview</title></head>
  <body><div id="root"></div><script type="module" src="./main.tsx"></script></body>
</html>
EOF
COPY <<'EOF' /home/node/preview/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/design-system/tokens.css";
import { Page } from "@PAGE@";

const root = document.getElementById("root");
if (!root) throw new Error("the preview is missing #root");
// The canvas names the document it expects (?doc=). A stale iframe reconnecting to a port another
// document's sandbox took meanwhile asks for the wrong one, and gets nothing of it.
if (new URLSearchParams(location.search).get("doc") === "@DOC@") createRoot(root).render(<StrictMode><Page /></StrictMode>);
else root.textContent = "This preview belongs to another document. Reload the canvas.";
EOF
# The dev server's config: OURS, wrapped around the customer's (which may say anything). The port and
# host the worker depends on, and cors. The canvas frames the preview with sandbox="allow-scripts" and
# no allow-same-origin, so the page's origin is "null" and every module request carries `Origin: null`;
# Vite's default (any localhost origin) refuses those and the page never renders (measured). Allowing
# exactly "null", and no real origin, is also STRICTER for real sites: another local dev server can no
# longer read this one's source. ponytail: any site's opaque-origin frame passes too, until the
# per-document hostname proxy (noon-9gz) puts an unguessable name in front of it.
# The customer's config is wrapped, not trusted: see the plugin below for what that takes.
COPY <<'EOF' /home/node/preview/vite.config.mjs
import { loadConfigFromFile } from "vite";

// The ONE origin that may read this dev server: the canvas's iframe, which has no origin of its own.
const ALLOWED = "null";
const IS_CORS_HEADER = /^access-control-/iu;

/**
 * Overriding `server.cors` is not enough: the customer's config can hand its source to any site through
 * `server.headers`, or through a plugin middleware that sets the header itself (both measured by the E4.3
 * verifier, which broke the first version of this file). Vite's own cors, forced above, writes the header
 * for every request; this refuses every LATER attempt to change it, from a plugin or from `server.headers`.
 * Two more defences were measured and DELETED because nothing could make them matter on Node 24: writing
 * the header ourselves first (Vite's cors, with a fixed origin, already answers every request), and
 * stripping the header from a `writeHead` headers object (a value set with `setHeader` wins over one passed
 * to `writeHead`, even when a plugin serves the file itself - measured, and a mutant survived both).
 */
const lockTheOrigin = () => ({
  name: "noon-preview-cors",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      const set = res.setHeader.bind(res);
      res.setHeader = (name, value) => (IS_CORS_HEADER.test(String(name)) ? res : set(name, value));
      res.appendHeader = res.setHeader;
      next();
    });
  },
});

export default async (env) => {
  const own = (await loadConfigFromFile(env, undefined, process.cwd()))?.config ?? {};
  return {
    ...own,
    plugins: [lockTheOrigin(), ...(own.plugins ?? [])],
    server: { ...own.server, host: true, port: 5173, strictPort: true, cors: { origin: ALLOWED } },
  };
};
EOF
COPY <<'EOF' /home/node/preview/placeholder.tsx
export function Page() {
  return null;
}
EOF
COPY --chmod=755 <<'EOF' /home/node/start.sh
#!/bin/sh
set -eu
if ! git rev-parse --quiet --verify HEAD >/dev/null 2>&1; then
  rm -rf .git
  git init --quiet --initial-branch=main
  git remote add origin "$SEED_REPO"
  git fetch --quiet origin main
  git checkout --quiet --force -B "$BRANCH" origin/main
fi
mkdir -p noon-preview
cp /home/node/preview/index.html /home/node/preview/vite.config.mjs noon-preview/
sed -e "s|@PAGE@|../$PAGE|" -e "s|@DOC@|${BRANCH#noon/}|" /home/node/preview/main.tsx > noon-preview/main.tsx
[ -f "$PAGE" ] || cp /home/node/preview/placeholder.tsx "$PAGE"
grep -qx 'noon-preview/' .git/info/exclude || echo 'noon-preview/' >> .git/info/exclude
exec pnpm exec vite --config noon-preview/vite.config.mjs
EOF
CMD ["/home/node/start.sh"]
