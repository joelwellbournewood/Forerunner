export const meta = {
  name: 'forerunner-phase-f',
  description: 'Phase F: independent final check. One fresh agent per journey walks the real app (real model where it matters), an independent verifier re-checks every finding, then a synthesis gives the owner a verdict per complaint and checklist step plus a fix spec',
  phases: [
    { title: 'Walk', detail: 'one fresh agent per journey, own worktree and bench, real model where it matters' },
    { title: 'Verify', detail: 'an independent agent reproduces or refutes each finding' },
    { title: 'Synthesize', detail: 'verdicts per owner complaint and checklist step, fix spec, what was not checked' },
  ],
}

const REPO = '/home/user/Forerunner'
const BRANCH = 'claude/nifty-knuth-f9udt0'
const HEAD = args && args.head ? args.head : BRANCH
const OUT = '/tmp/frbench/phaseF'

const COMPLAINTS = [
  '1. The PR link does nothing.',
  '2. Needs me / Mark failed / Cancel / Depends on are unclear.',
  '3. It is hard to interact with it dynamically.',
  '4. Many features do not work.',
  '5. Workflows get stuck.',
  '6. The "Not in this session" wall of text.',
  '7. Summaries are verbose.',
  '8. The chat knows nothing.',
]
const CHECKLIST = [
  '1. Remove the old install and its data, then install fresh (here: a fresh home and the setup assistant, as the installed app starts).',
  '2. A first project from a brief.',
  '3. Answer a question and see the work continue.',
  '4. Steer from chat; open the result and its PR in forerunner-sandbox.',
  '5. A task that needs Docker Desktop.',
  '6. Optional: the subscription (not testable here: no subscription login on this machine; say so).',
]

const COMMON = `
Context: Forerunner (repo ${REPO}, branch ${BRANCH}) is a desktop app: a persistent AI project manager that plans work from a brief, delegates tasks to specialist agents and has a critic review them; React UI in apps/ui, local daemon in packages/runtime, Tauri shell in apps/desktop/src-tauri. The owner's verdict before this round: it "boots up, but you can't really get a project into a workable state". This round fixed it in phases (fix waves 1-3, the live-model fixes, phase C: work that ends wrong or stuck, phase E: the leftovers sweep) and everything is merged into ${BRANCH}. This is phase F of the owner-approved plan (docs/status/handoff/NEXT-SESSION.md, read it first, especially 'Owner decisions of 2026-11-01'): the INDEPENDENT FINAL CHECK. You did not write any of the fixes. Your job is to find out, like a demanding person who just installed it and a QA engineer at once, whether a person can now go from a brief to finished work they can open, with the real model, without getting stuck or being told anything untrue.

The owner's 8 complaints:
${COMPLAINTS.join('\n')}
The owner's checklist (they will walk it on their Windows PC after this):
${CHECKLIST.join('\n')}

Read first: docs/design/core-experience.md (THE design target: screens, actions and their one-line explanations, states, session behaviour §4, writing rules §5), docs/decisions/0102-core-experience-round-decisions.md and the ADRs after it, scripts/bench/README.md (the bench: real daemon + real UI, a stand-in model with failure injection, live mode with the real model, the model-call log with USD, the recorder for Playwright), docs/user-guide.md.

Hard rules:
- Real model: start a live bench with the key passed ONLY as a prefix on the start command: \`ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node scripts/bench/start.mjs --name <n> ... --provider bench-live\`. Never print, echo, log, write to a file or commit the key or any token; never put it in a screenshot (do not screenshot a field while it shows a key). Check a variable only with \`test -n "$NAME"\`. The environment's GH_TOKEN, GITHUB_TOKEN and ANTHROPIC_BASE_URL must not be used for the app.
- Money: your journey has a USD cap (below). Check \`node scripts/bench/calls.mjs --name <n> --cap <usd>\` after each step that calls the model; stop spending when it exits 3, and report what you could not do.
- GitHub: only the repository joelwellbournewood/forerunner-sandbox, with the token in FORERUNNER_TEST_GITHUB_TOKEN typed into the app's own UI by your Playwright script from process.env (never shown in a screenshot, never printed). Never create, rename or delete repositories; never touch any other repository. To read GitHub state (the PR, its files, its checks), use the GitHub MCP tools (ToolSearch "github pull request") on forerunner-sandbox.
- Never push, commit to ${BRANCH}, or open pull requests on the Forerunner repository. Do not modify product code: you report, others fix.
- Processes: never kill by name pattern (pkill -f kills your own shell and other agents' benches). Stop only PIDs you started, or use scripts/bench/stop.mjs. One bench at a time; stop it and delete its home (/tmp/frbench/<n>/home, it holds a vault with the key) when you finish.
- Machine: 4 CPUs shared with one other agent; at most one bench and one browser per agent. Playwright: \`cp /tmp/frbench/pw-local.config.template.ts apps/ui/playwright.local.config.ts\` if you run the UI suite; for your own scripts require('playwright') works (NODE_PATH=$(npm root -g) outside the repo); chromium.launch() needs no options; never "playwright install".
- Disk is limited: any cargo command uses CARGO_TARGET_DIR=/tmp/frbench/cargo-target. Put your scripts and evidence under ${OUT}/<your journey>/ (not in the repo).
- Look at your screenshots with the Read tool: judge what a person SEES, not only the DOM. Quote system-written text verbatim. Measure: clicks needed, time, USD.
- For every problem: steps, expected (cite the design section), actual (verbatim), evidence paths, root cause with file:line when you can find it, severity (blocker: a person cannot finish the journey; major: they finish only with outside knowledge or are told something untrue; minor; polish). Name an existing U-entry from docs/status/UPDATE-LOG.md when it matches. Also report what works well: the owner needs a true picture, not only faults.
`

