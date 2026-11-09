export const meta = {
  name: 'forerunner-prep-e-f2',
  description: 'While phase C runs: triage the leftovers into a phase E spec (read-only), and build the F2 CI checks (real desktop window on Windows, Docker sandbox task on Linux) on their own branch, reviewed; no merge',
  phases: [
    { title: 'Triage E', detail: 'dedupe and classify the leftovers against the current code; a phase E spec' },
    { title: 'Build F2', detail: 'the two CI checks on branch fix/f2-ci-checks' },
    { title: 'Review', detail: 'an independent check of the triage and of F2' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const TRAILER = `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RnhAjh3NRzs8pWu1az7fYz`

const CONTEXT = `
Context: Forerunner (repo ${REPO}, branch ${BRANCH}) is a desktop app (Tauri shell in apps/desktop/src-tauri, React UI in apps/ui, daemon in packages/runtime): a persistent AI project manager. The owner-approved plan for this round is docs/status/handoff/NEXT-SESSION.md (read it first: phases A to H, the quality rules, the owner's decisions). Phases A, B and D are done; phase C (verification, continuity, github-result, research-web) is running right now in other worktrees and will merge into ${BRANCH} later. Do NOT touch the main checkout ${REPO} (another agent will merge there); never push; never open pull requests. Read AGENTS.md and docs/maintainers/validation.md.
Machine facts: 4 CPUs shared with the phase C agents, about 15 GB of disk free; no Docker daemon; no Claude API key; Playwright needs the local config (/tmp/frbench/pw-local.config.template.ts copied to apps/ui/playwright.local.config.ts, never committed). Never kill processes by name pattern; stop only PIDs you started. For cargo use CARGO_TARGET_DIR=/tmp/frbench/cargo-target.
`

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    spec_path: { type: 'string' },
    counts: { type: 'object', properties: { input: { type: 'number' }, already_fixed: { type: 'number' }, owned_by_phase_c: { type: 'number' }, duplicates: { type: 'number' }, real: { type: 'number' }, polish: { type: 'number' }, out_of_scope: { type: 'number' } } },
    areas: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, items: { type: 'number' } }, required: ['key', 'title', 'items'] } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['spec_path', 'counts', 'areas'],
}

const F2_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head_sha: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    windows_job: { type: 'string', description: 'what it does, step by step, and how each assertion is made' },
    linux_docker_job: { type: 'string' },
    validated_here: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    not_validated: { type: 'array', items: { type: 'string' }, description: 'what can only be proven by a GitHub run after the merge, and what to look at in that run' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head_sha', 'commits', 'windows_job', 'linux_docker_job', 'validated_here', 'not_validated'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix-needed'] },
    blocking: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' } }, required: ['issue', 'evidence', 'expected'] } },
    non_blocking: { type: 'array', items: { type: 'string' } },
    what_i_checked: { type: 'string' },
  },
  required: ['verdict', 'blocking', 'what_i_checked'],
}

const triagePrompt = `${CONTEXT}
Your job (read-only on the code; write only under /tmp/frbench): turn the leftovers list into a phase E spec.

Input: /tmp/frbench/handoffs.json, key "later" (about 100 items gathered from three fix waves, the live-model walks and reviews; some duplicate each other, some are already fixed, some belong to phase C). Also read the phase C spec /tmp/frbench/phaseC.json (its four areas own their items: do not duplicate them into E) and the live reports in docs/status/handoff/round-2026-11-01/live-reports/.

For EVERY item: check it against the current code on ${BRANCH} (git show/grep in ${REPO}, read-only, or a detached worktree of your own) and decide one of: already_fixed (say which commit or file shows it), owned_by_phase_c (which area), duplicate (of which item), out_of_scope (voice, email, phone, extensions, GitHub Projects mirror, peers/teams, cloud runner: the plan's out-of-scope list), real (misleads, blocks, contradicts, or is untrue for a person), or polish. Group the real and polish items into 3 to 5 fix areas with clear file ownership (like phase C's spec: key, title, problems with the item's words and evidence, root_causes with file:line where you found them, fix_scope, files, acceptance on the bench with the stand-in, depends_on), real problems first in each area, and one 'polish' area that batches the small wording/layout items. Write the spec to /tmp/frbench/phaseE.json in the same format as /tmp/frbench/phaseC.json (headline, areas, parallel_groups, shared_files), plus a top-level "triage" array with every input item and its decision. Report the counts and areas.`

