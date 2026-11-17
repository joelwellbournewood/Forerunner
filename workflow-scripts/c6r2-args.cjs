// Builds /tmp/frbench/runC-C6r2-args.json: C6 again after the second container restart (2026-11-17 ~00:58 UTC).
// Reuses the chat fixer's report and the chat review; the chat fix-up and the cred-screens fixer resume from
// their saved branches and WIP patches; the areas run one at a time (sequential), chat first.
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("/tmp/frbench/runC-C6-args.json", "utf8"));
const fx = JSON.parse(fs.readFileSync("/tmp/frbench/runC-C6-fix-d1109-selftasks-chat.json", "utf8"));
const rv = JSON.parse(fs.readFileSync("/tmp/frbench/runC-C6-review-d1109-selftasks-chat.json", "utf8"));
const T = "/root/.claude/projects/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/subagents/workflows";

const machine =
  " Machine rule (binding): this machine has 16 GB of memory and no swap, and it restarted twice tonight (about 23:56 and 00:58 UTC) while two agents ran big suites at once, which lost their work in progress. Run one heavy command at a time, each wrapped as `flock /tmp/frbench/heavy.lock <command>` so that no two agents ever run one together: pnpm check, pnpm test, the UI suite, Playwright, pnpm test:integration, pnpm test:e2e, pnpm test:injection, the live harness tests, tsc over a whole package, and the cargo checks. Stop your bench before the full suites. Commit after each coherent piece and run `git branch -f` as your prompt says, so that a restart loses little.";
const history =
  " C6's history: the first run (wf_2ce6c7a0-0e2) and the second (wf_77c66af8-06c) were each stopped by a container restart. d1109-selftasks-chat's fixer finished (its report is reused; fix/d1109-selftasks-chat is at d03d7f6) and its review finished with fix-needed and 4 blocking items (reused); its fix-up resumes from its saved commits and patch. d1109-cred-screens' fixer resumes again from its branch and patch. This run takes the areas one at a time: d1109-selftasks-chat's fix-up first, then d1109-cred-screens (fix, review, fix-up); the merge order stays d1109-cred-screens, d1109-selftasks-chat.";
const anchor = "The next migration number is 0011.";
if (!a.note.includes(anchor)) throw new Error("anchor");
a.note = a.note.replace(anchor, anchor + machine + history);

const csResume = [
  "RESUMING AN INTERRUPTED RUN (second time). Two earlier runs of this fixer were stopped by container restarts before they reported (transcripts: " + T + "/wf_2ce6c7a0-0e2/agent-a54a897b60128d8df.jsonl and " + T + "/wf_77c66af8-06c/agent-a9c9240c6c38f3ceb.jsonl; JSON lines, grep them, do not read them whole).",
  "Their work is committed on branch fix/d1109-cred-screens at 46b0593 (also saved as c6-saved/cred-screens-fix): 13 commits on d133246, the 10 of the first run (eb395fc CS-1, CS-2, C5-left-4, C3-left-9; 62f39b6 CS-3; 49c30ce CS-4; e7bb56a CS-5, C4b-left-6; f87ad69 C5-left-1, CS-6; fb245c1 C5-left-5; 8807212 CS-8, C5-left-3; d631882 CS-9; fd0c3b9 docs; e1188ae the chat one-off line) and 3 of the second (f02f441 the Start dialog's review warning and Use API key's order for a start refused for its budget, C4b-left-5, CS-3; 872e9b2 the run indicator: on your API key, the question with Answer, the share and key-month waits, CS-7; 46b0593 the switch notification, C5-left-2).",
  "The second run's own task list said: C4b-left-5, CS-7 and C5-left-2 built with failing-first tests; CS-3's money-order fix and the refused-key and no-room coverage done; CS-8, C5-left-3, C5-left-5 and CS-9 verified; in progress when it stopped: CS-10's bench walk, the docs and ADR 0120's screens part, the full validation and the report.",
  "It also left uncommitted edits in 11 files, saved as /tmp/frbench/c6-wip-cred-screens-on-46b0593.patch (StartSessionDialog.tsx, credential-start.test.tsx, fake-daemon.ts, real-daemon.test.ts, api-types.ts, compose.ts, credential-start.ts, request-words.ts, server.ts, credential-words.ts, credential-policy-view.test.ts). Read the patch and the transcript's last part to see what it was for; apply it with `git apply` if it is sound and finish it test-first, or drop it and say why.",
  "Setup: that branch is NOT stale: in setup step 1 do NOT run `git branch -f fix/d1109-cred-screens HEAD`; after the merge-base check run `git reset --hard fix/d1109-cred-screens` (a fast-forward of d133246) and build on it; keep running `git branch -f fix/d1109-cred-screens HEAD` after each of your own commits.",
  "Then finish what is left (CS-10's AFTER walk with screenshots you look at; the docs; anything an item still lacks), run the whole validation once more, one heavy command at a time under the lock (pnpm check, test:integration, test:e2e, the UI suite, Playwright with the real Vite build, cargo only if the desktop shell changed), and return one report on the area as a whole, every item and every commit of the three runs, as if one run had done it.",
].join(" ");
const base = a.fixNotes["d1109-cred-screens"];
a.fixNotes["d1109-cred-screens"] = `${csResume}\n\n${base}`;

const scResume = [
  "RESUMING AN INTERRUPTED FIX-UP. An earlier run of this fix-up (transcript " + T + "/wf_77c66af8-06c/agent-a9baa222688ca370c.jsonl; grep it, do not read it whole) was stopped by a container restart at about 00:58 UTC on 2026-11-17, before it reported.",
  "Its commits are on branch c6-saved/selftasks-chat-fixup at 8682c75 (2 commits on fix/d1109-selftasks-chat's d03d7f6: 450e9de the real-daemon describe removes its homes with removeHomes, blocking 3; 8682c75 the drawer says what the agent did to a task, blocking 1, SC-8 and SC-12). Blocking 2 (the read-back names what an edit changes, no 'reword' for a priority) was in progress: its uncommitted edits are saved as /tmp/frbench/c6-wip-selftasks-chat-fixup-on-8682c75.patch (task-fix-tool.ts and chat-fix-tasks.test.ts). Blocking 4 (a test at the model boundary for C5-left-7) was not started.",
  "Setup: instead of `git checkout -B fixup-d1109-selftasks-chat fix/d1109-selftasks-chat`, run `git checkout -B fixup-d1109-selftasks-chat c6-saved/selftasks-chat-fixup`; read the patch, apply it with `git apply` if it is sound and finish blocking 2 test-first (or redo it), then blocking 4, then the cheap non-blocking items, the docs, the bench re-walk and the validation (one heavy command at a time under the lock). Your report covers every change of the fix-up, the earlier run's two commits included, and ends with `git branch -f fix/d1109-selftasks-chat HEAD`.",
].join(" ");
a.fixupNotes = { "d1109-selftasks-chat": scResume };

a.existingFixes = { "d1109-selftasks-chat": fx };
a.existingReviews = { "d1109-selftasks-chat": rv };
a.sequential = true;
a.order = ["d1109-selftasks-chat", "d1109-cred-screens"];
fs.writeFileSync("/tmp/frbench/runC-C6r2-args.json", JSON.stringify(a, null, 2));
console.log("bytes", JSON.stringify(a).length, "review bytes", JSON.stringify(rv).length);
