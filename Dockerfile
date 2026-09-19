# One image for every server role (api now; sync and worker later). The role is the command.
# No build step: Node 24 runs the TypeScript source directly, so the image is source + production deps.
FROM node:24-slim
RUN corepack enable
WORKDIR /repo

# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --prod

COPY apps apps
COPY packages packages
USER node
