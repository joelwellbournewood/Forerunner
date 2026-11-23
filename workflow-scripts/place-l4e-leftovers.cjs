// Places run L4 sub-run L4e's leftovers (l4-github-link and l4-github-merge, merged and pushed at 7eaf59c).
// Most go into a NEW area, l4-github-carried, which runs in sub-run L4h after l4-chat-carried; the rest go to
// /tmp/frbench/leftovers-L4e.json. Idempotent: the area is rebuilt and triage items tagged "(L4e leftovers)" are replaced.
const fs = require("fs");
const TAG = "(L4e leftovers)";
const SRC =
  "Sources: /tmp/frbench/runL4-L4e-{fix,review,fixup}-l4-github-{link,merge}.json and runL4-L4e-merge.json (problems_left).";
const KEY = "l4-github-carried";

// [id, severity, text]. never: true marks a never-cut item.
const items = [
  ["L4-github-130", "minor, OWNER", true,
    "OWNER 2026-11-18 (owner-decisions-2026-11-09.md, answers of 2026-11-17, point 4, quoted): 'A cancelled task whose pull request is still open on GitHub: add a Close button. One press closes that pull request on GitHub (it can be reopened there); the Overview's 'Cancelled, still open on GitHub' list offers it beside Open.' Not built in L4e (l4-github-merge not_done, cut line). Build: Close beside Open on that row with its one-line consequence ('Closes this pull request on GitHub; you can reopen it there.'); a press route (the fixer's note: POST /projects/:id/pull-requests/:n/close, allowed only for a row of kind 'cancelled', with the project's own token); it closes only that pull request, never deletes its branch, and the row goes once GitHub answers; a refusal or a GitHub failure says so in one sentence and keeps the row; the fake daemon in step; amend ADR 0105 point 4 (dated). Tests: commands or route unit, real-daemon (press through the client, the row gone after GitHub answers, a restart case), the UI row with the button, the GitHub stand-in records exactly one close call and no branch delete."],
  ["L4e-left-1", "minor, words, owner default", true,
    "The take-over line shown when the docs pull request could not be opened ('Took over o/kite from \"Kite club\" here, but the docs pull request that names this project could not be opened, so GitHub still names \"Kite club\".') gives no next step (design section 5 rule 8); nothing in the app tries the pull request again. Build the owner-question default (owner_questions OQ-L4e-1): a Try again button beside the line on the Overview and Docs that runs the scaffold's own-branch push and pull request again (the L4-github-102 rules: own branch only, lease, never the default branch, never another project's open pull request), with its consequence line; the line goes when a pull request names this project. Name it in notes_for_other_areas so the owner's answer can change it in one place."],
  ["L4e-left-2", "minor, defect", true,
    "packages/capabilities/src/githost/pr-executor.ts taskBranchName keeps dots from a task title: 'Update yarn.lock' gives fr/<8>-update-yarn.lock and a title with '..' gives a name git refuses, so the task's push fails. Use the dots-to-dashes rule intakeDocsBranch and scaffoldBranchesOf now use (one shared helper); test with 'Wait... what' and 'Update yarn.lock' through the push stand-in (sibling found by the L4e merge)."],
  ["L4e-left-3", "minor, false promise", true,
    "A merged-through record whose change reached main through no named pull request (through null) keeps merge_sha null for good, so Take this work out always answers 'Forerunner is still reading where the change of #N reached main. Try again in a minute.', a promise the app never keeps. Settle the record (read the merge commit from main's history, or say in one sentence that the work cannot be taken out here and why) with a restart case."],
  ["L4-github-106", "minor, cut-able", false,
    "'Add to it' waits on 'Adding…' for the whole planning call (2.4 s on the bench, 10.5 s live) and the project page never shows 'Drafting the plan…'. POST /projects/:id/intake awaits rt.intake.propose(); 42 call sites in 5 test files read requestId from its synchronous answer, and a second brief while a plan is open must stay refused with 409. Prefer an additive route or an option (answer at once in 'drafting', plan in the background as POST /projects with intake: true does) so the existing callers keep their contract; the 409 refusal is kept and never recorded as 'Planning failed'. Evidence: /tmp/frbench/fix-l4-github-link-evidence/before/12-before-21-after-add-press.png."],
  ["L4e-left-4", "minor, session lead decision", false,
    "DocsTab shows any 'elsewhere' line, including OR-07's offer ('o/kite is also the Forerunner project ...') without its Take it over button, which repeats the Overview (design section 5 rule 10). Session lead decision (2026-11-23): Docs shows only the take-over outcome line (taken over, or the no-pull-request line with its Try again); OR-07's offer stays on the Overview with its button. This needs a view field that tells the two apart (api-types, client, contracts, fake daemon)."],
  ["L4e-left-5", "minor", false,
    "A take-over made with a brief (intake: true) defers its docs to the intake. If the intake's docs pull request then fails, the Overview says nothing, because scaffoldLeftNoMarker needs a scaffold record. Record the intake's push outcome on the project and show the same no-pull-request line (with L4e-left-1's Try again); a composed test with a host refusal."],
  ["L4-github-124 (b)(c)", "words, minor", false,
    "(b) the cancelled block's words are plural for one pull request; (c) a pull request rebuilt without its dependency is still listed under 'Reviewed by the critic'. Exact-text and view tests."],
  ["L4e-left-6", "minor", false,
    "After A was closed and its change reached main through #6, the Overview's Last result reads 'Since then: merged #2 and #6.' and chat's facts list #2 among the merged pull requests. mergedSinceLine (packages/runtime/src/daemon/views.ts) and repositoryFacts do not know the merged_through state; say it ('#2's change reached main through #6') or count only #6."],
  ["L4e-left-7", "minor, money words", false,
    "A paused run that no run has continued yet reads as one try ('0 / 1 (0%)') on Costs while its Continue card waits; and with a period, Costs takes a known task's runs from runs created inside the period, so a run started before it and billed inside it reads runs 0 next to a cost (views.ts taskRunFacts and costFacts). One rule for tries and runs, asserted on GET /costs with and without a period."],
  ["L4e-left-8", "words", false,
    "The joined project's Last result keeps the stored 'Left 5 reviewed pull requests for you to merge.' after the join moved them; and joinRefusedHeldStart says 'starts by itself soon', which is untrue when quiet hours hold the start for hours (say when, or 'waits to start by itself' as before)."],
  ["L4e-left-9", "tests", false,
    "Real-daemon cases the L4e areas left: the 'Take this work out' press through the Inbox for a merged-through task (L4-github-112), L4-github-122's acceptance case, the Redo-after-join count (L4-github-116), and a watcher test for a cancelled task's pull request that is merged on GitHub (mergedOnHost: record merged, merge.merged fires, dependents rebuilt)."],
  ["L4c-left-4", "words, UI", false,
    "'Waiting for you: approve the plan' shows twice after Add to (ProjectPage planBanner and IntakeBanner). Show it once; a UI test of the project page after Add to."],
  ["L4e-left-10", "minor", false,
    "A GitHub Enterprise install still accepts github.com links (repoHostsFor's default gitRemoteBase), and the fake daemon's data import mirrors only the in-use refusal, not other_host. Also: Shell.tsx shows an empty header name when GET /projects/:id fails for an archived project, and markerNameOf cuts the marker name at 60 characters mid-word in the offer's first sentence (cut at a word with an ellipsis)."],
  ["L4e-left-11", "bench", false,
    "Bench walks before and after for these items with screenshots (the L4e GitHub areas recorded none for the merge path): the Close press on a cancelled task's open pull request, Try again on the no-pull-request line, a task titled 'Update yarn.lock' pushing its branch, and Add to showing 'Drafting the plan…'."],
];

