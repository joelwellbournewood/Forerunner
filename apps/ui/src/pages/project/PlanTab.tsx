import { useMemo } from "react";
import type { ProjectCard, TaskView } from "../../api/client.ts";
import { Badge, ErrorBanner, Loading, Placeholder, statusTone } from "../../components/ui.tsx";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

interface MilestoneRow {
  id: string;
  name: string;
  targetDate: string | null;
  tasks: TaskView[];
  done: number;
}

/**
 * Milestones as the daemon exposes them in phase 1: the project's next milestone plus every
 * milestone id referenced by a task. A dedicated milestones route comes with the plan work in
 * phase 5 (timeline and dependency graph).
 */
export function milestonesFromTasks(project: ProjectCard, tasks: TaskView[]): MilestoneRow[] {
  const rows = new Map<string, MilestoneRow>();
  if (project.nextMilestone) {
    rows.set(project.nextMilestone.id, {
      id: project.nextMilestone.id,
      name: project.nextMilestone.name,
      targetDate: project.nextMilestone.targetDate,
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
      tasks: [],
      done: 0,
    };
    row.tasks.push(t);
    if (t.status === "done") row.done += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function PlanTab({ projectId, project }: { projectId: string; project: ProjectCard }) {
  const client = useClient();
  const tasks = useAsync(
    (signal) => client.tasks(projectId, { limit: 500 }, signal),
    [client, projectId],
  );
  const milestones = useMemo(
    () => milestonesFromTasks(project, tasks.data ?? []),
    [project, tasks.data],
  );

  return (
    <div className="space-y-4" data-testid="plan">
      <div>
        <h2 className="font-semibold">Milestones</h2>
        {tasks.loading && !tasks.data ? <Loading what="milestones" /> : null}
        {tasks.error ? <ErrorBanner message={tasks.error} onRetry={tasks.reload} /> : null}
        {tasks.data && milestones.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No milestones yet; the agent plans them from the brief.
          </p>
        ) : null}
        <ul className="mt-2 space-y-2" data-testid="milestone-list">
          {milestones.map((m) => (
            <li
              key={m.id}
              className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {project.nextMilestone?.id === m.id ? <Badge tone="info">next</Badge> : null}
                {m.targetDate ? (
                  <span className="text-xs text-neutral-500">target {m.targetDate}</span>
                ) : null}
                <span className="ml-auto text-xs text-neutral-500">
                  {m.done} / {m.tasks.length} tasks done
                </span>
              </div>
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
      </div>
      <Placeholder title="Timeline and dependency graph" phase={5}>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400" data-testid="plan-todo">
          TODO: milestone timeline and task dependency graph, coming with phase 5.
        </p>
      </Placeholder>
    </div>
  );
}
