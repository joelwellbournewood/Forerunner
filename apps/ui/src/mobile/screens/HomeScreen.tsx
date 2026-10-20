import { Link, useNavigate } from "react-router";
import { Badge, Button, EmptyState, healthTone, SpendBar } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useMobileController, useMobileState } from "../store.tsx";

/** Home (spec K.1 on a phone): every project with its waiting-on-you count; tap to make it active. */
export function HomeScreen() {
  const controller = useMobileController();
  const navigate = useNavigate();
  const projects = useMobileState((s) => s.projects);
  const loaded = useMobileState((s) => s.projectsLoaded);
  const activeId = useMobileState((s) => s.activeProjectId);
  const blocking = useMobileState((s) => s.blockingCount);

  return (
    <section aria-labelledby="m-home-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 id="m-home-title" className="text-xl font-semibold">
          Projects
        </h1>
        <Button variant="ghost" className="ml-auto" onClick={() => void controller.refresh()}>
          Refresh
        </Button>
      </div>
      {blocking > 0 ? (
        <Link
          to="/inbox"
          className="block rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="m-blocking-banner"
        >
          {blocking} request{blocking === 1 ? "" : "s"} block{blocking === 1 ? "s" : ""} work until
          you answer.
        </Link>
      ) : null}
      {loaded && projects.length === 0 ? (
        <EmptyState testId="m-no-projects">No projects yet. Create one on the desktop.</EmptyState>
      ) : null}
      <ul className="space-y-2">
        {projects.map((p) => (
          <li
            key={p.id}
            className={`rounded border p-3 ${
              p.id === activeId
                ? "border-blue-400 dark:border-blue-700"
                : "border-neutral-200 dark:border-neutral-800"
            }`}
            data-testid="m-project-card"
            data-project-id={p.id}
            data-active={p.id === activeId ? "true" : "false"}
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="text-left font-semibold"
                onClick={() => controller.setActiveProject(p.id)}
                data-testid="m-project-name"
              >
                {p.name}
              </button>
              <Badge>{p.stage}</Badge>
              <Badge tone={healthTone(p.health)}>{p.health}</Badge>
              <Badge tone={p.waitingOnYou > 0 ? "warn" : "neutral"} testId="m-waiting">
                {p.waitingOnYou} waiting on you
              </Badge>
            </div>
            <div className="mt-2">
              <SpendBar spent={p.spend} cap={p.budget} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span>
                {p.nextMilestone ? `Next: ${p.nextMilestone.name}` : "No milestone planned"}
              </span>
              <span>· last session {relativeTime(p.lastSessionAt)}</span>
              {p.latestCriticGrade !== null ? <span>· critic {p.latestCriticGrade}</span> : null}
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  controller.setActiveProject(p.id);
                  navigate("/remote");
                }}
                data-testid="m-project-remote"
              >
                Control
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
