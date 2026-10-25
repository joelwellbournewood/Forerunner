# w4-install-identity: install identity on a shared store (triage P0 #2, ADR 0082)

Item `w4-install-identity`, built on `wave/w4-install-identity` (one commit, 8afffb5) and merged
without a review in 90adce1 on 2026-10-23. Rows F.1, U.2, U.3 (and the S.1 to S.4 isolation the
P0 names); brief `briefs/w4-install-identity.md` on `origin/build-briefs`; ADR 0082;
`docs/status/reports/triage-2026-10-23.md` P0 #2.

## Review

Independent adversarial review, stage REVIEW AND FIX, 2026-10-25, of the item's changes as they
stand on `ccr-af5a431d-jc9xqj` at 894b76d (the code moved since the merge: `compose.ts` grew
by a thousand lines, `main.ts` and `runner.ts` were touched by later items; every function,
route, test and doc sentence the item added was located on the current head and traced from its
callers). The item's tests were run on the head (`compose-identity.test.ts` 10, cloud-runner
`identity.test.ts` 1: all pass) and checked by mutation: dropping the source condition on
`rememberBoundHuman` fails exactly "records the bound human there, never an override"; making
`pickPrincipal` ignore the name fails exactly "by name when there are several". Two throwaway
tests (deleted afterwards) proved findings 1 and 2.

**Verdict: revise.** Score: 62/100. The P0 itself is closed: two installs on one store each
bind to their own human, principal and critic; no selector on a two-human store is refused with
nothing written; the runner follows the same rule and never creates; `fr doctor` names the
binding; the ADR and the three maintainer docs describe what the code does, and the tests prove
what their names claim. What is wrong sits at the edges the brief and the ADR drew themselves:
the id the daemon records in `config.json` (ADR 0082 decision 3) becomes a dead end the moment it
names nobody in the configured store, and the remedies the refusal offers on that path lead to
the other human's row, the bug by hand; the cloud runner binds the runtime to its human but not
to its agent; and `fr doctor`'s "without creating anything" creates the store.

### Requirements checked

- [x] Brief: a `humanId`/`humanEmail` selector in `config.json` written by `fr setup`
  (`--human-id`, `--email`), overridable by `FORERUNNER_HUMAN` as id or email, resolved like the
  runner's `resolveHuman` (id first, then email, case-insensitive): `identity.ts`
  `lookupInstallHuman`, proven by `compose-identity.test.ts` "two installs...", "config.json
  selects by id, then by email...", "the environment selector wins...".
- [x] Brief: a store holding several humans and no selector refuses with
  `ForerunnerError("identity_ambiguous")` and nothing is created. ADR 0082 decision 2 widens
  the triage's "non-sqlite" to every dialect with a reason; the test proves counts unchanged.
- [x] Brief: the first-run creation path unchanged for a store with no human; a single-human
  store unchanged (`source: "only"`).
