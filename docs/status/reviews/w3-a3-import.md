# w3-a3-import: import an existing GitHub repository on a migration branch

## Build report

Item `w3-a3-import`, requirement A.3, ADR 0069. Started by merging the interrupted
`origin/wave/w3-a3-import` (3 commits over `b31c2e5`) onto `ccr-af5a431d-jc9xqj`; one
conflict (`capabilities.md`, both sides kept). Built: `DataImporter.importGitHubRepo()`
clones `owner/name` or an http(s) URL into `<data>/projects/<id>/repos/<owner>/<name>`,
opens `forerunner/migration-<date>` from `origin/<default>`, never writes the default branch
(asserted in code), registers one folder asset and the `repos` link, audits the reference only;
`POST /projects/:id/data/import` with `source: "github"`, `tokenRef?`; composed with the vault and
`secret:github_token`, sent to `gitRemoteBase`'s origin only. Changed from the interrupted build:
(1) a re-import compares the checkout's `origin` with the requested URL and refuses a mismatch
(the same slug on another host silently fetched the other checkout); (2) the token header is
scoped to the origin at the git level (`http.<origin>/.extraheader`; an `insteadOf` rewrite
carried the token before); (3) a fresh clone that fails after the clone (empty repository,
refused checkout, time limit) is removed; (4) a killed git command is `timeout` naming the limit;
(5) platform `run()` resolved only at `close`, which git's surviving remote helper held open,
so no clone was time-bounded: it now resolves at the killed child's exit. Tests (each new case
failed before its change): `data-import-github.test.ts` (6: clone, branch, untouched default
branch, token on no surface, idempotent re-import; token origin rule and the mismatch refusal;
hostile `..`/`.git` tree, symlinks, empty repository, never-answering server; `insteadOf`;
refusals; parser), `data-routes` (+1), `data-wiring` (+1), `git.test.ts` (5), `shell.test.ts`
(+1). Verification: Biome clean on the 6 code files; check-paths, typecheck and docs-check ok
except the base's own `scripts/package-test-scripts.test.ts` (3 tsc errors, one `node:path`
import, pre-existing on `7ad6011`); unit run of runtime, capabilities and platform: 183 files,
1731 passed, 1 skipped, 1 load flake (`monthly-jobs-wiring`, passed alone). Open: the UI form
posts `source: "repo"` to the proposed route; the PR executor neither reuses the checkout nor
passes `auth.origin`; clone size bounded by time only; one checkout per slug and project.
