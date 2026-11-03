# Backup: the November 2026 round's working files

This branch holds no product code. It keeps the session's working files on GitHub, so the round
(docs/status/handoff/NEXT-SESSION.md on claude/nifty-knuth-f9udt0) can go on if the cloud
machine is wiped. Delete this branch and the other `claude/nifty-knuth-f9udt0-backup/*`
branches once wave 7 group 3 is merged.

## What is here

- `frbench/`: the plan files from `/tmp/frbench`:
  - the specs (`phaseE.json`, `phaseE7.json`, `phaseE7-live*.md`);
  - the owner's decisions of 2026-11-02 (`owner-decisions-2026-11-02.json`, `owner-answers.md`);
  - the leftovers (`handoffs.json`, the `*-triage.json` files);
  - the results of each wave (`wave*-result.json`, `phaseC*-result.json`);
  - the collaboration audit and wave 8 spec (`collab/`);
  - the group 3 resume recipe (`wave7g3-resume.json`) and the finished fixers' reports
    (`wave7g3-fix-reports.json`).

  Logs, screenshots and bench folders are left out.
- `workflow-scripts/`: the workflow scripts that run the waves (`forerunner-phase-e6.js` runs
  wave 7's groups, `forerunner-phase-f.js` phase F).

## Wave 7 group 3's fix branches (written, not yet reviewed)

| Area | Backup branch | Head |
|---|---|---|
| merge-in-app | `claude/nifty-knuth-f9udt0-backup/fix-merge-in-app` | cce8cbf |
| credential-chooser | `claude/nifty-knuth-f9udt0-backup/fix-credential-chooser` | fff29af |
| cost | `claude/nifty-knuth-f9udt0-backup/fix-cost` | 5aaaabe |
| merged-copy (cut off by the usage limit; 9 commits, to be finished) | `claude/nifty-knuth-f9udt0-backup/fix-merged-copy` | 6a1c21a |

## Restore on a fresh machine

```bash
git fetch origin 'refs/heads/claude/nifty-knuth-f9udt0-backup/*:refs/remotes/origin/backup/*'
```

```bash
for k in merge-in-app credential-chooser cost merged-copy; do git branch -f fix/$k origin/backup/fix-$k; done
```

```bash
git archive origin/backup/plan-files frbench | tar -x -C /tmp
```

```bash
git archive origin/backup/plan-files workflow-scripts | tar -x -C /tmp/frbench
```

The first command recreates `/tmp/frbench`. The second puts the scripts in
`/tmp/frbench/workflow-scripts`. Copy them from there into the session's workflow scripts folder.

## Resume group 3

- **Same machine, workflow cache still there:** resume run `wf_dbd51cc4-c3a` with the args in
  `frbench/wave7g3-resume.json`. That file's `fixNotes` tell the rerun merged-copy fixer to
  continue its branch, not reset it.
- **Fresh machine:** start `forerunner-phase-e6.js` new, with the same args plus
  `existingFixes` set to the contents of `frbench/wave7g3-fix-reports.json`. The finished
  fixers are then not run again: their reviews, fix-ups and the merge run as usual.
