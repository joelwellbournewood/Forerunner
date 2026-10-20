import { Badge, Button, ErrorBanner, Loading, statusTone } from "../../components/ui.tsx";
import { formatDateTime, relativeTime } from "../../lib/time.ts";
import { useAsync } from "../../lib/use-async.ts";
import { useClient } from "../../store/context.tsx";

/** Peers feed (spec F.6): what the other agents on the project are doing. */
export function PeersSection({ projectId }: { projectId: string }) {
  const client = useClient();
  const feed = useAsync((signal) => client.peers(projectId, signal), [client, projectId]);

  return (
    <section data-testid="peers" aria-labelledby="peers-title">
      <div className="flex items-center gap-2">
        <h2 id="peers-title" className="font-semibold">
          Peers
        </h2>
        {feed.data ? (
          <span className="text-xs text-neutral-500">
            as of {formatDateTime(feed.data.generatedAt)}
          </span>
        ) : null}
        <Button variant="ghost" className="ml-auto" onClick={feed.reload}>
          Refresh
        </Button>
      </div>
      {feed.loading && !feed.data ? <Loading what="peer feed" /> : null}
      {feed.error && !feed.data ? <ErrorBanner message={feed.error} onRetry={feed.reload} /> : null}
      {feed.data && feed.data.peers.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="peers-empty">
          No other agent works on this project (solo mode).
        </p>
      ) : null}
      <ul className="mt-1 space-y-2">
        {feed.data?.peers.map((p) => (
          <li
            key={p.agentId}
            className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
            data-testid="peer"
            data-agent-id={p.agentId}
            data-online={p.online ? "true" : "false"}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.agentName}</span>
              <Badge tone={p.online ? "good" : "neutral"}>{p.online ? "online" : "offline"}</Badge>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-neutral-500">Claims</dt>
              <dd>
                {p.activeClaims.length === 0 ? (
                  "none"
                ) : (
                  <ul className="space-y-0.5">
                    {p.activeClaims.map((c) => (
                      <li key={c.taskId} data-testid="peer-claim">
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge> {c.title}
                        {c.expiresAt ? (
                          <span className="text-neutral-500">
                            {" "}
                            · expires {relativeTime(c.expiresAt)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="text-neutral-500">Open PRs</dt>
              <dd>
                {p.openPullRequests.length === 0 ? (
                  "none"
                ) : (
                  <ul className="space-y-0.5">
                    {p.openPullRequests.map((pr) => (
                      <li key={pr.url}>
                        <a
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 hover:underline dark:text-blue-300"
                          data-testid="peer-pr"
                        >
                          {pr.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="text-neutral-500">Last handoff</dt>
              <dd data-testid="peer-handoff">
                {p.lastHandoff ? (
                  <>
                    <p>
                      {p.lastHandoff.summary}{" "}
                      <span className="text-neutral-500">({relativeTime(p.lastHandoff.at)})</span>
                    </p>
                    {p.lastHandoff.inFlight.length > 0 ? (
                      <p>In flight: {p.lastHandoff.inFlight.join(", ")}</p>
                    ) : null}
                    {p.lastHandoff.blocked.length > 0 ? (
                      <p>Blocked: {p.lastHandoff.blocked.join(", ")}</p>
                    ) : null}
                    {p.lastHandoff.next.length > 0 ? (
                      <p>Next: {p.lastHandoff.next.join(", ")}</p>
                    ) : null}
                  </>
                ) : (
                  "none yet"
                )}
              </dd>
              {Object.keys(p.inFlightFiles).length > 0 ? (
                <>
                  <dt className="text-neutral-500">Files in flight</dt>
                  <dd>
                    {Object.entries(p.inFlightFiles).map(([taskId, files]) => (
                      <p key={taskId} data-testid="peer-files">
                        <span className="font-mono">{taskId}</span>: {files.join(", ")}
                      </p>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
