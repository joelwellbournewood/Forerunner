# Live walk 3: phase B confirmation on 7765efd (helper session, real model), 2026-11-02 02:28-02:37 UTC

Result: with the real model a project now goes from a brief to finished work the person can open.
All 4 runs got a plan on the FIRST call (4 of 4; before the fixes 1 in 6). USD 0.978 in total.

| Run | Brief | Plan | Intake calls | Out tokens | Session | USD |
|---|---|---|---|---|---|---|
| liveB1 | A page that shows a random quote | coder "Build the random quote page" (~CHF 0.48); tester "Check the quote page behaviour" (~CHF 0.40) | 1 | 1,573 | completed 2/2 | 0.194 |
| liveB2 | smoke brief (one-page quote site) | coder + tester | 1 | - | completed 2/2 | 0.173 |
| liveB3 | A todo list in the browser | coder (~CHF 0.48) + tester (~CHF 0.32) | 1 | 1,410 | completed 2/2 (tester sent back once) | 0.298 |
| liveB4 | A script that renames photos by date | coder (~CHF 1.20) + tester (~CHF 0.80) | 1 | 1,574 | completed 2/2 | 0.313 |

- Intake checks 13/13 on runs 1, 3, 4: planSizeLine "Plan size: small (a short brief: see Size in your
  instructions)", retryAsked null, 2 tasks, no reviewer/deploy/marketing task, a real "Decision:" line, the
  critic reviewed every finished task. Smoke journey (run 2) 26/26.
- The work works: B1 page shows and changes quotes, node test.js 4/4; B2 page + tests 4/4; B3 todo list adds,
  ticks, deletes, survives reload, escapes HTML, npm test 9/9; B4 python3 -m unittest 13 OK, dry-run and real
  rename correct (EXIF date honoured, collision suffix, non-image untouched, idempotent).
- What the person sees (B2): Overview "Done: all 2 tasks. Your files: <workspace>"; "Did 2 tasks: … Nothing
  left. CHF 0.12."; "Changed by the last session: index.html, script.js, style.css, README.md, tests/check.js";
  Files tab opens the sources; Inbox "Nothing needs you."; session timeline readable. Chat "what did you build
  and where is it?" answered correctly with the folder path; "what is left?" → "Nothing is left…".
- Problems: (1) MAJOR the last task's work is never committed (all 4 runs); (2) MAJOR the critic judges from the
  diff alone ("I judged this by reading the diff only, and nothing was run"); (3) minor critic.ts:717 turns an
  accept into a revise on a doc_drift text that is not exactly "none"; (4) minor critic.ts:699 "Fix: <finding>";
  (5) minor __pycache__ staged (no .gitignore); (6) minor tester left docs/testing.md a stub; (7) bench:
  intake.cjs names every project "Quote page HH:MM:SS".
