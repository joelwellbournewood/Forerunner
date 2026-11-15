import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, type CreateProjectBody, describeError } from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { refreshProjects, switchActiveProject, useClient, useUiStore } from "../store/context.tsx";

/** Longest goal taken from a brief's first sentence. */
const GOAL_FROM_BRIEF_CHARS = 160;

/**
 * The goal a brief gives when the Goal is left empty: its first sentence (or first line),
 * without the closing full stop, cut at a word to `GOAL_FROM_BRIEF_CHARS`. Live (2026-11-01) the
 * dialog refused a one-line brief until a Goal was typed, often the same words again.
 */
export function goalFromBrief(brief: string): string {
  const first = (brief.trim().split(/\r?\n/)[0] ?? "").trim();
  const sentence = (/^(.+?[.!?])(?:\s|$)/.exec(first)?.[1] ?? first).replace(/\.$/, "").trim();
  if (sentence.length <= GOAL_FROM_BRIEF_CHARS) return sentence;
  const cut = sentence.slice(0, GOAL_FROM_BRIEF_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > GOAL_FROM_BRIEF_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/**
 * d1109-onerepo-link (D1, ADR 0117): what the daemon offered for a link another project uses,
 * in its own words. `inUse`: a project on this computer (Open it, Add to it, Cancel);
 * `elsewhere`: the repository's Forerunner project that is not on this computer (Work together
 * first, Take it over only when the daemon allows it, Cancel).
 */
type LinkOffer =
  | { kind: "inUse"; message: string; projectId: string; projectName: string }
  | {
      kind: "elsewhere";
      message: string;
      projects: string[];
      canWorkTogether: boolean;
      canTakeOver: boolean;
      togetherLine: string | null;
      takeOverLine: string | null;
      takeOverDetails: string | null;
    };

/** The offer a refusal of `POST /projects` carries, or null for any other error. */
export function linkOfferOf(err: unknown): LinkOffer | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.details) return null;
  const d = err.details;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (d.cause === "repository_in_use" && text(d.projectId))
    return {
      kind: "inUse",
      message: err.message,
      projectId: String(d.projectId),
      projectName: text(d.projectName) ?? "",
    };
  if (d.cause === "repository_used_elsewhere" && Array.isArray(d.projects))
    return {
      kind: "elsewhere",
      message: err.message,
      projects: d.projects.filter((p): p is string => typeof p === "string"),
      canWorkTogether: d.canWorkTogether === true,
      canTakeOver: d.canTakeOver === true,
      togetherLine: text(d.togetherLine),
      takeOverLine: text(d.takeOverLine),
      takeOverDetails: text(d.takeOverDetails),
    };
  return null;
}

/**
 * "New project": name, goal, brief, repo link -> POST /projects, then open the project. The
 * Goal is optional when there is a brief: its first sentence is the goal (the dialog says so).
 * A link another project uses gets the daemon's offer instead of a second project (D1).
 */
