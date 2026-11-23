// Places run L4 sub-run L4f's leftovers (l4-selftasks-chat, merged and pushed at 987614d).
// L4-selftasks-129 goes into l4-chat-carried beside C4-left-6 (the same split Undo refusal); the rest goes into a NEW
// area, l4-selftasks-carried, in sub-run L4h between l4-chat-carried and l4-github-carried. Items for the final check
// and the stand-in-only notes go to /tmp/frbench/leftovers-L4f.json. Idempotent: rebuilt and re-tagged "(L4f leftovers)".
const fs = require("fs");
const TAG = "(L4f leftovers)";
const SRC =
  "Sources: /tmp/frbench/runL4-L4f-{fix,review,fixup}-l4-selftasks-chat.json and runL4-L4f-merge.json (problems_left).";
const KEY = "l4-selftasks-carried";

const toChatCarried = [
  "[minor, words] L4-selftasks-129 (from L4f, build together with C4-left-6, one refusal): a split's Undo that would drop a later change is refused in words, never done in part; its sentence names the split and what came after; the 'undone' line still reads right after a reload (the reload line). L4f built the suggestion card's reasons and left these parts.",
];

const items = [
  ["L4f-left-1", "minor, false state", true,
    "After a No in chat, or a Yes the app refuses because the task or the list changed since the read-back, the open page keeps 'Waiting for you: 1 change to confirm [Answer]' in the header and the Inbox badge for 40 s or more until a reload (bench walk8/8b). POST /chat's heardChat emits inbox.changed only on some paths. Every card close (Yes, No, a refused Yes, an expiry) emits inbox.changed and conversation.changed once; a UI test and a real-daemon case read the header after each."],
  ["L4f-left-2", "minor, session lead decision", true,
    "A 'fix the tasks' read-back answered while a session runs almost always gets 'The tasks changed since I checked them', because taskListFingerprint includes every task's status. Session lead decision (2026-11-23): the fingerprint covers what the fix set reads and changes (the tasks it names: present, status, title, outcome, dependencies; and which tasks the list holds), so a status move of a task the set does not name leaves the Yes valid; a change to a named task still refuses with the changed-since line. Composed test: a session finishes an unrelated task between the read-back and Yes and the set applies; it finishes a named task and Yes refuses."],
  ["L4-selftasks-120 (rest)", "minor, the person's control", true,
    "The redirect guards in task.transition and task.resume ('has the person's note') still judge by the note's presence (packages/commands/src/commands/task.ts near 1303-1308 and 1506-1508), so a note the chat model wrote can block or allow like the person's own. Judge by who wrote it (the note's author, as L4f's 'a note is the person's only when they wrote it'), with a restart case."],
  ["L4-selftasks-127 (rest)", "words, cut-able", false,
    "'Fixing the tasks needs Claude.' now says what to do (L4f), but the Connect offer kind (a button beside the sentence that opens the credential section) is not built."],
  ["L4-other-1 D-5/D-6", "words, cut-able", false,
    "D-5: the line that names review.md for a reviewer that writes no file; D-6: chat's create/edit read-back clause for that reviewer (ADR 0109's amendment says decision 1 covers New task, Edit and chat). Also D-3: Edit still calls useWhoChoices(true) without the project and the edited words."],
  ["L4f-left-3", "words", false,
    "The 120 read-back ends with a double period ('Note for its next brief: \"Put on hold by the person.\".'); lapsedCardUpdate says 'The change you asked for was not made: the session budget for Quarry.' without the values its orphan sibling gives ('(CHF 5.00 to CHF 20.00)'); an Undo read back in chat after a restart is confirmed with the change-log sentence ('Undone: Lowered the monthly cap from CHF 150.00 to CHF 100.00.') instead of the live one ('Undone: the monthly cap is back to CHF 150.00.'). Exact-text tests."],
  ["L4f-left-4", "minor, attribution", false,
    "A merged card that mixes the agent's planFix steps with the person's own step is one change-log row authored by the agent (byAgent true), while the person's step's task reads 'Changed by you'. Make the row and the task line agree (split the row by author, or say both)."],
  ["L4b-left-1..5 (rest)", "minor, cut-able", false,
    "Still open from L4b: the fence's dropped wait, 'Left out: the add of' wording, quotesOthersWords with task_proposal, and the L4-selftasks-109/111/112/114 cases (restart, the critic's-notes body at the real daemon, CostsTab render, quoting two sentences). L4f built the suggestion card's reasons leaving its change list (L4b-left-1's part)."],
  ["L4f-left-5", "tests", false,
    "L4-selftasks-117 details without their own test: a real-daemon fake-clock 'fix the tasks' case at POST /chat; changedSince for a settings, budget, autonomy, model, capability or email card (oldValue compared, untested, also after a restart where subjectsNow reads only task subjects); the header's 'Waiting for you: 1 question' after the Inbox answer; the chat POST emitting inbox.changed when a turn meets an expired card."],
  ["L4f-left-6", "performance", false,
    "apps/ui store/context.tsx reloads every conversation that shows a waiting card on every inbox.changed, including the polling mode's periodic counts; chat cards now wait indefinitely, so this repeats GET /conversation while they wait. Reload only the conversation the event names, or compare a version."],
  ["L4f-left-7", "bench, stand-in", false,
    "The bench stand-in repeats CHAT_PENDING_NOTE in its chat reply (walk-b1.json o1) and its critic sends back a reviewer that changed no file ('the worker reports it could not do the work'), so after two tries the ladder hands the task to the data-analyst and U-098 step 4 cannot be walked on the bench. Teach the stand-in both; then bench walks before and after for L4f's and this area's items (LC-C28 shapes, New task/Edit reviewer line, a reviewer run). Also L4-selftasks-125's rest: scripts/bench/README.md lists FORERUNNER_BENCH_TASK_LIST and _SAYS; docs:check says what it needs without --base in a worktree."],
];

