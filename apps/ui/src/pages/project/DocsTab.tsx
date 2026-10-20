import { useState } from "react";
import { RouteMissing } from "../../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, Loading } from "../../components/ui.tsx";
import { formatBytes } from "../../lib/format.ts";
import { formatDateTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** Docs tab (spec G.5): the standard doc set with the critic's drift check and a reader. */
export function DocsTab({ projectId }: { projectId: string }) {
  const client = useClient();
  const docs = useAsync((signal) => client.docs(projectId, signal), [client, projectId]);
  const [selected, setSelected] = useState<string | null>(null);
  const content = useAsync(
    (signal) => (selected ? client.doc(projectId, selected, signal) : Promise.resolve(null)),
    [client, projectId, selected],
  );

  if (docs.routeMissing) return <RouteMissing route="docs" what="the project's docs" />;
  if (docs.loading && !docs.data) return <Loading what="docs" />;
  if (docs.error && !docs.data) return <ErrorBanner message={docs.error} onRetry={docs.reload} />;
  const rows = docs.data ?? [];
  const present = rows.filter((d) => d.exists).length;
  const drifted = rows.filter((d) => d.drift).length;

  return (
    <div className="space-y-3" data-testid="docs">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge testId="docs-present">
          {present} of {rows.length} present
        </Badge>
        <Badge tone={drifted > 0 ? "warn" : "neutral"} testId="docs-drift">
          {drifted} drifted
        </Badge>
        <span className="text-xs text-neutral-500">
          Kept by the agent, checked for drift by the critic at tier 2 and above.
        </span>
        <Button variant="ghost" className="ml-auto" onClick={docs.reload}>
          Refresh
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No docs yet; the agent writes them from the brief.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 pr-2">Doc</th>
              <th className="py-1 pr-2">Path</th>
              <th className="py-1 pr-2">State</th>
              <th className="py-1 pr-2">Size</th>
              <th className="py-1">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.path}
                className="border-t border-neutral-100 dark:border-neutral-800"
                data-testid="doc-row"
                data-path={d.path}
                data-drift={d.drift ? "true" : "false"}
              >
                <td className="py-1 pr-2">
                  {d.exists ? (
                    <button
                      type="button"
                      className="text-blue-700 hover:underline dark:text-blue-300"
                      onClick={() => setSelected(d.path)}
                      data-testid="doc-open"
                    >
                      {d.title}
                    </button>
                  ) : (
                    d.title
                  )}
                </td>
                <td className="py-1 pr-2 font-mono text-xs">{d.path}</td>
                <td className="py-1 pr-2">
                  {!d.exists ? <Badge tone="bad">missing</Badge> : null}
                  {d.exists && d.drift ? (
                    <Badge tone="warn" title={d.note}>
                      drift
                    </Badge>
                  ) : null}
                  {d.exists && !d.drift ? <Badge tone="good">current</Badge> : null}
                  {d.note ? <span className="ml-1 text-xs text-neutral-500">{d.note}</span> : null}
                </td>
                <td className="py-1 pr-2">{d.exists ? formatBytes(d.sizeBytes) : "—"}</td>
                <td className="py-1 text-neutral-600 dark:text-neutral-400">
                  {formatDateTime(d.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected ? (
        <section
          className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
          data-testid="doc-content"
          aria-label={`Document ${selected}`}
        >
          <div className="flex items-center gap-2">
            <code className="text-xs">{selected}</code>
            {content.data ? (
              <span className="text-xs text-neutral-500">
                updated {formatDateTime(content.data.updatedAt)}
              </span>
            ) : null}
            <Button variant="ghost" className="ml-auto" onClick={() => setSelected(null)}>
              Close
            </Button>
          </div>
          {content.loading && !content.data ? <Loading what="document" /> : null}
          {content.error ? <ErrorBanner message={content.error} onRetry={content.reload} /> : null}
          {content.data ? (
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
              {content.data.content}
            </pre>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
