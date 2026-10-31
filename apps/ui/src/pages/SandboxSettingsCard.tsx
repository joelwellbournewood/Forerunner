import {
  DOCKER_DESKTOP_URL,
  type SandboxPullEntryView,
  type SandboxState,
  type SandboxStatusView,
  sizeWords,
} from "@forerunner/runtime/sandbox/readiness-types";
import { useEffect, useRef, useState } from "react";
import { describeError } from "../api/client.ts";
import { followSandboxPull, pullProgress } from "../api/sandbox.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { useClient } from "../store/context.tsx";

/** The badge per state, in the person's words. */
export const SANDBOX_STATE_LABEL: Record<SandboxState, string> = {
  not_installed: "Docker not installed",
  not_running: "Docker not running",
  windows_containers: "Windows containers",
  image_missing: "not downloaded",
  pulling: "downloading",
  ready: "ready",
};

const LINE_TONES = {
  neutral: "text-neutral-700 dark:text-neutral-300",
  good: "text-emerald-800 dark:text-emerald-300",
  warn: "text-amber-800 dark:text-amber-300",
  bad: "text-red-800 dark:text-red-300",
} as const;

/**
 * Settings → Sandbox (Docker) (U-079, ADR 0101): whether full-review tasks can run, and the one
 * thing to do when they cannot: install Docker Desktop, start it, switch it to Linux
 * containers, download the sandbox (with its size and progress), or nothing (ready). Check
 * again looks at Docker afresh; tasks at risk tier 2 and above wait until this says ready.
 */
export function SandboxSettingsCard() {
  const client = useClient();
  const status = useAsync((signal) => client.sandboxStatus(signal), [client]);
  const [view, setView] = useState<SandboxStatusView | null>(null);
  const [entries, setEntries] = useState<SandboxPullEntryView[]>([]);
  const [busy, setBusy] = useState<"check" | "pull" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attached = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (status.data) setView(status.data);
  }, [status.data]);
  useEffect(() => () => abort.current?.abort(), []);

  const v = view ?? status.data;
  const job = v?.pull ?? null;
  const runningJobId = job?.state === "running" ? job.id : null;

  const follow = (afterSeq: number) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    followSandboxPull(
      client,
      afterSeq,
      (e) => setEntries((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e])),
      controller.signal,
    )
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(describeError(e));
      })
      .finally(async () => {
        if (controller.signal.aborted) return;
        try {
          setView(await client.sandboxStatus());
        } catch (e) {
          setError(describeError(e));
        }
      });
  };

  // A download already running when the page opens (started by a session, or another window).
  // biome-ignore lint/correctness/useExhaustiveDependencies: attach once per running download
  useEffect(() => {
    if (!runningJobId || !job || attached.current === runningJobId) return;
    attached.current = runningJobId;
    setEntries(job.recent);
    follow(job.recent.at(-1)?.seq ?? 0);
  }, [runningJobId]);

  const checkAgain = async () => {
    setBusy("check");
    setError(null);
    try {
      setView(await client.checkSandbox());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const download = async () => {
    setBusy("pull");
    setError(null);
    setEntries([]);
    try {
      const started = await client.pullSandbox();
      setView(started);
      if (started.pull) {
        attached.current = started.pull.id;
        follow(0);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  if (status.routeMissing) return <RouteMissing what="Sandbox (Docker)" route="sandboxStatus" />;
  const progress = pullProgress(entries.length ? entries : (job?.recent ?? []));
  const size = sizeWords(v?.downloadBytes ?? null);
  const pulling = v?.state === "pulling";

  return (
    <div
      id="sandbox"
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="sandbox-settings"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-semibold">Sandbox (Docker)</h2>
        {v ? (
          <Badge
            tone={v.ready ? "good" : v.state === "pulling" ? "info" : "warn"}
            testId="sandbox-state"
          >
            {SANDBOX_STATE_LABEL[v.state]}
          </Badge>
        ) : null}
      </div>
      {status.loading && !v ? <Loading what="the Docker sandbox" /> : null}
      {status.error && !v ? <ErrorBanner message={status.error} onRetry={status.reload} /> : null}
      {v ? (
        <>
          <p
            className="mt-1 text-sm text-neutral-600 dark:text-neutral-400"
            data-testid="sandbox-why"
          >
            {v.why}
          </p>
          <p className="mt-2 font-medium" data-testid="sandbox-headline">
            {v.headline}
          </p>
          {v.steps.length > 0 ? (
            <ol className="mt-1 list-decimal pl-5 text-sm" data-testid="sandbox-steps">
              {v.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : null}
          {v.state === "not_installed" && v.platform !== "linux" ? (
            <p className="mt-1 text-sm">
              <a
                href={DOCKER_DESKTOP_URL}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 hover:underline dark:text-blue-300"
                data-testid="sandbox-docker-link"
              >
                Get Docker Desktop
              </a>
            </p>
          ) : null}
          {v.waiting > 0 && !v.ready ? (
            <p
              className="mt-2 text-sm text-amber-800 dark:text-amber-200"
              data-testid="sandbox-waiting"
            >
              {v.waiting === 1
                ? "1 full-review task waits for the sandbox."
                : `${v.waiting} full-review tasks wait for the sandbox.`}{" "}
              They run in the next session once it is ready; nothing failed and no retry is used.
            </p>
          ) : null}
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-neutral-500">Image</dt>
            <dd data-testid="sandbox-image">
              <code>{v.image}</code>
              {size && !v.ready ? ` (${size} to download)` : ""}
            </dd>
            <dt className="text-neutral-500">Engine</dt>
            <dd data-testid="sandbox-engine">
              {v.engine === "none"
                ? "none usable"
                : `${v.engine}${v.engineVersion ? ` ${v.engineVersion}` : ""}`}
              {v.reason ? <span className="text-neutral-500"> · {v.reason}</span> : null}
            </dd>
          </dl>
          <div className="mt-2 flex flex-wrap gap-2">
            {v.state === "image_missing" && v.pullable ? (
              <Button
                variant="primary"
                onClick={() => void download()}
                disabled={busy !== null}
                data-testid="sandbox-download"
              >
                {size ? `Download the sandbox (${size})` : "Download the sandbox"}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => void checkAgain()}
              disabled={busy !== null || pulling}
              data-testid="sandbox-check"
            >
              Check again
            </Button>
          </div>
        </>
      ) : null}
      {error ? <ErrorBanner message={error} testId="sandbox-error" /> : null}
      {pulling || progress.lines.length > 0 ? (
        <div className="mt-3 space-y-1 text-xs" data-testid="sandbox-progress">
          {pulling ? (
            <div className="flex items-center gap-2">
              <progress max={100} value={progress.percent ?? undefined} className="h-2 flex-1" />
              <span className="w-28 text-right" data-testid="sandbox-progress-layers">
                {progress.layers ?? "starting"}
              </span>
            </div>
          ) : null}
          <ul data-testid="sandbox-progress-log">
            {progress.lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tail of an append-only log
              <li key={i} className={LINE_TONES[l.tone]}>
                {l.text}
              </li>
            ))}
          </ul>
          {pulling ? (
            <Loading what="the download (it keeps running if you leave this page)" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
