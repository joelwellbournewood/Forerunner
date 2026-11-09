import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { describeError } from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { refreshProjects, useClient, useUiStore } from "../store/context.tsx";

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
 * "New project": name, goal, brief, repo link -> POST /projects, then open the project. The
 * Goal is optional when there is a brief: its first sentence is the goal (the dialog says so).
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

  const reset = () => {
    setName("");
    setGoal("");
    setBrief("");
    setRepo("");
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const goalText = goal.trim() || goalFromBrief(brief);
    if (!goalText) {
      setError("Give a goal or a brief: the agent plans from them.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const repos = repo.trim() ? [repo.trim()] : undefined;
      // A brief asks for the PM intake (spec A.2): the proposal lands in the inbox.
      // The new project is the active one for chat, voice and the phone too (U-056), in the
      // same change as the creation (W15-36: one Changes row, whose Undo removes the project
      // and makes the previous one active again; before, a project.switch followed it).
      const project = await client.createProject({
        name: name.trim(),
        goal: goalText,
        brief: brief.trim() || undefined,
        repos,
        ...(brief.trim() ? { intake: true } : {}),
        switch: true,
      });
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
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

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
            onChange={(e) => setRepo(e.target.value)}
            placeholder="https://github.com/org/repo"
            name="repo"
          />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy} data-testid="create-project">
            {busy ? "Creating…" : "Create project"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
