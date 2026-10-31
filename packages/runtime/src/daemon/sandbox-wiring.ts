import { type Clock, errorMessage, log, type Platform } from "@forerunner/platform";
import type { HumanRequestRow, StateStore } from "@forerunner/state";
import type { EngineDetection } from "../sandbox/detect.ts";
import {
  type BuildRunnerImage,
  readBuildRunnerImage,
  resolveSandboxImage,
} from "../sandbox/image.ts";
import { type SandboxReadiness, SandboxReadinessService } from "../sandbox/readiness.ts";
import {
  SANDBOX_SETTINGS_PLACE,
  type SandboxStatusView,
  sandboxNextStep,
  sandboxWords,
} from "../sandbox/readiness-types.ts";
import type { RunFn, WhichFn } from "../sandbox/types.ts";
import type { RunSandboxPort } from "../session/executor.ts";
import {
  FULL_REVIEW_TIER,
  type SandboxGate,
  type SandboxGateAnswer,
} from "../session/sandbox-gate.ts";
import { DetectingSandboxPort } from "./sandbox-port.ts";

/**
 * The daemon's sandbox (ADR 0007, U-079 / ADR 0101) in one place, so `composeRuntime` makes
 * one call: the readiness check and the download (`SandboxReadinessService`), the port every
 * task run opens a lease on, the session runner's gate, the one Inbox notice while full-review
 * tasks wait, and the requeue of tasks an older version failed for want of a sandbox.
 */
export interface SandboxWiringDeps {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  store: StateStore;
  humanId: string;
  /** Tests: a fixed engine detection (no `docker info`); the image is still inspected. */
  detection?: EngineDetection;
  run?: RunFn;
  which?: WhichFn;
  /**
   * Tests only, never read from a setting, a file or the environment: every task, at every
   * risk tier, runs in the process stand-in, and the readiness is pinned `ready`.
   */
  pinProcessForEveryTier?: boolean;
  /** The image the desktop build named; default: read from the payload's `runtime.json`. */
  build?: BuildRunnerImage | null;
  platform?: Platform;
  /** The Inbox changed (the notice was filed or withdrawn): the screens reload it. */
  onInbox?: () => void;
}

export interface ComposedSandbox {
  readiness: SandboxReadinessService;
  port: RunSandboxPort;
  gate: SandboxGate;
  /** `GET /sandbox`: the last answer (a first check when there is none) in plain words. */
  view(): Promise<SandboxStatusView>;
  /** Ready tasks at tier 2+ of the human's projects (they wait while the sandbox is not ready). */
  waitingCount(): Promise<number>;
  /** Stops a running download (the daemon's stop). */
  close(): Promise<void>;
}

/** `author_agent` and `change_card.key` of the one Inbox notice. */
export const SANDBOX_NOTICE_AUTHOR = "sandbox-gate";
export const SANDBOX_NOTICE_KEY = "sandbox.not_ready";

/**
 * Failure reasons an older version wrote for a full-review task with no usable sandbox (the
 * process-sandbox refusal, the missing local image, Docker on Windows containers). Such a task
 * goes back to ready, its attempt count unchanged, once the sandbox is ready.
 */
export const OLD_SANDBOX_FAILURE =
  /needs a container sandbox and none is reachable|Unable to find image 'forerunner-runner|docker run failed \(exit 125\)|invalid mount path: '\/work'/;

export function answerOf(r: SandboxReadiness, platform: Platform): SandboxGateAnswer {
  const input = { state: r.state, platform, image: r.image, pullable: r.choice.pullable };
  return {
    ready: r.state === "ready",
    state: r.state,
    step: sandboxNextStep(input),
    headline: sandboxWords(input).headline,
  };
}

