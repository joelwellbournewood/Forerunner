# 0082 — Install identity on a shared store: an install names its human; the store's first row is never it

Date: 2026-10-23
Status: accepted (amends 0024's "Paired mode, PC online: it works on Postgres directly")

## Context

ADR 0024 makes every PC's daemon and the cloud runner direct clients of the shared Postgres.
The composition root (`composeRuntime`) bootstrapped identity as "the first human in the
store, created when there is none", which is right for a solo `sqlite:` store with one
person in it and wrong for every shared one: the second PC's daemon became the first
human. It ran that human's agent with its own vault keys, answered requests as them
(`by = rt.human.id` on the daemon routes), spent their monthly cap and read their inbox:
cross-human access in the spec's default two-person mode (triage 2026-10-23, P0 #2). The
cloud runner already had a selector (`FORERUNNER_RUNNER_HUMAN`, id or email) but fell back to
the first row too, and passed only the human's name to `composeRuntime`, so the runtime it
composed could bind to someone else on a store with several humans. The scenario world
assembled its two installs by hand for this reason, so no test covered two installs through
`composeRuntime`.

The question was what an install should name, where, and what happens when it names nothing.

## Decision

1. **An install binds by selector, in this order, the first present deciding:** the caller's
   `ComposeOptions.identity.humanId` (the cloud runner passes the human it resolved), the
   environment's `FORERUNNER_HUMAN`, `config.json`'s `humanId`. Each is an id or an email;
   the id is tried first, then the email (case does not matter); a selector that names
   nobody is `not_found` and the daemon does not start. Without one of these, an email
   (`ComposeOptions.identity.email`, else `config.json`'s `humanEmail` from
   `fr setup --email`) finds the human by email or, when nobody has it, names the human
   created at this start: the joining PC's path. Without any selector the store must hold at
   most one human: none is the first run (the human is created from `humanName` and
   `timezone`), one is a solo install, more is `ForerunnerError("identity_ambiguous")` and
   nothing is created or started. `packages/runtime/src/daemon/identity.ts` holds the rule
   (`lookupInstallHuman`, `bindInstallHuman`); the daemon and the cloud runner both call it.
2. **The dialect plays no part.** The triage proposed refusing an ambiguous *non-sqlite*
   store. Two profiles on one machine can share a `sqlite:` file, and the rule costs nothing
   on a store that holds one human, so it is the same everywhere: a store holding several
   humans and no selector is refused whatever the URL. A single-human store is unchanged.
3. **The binding is recorded once.** A daemon started from its `config.json` (the file read
   from the install's config dir) that bound by email, as the only human or by creating one,
   writes the human's `id` into `config.json` as `humanId`, so a later change of the email in
   the store never rebinds the install and the next start resolves by id. A binding from
   `FORERUNNER_HUMAN` or from the caller is for that start only and is never written; a
   `config.json` that already names a human is left alone. `fr setup` keeps the key.
4. **The agent is one of the human's own principals.** `store.agent.principals(human.id)`
   is the only candidate list; `agentName` (or `FORERUNNER_AGENT_NAME`) picks among them by
   name when it matches, else the first, and a principal is created with that name only when
   the human has none. The critic agent is looked up and created per owner as before.
5. **The runner follows the same rule and never creates.** `FORERUNNER_RUNNER_HUMAN` is the
   caller's selector; no selector binds the store's only human, several humans are
   `identity_ambiguous`, an empty store is `not_found` ("run the desktop setup first"). The
   runner passes `identity.humanId` to `composeRuntime`, so the runtime it composes is bound
   to the same row as its own device, sessions and billing.
6. **`fr doctor` says who the install is** before any daemon runs: with a `config.json` it
   opens the configured store, runs the lookup without creating anything and prints the
   human it would bind to and from which selector, "created at first start" for an empty
   store or an unknown email, or a failing line naming the humans and the remedies
   (`FORERUNNER_HUMAN=<id or email>`, `fr setup --human-id <id>`, `fr setup --email <address>`).

## Consequences

- A second PC on a shared store starts only as its own human: with `fr setup --email` it
  joins (its human is created or found by email); without any selector it is refused with a
  message that names the humans and the fix, instead of silently becoming the first one.
- An existing solo install is unchanged: one human, no selector, bound as before; its
  `config.json` gains `humanId` at the next start.
- `fr setup --email` on a solo install whose human was created with an empty email creates
  a second human at the next start (the email matches nobody). `fr doctor` says so before
  the start ("created at the daemon's first start, the store holds 1 other; use --human-id
  to bind to one of them"); `fr setup --human-id <id>` binds to the existing row instead.
  The daemon never adopts a row the selector does not name.
- The e2e scenario world still assembles its installs by hand; the seam it needed
  (`identity.humanId`) now exists, and the gate-5 daemon view carries `identity` like the
  real `RuntimeApp`. Pointing the world at `composeRuntime` is a separate refactor
  (testing.md, Scenarios, Known issues).
- `identity_ambiguous` is a new stable error code in `@forerunner/platform`.

## Alternatives considered

- **Keep "first human" and document it.** Rejected: it is the P0 itself; the default
  two-person mode of the spec runs two daemons on one Postgres.
- **Refuse ambiguity on non-sqlite stores only.** Rejected (decision 2): the dialect is not
  what makes a store shared, and the rule is free on a single-human store.
- **Adopt the store's only human when the configured email matches nobody.** Rejected: on a
  shared store whose first human was created by an older build with an empty email, the
  joining PC would become that person, which is the bug again. `--human-id` is the explicit
  path, and `fr doctor` shows what the next start will do.
- **Resolve the human in `fr setup` and write only `humanId`.** Rejected: setup runs before
  the store is reachable on a fresh install (the human does not exist yet), and setup is the
  one command that must not need the database. The daemon records the id after its first
  bind instead (decision 3).
- **Make the selector the human's name.** Rejected: names are not unique and change; the id
  is stable, the email is what people know, and both already identify a human in the
  runner's selector.
