export const meta = {
  name: 'forerunner-window-settle',
  description: 'The window check failed on e16bb8c: after the new in-app Ctrl/Shift-click steps it goes back to /projects/<id>, which redirects to /summary while the file: link step already runs, so "the window stays on the page" compares across the redirect; fix the script, review, merge after the temp-folder fix, push',
  phases: [{ title: 'Fix' }, { title: 'Review' }, { title: 'Merge' }],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}, head e16bb8c) has a Windows CI job that drives the installed desktop app's real window (scripts/desktop-window-check.mjs; unit tests in scripts/desktop-window-check.test.ts; docs/maintainers/testing.md, the window check section). On e16bb8c (Desktop app run 41567593475, job 125699876809) every check passed except one: "FAIL the window stays on the app's page after a file: link: before http://tauri.localhost/projects/<id>, after http://tauri.localhost/projects/<id>/summary". Cause (read the script around the in-app Ctrl/Shift-click loop added by polish-desktop, ~lines 1945-1996): after each in-app click the loop calls backToProject(), which goes to /projects/<id>; the app redirects that to /projects/<id>/summary asynchronously; the file: link step captures beforeFile before the redirect settles, so stays() compares two URLs of one page. The app did the right thing (the file: link was handed to no program). Fix the script, not the check's strictness: after backToProject() (and wherever the script navigates before capturing a "before" URL) wait until the page has settled (the URL stops changing and the page's own marker is shown), or go straight to the settled route; keep stays() strict (an app page that moves after a click must still fail). Add a unit test for the settling helper (it waits through a redirect; it still reports a real move). Update testing.md if it describes the steps.

Binding rules: AGENTS.md and docs/maintainers/validation.md (never weaken a check). Never kill processes by name pattern. Do not use the real model or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX = { type: 'object', properties: { branch: { type: 'string' }, head_sha: { type: 'string' }, what_changed: { type: 'string' }, validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } } }, required: ['branch', 'head_sha', 'what_changed', 'validation'] }
const REVIEW = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fix-needed'] }, blocking: { type: 'array', items: { type: 'string' } }, non_blocking: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'blocking', 'non_blocking'] }
const MERGE = { type: 'object', properties: { merged: { type: 'array', items: { type: 'string' } }, head_sha: { type: 'string' }, pushed: { type: 'boolean' }, validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } }, problems_left: { type: 'array', items: { type: 'string' } } }, required: ['merged', 'head_sha', 'pushed', 'validation', 'problems_left'] }

phase('Fix')
const fix = await agent(`${COMMON}
You fix this in a fresh git worktree: \`git checkout -B fix/window-settle ${BRANCH}\` (must contain e16bb8c), \`pnpm install --frozen-lockfile\`. Validation: the scripts' unit tests (\`npx vitest run --project unit scripts/desktop-window-check.test.ts\`), \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, and an --attach run of the window check against a bench in headless Chromium as testing.md describes (bench: \`node scripts/bench/start.mjs --name winsettle --daemon-port 48560 --ui-port 2160 --fresh\`; stop it with stop.mjs and delete its home) to show the driver still walks. Commit (signed); \`git branch -f fix/window-settle HEAD\`.`, { label: 'fix:window-settle', phase: 'Fix', isolation: 'worktree', schema: FIX })
if (!fix) return { fix: null }

phase('Review')
let review = await agent(`${COMMON}
You are an independent reviewer of branch fix/window-settle (fresh worktree: \`git checkout --detach fix/window-settle\`, \`pnpm install --frozen-lockfile\`). Check: the cause is the one described (read the job log lines above and the script); the fix waits for a settled page without loosening stays() (a page that really moves after a click still fails: show it with the unit test); every place that captures a "before" URL after a navigation is covered; the unit tests pass and would fail without the fix; the --attach run walks. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:window-settle', phase: 'Review', isolation: 'worktree', schema: REVIEW })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/window-settle (fresh worktree: \`git checkout -B fixup-window-settle fix/window-settle\`, \`pnpm install --frozen-lockfile\`); same validation; commit (signed); \`git branch -f fix/window-settle HEAD\`.
Fixer: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:window-settle', phase: 'Review', isolation: 'worktree', schema: FIX })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/window-settle into ${BRANCH} in the MAIN checkout ${REPO}. Other work merges there too, one at a time. Before you start, wait (check every 2 minutes, up to 3 hours) until BOTH hold: \`git fetch origin ${BRANCH}\` shows a merge of fix/test-tmp on origin (\`git log --merges --oneline origin/${BRANCH} | grep -c fix/test-tmp\` is at least 1), and the main checkout is on ${BRANCH}, clean (only apps/ui/playwright.local.config.ts untracked), with no .git/MERGE_HEAD and local equal to origin. If it never frees, report that and merge nothing. Wave 7 group 2 works in worktrees on fix/dependent-branches and fix/credential-limits: never touch those.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}
Then: \`git merge --no-edit --no-ff fix/window-settle\`; \`pnpm install --frozen-lockfile\`; validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\` and the scripts' unit tests (the branch changes only the window check script, its tests and docs). Every commit to push is signed (\`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing). \`git push -u origin ${BRANCH}\` (retry 2/4/8/16 s on a network error). Never force-push.`, { label: 'merge:window-settle', phase: 'Merge', schema: MERGE })

return { fix, review, fixup, merge }
