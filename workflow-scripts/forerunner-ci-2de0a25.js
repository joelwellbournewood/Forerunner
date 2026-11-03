export const meta = {
  name: 'forerunner-ci-2de0a25',
  description: 'CI on 2de0a25 failed on Windows only: 23 unit tests (voice install, voice dependencies, the test temp-folder guard) since the run-scoped temp folder (2622e74); find the cause, fix, review, merge, push',
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
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}; head 4b727ae, which contains 2622e74 'testenv: one temp folder per test run' and 2de0a25). CI run 41585526128 on 2de0a25, job 125750207074 'check (windows-latest)': 23 unit tests failed, Windows only (Linux green; the same failures are expected on 4b727ae, CI run 41591479028, in progress). Log, ANSI stripped: /tmp/frbench/ci-artifacts/ci-2de0a25/w.txt. Failing files: scripts/voice-install.test.ts, packages/runtime/test/voice-install.test.ts, packages/runtime/test/voice-install-cli.test.ts, packages/runtime/test/dependencies.test.ts ('voice beside the install (U-011)'), testenv/test/test-tmp.test.ts ('a folder a running process still works in: on Windows it stays ...': on Windows the folder WAS removed). Examples: voice-install.test.ts:652 existsSync(venv('cpu')) false after an install; dependencies.test.ts:199 the same; scripts/voice-install.test.ts:38 exit 1 instead of 0. These passed on Windows before 2622e74 (CI 77497b4 and e16bb8c green). Likely causes to check (verify, do not assume): the run folder makes every temp path longer (D:\a\_temp\fr-test-run-<pid>-<time>\...), and a voice venv layout under it exceeds Windows' 260-character path limit (venv creation or the fake installer fails silently); or the voice code treats a path under TEMP specially; or something keys off TEMP vs TMP vs the original temp folder. For the guard test: on the Windows runner a folder a live child process has as its cwd could be removed, so the test's assumption is wrong there, or the child had exited: find out which from the log and the code. Fix the cause so the tests pass on Windows without weakening them: if paths are too long, shorten the run folder name and its location (e.g. a short prefix and id, at the temp root) and keep each test's own temp names short, and if product code (the voice installer) breaks on long paths say so as a product finding with the fix (Windows long paths are real on a person's PC too); correct the guard test's Windows expectation only with evidence of what Windows does. Measure the longest path the voice tests create, and add a guard (a test that fails if the run folder's path plus the longest known nested path exceeds the Windows limit). Windows cannot be run here: reason from the log and the code, and make the cases you can run here prove the path lengths.

Binding rules: AGENTS.md and docs/maintainers/validation.md (failing test first where one can be written; never weaken a test). CPUs are shared with wave 7 group 3 agents: a test that fails only under load is re-run alone and reported either way. Never kill processes by name pattern. Do not use the real model or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    problem1: { type: 'string', description: 'the voice and dependencies failures: cause with evidence, fix, guard' },
    problem2: { type: 'string', description: 'the guard test on Windows: what Windows does, the corrected expectation and its evidence' },
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
You fix this. You run in a fresh git worktree: \`git checkout -B fix/ci-2de0a25 ${BRANCH}\` (it must contain 4b727ae), \`pnpm install --frozen-lockfile\`. Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\` (maintainer docs for every module you change), \`pnpm test:integration\`, \`pnpm test:e2e\`, and the UI suite if you touch apps/ui. Commit (signed, as git is configured); \`git branch -f fix/ci-2de0a25 HEAD\`.`, { label: 'fix:ci-2de0a25', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/ci-2de0a25 (the fixer's report below holds claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/ci-2de0a25\`, \`pnpm install --frozen-lockfile\`. Check: the cause is proven from the Windows log and the code (path lengths measured, not guessed); the fix keeps every test as strict as before; the guard test's Windows expectation follows evidence; nothing in the temp-folder mechanism's safety (only its own run folders are ever deleted) was weakened; docs true. Run the validation that matters. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:ci-2de0a25', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/ci-2de0a25 (failing test first where it applies; if you judge a finding wrong, say why with evidence). Fresh worktree: \`git checkout -B fixup-ci-2de0a25 fix/ci-2de0a25\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit (signed); \`git branch -f fix/ci-2de0a25 HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:ci-2de0a25', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/ci-2de0a25 into ${BRANCH} in the MAIN checkout ${REPO}. Wave 7 group 3 fixers work in worktrees under .claude/worktrees/ on fix/merge-in-app, fix/credential-chooser, fix/cost, fix/merged-copy: never touch those branches or worktrees. Their merge agent uses the main checkout later: before you start, \`git status\` must show ${BRANCH}, a clean tree (only apps/ui/playwright.local.config.ts untracked; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it) and no .git/MERGE_HEAD; if not, wait (check every 2 minutes, up to 60 minutes) and report if it never frees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`git fetch origin ${BRANCH}\`; local equals origin. \`git merge --no-edit --no-ff fix/ci-2de0a25\`; no conflict markers.
2. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, the live harness \`pnpm --filter @forerunner/live test\`, \`pnpm test:injection\`, the UI suite (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), Playwright with the local config, and the unit suite once more the way CI runs it (FORCE_COLOR=1, no git identity), and the cargo checks (CARGO_TARGET_DIR=/tmp/frbench/cargo-target) only if the branch touched apps/desktop. Fix what the merge broke with the smallest change, its own commit.
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:ci-2de0a25', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
