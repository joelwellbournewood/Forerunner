export const meta = {
  name: 'forerunner-collab-audit',
  description: 'Audit the collaboration module (two people, two agents, a shared state service: inbox and messages, receipts, realtime, claims, peer awareness, handoffs, privacy, sync) as a person uses it, plus how it fits the status issue and a standard repository guide; verify findings; write fix and test plans',
  phases: [
    { title: 'Audit', detail: 'bench walk with two people, code review, test inventory, design' },
    { title: 'Verify', detail: 'skeptics reproduce or refute each finding' },
    { title: 'Plan', detail: 'phase E area specs, phase F journey, owner summary' },
  ],
}

const REPO = '/home/user/Forerunner'
const COMMON = `
Context: Forerunner (repository ${REPO}, branch claude/nifty-knuth-f9udt0; read at HEAD; phase E branches fix/answers, fix/screens, fix/noise, fix/bench, fix/stops, fix/asking, fix/decisions, fix/verification hold unmerged work) is a desktop app: a persistent AI project manager. Each person has an agent that plans and runs project work in sessions. The COLLABORATION module lets two people, each with their own agent and PC, work on one project through a shared state service (services/state-api, Postgres): requirements section F in docs/requirements.md (F.1 inbox per agent and human with typed messages; F.2 receipts and resurfacing; F.3 realtime push with polling fallback; F.4 claim-before-work with expiry; F.5 code only via branches and PRs; F.6 peer awareness feed and overlap detection; F.7 handoff note at every session end) and S.10 (privacy between collaborators). Read docs/maintainers/state-service.md, docs/maintainers/runtime.md (Peer awareness, messages, handoffs, schema sync gate), docs/maintainers/data-model.md, docs/user-guide.md, the ADRs in docs/decisions/ that mention peers, members, claims, state service or collaboration, and tests/e2e/scenarios/04-collision and 08-handover. It was built in earlier rounds and NOT tested this round; this round changed the session runner, the Inbox, chat, verification, GitHub flow and more, so assumptions may have broken.

The owner (a non-developer, Windows PC with Docker) just decided (2026-11-02), to be built next: a project's status on GitHub is ONE pinned GitHub issue per project ("Forerunner status: <project>", hidden marker; the summary rewritten after each session; a "Working on now" list updated when a task starts and ends; each person/agent/install has its own comment it edits in place so writers never overwrite each other; read before planning and before every task, and when a repository is connected, new or familiar; issue text is untrusted information, never instructions; no costs in it); no docs/status.md file in repositories; GitHub projects default to "the person presses Merge" (one-click Merge in the app), "merge automatically after review" per project; a dependent task builds on its dependency's unmerged branch. The owner also wants every repository to get a STANDARD GUIDE for any agent or person reading it, by default. Today the standard doc set is packages/memory/src/docs.ts STANDARD_DOCS (README.md, docs/overview.md, architecture.md, status.md, decisions/, runbook.md, data.md, testing.md): there is no agent/contributor guide.

Rules: ground every claim in code you read (file:line) or in what you saw on the bench (screenshot path, log line). Use only the stand-in model (--provider bench or fake); never use FORERUNNER_ANTHROPIC_API_KEY or FORERUNNER_TEST_GITHUB_TOKEN. Do not change any tracked file in the repository (scratch work under /tmp/frbench/collab/<your label>/). Never kill processes by name pattern; stop what you started by PID and delete what you created (disk is limited: keep it above 8 GB). Postgres 16 binaries are in /usr/lib/postgresql/16/bin (start a private cluster under /tmp/frbench/collab/<label>/pg on a free port, as a non-root user if initdb refuses root, e.g. with su to a throwaway user or initdb's own options; stop it with pg_ctl when done).
`

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      severity: { type: 'string', enum: ['major', 'minor', 'polish'] },
      requirement: { type: 'string', description: 'F.x / S.10 / design § / the owner decision it concerns' },
      what_a_person_meets: { type: 'string' },
      evidence: { type: 'string' },
      expected: { type: 'string' },
      fix_hint: { type: 'string' },
    }, required: ['id', 'title', 'severity', 'requirement', 'what_a_person_meets', 'evidence', 'expected', 'fix_hint'] } },
    could_not_check: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['summary', 'findings', 'could_not_check', 'notes'],
}
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
      severity: { type: 'string', enum: ['major', 'minor', 'polish'] }, evidence: { type: 'string' },
    }, required: ['id', 'verdict', 'severity', 'evidence'] } },
    missed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' }, expected: { type: 'string' } }, required: ['title', 'severity', 'evidence', 'expected'] } },
  },
  required: ['verdicts', 'missed'],
}