const f2Prompt = `${CONTEXT}
Your job: phase F2 of the plan, built on a branch of your own, NOT merged: two GitHub Actions checks that close gaps no local test can.

Set up: you are in a fresh git worktree. \`git checkout -b fix/f2-ci-checks\` from ${BRANCH}'s tip. \`pnpm install --frozen-lockfile\`.

1. The real desktop window on Windows. Every walk so far drove the UI in Chromium; the desktop shell opens links, files and windows its own way (the owner's complaint 1, "Clicking PR does nothing", was a shell-only bug; apps/desktop/src-tauri/src/windows.rs on_navigation; the Open folder command in src/folder.rs). .github/workflows/desktop.yml already builds the MSI and runs scripts/installed-check.ps1 (installs it, starts it with --self-test, waits for /health). Add a step (or job) on windows-latest that: installs the MSI; starts the installed app the way a person does but with WebView2 remote debugging (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>) and its daemon on the stand-in model (find how the shell starts the daemon and how a provider is chosen; the bench uses \`--provider bench\`; if the shell has no way to pass that, add the smallest, safe, documented switch, e.g. an environment variable the shell forwards only when set, with a cargo test); drives the window over Chrome DevTools Protocol (reuse apps/mobile/e2e/cdp.mjs, the raw CDP client the Android emulator job uses) through the core journey: skip or finish setup, New project with a one-line brief, the plan card, Approve and start, the session ending, the Tasks tab; then clicks a PR link and an external link and Open folder, and asserts what the SHELL did (it must not navigate the window away; it must hand the URL to the system browser and the folder to the file manager: find or add a log line or test hook in the shell that records each hand-off, and assert on it). For the PR link a task needs a PR: use the fake git host from testenv/src/githost if it can run on the runner, or seed a task with a prUrl through the daemon API. Save screenshots (CDP Page.captureScreenshot) as artifacts.
2. A full-review task in the real Docker sandbox on Linux. The owner's PC has Docker, so tasks that need a full review will run in the sandbox there, and nobody has run that path end to end (packages/runtime/test/sandbox.integration.test.ts covers only the adapter). Add a job on ubuntu-latest (Docker with Linux containers is available there): build the runner image the sandbox expects (find its name and Dockerfile from the sandbox readiness code: e.g. forerunner-runner:local), start the daemon on the stand-in model, create a project and a task at the full-review level, start a session, and assert the task ran in the container (sandbox logs or the run record), the critic reviewed it, the files landed in the project folder, and the container was removed afterwards.

Write each driver as a script under scripts/ (Node, ESM, no new dependencies unless unavoidable) with unit tests for its pure parts (vitest, like scripts/*.test.ts), document both in docs/maintainers/testing.md (and the shell change, if any, in the desktop maintainer doc), and keep the jobs' total time reasonable (they run on every push: if long, run them on push to the round branch and on workflow_dispatch only, and say so). Validate what you can here: the scripts' unit tests, \`pnpm check\` (lint, typecheck, docs check with DOCS_CHECK_BASE=origin/${BRANCH}), actionlint or a YAML parse of the workflow files, cargo fmt/clippy/test if you change the shell. List precisely what only a GitHub run can prove and what to look for in that run. Commit with messages \`ci: …\` / \`desktop: …\` ending with:
${TRAILER}
Every commit signed (check \`git cat-file commit HEAD | grep -c '^gpgsig'\`). Never push.`

const triageReviewPrompt = (t) => `${CONTEXT}
You independently check a triage of the leftovers list (read-only on the code). The triage report: ${JSON.stringify(t).slice(0, 6000)}. The spec is /tmp/frbench/phaseE.json (its "triage" array has each input item's decision). Pick at least 25 items across all decisions (every 'already_fixed' and 'out_of_scope' item that sounds important, plus a sample of the rest) and verify each decision against the current code on ${BRANCH} in ${REPO} (read-only). A blocking finding is: a real problem marked already_fixed/duplicate/out_of_scope wrongly, a person-visible problem that ended in polish when it misleads or blocks, a phase C item duplicated into E, or an area whose acceptance cannot be walked on the bench. Report the verdict; if fix-needed, also correct /tmp/frbench/phaseE.json yourself (keep a copy as /tmp/frbench/phaseE.before-review.json) and list what you changed.`

const f2ReviewPrompt = (f) => `${CONTEXT}
You independently review branch fix/f2-ci-checks (you did not write it). In your own worktree: \`git checkout --detach fix/f2-ci-checks\`. The builder's report: ${JSON.stringify(f).slice(0, 8000)}.
Check: the workflow YAML is valid and the jobs would run on the stated runners (actionlint if available, else a careful read); every assertion actually tests what it claims (a step that cannot fail is a blocking finding); the shell change, if any, is safe (cannot be triggered by a web page, does not weaken the shell's navigation rules) and tested; the CDP driver handles timeouts with clear messages and always saves screenshots and logs as artifacts; the Docker job really runs a full-review task in a container (not the process sandbox) and checks it; nothing leaks secrets into logs or artifacts; no test was weakened; docs updated; \`pnpm check\` passes in your worktree. If fix-needed, fix the blocking findings yourself on the branch (\`git checkout fix/f2-ci-checks\`, signed commits with the trailer below, never push) and report what you changed.
${TRAILER}`

const results = await parallel([
  async () => {
    const t = await agent(triagePrompt, { label: 'triage:E', phase: 'Triage E', schema: TRIAGE_SCHEMA })
    if (!t) return { triage: null }
    const r = await agent(triageReviewPrompt(t), { label: 'review:triage', phase: 'Review', schema: REVIEW_SCHEMA })
    return { triage: t, review: r }
  },
  async () => {
    const f = await agent(f2Prompt, { label: 'build:F2', phase: 'Build F2', schema: F2_SCHEMA, isolation: 'worktree' })
    if (!f) return { f2: null }
    const r = await agent(f2ReviewPrompt(f), { label: 'review:F2', phase: 'Review', schema: REVIEW_SCHEMA, isolation: 'worktree' })
    return { f2: f, review: r }
  },
])
return { e: results[0], f2: results[1] }