const WALK_SCHEMA = {
  type: 'object',
  properties: {
    journey: { type: 'string' },
    verdict: { type: 'string', description: 'three sentences at most: can a person do this journey today, and what stops them' },
    walkthrough: { type: 'string', description: 'what you did, step by step, with evidence paths, clicks, time and USD' },
    usd_spent: { type: 'number' },
    complaints: { type: 'array', items: { type: 'object', properties: {
      complaint: { type: 'integer', description: '1-8' },
      status: { type: 'string', enum: ['fixed', 'partly', 'not-fixed', 'not-reached'] },
      evidence: { type: 'string' },
    }, required: ['complaint', 'status', 'evidence'] } },
    checklist: { type: 'array', items: { type: 'object', properties: {
      step: { type: 'integer', description: '1-6' },
      status: { type: 'string', enum: ['passes', 'passes-with-problems', 'fails', 'not-testable-here'] },
      evidence: { type: 'string' },
    }, required: ['step', 'status', 'evidence'] } },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string', description: '<journey>-<n>' },
      title: { type: 'string', description: 'what the person sees, in plain words' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
      kind: { type: 'string', enum: ['broken', 'stuck', 'untrue', 'confusing', 'wrong-text', 'missing', 'slow-or-costly'] },
      needs_real_model: { type: 'boolean', description: 'true when it only shows with the real model' },
      steps: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
      root_cause: { type: 'string', description: 'file:line and why, or "unknown"' },
      suggested_fix: { type: 'string' },
    }, required: ['id', 'title', 'severity', 'kind', 'needs_real_model', 'actual', 'root_cause'] } },
    worked_well: { type: 'array', items: { type: 'string' } },
    not_checked: { type: 'array', items: { type: 'string' }, description: 'what this journey should have covered and did not, and why' },
  },
  required: ['journey', 'verdict', 'walkthrough', 'usd_spent', 'complaints', 'checklist', 'findings', 'worked_well', 'not_checked'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    journey: { type: 'string' },
    verdicts: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      verdict: { type: 'string', enum: ['confirmed', 'refuted', 'cannot-reproduce', 'confirmed-different-cause'] },
      how: { type: 'string', description: 'what you ran or read to decide, with evidence paths' },
      root_cause: { type: 'string', description: 'file:line, corrected if the walker was wrong' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'], description: 'your severity, which may differ' },
      fix_hint: { type: 'string' },
    }, required: ['id', 'verdict', 'how', 'root_cause', 'severity'] } },
    missed: { type: 'array', items: { type: 'string' }, description: 'problems you saw that the walker did not report, with evidence' },
    usd_spent: { type: 'number' },
  },
  required: ['journey', 'verdicts', 'missed', 'usd_spent'],
}

