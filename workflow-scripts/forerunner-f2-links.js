export const meta = {
  name: 'forerunner-f2-links',
  description: 'F2 follow-up: in the installed Windows app a target="_blank" link (and a Ctrl/Shift-click on any link) does nothing, because the opener plugin\'s injected click script calls a plugin command the ACL refuses; fix, guard, review (merge runs separately after phase C)',
  phases: [
    { title: 'Fix', detail: 'opener without its click script, guards, window-check steps, in a worktree' },
    { title: 'Review', detail: 'independent review incl. the link security model' },
    { title: 'Fixup', detail: 'blocking review findings fixed' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (Tauri 2 shell in apps/desktop/src-tauri, React UI in apps/ui, local daemon). The CI job \`window\` in .github/workflows/desktop.yml installs the built MSI on windows-latest and drives the installed app's own WebView2 window over DevTools (scripts/desktop-window-check.mjs; read docs/maintainers/testing.md, the window check section, and docs/maintainers/apps.md, how the shell hands links to the system browser).

Its run on 9a24edb (Desktop app run 41442343517, job 125278317912) walked the whole journey in the real window for the first time: brief → plan → approve → session → tasks done → PR link → system browser, file: link refused, Open folder, Get Docker Desktop, all ok. ONE required check failed: 'a target="_blank" link goes to the system browser (new window)': nothing in desktop-shell.log. The webview console showed: \`Uncaught (in promise) Command plugin:opener|open_url not allowed by ACL\`. The artifact is unpacked at /tmp/frbench/ci-artifacts/window-41442343517/x (result.json, desktop-shell.log, screenshots).

Root cause (verified by reading the source): apps/desktop/src-tauri/src/lib.rs registers \`tauri_plugin_opener::init()\`. tauri-plugin-opener 2.6.0's default Builder has open_js_links_on_click = true, which injects src/init-iife.js (see ~/.cargo/registry/src/*/tauri-plugin-opener-2.6.0/src/lib.rs and src/init-iife.js) into every window: a window click listener that, for an <a> with target="_blank" OR any link clicked with Ctrl or Shift held (http, https, mailto, tel), calls preventDefault() and invokes \`plugin:opener|open_url\` from the page. capabilities/default.json deliberately exposes no plugin command to the webview ("every plugin ... is driven from Rust"), so the invoke is refused and the click does nothing. The shell's own on_new_window handler in windows.rs (new_window_action, with its origin allowlist and the "handed to the system browser" log line) never sees these clicks. So for a person: a Ctrl-click or Shift-click on the PR link, the Docker link or any external link does nothing, and any target="_blank" link (rendered markdown, future code) does nothing.

Binding rules: AGENTS.md and docs/maintainers/validation.md (failing test first for a behaviour bug; never weaken a test or a check). Disk is limited: every cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. 4 CPUs are shared with other agents: a test that fails only under load is re-run alone and reported either way. Never kill processes by name pattern. Commit messages end with:
${TRAILER}
Never push and never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    what_changed: { type: 'string' },
    invoke_audit: { type: 'string', description: 'every webview-to-shell invoke the UI and injected scripts make, and whether the capabilities grant it' },
    what_the_next_windows_run_shows: { type: 'string' },
    security_note: { type: 'string' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_validated: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head_sha', 'commits', 'what_changed', 'invoke_audit', 'what_the_next_windows_run_shows', 'validation', 'not_validated'],
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

phase('Fix')
const fix = await agent(`${COMMON}
You fix this. You run in a fresh git worktree: \`git merge-base --is-ancestor ${BRANCH} HEAD || git merge --no-edit ${BRANCH}\`, create branch fix/f2-links from it, \`pnpm install --frozen-lockfile\`.

1. The fix: build the opener plugin without its injected click script (\`tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build()\`), with a comment saying why (the shell's on_new_window/on_navigation handlers are the one path out, behind the origin allowlist; the plugin's script would call a command the ACL refuses). Keep the capabilities as they are: no plugin command for the webview.
2. Guards, failing first where they can fail here: (a) a Rust test that fails if the opener plugin is ever registered with its click script again (e.g. a source test like the existing one that keeps every window in windows::new_window, if that is the house style; read it first); (b) an audit of every webview-to-shell invoke: every \`invoke(\` / \`__TAURI_INTERNALS__\` / \`@tauri-apps/api\` call in apps/ui/src (download.ts, ExternalLink.tsx, folder, hotkey, and others) and every plugin that injects a js_init_script, each checked against capabilities/*.json. If a test can enforce it cheaply (each command the UI invokes is granted to the window it runs in), add it. Report the audit.
3. The window check (scripts/desktop-window-check.mjs) keeps the failing new-window check unchanged and adds, in shell mode: a Ctrl+click on an external link (one with no target, like the ones ExternalLink renders in the shell) is handed to the system browser, read from the shell's hand-off log line (whatever \`via\` it reports, as long as the shell handed it, and the window stays on the app's page); and a Ctrl+click on an in-app link does not leave the app or open a browser (read new_window_action for app origins first and check what a person should get). Make "the page threw no uncaught error" REQUIRED for errors that show the shell refusing the page (a message containing "not allowed by ACL" or "not allowed. Permissions"), keep other uncaught errors as a note unless you find the journey's clean run throws none, in which case make the whole check required. Unit-test what you add (scripts/desktop-window-check.test.ts).
4. Docs: docs/maintainers/apps.md (how links leave the app: the one path, the plugin's script off and why), docs/maintainers/testing.md (the new window-check steps), CHANGELOG.md (Unreleased: Ctrl/Shift-click and new-window links open in the browser in the desktop app).

Validation before you report: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, the scripts' unit tests, the UI suite if you touched apps/ui (\`cd apps/ui && npx vitest run --config vitest.config.ts\`), and in apps/desktop/src-tauri with CARGO_TARGET_DIR=/tmp/frbench/cargo-target: cargo fmt --check, cargo clippy --all-targets -- -D warnings, cargo test. Then an --attach run of the window check against a bench in headless Chromium (see testing.md; bench via \`node scripts/bench/start.mjs --name links --daemon-port 48530 --ui-port 2130 --fresh\`, stop it with stop.mjs and delete its home) to show the driver still walks and the new steps skip cleanly without a shell. Commit (signed, as git is configured), \`git branch -f fix/f2-links HEAD\`. Report what the next Windows run will show.`, { label: 'fix:f2-links', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/f2-links (the fixer's report below holds claims to verify, not facts). You run in a fresh git worktree: \`git checkout --detach fix/f2-links\`, \`pnpm install --frozen-lockfile\`.

Check: (a) the root cause and the fix: read tauri-plugin-opener 2.6.0's Builder and init-iife.js yourself; with the script off, does every way a person clicks a link (plain click on an ExternalLink in the shell, Ctrl/Shift/middle click, target="_blank", window.open) end in the shell's handlers in windows.rs, and does nothing now bypass the origin allowlist or the file:/custom-scheme refusals; is anything the plugin's script used to do now lost (mailto:, tel: links: does the UI have any, and what happens to them now); (b) the guards would fail if the regression came back, and the invoke audit is complete and true (grep the UI yourself); (c) the window check: the new steps can fail, the old new-window check is unchanged, the uncaught-error rule is right and cannot be flaky on a clean run, unit tests cover the new code; (d) docs true; (e) run the validation that matters (cargo fmt/clippy/test with CARGO_TARGET_DIR=/tmp/frbench/cargo-target, the scripts' unit tests, pnpm check) and an --attach run on a bench (ports 48540/2140, name links-rv; stop it and delete its home). Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:f2-links', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/f2-links (failing test first where it applies; if you judge a finding wrong, say why with evidence). You run in a fresh worktree: \`git checkout -B fixup-f2-links fix/f2-links\`, \`pnpm install --frozen-lockfile\`. Same validation as the fixer; commit (signed); \`git branch -f fix/f2-links HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:f2-links', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

return { fix, review, fixup }
