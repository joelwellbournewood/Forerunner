# Forerunner runner image. Used both as the headless cloud runner and as the sandbox image for
# coding and test tasks (the runtime mounts only the task worktree and applies a network
# allowlist). Nothing in this image is tied to an org, account or host: every setting comes
# from FORERUNNER_* environment variables at `docker run` time (docs/maintainers/cloud-runner.md).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true FORERUNNER_HOME=/data
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini python3 build-essential curl \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && git config --system safe.directory '*'

WORKDIR /app
# The build context is the repository root; the root .dockerignore keeps node_modules, build
# output and git out of the context.
COPY . .
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts \
 && pnpm store prune

# /data holds the runner's app directories (FORERUNNER_HOME): the encrypted vault blob
# (config/vault.runner.json, key never inside the image), worktrees, cache and the readiness file.
VOLUME ["/data"]
# Health route, bound to the container's own loopback interface by design (a non-loopback
# FORERUNNER_RUNNER_HEALTH_HOST is refused): a published port never reaches it from the host.
# The HEALTHCHECK below polls it from inside; an external poller uses `docker exec` or the
# container's network namespace (docs/maintainers/cloud-runner.md, "Docker").
EXPOSE 8787
ENV FORERUNNER_RUNNER_HEALTH_PORT=8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.FORERUNNER_RUNNER_HEALTH_PORT||'8787')+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# `pnpm runner` is `tsx services/cloud-runner/src/main.ts`: the entry point reads the
# environment. Exit code 75 means "vault key forgotten, start afresh": run the container with
# --restart unless-stopped so the fresh process asks the human for the key again.
CMD ["pnpm", "runner"]
