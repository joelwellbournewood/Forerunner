# 0001 — Stack

Date: 2026-10-19
Status: accepted

## Context

The spec suggests TypeScript end to end, Tauri + React + Tailwind, the Claude Agent SDK,
Postgres (Supabase) for shared state, SQLite for solo mode, LanceDB or sqlite-vec for vectors,
Playwright, Docker, Vitest. Every build must run on Windows and Linux with an Android client,
nothing may be hardcoded to a host, and CI must stay fast on both runners.

## Decision

Confirm the suggested stack with these specifics:

| Area | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5.9, ESM, strict, `moduleResolution: bundler` | One language for runtime, services, apps and tests |
| Workspace | pnpm 10 workspaces; packages export `src/*.ts` directly, no build step | Fewer moving parts on Windows; Vite, Vitest and tsx consume TS natively |
| Runner for services | `tsx` | Runs TS directly on both OSes and in the runner image |
| Lint and format | Biome 2 | One fast binary, identical on both OSes, no plugin chain |
| Tests | Vitest 4 (unit, integration, e2e projects), Playwright for UI and the simulated users | Cross-platform, fast, one config |
| HTTP service | Hono on `@hono/node-server` | Tiny, typed, runs on Node, Fly.io, a VPS or Cloudflare Workers if needed |
| Shared state DB | Postgres via `pg` | Atomic claims, receipts, realtime via LISTEN/NOTIFY |
| Local state DB | SQLite via Node's built-in `node:sqlite` | No native build on Windows or Linux; same SQL dialect handling as Postgres through our adapter |
| Vector search | Built-in cosine index over SQLite/Postgres rows with pluggable embeddings (local hashed n-gram embedding by default) | Thousands of lessons, not millions; avoids native extensions on three platforms; a LanceDB adapter can be added behind the same interface |
| Agents | Claude Agent SDK for live runs, own loop for the fake provider (ADR 0004) | SDK gives subscription login, hooks, subagents; the loop gives deterministic tests |
| Validation | zod 4 | Command parameters, briefs, API bodies, config |
| App shell | Tauri 2, React 19, Tailwind 4, Vite | One UI for Windows, Linux and Android |
| Sandboxes | Docker or Podman through one adapter (ADR 0007) | Same image for sandbox and cloud runner |
| Browser | Playwright Chromium, isolated profile per agent | Same on both OSes |
| Keychain | `@napi-rs/keyring` (prebuilt for Windows and Linux) with encrypted-file fallback (ADR 0006) | Windows Credential Manager and libsecret through one API |
| Mail stand-in | In-process SMTP/IMAP servers in `testenv` with DKIM | No external daemon needed in CI on either OS |

Out: Supabase client libraries (the state service talks plain Postgres so any host works),
Turborepo (not needed at this size), native SQLite modules.

## Consequences

- No `dist/` anywhere; `pnpm typecheck` is the compile step.
- `node:sqlite` prints an experimental warning on Node 22; it is silenced in the adapter and
  the minimum Node is 22.13 where the module is unflagged.
- The cloud runner image is `node:22` plus the repo and `tsx`.

## Alternatives considered

- better-sqlite3: mature but needs native builds or prebuild downloads on Windows CI.
- LanceDB: strong, but a native dependency on three platforms for a small corpus.
- ESLint + Prettier: works, slower, more configuration drift between contributors.
