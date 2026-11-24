// Places run L4 sub-run L4h's leftovers (l4-chat-carried and l4-selftasks-carried, merged and pushed at 4a884ef) into a
// NEW area, l4-chat-final, in sub-run L4i between l4-starts-carried and l4-github-carried. Idempotent: rebuilt and
// re-tagged "(L4h leftovers)".
const fs = require("fs");
const TAG = "(L4h leftovers)";
const SRC =
  "Sources: /tmp/frbench/runL4-L4h-{fix,review,fixup}-l4-{chat,selftasks}-carried.json and runL4-L4h-merge.json (problems_left).";
const KEY = "l4-chat-final";

const items = [
  ["L4h-left-1", "minor, the person's words", true,
    "L4-selftasks-120 drops the person's own words in chat: every chat note is passed by the model, so ownNote is always false there, and 'Try X again and tell it to use the old layout' now becomes the card's answer without the person's instruction (review of l4-selftasks-carried). A note the person typed in their own line (the words appear in the person's message) is the person's; only a note the model made up is read back. Composed and real-daemon cases for both."],
  ["L4h-left-2", "tests, a weakened assertion", true,
    "chat-depth.test.ts 'Stop pressed during the nudge' went from an exact toBe(TRUE_LINE) to two negative checks, and the new conversation-memory C3-left-11 case asserts only negatives for res.reply. Never weaken a test: assert the exact stopped reply ('You stopped this answer: CHF … spent.') in both."],
  ["L4h-left-3", "minor", false,
    "L4c-left-9: the parser question's `named` check is a substring test, so an option 'No' matches 'Notes'; use a word-boundary match. Parser options that contain commas read ambiguously."],
  ["L4h-left-4", "words", false,
    "SC-13: the session page's Details line 'Session review measured: N of M planned tasks done' never mentions the replaced count and reads '0 of 0 planned tasks done' when the only planned task was replaced; onlyDrops reads the card's proposed changes, not the applied ones, and 'runs it' is said when the first part waits for a person task. The Inbox's Updates list shows the raw type 'warning' under the lapse Update (design section 5 rule 6). A high-risk card answered from chat ('Answer it on its card in the Inbox: ...') does not mention the person's note."],
  ["L4h-left-5", "minor, restart and races", false,
    "C4-left-7: a second sync in the same process that read the row as 'applying' can settle it again (use a compare-and-set mark); the recovered path admits only the tasks the change made, so the changes the original check left out are not recorded. The pr-answers take-out mark has no start-time recovery."],
  ["L4h-left-6", "minor, attribution", false,
    "task.update, task.transition and task.dependencies use a model-written note as the change log's reason (params.note?.trim()); use it only when the person wrote it. At Assisted, chat's task_create acts at once: check it against design section 3.9 and the owner's 2026-11-17 answer (every chat read-back waits) and make it read back if the design says so."],
  ["L4h-left-7", "small, cut-able", false,
    "NOW_STATE also frees 'I don't see any changes.' and 'any sessions.' (history that recall covers; narrow it). conversationOfCard scans the session's last 400 chat.reply rows. In polling mode the open chat reloads only when the count moved. A lapse emits inbox.changed twice. The fake daemon does not model the waits-changed split Undo refusal, switchedHere for 'there', or a chat No (heardChat sets 'yes'). Talk on a project not in the store flashes the message box. ADR 0109's 2026-11-23 amendment swaps the D-3 and D-5 labels. agent.ts has two stacked doc blocks above switchedHere. The stand-in's thoroughWhy catches 'review.md' in chat tool lines."],
  ["L4h-left-8", "carried from L4h, cut-able", false,
    "L4-selftasks-127 rest (the Connect offer kind beside 'Fixing the tasks needs Claude: connect it in Settings, Basics.'), L4b-left-2 (the fence silently drops a wait whose order names a pending add of the same set; refuse it in words and re-run the loop check), L4b-left-3 second half (the plan card's warning repeats the task's title under that task's row), L4b-left-5 (L4-selftasks-109 restart composed twice on one home, -111's critic-notes body at the real daemon, a CostsTab render test for -114, -112 (a) quoting two sentences), bench walks before and after with screenshots kept outside --fresh."],
];

