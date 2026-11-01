import { Link } from "react-router";
import type { ProjectCard } from "../api/client.ts";
import { Badge, Button, buttonClassName, healthTone } from "./ui.tsx";

/** What a status's Continue does, said with the button (design §3.2). */
export const CONTINUE_EXPLAIN = "Starts a session that works until nothing more can run.";

/**
 * A project's state in one sentence (design §2 "Project status"): the line the project header,
 * its Overview and its row on Home show, with the one button it offers ("Answer", "Open
 * running session", "Continue", "Set up Docker", ...). The daemon words it
 * (`statusLine`, `project-status.ts`); a card without one (the state service) falls back to
 * the old state badge.
 */
export function ProjectStatus({
  project,
  onStart,
  testId = "project-status",
  showAction = true,
}: {
  project: Pick<ProjectCard, "id" | "health" | "needsYou" | "statusLine">;
  /** Continue: opens the Start dialog for the project. */
  onStart?: () => void;
  testId?: string;
  showAction?: boolean;
}) {
  const line = project.statusLine;
  if (!line) return <ProjectStateBadge project={project} testId={testId} />;
  const tone =
    line.kind === "waiting" || line.kind === "docker"
      ? "text-amber-900 dark:text-amber-200"
      : line.kind === "stuck" || line.kind === "planning_failed"
        ? "text-red-800 dark:text-red-300"
        : line.kind === "done"
          ? "text-green-800 dark:text-green-300"
          : "text-neutral-800 dark:text-neutral-200";
  const action = showAction ? line.action : null;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid={`${testId}-row`}>
      <span className={`text-sm font-medium ${tone}`} data-testid={testId} data-kind={line.kind}>
        {line.text}
      </span>
      {action?.kind === "start" && onStart ? (
        <Button
          variant="primary"
          onClick={onStart}
          title={CONTINUE_EXPLAIN}
          data-testid={`${testId}-action`}
        >
          {action.label}
        </Button>
      ) : action?.kind === "link" && action.to ? (
        <Link
          to={action.to}
          className={buttonClassName(line.kind === "waiting" ? "primary" : "secondary")}
          data-testid={`${testId}-action`}
        >
          {action.label}
        </Link>
      ) : null}
    </span>
  );
}

/**
 * A project's state as its card and header showed it before the status sentence (U-071), for
 * a card that carries none: "blocked" only while something waits on you in the Inbox; a task
 * that needs you without an Inbox card reads "needs you: <task>" and opens the project's tasks.
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
