import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { HumanRequestView, ProjectCard as ProjectCardView } from "../api/client.ts";
import { ProjectStatus } from "../components/ProjectState.tsx";
import { Button, buttonClassName, EmptyState, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { RunIndicator, useRunning } from "../shell/RunIndicator.tsx";
import { useShell } from "../shell/ShellContext.ts";
import { useClient, useUiState } from "../store/context.tsx";
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
  const shell = useShell();
  const [starting, setStarting] = useState<ProjectCardView | null>(null);

  return (
    <section aria-labelledby="home-title" className="space-y-6">
      <h1 id="home-title" className="sr-only">
        Home
      </h1>
      <NeedsYou />
      <WorkingNow />
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
            <ProjectRow key={p.id} project={p} onStart={() => setStarting(p)} />
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

/**
 * One project on Home: name, status sentence, "n of m done" and one action (design §3.2).
 * Opening it is a look, not a switch (later #61): it wrote "Switch project: …" to Changes on
 * every visit. The page names the project on screen; the header's switcher still switches.
 */
export function ProjectRow({
  project,
  onStart,
}: {
  project: ProjectCardView;
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
      <Link to={href} className="min-w-40 font-semibold hover:underline" data-testid="open-project">
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

/**
 * A Needs you row's one button (design §3.2, P7-8): Answer, to the card in the Inbox; a card
 * with nothing to answer (no choice, no words) and a link of its own offers that link instead,
 * as the Inbox does (the refused key's "Save a new key" to the setup assistant).
 */
export function homeCardAction(r: HumanRequestView): { label: string; to: string } {
  const own = (r.choices ?? []).length === 0 && r.reply === "none" ? r.links?.[0] : undefined;
  if (own?.to) return { label: own.label, to: own.to };
  return { label: "Answer", to: `/inbox#card-${encodeURIComponent(r.id)}` };
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
        {open.slice(0, 10).map((r) => {
          const action = homeCardAction(r);
          return (
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
                to={action.to}
                className={buttonClassName("primary")}
                data-testid="home-card-action"
              >
                {action.label}
              </Link>
            </li>
          );
        })}
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

/**
 * Design §3.2 "Working now", as the run indicator says it (d1109-run-visible V-3): the same words
 * and Stop as the bar under the header, in its block form; nothing when nothing runs or waits.
 */
function WorkingNow() {
  const running = useRunning();
  if (running.length === 0) return null;
  return (
    <div data-testid="working-now">
      <h2 className="mb-2 text-lg font-semibold">Working now</h2>
      <RunIndicator form="block" />
    </div>
  );
}
