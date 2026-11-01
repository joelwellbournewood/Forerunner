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
  /** Applies the answered Docker cards (Cancel task), from `syncApprovals`. */
  syncAnswers(): Promise<{ cancelled: number }>;
  /** Stops a running download (the daemon's stop). */
  close(): Promise<void>;
}

/** `author_agent` and `change_card.key` of the one Inbox notice. */
export const SANDBOX_NOTICE_AUTHOR = "sandbox-gate";
export const SANDBOX_NOTICE_KEY = "sandbox.not_ready";
/** The one option of a project's Docker card that waits for one task (design §3.8). */
export const SANDBOX_CANCEL_OPTION = "Cancel task";

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

  // --- One Inbox card per project ------------------------------------------------------------
  // Design §3.8, §4.12 (ADR 0101, 0102): a full-review task without Docker waits, with one card
  // per project that names its tasks, the steps for this computer (Set up Docker opens them in
  // Settings) and, for one task, Cancel task. No light-review shortcut.
  const notices = async (): Promise<HumanRequestRow[]> =>
    (
      await store.humanRequest.list(
        { author_agent: SANDBOX_NOTICE_AUTHOR },
        { orderBy: [{ column: "created_at", direction: "desc" }], limit: 200 },
      )
    ).filter((r) => (r.change_card as { key?: unknown } | null)?.key === SANDBOX_NOTICE_KEY);
  const withdrawOpen = async (projectId?: string | null) => {
    let changed = false;
    for (const r of await notices()) {
      if (r.status !== "open") continue;
      if (projectId !== undefined && r.project_id !== projectId) continue;
      await store.humanRequest.withdraw(r.id, r.version);
      changed = true;
    }
    if (changed) deps.onInbox?.();
  };
  type Waiting = { id: string; title: string };
  const lastTasks = new Map<string | null, Waiting[]>();
  const stateOf = (row: HumanRequestRow) => (row.change_card as { state?: unknown } | null)?.state;
  const idsOf = (row: HumanRequestRow) => {
    const ids = (row.change_card as { task_ids?: unknown } | null)?.task_ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  };
  /**
   * The project's card, kept while open and while it says the same (the state, the tasks);
   * filed again when either changed. A card the person answered (Cancel task) is not repeated
   * for the same tasks.
   */
  const ensureNotice = async (r: SandboxReadiness, projectId: string | null, tasks: Waiting[]) => {
    if (r.state === "ready") return withdrawOpen();
    const mine = (await notices()).filter((row) => row.project_id === projectId);
    const ids = tasks.map((t) => t.id).sort();
    const same = (row: HumanRequestRow) =>
      stateOf(row) === r.state && idsOf(row).sort().join() === ids.join();
    const open = mine.find((row) => row.status === "open");
    if (open && same(open)) return;
    if (!open && mine[0]?.status === "answered" && same(mine[0])) return;
    await withdrawOpen(projectId);
    if (tasks.length === 0) return;
    const words = sandboxWords({
      state: r.state,
      platform,
      image: r.image,
      pullable: r.choice.pullable,
      downloadBytes: r.downloadBytes,
    });
    const one = tasks.length === 1 ? tasks[0] : undefined;
    const named = one ? `"${one.title}" waits` : `${tasks.length} tasks wait`;
    await store.humanRequest.insert({
      human_id: humanId,
      project_id: projectId,
      task_id: one?.id ?? null,
      session_id: null,
      kind: one ? "approval" : "info",
      why: `${named} for Docker: ${words.headline} A full review runs the work in Docker, isolated from your computer; the rest of the plan goes on.`,
      steps: words.steps.length ? words.steps : [`Open ${SANDBOX_SETTINGS_PLACE}.`],
      // Cancel task for one task; with several, each is cancelled on the Tasks tab.
      options: one ? [SANDBOX_CANCEL_OPTION] : [],
      blocking: false,
      risk: "low",
      change_card: {
        key: SANDBOX_NOTICE_KEY,
        state: r.state,
        headline: words.headline,
        tasks: tasks.slice(0, 20).map((t) => t.title),
        task_titles: tasks.slice(0, 20).map((t) => t.title),
        task_ids: tasks.slice(0, 20).map((t) => t.id),
        applied_at: null,
      },
      author_agent: SANDBOX_NOTICE_AUTHOR,
    });
    deps.onInbox?.();
  };
  /** Cancel task on a project's card: the task is cancelled (its card is answered). */
  const syncAnswers = async (): Promise<{ cancelled: number }> => {
    let cancelled = 0;
    for (const row of await notices()) {
      const card = (row.change_card ?? {}) as Record<string, unknown>;
      if (row.status !== "answered" || card.applied_at) continue;
      const word =
        typeof row.answer === "string"
          ? row.answer
          : ((row.answer as { choice?: unknown } | null)?.choice ?? "");
      const cancel = typeof word === "string" && /^cancel( the)? task$/i.test(word.trim());
      let outcome = "unrecognized_answer";
      const taskId = idsOf(row)[0];
      const task = cancel && taskId ? await store.task.get(taskId) : undefined;
      if (cancel && task && task.status !== "done" && task.status !== "cancelled") {
        try {
          await store.task.transition(
            task.id,
            task.version,
            "cancelled",
            "you cancelled it in the Inbox",
            {
              humanId,
            },
          );
          cancelled++;
          outcome = "cancel";
        } catch (e) {
          logger.warn("task not cancelled from the Docker card", { error: errorMessage(e) });
          outcome = "task_moved_on";
        }
      } else if (cancel) outcome = "task_moved_on";
      await store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome } as never,
      });
    }
    return { cancelled };
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
        // An open card follows the state (Docker started, the download began or failed).
        if (!prev || prev.state === next.state) return;
        for (const open of (await notices()).filter((r) => r.status === "open"))
          await ensureNotice(next, open.project_id, lastTasks.get(open.project_id) ?? []);
      } catch (e) {
        logger.warn("sandbox notice bookkeeping failed", { error: errorMessage(e) });
      }
    })();
  });

  const gate: SandboxGate = {
    check: async () => answerOf(await readiness.check({ force: true }), platform),
    waiting: async ({ tasks, projectId }) => {
      const waiting = tasks.map((t) => ({ id: t.id, title: t.title }));
      lastTasks.set(projectId, waiting);
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
      await ensureNotice(r, projectId, waiting);
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
    syncAnswers,
    waitingCount,
    view: async () => {
      const r = await readiness.withSize();
      const waiting = r.state === "ready" ? 0 : await waitingCount();
      return readiness.view(r, waiting);
    },
    close: () => readiness.close(),
  };
}