const area = {
  key: KEY,
  title:
    "Run L4 sub-run L4e's GitHub leftovers close: the owner's Close button for a cancelled task's pull request still open on GitHub, a Try again for a take-over whose docs pull request did not open, task branches git accepts, a take-out that never promises what it cannot do, Add to that plans in the background, and the words and tests the two GitHub areas left",
  problems: items.map(([id, sev, never, text]) => `[${sev}${never ? ", never cut" : ""}] ${id}: ${text} ${TAG} ${SRC}`),
  decisions: [
    "OWNER 2026-11-18 (quoted in L4-github-130): add a Close button; one press closes that pull request on GitHub (it can be reopened there); the Overview's 'Cancelled, still open on GitHub' list offers it beside Open. Forerunner still never closes or merges a pull request by itself (ADR 0105): only the person's press.",
    "Owner question OQ-L4e-1 (open): what the no-pull-request take-over line offers. Default built until answered: a Try again button, in one place so the answer can change it.",
    "Session lead decision 2026-11-23 (L4e-left-4): the Docs tab shows only the take-over outcome line; OR-07's offer stays on the Overview with its Take it over button.",
    "Every write to GitHub in this area is the person's press (Close, Try again); never a force-push over a branch that is not this project's own, never a write to another project's open pull request, never a branch delete.",
  ],
  u_entries: [
    "U-091 (one repository, one project; the take-over): L4e-left-1's Try again, L4e-left-4's Docs line, L4e-left-5.",
    "The cancel-takes-work-out entry (ADR 0105): L4-github-130's Close button, with its Check in the app step.",
  ],
  root_causes: [
    "No close route or button for the 'Cancelled, still open on GitHub' row (ADR 0105 point 4, amended 2026-11-15).",
    "packages/runtime/src/daemon/docs-scaffold.ts and the Overview/Docs views: scaffoldLeftNoMarker has no action; nothing retries the scaffold's push.",
    "packages/capabilities/src/githost/pr-executor.ts taskBranchName: safeSegment allows dots.",
    "packages/runtime/src/loop/take-out.ts with the merged_through record: merge_sha stays null when through is null.",
    "packages/runtime/src/daemon/server.ts POST /projects/:id/intake awaits rt.intake.propose() (L4-github-106).",
    "packages/runtime/src/daemon/views.ts mergedSinceLine, repositoryFacts, taskRunFacts and costFacts (L4e-left-6, -7).",
  ],
  fix_scope:
    "Run L4 area l4-github-carried, sub-run L4h (wave 32), after l4-chat-carried in the same sub-run, base: the merge of sub-run L4g. It builds on l4-github-link and l4-github-merge (merged at 7eaf59c): their regions in docs-scaffold.ts, pull-requests.ts, take-out.ts, views.ts, pr-executor.ts, the Overview, Docs and the fake daemon are re-found and kept. Read runL4-L4e-merge.json and both areas' fix, review and fixup reports first.",
  files: [
    "packages/runtime/src/daemon/pull-requests.ts and server.ts (the Close route; L4-github-106's additive route or option).",
    "packages/capabilities/src/githost/* (close a pull request with the project's own token; taskBranchName).",
    "packages/runtime/src/daemon/docs-scaffold.ts (Try again; the intake's push outcome, L4e-left-5).",
    "packages/runtime/src/loop/take-out.ts (L4e-left-3).",
    "packages/runtime/src/daemon/views.ts (L4e-left-6, -7, -8; the Docs view field of L4e-left-4).",
    "apps/ui: the Overview's cancelled list, DocsTab, ProjectPage banners, NewProjectDialog (Add to), Shell.tsx; apps/ui/src/api (client, api-types) and the fake daemon.",
    "docs/decisions/0105-*.md and 0117-*.md (dated amendments), docs/maintainers (runtime.md, apps.md, testing.md), docs/user-guide.md.",
  ],
  acceptance: [
    "L4-github-130 (never cut): Close beside Open on the 'Cancelled, still open on GitHub' row; one press closes exactly that pull request on GitHub (stand-in records one close call, no branch delete); the row goes once GitHub answers, also after a restart; a refusal or failure says so in one sentence and keeps the row; exact-text tests of the consequence line; real-daemon and UI cases; ADR 0105 amended.",
    "L4e-left-1 (never cut): the no-pull-request line has Try again on the Overview and Docs; the press pushes only this project's own branch and opens one pull request; the line goes when a pull request names the project; composed test with a refused first push and a working second.",
    "L4e-left-2 (never cut): task titles with dots give branch names git accepts (one shared helper with intakeDocsBranch and scaffoldBranchesOf).",
    "L4e-left-3 (never cut): no 'Try again in a minute' that can never succeed; restart case.",
    "The rest: each item with its failing test first, or in not_done with the reason; exact text for every new sentence (design section 5).",
  ],
  depends_on: [
    "Base: the merge of sub-run L4g. Runs in L4h after l4-chat-carried (sequential).",
    "Built on l4-github-link and l4-github-merge (L4e, 7eaf59c).",
  ],
  handoff_items: items.map(([id]) => id),
  owner_questions: ["OQ-L4e-1"],
  size:
    "Medium: 15 items. Larger: L4-github-130 (a GitHub write the person presses, through route, client, fake, UI and ADR), L4e-left-1 (Try again with the scaffold's push rules), L4-github-106 (Add to in the background without breaking the route's callers). The rest are one function, one sentence or one test each. Cut line, may end in not_done with the evidence: L4-github-106, L4e-left-4, -5, -6, -7, -8, -9, -10, -11, L4c-left-4 and L4-github-124 (b)(c). Never in not_done: L4-github-130 (the owner's decision), L4e-left-1 (the default of OQ-L4e-1), L4e-left-2 (a push git refuses) and L4e-left-3 (a promise the app never keeps), and every security and money rule.",
  sub_run: "L4h",
  wave: 32,
  items: items.map(([id]) => id),
  counts: { items: items.length, major: 0, minor: items.length, words: 0, blocker: 0 },
};

