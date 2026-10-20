import { useMemo } from "react";
import type { ProjectCard, TaskView } from "../../api/client.ts";
import type { MilestoneView } from "../../api/contracts.ts";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, ErrorBanner, Loading, statusTone, type Tone } from "../../components/ui.tsx";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

export interface MilestoneRow {
  id: string;
  name: string;
  targetDate: string | null;
  status: MilestoneView["status"] | "derived";
  successCriteria: string[];
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

/** Plan tab (spec K.2, B): milestone timeline, milestones with their tasks, dependency graph. */
export function PlanTab({ projectId, project }: { projectId: string; project: ProjectCard }) {
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
  const today = new Date().toISOString();

  return (
    <div className="space-y-5" data-testid="plan">
      <section>
        <h2 className="font-semibold">Timeline</h2>
        {milestones.routeMissing ? (
          <RouteMissing route="milestones" what="the milestone timeline">
            <p className="mt-1">
              Milestones below are derived from the tasks and the project card.
            </p>
          </RouteMissing>
        ) : null}
        {milestones.error && !milestones.routeMissing && !milestones.data ? (
          <ErrorBanner message={milestones.error} onRetry={milestones.reload} />
        ) : null}
        {(milestones.loading || tasks.loading) && !milestones.data && !tasks.data ? (
          <Loading what="milestones" />
        ) : null}
        {milestones.data ? <Timeline rows={rows} today={today} /> : null}
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
              </div>
              {m.successCriteria.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                  {m.successCriteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : null}
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

      <section>
        <h2 className="font-semibold">Dependency graph</h2>
        <p className="text-xs text-neutral-500">
          Left to right: a task sits after every task it depends on.
        </p>
        <div className="mt-2 overflow-x-auto">
          {tasks.data ? <DependencyGraph tasks={tasks.data} /> : null}
        </div>
      </section>
    </div>
  );
}
