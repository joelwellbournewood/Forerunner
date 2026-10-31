import { type FormEvent, useState } from "react";
import { type CommandResultJson, describeError } from "../../api/client.ts";
import { CommandResult } from "../../components/ChangeCardDialog.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { useClient, useUiState } from "../../store/context.tsx";

/** A repository name from a project's name, as the daemon names it (`repoNameFor`). */
export function repoNameFor(projectName: string): string {
  return projectName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

/**
 * Create a repository (U-037, ADR 0097): for a project without one, the `repo.create` command
 * that Chat ("create a repository") and the agent's proposal use. The form names the
 * repository (from the project's name), an organization (empty: the GitHub token's own
 * account) and private or public; the daemon answers with the change card (the name, where,
 * private or public), and Yes creates it, pushes the project's folder as the first commit and
 * links it. A public repository is high risk: the card asks for this paired device.
 */
export function CreateRepoDialog({
  open,
  onClose,
  projectId,
  projectName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  onCreated: () => void;
}) {
  const client = useClient();
  const desktopDeviceId = useUiState((s) => s.me?.desktopDeviceId ?? null);
  const [name, setName] = useState(() => repoNameFor(projectName));
  const [owner, setOwner] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [result, setResult] = useState<CommandResultJson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<CommandResultJson>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      setResult(r);
      if (r.status === "done") onCreated();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      client.executeCommands({
        commands: [
          {
            name: "repo.create",
            params: {
              project: projectId,
              private: isPrivate,
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(owner.trim() ? { owner: owner.trim() } : {}),
            },
          },
        ],
        wordsUsed: "Create a repository (project page)",
        source: "ui",
        projectId,
      }),
    );
  };

  const confirm = (answer: "yes" | "no") => {
    if (result?.status !== "pending" || !result.pendingId) return;
    const pendingId = result.pendingId;
    if (answer === "no") {
      void run(() => client.confirmCommand(pendingId, { answer: "no" }));
      return;
    }
    void run(() =>
      result.decision === "needs_device"
        ? client.confirmCommand(pendingId, {
            answer: "device",
            ...(desktopDeviceId ? { deviceId: desktopDeviceId } : {}),
          })
        : client.confirmCommand(pendingId, { answer: "tap" }),
    );
  };

  const finish = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={finish} title="Create a repository" testId="create-repo-dialog">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {projectName} has no repository: its tasks run in the project's folder on this computer,
          without branches, pull requests or reviews on GitHub. This creates a GitHub repository
          with your GitHub token, pushes the project's folder as the first commit and links it, so
          later tasks run on branches with pull requests.
        </p>
        {result === null || result.status === "refused" ? (
          <form onSubmit={submit} className="space-y-2">
            <Field label="Name">
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="create-repo-name"
              />
            </Field>
            <Field label="Organization" hint="Leave empty for your own GitHub account.">
              <input
                className={INPUT_CLASS}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                data-testid="create-repo-owner"
              />
            </Field>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
                data-testid="create-repo-private"
              />
              Private
            </label>
            {result?.status === "refused" ? (
              <ErrorBanner message={result.reason ?? "Refused."} />
            ) : null}
            {error ? <ErrorBanner message={error} /> : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={busy}
                data-testid="create-repo-preview"
              >
                Preview
              </Button>
              <Button variant="ghost" onClick={finish}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <CommandResult result={result} busy={busy} onConfirm={confirm} onDismiss={finish} />
            {error ? <ErrorBanner message={error} /> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
