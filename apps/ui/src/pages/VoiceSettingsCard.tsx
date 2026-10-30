import {
  type VoiceDeviceView,
  type VoiceInstallEntryView,
  type VoiceInstallView,
  type VoiceProfile,
  voiceInstallCommand,
} from "@forerunner/runtime/daemon/api-types";
import { useEffect, useRef, useState } from "react";
import { describeError } from "../api/client.ts";
import {
  cancelVoiceInstall,
  followVoiceInstall,
  startVoiceInstall,
  voiceInstallView,
} from "../api/voice-install.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, Button, ErrorBanner, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { useClient } from "../store/context.tsx";

/** "cuda (float16)", with the CPU fallback's reason when the GPU check fell back. */
export function deviceLabel(d: VoiceDeviceView | null): string {
  if (!d) return "not checked yet";
  return `${d.device}${d.computeType ? ` (${d.computeType})` : ""}`;
}

/** The wait before re-attaching after the n-th stream in a row that brought nothing: 0.5 s doubling to 10 s. */
export function reattachDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

/** Stream failures in a row after which the card stops re-attaching (the error stays). */
const MAX_FAILED_STREAMS = 8;

/** What the progress area shows: the last line per download and the last few messages. */
export function installProgress(entries: VoiceInstallEntryView[]): {
  bars: { what: string; percent: number | null; text: string }[];
  lines: { tone: "neutral" | "warn" | "bad" | "good"; text: string }[];
  result: { ok: boolean; exitCode: number; message: string } | null;
} {
  const bars = new Map<string, { what: string; percent: number | null; text: string }>();
  const lines: { tone: "neutral" | "warn" | "bad" | "good"; text: string }[] = [];
  let result: { ok: boolean; exitCode: number; message: string } | null = null;
  for (const { event: e } of entries) {
    if (e.type === "progress") {
      const percent = e.total ? Math.min(100, Math.floor((e.bytes / e.total) * 100)) : null;
      const mb = (n: number) => (n / 1_000_000).toFixed(1);
      bars.set(e.what, {
        what: e.what,
        percent,
        text: e.total ? `${mb(e.bytes)} of ${mb(e.total)} MB` : `${mb(e.bytes)} MB`,
      });
    } else if (e.type === "step") lines.push({ tone: "neutral", text: e.message });
    else if (e.type === "log") lines.push({ tone: "neutral", text: e.message });
    else if (e.type === "warning") lines.push({ tone: "warn", text: e.message });
    else if (e.type === "error") lines.push({ tone: "bad", text: e.message });
    else if (e.type === "result") {
      result = { ok: e.ok, exitCode: e.exitCode, message: e.message };
      lines.push({ tone: e.exitCode === 0 ? "good" : e.ok ? "warn" : "bad", text: e.message });
    }
  }
  return { bars: [...bars.values()], lines: lines.slice(-8), result };
}

const LINE_TONES = {
  neutral: "text-neutral-700 dark:text-neutral-300",
  good: "text-emerald-800 dark:text-emerald-300",
  warn: "text-amber-800 dark:text-amber-300",
  bad: "text-red-800 dark:text-red-300",
} as const;

/**
 * Settings → Voice (ADR 0090): the voice profile in force (none, cpu, gpu) with the devices its
 * check verified, each profile's disk size and trade-off, and a switch that runs the same
 * install as `fr voice install` through the daemon with its progress streamed here. A switch
 * downloads gigabytes, so it is confirmed first; the terminal command is shown too.
 */
