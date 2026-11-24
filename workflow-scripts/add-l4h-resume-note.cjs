// Adds ARGS.fixupNotes["l4-selftasks-carried"] to the L4h workflow copy so the re-run fixup knows that the cut-off
// fixup's two commits are already on fix/l4-selftasks-carried. Only that fixup's prompt changes, so the cached
// agent results before it (both fixes, both reviews, the chat-carried fixup) replay on resume.
const fs = require("fs");
const p = "/home/user/Forerunner/.claude/worktrees/_wf-scripts/forerunner-phase-e6-L4h.js";
let s = fs.readFileSync(p, "utf8");
const note =
  "Resumed after a container restart (2026-11-24 about 00:30 UTC): an earlier fixup run of this area was cut off by the restart. " +
  "Its two commits are already on fix/l4-selftasks-carried, so your checkout starts from them: fa6a725 (runtime: the reviewer's line " +
  "never takes a technology's name for a file; the review's blocking item) and 440b6bc (ui tests: the fake daemon answers a card " +
  "closed by a chat No with \"no\"). Check them against the review: show the new test fails without fa6a725 (revert it locally, run " +
  "the test, restore), keep both, then finish what remains (the review's cheap non-blocking items, docs, bench re-walk, full " +
  "validation) and report every commit of this fixup, these two included.";
const marker = '"sequential":true}';
if (s.includes('"fixupNotes":{"l4-selftasks-carried"')) {
  console.log("already has the note");
} else {
  if (!s.includes(marker)) throw new Error("marker missing");
  s = s.replace(marker, `"sequential":true,"fixupNotes":{"l4-selftasks-carried":${JSON.stringify(note)}}}`);
  fs.writeFileSync(p, s);
  console.log("note added");
}
