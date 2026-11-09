import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import type { ProjectFileEntryView, ProjectFilesView } from "../../api/client.ts";
import { FolderPath } from "../../components/FolderPath.tsx";
import { EmptyState, ErrorBanner, Loading } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient, useUiState } from "../../store/context.tsx";

/** What Open folder does on the Local only row (design §3.10). */
export const OPEN_LOCAL_ONLY_EXPLAIN = "Opens the Local only folder.";

/**
 * "14:05" today, "2 Nov, 14:05" another day: when this computer's copy was last brought to what
 * is merged (merged-copy, ADR 0113). The clock of the person's computer, 24 hours.
 */
export function copyUpdatedWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/**
 * The line above a repository project's files: whose copy it is, since when it is as merged
 * on GitHub (once it was brought there), and where the work in pull requests is. Before the
 * copy was first brought there (a copy made by an earlier version, until its first refresh) it
 * claims nothing about merges (review of merged-copy: "as merged" was not true then).
 */
export function repositoryLine(
  fullName: string,
  updatedAt: string | null | undefined,
  now = new Date(),
  stopped?: { line: string } | null,
): string {
  const where = "Work waiting in a pull request is on the Overview.";
  // leftovers7-merge2 (R-copystuck): a copy that stopped following what is merged says so and
  // why (the daemon's line), never "As merged" with a time that no longer moves.
  // W14-5 (polish-words): two sentences, what happened and what to do; the pull requests' line
  // is left out here (it made three, and has nothing to do with the stuck copy).
  if (stopped) {
    const since = updatedAt ? ` since ${copyUpdatedWords(updatedAt, now)}` : "";
    return `This computer's copy of ${fullName} has not followed merges${since}. ${stopped.line}`;
  }
  if (!updatedAt) return `This computer's copy of ${fullName}. ${where}`;
  return `This computer's copy of ${fullName}. As merged on GitHub, updated ${copyUpdatedWords(updatedAt, now)}. ${where}`;
}

/** "1.2 KB": a file's size in words. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files (design §3.10): what the work produced. The project's folder (its workspace, the
 * linked folder or this computer's checkout of its repository) as a tree with change dates;
 * a text file opens inline, read-only (`?path=` in the address, so a link from the Overview or
 * the task drawer opens it); **Open folder** in the desktop app, the path to copy in a
 * browser. Before, no screen showed the folder: Docs listed only the template docs and refused
 * index.html.
 */
