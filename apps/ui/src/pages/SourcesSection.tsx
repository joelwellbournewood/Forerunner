import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import {
  type AddSourceBody,
  describeError,
  type SourceCandidateView,
  type SourceView,
} from "../api/client.ts";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
} from "../components/ui.tsx";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { refreshProjects, useClient, useUiStore } from "../store/context.tsx";

/** The kinds a scan supports today; GitLab and plain remotes come later (the daemon refuses them). */
export const SOURCE_KIND_OPTIONS: { value: AddSourceBody["kind"]; label: string; hint: string }[] =
  [
    { value: "github_org", label: "GitHub organisation", hint: "the org's login, e.g. acme" },
    { value: "github_user", label: "GitHub account", hint: "the user's login" },
    { value: "github_repo", label: "GitHub repository", hint: "owner/name or the repository URL" },
    {
      value: "local_folder",
      label: "Local folder",
      hint: "an absolute path; its subfolders become proposals",
    },
  ];

export function kindLabel(kind: SourceView["kind"]): string {
  return SOURCE_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;
}

export function candidateTone(
  status: SourceCandidateView["status"],
): "good" | "warn" | "bad" | "neutral" | "info" {
  switch (status) {
    case "proposed":
      return "info";
    case "accepted":
      return "good";
    case "duplicate":
      return "warn";
    default:
      return "neutral";
  }
}