const JOURNEYS = [
  { key: 'first-run', cap: 2.5, title: 'A fresh install: setup with a key, a first project from a brief, the result opened, a small change',
    task: `Checklist steps 1 and 2; complaints 3, 4, 7. Start the daemon the way an installed app starts it: on a fresh home with NO key in its environment and the real provider (no stand-in), and the UI against it (read scripts/bench/start.mjs and packages/runtime/src/cli/main.ts; --provider none or a plain \`daemon\` start may be what you need; find the honest equivalent and say what you used). Walk the setup assistant as a person with an API key: your Playwright script types process.env.FORERUNNER_ANTHROPIC_API_KEY into the key field (no screenshot while the field shows it). Then New project from the one-line brief "A one-page website that shows today's date and a greeting that changes with the time of day", find and approve the plan, follow the work while it runs (what does the person see, is it true), find what was produced (Files tab, Open folder's path, the files on disk: open index.html in the browser and check it works), read the summary (length, truth). Then ask for a change from the project's chat: "make the greeting say good evening after 6 pm" and see it done. Count clicks; time each phase; USD from the app's Costs tab (no call log without bench-live).` },
  { key: 'answer-continue', cap: 2, title: 'Something needs the person: find it, answer it, the work continues by itself',
    task: `Checklist step 3; complaints 2 and 5. Live bench. Brief: "A one-page website for my bakery with its name, address and opening hours. Ask me for the bakery's name, address and opening hours before writing the page; do not invent them." Find out how the person learns that something needs them (header, Inbox, project page, notification), answer it in the Inbox, and see whether the work continues by itself to a finished page with your answers in it. Then add a second task from the UI that needs an answer and answer that one from the project's chat instead. Check every control a person meets on cards and task rows (the Needs me / Mark failed / Cancel / Depends on family the owner found unclear, whatever their names are now): does each say what it does in one line, and does it do that? Also: a task the critic sends back for rework (if the real model does not do it, use a stand-in bench with FORERUNNER_BENCH_CRITIC_REJECT and say so).` },
  { key: 'steer-chat', cap: 2, title: 'Steering from chat: the chat knows the project and its commands do what they say',
    task: `Checklist step 4 (the chat half); complaints 3 and 8. Live bench with a project that has finished work, a failed or stopped task and work still to do (build it honestly: a brief, Approve and start, then stop part-way or give a task that cannot succeed, e.g. "publish the site to my server" with no server). Ask the project's chat, and the shared conversation if separate: "what is going on in this project?", "what failed and why?", "what will you do next?", "add a task: write a FAQ page", "make the FAQ wait for the README", "skip the FAQ", "start working now", "stop", "summarise the last session", "where are the files?". For each: is the answer TRUE against the app's own state (check the daemon API), does a command do what it says, and is it short? Which phrases work without the model? Read the model-call log to see what context the chat model got.` },
  { key: 'github-pr', cap: 2.5, title: 'A project on a real GitHub repository: the work arrives as a pull request the person can open',
    task: `Checklist step 4 (the PR half); complaint 1. Live bench. Connect GitHub in the app's UI with FORERUNNER_TEST_GITHUB_TOKEN (typed by your script from process.env, never shown). Create a project on joelwellbournewood/forerunner-sandbox (link it the way the app offers) with the brief "Add a CONTRIBUTING.md and a small HTML page docs/index.html that links to it". Approve and start; follow the work to the end. Then: where does the person find the pull request(s) (Tasks tab, task drawer, Overview, Inbox)? Does every PR link point at the real PR URL (read it with the GitHub MCP tools: it exists, it has the files, it is open or merged as the app says)? Clicking it in the web UI must open the PR (a new tab or the system browser), never navigate the app away or do nothing (the shell's hand-off is checked in CI by scripts/desktop-window-check.mjs; read its latest result in the Desktop app workflow run if you can, and say what it showed). Is anything the app says about the repository, branches or merges untrue? Leave the PRs open; list their URLs.` },
  { key: 'docker-review', cap: 2, title: 'A task that needs the full review runs in a real Docker sandbox',
    task: `Checklist step 5. First, without any Docker engine reachable, see what a person is told for a task that needs the sandbox (tier 2 or above): is it true and does it say what to do (the owner's Windows PC has Docker Desktop)? Then start a private Docker engine the way the F2 builder did (no root daemon on the default socket; your own sockets and dirs under ${OUT}/docker-review/docker): \`dockerd --host unix://${OUT}/docker-review/docker/docker.sock --data-root ${OUT}/docker-review/docker/data --exec-root ${OUT}/docker-review/docker/exec --pidfile ${OUT}/docker-review/docker/docker.pid --iptables=false --ip6tables=false --bridge=none --storage-driver=vfs\` (background it; stop it by its pid file at the end and delete its data dir; vfs uses a lot of disk, so pull only a slim image, e.g. node:22-bookworm-slim from mirror.gcr.io/library/node, and tag it as the runner image the daemon expects; read scripts/sandbox-full-review.mjs and docs/maintainers/testing.md for how F2 did this). Point the bench's daemon at that engine (DOCKER_HOST via --env, FORERUNNER_SANDBOX_ENGINE=docker, FORERUNNER_RUNNER_IMAGE). Live bench: a project with a task the plan marks as needing the full review (or add one at tier 2: "Write src/slug.js that turns a title into a URL slug, with a test in test/slug.test.js, and run the test"). Follow it: does it run inside the container (docker events), does the critic review it at the full tier, does the person see "Reviewed and tried" or the owner's words for it (owner decision of 2026-11-01: no 'checks only' or tier words), with evidence they can open? Also answer for the owner's PC: which runner image does an INSTALLED app use, where does it come from, and can a person with Docker Desktop and no repository checkout get it (read packages/runtime/src/sandbox/, the sandbox-image CI job, the installer)? If not, that is a blocker for checklist step 5.` },
  { key: 'big-project', cap: 6, title: 'A larger real project: about 10 tasks, a real failure, a stop, a restart and a crash',
    task: `Complaints 4, 5 and 7. Live bench. Brief (or longer if the plan comes out small): "A small static website for a hiking club: a home page, a page listing five hikes with distance and difficulty, a page with the club's rules, a contact page with a form that only shows a thank-you message, a shared stylesheet, a navigation bar on every page, a README explaining how to open it, and a check that every internal link works. Also publish it to our club's FTP server." (the FTP part cannot succeed: no server or credentials, so a real failure). Approve and start. While the session runs: stop it from the UI part-way and continue; restart the daemon (\`node scripts/bench/restart-daemon.mjs --name <n>\`, then reconnect) during a run; later crash it (\`--hard\`) during a run and restart. After each: does the work continue by itself or with one obvious click, is any task stuck, are files lost or duplicated, does the app say anything untrue? At the end: are all doable tasks done and the site working (open it, click every link), and what does the person see about the failed FTP task (the true reason, what they can do)? Measure total clicks, time, USD, and the length of every summary.` },
  { key: 'api-errors', cap: 0.5, title: 'When the model is not reachable: bad key, no network, overloaded',
    task: `Complaints 4 and 5, and the D-phase leftover "real API errors". (a) A wrong key: on a fresh home, type a syntactically valid but wrong key (e.g. the real key's prefix + "x" x 20: never print either) into setup, and later into Settings for a working install: what does the person see, is it true, and does a later correct key make everything work again without leftovers? (b) No network to the model while work runs: find the app's supported way to point the provider elsewhere (a base URL setting, if any; NOT the environment's ANTHROPIC_BASE_URL) and use a closed local port, or stop the network another honest way; if there is no honest way, say so. (c) Overloaded / rate limited mid-session: a stand-in bench with FORERUNNER_BENCH_FAIL=<a task title substring> FORERUNNER_BENCH_FAIL_MODE=error (and FORERUNNER_BENCH_FAIL_TIMES=2 for a recovery). For each: what the person sees in the session page, the task, the Inbox and Home; whether the work resumes by itself when the problem goes away; whether a retry costs extra calls; whether anything stays stuck.` },
  { key: 'every-screen', cap: 1.5, title: 'Every screen and every word: after real work, is everything a person reads short, true and clear?',
    task: `Complaints 2, 6 and 7. Use a live bench for one small real project (cap 1 USD of your 1.5) so summaries and session texts are real, then a stand-in bench for the rest (failures via FORERUNNER_BENCH_FAIL, a rework via FORERUNNER_BENCH_CRITIC_REJECT, a question via FORERUNNER_BENCH_ASK). Visit EVERY screen in the main navigation and EVERY project tab, the session page, notifications, the command palette and Settings, in empty, running, finished and failed states. Collect verbatim every system-written text; judge each against design §5 (length, names not ids, no raw states or jargon, no USD where CHF is the person's currency, every sentence true now). Look specifically for the owner's "Not in this session" wall of text and anything like it, and for summaries longer than the design allows. Test the controls around running work: Start dialog, Stop all and Resume, stop from the session page, reload during a run. Report each problem text with where it is, verbatim, and the design rule it breaks.` },
]