export async function composeSandbox(deps: SandboxWiringDeps): Promise<ComposedSandbox> {
  const logger = log("sandbox:wiring");
  const { store, clock, humanId } = deps;
  const choice = resolveSandboxImage({
    env: deps.env,
    build: deps.build !== undefined ? deps.build : readBuildRunnerImage(),
  });
  const readiness = new SandboxReadinessService({
    env: deps.env,
    clock,
    image: choice,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.which ? { which: deps.which } : {}),
    ...(deps.detection ? { detection: deps.detection } : {}),
    ...(deps.pinProcessForEveryTier ? { pinnedProcess: true } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  const platform = readiness.platform;
  const port = new DetectingSandboxPort({
    env: deps.env,
    clock,
    store,
    audit: store.auditLog,
    readiness,
    ...(deps.pinProcessForEveryTier ? { pinnedProcess: true } : {}),
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.which ? { which: deps.which } : {}),
  });

  // --- The one Inbox notice ------------------------------------------------------------------
  const notices = async (): Promise<HumanRequestRow[]> =>
    (
      await store.humanRequest.list(
        { author_agent: SANDBOX_NOTICE_AUTHOR },
        { orderBy: [{ column: "created_at", direction: "desc" }], limit: 20 },
      )
    ).filter((r) => (r.change_card as { key?: unknown } | null)?.key === SANDBOX_NOTICE_KEY);
  const withdrawOpen = async () => {
    let changed = false;
    for (const r of await notices()) {
      if (r.status !== "open") continue;
      await store.humanRequest.withdraw(r.id, r.version);
      changed = true;
    }
    if (changed) deps.onInbox?.();
  };
  let lastTasks: string[] = [];
  /** One notice per state: kept while open, not repeated after the person answered it. */
  const ensureNotice = async (r: SandboxReadiness, tasks: string[]) => {
    if (r.state === "ready") return withdrawOpen();
    const latest = (await notices())[0];
    const stateOf = (row: HumanRequestRow) =>
      (row.change_card as { state?: unknown } | null)?.state;
    if (latest && latest.status !== "withdrawn" && stateOf(latest) === r.state) return;
    await withdrawOpen();
    const words = sandboxWords({
      state: r.state,
      platform,
      image: r.image,
      pullable: r.choice.pullable,
      downloadBytes: r.downloadBytes,
    });
    const named = tasks
      .slice(0, 5)
      .map((t) => `"${t}"`)
      .join(", ");
    await store.humanRequest.insert({
      human_id: humanId,
      project_id: null,
      session_id: null,
      kind: "info",
      why: `Full-review tasks wait for the Docker sandbox: ${words.headline}${
        named ? ` Waiting: ${named}${tasks.length > 5 ? ` and ${tasks.length - 5} more` : ""}.` : ""
      } They run their tests and builds in it, isolated from your computer, so the critic sees real results. Nothing failed and no retry is used.`,
      steps: words.steps.length ? words.steps : [`Open ${SANDBOX_SETTINGS_PLACE}.`],
      options: [],
      blocking: false,
      risk: "low",
      change_card: { key: SANDBOX_NOTICE_KEY, state: r.state, tasks: tasks.slice(0, 20) },
      author_agent: SANDBOX_NOTICE_AUTHOR,
    });
    deps.onInbox?.();
  };

  // --- Old failures back to ready --------------------------------------------------------------
  const requeueOldFailures = async () => {
    const failed = await store.task.list({ status: "failed" } as never, { limit: 1000 });
    for (const t of failed) {
      if (t.risk_tier < FULL_REVIEW_TIER || !OLD_SANDBOX_FAILURE.test(t.reason ?? "")) continue;
      try {
        // failed -> ready counts an attempt; the failure was the missing sandbox, not the work.
        const moved = await store.task.transition(
          t.id,
          t.version,
          "ready",
          "the Docker sandbox is ready: back to ready, the earlier failure was the missing sandbox (U-079)",
        );
        await store.task.patch(moved.id, { attempt: t.attempt });
        logger.info("task failed for want of a sandbox is ready again", { taskId: t.id });
      } catch (e) {
        logger.warn("task not requeued", { taskId: t.id, error: errorMessage(e) });
      }
    }
  };

  readiness.onChange((next, prev) => {
    void (async () => {
      try {
        if (next.state === "ready") {
          await withdrawOpen();
          if (!next.pinned) await requeueOldFailures();
          return;
        }
        // An open notice follows the state (Docker started, the download began or failed).
        const open = (await notices()).find((r) => r.status === "open");
        if (open && prev && prev.state !== next.state) await ensureNotice(next, lastTasks);
      } catch (e) {
        logger.warn("sandbox notice bookkeeping failed", { error: errorMessage(e) });
      }
    })();
  });

  const gate: SandboxGate = {
    check: async () => answerOf(await readiness.check({ force: true }), platform),
    waiting: async ({ tasks }) => {
      lastTasks = tasks.map((t) => t.title);
      let r = readiness.current() ?? (await readiness.check());
      // The image is all that is missing: the download starts by itself (progress in Settings).
      if (r.state === "image_missing" && r.choice.pullable && r.engine !== "none") {
        try {
          await readiness.startPull();
        } catch (e) {
          logger.warn("sandbox download not started", { error: errorMessage(e) });
        }
        r = readiness.current() ?? r;
      }
      await ensureNotice(r, lastTasks);
    },
  };

  const waitingCount = async () => {
    const ready = await store.task.list({ status: "ready" } as never, { limit: 10_000 });
    return ready.filter((t) => t.risk_tier >= FULL_REVIEW_TIER).length;
  };

  return {
    readiness,
    port,
    gate,
    waitingCount,
    view: async () => {
      const r = await readiness.withSize();
      const waiting = r.state === "ready" ? 0 : await waitingCount();
      return readiness.view(r, waiting);
    },
    close: () => readiness.close(),
  };
}
