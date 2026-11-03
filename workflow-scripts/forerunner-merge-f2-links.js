export const meta = {
  name: 'forerunner-merge-f2-links',
  description: 'Merge fix/f2-links (links that ask for a new window, and Ctrl/Shift-clicks, reach the shell instead of a refused plugin command) into the round branch with full validation, cargo, signature check, push',
  phases: [{ title: 'Merge', detail: 'one branch, full validation, cargo, push' }],
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
    conflicts_resolved: { type: 'array', items: { type: 'string' } },
    integration_fixes: { type: 'array', items: { type: 'string' } },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    problems_left: { type: 'array', items: { type: 'string' } },
  },
  required: ['merged', 'head_sha', 'pushed', 'validation', 'problems_left'],
}

phase('Merge')
const merge = await agent(`
Context: Forerunner (main checkout ${REPO}, branch ${BRANCH}) is a desktop app (React UI in apps/ui, daemon in packages/runtime, Tauri 2 shell in apps/desktop/src-tauri). The Windows window check (Desktop app run 41442343517) found that a target="_blank" link, and any Ctrl/Shift-click on a link, did nothing in the installed app: tauri-plugin-opener's injected click script invoked plugin:opener|open_url, which the capabilities refuse. Branch fix/f2-links fixes it (the plugin is built without its click script, so the shell's own on_new_window / on_navigation handlers take every link), with guards and new window-check steps; it was reviewed independently and fixed up. The fixer's and the reviewer's reports (verdict pass, no blocking findings) are in /tmp/frbench/f2-links-result.json: read them first. The branch is based on 9a24edb; ${BRANCH} has since moved to 193e579 (phase C merged); a dry merge was clean. The fixer's worktrees .claude/worktrees/wf_1061cca9-1ab-1 and -2 are finished: leave them, the session lead removes them.
Other work may be running in worktrees under .claude/worktrees/ (phase E fixers on fix/<area> branches): do not touch those branches or worktrees.

Binding rules: AGENTS.md and docs/maintainers/validation.md (never weaken a test). Disk is limited: every cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. CPUs are shared with other agents: a test that fails only under load is re-run alone and reported either way.

Steps:
1. \`cd ${REPO} && git status\`: on ${BRANCH}, clean (the only untracked file allowed is apps/ui/playwright.local.config.ts; create it from /tmp/frbench/pw-local.config.template.ts if missing, never commit it). \`git fetch origin ${BRANCH}\` and make sure the local branch equals origin.
2. \`git merge --no-edit --no-ff fix/f2-links\` (the merge message says what a person gets: Ctrl/Shift-click and new-window links open in the browser in the desktop app). \`git grep -n "^<<<<<<< "\` finds nothing. \`pnpm install --frozen-lockfile\`. Full validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, \`pnpm test:integration\`, \`pnpm test:e2e\`, \`cd apps/ui && npx vitest run --config vitest.config.ts\`, Playwright with the local config (\`cd apps/ui && npx playwright test --config playwright.local.config.ts\`), and in apps/desktop/src-tauri with CARGO_TARGET_DIR=/tmp/frbench/cargo-target: \`cargo fmt --check\`, \`cargo clippy --all-targets -- -D warnings\`, \`cargo test\`. Fix what the merge broke with the smallest correct change, each fix its own commit.
2b. Three follow-ups from the review's non-blocking notes, each its own commit (failing test first where it can fail here), after the merge and before the full validation is re-run on the result:
   (i) Stale cause: the comment above on_new_window in apps/desktop/src-tauri/src/windows.rs (about lines 132-134), the ExternalLink comment in apps/ui/src/components/ExternalLink.tsx (about lines 10-13) and the apps.md sentence "Before, nothing handled it and the webview dropped the click (the Tasks tab's PR link did nothing)" still say the webview dropped a target="_blank" click; the real cause was the opener plugin's page script cancelling it and the ACL refusing open_url. Make them true and consistent with the new apps.md paragraph.
   (ii) A check that cannot fail: in scripts/desktop-window-check.mjs, pageTargets() turns a failed listTargets into [] (0 targets), so when both reads fail the "no second window" part of the three new shell checks passes without checking anything. A failed read must make that part fail (or the check say it could not tell, as a failure), never pass. Unit test in scripts/desktop-window-check.test.ts that fails before.
   (iii) A refused call at every page load on Linux and macOS: tauri-plugin-notification 2.5.0's page script (src/init-iife.js in ~/.cargo/registry/src/*/tauri-plugin-notification-2.5.0) calls plugin:notification|is_permission_granted at load on every platform but Windows; capabilities refuse it, so every page load throws an uncaught rejection there (the window check now requires a page that throws nothing; a Linux window check would fail). The shell sends notifications from Rust; the UI never uses the web Notification API (pinned by apps/ui/test/shell-commands.test.ts). Fix: grant only notification:allow-is-permission-granted (a read of the permission state, nothing more) to the main window in a capability file with a description saying why, and remove that call from webview_acl.rs's reviewed REFUSED_SCRIPT_CALLS list so the test demands it be granted (show the test failing before the grant). Keep notify / request_permission refused. Update the capability description in default.json if it now says no plugin command at all, and apps.md.
3. The window check's attach mode against a bench, to show the driver still walks the merged UI: \`node scripts/bench/start.mjs --name merge-links --daemon-port 48550 --ui-port 2150 --fresh\`, then the attach run as docs/maintainers/testing.md says; stop the bench with stop.mjs and delete its home.
4. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (if not, re-create from the first unsigned commit with \`git commit-tree -S\`, same trees/authors/messages, and move the branch with \`git update-ref\` after checking the tip's tree is unchanged). End every commit message you write with:
${TRAILER}
5. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push. Never open a pull request.

Report the merge commit, conflicts, fixes after the merge, every validation command with its result, the attach run, whether you pushed and the head sha, and anything left broken.`, { label: 'merge:f2-links', phase: 'Merge', schema: MERGE_SCHEMA })

return { merge }