const area = {
  key: KEY,
  title:
    "Run L4 sub-run L4f's leftovers close: a closed chat card leaves no stale 'waiting' header, a 'fix the tasks' Yes is not voided by a session moving tasks it does not name, the redirect guards judge a note by who wrote it, and the words, attribution, tests and bench walks the agent's-tasks-in-chat area left",
  problems: items.map(([id, sev, never, text]) => `[${sev}${never ? ", never cut" : ""}] ${id}: ${text} ${TAG} ${SRC}`),
  decisions: [
    "Session lead decision 2026-11-23 (L4f-left-2): a 'fix the tasks' read-back's fingerprint covers the tasks the set names and the list's membership, not the status of tasks it does not name (the owner's 2026-11-17 answer: every chat read-back waits until answered; run C decision 53: a Yes after the list changed says so).",
    "Session lead decision 2026-11-23 (L4f interpretation): the chat model's acts-at-once calls stay the agent's on Changes (security-command-actor.test.ts pins author_agent; the model never authors as the person without the person's Yes); only a read-back the person confirmed becomes theirs. They are no Inbox echo.",
  ],
  u_entries: ["U-084 and U-095 (chat changes the tasks; read-backs wait): L4f-left-1, -2, -3, -4, -5.", "U-098 (the reviewer that writes no file): L4-other-1 D-3, D-5, D-6."],
  root_causes: [
    "packages/runtime/src/daemon/server.ts POST /chat heardChat: inbox.changed only on some card closes (L4f-left-1).",
    "packages/commands taskListFingerprint: every task's status (L4f-left-2).",
    "packages/commands/src/commands/task.ts redirect guards by note presence (L4-selftasks-120 rest).",
    "apps/ui/src/store/context.tsx: every waiting conversation reloaded on inbox.changed (L4f-left-6).",
  ],
  fix_scope:
    "Run L4 area l4-selftasks-carried, sub-run L4h (wave 32), after l4-chat-carried and before l4-github-carried, base: the merge of sub-run L4g. It builds on l4-selftasks-chat (L4f, 987614d): its read-back waits, changedSince, onPersonsWords and the injection channels are re-found and kept. Read runL4-L4f-merge.json and the L4f fix, review and fixup reports first.",
  files: [
    "packages/runtime/src/daemon/server.ts (POST /chat card closes), packages/runtime/src/conversation/agent.ts.",
    "packages/commands (executor, readback-check.ts, task.ts, the fix set's fingerprint).",
    "apps/ui (store/context.tsx, the header, ChatTab, New task and Edit), apps/ui/src/api and the fake daemon.",
    "scripts/bench (the stand-in's chat and critic), scripts/bench/README.md.",
    "docs/decisions/0109-*.md (dated amendment), docs/maintainers, docs/user-guide.md.",
  ],
  acceptance: [
    "L4f-left-1 (never cut): after No, a refused Yes and an expiry, the header and the Inbox badge change at once (UI test and real-daemon case).",
    "L4f-left-2 (never cut): the composed case of the decision passes both ways.",
    "L4-selftasks-120 rest (never cut): the guards judge by the note's author, also after a restart.",
    "The rest: each with its failing test first, or in not_done with the reason; exact text for every new sentence (design section 5).",
  ],
  depends_on: ["Base: the merge of sub-run L4g. Runs in L4h after l4-chat-carried, before l4-github-carried (sequential).", "Built on l4-selftasks-chat (L4f, 987614d)."],
  handoff_items: items.map(([id]) => id),
  owner_questions: [],
  size:
    "Medium-small: 11 items, most one function, one sentence or one test. Cut line, may end in not_done with the evidence: L4-selftasks-127 (rest), L4-other-1 D-5/D-6, L4f-left-3, -4, -5, -6, -7 and L4b-left-1..5 (rest). Never in not_done: L4f-left-1 (a false 'waiting' state), L4f-left-2 (the decision), L4-selftasks-120 (rest) (the person's control), and every security and money rule.",
  sub_run: "L4h",
  wave: 32,
  items: items.map(([id]) => id),
  counts: { items: items.length, major: 0, minor: items.length, words: 0, blocker: 0 },
};

