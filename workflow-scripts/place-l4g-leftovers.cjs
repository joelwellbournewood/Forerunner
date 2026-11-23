// Places run L4 sub-run L4g's leftovers (l4-starts-sessions, merged and pushed at 3e1ab9d) into a NEW area,
// l4-starts-carried, and splits the last sub-run: L4h = l4-chat-carried + l4-selftasks-carried; a new L4i (wave 33,
// after L4h) = l4-starts-carried + l4-github-carried. The earlier-round leftovers that l4-starts-sessions did not build
// are copied over with their text. Idempotent: rebuilt and re-tagged "(L4g leftovers)".
const fs = require("fs");
const TAG = "(L4g leftovers)";
const SRC =
  "Sources: /tmp/frbench/runL4-L4g-{fix,review,fixup}-l4-starts-sessions.json and runL4-L4g-merge.json (problems_left).";
const KEY = "l4-starts-carried";
const CARRIED_IDS = ["L4a-left-5", "L4b-left-6", "L4c-left-1", "L4c-left-2", "L4c-left-3", "L4d-left-1", "L4d-left-2", "L4d-left-3", "L4d-left-4"];
const NEVER_CARRIED = new Set(["L4d-left-2", "L4a-left-5"]);

const items = [
  ["L4g-left-1", "minor, false sentence", true,
    "start-blocked.ts words an outer-limit card without room as 'needs your answer' in the start check; say the limit and what changes it (sibling of L4-money-204)."],
  ["L4g-left-2", "minor, false sentence", true,
    "previewWork (chat's read-back of make ready) says the no_room line while a session runs, because it has no estimate to compare with the work budget; use the task's estimate as L4-money-203's admit does (sibling of 203)."],
  ["L4g-left-3", "minor, money words", true,
    "The repository/folder status note says 'Spent CHF 0.00.' for a session whose result says 'Less than CHF 0.01.' (runner.ts endedNote uses formatChf instead of the W14-6 words). One money wording everywhere."],
  ["L4g-left-4", "minor, a button that fails", true,
    "While the project's own session waits to go on (a continuation), the header still offers Start session at 1280 and 375 px and POST /sessions answers 409 (review walk 6). Offer what the wait offers (Cancel the wait, or Start after it) and check the Start dialog too."],
  ["L4-money-207 (rest)", "minor", false,
    "Time half: the 'Interrupted' end line carries the restart's time (session.ended is stamped when Forerunner starts again); use the last event's time. And one crash that released tasks in several projects posts one Update with project_id null; post one Update per project (the triage note)."],
  ["L4-money-210/211/212/215/216", "minor, cut-able", false,
    "210: stopping the critic's monthly check records it failed. 211: continuation and hands-off tests count sessions right after the task is done (race). 212: the Desktop window check passes without seeing the session run. 215: move read-backs name same-titled tasks by title only. 216: turning on 'Start a session by itself' does not say tasks that were already ready run too."],
  ["L4g-left-5", "words, cut-able", false,
    "Fixed words that do not follow the prepared context: the Tasks-row tooltips for Go ahead without, Redo and Try again, chat's option line (202's and 208's cut parts), and Make ready's confirm dialog ('Ready to run: the running session takes it if it fits, else your next Start.', shown after the session had ended, walk 5)."],
  ["L4g-left-6", "words, cut-able", false,
    "Design section 5 rule 10: on a waiting Overview the wait's text appears four times (the bar, the header line, Working now, Last result/Next). A continuation's page reads 'Goes on with your session of 16:41.' then 'It goes on with a budget of CHF 5.00.' ('goes on' twice). The queued start's Cancel explanation is only a tooltip. Bird notes' Last result reads 'No session yet.' while its start waits in line (say it starts after that session). A running continuation's Sessions row shows startedBy null and 'plans the session'."],
  ["L4g-left-7", "minor, owner-visible choice", false,
    "A session whose only task the person paused (or cancelled, W15-59) shows the badge 'Done' beside 'You paused \"X\"; nothing else ran.'. Default kept: 'Done' (a queue end). Note it in notes_for_other_areas so the owner can change it."],
  ["L4g-left-8", "tests, fake daemon", false,
    "The fake daemon does not model the limit wake (budget.set's woken line, the start-check wake); validation rule 3 asks the fake to change with a changed route. listedWhere does not list stop_reason 'plan_awaiting_approval' or a session another one continues (L4-money-201's triage note). Bench walks before and after with screenshots kept outside --fresh."],
];

