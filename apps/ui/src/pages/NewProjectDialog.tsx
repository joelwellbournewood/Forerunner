import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { describeError } from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { refreshProjects, useClient, useUiStore } from "../store/context.tsx";

/** "New project": name, goal, brief, repo link -> POST /projects, then open the project. */
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
    setBusy(true);
    setError(null);
    try {
      const repos = repo.trim() ? [repo.trim()] : undefined;
      const project = await client.createProject({
        name: name.trim(),
        goal: goal.trim(),
        brief: brief.trim() || undefined,
        repos,
      });
      store.dispatch({ type: "project.upsert", project });
      store.dispatch({ type: "activeProject", id: project.id });
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
        <Field label="Goal" hint="One sentence: what done looks like.">
          <input
            className={INPUT_CLASS}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            required
            name="goal"
          />
        </Field>
        <Field label="Brief" hint="Paste the brief; the agent plans milestones from it.">
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