const rest = {
  why: "Run L4 sub-run L4f's items that only the real model can show, for the final check.",
  base: "987614d",
  items: [],
  for_session_lead: {
    live_checks_for_F: [
      "LC-C28: a change in the person's own words read back and confirmed: GET /changes byAgent false, no GET /inbox Update.",
      "LC-C13/C16: no 'needs your yes' sentence and no CHAT_PENDING_NOTE text beside a read-back in the real model's reply; withoutCardTalk keeps the real answers beside a card (live samples).",
      "F-7: two chat read-backs left 11 minutes and across a restart still wait; Yes applies.",
      "F-11: the reviewer that writes no file is held to its report on the real model (U-098 step 4).",
      "F-2: a pause asked in chat with a model-written note is read back before it applies.",
    ],
  },
};

for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  d.areas = d.areas.filter((x) => x.key !== KEY);
  const gi = d.areas.findIndex((x) => x.key === "l4-github-carried");
  d.areas.splice(gi < 0 ? d.areas.length : gi, 0, JSON.parse(JSON.stringify(area)));
  const cc = d.areas.find((x) => x.key === "l4-chat-carried");
  cc.problems = (cc.problems || []).filter((x) => !String(x).includes(TAG));
  for (const p of toChatCarried) cc.problems.push(`${p} ${TAG} ${SRC}`);
  if (P.endsWith("runL4-plan.json")) {
    const s = d.sub_runs.find((x) => x.name === "L4h");
    s.keys = ["l4-chat-carried", KEY, "l4-github-carried"].filter((k) => k === KEY || s.keys.includes(k));
    const add = " Then l4-selftasks-carried (added 2026-11-23 after L4f): L4f's leftovers, between l4-chat-carried and l4-github-carried.";
    if (!s.note.includes("l4-selftasks-carried")) s.note += add;
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
    d.triage.push({ n: "L4-selftasks-129", item: toChatCarried[0], decision: "fix", area: "l4-chat-carried", evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4f.json", JSON.stringify(rest, null, 1));
console.log("area", KEY, "items", items.length, "; to l4-chat-carried", toChatCarried.length);