phase('Walk')
const results = await pipeline(
  JOURNEYS,
  (j, _o, i) => agent(`${COMMON}
Your journey: "${j.title}". USD cap: ${j.cap}. Bench name "f-${j.key}", daemon port ${48600 + i}, UI port ${2200 + i}; use only these. Evidence under ${OUT}/${j.key}/.

You run in a fresh git worktree of ${HEAD}: \`git log --oneline -1\` (it must be the head of ${BRANCH}; if not, \`git checkout --detach ${BRANCH}\`), then \`pnpm install --frozen-lockfile\`, then start your bench from this worktree.

The journey:
${j.task}

Return verdicts for the complaints and checklist steps your journey reaches ('not-reached' / 'not-testable-here' for the rest), every finding, what worked well, and what you could not check.`, { label: `walk:${j.key}`, phase: 'Walk', isolation: 'worktree', schema: WALK_SCHEMA }),
  (walk, j, i) => {
    if (!walk) return null
    if (!walk.findings.length) return { key: j.key, walk, verify: null }
    return agent(`${COMMON}
You are an independent verifier for journey "${j.title}". A walker reported the findings below. Your job is to decide for EACH finding whether it is real: reproduce it (a stand-in bench is enough unless the finding needs_real_model; then you may spend up to USD 0.5 in total on a live bench, else judge from the walker's evidence, the model-call log and the code, and say which you did), check the root cause in the code (file:line), and correct the severity against the definitions (a finding the walker exaggerated is not a blocker; one they underrated is). Be adversarial in both directions: refute what does not hold, and add what the walker missed on the same screens. Bench name "fv-${j.key}", daemon port ${48620 + i}, UI port ${2220 + i}. You run in a fresh git worktree of ${HEAD} (\`pnpm install --frozen-lockfile\` first). Evidence under ${OUT}/${j.key}-verify/.

The walker's report:
${JSON.stringify(walk)}`, { label: `verify:${j.key}`, phase: 'Verify', isolation: 'worktree', schema: VERIFY_SCHEMA })
      .then((verify) => ({ key: j.key, walk, verify }))
  },
)

