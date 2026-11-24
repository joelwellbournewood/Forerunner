import type { JoinPreviewView } from "@forerunner/runtime/daemon/api-types";
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
  together = false,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /**
   * w8-together (OJ-11): the together form, for a project already here whose repository is
   * another Forerunner's project: one press makes it that project (the repository's id and name,
   * read from GitHub by the daemon) and moves its work there; nothing to choose.
   */
  together?: boolean;
}) {
  const client = useClient();
  const preview = useAsync(
    (signal) =>
      open
        ? together
          ? client.togetherPreview(projectId, signal)
          : client.joinPreview(projectId, [], signal)
        : Promise.resolve(null),
    [client, projectId, open, together],
  );
  if (together)
    return (
      <TogetherForm
        open={open}
        onClose={onClose}
        projectId={projectId}
        view={preview.data ?? null}
        loading={preview.loading}
        error={preview.error}
        reload={preview.reload}
      />
    );
  return (
    <PairForm
      open={open}
      onClose={onClose}
      view={preview.data ?? null}
      loading={preview.loading}
      error={preview.error}
      reload={preview.reload}
    />
  );
}

interface FormProps {
  open: boolean;
  onClose: () => void;
  view: JoinPreviewView | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * w8-together (OJ-11, W8-join-1, -2): Work together for a project already here. The daemon's
 * words: the one sentence of what the press does ('"Site" becomes "Kite club", the project GitHub
 * knows: ...'), the project's facts, the one line of what it writes on GitHub (only its own old
 * status pull request is closed, or nothing), what stays, and what holds it now (GitHub not
 * answering among them). The press is the yes (`project.join` with `keep: {together: true}`,
 * source ui); Changes has its Undo. It lands on the together project.
 */
function TogetherForm({
  open,
  onClose,
  projectId,
  view,
  loading,
  error: loadError,
  reload,
}: FormProps & { projectId: string }) {
  const client = useClient();
  const store = useUiStore();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = view?.together ?? null;
  const close = () => {
    setError(null);
    onClose();
  };
  const join = async () => {
    if (!t?.name || busy || t.refusal) return;
    setBusy(true);
    setError(null);
    try {
      const r = await client.executeCommands({
        commands: [
          { name: "project.join", params: { keep: { together: true }, close: [projectId] } },
        ],
        wordsUsed: "Work together (Overview)",
        source: "ui",
        projectId,
        confirm: "tap",
      });
      if (r.status === "done" || r.status === "partial") {
        await refreshProjects(client, store).catch(() => undefined);
        close();
        // The project it became (its id the daemon read from GitHub for the dialog).
        navigate(
          t.projectId ? `/projects/${encodeURIComponent(t.projectId)}/summary` : "/projects",
        );
      } else setError(r.reason ?? "The project was not joined.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const site = view?.projects[0] ?? null;
  return (
    <Dialog open={open} onClose={close} title="Work together" testId="join-together-dialog">
      <div className="space-y-3 text-sm">
        {loading && !view ? <Loading what="the repository's project" /> : null}
        {loadError ? <ErrorBanner message={loadError} onRetry={reload} /> : null}
        {t?.sentence ? <p data-testid="join-together-sentence">{t.sentence}</p> : null}
        {site ? (
          <div
            className="space-y-0.5 rounded border border-neutral-200 p-2 dark:border-neutral-800"
            data-testid={`join-project-${site.id}`}
          >
            <span className="block font-medium">"{site.name}"</span>
            {site.lines.map((line) => (
              <span key={line} className="block text-xs text-neutral-600 dark:text-neutral-400">
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {t?.github ? <p data-testid="join-together-github">{t.github}</p> : null}
        {t && !t.refusal ? (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">{t.stays}</p>
        ) : null}
        {t?.refusal ? (
          <p className="text-amber-800 dark:text-amber-300" data-testid="join-refusal">
            {t.refusal}
          </p>
        ) : null}
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void join()}
            disabled={!t?.name || !!t.refusal || busy}
            data-testid="join-together-confirm"
          >
            {busy ? "Working together…" : "Work together"}
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

function PairForm({ open, onClose, view, loading, error: loadError, reload }: FormProps) {
  const client = useClient();
  const store = useUiStore();
  const navigate = useNavigate();
  const preview = { data: view, loading, error: loadError, reload };
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
