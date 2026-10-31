import { PRIORITY_LABELS } from "@forerunner/runtime/priority";
import { type FormEvent, useMemo, useState } from "react";
import {
  type ChangeMilestoneInput,
  describeError,
  type ProjectCard,
  type TaskView,
} from "../../api/client.ts";
import { MILESTONE_STATUSES, type MilestoneView } from "../../api/contracts.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  statusTone,
  type Tone,
} from "../../components/ui.tsx";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";
import { describeDependencies } from "./DependencyPicker.tsx";

export interface MilestoneRow {
  id: string;
  name: string;
  targetDate: string | null;
  status: MilestoneView["status"] | "derived";
  successCriteria: string[];
  /** Reason for the last change (spec B.5); "" when never changed or derived. */
  reason: string;
  /** The row's version for an edit; null for a derived row, which cannot be edited. */
  version: number | null;
  tasks: TaskView[];
  done: number;
}

/**
 * Milestones as the daemon exposed them before the milestones route: the project's next
 * milestone plus every milestone id referenced by a task. Still the fallback when a daemon
 * does not serve `GET /projects/:id/milestones` (ADR 0032).
 */
export function milestonesFromTasks(project: ProjectCard, tasks: TaskView[]): MilestoneRow[] {
  const rows = new Map<string, MilestoneRow>();
  if (project.nextMilestone) {
    rows.set(project.nextMilestone.id, {
      id: project.nextMilestone.id,
      name: project.nextMilestone.name,
      targetDate: project.nextMilestone.targetDate,
      status: "derived",
      successCriteria: [],
      reason: "",
      version: null,
      tasks: [],
      done: 0,
    });
  }
  for (const t of tasks) {
    const key = t.milestoneId ?? "__none";
    const row = rows.get(key) ?? {
      id: key,
      name: t.milestoneId ?? "No milestone",
      targetDate: null,
      status: "derived" as const,
      successCriteria: [],
      reason: "",
      version: null,
      tasks: [],
      done: 0,
    };
    row.tasks.push(t);
    if (t.status === "done") row.done += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Milestones from the route, in order, each with its tasks; unassigned tasks come last. */
export function milestoneRows(milestones: MilestoneView[], tasks: TaskView[]): MilestoneRow[] {
  const rows: MilestoneRow[] = [...milestones]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((m) => ({
      id: m.id,
      name: m.name,
      targetDate: m.targetDate,
      status: m.status,
      successCriteria: m.successCriteria,
      reason: m.reason,
      version: m.version,
      tasks: [],
      done: 0,
    }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const none: MilestoneRow = {
    id: "__none",
    name: "No milestone",
    targetDate: null,
    status: "derived",
    successCriteria: [],
    reason: "",
    version: null,
    tasks: [],
    done: 0,
  };
  for (const t of tasks) {
    const row = (t.milestoneId && byId.get(t.milestoneId)) || none;
    row.tasks.push(t);
    if (t.status === "done") row.done += 1;
  }
  if (none.tasks.length > 0) rows.push(none);
  return rows;
}

export interface TimelinePoint {
  id: string;
  name: string;
  status: MilestoneRow["status"];
  /** 0..1 along the axis; milestones without a date sit after the dated ones, in order. */
  x: number;
  targetDate: string | null;
}

/** Positions on a time axis from the earliest to the latest target date (spec K.2). */
export function timelineLayout(rows: MilestoneRow[], today: string): TimelinePoint[] {
  const dated = rows.filter((r) => r.targetDate);
  const times = dated.map((r) => new Date(`${r.targetDate}T00:00:00Z`).getTime());
  const todayT = new Date(today).getTime();
  const all = [...times, Number.isFinite(todayT) ? todayT : Number.NaN].filter(Number.isFinite);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const undated = rows.filter((r) => !r.targetDate && r.id !== "__none");
  return rows
    .filter((r) => r.id !== "__none")
    .map((r) => {
      if (r.targetDate) {
        const t = new Date(`${r.targetDate}T00:00:00Z`).getTime();
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          targetDate: r.targetDate,
          x: (t - min) / span,
        };
      }
      const i = undated.indexOf(r);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        targetDate: null,
        x:
          dated.length === 0
            ? (i + 1) / (undated.length + 1)
            : 1 + ((i + 1) / (undated.length + 1)) * 0.3,
      };
    });
}

export interface GraphNode {
  id: string;
  title: string;
  status: string;
  layer: number;
  row: number;
}
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * Layered layout of the task dependency graph: a task's layer is one more than the deepest
 * task it depends on (edges to unknown tasks are dropped; a cycle is cut at the repeated
 * node). Pure, so the picture is testable without a DOM.
 */
export function layoutGraph(tasks: TaskView[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    let layer = 0;
    for (const dep of task?.dependsOn ?? []) {
      if (byId.has(dep)) layer = Math.max(layer, depth(dep) + 1);
    }
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  const rowsPerLayer = new Map<number, number>();
  const nodes: GraphNode[] = tasks.map((t) => {
    const layer = depth(t.id);
    const row = rowsPerLayer.get(layer) ?? 0;
    rowsPerLayer.set(layer, row + 1);
    return { id: t.id, title: t.title, status: t.status, layer, row };
  });
  const edges: GraphEdge[] = tasks.flatMap((t) =>
    t.dependsOn.filter((dep) => byId.has(dep)).map((dep) => ({ from: dep, to: t.id })),
  );
  return { nodes, edges };
}

const NODE_W = 150;
const NODE_H = 34;
const GAP_X = 50;
const GAP_Y = 12;

function fillClass(tone: Tone): string {
  switch (tone) {
    case "good":
      return "fill-emerald-100 dark:fill-emerald-900/60";
    case "warn":
      return "fill-amber-100 dark:fill-amber-900/60";
    case "bad":
      return "fill-red-100 dark:fill-red-900/60";
    case "info":
      return "fill-blue-100 dark:fill-blue-900/60";
    default:
      return "fill-neutral-100 dark:fill-neutral-800";
  }
}

function milestoneTone(status: MilestoneRow["status"]): Tone {
  switch (status) {
    case "done":
      return "good";
    case "active":
      return "info";
    case "cancelled":
      return "bad";
    default:
      return "neutral";
  }
}

function DependencyGraph({ tasks }: { tasks: TaskView[] }) {
  const { nodes, edges } = useMemo(() => layoutGraph(tasks), [tasks]);
  if (nodes.length === 0) {
    return <p className="text-sm text-neutral-500">No tasks yet.</p>;
  }
  const layers = Math.max(...nodes.map((n) => n.layer)) + 1;
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const width = layers * (NODE_W + GAP_X) - GAP_X + 8;
  const height = rows * (NODE_H + GAP_Y) - GAP_Y + 8;
  const pos = new Map(
    nodes.map((n) => [
      n.id,
      { x: 4 + n.layer * (NODE_W + GAP_X), y: 4 + n.row * (NODE_H + GAP_Y) },
    ]),
  );
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      style={{ maxWidth: width }}
      role="img"
      aria-label={`Dependency graph: ${nodes.length} tasks, ${edges.length} dependencies`}
      data-testid="dependency-graph"
    >
      <defs>
        <marker
          id="dep-arrow"
          viewBox="0 0 8 8"
          refX={8}
          refY={4}
          markerWidth={6}
          markerHeight={6}
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="fill-neutral-500" />
        </marker>
      </defs>
      {edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.from}->${e.to}`}
            x1={a.x + NODE_W}
            y1={a.y + NODE_H / 2}
            x2={b.x}
            y2={b.y + NODE_H / 2}
            className="stroke-neutral-500"
            strokeWidth={1.5}
            markerEnd="url(#dep-arrow)"
            data-testid="graph-edge"
            data-from={e.from}
            data-to={e.to}
          />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const label = n.title.length > 22 ? `${n.title.slice(0, 22)}…` : n.title;
        return (
          <g key={n.id} data-testid="graph-node" data-task-id={n.id} data-status={n.status}>
            <rect
              x={p.x}
              y={p.y}
              width={NODE_W}
              height={NODE_H}
              rx={4}
              className={`${fillClass(statusTone(n.status))} stroke-neutral-300 dark:stroke-neutral-700`}
              strokeWidth={1}
            />
            <text
              x={p.x + 8}
              y={p.y + 15}
              className="fill-neutral-900 text-[11px] dark:fill-neutral-100"
            >
              {label}
            </text>
            <text x={p.x + 8} y={p.y + 28} className="fill-neutral-500 text-[10px]">
              {n.status}
            </text>
            <title>
              {n.title} ({n.status})
            </title>
          </g>
        );
      })}
    </svg>
  );
}

function Timeline({ rows, today }: { rows: MilestoneRow[]; today: string }) {
  const points = useMemo(() => timelineLayout(rows, today), [rows, today]);
  if (points.length === 0) return <p className="text-sm text-neutral-500">No milestones yet.</p>;
  const width = 640;
  const height = 70;
  const left = 16;
  const right = 16;
  const scale = (x: number) => left + Math.min(1.3, x) * ((width - left - right) / 1.3);
  const todayT = new Date(today).getTime();
  const dated = points.filter((p) => p.targetDate);
  const times = dated.map((p) => new Date(`${p.targetDate}T00:00:00Z`).getTime());
  const all = [...times, todayT].filter(Number.isFinite);
  const min = Math.min(...all);
  const span = Math.max(...all) - min || 1;
  const todayX = scale((todayT - min) / span);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-3xl"
      role="img"
      aria-label={`Milestone timeline: ${points.map((p) => `${p.name} ${p.targetDate ?? "no date"}`).join(", ")}`}
      data-testid="milestone-timeline"
    >
      <line
        x1={left}
        x2={width - right}
        y1={30}
        y2={30}
        className="stroke-neutral-300 dark:stroke-neutral-700"
        strokeWidth={2}
      />
      <g data-testid="timeline-today">
        <line
          x1={todayX}
          x2={todayX}
          y1={18}
          y2={42}
          className="stroke-neutral-500"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
        <text x={todayX} y={14} textAnchor="middle" className="fill-neutral-500 text-[10px]">
          today
        </text>
      </g>
      {points.map((p, i) => {
        const x = scale(p.x);
        const tone = milestoneTone(p.status);
        return (
          <g
            key={p.id}
            data-testid="timeline-milestone"
            data-milestone-id={p.id}
            data-status={p.status}
          >
            <circle
              cx={x}
              cy={30}
              r={6}
              className={`${fillClass(tone)} stroke-neutral-600 dark:stroke-neutral-300`}
              strokeWidth={1.5}
            />
            <text
              x={x}
              y={i % 2 === 0 ? 56 : 66}
              textAnchor="middle"
              className="fill-neutral-700 text-[10px] dark:fill-neutral-300"
            >
              {p.name}
              {p.targetDate ? ` · ${p.targetDate}` : ""}
            </text>
            <title>
              {p.name}: {p.status}
              {p.targetDate ? `, target ${p.targetDate}` : ", no target date"}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

function DependencyGraphSection({ tasks }: { tasks: TaskView[] | null }) {
  return (
    <section>
      <h2 className="font-semibold">Dependency graph</h2>
      <p className="text-xs text-neutral-500">
        Left to right: a task sits after every task it depends on.
      </p>
      <div className="mt-2 overflow-x-auto">{tasks ? <DependencyGraph tasks={tasks} /> : null}</div>
    </section>
  );
}

/** The one milestone of a small project as the Plan tab shows it. */
export interface SmallProjectMilestone {
  id: string;
  name: string;
  targetDate: string | null;
  status: MilestoneView["status"] | "derived";
  successCriteria: string[];
  reason: string;
  version: number | null;
}

/**
 * Small-project mode (spec B.6) keeps one milestone: the project's open one (`planned` or
 * `active`, first by order) from the route, or, on a daemon without the route, the card's
 * next milestone. Any other milestone on file (one from before the mode was switched on, or
 * one the mode closed before the next plan opened the current one) is named, never hidden.
 */
export function smallProjectMilestone(
  project: ProjectCard,
  milestones: MilestoneView[] | null,
): { current: SmallProjectMilestone | null; others: MilestoneView[] } {
  if (milestones) {
    const sorted = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
    const open = sorted.find((m) => m.status === "planned" || m.status === "active") ?? null;
    return {
      current: open
        ? {
            id: open.id,
            name: open.name,
            targetDate: open.targetDate,
            status: open.status,
            successCriteria: open.successCriteria,
            reason: open.reason,
            version: open.version,
          }
        : null,
      others: sorted.filter((m) => m.id !== open?.id),
    };
  }
  const next = project.nextMilestone;
  return {
    current: next
      ? {
          id: next.id,
          name: next.name,
          targetDate: next.targetDate,
          status: "derived",
          successCriteria: [],
          reason: "",
          version: null,
        }
      : null,
    others: [],
  };
}

/** What the milestone dialog edits: the route's row with the version the change is checked against. */
export interface EditableMilestone {
  id: string;
  name: string;
  targetDate: string | null;
  status: MilestoneView["status"];
  successCriteria: string[];
  version: number;
}

export interface MilestoneForm {
  name: string;
  targetDate: string;
  status: MilestoneView["status"];
  /** One success criterion per line. */
  criteria: string;
  reason: string;
}

export function milestoneFormFor(m: EditableMilestone | null): MilestoneForm {
  return {
    name: m?.name ?? "",
    targetDate: m?.targetDate ?? "",
    status: m?.status ?? "planned",
    criteria: (m?.successCriteria ?? []).join("\n"),
    reason: "",
  };
}

/** The reason sent with a milestone edit whose reason field was left empty (U-010). */
export const DEFAULT_MILESTONE_REASON = "Milestone edited in the app";

/**
 * The body `POST /milestones/:id` gets (spec B.5): every editable field with the row's
 * version and the human's reason, or `DEFAULT_MILESTONE_REASON` when they gave none (the
 * daemon keeps a reason on every change). Blank criteria lines are dropped; a blank date is
 * null.
 */
export function milestoneChangeBody(
  m: EditableMilestone,
  form: MilestoneForm,
): ChangeMilestoneInput {
  return {
    version: m.version,
    reason: form.reason.trim() || DEFAULT_MILESTONE_REASON,
    name: form.name.trim(),
    successCriteria: form.criteria
      .split(/\r?\n/)
      .map((c) => c.trim())
      .filter((c) => c !== ""),
    targetDate: form.targetDate.trim() === "" ? null : form.targetDate.trim(),
    status: form.status,
  };
}

/** A row that can be edited: one the route served (a derived row has no version). */
function editable(m: {
  id: string;
  name: string;
  targetDate: string | null;
  status: MilestoneView["status"] | "derived";
  successCriteria: string[];
  version: number | null;
}): EditableMilestone | null {
  if (m.version === null || m.status === "derived") return null;
  return {
    id: m.id,
    name: m.name,
    targetDate: m.targetDate,
    status: m.status,
    successCriteria: m.successCriteria,
    version: m.version,
  };
}

/** The reason of a milestone's last change, as the Plan tab shows it under the row (spec B.5). */
function MilestoneReason({ reason }: { reason: string }) {
  if (reason === "") return null;
  return (
    <p className="mt-1 text-xs text-neutral-500" data-testid="milestone-reason">
      Last change: {reason}
    </p>
  );
}

/**
 * Edit a milestone (spec B.5): name, target date, status and success criteria with an
 * optional reason (U-010), posted with the row's version. The daemon's refusal (a stale version, a
 * bad date) stays in the dialog. Mount with `key={milestone.id}` so the form starts from the row.
 */
function MilestoneDialog({
  milestone,
  onClose,
  onSaved,
}: {
  milestone: EditableMilestone | null;
  onClose: () => void;
  onSaved: (updated: MilestoneView) => void;
}) {
  const client = useClient();
  const [form, setForm] = useState<MilestoneForm>(() => milestoneFormFor(milestone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (part: Partial<MilestoneForm>) => setForm((prev) => ({ ...prev, ...part }));
  const ready = form.name.trim() !== "";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!milestone || busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await client.changeMilestone(
        milestone.id,
        milestoneChangeBody(milestone, form),
      );
      onSaved(updated);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={milestone !== null}
      onClose={onClose}
      title={milestone ? `Edit milestone: ${milestone.name}` : ""}
      testId="milestone-dialog"
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input
            className={INPUT_CLASS}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            required
            data-testid="milestone-name"
          />
        </Field>
        <Field label="Target date" hint="A calendar date, YYYY-MM-DD; empty for none.">
          <input
            className={INPUT_CLASS}
            value={form.targetDate}
            onChange={(e) => patch({ targetDate: e.target.value })}
            placeholder="YYYY-MM-DD"
            pattern="\d{4}-\d{2}-\d{2}"
            data-testid="milestone-target-date"
          />
        </Field>
        <Field label="Status">
          <select
            className={INPUT_CLASS}
            value={form.status}
            onChange={(e) => patch({ status: e.target.value as MilestoneView["status"] })}
            data-testid="milestone-status"
          >
            {MILESTONE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Success criteria" hint="One per line.">
          <textarea
            className={INPUT_CLASS}
            rows={3}
            value={form.criteria}
            onChange={(e) => patch({ criteria: e.target.value })}
            data-testid="milestone-criteria"
          />
        </Field>
        <Field
          label="Reason (optional)"
          hint={`Recorded on the milestone with you as the author; your agent reads it. Left empty: "${DEFAULT_MILESTONE_REASON}".`}
        >
          <input
            className={INPUT_CLASS}
            value={form.reason}
            onChange={(e) => patch({ reason: e.target.value })}
            autoFocus
            data-testid="milestone-change-reason"
          />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !ready}
            data-testid="confirm-milestone"
          >
            {busy ? "Saving\u2026" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Replace one milestone in the loaded list after an edit. */
function replaceMilestone(
  prev: MilestoneView[] | null,
  updated: MilestoneView,
): MilestoneView[] | null {
  return prev ? prev.map((m) => (m.id === updated.id ? updated : m)) : prev;
}

/**
 * The Plan tab of a small project (spec B.6): the one milestone, the tasks as a flat list in
 * the order the daemon serves them (priority first), no grouping and no timeline, and the
 * dependency graph.
 */
function SmallProjectPlan({
  project,
  tasks,
  milestones,
}: {
  project: ProjectCard;
  tasks: ReturnType<typeof useAsync<TaskView[]>>;
  milestones: ReturnType<typeof useAsync<MilestoneView[]>>;
}) {
  const all = tasks.data ?? [];
  // Dependencies by title, as on the Tasks tab (U-040).
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all]);
  const { current, others } = useMemo(
    () => smallProjectMilestone(project, milestones.data),
    [project, milestones.data],
  );
  const done = all.filter((t) => t.status === "done").length;
  const [editing, setEditing] = useState<EditableMilestone | null>(null);
  return (
    <div className="space-y-5" data-testid="plan">
      <p
        className="rounded border border-neutral-200 p-2 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-300"
        data-testid="small-project-notice"
      >
        Small-project mode: one milestone and a flat task list. A new task that names no tier is
        reviewed at critic tier 0.
      </p>

      <section>
        <h2 className="font-semibold">Milestone</h2>
        {milestones.routeMissing ? (
          <RouteMissing route="milestones" what="milestone status and success criteria">
            <p className="mt-1">The milestone below comes from the project card.</p>
          </RouteMissing>
        ) : null}
        {milestones.error && !milestones.routeMissing && !milestones.data ? (
          <ErrorBanner message={milestones.error} onRetry={milestones.reload} />
        ) : null}
        {milestones.loading && !milestones.data && !milestones.routeMissing ? (
          <Loading what="milestone" />
        ) : null}
        <div
          className="mt-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
          data-testid="small-project-milestone"
          data-milestone-id={current?.id ?? ""}
        >
          {current ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{current.name}</span>
                {current.status !== "derived" ? (
                  <Badge tone={milestoneTone(current.status)}>{current.status}</Badge>
                ) : null}
                {current.targetDate ? (
                  <span className="text-xs text-neutral-500">target {current.targetDate}</span>
                ) : null}
                <span className="ml-auto text-xs text-neutral-500">
                  {done} / {all.length} tasks done
                </span>
                {editable(current) ? (
                  <Button
                    onClick={() => setEditing(editable(current))}
                    data-testid="edit-milestone"
                  >
                    Edit
                  </Button>
                ) : null}
              </div>
              {current.successCriteria.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                  {current.successCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : null}
              <MilestoneReason reason={current.reason} />
            </>
          ) : (
            <p className="text-neutral-500">No milestone yet; the agent plans it from the brief.</p>
          )}
        </div>
        {others.length > 0 ? (
          <p className="mt-1 text-xs text-neutral-500" data-testid="small-project-other-milestones">
            Other milestones on file: {others.map((m) => `${m.name} (${m.status})`).join(", ")}
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="font-semibold">Tasks</h2>
        {tasks.error ? <ErrorBanner message={tasks.error} onRetry={tasks.reload} /> : null}
        {tasks.loading && !tasks.data ? <Loading what="tasks" /> : null}
        {tasks.data && all.length === 0 ? (
          <p className="text-sm text-neutral-500">No tasks yet.</p>
        ) : null}
        <ul className="mt-2 space-y-1" data-testid="flat-task-list">
          {all.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
              data-testid="flat-task"
              data-task-id={t.id}
              data-status={t.status}
            >
              <Badge tone={statusTone(t.status)}>{t.status}</Badge>
              <span className="font-medium">{t.title}</span>
              <span className="text-xs text-neutral-500">
                tier {t.riskTier} · {PRIORITY_LABELS[t.priority]} priority
                {t.dependsOn.length > 0 ? ` · after ${describeDependencies(t, byId)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <DependencyGraphSection tasks={tasks.data} />
      <MilestoneDialog
        key={editing?.id ?? "none"}
        milestone={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          milestones.setData((prev) => replaceMilestone(prev, updated));
          setEditing(null);
        }}
      />
    </div>
  );
}

/**
 * Plan tab (spec K.2, B): milestone timeline, milestones with their tasks, dependency graph.
 * `now` (epoch ms) places today's tick; it defaults to the wall clock and tests inject it,
 * the same way `lib/time.ts` takes `now`. A project in small-project mode (B.6) gets the flat
 * list instead (`SmallProjectPlan`).
 */
export function PlanTab({
  projectId,
  project,
  now = Date.now(),
}: {
  projectId: string;
  project: ProjectCard;
  now?: number;
}) {
  const client = useClient();
  const tasks = useAsync(
    (signal) => client.tasks(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  const milestones = useAsync(
    (signal) => client.milestones(projectId, signal),
    [client, projectId],
  );
  const rows = useMemo(
    () =>
      milestones.data
        ? milestoneRows(milestones.data, tasks.data ?? [])
        : milestonesFromTasks(project, tasks.data ?? []),
    [milestones.data, project, tasks.data],
  );
  const today = new Date(now).toISOString();
  // The timeline draws the route's milestones, or, on a daemon without the route, the derived
  // ones (the card's dated next milestone on the axis, the ids the tasks reference after it).
  const showTimeline = milestones.data !== null || (milestones.routeMissing && tasks.data !== null);
  const [editing, setEditing] = useState<EditableMilestone | null>(null);

  if (project.smallProjectMode) {
    return <SmallProjectPlan project={project} tasks={tasks} milestones={milestones} />;
  }

  return (
    <div className="space-y-5" data-testid="plan">
      <section>
        <h2 className="font-semibold">Timeline</h2>
        {milestones.routeMissing ? (
          <RouteMissing route="milestones" what="milestone status and success criteria">
            <p className="mt-1">
              The timeline and the milestones below are derived from the tasks and the project card.
            </p>
          </RouteMissing>
        ) : null}
        {milestones.error && !milestones.routeMissing && !milestones.data ? (
          <ErrorBanner message={milestones.error} onRetry={milestones.reload} />
        ) : null}
        {(milestones.loading || tasks.loading) && !milestones.data && !tasks.data ? (
          <Loading what="milestones" />
        ) : null}
        {showTimeline ? <Timeline rows={rows} today={today} /> : null}
      </section>

      <section>
        <h2 className="font-semibold">Milestones</h2>
        {tasks.error ? <ErrorBanner message={tasks.error} onRetry={tasks.reload} /> : null}
        {tasks.data && rows.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No milestones yet; the agent plans them from the brief.
          </p>
        ) : null}
        <ul className="mt-2 space-y-2" data-testid="milestone-list">
          {rows.map((m) => (
            <li
              key={m.id}
              className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
              data-testid="milestone"
              data-milestone-id={m.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.status !== "derived" ? (
                  <Badge tone={milestoneTone(m.status)}>{m.status}</Badge>
                ) : null}
                {project.nextMilestone?.id === m.id ? <Badge tone="info">next</Badge> : null}
                {m.targetDate ? (
                  <span className="text-xs text-neutral-500">target {m.targetDate}</span>
                ) : null}
                <span className="ml-auto text-xs text-neutral-500">
                  {m.done} / {m.tasks.length} tasks done
                </span>
                {editable(m) ? (
                  <Button onClick={() => setEditing(editable(m))} data-testid="edit-milestone">
                    Edit
                  </Button>
                ) : null}
              </div>
              {m.successCriteria.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                  {m.successCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : null}
              <MilestoneReason reason={m.reason} />
              {m.tasks.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {m.tasks.map((t) => (
                    <li key={t.id}>
                      <Badge tone={statusTone(t.status)} title={t.title}>
                        {t.title.length > 40 ? `${t.title.slice(0, 40)}…` : t.title}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <DependencyGraphSection tasks={tasks.data} />
      <MilestoneDialog
        key={editing?.id ?? "none"}
        milestone={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          milestones.setData((prev) => replaceMilestone(prev, updated));
          setEditing(null);
        }}
      />
    </div>
  );
}