export function VoiceSettingsCard() {
  const client = useClient();
  const view = useAsync((signal) => voiceInstallView(client, signal), [client]);
  const [entries, setEntries] = useState<VoiceInstallEntryView[]>([]);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<VoiceProfile | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // The job being followed and the last event the card has: a stream that drops while the
  // job runs (a proxy, a sleeping laptop) is opened again from there, never from the start.
  const attached = useRef<string | null>(null);
  const lastSeq = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const failures = useRef(0);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelVoiceInstall(client);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCancelling(false);
    }
  };
  useEffect(
    () => () => {
      if (retry.current) clearTimeout(retry.current);
    },
    [],
  );

  const follow = (afterSeq: number) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setFollowing(true);
    let failed = false;
    followVoiceInstall(
      client,
      afterSeq,
      (e) => {
        lastSeq.current = Math.max(lastSeq.current, e.seq);
        // Progress again: a stream error shown before is over, and the backoff starts anew.
        attempts.current = 0;
        failures.current = 0;
        setError(null);
        setEntries((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]));
      },
      controller.signal,
    )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        failed = true;
        failures.current++;
        setError(describeError(e));
      })
      .finally(async () => {
        if (controller.signal.aborted) return;
        let running = false;
        try {
          const now = await voiceInstallView(client);
          running = now.job?.state === "running" && now.job.id === attached.current;
        } catch {
          running = false;
          failed = true;
        }
        if (controller.signal.aborted) return;
        // Again while the job runs, or after a failed stream (the job's tail is still to read).
        if ((running || failed) && failures.current < MAX_FAILED_STREAMS) {
          retry.current = setTimeout(
            () => follow(lastSeq.current),
            reattachDelay(attempts.current++),
          );
          return;
        }
        setFollowing(false);
        view.reload();
      });
  };

  // A job already running when the page opens (started here earlier, or from another window).
  const job = view.data?.job ?? null;
  const runningJobId = job?.state === "running" ? job.id : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attach once per running job
  useEffect(() => {
    if (!runningJobId || !job || attached.current === runningJobId) return;
    attached.current = runningJobId;
    setEntries(job.recent);
    lastSeq.current = job.recent.at(-1)?.seq ?? 0;
    follow(lastSeq.current);
  }, [runningJobId]);

  const start = async (profile: VoiceProfile) => {
    setConfirming(null);
    setError(null);
    setEntries([]);
    try {
      const started = await startVoiceInstall(client, profile);
      attached.current = started.job?.id ?? null;
      lastSeq.current = 0;
      attempts.current = 0;
      failures.current = 0;
      follow(0);
    } catch (e) {
      setError(describeError(e));
    }
  };

  if (view.routeMissing) return <RouteMissing what="Voice settings" route="voiceInstall" />;
  const v: VoiceInstallView | null = view.data;
  const busy = following || job?.state === "running";
  const progress = installProgress(entries);
  const fallbacks = [v?.stt, v?.tts].filter((d): d is VoiceDeviceView => !!d?.fallback);

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="voice-settings"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-semibold">Voice</h2>
        {v ? (
          <Badge
            tone={v.profile && v.profile !== "none" ? "good" : "neutral"}
            testId="voice-profile-current"
          >
            {v.profile ?? "not chosen"}
          </Badge>
        ) : null}
      </div>
      {view.loading && !v ? <Loading what="voice settings" /> : null}
      {view.error && !v ? <ErrorBanner message={view.error} onRetry={view.reload} /> : null}
      {v ? (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-500">Speech recognition</dt>
            <dd data-testid="voice-stt-device">{deviceLabel(v.stt)}</dd>
            <dt className="text-neutral-500">Speech</dt>
            <dd data-testid="voice-tts-device">{deviceLabel(v.tts)}</dd>
            <dt className="text-neutral-500">GPU</dt>
            <dd data-testid="voice-gpu">
              {v.gpu.present
                ? `${v.gpu.name ?? "NVIDIA"}${v.gpu.driver ? `, driver ${v.gpu.driver}` : ""}`
                : `none found (${v.gpu.reason})`}
            </dd>
          </dl>
          {fallbacks.map((d) => (
            <p
              key={d.fallback}
              role="alert"
              data-testid="voice-fallback"
              className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              The GPU check failed and the CPU stands in: {d.fallback}. Fix the NVIDIA driver, then
              install the GPU profile again.
            </p>
          ))}
          <p
            className="mt-2 text-xs text-neutral-600 dark:text-neutral-400"
            data-testid="voice-folder"
          >
            {v.profile && v.profile !== "none" && v.installedAt ? "Installed in" : "Installs into"}{" "}
            <code className="font-mono">{v.folder}</code>
          </p>
          {v.folderNote ? (
            <p
              className="mt-1 text-xs text-amber-800 dark:text-amber-200"
              data-testid="voice-folder-note"
            >
              {v.folderNote}
            </p>
          ) : null}
          {v.pythonOverride ? (
            <p
              className="mt-2 text-xs text-neutral-600 dark:text-neutral-400"
              data-testid="voice-python-override"
            >
              FORERUNNER_PYTHON is set ({v.pythonOverride}): the helpers use that interpreter, not
              the managed one.
            </p>
          ) : null}
          <ul className="mt-3 space-y-2 text-sm">
            {v.profiles.map((p) => {
              const current = v.profile === p.profile;
              return (
                <li
                  key={p.profile}
                  data-testid="voice-profile"
                  data-profile={p.profile}
                  className="rounded border border-neutral-100 p-2 dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.label}</span>
                    {current ? <Badge tone="good">current</Badge> : null}
                    {v.recommended === p.profile && !current ? (
                      <Badge tone="info">recommended here</Badge>
                    ) : null}
                    {p.needsNvidia ? <Badge>NVIDIA only</Badge> : null}
                    <span
                      className="text-neutral-600 dark:text-neutral-400"
                      data-testid="voice-profile-size"
                    >
                      {p.disk} on disk · {p.download} to download
                    </span>
                    <span className="ml-auto">
                      {confirming === p.profile ? (
                        <>
                          <Button
                            variant="primary"
                            onClick={() => void start(p.profile)}
                            data-testid="voice-profile-confirm"
                          >
                            {p.profile === "none" ? "Remove" : "Install"}
                          </Button>{" "}
                          <Button variant="ghost" onClick={() => setConfirming(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant={current ? "ghost" : "secondary"}
                          disabled={busy}
                          onClick={() => setConfirming(p.profile)}
                          data-testid="voice-profile-switch"
                        >
                          {current
                            ? p.profile === "none"
                              ? "Off"
                              : "Check again"
                            : p.profile === "none"
                              ? "Turn off"
                              : `Switch to ${p.label}`}
                        </Button>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-neutral-600 dark:text-neutral-400">{p.tradeOff}</p>
                  {confirming === p.profile ? (
                    <p className="mt-1 text-xs" data-testid="voice-profile-confirm-text">
                      {p.profile === "none"
                        ? "Removes the local speech packages and models; a voice session has to be closed first."
                        : `Downloads ${p.download} and checks the result; this takes a while. A voice session has to be closed first.`}{" "}
                      From a terminal: <code>{voiceInstallCommand(p.profile)}</code>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-neutral-500" data-testid="voice-cli">
            The same from a terminal: <code>fr voice install --cpu</code>, <code>--gpu</code> or{" "}
            <code>fr voice remove</code>; <code>fr voice status</code> shows what is installed.
          </p>
        </>
      ) : null}
      {error ? <ErrorBanner message={error} testId="voice-install-error" /> : null}
      {entries.length > 0 ? (
        <div className="mt-3 space-y-1 text-xs" data-testid="voice-install-progress">
          {progress.bars.map((b) => (
            <div key={b.what} className="flex items-center gap-2" data-testid="voice-install-bar">
              <span className="w-40 truncate font-mono" title={b.what}>
                {b.what}
              </span>
              <progress max={100} value={b.percent ?? undefined} className="h-2 flex-1" />
              <span className="w-32 text-right">{b.text}</span>
            </div>
          ))}
          <ul data-testid="voice-install-log">
            {progress.lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the tail of an append-only log
              <li key={i} className={LINE_TONES[l.tone]}>
                {l.text}
              </li>
            ))}
          </ul>
          {busy ? (
            <div className="flex items-center gap-3">
              <Loading what="the voice install (it keeps running if you leave this page)" />
              <Button
                variant="ghost"
                onClick={() => void cancel()}
                disabled={cancelling}
                data-testid="voice-install-cancel"
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
