// Usage: node build-runC-args.cjs <subRunIndex 0-5> <base sha>
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("/tmp/frbench/runC-plan.json", "utf8"));
const i = Number(process.argv[2]);
const base = process.argv[3];
const s = p.sub_runs[i];
const note = [
  `This is run C, sub-run ${s.name} of six (C1 to C6): the owner's decisions of 2026-11-09 (D1 one repository one project, D2 a sessions list, D3 chat recall and thinking longer, D4 a task larger than one session, D5 one credential choice, D6 only the person starts a session and prepared work joins a running session if it fits, D7 the agent keeps its own tasks right, D8 a running session visible everywhere). Base ${base}${i === 0 ? " (wave 15 run B merged, CI pending or green)" : ` (sub-run ${p.sub_runs[i - 1].name} merged)`}.`,
  `Read first, whole: /tmp/frbench/owner-decisions-2026-11-09.md (the owner's words; later sections overrule earlier ones; the last section is binding: a session the person started goes on by itself when its Claude credential is back; the agent changes its own tasks without asking from Standard up and asks first at Advisor and Assisted). Your area spec is in /tmp/frbench/phaseE.json areas by key (copied from /tmp/frbench/runC-plan.json areas, which also has the sub-run notes, adr_plan, u_entries, design_doc_changes, live_check_4 and owner_questions). shared_files: the rule that starts 'Run C (base:' and the rules marked '(run C)' decide over every older rule; your sub-run's rules name ${s.name}.`,
  `This sub-run: ${s.note}`,
  `Open owner questions (runC-plan.json owner_questions) are not decided: build the default_built each names, so that the answer can change it in one place (a setting or one constant), and name it in notes_for_other_areas. Areas of later sub-runs build on yours: keep the functions, fields and shapes your spec says they use, and say in notes_for_other_areas what you changed in them.`,
  `The common rule holds even where a spec's files list names them: do not edit docs/status/UPDATE-LOG.md, CHANGELOG.md, docs/requirements.md or docs/design/core-experience.md (the session lead writes them from your report: put suggested lines in it). Maintainer docs, your ADR (its number is fixed in runC-plan.json adr_plan; a new ADR follows docs/decisions/README.md's template; amendments are dated and appended at the end), and your user-guide paragraphs: yes.`,
  `Security in every area: never weaken the hooks or the sandbox; text from pages, searches, files, cards, chat history, reports or any record never becomes instructions to a model (quoted as data; the injection suite pnpm test:injection covers each new channel); the page reader never reaches this PC or the home network. Money and the person's control: no budget, wrap-up line, monthly cap or plan-share cap is ever passed; spend is booked and shown in CHF; when the app says it waits, nothing moves; no session starts unless the person said so (or the hands-off setting, off by default, or the decided continuation of the person's own session). Model-facing prompts and tool definitions are code: change them in the repository and assert the exact text the model receives. Tests use the stand-ins; no real API calls and no GitHub calls; what only the real model shows goes to live check 4 (runC-plan.json live_check_4): write your check_in_the_app steps so the session lead can run them there.`,
  `Words the person sees follow design section 5: one sentence read at a glance, CHF only, no ids, no markdown, no raw states, a sentence promises only what the app does.`,
  `Merge order: ${s.keys.join(", ")}. In a conflict, keep each area's owned part as shared_files says and both areas' intent; in the append-only test files keep every area's describe block ('<key>, run C'); a later area that rewords a sentence updates the earlier area's assertion.`,
  `Reviewers: besides the acceptance lines, check every new or changed person-facing sentence against design section 5, the siblings of each fix (validation rule 8), a restart case wherever a state must survive (validation rule 4), and the owner's words for the decision the area builds (quote them): no less and no more.`,
].join(" ");
const args = { wave: s.wave, keys: s.keys, noMerge: false, note, fixNotes: {} };
for (const k of s.keys) {
  const a = p.areas.find((x) => x.key === k);
  args.fixNotes[k] = `Your area builds ${a.title.split(":")[0]}. Its size and cut line: ${a.size}`;
}
const out = `/tmp/frbench/runC-${s.name}-args.json`;
fs.writeFileSync(out, JSON.stringify(args, null, 2));
console.log(out, "note chars", note.length, "bytes", JSON.stringify(args).length);