- [x] Brief: the agent chosen among the human's own principals, never another human's
  (`pickPrincipal` over `store.agent.principals(human.id)`; "Naming another human's agent never
  crosses over" case). Partly met for the runner: it resolves its agent by
  `FORERUNNER_RUNNER_AGENT` but the runtime it composes picks its own (finding 2).
- [~] Brief: `fr doctor` reports which human the install is bound to "without creating
  anything": it names the binding, but opening the store creates the SQLite file and runs
  migrations (finding 3).
- [x] Brief: the runner passes the human it resolved (`identity.humanId`), so its device,
  sessions, billing and the composed runtime share one row (`identity.test.ts`).
- [x] Brief: docs runtime.md (Local daemon, Identity paragraph, tests, Known issues),
  cloud-runner.md (variables, start sequence, tests, Known issue resolved), testing.md
  (scenario world), platform-notes.md (the new code); ADR 0082 amends 0024.
- [~] ADR 0082 decision 3, "a later change of the email in the store never rebinds the
  install": the recorded id also survives a change of the store or the loss of the row, where
  it names nobody and cannot be cleared (finding 1).
- [x] Security: no secret in any log line or row (`install identity` logs id and source);
  `fr doctor` redacts the store URL's credentials; `identity_ambiguous` details list names and
  emails of the store's humans, which members of a shared store see anyway (peer feed).
- [x] Later merges: ADR 0083's private index is per install directory and independent of the
  human; ADR 0065 shared secrets, R.2 Settings → Devices and ADR 0088 late approvals all act as
  `rt.human.id`, which is now the install's own human on every store. The gate-5 daemon view
  carries `identity`. No semantic conflict found; one hygiene gap on the refusal path
  (finding 4).

### Findings

1. **high**: `packages/runtime/src/daemon/identity.ts:113-121` (`lookupInstallHuman`, a named
   selector that names nobody is `not_found` whatever its source) with
   `packages/runtime/src/setup/wizard.ts:171-183` (`rememberBoundHuman` writes `humanId` into
   `config.json` after the first bind) and `:216` (`runSetup` keeps `existing.humanId` whatever
   flags are given). Once a daemon has started from its `config.json`, the file names a human
   by id. If that id names nobody in the configured store, the install never starts again and
   nothing the product offers gets it out: `--email` is never consulted while `humanId` is set,
   `fr setup` has no way to clear `humanId`, and the refusal's remedies are
   `FORERUNNER_HUMAN=<id or email>` (the own email names nobody on that store: `not_found`
   again) and `fr setup --human-id <id>`, where the only ids that resolve are other people's.
   Realistic paths: (a) a solo install whose daemon ran once, then `fr setup --state-url
   postgres://... --email me@...` to join the friend's shared store (the spec's default
   "Paired local" mode; `--state-url` is a `fr setup` flag): the recorded id belongs to the old
   SQLite store, the Postgres holds the friend, and the one id the message offers to bind to is
   the friend's, the P0 by hand; (b) a wiped data directory with an untouched config directory
   (XDG keeps `~/.config/forerunner` apart from `~/.local/share/forerunner`): the install is
   dead until `config.json` is edited by hand. Verified with a throwaway test: `config.json`
   `{ humanId: "stale-id-from-before-the-wipe", humanEmail: "j@solo.test" }` on an empty
   `sqlite:` store; `composeRuntime` rejected `not_found: no human with id or email
   stale-id-from-before-the-wipe (from config.json humanId); set FORERUNNER_HUMAN=<id or
   email>, or run fr setup --human-id <id> or fr setup --email <address>`. Neither the item's
   tests nor the ADR consider a recorded id that stops resolving. Smallest correct fix: a
   `config.json` id that names nobody is stale, not a refusal: the lookup falls through to the
   configured email (which binds the row with that email or creates the install's own human,
   never another row), the daemon logs it and re-records the new id; with no email configured
   it stays `not_found`. `FORERUNNER_HUMAN` and the caller's selector stay strict (they are
   given per start). `fr doctor` says what the next start will do. ADR 0082 decision 1 and 3
   amended (dated section). Test: `compose-identity.test.ts` with a stale recorded id on an
   empty store and on a store holding another human.
   Resolution: fixed in f6423e2: `lookupInstallHuman` treats a `config.json` `humanId` that
   names nobody as stale when the configuration carries an email (the email binds its own row
   or creates the install's human, never another row; `staleConfigHumanId` on the lookup and
   on `RuntimeApp.identity`; the daemon warns and re-records the id; `fr doctor` names it),
   and keeps `not_found` without an email and for `FORERUNNER_HUMAN` or the caller's selector;
   ADR 0082 amended (decisions 1 and 3). Tests: `compose-identity.test.ts` "a recorded
   humanId that names nobody falls through to the configured email, never to another row" and
   "a wiped store with a recorded humanId starts again by email and records the new id" (both
   fail before the fix with the `not_found` quoted above).
