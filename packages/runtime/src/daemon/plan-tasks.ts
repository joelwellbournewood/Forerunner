import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { HumanRequestRow, ProjectRow, TaskRow } from "@forerunner/state";
import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import { PERSON_SPECIALIST } from "../session/person-questions.ts";
import { type ShapedPlan, shapeProjectPlan } from "../session/project-plan.ts";
import { webAccessOf } from "../wiring/web-access.ts";
import type { CredentialRunsOn, HumanRequestView } from "./api-types.ts";
import { oversizedPlanNote } from "./oversize-words.ts";

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
  /**
   * W15B-07: whether the specialist reads web pages (its registry entry names the page reader).
   * Absent: no task's note says it reads no website.
   */
  readsWeb?(name: string): boolean;
  /**
   * D4 (d1109-oversize-start): what a session of the project may spend on its tasks (its session
   * cap less the fifth kept for reviews, as the Start dialog's default) and the day's rate: a task
   * whose figure alone is more gets the note that it pauses with its work kept and asks to
   * continue. Absent: no task gets it.
   */
  workBudget?: { usdMicro: number; chfPerUsd: number };
  estimate?: {
    /** W15B-07: its `settings` (when given) hold the site rule the notes read. */
    project: Pick<ProjectRow, "name" | "small_project_mode"> &
      Partial<Pick<ProjectRow, "settings">>;
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

/**
 * W15B-07 (W15-33's plan-card line): a task whose specialist reads web pages, in a project whose
 * "Web pages research may read" is "Only these websites" with no website on the list, reads
 * nothing (the rule fails closed, R-failopen); the card says so under the task.
 */
export const READS_NO_WEBSITE_NOTE =
  'Reads no website: this project\'s "only these websites" list is empty. Add websites in Settings, or Change the plan.';

/** The note under a plan task of `specialist` (a specialist of this install), or null. */
function planTaskNote(specialist: string | null, deps: PlanTasksDeps): string | null {
  if (!specialist || !deps.readsWeb?.(specialist)) return null;
  const settings = deps.estimate?.project.settings;
  if (!settings) return null;
  const rule = webAccessOf(settings);
  return rule.mode === "only" && rule.only.length === 0 ? READS_NO_WEBSITE_NOTE : null;
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
  // D4: the note under a task larger than the project's session work budget (once per card).
  const work = deps.workBudget;
  const workChf = work ? usdToChfMicro(Math.max(0, Math.round(work.usdMicro)), work.chfPerUsd) : 0;
  const oversizedNote = (figure: number | null): string | null =>
    work && figure !== null && figure > work.usdMicro
      ? oversizedPlanNote({ chfMicro: workChf, text: formatChf(workChf) })
      : null;
  const out: PlanTaskView[] = [];
  for (const t of tasks) {
    const title = str(t.title);
    if (!title) continue;
    const named = str(t.specialist);
    const canonical = named ? canonicalSpecialistName(named) : null;
    const person = canonical === PERSON_SPECIALIST;
    const known = canonical && !person && deps.has(canonical) ? canonical : null;
    const estimateUsdMicro = estimateOf(str(t.key), person);
    out.push({
      key: str(t.key),
      title,
      specialist: known,
      unknown: named && !person && !known ? named : null,
      estimateUsdMicro,
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
      note: planTaskNote(known, deps),
      oversized: oversizedNote(estimateUsdMicro),
    });
  }
  return onceForThePlan(out);
}

/** '"A", "B" and "C"', or '"A", "B", "C" and 2 more' (design §5 rule 5), titles cut at a word. */
function namedTasks(titles: readonly string[]): string {
  const q = (t: string) => {
    const s = t.replace(/\s+/g, " ").trim();
    if (s.length <= 40) return `"${s}"`;
    const cut = s.slice(0, 39);
    const space = cut.lastIndexOf(" ");
    return `"${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…"`;
  };
  const shown = titles.slice(0, 3).map(q);
  if (titles.length > 3) return `${shown.join(", ")} and ${titles.length - 3} more`;
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A runs-on line the same for several tasks ("On your subscription this task's tests will not
 * run: commands cannot run there.") is said once, under the first of them, for all of them, and
 * names them (W15-86: up to three titles, then "and N more"; before, "the tests of 2 tasks"
 * named none). P7-14: the plan card repeated it under every code task.
 */
function onceForThePlan(tasks: PlanTaskView[]): PlanTaskView[] {
  const count = new Map<string, number>();
  const titles = new Map<string, string[]>();
  for (const t of tasks)
    if (t.runsOn?.line) {
      count.set(t.runsOn.line, (count.get(t.runsOn.line) ?? 0) + 1);
      titles.set(t.runsOn.line, [...(titles.get(t.runsOn.line) ?? []), t.title]);
    }
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
        // "this task" is one: with several the line names them (W15-86).
        line: line.replace(
          /\bthis task's tests will not run\b/,
          `the tests of ${namedTasks(titles.get(line) ?? [])} will not run`,
        ),
      },
    };
  });
}