const oq = {
  id: "OQ-L4e-1",
  area: KEY,
  question:
    "When Forerunner takes over a repository but cannot open the pull request that updates the docs to name the new project, the app says so and offers nothing. What should it offer?",
  default: "A Try again button beside the line on the Overview and Docs, which tries opening the pull request again.",
  asked: "2026-11-23 (session status, and the dashboard's 'For the owner' panel)",
};

const rest = {
  why: "Run L4 sub-run L4e's leftovers that no run L4 area takes: by design, rare, or for the final check.",
  base: "7eaf59c",
  items: [
    { id: "L4e-rest-1", severity: "by design", text: "A dependency merged on GitHub (not closed) shortly before the Merge press reads 'waiting for you to merge' until the watcher's next poll: settling it at the press would start the merge's listeners (copy refresh, card closing, rebuilds of other dependents) without the person's press." },
    { id: "L4e-rest-2", severity: "by design", text: "After Undo of a take-over, the removed project's docs pull request stays open on GitHub; the next Take it over opens a second one (run C decision 14). The person could merge the wrong one." },
    { id: "L4e-rest-3", severity: "rare", text: "rebuildForTakeOver writes the branch's version of every file the branch changed since its merge-base; if main later changed the same file, main's newer version is replaced." },
    { id: "L4e-rest-4", severity: "unlikely", text: "Two concurrent first-plan POSTs are not refused atomically (pendingFor is checked before the model call)." },
    { id: "L4e-rest-5", severity: "tests", text: "The writing-rules possessive sweep only catches the `\"${x}\"'s` and `quoted(...)}'s` forms." },
    { id: "L4e-rest-6", severity: "follows BA-9/OJ-07", text: "By specialist and By model of the kept project are empty for moved tasks after a join (the project's own ledger)." },
  ],
  for_session_lead: {
    ci_check: "Check that CI runs 'l4-github-merge, run L4: project.join on Postgres (L4-github-121)' on Linux and Windows and that it does not skip.",
    live_checks_for_F: [
      "Real GitHub (forerunner-sandbox): Take it over on a repository with an old fr/docs-scaffold branch of a closed pull request whose marker names another project, main naming 'Kite club': exactly one new open pull request on fr/docs-scaffold-<name>, started from main; the Overview lists it as 'The project's standard docs'.",
      "The check_in_the_app steps of L4-github-101 to -105, -112 to -125 in runL4-L4e-fix-l4-github-{link,merge}.json, on real GitHub.",
    ],
  },
};

