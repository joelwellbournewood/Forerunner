import { Link } from "react-router";
import type { ProjectCard } from "../api/client.ts";
import { Badge, healthTone } from "./ui.tsx";

/**
 * A project's state as its card and header show it (U-071): "blocked" only while something
 * waits on you in the Inbox; a task that needs you without an Inbox card reads
 * "needs you: <task>" and opens the project's tasks, so the state says what to do.
 */
export function ProjectStateBadge({
  project,
  testId = "health-badge",
}: {
  project: Pick<ProjectCard, "id" | "health" | "needsYou">;
  testId?: string;
}) {
  const needsYou = project.needsYou ?? null;
  const link = needsYou ? (
    <Link
      to={`/projects/${encodeURIComponent(project.id)}/tasks`}
      className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:underline dark:bg-amber-900 dark:text-amber-100"
      data-testid="needs-you"
      title="This task waits for you on the Tasks tab"
    >
      needs you: {needsYou.title}
    </Link>
  ) : null;
  if (needsYou && project.health !== "blocked") return link;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={healthTone(project.health)} testId={testId}>
        {project.health}
      </Badge>
      {link}
    </span>
  );
}
