export const meta = {
  name: 'forerunner-ci-193e579',
  description: 'CI on 193e579 (phase C merged) failed: a git-version-dependent first-commit refusal message (Linux and Windows) and 10 Windows unit tests timing out after a 2.5x slowdown; find the causes, fix, review, merge, push',
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
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (React UI in apps/ui, daemon in packages/runtime, capabilities in packages/capabilities, Tauri shell). Phase C (verification, continuity, github-result, research-web) was merged at 193e579; the branch is now at 0cf1a40 (a desktop link fix on top). CI on 193e579 (run 41456492496) FAILED; CI on 9a24edb (run 41442343570), before phase C, was green on both OSes. Logs are downloaded (ANSI stripped) in /tmp/frbench/ci-artifacts/ci-193e579/: u.txt (check ubuntu-latest), w.txt (check windows-latest), pw.txt (check windows-latest on 9a24edb, the green run before), now.lst / before.lst (Windows per-file durations, ms). A second sample, CI on 0cf1a40 (run 41465526607), started 14:48 UTC: when its check (windows-latest) job has finished, read it with the GitHub MCP tools (ToolSearch "github actions job logs": mcp__github__actions_list list_workflow_jobs, then mcp__github__get_job_logs with return_content false and curl the URL into /tmp/frbench/ci-artifacts/ci-0cf1a40/; repository joelwellbournewood/forerunner, read only).

Problem 1 (both OSes, deterministic on CI's git 2.56; passes locally): packages/capabilities/test/pr-executor.test.ts "a first commit refused for another reason names the host's one line, not git's output" expected 'git said "This repository is archived and read-only"' and got 'git said "pre-receive hook declined"'. The code (pr-executor.ts, added by phase C github-result) takes the reason from the '! [remote rejected] ... (reason)' line (regex /\\[(?:remote )?rejected\\][^(]*\\(([^)]+)\\)/i) before the host's own 'remote: ...' line, so with this git a person is told git's generic reason instead of the host's sentence. Find how the output differs between git versions (local git --version vs 2.56), fix the extraction so the host's own line wins in every git version (remote: lines, minus git's boilerplate), and make the test feed both output shapes (the newer git's exact shape from u.txt, and the older one) so it can never depend on the machine's git.

Problem 2 (Windows only): 10 unit tests time out or fail (compose-identity x6 at 20 s, voice-run, loop-merge at 60 s, effort-offset assertion, update-screen 'unknown' vs 'available'). The whole Windows unit run took 946 s against 384 s before phase C (import 742 s vs 420 s; tests 1965 s vs 655 s); per-file, compose-identity went 9.7 s to 191 s, voice-run 2.4 s to 173 s, update-screen 0.7 s to 49 s, while Linux stayed normal (270 s, all green except problem 1). Seven new test files came with phase C (continuity-*, verification, web-fetch, research-web). Find out whether this is (a) a slow runner (the 0cf1a40 sample says), (b) something phase C's tests or code leave running on Windows that eats the machine for the rest of the run (a child process tree not killed on Windows: killing cmd.exe/npm does not kill its node child; a headless browser not closed; a timer or watcher keeping a worker busy; a busy-wait), or (c) something phase C made slow per call on Windows (e.g. a probe that spawns npm/npx/docker/a browser with shell: true at compose or per session). Evidence first: read what phase C added that spawns processes or launches a browser (git diff 9a24edb 193e579 -- packages/ testenv/), and how the slow tests compose the runtime. If it is (b) or (c), it is a product bug too (a person's Windows PC would keep a stray process, or every start would be slow): fix it in the product (e.g. kill the whole process tree on Windows with taskkill /T /F, or no probe at compose), with a test that fails before where one can be written off Windows (e.g. the kill path chooses the tree kill on win32; the probe is not called at compose). If it is (a) only, say so with the numbers from both samples and change nothing for it. Never raise a test timeout to hide a slowdown you have not explained.

Binding rules: AGENTS.md and docs/maintainers/validation.md (failing test first; never weaken a test). Disk is limited: every cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. CPUs are shared with phase E agents: a test that fails only under load is re-run alone and reported either way. Never kill processes by name pattern. Do not use the real model (FORERUNNER_ANTHROPIC_API_KEY) or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    problem1: { type: 'string', description: 'cause, fix, test that failed before' },
    problem2: { type: 'string', description: 'which of (a)/(b)/(c), with the evidence (numbers from both samples), the fix if any and its test' },
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
You fix this. You run in a fresh git worktree: \`git checkout -B fix/ci-193e579 ${BRANCH}\` (it must contain 0cf1a40), \`pnpm install --frozen-lockfile\`. Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\` (maintainer docs for every module you change), \`pnpm test:integration\`, \`pnpm test:e2e\`, and the UI suite if you touch apps/ui. Commit (signed, as git is configured); \`git branch -f fix/ci-193e579 HEAD\`.`, { label: 'fix:ci-193e579', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/ci-193e579 (the fixer's report below holds claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/ci-193e579\`, \`pnpm install --frozen-lockfile\`. Check: problem 1's extraction is right for every git output shape you can produce or find (run a real push to a local bare repo with a refusing pre-receive hook with this machine's git, and compare with u.txt's shape), and the test cannot depend on the machine's git; problem 2's conclusion follows from the evidence of both CI samples (read them yourself), no timeout was raised to hide an unexplained slowdown, and any product change (process tree kill, probe) is right on Windows and harmless elsewhere; tests would fail if the fix were reverted; docs true. Run the validation that matters. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:ci-193e579', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/ci-193e579 (failing test first where it applies; if you judge a finding wrong, say why with evidence). Fresh worktree: \`git checkout -B fixup-ci-193e579 fix/ci-193e579\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit (signed); \`git branch -f fix/ci-193e579 HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:ci-193e579', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/ci-193e579 into ${BRANCH} in the MAIN checkout ${REPO}. Phase E fixers work in worktrees under .claude/worktrees/ on fix/answers, fix/screens, fix/noise, fix/bench, fix/stops, fix/asking, fix/decisions, fix/verification: never touch those branches or worktrees. A phase E merge agent may also use the main checkout later: before you start, \`git status\` must show ${BRANCH}, a clean tree (only apps/ui/playwright.local.config.ts untracked; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it) and no .git/MERGE_HEAD; if not, wait (check every 2 minutes, up to 60 minutes) and report if it never frees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`git fetch origin ${BRANCH}\`; local equals origin. \`git merge --no-edit --no-ff fix/ci-193e579\`; no conflict markers.
2. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, the UI suite (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), Playwright with the local config, and the cargo checks (CARGO_TARGET_DIR=/tmp/frbench/cargo-target) only if the branch touched apps/desktop. Fix what the merge broke with the smallest change, its own commit.
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:ci-193e579', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
