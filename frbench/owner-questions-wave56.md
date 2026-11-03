# Owner questions from the wave 5 and 6 leftovers

These are the 'owner-decision' items of `/tmp/frbench/wave56-leftovers-triage.json`. The owner's
decisions of 2026-11-02 (`/tmp/frbench/owner-decisions-2026-11-02.json`) do not answer them. Each
question names what is built today.

- **W5-6, the science-evaluator's review level.** Its registry floor is the full review, but its tasks are stored, sandboxed and shown as a light review, and a data-analyst task that failed twice is handed to it. Which do you want? (a) its tasks get the full review in Docker, and a stand-in keeps the task's review level as it keeps the sign-off; (b) its floor becomes the light review, in the process sandbox, as other tasks. Built today: neither, so the two disagree.
- **W5-19, stand-ins with fewer tools.** When a specialist fails twice, may the stand-in be one with fewer tools whose words fit the task better (a page task going to the designer)? (a) no, the stand-in must have every tool of the first specialist (built, ADR 0108); (b) yes, when its words fit.
- **W5-40, removing a project.** Forerunner has no way to remove a project. Which do you want? (a) none, as today; (b) archive (hidden, its files and evidence kept); (c) delete, with its evidence under the data folder removed too.
- **W5-42, the reviewer writing files.** A specialist without a write tool (the reviewer) can still write files through a command; only its brief and the critic stop it. (a) keep that limitation, as ADR 0109 states it (built); (b) build a read-only folder for such runs (a read-only Docker mount and the same in the process sandbox).
- **W6-37, Go ahead without, then Redo.** After Go ahead without, the specialist may never ask about that task again, even after a Redo. (a) keep it for good (built); (b) a Redo clears the choice; (c) after a Redo the specialist may file one new questions card.
- **W6-38, the person's step and the plan size.** A brief that promises your content gets a step for you, so a "Plan size: small" plan can have four tasks, while the design says one to three. (a) your step does not count toward the one to three tasks (built); (b) it counts, so the plan drops or joins work to stay at three.