const area = {
  key: KEY,
  title:
    "Run L4 sub-run L4h's leftovers close: the person's own words in a chat note stay the person's, the weakened Stop assertions are exact again, and the parser, words, restart, attribution and test gaps the two carried chat areas left",
  problems: items.map(([id, sev, never, text]) => `[${sev}${never ? ", never cut" : ""}] ${id}: ${text} ${TAG} ${SRC}`),
  decisions: [
    "Session lead decision 2026-11-24 (L4c-left-6): the fixer's reason is accepted. A forged lower-case 'the app did:' line is the model's output, not text that reaches a model, so it is no new injection channel; 32db6f1 strips the app's markers in any letter case with its own tests. No injection-suite case is added.",
    "Session lead decision 2026-11-24 (L4h-left-1): a note is the person's when its words are in the person's own message; a note the model wrote without them is read back (L4f's rule, refined).",
  ],
  u_entries: ["U-084 and U-095 (chat changes the tasks; read-backs wait): every item here."],
  root_causes: [
    "packages/commands/src/commands/task.ts ownNote (L4h-left-1); reason lines params.note (L4h-left-6).",
    "packages/runtime/test/chat-depth.test.ts and conversation-memory.test.ts (L4h-left-2).",
    "packages/runtime/src/session/task-proposal.ts syncTaskProposals (L4h-left-5).",
  ],
  fix_scope:
    "Run L4 area l4-chat-final, sub-run L4i (wave 33), after l4-starts-carried and before l4-github-carried, base: the merge of sub-run L4h (4a884ef). It builds on l4-chat-carried and l4-selftasks-carried: their regions in agent.ts, task.ts, task-proposal.ts, session-review.ts and the fake daemon are re-found and kept. Read runL4-L4h-merge.json and the L4h fix, review and fixup reports first.",
  files: [
    "packages/commands (task.ts, the executor), packages/runtime (agent.ts, task-proposal.ts), packages/critic (session-review.ts), apps/ui (Inbox Updates, session page, ChatTab), the fake daemon, docs/decisions/0109-*.md, docs/maintainers.",
  ],
  acceptance: [
    "Never cut: L4h-left-1 (a composed and a real-daemon case: the person's own note is kept and answered; a model-made note is read back) and L4h-left-2 (exact assertions).",
    "The rest: each with its failing test first, or in not_done with the reason; exact text for every new sentence (design section 5).",
  ],
  depends_on: ["Base: the merge of sub-run L4h (4a884ef). Runs in L4i after l4-starts-carried, before l4-github-carried (sequential)."],
  handoff_items: items.map(([id]) => id),
  owner_questions: [],
  size:
    "Medium-small: 8 items. Cut line, may end in not_done with the evidence: L4h-left-3 to -8. Never in not_done: L4h-left-1 (the person's words), L4h-left-2 (a weakened test), and every security and money rule.",
  sub_run: "L4i",
  wave: 33,
  items: items.map(([id]) => id),
  counts: { items: items.length, major: 0, minor: items.length, words: 0, blocker: 0 },
};

for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  d.areas = d.areas.filter((x) => x.key !== KEY);
  const gi = d.areas.findIndex((x) => x.key === "l4-github-carried");
  d.areas.splice(gi < 0 ? d.areas.length : gi, 0, JSON.parse(JSON.stringify(area)));
  if (P.endsWith("runL4-plan.json")) {
    const s = d.sub_runs.find((x) => x.name === "L4i");
    s.keys = ["l4-starts-carried", KEY, "l4-github-carried"];
    if (!s.note.includes(KEY)) s.note += " (2026-11-24 after L4h: l4-chat-final, L4h's chat leftovers, runs between them.)";
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
fs.writeFileSync("/tmp/frbench/leftovers-L4h.json", JSON.stringify({ why: "Run L4 sub-run L4h's leftovers: all placed in l4-chat-final (L4i); L4c-left-6's injection case dropped by session lead decision (model output, no new channel).", base: "4a884ef", items: [] }, null, 1));
console.log("area", KEY, "items", items.length);