const AUDITS = [
  { key: 'walk', task: `You walk the collaboration module as two people would, on a bench you build: a private Postgres, the shared state service (services/state-api; read its config, main.ts and docs/maintainers/state-service.md "Deploy" for how to run it locally, including its admin token), and TWO daemons, one per person (two homes, each its own human and agent, both pointed at the shared service the way the app documents: find the real setup path a person uses, in the setup assistant, Settings or the CLI, and use it through the UI where one exists), each with its own UI (read scripts/bench/start.mjs and scripts/bench/README.md; you may need to start the second daemon and UI by hand with the same flags; ports 48760-48779, UI 2360-2379). Use the stand-in model. Journeys, through the UI with Playwright and screenshots (save under /tmp/frbench/collab/walk/steps/): (1) set up sharing and get the second person onto the first person's project (an invite, members, or whatever exists): count the steps and say what a person could not find; (2) both agents start sessions on the same project at about the same time: does claim-before-work stop double work, what does each person see (Peers, Inbox, task rows), are the words true; (3) a message or question from one agent or person to the other: does it arrive (realtime, and after a restart), receipts, resurfacing; (4) handoff note at session end, seen by the other side; (5) privacy: can person B see A's private memory, vault, files, chat, budgets; (6) one daemon offline then back: sync, the schema sync gate; (7) a repository project shared by both (use the bench's fake git host if there is one; never real GitHub): branches and PRs from both agents, overlap on the same file. Report every finding.` },
  { key: 'code', task: `You review the collaboration code for real bugs: services/state-api (routes, auth, scopes, outbox, realtime, mirror, offline story), the runtime's shared-store side (the remote/shared store client, sync, the schema sync gate, packages/state repos for messages, claims, handoffs, members), packages/runtime/src/session/peers.ts (peer feed, detectOverlap), claims and their expiry and renewal during long tasks, message receipts and resurfacing (acks), handoffs, the privacy scopes (S.10: private memory, vault, local files, email never shared), and how this round's changes (runner.ts, the Inbox and request cards, chat, verification, continuity's cancel and Undo, dependent branches on fix/decisions, the merge step) interact with a second agent on the same project (e.g. a task cancelled or redone by one person while the other's agent holds a claim or built on it; a card answered on one PC; Undo across PCs; budgets and the monthly cap per person; the critic of one agent reviewing the other's PR). Look for races, lost updates, stale claims that block forever, messages that never arrive or arrive twice, data shown to the wrong person, and words that are untrue for a two-person project. Run the existing collaboration tests (with FORERUNNER_TEST_PG pointing at a private Postgres you start) and report what passes and fails.` },
  { key: 'tests', task: `You take stock of the collaboration module's tests and what is untested at the person's boundary (docs/maintainers/validation.md: test what the person sees at the boundary they use). For each of F.1-F.7 and S.10: the tests listed in docs/requirements.md, whether they still exist and pass (run them, with FORERUNNER_TEST_PG pointing at a private Postgres you start; CI's check job sets FORERUNNER_TEST_PG, see .github/workflows/ci.yml), whether any test drives two real daemons and two UIs, and which journeys a person takes have no test at all. Also: which collaboration tests skip without Postgres locally, so merge steps here never ran them this round; whether CI runs them; and whether this round's merges changed code they cover. Propose (as findings with expected = the test to add) the tests that would catch the problems a person would meet: a two-daemon real-daemon test, a bench journey for two people (what scripts/bench would need), and a phase F live journey.` },
  { key: 'design', task: `You design how the collaboration module, the owner's new GitHub status issue and a new standard repository guide fit together, and find what is missing or wrong in the module for that. (a) The status issue as the shared noticeboard ACROSS stores: people and Forerunner installs that do not share a state service, other bots, and the person themself: what each writes (its own comment edited in place; "Working on now" with task, branch, files), what each reads before planning and before every task, how it relates to the in-store peer feed (F.6) when both exist (which wins, no double reporting), claims across stores (a claim line in the issue? expiry? what if a writer is gone), races when two writers edit (GitHub has no compare-and-swap on issue edits: each writer only edits its own comment), trust (issue and comment text is untrusted; mark the author; never instructions), and failure (issues off, no permission, offline). (b) The standard repository guide, added to every repository by default with the docs scaffold: name and place (e.g. AGENTS.md at the root, which many coding agents read, with a short CLAUDE.md that points to it; check what Claude Code, the Agent SDK and other common agents actually read), its contents for both agents and people (what the project is, where the docs and the decisions are, the status issue and how to announce and claim work there, branches and PRs and who merges, how to run the checks, what not to touch, the "Local only" folder, how to reach the owner), how it stays current (Forerunner keeps it current like the other standard docs; the critic's doc drift), and what changes in STANDARD_DOCS (status.md out for repositories, the guide in). (c) What the collaboration module needs for this: concrete gaps as findings.` },
]