2. **medium**: `services/cloud-runner/src/runner.ts:392-397`. The runner resolves its agent
   (`FORERUNNER_RUNNER_AGENT`, id or name, `resolveAgent`) and keys every session, token, claim
   and status to it, but passes only `humanId` to `composeRuntime`, which picks the human's
   principal by `FORERUNNER_AGENT_NAME` or takes the first. With two principals and the runner
   serving the second, `runner.agent` and `rt.agent` are two agents: the composed memory loop,
   context layer, token issuer, model-watch approvals, the specialist and extension approval
   syncs and `/health` are the first agent's while the runner's sessions run as the second.
   Verified with a throwaway test: human J with principals Alice and Alice2,
   `FORERUNNER_RUNNER_AGENT=Alice2`; `runner.agent` was Alice2, `runner.rt.agent` was Alice.
   The item's test seeds one principal per human and cannot see it. Fix:
   `ComposeOptions.identity.agentId` (the caller's resolved agent, which must be one of the
   human's principals, else `not_found`; never another human's), the runner passes `agent.id`;
   `pickPrincipal` takes the id ahead of the name. Test in cloud-runner `identity.test.ts`.
   Resolution: fixed in f6423e2: `ComposeOptions.identity.agentId`, picked by id ahead of the
   name and refused `not_found` (nothing created, stores closed) when it is not one of the
   human's principals; the runner passes `agent.id`; ADR 0082 decision 4 amended. Tests:
   cloud-runner `identity.test.ts` "the composed runtime is the runner's agent, not the
   human's first principal" (fails before the fix: `rt.agent` was the first principal) and
   `compose-identity.test.ts` "...by name when there are several" extended with the id pick
   and another human's agent by id refused.
3. **medium**: `packages/runtime/src/cli/main.ts:423-440` (`identityCheck`). `fr doctor` opens
   the configured store with `openStore({ url })`: `openSqlite`
   (`packages/state/src/db/sqlite.ts:208-209`) creates the directory and the file, and
   `migrate` defaults to true, so the doctor writes the whole schema to a `state.sqlite` the
   daemon never created, and runs pending migrations on a shared Postgres, from a diagnostic
   command. runtime.md and ADR 0082 decision 6 say it runs the lookup "without creating
   anything". Verified by reading, and by `cli.test.ts`: its doctor case runs before any daemon
   and gets an `identity` line, which only a created store can give. Fix: `migrate: false`; a
   `sqlite:` file that does not exist is not opened and is reported as an empty store (a named
   selector `not_found`, otherwise "created at the daemon's first start"), with the file still
   absent afterwards. Test in `cli.test.ts` (the store file does not exist after `fr doctor`).
   Resolution: fixed in f6423e2: `identityCheck` opens with `migrate: false` and never opens
   a `sqlite:` file that does not exist; the lookup then runs over `EMPTY_HUMAN_STORE`
   (`identity.ts`), prefixed "no store yet (the daemon's first start creates it)"; ADR 0082
   decision 6 amended. Tests: `cli.test.ts` "doctor reports prerequisites and the human the
   install binds to, creating no store" (asserts the state file absent before and after; fails
   before the fix, the file existed) and `compose-identity.test.ts` cases over
   `EMPTY_HUMAN_STORE`.
4. **low**: `packages/runtime/src/daemon/compose.ts:1148-1151`. The identity refusal closes
   `store` but not the private memory index opened just before it (`openPrivateIndex`, line
   1115, ADR 0083, merged after the item): on a non-`sqlite:` store a refused start leaves the
   index's SQLite handle open. Verified by reading (the index is closed only in `close()`,
   line 3147). Fix: close it in the same `catch`, with a test that observes the close.
   Resolution: fixed in f6423e2: the identity refusal (and the new agent refusal) closes the
   private index before the store. Test: `compose-identity.test.ts` "a refused start closes
   the private memory index it opened" (`openPrivateIndex` wrapped through `vi.mock` to
   record each close; fails before the fix with an empty list).
5. **low**: `packages/runtime/test/cli.test.ts:303-312`. The doctor case's "environment
   override is read the way the daemon reads it" sets `FORERUNNER_HUMAN: ""`, which
   `installIdentitySelectors` drops as absent, so the asserted `ok === false` holds with or
   without any environment handling: the assertion proves nothing. Fix: a value that names
   nobody, and assert the detail names it and the `FORERUNNER_HUMAN` label.
   Resolution: fixed in f6423e2: the case sets `FORERUNNER_HUMAN=nobody@env.test` over a
   `config.json` naming `h-123` and asserts the detail names `nobody@env.test`
   "(from FORERUNNER_HUMAN)" and not `h-123`.
6. **low**: `docs/maintainers/platform-notes.md:16-18`. "The latest, `identity_ambiguous`
   (ADR 0082)" is stale: `MEMORY_SCOPE_VIOLATION` (ADR 0083) was added to the union after it.
   Wording; fix in the doc.
   Resolution: fixed in f6423e2: the paragraph names both codes without "the latest".