export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useClient();
  const store = useUiStore();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [brief, setBrief] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<LinkOffer | null>(null);

  const reset = () => {
    setName("");
    setGoal("");
    setBrief("");
    setRepo("");
    setError(null);
    setOffer(null);
  };

  /** What the dialog sends for a new project (the offer's buttons add to it). */
  const bodyNow = (): CreateProjectBody | null => {
    const goalText = goal.trim() || goalFromBrief(brief);
    if (!goalText) return null;
    const repos = repo.trim() ? [repo.trim()] : undefined;
    // A brief asks for the PM intake (spec A.2): the proposal lands in the inbox.
    // The new project is the active one for chat, voice and the phone too (U-056), in the
    // same change as the creation (W15-36: one Changes row, whose Undo removes the project
    // and makes the previous one active again; before, a project.switch followed it).
    return {
      name: name.trim(),
      goal: goalText,
      brief: brief.trim() || undefined,
      repos,
      ...(brief.trim() ? { intake: true } : {}),
      switch: true,
    };
  };

  /** Open a project that exists (the offer's Open it and Add to it land there). */
  const land = async (projectId: string) => {
    await switchActiveProject(client, store, projectId);
    void refreshProjects(client, store).catch(() => {});
    reset();
    onClose();
    navigate(`/projects/${encodeURIComponent(projectId)}`);
  };

  const create = async (extra: Partial<CreateProjectBody> = {}) => {
    const body = bodyNow();
    if (!body) {
      setError("Give a goal or a brief: the agent plans from them.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await client.createProject({ ...body, ...extra });
      store.dispatch({ type: "project.upsert", project });
      store.dispatch({ type: "activeProject", id: project.id });
      void client
        .me()
        .then((me) => store.dispatch({ type: "me", me }))
        .catch(() => {});
      void refreshProjects(client, store).catch(() => {});
      reset();
      onClose();
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch (err) {
      const found = linkOfferOf(err);
      if (found) setOffer(found);
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    await create();
  };

  /** Add to it: the brief (or the goal) becomes a plan of only the new work in that project. */
  const addTo = async (projectId: string) => {
    const text = brief.trim() || goal.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await client.proposeIntake(projectId, { brief: text });
      await land(projectId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const offerView = offer ? (
    <div
      className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-neutral-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      data-testid="link-offer"
      role="alert"
    >
      <p data-testid="link-offer-sentence">{offer.message}</p>
      {offer.kind === "inUse" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            data-testid="offer-open"
            onClick={() => void land(offer.projectId)}
          >
            Open it
          </Button>
          {brief.trim() || goal.trim() ? (
            <Button
              disabled={busy}
              data-testid="offer-add"
              onClick={() => void addTo(offer.projectId)}
            >
              {busy ? "Adding…" : "Add to it"}
            </Button>
          ) : null}
          <Button disabled={busy} data-testid="offer-cancel" onClick={() => setOffer(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {offer.canWorkTogether && offer.projects[0] ? (
            <div>
              <Button
                variant="primary"
                disabled={busy}
                data-testid="offer-together"
                onClick={() => void create({ together: { project: offer.projects[0] ?? "" } })}
              >
                Work together
              </Button>
              {offer.togetherLine ? <p className="mt-1 text-xs">{offer.togetherLine}</p> : null}
            </div>
          ) : null}
          {offer.canTakeOver ? (
            <div>
              <Button
                disabled={busy}
                data-testid="offer-take-over"
                onClick={() => void create({ takeOver: { projects: offer.projects } })}
              >
                Take it over
              </Button>
              {offer.takeOverLine ? <p className="mt-1 text-xs">{offer.takeOverLine}</p> : null}
              {offer.takeOverDetails ? (
                <details className="text-xs">
                  <summary>Details</summary>
                  {offer.takeOverDetails}
                </details>
              ) : null}
            </div>
          ) : null}
          <Button disabled={busy} data-testid="offer-cancel" onClick={() => setOffer(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <Dialog open={open} onClose={onClose} title="New project" testId="new-project-dialog">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input
            className={INPUT_CLASS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            name="name"
          />
        </Field>
        <Field
          label="Goal"
          hint="One sentence: what done looks like. Optional: left empty, the first sentence you write below is the goal."
        >
          <input
            className={INPUT_CLASS}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            name="goal"
          />
        </Field>
        <Field
          label="Brief"
          hint="What you want, in your words. Without a repository, a sentence or two gets a small plan (up to three tasks); a list of features gets a full one."
        >
          <textarea
            className={`${INPUT_CLASS} min-h-28`}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            name="brief"
          />
        </Field>
        <Field label="Repository link" hint="Optional. A GitHub URL to import from.">
          <input
            className={INPUT_CLASS}
            value={repo}
            onChange={(e) => {
              setRepo(e.target.value);
              setOffer(null);
            }}
            placeholder="https://github.com/org/repo"
            name="repo"
          />
        </Field>
        {offerView}
        {error ? <ErrorBanner message={error} /> : null}
        {offer ? null : (
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy} data-testid="create-project">
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