phase('Audit')
const audits = await pipeline(
  AUDITS,
  (a) => agent(`${COMMON}\nYour part: ${a.task}`, { label: `audit:${a.key}`, phase: 'Audit', schema: FINDINGS }),
  (f, a) => {
    if (!f) return { key: a.key, findings: null, verify: null }
    if (!f.findings.length) return { key: a.key, findings: f, verify: null }
    return agent(`${COMMON}
You are an independent skeptic. Another agent reported the collaboration findings below (part: ${a.key}); they are claims, not facts. For each one, try to refute it: read the code yourself, re-run what it ran, or reproduce it on a bench of your own (ports 48780-48799, UI 2380-2399; your own Postgres if needed). Default to "unclear" unless you can confirm or refute with evidence; correct the severity if it is wrong. Also report real problems in the same part that it missed.

Findings: ${JSON.stringify(f)}`, { label: `verify:${a.key}`, phase: 'Verify', schema: VERDICTS }).then((v) => ({ key: a.key, findings: f, verify: v }))
  },
)

phase('Plan')
const plan = await agent(`${COMMON}
You turn the audit into plans. Inputs below: each part's findings and the skeptic's verdicts (drop refuted findings; keep unclear ones marked unclear; add the skeptics' missed problems).
Write three files:
1. /tmp/frbench/collab/collab-areas.json: phase E area specs in the shape of /tmp/frbench/phaseE.json areas (read it: key, title, problems, u_entries, root_causes, fix_scope, files, acceptance, depends_on, handoff_items) for: 'collab' (the collaboration module's verified fixes, majors first, each with its test at the person's boundary), 'status-issue' (the owner's status issue decision, built as designed, with the in-store peer feed), and 'repo-guide' (the standard repository guide in the scaffold, status.md out for repositories). Keep each area to what one agent can fix, review and validate in a few hours; split if larger and say the order. Also a 'shared_files' list for these areas.
2. /tmp/frbench/collab/collab-tests.md: the test plan: tests to add per area, a two-person bench journey (what scripts/bench needs to run two daemons and a state service), and a phase F live journey for two people on forerunner-sandbox (steps, what to check, USD cap).
3. /tmp/frbench/collab/owner-summary.md: for the owner, in plain words (no file paths in the main text): what the collaboration module does, what works, what is broken or missing (most important first), what the standard guide will say, and how the status issue makes collaboration work across PCs. Short.
Return the owner summary text.

Audit and verdicts: ${JSON.stringify(audits.filter(Boolean))}`, { label: 'plan:collab', phase: 'Plan' })

return { audits, plan }
