import { useEffect, useState } from "react";
import { Navigate, NavLink, useParams } from "react-router";
import { ProjectStateBadge } from "../components/ProjectState.tsx";
import { Badge, Button, ErrorBanner, Loading, SpendBar } from "../components/ui.tsx";
import { autonomyLabel } from "../lib/plain-words.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import { ChatTab } from "./project/ChatTab.tsx";
import { CostsTab } from "./project/CostsTab.tsx";
import { CreateRepoDialog } from "./project/CreateRepoDialog.tsx";
import { DataTab } from "./project/DataTab.tsx";
import { DocsTab } from "./project/DocsTab.tsx";
import { PlanTab } from "./project/PlanTab.tsx";
import { ReviewsTab } from "./project/ReviewsTab.tsx";
import { StartSessionDialog } from "./project/StartSessionDialog.tsx";
import { SummaryTab } from "./project/SummaryTab.tsx";
import { TasksTab } from "./project/TasksTab.tsx";

export const PROJECT_TABS = [
  { id: "summary", label: "Summary" },
  { id: "plan", label: "Plan" },
  { id: "tasks", label: "Tasks" },
  { id: "docs", label: "Docs" },
  { id: "reviews", label: "Reviews" },
  { id: "costs", label: "Costs" },
  { id: "data", label: "Data" },
  { id: "chat", label: "Chat" },
] as const;
export type ProjectTabId = (typeof PROJECT_TABS)[number]["id"];

function isTab(value: string | undefined): value is ProjectTabId {
  return PROJECT_TABS.some((t) => t.id === value);
}

/**
 * Project page (spec K.2): `/projects/:id/:tab?`. Opening a project does not change the active
 * project (U-056): that is the header's switcher, which every channel follows; this page's Chat
 * tab speaks about this project whatever is active.
 */
export function ProjectPage() {
  const { id = "", tab } = useParams();
  const client = useClient();
  const store = useUiStore();
  const cached = useUiState((s) => s.projects.find((p) => p.id === id) ?? null);
  const project = useAsync((signal) => client.project(id, signal), [client, id]);
  const [startOpen, setStartOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);

  useEffect(() => {
    if (project.data) store.dispatch({ type: "project.upsert", project: project.data });
  }, [project.data, store]);

  if (!isTab(tab)) return <Navigate to={`/projects/${encodeURIComponent(id)}/summary`} replace />;

  const view = project.data ?? cached;
  if (!view && project.loading) return <Loading what="project" />;
  if (!view)
    return <ErrorBanner message={project.error ?? "Project not found."} onRetry={project.reload} />;

  const base = `/projects/${encodeURIComponent(id)}`;

  return (
    <section aria-labelledby="project-title" className="flex h-full flex-col">
      <header className="mb-3 space-y-2" data-testid="project-header">
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="project-title" className="text-xl font-semibold">
            {view.name}
          </h1>
          <Badge>{view.stage}</Badge>
          <ProjectStateBadge project={view} testId="project-health" />
          <Badge>{view.status}</Badge>
          <Badge title={autonomyLabel(view.autonomyLevel).means} testId="project-autonomy">
            autonomy: {autonomyLabel(view.autonomyLevel).label}
          </Badge>
          <div className="ml-auto flex gap-2">
            {view.repos && view.repos.length === 0 ? (
              <Button
                onClick={() => setRepoOpen(true)}
                data-testid="create-repo"
                title="The project has no repository: its tasks run in the project's folder on this computer"
              >
                Create a repository
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => setStartOpen(true)}
              data-testid="start-session"
            >
              Start session
            </Button>
          </div>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{view.goal}</p>
        <div className="max-w-md">
          <SpendBar spent={view.spend} cap={view.budget} label="Spend vs budget" />
        </div>
        {project.error ? <ErrorBanner message={project.error} onRetry={project.reload} /> : null}
      </header>
      <nav
        className="mb-3 flex gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800"
        aria-label="Project tabs"
        data-testid="project-tabs"
      >
        {PROJECT_TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`${base}/${t.id}`}
            data-testid={`tab-${t.id}`}
            className={({ isActive }) =>
              `whitespace-nowrap px-3 py-1.5 text-sm ${
                isActive
                  ? "border-b-2 border-blue-600 font-medium"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1" data-testid={`tab-panel-${tab}`}>
        {tab === "summary" ? <SummaryTab projectId={id} /> : null}
        {tab === "plan" ? <PlanTab projectId={id} project={view} /> : null}
        {tab === "tasks" ? (
          <TasksTab projectId={id} reference={view.budget} defaultRiskTier={view.defaultRiskTier} />
        ) : null}
        {tab === "docs" ? <DocsTab projectId={id} /> : null}
        {tab === "reviews" ? <ReviewsTab projectId={id} /> : null}
        {tab === "costs" ? <CostsTab projectId={id} /> : null}
        {tab === "data" ? <DataTab projectId={id} /> : null}
        {tab === "chat" ? (
          <ChatTab projectId={id} reference={view.budget} defaultRiskTier={view.defaultRiskTier} />
        ) : null}
      </div>
      {repoOpen ? (
        <CreateRepoDialog
          open={repoOpen}
          onClose={() => setRepoOpen(false)}
          projectId={id}
          projectName={view.name}
          onCreated={project.reload}
        />
      ) : null}
      <StartSessionDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        projectId={id}
        reference={view.budget}
      />
    </section>
  );
}
