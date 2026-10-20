# Capabilities

> Status: partial. Git host adapters are in; browser, email, desktop control and connectors
> land with phase 6.

## Purpose

`packages/capabilities`: what agents can reach outside the runtime. Each capability is
granted or revoked per run through the capability token (tools, domains, secrets). This file
covers the git host adapters; browser, email, desktop control and MCP connectors are added
with their milestone.

## Git hosts (`src/githost/`)

- `GitHost` (`types.ts`) is the contract: repositories, branches, file contents, pull requests
  (create, list, merge, comment, review), issues, check runs, releases with assets, rate limit.
- `GitHubHost` (`github.ts`) implements it for api.github.com, GitHub Enterprise and the fake
  git host in `testenv` (same REST shapes). The token is a bearer header taken from the vault by
  reference; it is never logged. 403 with an exhausted rate limit waits for the reset once
  (bounded by `maxRateLimitWaitSec`); 5xx retries with backoff; 401/403/404/405/409/422 map to
  `provider_auth`, `tool_not_allowed`, `not_found` and `validation` codes. A merge that GitHub
  refuses returns `{ merged: false, message }` instead of throwing so the caller can open a
  human request.
- `GitOps` (`git.ts`) runs local git with argv arrays: clone, fetch, branch, commit, rebase onto
  the base before a PR (conflicts are reported by file and the rebase aborted, leaving the tree
  clean), push with `--force-with-lease` only when asked and never on the default branch,
  changed files, log. HTTPS auth uses an `http.extraheader` config argument so the token never
  touches disk; error output is redacted.
- `PrTaskExecutor` (`pr-executor.ts`) wraps any task executor in the branch-and-PR flow: clone
  or fetch into a per-task worktree, branch from the base (or the existing PR branch), run the
  inner executor inside the worktree, commit, rebase onto the base, push and open a pull
  request whose body carries the outcome and acceptance criteria; a second run on the same
  task updates the PR. A rebase conflict becomes a blocking human request with options and the
  task outcome `needs_human`; no changes means `failed`; tasks without a repository run the
  inner executor directly.
- `MemoryGitHost` (`memory.ts`) is an in-memory implementation of the contract for unit tests
  of callers.

## How it works

## How to change it

## Tests

## Known issues
