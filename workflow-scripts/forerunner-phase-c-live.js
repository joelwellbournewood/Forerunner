export const meta = {
  name: 'forerunner-phase-c-live',
  description: 'Confirm phase C (verification, continuity, github-result, research-web) with the real model on a live bench at 193e579: run each area\'s LIVE CHECK steps as a person would, report what holds and what does not (no code changes)',
  phases: [{ title: 'Live', detail: 'two walkers, own benches, USD cap each' }],
}

const REPO = '/home/user/Forerunner'
const HEAD = '193e579'

const COMMON = `
Context: Forerunner (main checkout ${REPO}, branch claude/nifty-knuth-f9udt0) is a desktop app: a persistent AI project manager (React UI in apps/ui, daemon in packages/runtime). Phase C was merged at ${HEAD}; its fixes were tested on the stand-in model only. You confirm them with the REAL model, as a person uses the app. You do not change any code. Work in a fresh worktree of ${HEAD}: you run with isolation 'worktree'; \`git checkout --detach ${HEAD}\` and \`pnpm install --frozen-lockfile\` first (never touch the main checkout).

The bench (read scripts/bench/README.md first): \`node scripts/bench/start.mjs --name <n> --daemon-port <p> --ui-port <q> --fresh --provider bench-live\` starts a daemon on a fresh home plus the UI; drive the UI with Playwright (scripts/bench/recorder.cjs and journeys/*.cjs show how; screenshots into your own steps folder); \`node scripts/bench/stop.mjs --name <n>\` stops it. <home>/bench/model-calls.jsonl logs every model call.

Rules you must keep:
- Real model: pass the key ONLY as a prefix on the start command: \`ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node scripts/bench/start.mjs ... --provider bench-live\`. Never print, echo, log, write to a file or commit the key or any token; never put it in a screenshot. Check a variable only with \`test -n "$NAME"\`. The environment's GH_TOKEN, GITHUB_TOKEN and ANTHROPIC_BASE_URL must not be used for the app.
- Money: your cap is below. Run \`node scripts/bench/calls.mjs --name <n> --cap <usd>\` after each step that calls the model; when it exits 3, stop spending and report what you could not check.
- GitHub (only if your checks need it): only the repository joelwellbournewood/forerunner-sandbox, with the token in FORERUNNER_TEST_GITHUB_TOKEN typed into the app's own UI by your Playwright script from process.env (never shown in a screenshot, never printed). Never create, rename or delete repositories; never touch any other repository. Read GitHub state with the GitHub MCP tools (ToolSearch "github pull request") on forerunner-sandbox only.
- Never kill processes by name pattern; stop benches with stop.mjs, other processes by PID. When done, stop your bench and delete its home and browser profile.
- 4 CPUs are shared with other agents; be patient with timeouts.

What to check: /tmp/frbench/phaseC-live-checks.json holds, per area, each fix's LIVE CHECK steps (what to do and what is expected). /tmp/frbench/phaseC-result.json has the full reports (areas[].fix/fixup: fixed[].problem/how/check_in_the_app; merge.problems_left says one continuity live check changed: since ADR 0107 a researcher on an API key runs, so check the "could not run" card with a plan task naming a specialist the install does not have, or another refusal that still exists). Walk each as a person: through the UI wherever a person would (New project from a brief, Approve and start, Inbox answers, task drawer, Stop/Cancel), reading model-calls.jsonl and the files on disk only as evidence. Several checks can share one project to save money; say which.

For each check: held | did-not-hold | could-not-check, with evidence (screenshot paths, call-log lines by number, file contents, what the screen said). For each did-not-hold, a finding: what a person meets, evidence, expected, severity (major | minor | polish), the phase C area it belongs to. Also report anything else wrong a person would meet on the way (same format), and the USD spent. Write a short markdown report to /tmp/frbench/live-reports/phaseC-<your label>.md.
`

const REPORT = {
  type: 'object',
  properties: {
    checks: { type: 'array', items: { type: 'object', properties: { area: { type: 'string' }, check: { type: 'string' }, result: { type: 'string', enum: ['held', 'did-not-hold', 'could-not-check'] }, evidence: { type: 'string' } }, required: ['area', 'check', 'result', 'evidence'] } },
    findings: { type: 'array', items: { type: 'object', properties: { problem: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor', 'polish'] }, area: { type: 'string' } }, required: ['problem', 'evidence', 'expected', 'severity', 'area'] } },
    usd_spent: { type: 'number' },
    report_file: { type: 'string' },
    not_checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['checks', 'findings', 'usd_spent', 'report_file', 'not_checked'],
}

const WALKERS = [
  { label: 'verification-continuity', areas: 'verification and continuity', cap: 1.6, name: 'livec-a', dport: 48700, uport: 2300 },
  { label: 'github-research', areas: 'github-result and research-web', cap: 1.4, name: 'livec-b', dport: 48710, uport: 2310 },
]

phase('Live')
const results = await parallel(WALKERS.map(w => () => agent(`${COMMON}
Your areas: ${w.areas} (every LIVE CHECK of these areas in /tmp/frbench/phaseC-live-checks.json). Your bench: --name ${w.name} --daemon-port ${w.dport} --ui-port ${w.uport} (a second bench, if you need one, uses the next ports up and the name ${w.name}2). Your cap: USD ${w.cap} in total. Your report file: /tmp/frbench/live-reports/phaseC-${w.label}.md.`, { label: `live:${w.label}`, phase: 'Live', isolation: 'worktree', schema: REPORT })))

return { results }
