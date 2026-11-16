import { MAKE_ONE_EXPLAIN } from "@forerunner/runtime/daemon/join-words";
import { useState } from "react";
import { useNavigate } from "react-router";
import { describeError } from "../../api/client.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Loading } from "../../components/ui.tsx";
import { useAsync } from "../../lib/use-async.ts";
import { refreshProjects, useClient, useUiStore } from "../../store/context.tsx";

/**
 * Make one project (d1109-onerepo-join, D1, ADR 0117 amended): the projects on this computer that
 * work in the same repository or folder, each with its open and done tasks, open pull requests,
 * what it spent so far in CHF, its budget per session, project budget, who merges and what
 * research reads (the daemon's `GET /projects/:id/join-preview`). The person chooses the one to
 * keep; nothing is chosen at first and Make one project stays disabled until one is ("without
 * guessing"). The kept project's settings that differ are named, each in one line, before the
 * press; what holds the join now (a session working, a plan waiting, a merge under way) is said
 * in its sentence and keeps the button disabled. The press is the yes (`project.join`, source
 * ui); Changes has its Undo. It lands on the kept project.
 */
export function JoinProjectsDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const client = useClient();
  const store = useUiStore();
  const navigate = useNavigate();
  const preview = useAsync(
    (signal) => (open ? client.joinPreview(projectId, [], signal) : Promise.resolve(null)),
    [client, projectId, open],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = preview.data;
  // A project worked on together with another Forerunner is the one kept (OJ-11).
  const keep = view?.keepOnly ?? chosen;
  const plan = keep && view ? view.ifKept[keep] : undefined;
  const others = view?.projects.filter((p) => p.id !== keep) ?? [];

  const close = () => {
    setChosen(null);
    setError(null);
    onClose();
  };

  const join = async () => {
    if (!keep || busy || plan?.refusal) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.executeCommands({
        commands: [{ name: "project.join", params: { keep, close: others.map((p) => p.id) } }],
        wordsUsed: "Make one project (Overview)",
        source: "ui",
        projectId: keep,
        confirm: "tap",
      });
      if (r.status === "done" || r.status === "partial") {
        await refreshProjects(client, store).catch(() => undefined);
        close();
        navigate(`/projects/${encodeURIComponent(keep)}/summary`);
      } else setError(r.reason ?? "The projects were not made one.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Make one project" testId="join-projects-dialog">
      <div className="space-y-3 text-sm">
        {preview.loading && !view ? <Loading what="the projects" /> : null}
        {preview.error ? <ErrorBanner message={preview.error} onRetry={preview.reload} /> : null}
        {view?.shared ? <p data-testid="join-shared-line">{view.shared.text}</p> : null}
        {view ? (
          <fieldset className="space-y-2">
            <legend className="font-medium">Which project do you keep?</legend>
            {view.projects.map((p) => (
              <label
                key={p.id}
                className="flex items-start gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800"
                data-testid={`join-project-${p.id}`}
              >
                <input
                  type="radio"
                  name="join-keep"
                  value={p.id}
                  checked={keep === p.id}
                  disabled={!!view.keepOnly && view.keepOnly !== p.id}
                  onChange={() => setChosen(p.id)}
                  data-testid="join-keep"
                  aria-label={`Keep "${p.name}"`}
                />
                <span className="space-y-0.5">
                  <span className="block font-medium">Keep "{p.name}"</span>
                  {p.lines.map((line) => (
                    <span
                      key={line}
                      className="block text-xs text-neutral-600 dark:text-neutral-400"
                    >
                      {line}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {view?.keepOnlyLine ? <p data-testid="join-keep-only">{view.keepOnlyLine}</p> : null}
        {plan ? (
          <div className="space-y-1" data-testid="join-plan">
            <p>{plan.moves}</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">{plan.stays}</p>
            {plan.settings.map((line) => (
              <p key={line} className="text-xs" data-testid="join-setting">
                {line}
              </p>
            ))}
          </div>
        ) : null}
        {plan?.refusal ? (
          <p className="text-amber-800 dark:text-amber-300" data-testid="join-refusal">
            {plan.refusal}
          </p>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void join()}
            disabled={!keep || !plan || !!plan.refusal || busy || others.length === 0}
            data-testid="join-confirm"
            title={MAKE_ONE_EXPLAIN}
          >
            {busy ? "Making one project…" : "Make one project"}
          </Button>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">Changes has its Undo.</p>
      </div>
    </Dialog>
  );
}
