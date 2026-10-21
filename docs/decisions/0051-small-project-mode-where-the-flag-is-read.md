# 0051 — Small-project mode: where the flag is read

Date: 2026-10-20
Status: accepted

## Context

Spec B.6: "Small-project mode: one milestone, flat task list, critic tier 0 by default."
`project.small_project_mode` existed as a column and as a Settings key (`settings.set`), and
nothing read it (`docs/status/BLOCKERS.md`, requirements close-out). Three places could act on
it: a planner that writes milestones and tasks (there was none: the session planner plans the
ready tasks and the intake step of A.2 is open), the critic's tier resolution, and the task
creation paths (the daemon's `POST /projects/:id/tasks`, the `task.create` command behind chat
and voice, the email command, the UI's New task dialog). The critic reads the tier from the
task row (`risk_tier`, NOT NULL), so at review time a default tier 1 and a tier 1 the human
named are the same number.

## Decision

1. **One function chooses a new task's tier.** `defaultRiskTier(project)` in
   `packages/runtime/src/session/project-plan.ts` returns 0 with the flag and 1 without. Every
   creation path that lets a task leave its tier out calls it: the daemon's
   `POST /projects/:id/tasks` (`riskTier` optional now), the `task.create` command
   (`risk_tier` optional now) and the plan writer. The critic keeps reviewing at
   `task.risk_tier` and never reads the flag: a tier named on a task stands whatever the mode,
   and flipping the flag leaves existing tasks' tiers alone.
2. **The plan writer is where a plan becomes rows.** `applyProjectPlan(store, project, plan,
   author)`, served as `POST /projects/:id/plan`, takes phases with their tasks plus loose
   tasks and writes milestone and task rows in one transaction. Outside the mode: a milestone
   per phase after the project's existing milestones (`order_index`), loose tasks under none.
   In the mode: exactly one milestone, and the project keeps exactly one, so a later plan joins
   the project's open milestone (`planned` or `active`, first by order) instead of adding a
   second; the one milestone is the planned one when the plan names a single milestone, else
   one named after the project with every phase's success criteria once each and the latest
   target date; every task joins it in plan order, so the list is flat. `dependsOn` takes plan
   keys or ids of the project's own tasks; rows are written dependencies first; an unknown
   reference, a cycle, a duplicate key, an empty plan or one over the caps (20 milestones, 200
   tasks) is refused as `validation` before anything is written. Milestone target dates in a
   plan are calendar dates (`YYYY-MM-DD`), the form the Plan tab's timeline reads.
3. **The card carries the mode; the UI computes nothing.** `ProjectCard.smallProjectMode` and
   `ProjectCard.defaultRiskTier` are served by the daemon and optional on the schema (the state
   service's card does not carry them). The New task dialog's first tier option is
   "project default (tier N)" from the card and the dialog sends no `riskTier` unless one is
   picked; the Plan tab lists the tasks flat under the one milestone (the open one from the
   milestones route, or the card's next milestone without the route) and names any milestones
   on file from before the mode was switched on rather than hiding them.
4. **The Settings card says what changes.** `SettingSpec.effect` renders the key's effect in
   the card's new value and in the change log sentence, both ways
   ("Set small project mode for X from false to true: new tasks default to critic tier 0 and
   the next plan is written as one milestone with a flat task list; existing tasks keep their
   tier. Undo.").

## Consequences

- B.6 closes with `packages/runtime/test/small-project.test.ts`,
  `packages/commands/test/small-project.test.ts` and `apps/ui/test/small-project.test.tsx`.
  The intake step of A.2, when built, writes through `applyProjectPlan` and inherits the shaping.
- The email command's task insert (`packages/capabilities/src/email/commands.ts`) still names
  tier 1 literally; the capabilities module was outside this change and the residual is in
  `docs/status/BLOCKERS.md` (one line when that path is next touched).
- `CreateTaskBody.riskTier` is optional: a client that omits it gets the project's default
  (1 outside the mode, as before). The UI's recorded request body no longer carries `riskTier`
  unless the human picked one.
- The daemon does not yet serve `GET /projects/:id/milestones` (a proposed route, ADR 0037);
  `PlanProjectView` returns the written milestones as `MilestoneView`, the shape the route
  will serve.

## Alternatives considered

- **Resolving the tier in the critic from the flag.** Cannot tell a named tier 1 from the
  default (the column is NOT NULL), and would re-tier every existing task when the flag flips.
- **Defaulting the tier in the UI dialog from the card.** Duplicates the rule in the client;
  the daemon's other callers (chat and voice `task.create`, the plan writer) would still need
  it, and a card without the field would need a second guess.
- **No milestone at all in small-project mode (`milestone_id` null).** The card's next
  milestone, the summary and the timeline expect one, and the spec says one milestone.
- **A new milestone per plan in small-project mode.** A second plan would leave the project
  with two; joining the open one keeps the invariant the mode promises.
- **Collapsing phases into one milestone outside the mode too.** Phases are what the Plan tab's
  timeline and milestone list are for.
