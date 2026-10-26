/**
 * Settings → Voice behind the daemon (ADR 0089): `GET /voice/install` (the profile, the
 * catalog, the GPU, what was verified), `POST /voice/install` (install, switch or remove in
 * the background, the same `installVoice` / `removeVoice` as the CLI) and
 * `GET /voice/install/events` (the job's progress, replayable, as SSE with the bearer header or
 * as JSON). One job at a time; refused while a voice session is open, because a switch stops
 * the local helpers. The helpers are stopped (`release`) right before an old venv is deleted,
 * so Windows can delete the files they held; the next voice use starts the new profile's.
 */
import {
  type AppDirs,
  type Clock,
  ForerunnerError,
  newId,
  type Platform,
} from "@forerunner/platform";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  detectNvidiaGpu,
  type InstallDeps,
  installVoice,
  readVoiceSettings,
  recommendedProfile,
  type VoiceProcRunner,
} from "./install.ts";
import {
  type GpuView,
  VOICE_PROFILE_INFO,
  VOICE_PROFILES,
  VoiceInstallBody,
  type VoiceInstallEntryView,
  type VoiceInstallEvent,
  type VoiceInstallJobView,
  type VoiceInstallView,
  type VoiceProfile,
  voiceInstallCommand,
} from "./install-types.ts";

export interface VoiceInstallJobsDeps {
  dirs: AppDirs;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  platform?: Platform;
  run?: VoiceProcRunner;
  /** Why a switch must wait (a voice session is open); null when it may run. */
  busy: () => string | null;
  /** Stops the local helpers (LocalVoice.release). */
  release: () => Promise<void>;
  detectGpu?: () => Promise<GpuView>;
}

interface Job {
  id: string;
  profile: VoiceProfile;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  entries: VoiceInstallEntryView[];
  done: Promise<void>;
}

const RECENT = 40;

export class VoiceInstallJobs {
  private job: Job | null = null;
  /** Called with each event, and with null when the job has ended. */
  private listeners = new Set<(e: VoiceInstallEntryView | null) => void>();
  private gpu: GpuView | null = null;

  constructor(private readonly deps: VoiceInstallJobsDeps) {}

  private async gpuView(refresh = false): Promise<GpuView> {
    if (!this.gpu || refresh)
      this.gpu = await (
        this.deps.detectGpu ??
        (() => detectNvidiaGpu({ run: this.deps.run, platform: this.deps.platform }))
      )();
    return this.gpu;
  }

  async view(): Promise<VoiceInstallView> {
    const s = readVoiceSettings(this.deps.dirs);
    const gpu = await this.gpuView();
    const profile = s?.profile ?? null;
    return {
      profile,
      profiles: VOICE_PROFILES.map((p) => ({ ...VOICE_PROFILE_INFO[p] })),
      recommended: recommendedProfile(gpu),
      gpu,
      installedAt: s?.install?.installedAt ?? null,
      verifiedAt: s?.verified?.at ?? null,
      stt: s?.verified?.stt ?? null,
      tts: s?.verified?.tts ?? null,
      pythonOverride: this.deps.env.FORERUNNER_PYTHON?.trim() || null,
      job: this.jobView(),
      cli: voiceInstallCommand(profile ?? recommendedProfile(gpu)),
    };
  }

  jobView(): VoiceInstallJobView | null {
    const j = this.job;
    if (!j) return null;
    return {
      id: j.id,
      profile: j.profile,
      state: j.state,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      exitCode: j.exitCode,
      recent: j.entries.slice(-RECENT),
    };
  }

  get running(): boolean {
    return this.job?.state === "running";
  }

  /** The current job's promise (tests wait on it). */
  get settled(): Promise<void> {
    return this.job?.done ?? Promise.resolve();
  }

