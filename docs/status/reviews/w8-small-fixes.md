# w8-small-fixes: four small defects and six stale doc lines (triage 2026-10-25, P.7)

Branch `worktree-agent-af87dc350971b84e8`, forked from `ccr-af5a431d-jc9xqj` at a120806.

## Build report

1. **Startup checklist's last session** (triage row 211). The runner inserts the new session row before
   the checklist, and `latestForAgent` returned the newest row, so the brief named the session being
   started (blank summary, empty diff). `SessionRepo.latestForAgent(agentId, { ended: true })` returns the
   row that ended last (both adapters' suite); the checklist and the E.4 carry-over read it; null before
   the first session ended. Tests first: `session.test.ts` (checklist in the runner's order; two runner
   sessions), `state/test/suite.ts`. Docs: runtime.md, data-model.md (via `docs.ts`).
2. **Reserved secret names** (triage row 166). The failing test showed a real hazard, not only defense in
   depth: `proposeSharedSecret` read the vault by name, so a proposal naming
   `forerunner.install_wrap_key` wrapped this install's private key to the peer (201 on the route).
   `RESERVED_SECRET_PREFIX` in `@forerunner/vault`; `assertSecretName` refuses with the new code
   `secret_reserved`; backends store under `assertStorableSecretName`. Refused: `resolveSecretRefs`,
   `TokenIssuer.issue`, the extension registry (add, approve, re-permission), shared-secret propose and
   serve (403 on the daemon's and the service's routes), `fr vault set`. ADR 0065 amended.
3. **`mcp-github` and `fr vault set`** (adding-a-connector.md Known issue). The entry names
   `github_token` (`SECRET_NAMES.github`, tied by the catalog test). `fr vault set <name>`: the value from
   a piped stdin or a hidden prompt, never an argument; name checked first; one `vault.set` audit row;
   nothing printed or logged (`vault-cli.test.ts`, 6).
4. **Six stale Known issues lines** removed or corrected after re-reading the cited code: apps.md (email
   routes), browser.md (`StateApprovals` one-shot, body and Known issues), commands.md (requirement
   cites), testing.md (live in CI; voice routes), voice.md (voice routes).

Verification: Biome clean on every changed file; `check-paths` ok (1086); `pnpm typecheck` clean; targeted
tests green; full `packages/runtime/test packages/vault/test packages/state/test services/state-api/test`:
1659 passed, 3 failed at 23–38 s under load, each green on re-run alone (`monthly-jobs-wiring` also
passes on the fork point's files, its `settle()` caps at 30 s wall); `docs-check` ok (42); `link-check` ok.
