export const meta = {
  name: 'forerunner-merge-f2',
  description: 'Merge fix/f2-ci-checks (the real-window check on Windows CI and the Docker full-review check on Linux CI) into the round branch with full validation, bench smoke, signature check, push',
  phases: [{ title: 'Merge', detail: 'one branch, full validation, cargo, bench smoke, push' }],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'string' } },
    head_sha: { type: 'string' },
    pushed: { type: 'boolean' },
    review_of_f6f9bb0: { type: 'string', description: 'what you found reading the reviewer\'s own fix commit' },
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    integration_fixes: { type: 'array', items: { type: 'string' } },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    smoke: { type: 'string' },
    problems_left: { type: 'array', items: { type: 'string' } },
  },
  required: ['merged', 'head_sha', 'pushed', 'validation', 'problems_left'],
}

phase('Merge')
const merge = await agent(`
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app: a persistent AI project manager (React UI in apps/ui, daemon in packages/runtime, Tauri 2 shell in apps/desktop/src-tauri). Phase F2 of the owner-approved plan (docs/status/handoff/NEXT-SESSION.md) adds two CI checks that only a real GitHub run can prove:
- job \`window\` in .github/workflows/desktop.yml: installs the built MSI on windows-latest, starts the installed app on the stand-in model (new shell switch FORERUNNER_DAEMON_PROVIDER, allowlisted to fake, bench, bench-live), attaches to the WebView2 window over DevTools (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) and walks the core journey plus the PR link, target=_blank, file: link, Open folder and Get Docker Desktop hand-offs (scripts/desktop-window-check.mjs), reading the shell's new hand-off log lines (windows.rs, folder.rs).
- job \`sandbox-full-review\` in .github/workflows/ci.yml: builds the runner image, runs a tier-2 task in the real Docker sandbox and checks the container's events, the critic's tier and the file (scripts/sandbox-full-review.mjs).
Branch fix/f2-ci-checks (f6f9bb0) holds four signed commits: ea132f5, 933e3d4 and 3ae158c by the builder, and f6f9bb0, the independent reviewer's own fix (it removed a sandbox check that could not fail and made the window check save a screenshot where it stops). Phase C is still running in other worktrees and will merge later; do not touch its branches (fix/verification, fix/continuity, fix/github-result, fix/research-web, wip/*) or its worktrees under .claude/worktrees/.

Binding rules: AGENTS.md and docs/maintainers/validation.md (failing test first for a behaviour bug; never weaken a test). Windows CI is several times slower: in any test you touch, no short real-time waits. Disk is limited: for every cargo command set \`CARGO_TARGET_DIR=/tmp/frbench/cargo-target\` (never build into apps/desktop/src-tauri/target). 4 CPUs are shared with two phase C agents: a test that fails only under load must be re-run alone before you call it a failure, and reported either way.

Steps:
1. \`cd ${REPO} && git status\`: on ${BRANCH}, clean (the only untracked file allowed is apps/ui/playwright.local.config.ts; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it). \`git fetch origin ${BRANCH}\` and make sure the local branch equals origin.
2. Nobody reviewed the reviewer's own fix commit. Read \`git show f6f9bb0\` critically: does every check it changes still fail when the thing it checks is broken; does the new whole-screen capture (desktopScreenshot, PowerShell CopyFromScreen with the path only in an env var) pass no untrusted text into a shell; are the docs true. Fix a real problem with the smallest change (its own commit), and say what you found.
3. \`git merge --no-edit --no-ff fix/f2-ci-checks\`. \`git grep -n "^<<<<<<< "\` must find nothing. \`pnpm install --frozen-lockfile\`. Full validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, \`cd apps/ui && npx vitest run --config vitest.config.ts\`, Playwright with the local config (\`cd apps/ui && npx playwright test --config playwright.local.config.ts\`), and in apps/desktop/src-tauri with CARGO_TARGET_DIR=/tmp/frbench/cargo-target: \`cargo fmt --check\`, \`cargo clippy --all-targets -- -D warnings\`, \`cargo test\`. Also parse both workflow files (python3 yaml.safe_load) and check every new step has exactly one of uses/run and that every artifact name the window job downloads is one the build job uploads. Fix what the merge broke with the smallest correct change, each fix its own commit.
4. Bench smoke on the merged result (stand-in): \`node scripts/bench/start.mjs --name merge-f2 --daemon-port 48510 --ui-port 2110 --fresh && node scripts/bench/journeys/smoke.cjs merge-f2; node scripts/bench/stop.mjs --name merge-f2\`. Every check ok, or each failure explained (a real product failure is fixed with a test, or reported in problems_left). Then, against that same kind of bench, the window check's attach mode as the builder did (\`node scripts/desktop-window-check.mjs --attach ... --app-origin ...\`, see docs/maintainers/testing.md), to show the driver still walks the merged UI; stop every bench you started and delete its home.
5. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (if not, re-create from the first unsigned commit with \`git commit-tree -S\`, same trees/authors/messages, and move the branch with \`git update-ref\` after checking the tip's tree is unchanged). End every commit message you write with these two lines:
${TRAILER}
6. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push. Never open a pull request.

Report: what you found in f6f9bb0, what was merged (merge commit id), conflicts, fixes after the merge, every validation command with its result, the smoke and attach-mode results, whether you pushed (and the head sha), and anything left broken.`, { label: 'merge:f2', phase: 'Merge', schema: MERGE_SCHEMA })

return { merge }
