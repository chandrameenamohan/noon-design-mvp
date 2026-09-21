# One image for every server role (api now; sync and worker later). The role is the command.
# No build step: Node 24 runs the TypeScript source directly, so the image is source + production deps.
FROM node:24-slim
RUN corepack enable
# The docker CLI, for the sandbox worker (E4.2b). Only `worker-sandbox` is given the daemon's socket;
# in every other role this binary has nothing to talk to. ponytail: one image for every role.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /repo

# Manifests first (one line per workspace package: add yours here, or the frozen install fails),
# so the dependency layer is cached until a package.json or the lockfile changes.
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
COPY packages/peer-client/package.json packages/peer-client/
COPY packages/process/package.json packages/process/
COPY packages/queue/package.json packages/queue/
COPY packages/session-token/package.json packages/session-token/
RUN pnpm install --frozen-lockfile --prod

COPY apps apps
COPY packages packages
USER node
