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
# BRANCH is set by the worker, which has already checked it is a plain `noon/<uuid>`.
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
exec pnpm exec vite
EOF
CMD ["/home/node/start.sh"]
