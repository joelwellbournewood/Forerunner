# CLAUDE.md

Read `AGENTS.md` first; it is the single source of working rules for this repository. Its
Validation section and `docs/maintainers/validation.md` decide when a change is done: read
them before writing a test or a fix.
Then read `docs/status/UPDATE-LOG.md`, `docs/status/PROGRESS.md`, `docs/requirements.md`, `docs/status/BLOCKERS.md`,
`docs/status/gates.md`, `docs/status/COST.md` and the recent git log before picking up work.

Quick reference:
- `pnpm check` runs lint, typecheck, unit tests, the docs check and the secret scan. Green is
  necessary, not enough: a person-facing change is tested at the boundary the person uses.
- Desktop shell: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
  in `apps/desktop/src-tauri` (Linux needs the packages listed in `.github/workflows/desktop.yml`).
- Before any release the owner installs the build from the Desktop app workflow run and walks
  the U-entries' "Check in the app" steps.
- Maintainer docs are in `docs/maintainers/`; a PR that changes a module must touch its doc.
- Decisions go in `docs/decisions/NNNN-title.md` (ADR template in `docs/decisions/README.md`).
