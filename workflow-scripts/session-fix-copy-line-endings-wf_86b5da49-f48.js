export const meta = {
  name: 'fix-copy-line-endings',
  description: 'Fix the Windows R-copystuck failure: the copy folder must read and write files as the daemon does; fix, adversarial review, fix-up',
  phases: [{ title: 'Fix' }, { title: 'Review' }, { title: 'Fixup' }],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const FAILURE = `CI evidence: the Desktop app workflow run 42525106539 on ce13bb1 (the head of ${BRANCH} before a docs-only commit 2069abc), job "tauri build (windows-latest)", step "UI unit tests" failed one test of 952:
apps/ui/test/real-daemon.test.ts > "the UI client against the real daemon: leftovers of wave 7, merge side, part 2 (leftovers7-merge2)" > "a copy that cannot follow a merge says so on GET /projects/:id/files, with the reason and the file; it follows again once the change is moved away (R-copystuck)"
AssertionError at real-daemon.test.ts:10770: expected after.copy.stopped to be undefined, received { reason: 'changed', files: ['README.md'], line: 'You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.' }.
The same test passes on Linux (CI on 2069abc and this machine). The test edits README.md in the copy, a merge on the host changes README.md, the poll reports the copy stopped (correct), then the test runs \`git -C <folder> checkout -- README.md\` (plain git, the machine's own config) and polls again: on Windows the copy still reads stopped.

The session lead's root-cause hypothesis (CONFIRM it before fixing; if it is wrong, find the real cause): GitOps (packages/capabilities/src/githost/git.ts base()) runs every daemon git command with \`-c core.autocrlf=false -c core.safecrlf=false\`, but the copy's own .git/config does not say so. Git for Windows' default (system/global) is core.autocrlf=true, so the person's git (and the test's) writes README.md with CRLF on \`checkout --\`. The daemon's git, with autocrlf=false, then sees the file's bytes differ from the blob (the index entry is racily clean, so git compares content, and the entry is smudged when the index is written, so it stays "modified"); \`checkout -B <base> origin/<base>\` in DocsWriter.switchCopy (packages/runtime/src/loop/docs.ts, backToBase/settle) refuses, and copyStoppedOf reports 'changed'. Person-visible consequence on Windows (the owner's platform): a person who does what the Files line says ("move your change out of the way") by restoring the file with their own git keeps a copy that never follows what is merged again.`

const COMMON = `Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (React UI in apps/ui, local daemon in packages/runtime). Read AGENTS.md and docs/maintainers/validation.md (binding: failing test first at the person's boundary, then the fix, then the siblings; never weaken a test; persisted state across a restart). ADR 0113 (docs/decisions/) is the copy following every merge and Local only.

${FAILURE}

Environment: 4 CPUs shared with another workflow's two agents (wave 13: areas leftovers7-tailmerge, leftovers7-tailrun, polish-words, polish-screens, which may touch packages/runtime/src/loop/docs.ts copyStoppedOf and add an env option to GitOps for git's message language): keep your change small and local so their merge on top stays simple. Never kill processes by name pattern; stop only PIDs you started. No bench is needed for this. Do not edit docs/status/UPDATE-LOG.md, CHANGELOG.md, docs/requirements.md or docs/status/handoff/NEXT-SESSION.md. Never push; never create pull requests. Commit messages: \`area: what changed (R-copystuck)\` with a body saying why, the root cause, and the test that failed before; end every commit message with:
${TRAILER}`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    root_cause_confirmed: { type: 'string', description: 'what you ran to confirm (or refute) the hypothesis, and what it showed' },
    failing_test_before: { type: 'string' },
    how: { type: 'string' },
    siblings: { type: 'string', description: 'other places checked for the same cause (other person-facing folders, other tests running git in the copy) and what you did' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_done: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['branch', 'head_sha', 'commits', 'root_cause_confirmed', 'failing_test_before', 'how', 'siblings', 'validation', 'not_done'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix-needed'] },
    blocking: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, where: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' } }, required: ['issue', 'where', 'evidence', 'expected'] } },
    non_blocking: { type: 'array', items: { type: 'string' } },
    claims_checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'blocking', 'non_blocking', 'claims_checked'],
}

phase('Fix')
const fix = await agent(`${COMMON}

You run in a fresh git worktree (your current directory). Set up: \`git checkout -B fix/copy-line-endings ${'$'}(git -C ${REPO} rev-parse ${BRANCH})\` (the branch's current head), then \`pnpm install --frozen-lockfile\`.

Task:
1. Confirm the cause. Reproduce the Windows condition on Linux: run the test's person-side git with a global config like Git for Windows' default (GIT_CONFIG_GLOBAL pointing at a temp file holding core.autocrlf=true; NOT a command-line -c, which would beat any folder config). Change the R-copystuck real-daemon case so its person-side \`git checkout -- README.md\` runs that way on every platform (the person's own git with Git for Windows' default), and see it fail before your fix with the Windows assertion. Keep every assertion; do not weaken any.
2. Fix it at the root, in the product: this computer's copy is a folder the person uses with their own tools, so git used in that folder must read and write files as the daemon's git does. The suggested fix: the copy's local config gets core.autocrlf=false (idempotent, set when the daemon clones the copy and on every settle, so copies made before the fix get it too; do not rewrite .git/config when it already says so). If you find a better root fix, explain why. Decide, and say in the report, whether a file whose only difference is line endings (an editor that saved it with CRLF) should still count as the person's change; keep today's behaviour unless the fix needs otherwise.
3. A test in packages/runtime (or capabilities) at the copy's boundary: after a refresh, the copy's own config says core.autocrlf=false, also for a copy made before the fix (one without it), and a person-side restore with a CRLF-by-default global git lets the copy follow again.
4. Siblings: other folders on this computer the daemon makes for the person from git (e.g. "Open this version"'s preview folder, the Local only handling) and other tests whose person-side git runs in such a folder (grep apps/ui/test and packages/*/test for git runs in the copy) — same treatment where the same cause applies; say what you checked.
5. Docs: docs/maintainers/runtime.md (the docs.ts copy section) and, if it lists the copy's git settings, capabilities.md; an ADR 0113 amendment dated 2026-11-09, appended at its end, stating the copy's folder config and why.
6. Validation (all must pass; report each): pnpm lint (0 errors), pnpm typecheck, pnpm test, \`cd apps/ui && pnpm vitest run --config vitest.config.ts\`, pnpm test:integration, pnpm test:e2e, \`node scripts/docs-check.mjs --base ${BRANCH}\`, pnpm docs:links, pnpm secrets:scan. If a failure is not yours (flaky), re-run it once and say so.
Commit on fix/copy-line-endings (one commit for the test and fix is fine if the test commit alone would be red; otherwise test first). Report precisely.`, { label: 'fix:copy-line-endings', phase: 'Fix', schema: FIX_SCHEMA, isolation: 'worktree' })

if (!fix) return { fix: null }

phase('Review')
const reviewPrompt = (head) => `${COMMON}

You are the independent reviewer of a fix for that failure. You run in a fresh git worktree: \`git checkout --detach fix/copy-line-endings\` (head ${head}), \`pnpm install --frozen-lockfile\`. The diff: \`git diff ${BRANCH}...fix/copy-line-endings\`. The fixer's report (claims to verify, not to trust):
${JSON.stringify(fix, null, 1)}

Try to refute the fix. Check: (1) the test reproduces the Windows condition on Linux and FAILS at the base (\`git stash\`/checkout the base's product files and run it) and passes with the fix; no assertion weakened; (2) the fix addresses the person's path on Windows (their own git with core.autocrlf=true in the system or global config; also an IDE using that folder), and copies made before the fix get it; (3) it does not break anything else: the daemon's own commands, Local only, the preview folder, a repository that has a .gitattributes with text/eol rules (does local core.autocrlf=false interact badly?), existing tests; (4) siblings named by the fixer, and any it missed; (5) docs and the ADR amendment are accurate; (6) run the relevant suites yourself (at least the runtime tests that touch the copy, the whole UI vitest suite, lint and typecheck). Verdict 'fix-needed' only for blocking problems (a wrong or incomplete fix, a weakened test, a regression, a missing failing-test-first); everything else is non_blocking.`
const review = await agent(reviewPrompt(fix.head_sha), { label: 'review:copy-line-endings', phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree' })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}

You fix up a reviewed fix. Fresh worktree: \`git checkout -B fixup-copy-line-endings fix/copy-line-endings\`, \`pnpm install --frozen-lockfile\`. The fixer's report:
${JSON.stringify(fix, null, 1)}
The reviewer's findings (fix every blocking one, failing test first; non-blocking ones only where cheap and safe):
${JSON.stringify(review, null, 1)}
Then re-run the full validation list (pnpm lint, typecheck, pnpm test, the UI vitest suite, test:integration, test:e2e, docs check, docs:links, secrets:scan) and move the branch: \`git branch -f fix/copy-line-endings HEAD\`. Report as the fixer did.`, { label: 'fixup:copy-line-endings', phase: 'Fixup', schema: FIX_SCHEMA, isolation: 'worktree' })
}
return { fix, review, fixup }
