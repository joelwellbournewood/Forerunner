# Backup: the November 2026 round's working files

This branch holds no product code. It keeps the session's working files on GitHub, so the round
(docs/status/handoff/NEXT-SESSION.md on claude/nifty-knuth-f9udt0) can go on if the cloud
machine is wiped. Delete this branch once wave 8 is merged (the session cannot delete branches:
GitHub refuses deletions from it, so the owner deletes it).

## What is here

- `frbench/`: the plan files from `/tmp/frbench`:
  - the specs (`phaseE.json`, `phaseE7.json`, `phaseE7-live*.md`);
  - the owner's decisions of 2026-11-02 (`owner-decisions-2026-11-02.json`, `owner-answers.md`);
  - the leftovers (`handoffs.json`, the `*-triage.json` files);
  - the results of each wave (`wave*-result.json`, `phaseC*-result.json`);
  - the collaboration audit and wave 8 spec (`collab/`);
  - group 3's resume recipe (`wave7g3-resume.json`), its fixers' reports
    (`wave7g3-fix-reports.json`) and its result (`wave7g3-result.json`);
  - group 4's and group 5's args, resume recipes and results (`wave7g4-*.json`,
    `wave7g5-*.json`);
  - group 6's triage of every leftover of groups 1 to 5 (`wave7g6-triage.json`), and wave 12's
    args and resume recipe (`wave7g6a-args.json`, `wave7g6a-resume.json`). Wave 12's three
    areas are in `phaseE.json` (keys `leftovers7-merge`, `leftovers7-session`,
    `leftovers7-web`); `phaseE.before-wave7g6.json` is the spec before they were added;
  - wave 12's result and its two fixers' reports (`wave7g6a-result.json`,
    `wave7g6a-fix-merge.json`, `wave7g6a-fix-session.json`);
  - wave 14, the continuation of wave 12: its args and resume recipe (`wave7g6c-args.json`,
    `wave7g6c-resume.json`); its new area `leftovers7-merge2` is in `phaseE.json`, and
    `phaseE.before-wave14.json` is the spec before it was added;
  - wave 13's polish split (`wave7g6b-areas.json`), to be put into `phaseE.json` when wave 14 is
    merged.

  Logs, screenshots and bench folders are left out.
- `workflow-scripts/`: the workflow scripts that run the waves (`forerunner-phase-e6.js` runs
  wave 7's groups, `forerunner-phase-f.js` phase F).

## Where the round stands (2026-11-09 20:15 UTC)

Wave 7 (groups 1 to 6) is merged; wave 15 (live check 2's fix wave) is merged: run A at 3600089
and run B at 7d6b34a, CI and the Desktop app workflow green on both. Run C builds the owner's
decisions of 2026-11-09 (`frbench/owner-decisions-2026-11-09.md`; plan `frbench/runC-plan.json`):
six sub-runs C1 to C6. C1 (chat-guard, oversize-start, sessions) was started on 7d6b34a at
19:00 UTC on 2026-11-09; the session then stopped, as the owner asked, until the weekly reset on
Sunday 2026-11-15. Live check 3 (`frbench/live3/BRIEF.md`, cap USD 3) runs in session
session_01RnhAjgpiRyyCw2BQVPP536 once the owner says yes there, else on resume. The four
`claude/nifty-knuth-f9udt0-backup/fix-*` branches are fully merged (SHAs in
`frbench/backup-branch-shas.txt`): the owner deletes them. The plan is in
docs/status/handoff/NEXT-SESSION.md on claude/nifty-knuth-f9udt0.

## Restore on a fresh machine

```bash
git fetch origin 'refs/heads/claude/nifty-knuth-f9udt0-backup/*:refs/remotes/origin/backup/*'
```

```bash
git archive origin/backup/plan-files frbench | tar -x -C /tmp
```

```bash
git archive origin/backup/plan-files workflow-scripts | tar -x -C /tmp/frbench
```

The first command fetches the backup. The second recreates `/tmp/frbench`. The third puts the
scripts in `/tmp/frbench/workflow-scripts`. Copy them from there into the session's workflow scripts folder.

## Resume (from 2026-11-15)

1. Restore as above; the run C args builder is `workflow-scripts/build-runC-args.cjs`
   (`node build-runC-args.cjs <sub-run index 0-5> <base sha>` writes
   `/tmp/frbench/runC-C<n>-args.json`).
2. Make sure the run C areas of the next sub-run are in `/tmp/frbench/phaseE.json` (they were
   inserted before C1; the revised C2 to C6 areas from `runC-plan.json` replace them once the
   answers revision is done: see NEXT-SESSION.md).
3. Start `workflow-scripts/forerunner-phase-e6.js` with those args, from the main checkout as the
   session's working folder; one sub-run at a time, each merged with CI and the Desktop app
   workflow green before the next.

## Resume (older notes)



Start `forerunner-phase-e6.js` for the next group with the args described in
NEXT-SESSION.md. Wave 14 is merged (ce13bb1; its reports are `wave7g6c-*.json`). Wave 13 (polish-words,
polish-screens, leftovers7-tailmerge, leftovers7-tailrun) runs from `wave7g6d-args.json` (resume details in
`wave7g6d-resume.json`; the spec was built by `build-wave13.cjs`). To restart wave 14 from scratch, use the args in `wave7g6c-args.json` (they point at the
wave 12 fixers' reports in `frbench/`).
Each group's note lists the earlier groups' result files (`wave7g1-result.json` to
`wave7g4-result.json`), whose leftovers the later areas fix.
