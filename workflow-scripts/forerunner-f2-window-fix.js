export const meta = {
  name: 'forerunner-f2-window-fix',
  description: 'F2 follow-up: the Windows window check could not reach the WebView2 page over DevTools on its first CI run; add diagnostics and a shell-side DevTools switch, review, merge, push',
  phases: [
    { title: 'Fix', detail: 'diagnostics + shell switch + check uses both, in a worktree' },
    { title: 'Review', detail: 'independent review incl. security of the shell switch' },
    { title: 'Fixup', detail: 'blocking review findings fixed' },
    { title: 'Merge', detail: 'full validation, cargo, push' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (Tauri 2 shell in apps/desktop/src-tauri, React UI, local daemon). Phase F2 added the CI job \`window\` in .github/workflows/desktop.yml: it installs the built MSI on windows-latest, starts the installed app with a fresh FORERUNNER_HOME on the stand-in model, and drives the app's own WebView2 window over DevTools (scripts/desktop-window-check.mjs, which uses apps/mobile/e2e/cdp.mjs). Read docs/maintainers/testing.md (the window check section) and docs/maintainers/apps.md (the shell's FORERUNNER_DAEMON_PROVIDER switch) first.

Its first run (Desktop app run 41423382129, job 125215205869, on 6048d50) failed at "the window's page is reachable over DevTools: not within 180 s (GET http://127.0.0.1:9333/json: fetch failed)". The artifact is unpacked at /tmp/frbench/ci-artifacts/window-41423382129/x: result.json, desktop-shell.log, daemon-shell.log and 99-stopped-...-desktop.png. Facts from it:
- The app's environment did reach the app: FORERUNNER_HOME, FORERUNNER_DAEMON_PROVIDER=bench and the others took effect (the shell log names the fresh home; the daemon ran on the stand-in). So WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333 --disable-features=..." was in the app's environment too.
- The window rendered fine: the whole-screen capture shows the installed app's window with the setup assistant and "connected". So the hosted runner paints the window; only DevTools was unreachable.
- Microsoft's docs (CreateCoreWebView2EnvironmentWithOptions) say a WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS value is APPENDED to the app's own additionalBrowserArguments (wry passes its default "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"). Yet no port answered. Unknown whether: the switch never reached msedgewebview2.exe's command line; it reached it but the port did not open (an Edge/WebView2 policy such as RemoteDebuggingAllowed or DeveloperToolsAvailability on the runner image, or a Chromium rule); or it opened elsewhere.
- Only a GitHub run can test Windows. Every push of ${BRANCH} runs CI (about 20 min) and the Desktop app workflow (build about 25 min, then the window job). So the next run must both try the most likely fix AND say exactly what happened if it still fails.

Binding rules: AGENTS.md and docs/maintainers/validation.md; never weaken a check (the window check must still fail when the page cannot be driven). Disk is limited: every cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. 4 CPUs are shared with two other agents. Never kill processes by name pattern. Commit messages end with:
${TRAILER}
Never push and never open pull requests (only the merge step pushes).
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    what_changed: { type: 'string' },
    how_the_next_run_decides: { type: 'string', description: 'what the next CI run will show in each case, and what each outcome means' },
    security_note: { type: 'string' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_validated: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head_sha', 'commits', 'what_changed', 'how_the_next_run_decides', 'validation', 'not_validated'],
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
You fix this. You run in a fresh git worktree: \`git merge-base --is-ancestor ${BRANCH} HEAD || git merge --no-edit ${BRANCH}\`, create branch fix/f2-window from it, \`pnpm install --frozen-lockfile\`.

Do all three, so one CI run decides:
1. Diagnostics. When the DevTools endpoint does not answer in shell mode on Windows, the check collects and saves to the artifact (and prints a short form to the log), before it gives up: the command line of every msedgewebview2.exe process (Get-CimInstance Win32_Process), whether it carries --remote-debugging-port and which --user-data-dir; the TCP ports those processes listen on (Get-NetTCPConnection -State Listen -OwningProcess); the DevToolsActivePort file in that user data folder, if any; the Edge and WebView2 policy registry values under HKLM and HKCU (SOFTWARE\\Policies\\Microsoft\\Edge, ...\\Edge\\WebView2, and the WebView2 loader override keys) that bear on remote debugging, developer tools or additional browser arguments; the installed WebView2 runtime version. Use PowerShell with argv arrays and fixed script text (no untrusted text into a shell), with timeouts, and never let the diagnostics hang or hide the original failure. Unit-test what can be tested off Windows (parsing, the summary lines).
2. A shell-side switch, in case WebView2 ignores the environment variable for this app: read FORERUNNER_WEBVIEW_DEVTOOLS_PORT from the process environment only (like FORERUNNER_DAEMON_PROVIDER in supervisor.rs); accept only a decimal port 1024-65535, refuse anything else with a warning and never forward it; when accepted, the app's windows get \`--remote-debugging-port=<n>\` in their WebView2 additional browser arguments, keeping wry's default --disable-features list (find how the windows are created: tauri.conf.json, windows.rs; Tauri 2 has additional_browser_args on WebviewWindowBuilder / additionalBrowserArgs in window config; every window must share the same arguments, or WebView2 refuses a second environment with different options). Log a warn line naming it, the way the stand-in switch is logged. Off Windows it changes nothing. Rust unit tests for parsing and the argument string; cargo fmt, clippy -D warnings and cargo test pass here. If Windows-only code cannot be compiled here, try \`rustup target add x86_64-pc-windows-msvc\` and \`cargo check --target x86_64-pc-windows-msvc\` (it may fail on linking or the toolchain; say what you could check), and keep Windows-only code minimal and obviously right.
   Security: a DevTools port lets a local process drive the window (which holds the daemon token). The variable gives nothing a process that can set the app's environment does not already have (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS gives the same to any WebView2 app), but document it as development and CI only in docs/maintainers/apps.md next to FORERUNNER_DAEMON_PROVIDER, with that reasoning.
3. The check uses both: windowEnv sets FORERUNNER_WEBVIEW_DEVTOOLS_PORT and keeps WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; the result says which mechanism put the switch on the command line (from the diagnostics, or a quick command-line read once attached). Update the unit tests and docs/maintainers/testing.md (what the next run will show, how to read it).
Also re-check the rest of the journey's Windows assumptions you can check from here, now that the window is known to render (e.g. the target filter: tauri://localhost vs http(s)://tauri.localhost; the splash).

Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, the two scripts' unit tests, cargo fmt --check, clippy --all-targets -D warnings, cargo test (CARGO_TARGET_DIR=/tmp/frbench/cargo-target), and an --attach run of the window check against a bench in headless Chromium to show nothing regressed (see testing.md). Commit (signed, as git is configured), \`git branch -f fix/f2-window HEAD\`. Report what the next CI run will show in each outcome.`, { label: 'fix:f2-window', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/f2-window (the fixer's report below: claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/f2-window\`, \`pnpm install --frozen-lockfile\`.

Check: (a) the diagnostics cannot hang, cannot hide the original failure, pass no untrusted text into PowerShell, and would really answer the open question (switch on the command line or not; port listening or not; a policy); (b) the shell switch: strict parsing, refusal path, the same arguments for every window, wry's default features kept, nothing changes off Windows or without the variable, the log line, tests that would fail if the parsing or argument string broke; the security reasoning in apps.md is true; (c) the check still fails when the page cannot be driven (no check weakened), and its unit tests cover the new code; (d) run the validation that matters (cargo fmt/clippy/test with CARGO_TARGET_DIR=/tmp/frbench/cargo-target, the scripts' unit tests, pnpm check) and an --attach run on a bench. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:f2-window', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/f2-window (failing test first where it applies; if you judge a finding wrong, say why with evidence). You run in a fresh worktree: \`git checkout -B fixup-f2-window fix/f2-window\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit; \`git branch -f fix/f2-window HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:f2-window', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/f2-window into ${BRANCH} in the MAIN checkout ${REPO}. Phase C is running in other worktrees (fix/verification, fix/continuity, fix/github-result, fix/research-web): do not touch those branches or worktrees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`cd ${REPO} && git status\`: on ${BRANCH}, clean (only apps/ui/playwright.local.config.ts may be untracked; never commit it). \`git fetch origin ${BRANCH}\`; local equals origin.
2. \`git merge --no-edit --no-ff fix/f2-window\`; no conflict markers left. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, the UI suite (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), Playwright with the local config, and cargo fmt --check, clippy --all-targets -D warnings, cargo test in apps/desktop/src-tauri with CARGO_TARGET_DIR=/tmp/frbench/cargo-target. A test that fails only under load is re-run alone and reported either way. Fix what the merge broke with the smallest change, its own commit.
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:f2-window', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
