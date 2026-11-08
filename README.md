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
    (`wave7g3-fix-reports.json`) and its result (`wave7g3-result.json`).

  Logs, screenshots and bench folders are left out.
- `workflow-scripts/`: the workflow scripts that run the waves (`forerunner-phase-e6.js` runs
  wave 7's groups, `forerunner-phase-f.js` phase F).

## Where the round stands

Wave 7 group 3 (merge-in-app, credential-chooser, cost, merged-copy) is merged into
`claude/nifty-knuth-f9udt0` at b015f31. Its four `claude/nifty-knuth-f9udt0-backup/fix-*`
branches are no longer needed: all their commits are in that branch. Delete them on GitHub.

Next: group 4 (wave 10: budget-resume, web-search), then group 5 (wave 11: merged-actions,
sites), group 6 (wave 12: polish), live check 2, and wave 8 (`frbench/collab/`). The plan is
in docs/status/handoff/NEXT-SESSION.md.

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
NEXT-SESSION.md. Each group's note lists the earlier groups' result files
(`wave7g1-result.json`, `wave7g2-result.json`, `wave7g3-result.json`), whose leftovers the
later areas fix.
