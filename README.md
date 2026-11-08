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

## Where the round stands

Wave 7 groups 1 to 5 are merged into `claude/nifty-knuth-f9udt0`. Group 5 (merged-actions,
sites) ends at fa1a86f; CI and the Desktop app workflow are green on it. The four
`claude/nifty-knuth-f9udt0-backup/fix-*` branches from group 3 are no longer needed: all their
commits are in that branch. Delete them on GitHub.

Group 6 has three waves. Wave 12 merged leftovers7-merge and leftovers7-session at ca2c58d but
broke before their review, and leftovers7-web never started. Wave 14 is running from ca2c58d:
leftovers7-web, the review and fix-up of the two merged areas, and leftovers7-merge2 (the five
merge problems wave 12 did not start). Next: wave 13 (polish, two areas), live check 2, and wave
8 (`frbench/collab/`). The plan is in docs/status/handoff/NEXT-SESSION.md.

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

## Resume

Start `forerunner-phase-e6.js` for the next group with the args described in
NEXT-SESSION.md. To restart wave 14 from scratch, use the args in `wave7g6c-args.json` (they point at the
wave 12 fixers' reports in `frbench/`).
Each group's note lists the earlier groups' result files (`wave7g1-result.json` to
`wave7g4-result.json`), whose leftovers the later areas fix.
