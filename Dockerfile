# One image for every server role (api now; sync and worker later). The role is the command.
# No build step: Node 24 runs the TypeScript source directly, so the image is source + production deps.
FROM node:24-slim
RUN corepack enable
# The docker CLI, for the sandbox worker (E4.2b). Only `worker-sandbox` is given the daemon's socket;
# in every other role this binary has nothing to talk to. ponytail: one image for every role.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
# git, for the same worker: it fetches each sandbox's seed from Gitea and hands it over (E5.1; a sandbox has no route out).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# Manifests first (one line per workspace package this image runs: add yours here, or its dependencies are
# not installed and nothing can link to it), so the dependency layer is cached until a package.json or the
# lockfile changes. deploy/antithesis/driver is a workspace package too and is NOT here on purpose: nothing in
# this image depends on it, the frozen install passes without its manifest, and its dependencies (the Antithesis
# SDK) stay out of the app image. deploy/antithesis/Dockerfile.driver copies it and installs again.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/sync/package.json apps/sync/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/codegen/package.json packages/codegen/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/design-system/package.json packages/design-system/
COPY packages/doc-model/package.json packages/doc-model/
COPY packages/lease/package.json packages/lease/
COPY packages/peer-client/package.json packages/peer-client/
COPY packages/process/package.json packages/process/
COPY packages/queue/package.json packages/queue/
COPY packages/session-token/package.json packages/session-token/
RUN pnpm install --frozen-lockfile --prod

COPY apps apps
COPY packages packages
# The git peer's volume mounts here (E5.3a): a fresh named volume takes this directory's owner, so node can write it.
RUN mkdir -p /var/lib/noon-git && chown node:node /var/lib/noon-git
USER node
