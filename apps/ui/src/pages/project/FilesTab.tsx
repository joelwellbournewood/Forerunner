import { useSearchParams } from "react-router";
import type { ProjectFileEntryView } from "../../api/client.ts";
import { FolderPath } from "../../components/FolderPath.tsx";
import { EmptyState, ErrorBanner, Loading } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

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
          This computer's copy of {repository.fullName} as merged. Work waiting in a pull request is
          on the Overview.
        </p>
      ) : null}
      {data.folder ? <FolderPath path={data.folder} /> : null}
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
