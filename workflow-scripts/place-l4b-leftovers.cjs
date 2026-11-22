// Places run L4 sub-run L4b's leftovers (l4-selftasks-check and l4-chat-depth merged at 1ea22e9) into the later
// run L4 areas of /tmp/frbench/runL4-plan.json and /tmp/frbench/phaseE.json, and the rest into /tmp/frbench/leftovers-L4b.json.
// Idempotent: problems and triage items tagged "(L4b leftovers)" are replaced.
const fs = require("fs");
const TAG = "(L4b leftovers)";
const SRC = "Sources: /tmp/frbench/runL4-L4b-{fix,review,fixup}-<key>.json and runL4-L4b-merge.json (not_done, non_blocking, notes_for_other_areas).";
const place = {
  "l4-selftasks-chat": [
    "[minor, decision] L4b-left-1: L4-selftasks-113's suggestion-card half: at Assisted the card still lists 'Asks you first: \"<title>\" is a task you added or changed yourself.' among its change steps. Session lead decision (L4b merge): follow chat's rule from L4-selftasks-113 (a reason to ask first is said only at a level that would otherwise not ask), so an Assisted card, which always asks, lists no 'Asks you first' reasons; keep reasons apart from the change list where a level that would not ask shows them. This overrides L4-selftasks-111's acceptance line about Assisted.",
    "[minor] L4b-left-2: the fence silently drops a wait whose order names a pending add of the same set and a name that is neither stored nor pending; refuse it in words, and run the loop check again for the extra waits (session/task-check.ts).",
    "[words] L4b-left-3: the Details line 'Left out: the add of \"Write thanks.html\": ...' uses 'add' as a noun; the plan card's warning repeats the task's title right under that task's row.",
    "[minor] L4b-left-4: quotesOthersWords does not count a task_proposal card.",
    "[tests] L4b-left-5: L4-selftasks-109 restart composed twice on one home (the commands world is in-memory), L4-selftasks-111's critic-notes body at the real daemon, a CostsTab render test for L4-selftasks-114, L4-selftasks-112 (a) quoting two sentences within 160 characters.",
  ],
  "l4-starts-sessions": [
    "[minor] L4b-left-6: L4-selftasks-115: the 'Assisted mode: approve this session plan before work starts.' card still offers 'approve' / 'reject' in lower case with no explanation lines. Changing the labels changes the answer words the plan-approval sync, the cloud runner's trigger and the fake daemon read: keep the stored answer values and change only what the person sees (labels and one-line explanations, design section 3.4).",
  ],
  "l4-chat-answers": [
    "[minor] L4b-left-7: needOfLine (conversation/depth.ts) matches status questions such as 'how long has it been in review for?' or 'how does this compare?', so a paid ask line appears under a quick status answer (it spends nothing); narrow it, with cases.",
    "[minor] L4b-left-8: withoutWordsOffer removes every sentence matching 'stronger model' or 'hand it over', not only questions; an answer saying 'Sonnet is a stronger model.' loses that plain sentence too.",
    "[minor] L4b-left-9: task.dependencies' dependenciesNextLine (packages/commands/src/commands/task.ts): where the task could already run before the change, the done sentence appends previewWork's read-only line through afterMove; with the hands-off setting on and no session, check what it promises.",
    "[note] L4b-left-10: conversation-agent principal is 1.5.0 after L4b; bump from 1.5.0. CHAT_THOROUGH_RULES already carries L4-chat-106's look-it-up sentence: do not add it again.",
  ],
  "l4-money-pause": [
    "[words] L4b-left-11: Settings 'Budget per session … (CHF 5 unless set)' lacks two decimals (design section 5 rule 7).",
  ],
};
const rest = {
  why: "Run L4 sub-run L4b's leftovers that no later run L4 area owns (cut-line items, test infra, live checks and design-doc lines for the session lead).",
  base: "1ea22e9",
  items: [
    { id: "L4b-left-12", severity: "accepted", text: "L4-selftasks-101's budget raise at the plan's apply (raise a model-proposed task budget to its estimate with review before the plan card shows it) and an intake prompt line about review room: not built; the acceptance allows the warning instead, which is built and tested at the person's boundary." },
    { id: "L4b-left-13", severity: "cut line", text: "L4-chat-208's 'at least three lookups before the wrap-up on a 10,000-token context' case; L4-chat-202's eval file and words-only offer check; L4-chat-201's optional floor-without-the-ask-line." },
    { id: "L4b-left-14", severity: "tests", text: "Restart cases for the stepped history window and Go ahead use w.restart() on one in-memory store, not composeRuntime twice on one home; packages/runtime/test/chat-steering.test.ts leaves its mkdtemp home behind (no removeHomes)." },
    { id: "L4b-left-15", severity: "pre-existing", text: "The Inbox shows 'Done: You answered \"Yes\".' and then the Update 'was not applied' for a refused card." },
  ],
  for_session_lead: {
    design_doc_changes: "core-experience.md: section 5 'Chat read-back' After example '(up to CHF 5.00)'; section 3.9 'a dependency change says when the task runs'; section 3.9 'While it answers': Answer now ends with no new offer; section 3.9 an older ask line reads 'Offered: … Not taken.' / 'You went ahead.'.",
    live_checks_for_F: "LC-C13 (the fast model hands over or the app's ask appears), LC-C14 (a second Go ahead runs; a stronger Go ahead does not routinely offer the strongest model), LC-C15 (the Sonnet answer never says it could not hand over), LC-C16 (no offer after Answer now); live calibration of critic.md 1.4.0 (F-16); needOfLine on status questions.",
  },
};
for (const P of ["/tmp/frbench/runL4-plan.json", "/tmp/frbench/phaseE.json"]) {
  const d = JSON.parse(fs.readFileSync(P, "utf8"));
  for (const [key, probs] of Object.entries(place)) {
    const a = d.areas.find((x) => x.key === key);
    if (!a) throw new Error(`${P}: no area ${key}`);
    a.problems = (a.problems || []).filter((x) => !String(x).includes(TAG));
    for (const p of probs) a.problems.push(`${p} ${TAG} ${SRC}`);
  }
  if (P.endsWith("phaseE.json")) {
    d.triage = (d.triage || []).filter((t) => !String(t.note || "").includes(TAG));
    for (const [key, probs] of Object.entries(place))
      for (const p of probs) d.triage.push({ n: p.match(/L4b-left-\d+/)[0], item: p.replace(/^\[[^\]]+\] /, ""), decision: "fix", area: key, evidence: SRC, note: TAG });
  }
  fs.writeFileSync(P, JSON.stringify(d, null, 1));
}
fs.writeFileSync("/tmp/frbench/leftovers-L4b.json", JSON.stringify(rest, null, 1));
console.log("placed", Object.values(place).flat().length, "into", Object.keys(place).join(", "), "; rest", rest.items.length);