const done = results.filter(Boolean)
const missing = JOURNEYS.filter((j) => !done.find((r) => r.key === j.key)).map((j) => j.key)
if (missing.length) log(`No result for: ${missing.join(', ')}`)
const spent = done.reduce((n, r) => n + (r.walk.usd_spent || 0) + ((r.verify && r.verify.usd_spent) || 0), 0)
log(`${done.length}/${JOURNEYS.length} journeys walked; USD ${spent.toFixed(2)} on the model`)

phase('Synthesize')
const synthesis = await agent(`${COMMON}
You are the lead for the hand-over. Independent walkers walked the real app one journey each, and independent verifiers checked every finding. Their reports (walk + verify per journey) are below. ${missing.length ? `Journeys with no result: ${missing.join(', ')}; say so in not_checked.` : ''}

${JSON.stringify(done)}

Do four things, from the evidence only (a refuted finding is dropped; cannot-reproduce is kept only if the walker's evidence is strong, and marked so):
1. For each of the owner's 8 complaints and each checklist step: one status (fixed / partly / not-fixed; passes / passes-with-problems / fails / not-testable-here) with the decisive evidence, in plain words a non-engineer owner understands.
2. The confirmed problems, de-duplicated across journeys, ordered blockers first, as fix areas for one more fix wave in the format of /tmp/frbench/phaseE.json (key, title, problems with evidence, u_entries, root_causes with file:line, fix_scope, files, acceptance a fresh reviewer can walk on the bench, depends_on), plus parallel_groups and shared_files (which area owns each shared file). Areas must not overlap in files where you can avoid it; keep polish batched in one area. Write it to ${OUT}/phaseF-fix.json and return its path.
3. A completeness critique: what a person will do on the owner's PC that no journey covered (Windows specifics, the installer, Docker Desktop, the subscription, a project with an existing repository, very long sessions, ...), and how each can still be checked before the owner's walk (CI, a helper, the owner's checklist).
4. The owner's checklist as they should walk it on their PC: numbered steps with what to click and what they should see, written for a person, with the known problems they may meet marked.

Do not modify product code.`, {
  label: 'synthesize',
  phase: 'Synthesize',
  schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'five sentences at most for the owner: can a person now get a project into a workable state?' },
      complaints: { type: 'array', items: { type: 'object', properties: { complaint: { type: 'integer' }, status: { type: 'string' }, evidence: { type: 'string' } }, required: ['complaint', 'status', 'evidence'] } },
      checklist: { type: 'array', items: { type: 'object', properties: { step: { type: 'integer' }, status: { type: 'string' }, evidence: { type: 'string' } }, required: ['step', 'status', 'evidence'] } },
      fix_spec_path: { type: 'string' },
      counts: { type: 'object', properties: { blocker: { type: 'integer' }, major: { type: 'integer' }, minor: { type: 'integer' }, polish: { type: 'integer' }, refuted: { type: 'integer' } } },
      not_checked: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, how_to_check: { type: 'string' } }, required: ['what', 'how_to_check'] } },
      owner_checklist: { type: 'string' },
      usd_total: { type: 'number' },
    },
    required: ['headline', 'complaints', 'checklist', 'fix_spec_path', 'counts', 'not_checked', 'owner_checklist'],
  },
})

return { journeys: done, missing, usd: spent, synthesis }
