# 0010 — Test environment: fake provider, simulated clock, in-process mail and git host

Date: 2026-10-19
Status: accepted

## Context

Almost every module talks to a model vendor, a mail host or a git host, and the spec asks for
tests that run on Windows and Linux, in CI, without credentials, deterministically and fast.
The spec names "local Gitea for integration" and leaves the mail and model stand-ins open.
Recording real model replies into fixtures makes tests cheap but hides timing; mocking at the
call site makes every test re-implement the contract.

## Decision

One workspace package, `@forerunner/testenv`, holds the stand-ins, and each one implements the
real contract rather than a mock of a call site:

1. **Fake provider.** Implements the runtime's `ModelProvider` interface exactly, with scripted,
   echoed or recorded replies, token counts from the same counter the billing code uses and
   latency simulated through the injected `Clock`, so time-to-first-token, timeouts and the
   kill switch are testable without waiting. Recorded replies are stored by a hash of the
   request and replayed byte for byte.
2. **Simulated clock.** Every time-dependent module takes a `Clock` (in `@forerunner/platform`);
   tests advance it explicitly. No test sleeps for wall time except where a real process is
   under test.
3. **Mail server in process.** Two SMTP listeners on 127.0.0.1 (inbound and authenticated
   submission), DKIM signing with `node:crypto` only, SPF from an in-memory policy, push
   delivery to listeners, and an `outbox` that catches anything addressed to the internet.
   Helpers build the forwarded, spoofed and quoted messages the email-command rules must
   ignore. No Docker, no external daemon.
4. **Fake git host instead of Gitea.** An in-process GitHub stand-in: REST in GitHub's shapes
   and error bodies, git smart HTTP for clone and push, classic and fine-grained tokens, rate
   limits, webhooks with HMAC signatures, Projects, releases with assets and installation
   tokens. The real GitHub adapter runs against it unchanged by pointing `baseUrl` at it. Gitea
   would need a binary per platform and cannot simulate GitHub's permission model, rate-limit
   exhaustion or installation tokens; the final checks still run against a real organisation
   with `fr-test-` repositories as the spec says.
5. **Same code on both platforms.** git is the only external dependency; everything else is
   Node built-ins. Nothing in the package reaches the network.

## Consequences

- Unit and integration tests run with no credentials and no services besides the optional
  Postgres (`FORERUNNER_TEST_PG`), on both CI runners.
- The real provider, real mail hosts and the real GitHub org are exercised only by the opt-in
  live harness (ADR 0040) and the final checks, which the gate table records separately.
- A stand-in that drifts from the real service is a risk; the adapters are tested against both
  where a real service is available, and every divergence found live is written into the
  stand-in (the `registry.tool_unmapped` and integer-column findings of 2026-10-20 came from
  the live runs, not from the stand-ins).
