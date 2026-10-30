import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { describeError } from "../api/client.ts";
import type { AppUpdateView, ModelWatchAnswerInput, UpdatesView } from "../api/contracts.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { Badge, Button, ErrorBanner, Loading, type Tone } from "../components/ui.tsx";
import { formatBytes } from "../lib/format.ts";
import { formatDateTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

export function appStateTone(state: AppUpdateView["state"]): Tone {
  switch (state) {
    case "up_to_date":
      return "good";
    case "available":
      return "info";
    case "pending_health_check":
      return "warn";
    case "rolled_back":
    case "failed":
    case "rejected":
      return "bad";
    default:
      return "neutral";
  }
}

/**
 * A release whose artefact for this platform is an OS installer (the desktop's MSI, AppImage or
 * `.deb`): the staged install of ADR 0015 cannot run it, so the screen offers the download
 * instead of "Update and restart", which would roll back (ADR 0092; updates.md Known issues).
 */
export function isInstallerArtifact(name: string | null): boolean {
  return name !== null && /\.(msi|exe|appimage|deb|rpm)$/i.test(name);
}

/**
 * Updates screen (spec M.3 to M.5): the app's version and the available release with its
 * changelog and "Update and restart", connector updates and model updates (the model watch's
 * recommendations with adopt / ignore / remind). Opening the screen reads the daemon's local
 * state only; the release feed is asked only when the human presses "Check for updates", and
 * installing is its own click (the human's decision of 2026-10-25, ADR 0015 amendment).
 */
export function UpdatesPage() {
  const client = useClient();
  const { restart, connection, me } = useUiState((s) => s);
  const loaded = useAsync<UpdatesView>((signal) => client.updates(signal), [client]);
  const [checked, setChecked] = useState<UpdatesView | null>(null);
  const [checking, setChecking] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  // After an apply or a rollback the earlier check describes another install: show the
  // daemon's local state again (it forgets that check too).
  const forgetCheck = () => {
    setChecked(null);
    setFeedError(null);
    loaded.reload();
  };
  // An apply restarts the daemon: forget the check once the restart is over.
  const wasRestarting = useRef(false);
  useEffect(() => {
    if (restart) wasRestarting.current = true;
    else if (wasRestarting.current) {
      wasRestarting.current = false;
      forgetCheck();
    }
  });
  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    setFeedError(null);
    try {
      const v = await client.checkUpdates();
      setChecked(v);
      if (v.app.lastError) setFeedError(v.app.lastError);
    } catch (error) {
      setFeedError(describeError(error));
    } finally {
      setChecking(false);
    }
  };
  const watch = useAsync((signal) => client.modelWatchLatest(signal), [client]);
  const reports = useAsync((signal) => client.modelWatchReports(10, signal), [client]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<Record<string, boolean>>({});

  const act = async (key: string, action: () => Promise<string>) => {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      setActionNote(await action());
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const view = checked ?? loaded.data;
  const app = view?.app;
  const report = watch.data?.report ?? null;
  const health = watch.data?.health ?? null;
  const recommendations = report?.recommendations ?? [];
  const chosen = recommendations.filter((r) => adopt[r.id] ?? true).map((r) => r.id);

  const answer = (decision: ModelWatchAnswerInput["decision"]) => {
    if (!report) return;
    const by = me?.id ?? "human";
    void act(`mw-${decision}`, async () => {
      const r = await client.modelWatchAnswer(report.id, {
        decision,
        by,
        ...(decision === "adopt" ? { adopt: chosen } : {}),
      });
      watch.reload();
      reports.reload();
      return `Model watch: ${r.decision}${r.applied.length > 0 ? ` (applied ${r.applied.join(", ")})` : ""}.`;
    });
  };

  return (
    <section aria-labelledby="updates-title" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 id="updates-title" className="text-xl font-semibold">
          Updates
        </h1>
        {view ? (
          <span className="text-xs text-neutral-500" data-testid="updates-checked-at">
            {view.app.checkedAt
              ? `last checked ${formatDateTime(view.app.checkedAt)}`
              : "not checked yet"}
          </span>
        ) : null}
        <Button
          variant="ghost"
          className="ml-auto"
          disabled={checking}
          onClick={() => void checkNow()}
          data-testid="updates-check"
        >
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </div>
      {restart ? (
        <output
          className="block rounded border border-blue-300 bg-blue-50 p-2 text-sm dark:border-blue-800 dark:bg-blue-950"
          data-testid="restart-notice"
        >
          Restarting: {restart.reason} from {restart.fromVersion} to {restart.targetVersion}. The
          daemon comes back on its own; this page reconnects.
        </output>
      ) : null}
      {feedError ? (
        <ErrorBanner
          message={`Release feed not reachable (${feedError}); showing what this daemon knows.`}
          testId="feed-error"
        />
      ) : null}
      {loaded.loading && !loaded.data ? <Loading what="updates" /> : null}
      {loaded.error && !loaded.data ? (
        <ErrorBanner message={loaded.error} onRetry={loaded.reload} />
      ) : null}
      {actionError ? <ErrorBanner message={actionError} testId="updates-error" /> : null}
      {actionNote ? (
        <output className="block text-sm" data-testid="updates-note">
          {actionNote}
        </output>
      ) : null}

      {app ? (
        <div
          className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
          data-testid="app-update"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">App</h2>
            <Badge tone={appStateTone(app.state)} testId="app-state">
              {app.state.replace(/_/g, " ")}
            </Badge>
            <span className="text-sm" data-testid="app-version">
              running {app.runningVersion}
              {app.currentVersion !== app.runningVersion
                ? ` · installed ${app.currentVersion}`
                : ""}
            </span>
            <Badge>{app.channel}</Badge>
            {connection.health ? (
              <span className="text-xs text-neutral-500">
                daemon reports v{connection.health.version}
              </span>
            ) : null}
          </div>
          {app.available ? (
            <div
              className="mt-2 rounded border border-blue-200 p-2 dark:border-blue-900"
              data-testid="available-update"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Update available: {app.available.version}</span>
                <span className="text-xs text-neutral-500">
                  published {formatDateTime(app.available.publishedAt)}
                  {app.available.sizeBytes ? ` · ${formatBytes(app.available.sizeBytes)}` : ""}
                  {app.available.artifactName ? ` · ${app.available.artifactName}` : ""}
                </span>
                {isInstallerArtifact(app.available.artifactName) ? (
                  <span className="ml-auto">
                    {app.available.artifactUrl ? (
                      <ExternalLink href={app.available.artifactUrl} testId="download-installer">
                        Download the installer
                      </ExternalLink>
                    ) : null}
                  </span>
                ) : (
                  <Button
                    variant="primary"
                    className="ml-auto"
                    disabled={busy !== null || restart !== null}
                    onClick={() => {
                      const version = app.available?.version;
                      void act("apply", async () => {
                        const r = await client.applyUpdate(version);
                        return `Staged ${r.version} (${r.state}); ${r.restarting ? "restarting now" : "restart pending"}.`;
                      });
                    }}
                    data-testid="update-and-restart"
                  >
                    Update and restart
                  </Button>
                )}
              </div>
              {isInstallerArtifact(app.available.artifactName) ? (
                <p className="mt-1 text-sm" data-testid="installer-note">
                  This release updates through its installer: download it, close Forerunner and run
                  it. Your settings, keys and projects stay. The app replaces its background service
                  when it starts.
                </p>
              ) : null}
              <details className="mt-2 text-sm" open>
                <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
                  Changelog
                </summary>
                <pre
                  className="mt-1 whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900"
                  data-testid="changelog"
                >
                  {app.available.changelog || "No changelog."}
                </pre>
              </details>
            </div>
          ) : (
            <p
              className="mt-2 text-sm text-neutral-600 dark:text-neutral-400"
              data-testid="no-update"
            >
              {app.state === "up_to_date"
                ? `You are on the latest ${app.channel} release.`
                : app.checkedAt
                  ? `No newer release known (checked ${formatDateTime(app.checkedAt)}).`
                  : "The feed has not been checked yet."}
            </p>
          )}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {app.previousVersion ? (
              <>
                <dt className="text-neutral-500">Previous version</dt>
                <dd>
                  {app.previousVersion}{" "}
                  <Button
                    variant="ghost"
                    disabled={busy !== null || restart !== null}
                    onClick={() =>
                      void act("rollback", async () => {
                        const r = await client.rollbackUpdate("from the updates screen");
                        forgetCheck();
                        return `Rolling back from ${r.from} to ${r.to ?? "the previous version"} (${r.state}).`;
                      })
                    }
                    data-testid="rollback"
                  >
                    Roll back and restart
                  </Button>
                </dd>
              </>
            ) : null}
            {app.lastRollback ? (
              <>
                <dt className="text-neutral-500">Last rollback</dt>
                <dd data-testid="last-rollback">
                  {app.lastRollback.from} → {app.lastRollback.to ?? "?"} ({app.lastRollback.reason},{" "}
                  {app.lastRollback.automatic ? "automatic" : "manual"},{" "}
                  {formatDateTime(app.lastRollback.at)})
                </dd>
              </>
            ) : null}
            {app.rejected.length > 0 ? (
              <>
                <dt className="text-neutral-500">Rejected</dt>
                <dd data-testid="rejected-updates">
                  {app.rejected.map((r) => (
                    <p key={r.version}>
                      {r.version}: {r.reason} ({r.message})
                    </p>
                  ))}
                </dd>
              </>
            ) : null}
            {app.lastError ? (
              <>
                <dt className="text-neutral-500">Last error</dt>
                <dd className="text-red-700 dark:text-red-300">{app.lastError}</dd>
              </>
            ) : null}
          </dl>
          <p className="mt-2 text-xs text-neutral-500">
            Staged install with a health check on restart and an automatic rollback on failure;
            config, memory and data are untouched.
          </p>
        </div>
      ) : null}

      {view ? (
        <div data-testid="connector-updates">
          <h2 className="font-semibold">Connector updates</h2>
          {view.connectors.length === 0 ? (
            <p className="text-sm text-neutral-500">Every connector is on its latest version.</p>
          ) : (
            <table className="mt-1 w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr>
                  <th className="py-1 pr-2">Connector</th>
                  <th className="py-1 pr-2">Installed</th>
                  <th className="py-1 pr-2">Available</th>
                  <th className="py-1">Notes</th>
                </tr>
              </thead>
              <tbody>
                {view.connectors.map((c) => (
                  <tr
                    key={c.extensionId}
                    className="border-t border-neutral-100 dark:border-neutral-800"
                    data-testid="connector-update"
                  >
                    <td className="py-1 pr-2">
                      <Link
                        to="/extensions"
                        className="text-blue-700 hover:underline dark:text-blue-300"
                      >
                        {c.name}
                      </Link>{" "}
                      {!c.enabled ? <Badge>disabled</Badge> : null}
                    </td>
                    <td className="py-1 pr-2 font-mono text-xs">{c.installedVersion}</td>
                    <td className="py-1 pr-2 font-mono text-xs">{c.availableVersion}</td>
                    <td className="py-1 text-neutral-600 dark:text-neutral-400">
                      {c.notes ?? ""}
                      {c.sourceUrl ? (
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 text-blue-700 hover:underline dark:text-blue-300"
                        >
                          source
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-neutral-500">
            Connector versions change through the Extensions panel (remove and add the newer entry).
          </p>
        </div>
      ) : null}

      {view ? (
        <div data-testid="model-updates">
          <h2 className="font-semibold">Model updates</h2>
          {view.models.length === 0 ? (
            <p className="text-sm text-neutral-500">No model news from the watch.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {view.models.map((m) => (
                <li
                  key={`${m.provider}/${m.model}/${m.kind}`}
                  className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
                  data-testid="model-update"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{m.model}</span>
                    <Badge>{m.provider}</Badge>
                    <Badge tone={m.kind === "deprecation" ? "warn" : "info"}>
                      {m.kind.replace("_", " ")}
                    </Badge>
                    <span className="ml-auto text-xs text-neutral-500">
                      {formatDateTime(m.reportedAt)}
                    </span>
                  </div>
                  <p className="mt-1">{m.summary}</p>
                  {m.recommendedAction ? (
                    <p className="text-xs">Recommended: {m.recommendedAction}</p>
                  ) : null}
                  {m.evidence.length > 0 ? (
                    <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-400">
                      {m.evidence.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div
        className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        data-testid="model-watch"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Model watch</h2>
          <span className="text-xs text-neutral-500">
            Weekly: provider lists and prices, the eval set on new candidates and lower efforts.
          </span>
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() =>
              void act("mw-run", async () => {
                const r = await client.modelWatchRun();
                watch.reload();
                reports.reload();
                return `Model watch ran: ${r.report.summary}`;
              })
            }
            data-testid="model-watch-run"
          >
            Run now
          </Button>
        </div>
        {watch.loading && !watch.data ? <Loading what="model watch report" /> : null}
        {watch.error ? <ErrorBanner message={watch.error} onRetry={watch.reload} /> : null}
        {watch.data && !report ? (
          <p className="mt-1 text-sm text-neutral-500">No report yet.</p>
        ) : null}
        {report ? (
          <div
            className="mt-2 text-sm"
            data-testid="model-watch-latest"
            data-decision={health?.decision ?? ""}
          >
            <p>
              <span className="font-medium">{formatDateTime(report.generated_at)}</span>:{" "}
              {report.summary}
            </p>
            {health ? (
              <p className="mt-1 text-xs">
                Decision:{" "}
                <Badge tone={health.decision === "pending" ? "warn" : "neutral"}>
                  {health.decision}
                </Badge>
                {health.decided_at
                  ? ` by ${health.by ?? "?"} at ${formatDateTime(health.decided_at)}`
                  : ""}
                {health.applied.length > 0 ? ` · applied ${health.applied.join(", ")}` : ""}
              </p>
            ) : null}
            {recommendations.length > 0 ? (
              <ul className="mt-2 space-y-1" data-testid="recommendations">
                {recommendations.map((r) => (
                  <li key={r.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={adopt[r.id] ?? true}
                      onChange={(e) => setAdopt((prev) => ({ ...prev, [r.id]: e.target.checked }))}
                      disabled={health?.decision !== "pending"}
                      aria-label={`Adopt: ${r.text}`}
                    />
                    <span>
                      <Badge>{r.kind.replace("_", " ")}</Badge> {r.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {report.evals_deferred ? (
              <p className="mt-2 text-xs text-neutral-500" data-testid="model-watch-deferred">
                Evaluations not run: {report.evals_deferred.planned.length} eval set run(s) would
                cost money and count against your caps. Only Run evaluations (or the model_watch
                run_evals setting) runs them. Adopt applies the price rows only and runs no
                evaluation.
              </p>
            ) : null}
            {health?.decision === "pending" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={busy !== null || chosen.length === 0}
                  onClick={() => answer("adopt")}
                  data-testid="model-watch-adopt"
                >
                  Adopt selected
                </Button>
                {report.evals_deferred ? (
                  <Button
                    disabled={busy !== null}
                    onClick={() => answer("evaluate")}
                    data-testid="model-watch-evaluate"
                  >
                    Run evaluations
                  </Button>
                ) : null}
                <Button
                  disabled={busy !== null}
                  onClick={() => answer("ignore")}
                  data-testid="model-watch-ignore"
                >
                  Ignore
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() => answer("remind")}
                  data-testid="model-watch-remind"
                >
                  Remind me later
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {reports.data && reports.data.reports.length > 0 ? (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-neutral-500">
              {reports.data.reports.length} recent report
              {reports.data.reports.length === 1 ? "" : "s"}
            </summary>
            <table className="mt-1 w-full">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="py-0.5 pr-2">When</th>
                  <th className="py-0.5 pr-2">Decision</th>
                  <th className="py-0.5 pr-2">New</th>
                  <th className="py-0.5 pr-2">Retired</th>
                  <th className="py-0.5 pr-2">Repriced</th>
                  <th className="py-0.5">Summary</th>
                </tr>
              </thead>
              <tbody>
                {reports.data.reports.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-neutral-100 dark:border-neutral-800"
                    data-testid="model-watch-report"
                  >
                    <td className="py-0.5 pr-2">{formatDateTime(r.generated_at)}</td>
                    <td className="py-0.5 pr-2">{r.decision}</td>
                    <td className="py-0.5 pr-2">{r.new_models}</td>
                    <td className="py-0.5 pr-2">{r.retired_models}</td>
                    <td className="py-0.5 pr-2">{r.repriced}</td>
                    <td className="py-0.5">{r.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>
    </section>
  );
}