/** "1 proposed, 1 accepted, 1 duplicate, 1 with an install" from a source's counts. */
export function countsLine(c: SourceView["candidates"]): string {
  if (c.total === 0) return "nothing found yet";
  const parts = [
    `${c.proposed} proposed`,
    c.accepted ? `${c.accepted} accepted` : null,
    c.duplicate ? `${c.duplicate} duplicate` : null,
    c.gone ? `${c.gone} gone` : null,
    c.installs ? `${c.installs} with an existing install` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(", ");
}

function AddSourceForm({ onAdded }: { onAdded: () => void }) {
  const client = useClient();
  const [kind, setKind] = useState<AddSourceBody["kind"]>("github_org");
  const [locator, setLocator] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const github = kind !== "local_folder";
  const option = SOURCE_KIND_OPTIONS.find((k) => k.value === kind);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.addSource({
        kind,
        locator: locator.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(github && credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
      });
      setLocator("");
      setDisplayName("");
      setCredentialRef("");
      onAdded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 grid gap-2 md:grid-cols-2"
      data-testid="add-source-form"
    >
      <Field label="Kind">
        <select
          className={INPUT_CLASS}
          value={kind}
          onChange={(e) => setKind(e.target.value as AddSourceBody["kind"])}
          data-testid="add-source-kind"
        >
          {SOURCE_KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Locator" hint={option?.hint}>
        <input
          className={INPUT_CLASS}
          value={locator}
          onChange={(e) => setLocator(e.target.value)}
          required
          name="locator"
          data-testid="add-source-locator"
        />
      </Field>
      <Field label="Display name" hint="Optional.">
        <input
          className={INPUT_CLASS}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          name="displayName"
          data-testid="add-source-name"
        />
      </Field>
      {github ? (
        <Field
          label="Token reference"
          hint="A reference to the vault (secret:<name>), never the token itself; default secret:github_token from fr setup."
        >
          <input
            className={INPUT_CLASS}
            value={credentialRef}
            onChange={(e) => setCredentialRef(e.target.value)}
            placeholder="secret:github_token"
            name="credentialRef"
            data-testid="add-source-credential"
          />
        </Field>
      ) : null}
      {error ? (
        <div className="md:col-span-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <Button variant="primary" type="submit" disabled={busy} data-testid="add-source">
          {busy ? "Connecting…" : "Connect source"}
        </Button>
      </div>
    </form>
  );
}

function CandidateRow({
  candidate,
  onAccepted,
}: {
  candidate: SourceCandidateView;
  onAccepted: (next: SourceCandidateView, project: { id: string; name: string }) => void;
}) {
  const client = useClient();
  const store = useUiStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.acceptCandidate(candidate.id);
      try {
        store.dispatch({
          type: "project.upsert",
          project: await client.project(result.project.id),
        });
      } catch {
        // the card can be fetched later; the list refresh below covers it
      }
      void refreshProjects(client, store).catch(() => {});
      onAccepted(result.candidate, result.project);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="flex flex-wrap items-center gap-2 border-t border-neutral-100 py-1 text-sm dark:border-neutral-800"
      data-testid="candidate"
      data-candidate-id={candidate.id}
      data-status={candidate.status}
    >
      <span className="font-medium">{candidate.proposedName}</span>
      <code className="text-xs text-neutral-500">{candidate.locator}</code>
      <Badge tone={candidateTone(candidate.status)} testId="candidate-status">
        {candidate.status}
      </Badge>
      {candidate.existingInstall ? (
        <Badge tone="warn" testId="candidate-install">
          existing install{candidate.installMarker ? ` (${candidate.installMarker})` : ""}
        </Badge>
      ) : null}
      {candidate.kind === "folder" && !candidate.isGit ? <Badge>not a git repository</Badge> : null}
      {candidate.projectId ? (
        <Link
          to={`/projects/${encodeURIComponent(candidate.projectId)}`}
          className="text-blue-700 hover:underline dark:text-blue-300"
          data-testid="candidate-project"
        >
          {candidate.status === "duplicate" ? "already a project" : "open project"}
        </Link>
      ) : null}
      {candidate.status === "proposed" ? (
        <Button variant="primary" onClick={accept} disabled={busy} data-testid="candidate-accept">
          {busy ? "Creating…" : "Create project"}
        </Button>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </li>
  );
}

function SourceRow({ source, onChanged }: { source: SourceView; onChanged: () => void }) {
  const client = useClient();
  const [candidates, setCandidates] = useState<SourceCandidateView[] | null>(null);
  const [busy, setBusy] = useState<"scan" | "load" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  const run = async (what: "scan" | "load" | "remove", action: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const scan = () =>
    run("scan", async () => {
      const result = await client.scanSource(source.id);
      setCandidates(result.candidates);
      onChanged();
    });
  const load = () =>
    run("load", async () => {
      setCandidates(await client.sourceCandidates(source.id));
    });
  const remove = () =>
    run("remove", async () => {
      await client.removeSource(source.id);
      setConfirmRemove(false);
      onChanged();
    });

  return (
    <li
      className="rounded border border-neutral-200 p-2 dark:border-neutral-800"
      data-testid="source"
      data-source-id={source.id}
      data-kind={source.kind}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{source.displayName}</span>
        <Badge>{kindLabel(source.kind)}</Badge>
        <code className="text-xs text-neutral-500">{source.locator}</code>
        {source.credentialRef ? (
          <code className="text-xs text-neutral-500" data-testid="source-credential">
            {source.credentialRef}
          </code>
        ) : null}
        <Badge tone={source.status === "error" ? "bad" : "good"} testId="source-status">
          {source.status}
        </Badge>
        <span className="text-xs text-neutral-500" data-testid="source-counts">
          {source.lastScanAt
            ? `scanned ${formatDateTime(source.lastScanAt)}: ${countsLine(source.candidates)}`
            : "not scanned yet"}
        </span>
        <span className="ml-auto flex gap-1">
          <Button onClick={scan} disabled={busy !== null} data-testid="source-scan">
            {busy === "scan" ? "Scanning…" : source.lastScanAt ? "Rescan" : "Scan"}
          </Button>
          {source.lastScanAt && candidates === null ? (
            <Button
              variant="ghost"
              onClick={load}
              disabled={busy !== null}
              data-testid="source-candidates"
            >
              Candidates
            </Button>
          ) : null}
          {confirmRemove ? (
            <Button
              variant="danger"
              onClick={remove}
              disabled={busy !== null}
              data-testid="source-remove-confirm"
            >
              Remove (projects stay)
            </Button>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
              data-testid="source-remove"
            >
              Remove
            </Button>
          )}
        </span>
      </div>
      {source.status === "error" && source.error ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300" data-testid="source-error">
          Last scan failed: {source.error}
        </p>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      {created ? (
        <p className="mt-1 text-xs" data-testid="source-created">
          Project created:{" "}
          <Link
            to={`/projects/${encodeURIComponent(created.id)}`}
            className="text-blue-700 hover:underline dark:text-blue-300"
          >
            {created.name}
          </Link>
        </p>
      ) : null}
      {candidates ? (
        candidates.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500">
            Nothing to propose: no repository or folder found.
          </p>
        ) : (
          <ul className="mt-2" data-testid="candidates">
            {candidates.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                onAccepted={(next, project) => {
                  setCandidates((prev) => (prev ?? []).map((x) => (x.id === next.id ? next : x)));
                  setCreated(project);
                  onChanged();
                }}
              />
            ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

/**
 * Sources (spec A.4): connect a GitHub org, account or repository, or a local folder; scan
 * it for one proposed project per repository or folder (duplicates and existing installs
 * marked, never proposed twice), create a project from a proposal, rescan or remove at any
 * time. Tokens are named by vault reference and never pasted here.
 */
export function SourcesSection() {
  const client = useClient();
  const sources = useAsync((signal) => client.sources(signal), [client]);

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="sources"
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-semibold">Sources</h2>
        <span className="text-xs text-neutral-500">
          Connect GitHub organisations, accounts, repositories or local folders; a scan proposes one
          project per repository or folder and never one that exists already.
        </span>
      </div>
      {sources.loading && !sources.data ? <Loading what="sources" /> : null}
      {sources.error ? (
        sources.routeMissing ? (
          <EmptyState testId="sources-missing">
            This daemon has no source discovery route.
          </EmptyState>
        ) : (
          <ErrorBanner message={sources.error} onRetry={sources.reload} />
        )
      ) : null}
      {sources.data && sources.data.length === 0 ? (
        <EmptyState testId="sources-empty">No sources connected yet.</EmptyState>
      ) : null}
      {sources.data && sources.data.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {sources.data.map((s) => (
            <SourceRow key={s.id} source={s} onChanged={sources.reload} />
          ))}
        </ul>
      ) : null}
      {sources.routeMissing ? null : <AddSourceForm onAdded={sources.reload} />}
    </div>
  );
}
