# Forerunner runner image. Used both as the headless cloud runner and as the sandbox image for
# coding and test tasks (the runtime mounts only the task worktree and applies a network
# allowlist). Nothing in this image is tied to an org, account or host.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true FORERUNNER_HOME=/data
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini python3 build-essential curl \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && git config --system safe.directory '*'

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json tsconfig.node.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY testenv ./testenv
COPY evals ./evals
COPY tests ./tests
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts \
 && pnpm store prune

VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "runner"]
