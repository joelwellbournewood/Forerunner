## What and why

<!-- The U-entry or requirement, what a person saw, the root cause. -->

## Check in the app

<!-- The steps a person takes to see this work (copied to the U-entry). -->

## Validation (docs/maintainers/validation.md)

- [ ] The report or requirement is a test that failed before this change
- [ ] Tested at the person's boundary: the control is clicked, the visible result and the sent body are asserted; Inbox answers use the options the Inbox shows
- [ ] New or changed routes: a case in `apps/ui/test/real-daemon.test.ts`, the fake daemon updated
- [ ] Persisted state tested across a restart; processes and timers checked after stop, Quit, uninstall, upgrade
- [ ] Windows: paths with spaces and non-ASCII, another drive, a standard user, files held open (or why not applicable)
- [ ] Every step for the person can be done by the person; every step for an agent by an agent
- [ ] Siblings searched (which search):
- [ ] `pnpm check` green; desktop: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
- [ ] Docs: maintainer doc, user guide (if a person sees it), `CHANGELOG.md` `[Unreleased]`, `docs/requirements.md`, the U-entry

<!-- Docs changed: list them. If none are needed, add the waiver line AGENTS.md describes, with a reason. -->
