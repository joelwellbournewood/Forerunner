export const meta = {
  name: 'forerunner-win-tests',
  description: 'The desktop shell\'s Rust test binary no longer starts on Windows (STATUS_ENTRYPOINT_NOT_FOUND) since the link fix\'s webview_acl tests build every plugin; fix the root cause, review, merge, push',
  phases: [
    { title: 'Fix', detail: 'root cause, in a worktree' },
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
Context: Forerunner's desktop shell is Tauri 2 (apps/desktop/src-tauri; main checkout ${REPO}, branch ${BRANCH}). The Desktop app workflow on 0cf1a40 (run 41465526965, job 125345258042, windows-latest) failed at "Rust unit tests (desktop shell)": \`cargo test\` built fine, then \`target\\debug\\deps\\forerunner_desktop_lib-<hash>.exe\` did not start: exit code 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND. So the build, the installer and the window check were skipped. The same step passed on 9a24edb (run 41442343517) and on 193e579 (run 41456492318). What changed since: the link fix (merge c46e4d3, commits f0e9852 and 0cf1a40) added src/webview_acl.rs, whose cfg(test) tests BUILD every plugin run() registers (opener, dialog, notification, deep-link, single-instance, log, global-shortcut, the hotkey plugin) to read each plugin's page script, and capabilities/notification.json. Linux and the local cargo test pass (143 tests).

Likely cause (verify, do not assume): a DLL entry point the test binary imports is not found at load. tauri-plugin-dialog 2.8.0 uses rfd with its common-controls-v6 feature (TaskDialogIndirect from comctl32.dll v6), which needs an application manifest that selects Common Controls v6; tauri-build embeds that manifest only into the app's own binary, not into test executables, so a test binary that now links the dialog plugin's code loads comctl32 v5 and fails. Tauri documents this for tests on Windows (search the Tauri v2 docs and issues for "STATUS_ENTRYPOINT_NOT_FOUND" and tests; the usual fix is tauri_build's WindowsAttributes::new_without_app_manifest() and embedding the same manifest for every target with linker arguments (/MANIFEST:EMBED and /MANIFESTINPUT:<file>) from build.rs, under cfg(windows) for the msvc target). Read tauri-build's source in ~/.cargo/registry/src/*/tauri-build-* for what it embeds now (the app manifest's dependentAssembly for Microsoft.Windows.Common-Controls 6.0.0.0 and anything else, e.g. the DPI or long-path settings) so the app's own manifest stays exactly as it is today.

Binding rules: AGENTS.md and docs/maintainers/validation.md (never weaken a test: keep webview_acl's tests building the real plugins). Disk: every cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target (it was just emptied; the first build takes a while). CPUs are shared with phase E agents. Never kill processes by name pattern. Do not use the real model or any token. Commit messages end with:
${TRAILER}
Only the merge step pushes; never open pull requests.
`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    root_cause: { type: 'string', description: 'with the evidence (source lines, docs/issues read)' },
    fix: { type: 'string' },
    app_manifest_unchanged: { type: 'string', description: 'how you know the installed app embeds the same manifest as before' },
    what_ci_will_show: { type: 'string' },
    validation: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_validated: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head_sha', 'commits', 'root_cause', 'fix', 'app_manifest_unchanged', 'what_ci_will_show', 'validation', 'not_validated'],
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
You fix this. Fresh worktree: \`git checkout -B fix/win-tests ${BRANCH}\` (must contain 0cf1a40). Find the root cause with evidence (which imported function, from which crate and feature; why 9a24edb's test binary did not import it). Fix it so every test binary of the desktop shell starts on Windows while the app's own manifest stays the same; keep webview_acl's tests as they are. Add a guard that would catch a regression off Windows if one can be written (e.g. a build.rs unit or a test that the manifest file embedded for all targets declares Common Controls 6.0.0.0 and matches what tauri-build embedded before); if none can, say so. Check what you can here: cargo fmt --check, cargo clippy --all-targets -- -D warnings, cargo test (Linux), and \`rustup target add x86_64-pc-windows-msvc\` then \`cargo check --target x86_64-pc-windows-msvc --all-targets\` (build.rs runs for the target; linking cannot be checked here: say so). Update docs/maintainers/apps.md (the Windows manifest and why). Commit (signed); \`git branch -f fix/win-tests HEAD\`. Then delete /tmp/frbench/cargo-target/x86_64-pc-windows-msvc if you created it.`, { label: 'fix:win-tests', phase: 'Fix', isolation: 'worktree', schema: FIX_SCHEMA })

if (!fix) return { fix: null }

phase('Review')
const review = await agent(`${COMMON}
You are an independent reviewer of branch fix/win-tests (the fixer's report below holds claims to verify, not facts). Fresh worktree: \`git checkout --detach fix/win-tests\`. Check: the root cause is proven by the sources (rfd/tauri-plugin-dialog features, tauri-build's embedding); the fix makes every test binary and the app carry the right manifest on windows-msvc and changes nothing on Linux/macOS or windows-gnu; the app's manifest is unchanged (compare with tauri-build's own default manifest text); no test was weakened; the docs are true. Run cargo fmt/clippy/test (CARGO_TARGET_DIR=/tmp/frbench/cargo-target) and the windows-msvc cargo check if the target is installed. Verdict fix-needed only for real, evidenced problems. Do not modify the branch.

Fixer's report: ${JSON.stringify(fix)}`, { label: 'review:win-tests', phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })

let fixup = null
if (review && review.verdict === 'fix-needed') {
  phase('Fixup')
  fixup = await agent(`${COMMON}
Fix every blocking finding of the review on fix/win-tests (if you judge a finding wrong, say why with evidence). Fresh worktree: \`git checkout -B fixup-win-tests fix/win-tests\`. Same validation as the fixer; commit (signed); \`git branch -f fix/win-tests HEAD\`.

Fixer's report: ${JSON.stringify(fix)}
Review: ${JSON.stringify(review)}`, { label: 'fixup:win-tests', phase: 'Fixup', isolation: 'worktree', schema: FIX_SCHEMA })
}

phase('Merge')
const merge = await agent(`${COMMON}
You merge fix/win-tests into ${BRANCH} in the MAIN checkout ${REPO}. Phase E fixers work in worktrees under .claude/worktrees/ on fix/<area> branches: never touch those. Another merge (fix/ci-193e579) may still be using the main checkout: before you start, \`git status\` must show ${BRANCH}, a clean tree (only apps/ui/playwright.local.config.ts untracked; never commit it) and no .git/MERGE_HEAD, and \`git log origin/${BRANCH} -1\` must equal the local head; if not, wait (check every 2 minutes, up to 90 minutes) and report if it never frees.
Reports: fix ${JSON.stringify(fix)} review ${JSON.stringify(review)} fixup ${JSON.stringify(fixup)}

1. \`git fetch origin ${BRANCH}\`; local equals origin. \`git merge --no-edit --no-ff fix/win-tests\`; no conflict markers.
2. \`pnpm install --frozen-lockfile\`. Validation: \`DOCS_CHECK_BASE=origin/${BRANCH} pnpm check\`, and in apps/desktop/src-tauri with CARGO_TARGET_DIR=/tmp/frbench/cargo-target: cargo fmt --check, cargo clippy --all-targets -- -D warnings, cargo test. (The branch changes only the desktop shell and its docs; run pnpm test:integration and pnpm test:e2e as well if it touched anything else.)
3. Every commit to push is signed: \`for c in $(git rev-list origin/${BRANCH}..HEAD); do git cat-file commit $c | grep -q '^gpgsig' || echo "unsigned $c"; done\` prints nothing (else re-create with \`git commit-tree -S\`, same trees/authors/messages, and \`git update-ref\` after checking the tip's tree is unchanged).
4. \`git push -u origin ${BRANCH}\` (retry up to 4 times on a network error, 2/4/8/16 s). Never force-push.
Report the merge commit, every validation result, whether you pushed and the head sha.`, { label: 'merge:win-tests', phase: 'Merge', schema: MERGE_SCHEMA })

return { fix, review, fixup, merge }
