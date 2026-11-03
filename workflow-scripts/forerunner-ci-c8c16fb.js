export const meta = {
  name: 'forerunner-ci-c8c16fb',
  description: 'CI on c8c16fb (waves 5+6 merged) failed: a test needing a git identity, tried commands carrying colour codes under FORCE_COLOR, and three load-sensitive Windows tests; fix, review, merge, push',
  phases: [
    { title: 'Fix', detail: 'root causes, failing tests first, in a worktree' },
    { title: 'Review', detail: 'independent review' },
    { title: 'Fixup', detail: 'blocking findings' },
    { title: 'Merge', detail: 'main checkout, full validation, push' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (React UI apps/ui, daemon packages/runtime, capabilities packages/capabilities). Phase E waves 5 and 6 are merged at c8c16fb. CI on c8c16fb FAILED (CI run 41533695121; Desktop app run 41533695023; read their failed jobs' logs with the GitHub MCP tools: ToolSearch "github actions job logs", mcp__github__actions_list list_workflow_jobs, mcp__github__get_job_logs return_content false, curl the URL into /tmp/frbench/ci-artifacts/ci-c8c16fb/; repository joelwellbournewood/forerunner, read only). Local validation passed because this machine differs from CI in two ways: it has a global git identity, and it does not set FORCE_COLOR (ci.yml sets FORCE_COLOR: 1).
Known failures (from a triage; verify each yourself):
1. apps/ui/test/real-daemon.test.ts:~7276 (the C-57 status-PR case from b89db43) runs a plain \`git -C seedDir merge --no-ff\` through run(), bypassing the seed GitOps' identity: 'fatal: empty ident name' / 'Committer identity unknown' on CI (both OS, Desktop app workflow, UI unit tests).
2. packages/runtime/test/verification.test.ts:~846 and ~920 (C-1: a CLI tried with sample input): the tried command's output arrives as '\\x1b[33m9\\x1b[39m' because FORCE_COLOR=1 reaches the child (packages/runtime/src/loop/try-run.ts TRY_ENV does not clear it). This is a product issue as well: a person whose environment forces colour gets escape codes in 'See what was checked' and in the critic's evidence. Fix the product (tried commands and project checks run without forced colour, e.g. NO_COLOR=1 and FORCE_COLOR removed; and any command output shown to a person or the critic has ANSI escapes stripped), not only the test.
3. Windows only, load-sensitive: testenv/test/githost.test.ts:~504 (timed out at 20 s) and ~597 (2 closed PRs, expected 3), packages/runtime/test/notifications-hear-once.test.ts:~222 (the session did not end in time). Make each wait on the state it needs with a message that says what it saw (never just a longer sleep), and leave nothing running for the next test.
Then make this class of failure visible locally: reproduce 1 and 2 here first (e.g. FORCE_COLOR=1 for 2; for 1 a HOME with no git identity, as CI has), and add what keeps it from coming back (e.g. tests never depending on the machine's git identity; a note in docs/maintainers/testing.md and validation.md that CI sets FORCE_COLOR=1 and has no git identity, and the command to run the suite like CI).

Binding rules: AGENTS.md and docs/maintainers/validation.md (failing test first for a behaviour bug; never weaken a test). Disk is limited: cargo, if needed, uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. CPUs are shared with wave 7 agents: a test that fails only under load is re-run alone and reported either way. Never kill processes by name pattern. Do not use the real model or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    problem1: { type: 'string', description: 'failures 1 and 2: cause, fix, test that failed before' },
    problem2: { type: 'string', description: 'failure 3 and the local reproduction of CI conditions' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_validated: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head_sha', 'commits', 'problem1', 'problem2', 'validation', 'not_validated'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix-needed'] },
    blocking: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' } }, required: ['issue', 'evidence', 'expected'] } },
    non_blocking: { type: 'array', items: { type: 'string' } },
    what_i_checked: { type: 'string' },
  },
  required: ['verdict', 'blocking', 'non_blocking', 'what_i_checked'],
}
const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'string' } }, head_sha: { type: 'string' }, pushed: { type: 'boolean' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    problems_left: { type: 'array', items: { type: 'string' } },
  },
  required: ['merged', 'head_sha', 'pushed', 'validation', 'problems_left'],
}

phase('Fix')
const fix = await agent(`${COMMON}
You fix this. You run in a fresh git worktree: \`git checkout -B fix/ci-c8c16fb ${BRANCH}\` (it must contain c8c16fb), \`pnpm install --frozen-lockfile\`. Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\` (maintainer docs for every module you change), \`pnpm test:integration\`, \`pnpm test:e2e\`, and the UI suite if you touch apps/ui. Commit (signed, as git is configured); \`git branch -f fix/ci-c8c16fb HEAD\`.`, { label: 'fix:ci-c8c16fb', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/ci-c8c16fb (the fixer's report below holds claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/ci-c8c16fb\`, \`pnpm install --frozen-lockfile\`. Check: each failure reproduced under CI's conditions (FORCE_COLOR=1, no git identity) fails before and passes after; the product change (no forced colour for tried commands and checks, ANSI stripped from shown output) is right on Windows and Linux and changes nothing else; no test was weakened and no timeout raised without a reason; the Windows cases wait on state; docs true. Run the validation that matters. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:ci-c8c16fb', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/ci-c8c16fb (failing test first where it applies; if you judge a finding wrong, say why with evidence). Fresh worktree: \`git checkout -B fixup-ci-c8c16fb fix/ci-c8c16fb\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit (signed); \`git branch -f fix/ci-c8c16fb HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:ci-c8c16fb', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/ci-c8c16fb into ${BRANCH} in the MAIN checkout ${REPO}. Wave 7 group 1 fixers work in worktrees under .claude/worktrees/ on fix/merge-record, fix/budget-stop, fix/polish-desktop: never touch those branches or worktrees. Their merge agent uses the main checkout later: before you start, \`git status\` must show ${BRANCH}, a clean tree (only apps/ui/playwright.local.config.ts untracked; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it) and no .git/MERGE_HEAD; if not, wait (check every 2 minutes, up to 60 minutes) and report if it never frees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`git fetch origin ${BRANCH}\`; local equals origin. \`git merge --no-edit --no-ff fix/ci-c8c16fb\`; no conflict markers.
2. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, the live harness \`pnpm --filter @forerunner/live test\`, \`pnpm test:injection\`, the UI suite (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), Playwright with the local config, and the unit suite once more the way CI runs it (FORCE_COLOR=1, no git identity), and the cargo checks (CARGO_TARGET_DIR=/tmp/frbench/cargo-target) only if the branch touched apps/desktop. Fix what the merge broke with the smallest change, its own commit.
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:ci-c8c16fb', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
