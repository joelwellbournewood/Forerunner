import { Link } from "react-router";
import type { ProjectCard as ProjectCardView } from "../api/client.ts";
import { Badge, Button, EmptyState, healthTone, Loading, SpendBar } from "../components/ui.tsx";
import { relativeTime } from "../lib/time.ts";
import { useShell } from "../shell/ShellContext.ts";
import { useUiState, useUiStore } from "../store/context.tsx";

/** Home (spec K.1): every project as a card. */
export function HomePage() {
  const { projects, projectsLoaded, connection, activeProjectId } = useUiState((s) => s);
  const store = useUiStore();
  const shell = useShell();

  return (
    <section aria-labelledby="home-title">
      <div className="mb-3 flex items-center justify-between">
        <h1 id="home-title" className="text-xl font-semibold">
          Projects
        </h1>
        <Button variant="primary" onClick={shell.openNewProject} data-testid="new-project">
          New project
        </Button>
      </div>
      {!projectsLoaded && connection.status !== "disconnected" ? <Loading what="projects" /> : null}
      {projectsLoaded && projects.length === 0 ? (
        <EmptyState testId="empty-state">
          No projects yet. Create one from a brief, or import a repository.
        </EmptyState>
      ) : null}
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
        data-testid="project-cards"
      >
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            isActive={p.id === activeProjectId}
            onActivate={() => store.dispatch({ type: "activeProject", id: p.id })}
          />
        ))}
      </div>
    </section>
  );
}

export function ProjectCard({
  project,
  isActive,
  onActivate,
}: {
  project: ProjectCardView;
  isActive: boolean;
  onActivate: () => void;
}) {
  const href = `/projects/${encodeURIComponent(project.id)}`;
  return (
    <article
      className={`rounded-lg border p-3 ${
        isActive
          ? "border-blue-400 dark:border-blue-600"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
      data-testid="project-card"
      data-project-id={project.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <Link to={href} onClick={onActivate} className="font-semibold hover:underline">
            {project.name}
          </Link>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{project.goal}</p>
        </div>
        <Badge tone={healthTone(project.health)} testId="health-badge">
          {project.health}
        </Badge>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <dt className="text-neutral-500">Stage</dt>
        <dd data-testid="stage">{project.stage}</dd>
        <dt className="text-neutral-500">Next milestone</dt>
        <dd data-testid="next-milestone">
          {project.nextMilestone
            ? `${project.nextMilestone.name}${
                project.nextMilestone.targetDate ? ` · ${project.nextMilestone.targetDate}` : ""
              }`
            : "none planned"}
        </dd>
        <dt className="text-neutral-500">Waiting on you</dt>
        <dd data-testid="waiting-on-you">
          {project.waitingOnYou > 0 ? (
            <Link
              to="/inbox"
              className="font-medium text-red-700 hover:underline dark:text-red-300"
            >
              {project.waitingOnYou}
            </Link>
          ) : (
            "0"
          )}
        </dd>
        <dt className="text-neutral-500">Latest critic grade</dt>
        <dd data-testid="critic-grade">
          {project.latestCriticGrade === null
            ? "no review yet"
            : `${project.latestCriticGrade} / 100`}
        </dd>
        <dt className="text-neutral-500">Last session</dt>
        <dd>{relativeTime(project.lastSessionAt)}</dd>
        <dt className="text-neutral-500">Autonomy</dt>
        <dd>level {project.autonomyLevel}</dd>
      </dl>
      <div className="mt-3">
        <SpendBar
          spent={project.spend}
          cap={project.budget}
          label="Spend vs budget"
          testId="spend-bar"
        />
      </div>
      <div className="mt-3 flex gap-2">
        <Link to={href} onClick={onActivate}>
          <Button variant="secondary">Open</Button>
        </Link>
        {!isActive ? (
          <Button variant="ghost" onClick={onActivate}>
            Make active
          </Button>
        ) : (
          <Badge tone="info">active</Badge>
        )}
      </div>
    </article>
  );
}