export function FilesTab({
  projectId,
  repository = null,
}: {
  projectId: string;
  /** A project linked to a repository: the folder is this computer's copy of its default branch. */
  repository?: { fullName: string; url: string } | null;
}) {
  const client = useClient();
  const [params, setParams] = useSearchParams();
  const open = params.get("path");
  const files = useAsync((signal) => client.projectFiles(projectId, signal), [client, projectId]);
  // Live (merged-copy): the store re-reads the project card on every `project.changed`, which
  // the daemon sends when a merge brought this computer's copy up to date; the list follows.
  const card = useUiState((s) => s.projects.find((p) => p.id === projectId));
  const seenCard = useRef(card);
  const { reload } = files;
  useEffect(() => {
    if (seenCard.current === card) return;
    seenCard.current = card;
    reload();
  }, [card, reload]);

  if (files.loading && !files.data) return <Loading what="files" />;
  if (files.error && !files.data)
    return <ErrorBanner message={files.error} onRetry={files.reload} />;
  const data = files.data;
  if (!data) return null;
  const choose = (path: string | null) => {
    const next = new URLSearchParams(params);
    if (path) next.set("path", path);
    else next.delete("path");
    setParams(next);
  };

  return (
    <div className="space-y-3" data-testid="files-tab">
      {repository ? (
        // ADR 0106: the work of a repository project waits in pull requests until merged; this
        // folder is the default branch, so the page says so instead of looking incomplete.
        <p
          className="text-sm text-neutral-600 dark:text-neutral-400"
          data-testid="files-repository"
        >
          {repositoryLine(
            repository.fullName,
            data.copy?.updatedAt,
            undefined,
            data.copy?.stopped ?? null,
          )}
        </p>
      ) : null}
      {data.folder ? <FolderPath path={data.folder} /> : null}
      <LocalOnly copy={data.copy} />
      {data.entries.length === 0 ? (
        <EmptyState testId="files-empty">Nothing written yet.</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(16rem,1fr)_2fr]">
          <ul className="space-y-0.5 text-sm" data-testid="file-list">
            {data.entries.map((e) => (
              <FileRow key={e.path} entry={e} selected={e.path === open} onOpen={choose} />
            ))}
            {data.truncated ? (
              <li className="text-xs text-neutral-500">
                More files than this list shows: open the folder to see them all.
              </li>
            ) : null}
          </ul>
          {open ? (
            <FileView projectId={projectId} path={open} onClose={() => choose(null)} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * A repository project's Local only folder (the owner's decision of 2026-11-02, ADR 0113): its
 * one line, the path and Open folder; or the sentence when the repository already has a folder
 * of that name. Its files are in the list below like any other.
 */
function LocalOnly({ copy }: { copy: ProjectFilesView["copy"] }) {
  const local = copy?.localOnly;
  if (!local) return null;
  return (
    <div className="space-y-1" data-testid="local-only">
      <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="local-only-line">
        {local.folder ? (
          <>
            <span className="font-medium text-neutral-800 dark:text-neutral-200">Local only</span>
            {` · ${local.line}`}
          </>
        ) : (
          local.line
        )}
      </p>
      {local.folder ? (
        <FolderPath
          path={local.folder}
          testId="local-only-folder"
          explain={OPEN_LOCAL_ONLY_EXPLAIN}
        />
      ) : null}
    </div>
  );
}

function FileRow({
  entry,
  selected,
  onOpen,
}: {
  entry: ProjectFileEntryView;
  selected: boolean;
  onOpen: (path: string) => void;
}) {
  const depth = entry.path.split("/").length - 1;
  const name = entry.path.split("/").at(-1) ?? entry.path;
  const pad = { paddingLeft: `${depth * 1}rem` };
  if (entry.kind === "dir")
    return (
      <li style={pad} className="text-neutral-600 dark:text-neutral-400" data-testid="file-dir">
        {name}/
      </li>
    );
  return (
    <li style={pad} data-testid="file-row" data-path={entry.path}>
      <button
        type="button"
        onClick={() => onOpen(entry.path)}
        className={`text-left hover:underline ${
          selected
            ? "font-semibold text-blue-800 dark:text-blue-200"
            : "text-blue-700 dark:text-blue-300"
        }`}
      >
        {name}
      </button>{" "}
      <span className="text-xs text-neutral-500">
        {sizeWords(entry.sizeBytes)} · {relativeTime(entry.updatedAt)}
      </span>
    </li>
  );
}

function FileView({
  projectId,
  path,
  onClose,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const client = useClient();
  const file = useAsync(
    (signal) => client.projectFile(projectId, path, signal),
    [client, projectId, path],
  );
  return (
    <section
      className="min-w-0 rounded border border-neutral-200 dark:border-neutral-800"
      data-testid="file-view"
      aria-label={path}
    >
      <div className="flex items-center gap-2 border-b border-neutral-200 px-2 py-1 text-sm dark:border-neutral-800">
        <span className="font-medium" data-testid="file-view-path">
          {path}
        </span>
        <button
          type="button"
          className="ml-auto text-xs text-neutral-500 hover:underline"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {file.loading && !file.data ? <Loading what={path} /> : null}
      {file.error && !file.data ? <ErrorBanner message={file.error} /> : null}
      {file.data ? (
        file.data.content === null ? (
          <p className="p-2 text-sm text-neutral-500" data-testid="file-binary">
            Not a text file ({sizeWords(file.data.sizeBytes)}): open the folder to see it.
          </p>
        ) : (
          <pre
            className="max-h-[32rem] overflow-auto p-2 text-xs whitespace-pre-wrap"
            data-testid="file-content"
          >
            {file.data.content}
            {file.data.truncated ? "\n\n[Cut at 256 KB: open the folder to see the rest.]" : ""}
          </pre>
        )
      ) : null}
    </section>
  );
}
