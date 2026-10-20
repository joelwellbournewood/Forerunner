# Changelog

All notable changes to Forerunner are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`scripts/release-notes.mjs <tag>` turns the section for a tag into the GitHub Release body, so
every release needs a `## [x.y.z] - YYYY-MM-DD` section here before the tag is pushed. Entries
go under Added, Changed, Deprecated, Removed, Fixed or Security.

## [Unreleased]

### Added

- Monorepo scaffold, `@forerunner/platform`, CI on Windows and Linux, secret scan, docs check.
- Shared state schema v1 with SQLite and Postgres adapters, vault, billing sources and routing.
- Agent runtime: enforcement hooks, session budget, kill switch, `fr` CLI with the setup wizard.
- Fresh-install scripts for Windows and Linux, local Postgres helper, release tooling
  (release notes, Android keystore, gates verification, path lint).
