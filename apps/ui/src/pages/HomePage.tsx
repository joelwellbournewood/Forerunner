import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { HumanRequestView, ProjectCard as ProjectCardView } from "../api/client.ts";
import { ProjectStatus } from "../components/ProjectState.tsx";
import { Button, buttonClassName, EmptyState, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { elapsedWords, useNow } from "../shell/ShellBars.tsx";
import { useShell } from "../shell/ShellContext.ts";
import { switchActiveProject, useClient, useUiState, useUiStore } from "../store/context.tsx";
import { StartSessionDialog } from "./project/StartSessionDialog.tsx";

/** What New project does, said with the button (design §3.2). */
export const NEW_PROJECT_EXPLAIN =
  "Describe what you want; the agent drafts a plan for you to approve.";

/**
 * Home (design §3.2): what needs me, and how is each project doing. Needs you (every open card
 * of every project, one line each with its button), Working now (while a session runs), then
 * one row per project: its name, its status sentence, "n of m done" and one action. No stage,
 * critic grade, autonomy, spend or "Make active": those are internals or live in Settings.
 * Everything follows `inbox.changed`, the sessions and `project.changed` without a reload.
 */
export function HomePage() {
  const { projects, projectsLoaded, connection } = useUiState((s) => s);
  const client = useClient();
  const store = useUiStore();
  const shell = useShell();
  const [starting, setStarting] = useState<ProjectCardView | null>(null);

  return (
    <section aria-labelledby="home-title" className="space-y-6">
      <h1 id="home-title" className="sr-only">
        Home
      </h1>
      <NeedsYou />
      <WorkingNow projects={projects} />
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Projects</h2>
          <span className="flex items-center gap-2">
            <span className="hidden text-xs text-neutral-500 md:inline">{NEW_PROJECT_EXPLAIN}</span>
            <Button
              variant="primary"
              onClick={shell.openNewProject}
              data-testid="new-project"
              title={NEW_PROJECT_EXPLAIN}
            >
              New project
            </Button>
          </span>
        </div>
        {!projectsLoaded && connection.status !== "disconnected" ? (
          <Loading what="projects" />
        ) : null}
        {projectsLoaded && projects.length === 0 ? (
          <EmptyState testId="empty-state">
            No projects yet.{" "}
            <button
              type="button"
              className="font-medium text-blue-700 underline dark:text-blue-300"
              onClick={shell.openNewProject}
            >
              New project
            </button>
          </EmptyState>
        ) : null}
        <ul
          className="divide-y divide-neutral-200 dark:divide-neutral-800"
          data-testid="project-cards"
        >
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              onOpen={() => void switchActiveProject(client, store, p.id)}
              onStart={() => setStarting(p)}
            />
          ))}
        </ul>
      </div>
      {starting ? (
        <StartSessionDialog
          open
          onClose={() => setStarting(null)}
          projectId={starting.id}
          reference={starting.budget}
        />
      ) : null}
    </section>
  );
}

/** One project on Home: name, status sentence, "n of m done" and one action (design §3.2). */
export function ProjectRow({
  project,
  onOpen,
  onStart,
}: {
  project: ProjectCardView;
  onOpen: () => void;
  onStart: () => void;
}) {
  const href = `/projects/${encodeURIComponent(project.id)}`;
  const progress = project.progress;
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
      data-testid="project-card"
      data-project-id={project.id}
    >
      <Link
        to={href}
        onClick={onOpen}
        className="min-w-40 font-semibold hover:underline"
        data-testid="open-project"
      >
        {project.name}
      </Link>
      <span className="flex-1">
        <ProjectStatus project={project} onStart={onStart} testId="project-status" />
      </span>
      {progress && progress.total > 0 ? (
        <span className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="progress">
          {progress.done} of {progress.total} done
        </span>
      ) : null}
    </li>
  );
}

/** Design §3.2 "Needs you": every open card of every project, one line each with its button. */
function NeedsYou() {
  const client = useClient();
  const humanId = useUiState((s) => s.me?.id ?? null);
  const count = useUiState((s) => s.blockingCount);
  const inbox = useAsync(
    (signal) => (humanId ? client.inbox(humanId, signal) : Promise.resolve(null)),
    [client, humanId],
  );
  const { reload } = inbox;
  // A card came or went (the header's count moved): read the list again.
  useEffect(() => {
    if (count >= 0) reload();
  }, [count, reload]);
  const open: HumanRequestView[] = (inbox.data?.requests ?? []).filter((r) => r.status === "open");
  if (open.length === 0) return null;
  return (
    <div data-testid="home-needs-you">
      <h2 className="mb-2 text-lg font-semibold">Needs you</h2>
      <ul className="space-y-1">
        {open.slice(0, 10).map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50/50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30"
            data-testid="home-card"
          >
            {r.projectName ? (
              <span className="font-medium text-neutral-600 dark:text-neutral-300">
                {r.projectName}:
              </span>
            ) : null}
            <span className="flex-1">{r.title ?? r.why}</span>
            <Link
              to={`/inbox#card-${encodeURIComponent(r.id)}`}
              className={buttonClassName("primary")}
              data-testid="home-card-answer"
            >
              Answer
            </Link>
          </li>
        ))}
        {open.length > 10 ? (
          <li className="text-sm">
            <Link to="/inbox" className="text-blue-700 hover:underline dark:text-blue-300">
              and {open.length - 10} more in the Inbox
            </Link>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Design §3.2 "Working now": who works on what, for how long, with Open. */
function WorkingNow({ projects }: { projects: ProjectCardView[] }) {
  const now = useNow();
  const working = projects.filter((p) => p.working);
  if (working.length === 0) return null;
  return (
    <div data-testid="working-now">
      <h2 className="mb-2 text-lg font-semibold">Working now</h2>
      <ul className="space-y-1">
        {working.map((p) => {
          const w = p.working;
          if (!w) return null;
          const elapsed = elapsedWords(w.since, now);
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50/50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/30"
              data-testid="working-row"
            >
              <span className="flex-1">
                {w.agentName ?? "Your agent"} is working on{" "}
                {w.taskTitle ? `"${w.taskTitle}"` : "the next task"} in {p.name}
                {elapsed ? ` · ${elapsed}` : ""}
              </span>
              <Link
                to={`/sessions/${encodeURIComponent(w.sessionId)}`}
                className={buttonClassName("secondary")}
                data-testid="working-open"
              >
                Open
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
