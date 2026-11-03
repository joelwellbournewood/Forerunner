export const meta = {
  name: 'forerunner-test-tmp',
  description: 'The test suites leave about 1,500 temp folders per full run under the system temp folder (about 100,000 and 15 GB this round): point every test run at a run-scoped temp folder removed at the end, remove what crashed runs left of our own, guard it with a test; review, merge, push',
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
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}; head e16bb8c, wave 7 group 1 merged) is a TypeScript monorepo (vitest projects: unit, integration, e2e, live, injection in the root vitest config and the package configs; apps/ui has its own vitest config; Playwright in apps/ui). Problem (handoffs.json polish R-8): the test suites leave their temporary folders behind. On this machine the system temp folder holds about 101,000 entries from this round's test runs (17,704 fr-email-*, 7,756 fr-update-*, 5,232 fr-voice-install-*, 4,908 fr-bench-*, 3,211 fr-voice-local-*, 1,872 fr-unlock-*, ...), about 15 GB; free disk is 8 GB and each full run adds roughly 1,500 folders. Tests make folders with mkdtemp(os.tmpdir() + 'fr-...') and many never remove them (and daemons or browsers a test starts write there too).
Fix it at the root, once, so no test file needs to change: (1) a vitest globalSetup for every vitest project (root and apps/ui; testenv/src/ci-env.ts is the per-worker setup file added by the CI fix, read it) creates one run folder (e.g. <os tmp>/fr-test-run-<pid>-<time>), sets TMPDIR, TMP and TEMP to it before any worker starts (workers and every process a test spawns inherit it: os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows), and its teardown removes the run folder; (2) it also removes run folders of our own exact prefix that a crashed run left, older than a day; (3) Playwright (apps/ui) the same where it creates temp folders; (4) a test that proves it: a child vitest run (or a small script) that makes temp folders and checks none is left in the real temp folder afterwards and the run folder is gone; (5) docs/maintainers/testing.md says where test temp files go. Do NOT delete anything in the system temp folder except run folders this mechanism created (the exact prefix): never sweep other fr-* folders, which may belong to other runs or tools. Make sure Windows works (TEMP/TMP; long paths; files still open when the teardown runs: retry, then leave it and say so) and that a test that itself sets TMPDIR still works.

Binding rules: AGENTS.md and docs/maintainers/validation.md (never weaken a test). CPUs are shared with wave 7 group 2 agents: a test that fails only under load is re-run alone and reported either way. Never kill processes by name pattern. Do not use the real model or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    problem1: { type: 'string', description: 'the mechanism and where it is wired, per vitest project and Playwright' },
    problem2: { type: 'string', description: 'the proof: before/after counts of temp entries for one full unit run, and the guard test' },
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
You fix this. You run in a fresh git worktree: \`git checkout -B fix/test-tmp ${BRANCH}\` (it must contain e16bb8c), \`pnpm install --frozen-lockfile\`. Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\` (maintainer docs for every module you change), \`pnpm test:integration\`, \`pnpm test:e2e\`, and the UI suite if you touch apps/ui. Commit (signed, as git is configured); \`git branch -f fix/test-tmp HEAD\`.`, { label: 'fix:test-tmp', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/test-tmp (the fixer's report below holds claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/test-tmp\`, \`pnpm install --frozen-lockfile\`. Check: count the entries in the real temp folder before and after a full unit run and a UI run on the branch (none may be added, the run folder must be gone); the guard test fails if the mechanism is removed; nothing outside the mechanism's own run folders is ever deleted; Windows (TEMP/TMP) and a test that sets its own TMPDIR still work; no test weakened; docs true. Run the validation that matters. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:test-tmp', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/test-tmp (failing test first where it applies; if you judge a finding wrong, say why with evidence). Fresh worktree: \`git checkout -B fixup-test-tmp fix/test-tmp\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit (signed); \`git branch -f fix/test-tmp HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:test-tmp', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/test-tmp into ${BRANCH} in the MAIN checkout ${REPO}. Wave 7 group 2 fixers work in worktrees under .claude/worktrees/ on fix/dependent-branches, fix/credential-limits: never touch those branches or worktrees. Their merge agent uses the main checkout later: before you start, \`git status\` must show ${BRANCH}, a clean tree (only apps/ui/playwright.local.config.ts untracked; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it) and no .git/MERGE_HEAD; if not, wait (check every 2 minutes, up to 60 minutes) and report if it never frees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`git fetch origin ${BRANCH}\`; local equals origin. \`git merge --no-edit --no-ff fix/test-tmp\`; no conflict markers.
2. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, the live harness \`pnpm --filter @forerunner/live test\`, \`pnpm test:injection\`, the UI suite (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), Playwright with the local config, and the unit suite once more the way CI runs it (FORCE_COLOR=1, no git identity), and the cargo checks (CARGO_TARGET_DIR=/tmp/frbench/cargo-target) only if the branch touched apps/desktop. Fix what the merge broke with the smallest change, its own commit.
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:test-tmp', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
