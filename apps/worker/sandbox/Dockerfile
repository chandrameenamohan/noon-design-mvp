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
cp /home/node/preview/index.html noon-preview/index.html
sed -e "s|@PAGE@|../$PAGE|" -e "s|@DOC@|${BRANCH#noon/}|" /home/node/preview/main.tsx > noon-preview/main.tsx
[ -f "$PAGE" ] || cp /home/node/preview/placeholder.tsx "$PAGE"
grep -qx 'noon-preview/' .git/info/exclude || echo 'noon-preview/' >> .git/info/exclude
exec pnpm exec vite
EOF
CMD ["/home/node/start.sh"]
