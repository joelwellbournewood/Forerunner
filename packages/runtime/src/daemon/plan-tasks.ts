import type { HumanRequestRow, ProjectRow, TaskRow } from "@forerunner/state";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import { PERSON_SPECIALIST } from "../session/person-questions.ts";
import { type ShapedPlan, shapeProjectPlan } from "../session/project-plan.ts";
import type { CredentialRunsOn, HumanRequestView } from "./api-types.ts";

/**
 * An open plan card's tasks as this install would run them now (U-078, the credential chooser;
 * C-68): who does each (the registry's name for the one the plan names, or the name as planned
 * when this install has none of that name, so the card can say the task would wait for the
 * person), and where it runs and why (`RuntimeApp.chooser.forTask`, the same sentence New task
 * and Settings show). Read when the Inbox is shown (design §5 rule 4: true now).
 */
export type PlanTaskView = NonNullable<HumanRequestView["planTasks"]>[number];

export interface PlanTasksDeps {
  /** Whether this install has a runnable specialist of that (canonical) name. */
  has(name: string): boolean;
  forTask(input: {
    specialist: string;
    projectId: string | null;
    task: { title: string; outcome: string; acceptance_criteria: readonly string[] };
  }): Promise<CredentialRunsOn | null>;
  /**
   * What a task of the plan is estimated to cost now, as the Start dialog prices the task the
   * plan writes (`planEstimateUsdMicro` over the learned estimates; the leftovers of wave 7:
   * the card showed the plan's bounded guess while the Start dialog showed that figure times
   * the learned ratio). `project` shapes the plan as the apply does (its tier and budget per
   * task). Absent: the plan's own figure.
   */
  estimate?: {
    project: Pick<ProjectRow, "name" | "small_project_mode">;
    of(
      task: Pick<
        TaskRow,
        | "specialist"
        | "risk_tier"
        | "est_cost_usd_micro"
        | "budget_usd_micro"
        | "actual_cost_usd_micro"
      >,
    ): number;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The plan's tasks in the order the card lists them: each milestone's, then the loose ones. */
function planTasksOfCard(card: unknown): Record<string, unknown>[] | null {
  if (!isRecord(card) || !str(card.key)?.startsWith("intake:")) return null;
  const proposal = card.proposal;
  if (!isRecord(proposal) || !isRecord(proposal.plan)) return null;
  const plan = proposal.plan;
  const milestones = (Array.isArray(plan.milestones) ? plan.milestones : []).filter(isRecord);
  return [
    ...milestones.flatMap((m) => (Array.isArray(m.tasks) ? m.tasks : []).filter(isRecord)),
    ...(Array.isArray(plan.tasks) ? plan.tasks : []).filter(isRecord),
  ];
}

/** The first session's figure per plan task key (the plan's bounded guess, what the task stores). */
function firstSessionFigures(card: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isRecord(card) || !isRecord(card.proposal)) return out;
  const first = card.proposal.firstSession;
  if (!isRecord(first) || !Array.isArray(first.items)) return out;
  for (const i of first.items.filter(isRecord)) {
    const key = str(i.key);
    const n = typeof i.estimateUsdMicro === "number" ? i.estimateUsdMicro : null;
    if (key && n !== null && Number.isFinite(n)) out.set(key, Math.max(0, Math.round(n)));
  }
  return out;
}

/** The plan as the apply writes it, by task key; null when it does not shape. */
function shapedByKey(
  card: unknown,
  project: Pick<ProjectRow, "name" | "small_project_mode">,
): Map<string, ShapedPlan["unassigned"][number]> | null {
  if (!isRecord(card) || !isRecord(card.proposal) || !isRecord(card.proposal.plan)) return null;
  let shaped: ShapedPlan;
  try {
    shaped = shapeProjectPlan(card.proposal.plan as never, project);
  } catch {
    return null;
  }
  const out = new Map<string, ShapedPlan["unassigned"][number]>();
  for (const t of [...shaped.milestones.flatMap((m) => m.tasks), ...shaped.unassigned])
    if (t.key) out.set(t.key, t);
  return out;
}

/** `planTasks` of an open plan card; null for any other card, or one that is answered. */
export async function planTaskViews(
  row: Pick<HumanRequestRow, "change_card" | "project_id" | "status">,
  deps: PlanTasksDeps,
): Promise<PlanTaskView[] | null> {
  if (row.status !== "open") return null;
  const tasks = planTasksOfCard(row.change_card);
  if (!tasks) return null;
  const figures = firstSessionFigures(row.change_card);
  const shaped = deps.estimate ? shapedByKey(row.change_card, deps.estimate.project) : null;
  const estimateOf = (key: string | null, person: boolean): number | null => {
    const figure = key !== null ? figures.get(key) : undefined;
    if (figure === undefined) return null;
    // The person's questions cost nothing (no specialist runs), whatever the reply guessed.
    if (person) return 0;
    const t = key !== null ? shaped?.get(key) : undefined;
    if (!deps.estimate || !t) return figure;
    return deps.estimate.of({
      specialist: t.specialist,
      risk_tier: t.riskTier,
      est_cost_usd_micro: figure,
      budget_usd_micro: t.budgetUsdMicro,
      actual_cost_usd_micro: 0,
    });
  };
  const out: PlanTaskView[] = [];
  for (const t of tasks) {
    const title = str(t.title);
    if (!title) continue;
    const named = str(t.specialist);
    const canonical = named ? canonicalSpecialistName(named) : null;
    const person = canonical === PERSON_SPECIALIST;
    const known = canonical && !person && deps.has(canonical) ? canonical : null;
    out.push({
      key: str(t.key),
      title,
      specialist: known,
      unknown: named && !person && !known ? named : null,
      estimateUsdMicro: estimateOf(str(t.key), person),
      runsOn: known
        ? await deps
            .forTask({
              specialist: known,
              projectId: row.project_id,
              task: {
                title,
                outcome: str(t.outcome) ?? "",
                acceptance_criteria: strings(t.acceptanceCriteria),
              },
            })
            .catch(() => null)
        : null,
    });
  }
  return onceForThePlan(out);
}

/**
 * A runs-on line the same for several tasks ("On your subscription its tests will not run: it
 * cannot run commands there.") is said once, under the first of them, for all of them (P7-14:
 * the plan card repeated it under every code task).
 */
function onceForThePlan(tasks: PlanTaskView[]): PlanTaskView[] {
  const count = new Map<string, number>();
  for (const t of tasks)
    if (t.runsOn?.line) count.set(t.runsOn.line, (count.get(t.runsOn.line) ?? 0) + 1);
  const said = new Set<string>();
  return tasks.map((t) => {
    const line = t.runsOn?.line;
    const n = line ? (count.get(line) ?? 0) : 0;
    if (!line || n < 2 || !t.runsOn) return t;
    if (said.has(line)) return { ...t, runsOn: { ...t.runsOn, line: null } };
    said.add(line);
    return {
      ...t,
      runsOn: {
        ...t.runsOn,
        // "it" was the one task's specialist: with several tasks it named no one (the review
        // of polish-words).
        line: line
          .replace(/\bits tests will not run\b/, `the tests of ${n} tasks will not run`)
          .replace(/: it cannot run commands there\./, ": commands cannot run there."),
      },
    };
  });
}
