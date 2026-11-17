// Builds /tmp/frbench/runC-C6r-args.json: C6 again after the container restart of 2026-11-16 ~23:56 UTC.
// d1109-selftasks-chat's finished fixer report is reused (existingFixes); d1109-cred-screens' fixer resumes
// from its committed branch instead of starting over.
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("/tmp/frbench/runC-C6-args.json", "utf8"));
const fx = JSON.parse(fs.readFileSync("/tmp/frbench/runC-C6-fix-d1109-selftasks-chat.json", "utf8"));
const resume = [
  "RESUMING AN INTERRUPTED RUN. An earlier run of this same fixer (workflow run wf_2ce6c7a0-0e2) was stopped by a container restart at about 23:56 UTC on 2026-11-16, before it reported.",
  "Its work is committed on branch fix/d1109-cred-screens at e1188ae: 10 commits on d133246 (eb395fc settings: one place for which Claude does the work (CS-1, CS-2, C5-left-4, C3-left-9); 62f39b6 start dialog (CS-3, C3-left-9); 49c30ce plan card (CS-4); e7bb56a rows and status (CS-5, C4b-left-6); f87ad69 session log and session page: the switch to the API key (C5-left-1, CS-6); fb245c1 the refused card's closed line (C5-left-5); 8807212 chat and Inbox one-off (CS-8, C5-left-3); d631882 Costs by credential (CS-9); fd0c3b9 docs; e1188ae the chat one-off line).",
  "That branch is NOT stale: in setup step 1 do NOT run `git branch -f fix/d1109-cred-screens HEAD`. Instead, after the merge-base check, run `git reset --hard fix/d1109-cred-screens` in your worktree (it is a fast-forward of d133246) and build on it; keep running `git branch -f fix/d1109-cred-screens HEAD` after each of your own commits.",
  "The earlier run's validation had reached: pnpm check green (unit: 536 files, 5786 tests passed), the docs check ok with --base, pnpm test:integration green on its second run (one Chromium race in packages/capabilities/test/browser.integration.test.ts failed once and passed twice on rerun), pnpm test:e2e green; the UI suite was running when the container stopped, and Playwright, the cargo checks (only if the desktop shell changed) and its report were not done.",
  "Its bench files are in /tmp/frbench/fix-d1109-cred-screens (steps/ and walk/: see which BEFORE and AFTER walks exist); its transcript is /root/.claude/projects/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/subagents/workflows/wf_2ce6c7a0-0e2/agent-a54a897b60128d8df.jsonl (13 MB of JSON lines: grep it, do not read it whole).",
  "Your job: go through every item of your spec (CS-1 to CS-10) and every leftover in your problems against those commits and the diff against d133246. For each, confirm that its failing-first test exists and passes at the person's boundary and that its words meet design section 5. The commit subjects do not name C5-left-2 (the switch notification), CS-7 (the run indicator: the API key fragment, the ask-waiting state with Answer, the share and key-month waiting forms), C4b-left-5 (the Start dialog's review warning), C5-left-1's drawer run line and Costs part, or CS-10's walk: check whether each is done, and build what is missing (failing test first).",
  "Then run the whole validation again (pnpm check, test:integration, test:e2e, the UI suite, Playwright with the real Vite build, cargo only if the desktop shell changed) and return one report on the area as a whole, every item, the earlier run's commits included, as if one run had done it.",
].join(" ");
a.fixNotes["d1109-cred-screens"] = `${resume}\n\n${a.fixNotes["d1109-cred-screens"]}`;
a.existingFixes = { "d1109-selftasks-chat": fx };
fs.writeFileSync("/tmp/frbench/runC-C6r-args.json", JSON.stringify(a, null, 2));
console.log("bytes", JSON.stringify(a).length);
