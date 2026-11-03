import type { HumanRequestRow } from "@forerunner/state";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import { PERSON_SPECIALIST } from "../session/person-questions.ts";
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

/** `planTasks` of an open plan card; null for any other card, or one that is answered. */
export async function planTaskViews(
  row: Pick<HumanRequestRow, "change_card" | "project_id" | "status">,
  deps: PlanTasksDeps,
): Promise<PlanTaskView[] | null> {
  if (row.status !== "open") return null;
  const tasks = planTasksOfCard(row.change_card);
  if (!tasks) return null;
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
  return out;
}