  start(profile: VoiceProfile): VoiceInstallJobView {
    if (this.running)
      throw new ForerunnerError(
        "claim_conflict",
        `a voice install (${this.job?.profile}) is running; wait for it to finish`,
      );
    const busy = this.deps.busy();
    if (busy) throw new ForerunnerError("claim_conflict", busy);
    const entries: VoiceInstallEntryView[] = [];
    const job: Job = {
      id: newId(this.deps.clock.now()),
      profile,
      state: "running",
      startedAt: this.deps.clock.nowIso(),
      finishedAt: null,
      exitCode: null,
      entries,
      done: Promise.resolve(),
    };
    const out = (event: VoiceInstallEvent) => {
      const entry = { seq: entries.length + 1, event };
      entries.push(entry);
      for (const l of this.listeners) l(entry);
    };
    this.job = job;
    const deps: InstallDeps = {
      dirs: this.deps.dirs,
      env: this.deps.env,
      clock: this.deps.clock,
      out,
      beforeCleanup: () => this.deps.release(),
      ...(this.deps.platform ? { platform: this.deps.platform } : {}),
      ...(this.deps.run ? { run: this.deps.run } : {}),
    };
    job.done = (async () => {
      const gpu = await this.gpuView(true);
      // LocalVoice reads voice.json at its next use, so the new profile's helpers start then.
      const r = await installVoice(profile, { ...deps, gpu });
      job.exitCode = r.exitCode;
      job.state = r.exitCode === 1 ? "failed" : "done";
      job.finishedAt = this.deps.clock.nowIso();
    })()
      .catch((e: unknown) => {
        out({ type: "error", message: e instanceof Error ? e.message : String(e) });
        job.exitCode = 1;
        job.state = "failed";
        job.finishedAt = this.deps.clock.nowIso();
      })
      .finally(() => {
        for (const l of this.listeners) l(null);
      });
    return this.jobView() as VoiceInstallJobView;
  }

  eventsAfter(seq: number): VoiceInstallEntryView[] {
    return (this.job?.entries ?? []).filter((e) => e.seq > seq);
  }

  subscribe(listener: (e: VoiceInstallEntryView | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A timer on the daemon's clock (the stream's heartbeat); returns its cancel. */
  timer(ms: number, fn: () => void): () => void {
    return this.deps.clock.setTimeout(fn, ms);
  }
}

function errorBody(e: unknown): { code: string; message: string } {
  if (e instanceof ForerunnerError)
    return { code: e.code === "claim_conflict" ? "conflict" : e.code, message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

export function createVoiceInstallRoutes(deps: { jobs: VoiceInstallJobs }): Hono {
  const app = new Hono();
  const { jobs } = deps;

  app.onError((e, c) => {
    const body = errorBody(e);
    if (body.code === "conflict") return c.json(body, 409);
    if (body.code === "validation") return c.json(body, 400);
    return c.json(body, 500);
  });

  app.get("/voice/install", async (c) => c.json(await jobs.view()));

  app.post("/voice/install", async (c) => {
    const parsed = VoiceInstallBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { code: "validation", message: `profile must be one of ${VOICE_PROFILES.join(", ")}` },
        400,
      );
    jobs.start(parsed.data.profile);
    return c.json(await jobs.view(), 202);
  });

  app.get("/voice/install/events", async (c) => {
    const raw = c.req.query("afterSeq");
    const afterSeq = raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(afterSeq) || afterSeq < 0)
      return c.json(
        { code: "validation", message: "afterSeq must be a non-negative integer" },
        400,
      );
    if (!(c.req.header("accept") ?? "").includes("text/event-stream"))
      return c.json(jobs.eventsAfter(afterSeq));
    return streamSSE(c, async (stream) => {
      let last = afterSeq;
      const pending: VoiceInstallEntryView[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = jobs.subscribe((e) => {
        if (e) pending.push(e);
        wake?.();
      });
      stream.onAbort(() => wake?.());
      try {
        for (;;) {
          for (const e of [...jobs.eventsAfter(last), ...pending.splice(0)]) {
            if (e.seq <= last) continue;
            last = e.seq;
            await stream.writeSSE({
              event: "voice.install",
              data: JSON.stringify(e),
              id: String(e.seq),
            });
          }
          if (!jobs.running || stream.aborted) break;
          let cancel = () => {};
          await new Promise<void>((r) => {
            wake = r;
            cancel = jobs.timer(15_000, r);
          });
          cancel();
          wake = null;
          if (!stream.aborted && pending.length === 0 && jobs.running)
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