for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  d.areas = d.areas.filter((x) => x.key !== KEY);
  d.areas.push(JSON.parse(JSON.stringify(area)));
  if (P.endsWith("runL4-plan.json")) {
    const s = d.sub_runs.find((x) => x.name === "L4h");
    if (!s.keys.includes(KEY)) s.keys.push(KEY);
    const add = " Then l4-github-carried (added 2026-11-23 after L4e): run L4 sub-run L4e's GitHub leftovers, with the owner's Close button (L4-github-130, never cut); it runs after l4-chat-carried in the same sub-run and touches GitHub files only that area does not.";
    if (!s.note.includes("l4-github-carried")) s.note += add;
    d.owner_questions = (d.owner_questions || []).filter((q) => q.id !== oq.id);
    d.owner_questions.push(oq);
    if (Array.isArray(d.merge_order) && !d.merge_order.includes(KEY)) d.merge_order.push(KEY);
  }
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
    for (const [id, sev, never, text] of items)
      d.triage.push({ n: id, item: `${id}: ${text}`, decision: "fix", area: KEY, evidence: SRC, note: `${TAG}${never ? " never cut" : ""}` });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4e.json", JSON.stringify(rest, null, 1));
console.log("area", KEY, "items", items.length, "; rest", rest.items.length);