for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  const ss = d.areas.find((x) => x.key === "l4-starts-sessions");
  const carried = [];
  for (const id of CARRIED_IDS) {
    const line = (ss.problems || []).find((p) => String(p).includes(`${id}:`));
    if (line) carried.push([id, NEVER_CARRIED.has(id), String(line).replace(/ \(L4[a-d] leftovers\).*$/, "").replace(/^\[([^\]]+)\] /, "")]);
    else carried.push([id, NEVER_CARRIED.has(id), `${id}: see /tmp/frbench/leftovers and runL4-plan.json l4-starts-sessions.`]);
  }
  const problems = [
    ...items.map(([id, sev, never, text]) => `[${sev}${never ? ", never cut" : ""}] ${id}: ${text} ${TAG} ${SRC}`),
    ...carried.map(([id, never, text]) => `[carried from earlier rounds${never ? ", never cut" : ""}] ${text.startsWith(id) ? text : `${id}: ${text}`} ${TAG} (l4-starts-sessions did not build it)`),
  ];
  const area = {
    key: KEY,
    title:
      "Run L4 sub-run L4g's leftovers close: start-check, make-ready and status-note sentences that are true now, no Start button that fails while a session waits to go on, a crash's Update per project with the right time, the earlier rounds' start and credential leftovers (a start under a refused credential refused in words), and the words, tests and bench walks the Start-dialog area left",
    problems,
    decisions: [
      "Session lead decision L4d-left-2 (2026-11-23, carried): a start under a refused credential is refused in words outright, also with no session kept (POST /sessions, the phone, Continue), with the Start dialog's sentence. The owner can overrule.",
      "Default kept (L4g-left-7): a session whose only task the person paused shows 'Done' beside its sentence, like W15-59's cancel case, until the owner says otherwise.",
    ],
    u_entries: ["U-090 and U-093 (sessions and starts): every item here."],
    root_causes: [
      "packages/runtime/src/daemon/start-blocked.ts (L4g-left-1), previewWork (L4g-left-2), runner.ts endedNote (L4g-left-3), the header's Start offer (L4g-left-4), recovery.ts (L4-money-207 rest).",
    ],
    fix_scope:
      "Run L4 area l4-starts-carried, sub-run L4i (wave 33), first in L4i, base: the merge of sub-run L4h. It builds on l4-starts-sessions (L4g, 3e1ab9d): its admit too_large, limit wake, prepared-context words and crash Continue are re-found and kept. Read runL4-L4g-merge.json and the L4g fix, review and fixup reports first.",
    files: [
      "packages/runtime (start-blocked.ts, runner.ts, recovery.ts, request-words.ts, the session repo listing), packages/state (listedWhere, both dialects).",
      "apps/ui (header, Overview, Tasks row tooltips, Make ready dialog, Sessions), apps/ui/src/api and the fake daemon.",
      "docs/maintainers, docs/user-guide.md.",
    ],
    acceptance: [
      "Never cut: L4g-left-1 to -4 and L4d-left-2, each with its failing test first at the boundary the person uses (real-daemon or UI), exact text.",
      "The rest: each with its failing test first, or in not_done with the reason.",
    ],
    depends_on: ["Base: the merge of sub-run L4h. Runs first in L4i, then l4-github-carried (sequential).", "Built on l4-starts-sessions (L4g, 3e1ab9d)."],
    handoff_items: [...items.map(([id]) => id), ...CARRIED_IDS],
    owner_questions: [],
    size:
      "Large in count, small per item: about 19 items, most one sentence or one function. Cut line, may end in not_done with the evidence: L4-money-207 (rest), 210/211/212/215/216, L4g-left-5, -6, -7, -8, and the carried L4b-left-6, L4c-left-1/2/3, L4d-left-1/3/4. Never in not_done: L4g-left-1, -2, -3, -4, L4d-left-2 and L4a-left-5 (chat's run it now during a rest is kept for the reset; never on the cut line since L4a), and every money and security rule.",
    sub_run: "L4i",
    wave: 33,
    items: [...items.map(([id]) => id), ...CARRIED_IDS],
    counts: { items: items.length + CARRIED_IDS.length, major: 0, minor: items.length + CARRIED_IDS.length, words: 0, blocker: 0 },
  };
  d.areas = d.areas.filter((x) => x.key !== KEY);
  const gi = d.areas.findIndex((x) => x.key === "l4-github-carried");
  d.areas.splice(gi < 0 ? d.areas.length : gi, 0, area);
  const gh = d.areas.find((x) => x.key === "l4-github-carried");
  if (gh) { gh.sub_run = "L4i"; gh.wave = 33; }
  if (P.endsWith("runL4-plan.json")) {
    const h = d.sub_runs.find((x) => x.name === "L4h");
    h.keys = ["l4-chat-carried", "l4-selftasks-carried"];
    h.note = h.note.replace(/ Then l4-github-carried[^.]*\.[^.]*\./, "").replace(/After its merge: push, CI and the Desktop app workflow green, then phase F \(final_check\)\./, "After its merge: push, CI and the Desktop app workflow green, then L4i.");
    if (!h.note.includes("split 2026-11-23")) h.note += " (Sub-run split 2026-11-23 after L4g: l4-github-carried moved to L4i with l4-starts-carried.)";
    d.sub_runs = d.sub_runs.filter((x) => x.name !== "L4i");
    d.sub_runs.push({
      name: "L4i",
      wave: 33,
      keys: [KEY, "l4-github-carried"],
      depends_on_sub_runs: ["L4h"],
      note: "Base: L4h merged. Two areas, sequential: l4-starts-carried (L4g's leftovers and the earlier rounds' start and credential leftovers) then l4-github-carried (L4e's leftovers with the owner's Close button, L4-github-130, never cut). They share few files (the Overview, the fake daemon). After its merge: push, CI and the Desktop app workflow green, then wave 8 and phase F (final_check).",
    });
    if (Array.isArray(d.merge_order)) {
      d.merge_order = d.merge_order.filter((k) => k !== KEY);
      const at = d.merge_order.indexOf("l4-github-carried");
      d.merge_order.splice(at < 0 ? d.merge_order.length : at, 0, KEY);
    }
  }
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
    for (const [id, sev, never, text] of items)
      d.triage.push({ n: id, item: `${id}: ${text}`, decision: "fix", area: KEY, evidence: SRC, note: `${TAG}${never ? " never cut" : ""}` });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4g.json", JSON.stringify({ why: "Run L4 sub-run L4g's leftovers: all placed in l4-starts-carried (L4i).", base: "3e1ab9d", items: [] }, null, 1));
console.log("area", KEY, "items", items.length, "+ carried", CARRIED_IDS.length);
