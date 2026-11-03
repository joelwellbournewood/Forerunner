import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, useLocation, useParams } from "react-router";
import { ProjectStatus } from "../components/ProjectState.tsx";
import { Button, buttonClassName, ErrorBanner, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import { ChatTab } from "./project/ChatTab.tsx";
import { CostsTab } from "./project/CostsTab.tsx";
import { CreateRepoDialog } from "./project/CreateRepoDialog.tsx";
import { DataTab } from "./project/DataTab.tsx";
import { DocsTab } from "./project/DocsTab.tsx";
import { FilesTab } from "./project/FilesTab.tsx";
import { IntakeBanner, useIntakeStatus } from "./project/IntakeBanner.tsx";
import { PlanTab } from "./project/PlanTab.tsx";
import { ReviewsTab } from "./project/ReviewsTab.tsx";
import { StartSessionDialog } from "./project/StartSessionDialog.tsx";
import { SummaryTab } from "./project/SummaryTab.tsx";
import { TasksTab } from "./project/TasksTab.tsx";

/**
 * The project's tabs (design §6): Overview, Tasks, Chat and Files in the bar; Plan, Docs,
 * Reviews, Costs and Data behind More (same routes, one click away). The Overview keeps the
 * address `summary` it had as the Summary tab, so every link to it still works.
 */
export const PROJECT_TABS = [
  { id: "summary", label: "Overview", more: false },
  { id: "tasks", label: "Tasks", more: false },
  { id: "chat", label: "Chat", more: false },
  { id: "files", label: "Files", more: false },
  { id: "plan", label: "Plan", more: true },
  { id: "docs", label: "Docs", more: true },
  { id: "reviews", label: "Reviews", more: true },
  { id: "costs", label: "Costs", more: true },
  { id: "data", label: "Data", more: true },
] as const;
export type ProjectTabId = (typeof PROJECT_TABS)[number]["id"];

function isTab(value: string | undefined): value is ProjectTabId {
  return PROJECT_TABS.some((t) => t.id === value);
}

/** What Start does, said with the button (design §3.6). */
const START_EXPLAIN = "Works until nothing more can run, the budget is used, or you stop it.";

/**
 * Project page (design §3.4, spec K.2): `/projects/:id/:tab?`. The header is the project's
 * name, its status in one sentence (design §2) with the one button it offers, and Start
 * session, which reads "Open running session" while a session works on it. The card shown is
 * the store's live copy (it follows `project.changed`, the Inbox and the sessions), so the
 * header never goes stale after a session. Opening a project does not change the active
 * project (U-056); the header's switcher names the project on screen.
 */
export function ProjectPage() {
  const { id = "", tab } = useParams();
  const location = useLocation();
  const client = useClient();
  const store = useUiStore();
  const cached = useUiState((s) => s.projects.find((p) => p.id === id) ?? null);
  const project = useAsync((signal) => client.project(id, signal), [client, id]);
  const intake = useIntakeStatus(id).data?.state ?? null;
  const [startOpen, setStartOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);

  useEffect(() => {
    if (project.data) store.dispatch({ type: "project.upsert", project: project.data });
  }, [project.data, store]);

  if (tab === "overview")
    return (
      <Navigate to={`/projects/${encodeURIComponent(id)}/summary${location.search}`} replace />
    );
  if (!isTab(tab)) return <Navigate to={`/projects/${encodeURIComponent(id)}/summary`} replace />;

  // The live copy first: the page's own read is only for a project the list does not have yet.
  const view = cached ?? project.data;
  if (!view && project.loading) return <Loading what="project" />;
  if (!view)
    return <ErrorBanner message={project.error ?? "Project not found."} onRetry={project.reload} />;

  const base = `/projects/${encodeURIComponent(id)}`;
  // The plan banner says "Drafting the plan…" / "Waiting for you: approve the plan" itself.
  const planBanner =
    (view.progress?.total ?? 0) === 0 &&
    (intake === "drafting" ||
      intake === "pending" ||
      intake === "failed" ||
      intake === "waiting" ||
      intake === "rejected");
  const moreTabs = PROJECT_TABS.filter((t) => t.more);
  const inMore = moreTabs.some((t) => t.id === tab);
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `whitespace-nowrap px-3 py-1.5 text-sm ${
      isActive
        ? "border-b-2 border-blue-600 font-medium"
        : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
    }`;
  // A tab keeps the address's query (the Tasks tab's filters survive a look at another tab).
  const tabTo = (t: ProjectTabId) => ({ pathname: `${base}/${t}`, search: location.search });

  return (
    <section aria-labelledby="project-title" className="flex h-full flex-col">
      <header className="mb-3 space-y-2" data-testid="project-header">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="project-title" className="text-xl font-semibold">
            {view.name}
          </h1>
          {planBanner ? null : (
            <ProjectStatus
              project={view}
              onStart={() => setStartOpen(true)}
              testId="project-status"
              showAction={!view.working}
            />
          )}
          <div className="ml-auto flex gap-2">
            {view.repos && view.repos.length === 0 ? (
              <Button
                variant="ghost"
                onClick={() => setRepoOpen(true)}
                data-testid="create-repo"
                title="The project has no repository: its tasks run in the project's folder on this computer"
              >
                Create a repository
              </Button>
            ) : null}
            {view.working ? (
              <Link
                to={`/sessions/${encodeURIComponent(view.working.sessionId)}`}
                className={buttonClassName("primary")}
                data-testid="open-running-session"
              >
                Open running session
              </Link>
            ) : (
              <Button
                variant="primary"
                onClick={() => setStartOpen(true)}
                data-testid="start-session"
                title={START_EXPLAIN}
              >
                Start session
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{view.goal}</p>
        {project.error && !cached ? (
          <ErrorBanner message={project.error} onRetry={project.reload} />
        ) : null}
      </header>
      {/* U-046: the plan from the brief, drafting, waiting in the Inbox or failed with a Retry. */}
      <IntakeBanner projectId={id} />
      <nav
        className="mb-3 flex items-end gap-1 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800"
        aria-label="Project tabs"
        data-testid="project-tabs"
      >
        {PROJECT_TABS.filter((t) => !t.more).map((t) => (
          <NavLink key={t.id} to={tabTo(t.id)} data-testid={`tab-${t.id}`} className={tabClass}>
            {t.label}
          </NavLink>
        ))}
        <details className="relative" open={inMore} data-testid="tab-more">
          <summary
            className={`cursor-pointer list-none whitespace-nowrap px-3 py-1.5 text-sm ${
              inMore
                ? "border-b-2 border-blue-600 font-medium"
                : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            }`}
          >
            More ▾
          </summary>
          <span className="flex">
            {moreTabs.map((t) => (
              <NavLink key={t.id} to={tabTo(t.id)} data-testid={`tab-${t.id}`} className={tabClass}>
                {t.label}
              </NavLink>
            ))}
          </span>
        </details>
      </nav>
      <div className="min-h-0 flex-1" data-testid={`tab-panel-${tab}`}>
        {tab === "summary" ? <SummaryTab projectId={id} project={view} /> : null}
        {tab === "plan" ? <PlanTab projectId={id} project={view} /> : null}
        {tab === "tasks" ? (
          <TasksTab projectId={id} reference={view.budget} defaultRiskTier={view.defaultRiskTier} />
        ) : null}
        {tab === "files" ? <FilesTab projectId={id} repository={view?.repository ?? null} /> : null}
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
