# 0108 — The retry ladder's stand-in is named before it runs, and ranked by what the task is

Date: 2026-11-02
Status: accepted

## Context

The retry ladder's second rung (spec D.2, U-044) hands a task to another specialist after two
failed attempts. The executor made that choice inside its run, after the runner had already
written `task.started` with the plan item's specialist, and the runner wrote `task.finished` with
the same name. The session page therefore said "The coder started …" and "The coder finished …"
for work the migration specialist did, and never "takes over" (phase E triage #75, #83; design §5
rule 4: true now). The stand-in was ranked by tool coverage and by the words of the replaced
specialist's description only, never by what the task is.

## Decision

1. **Named before it runs.** The runner asks the executor which specialist the attempt runs with
   (`TaskExecutor.chooseSpecialist`) before it writes `task.started`; `task.started` names that
   specialist, with `handedFrom` the one that ran the task last (in this session or an earlier
   one), and the person line reads "The migration specialist takes over "X" from the coder.".
   `task.finished` names the specialist that ran (`TaskExecutionResult.specialist`, which also
   covers the web routing of ADR 0107). The executor's own `execute` decides the same way, so a
   caller that did not ask gets the same specialist.
2. **Ranked by the task.** Which specialists may take the task over is unchanged: their registry
   tools and their tools on the run's driver must cover the replaced specialist's (validation rule
   6: a specialist only gets work its tools allow). Among those, the task's title and what done
   looks like count first (twice the weight of the replaced specialist's description words,
   matched without a plural "s"), so a page task goes to a stand-in that speaks of pages and
   markup before one that speaks of migrations.

## Consequences

- The ladder's rungs, the attempt counts and the "no stand-in: the person decides" card are as
  before; only the order among fitting stand-ins and the words of the log change.
- With the registry as shipped, few specialists fit each other (the designer lacks the coder's
  `cc:Bash`), so the ranking by the task changes a choice only where two or more fit.
- Test worlds that wrap the executor forward `chooseSpecialist` as compose does.
- The critic still reviews the attempt with the plan item's specialist (its review floor and
  whether the person signs off): a coder task the migration specialist takes over is reviewed as
  the coder's task, as before this decision. Whether a stand-in's own floor should apply is left
  open; applying it would turn a light review into a full one, which waits for Docker.

## Alternatives considered

- Let a specialist with fewer tools take a task when its words fit better (a page task from the
  coder to the designer): it would hand work to a specialist that cannot run the commands the
  work may need. Left for the owner, if a registry with richer descriptions asks for it.
- Write a separate "handed over" line from inside the executor: the log would still name the
  wrong specialist on `task.started` and `task.finished`.
