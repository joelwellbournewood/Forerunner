import type { SessionRow } from "@forerunner/state";
import {
  asLine,
  storeProgress,
  type WaitOptions,
  waitFor as waitForBase,
} from "@forerunner/testenv/wait";
import type { RuntimeApp } from "../src/daemon/compose.ts";

/**
 * What a case started on a composed runtime, watched and stopped (docs/maintainers/testing.md,
 * "Waiting on work a case started"). Every wait on a session's or a task's state in the
 * runtime's, the daemon's and the UI's real-daemon tests goes through one of these, so that:
 *
 * - the wait goes on while the runtime still moves (any row written, a run registered or ended,
 *   a start active or queued), not for a fixed time (`@forerunner/testenv/wait`);
 * - when it gives up, the sessions the case started (and anything else of the agent that runs,
 *   and the starts that wait) are stopped as the session page's Stop now does, and the wait
 *   throws only once nothing of them runs, with what it saw of them;
 * - `settle()`, before `rt.close()`, does the same for whatever a failed or timed-out case left
 *   running: `close()` does not stop sessions, and one still running met a closed database
 *   ("sqlite database is closed" on the Windows runner, c8c16fb).
 */

export const ENDED_STATUSES: readonly string[] = ["completed", "stopped", "failed", "killed"];

type Rt = Pick<RuntimeApp, "store" | "kill" | "scheduler" | "agent">;

export interface RuntimeWatchOptions {
  /**
   * The daemon app's request (`createDaemonApp(rt).app.request` with its token), so a stop is
   * `POST /sessions/:id/stop`, the session page's Stop now. Without it the kill switch's stop of
   * the session is used, the stop that route makes for a running session.
   */
  request?: (path: string, init?: RequestInit) => Response | Promise<Response>;
  /** The agents whose work a case starts. Default: the install's agent. */
  agents?: () => string[];
}

export interface RuntimeWatch {
  /** Remember a session the case started; returns its id. Optional: a running one is found anyway. */
  track(sessionId: string): string;
  /** Changes whenever anything in the runtime moves: the `progress` of its waits. */
  progress(): Promise<string>;
  /** The agent's sessions that are not over (and the ones tracked), its runs and starts, in words. */
  seen(): Promise<string>;
  /** Stop everything the case started and wait until none of it runs; throws if something still does. */
  stop(why: string): Promise<void>;
  /** `waitFor` that watches this runtime, says what it saw of it, and stops what runs on giving up. */
  waitFor<T>(
    what: string,
    probe: () => T | undefined | Promise<T | undefined>,
    opts?: WaitOptions,
  ): Promise<T>;
  /** `until` with the same watch. */
  until(what: string, cond: () => boolean | Promise<boolean>, opts?: WaitOptions): Promise<void>;
  /**
   * Wait until the session has ended and the scheduler has finished its start (what a start
   * decides after the run returns, such as the session-end notification, is done then).
   */
  sessionOver(sessionId: string, opts?: WaitOptions): Promise<SessionRow>;
  /** Before `rt.close()`: stop and wait for whatever is still running. A no-op when nothing is. */
  settle(): Promise<void>;
}

/** How long `stop` waits for what it stopped to end before it says what still runs. */
const STOP_WAIT_MS = 15_000;

export function watchRuntime(rt: Rt, opts: RuntimeWatchOptions = {}): RuntimeWatch {
  const tracked = new Set<string>();
  const agents = () => opts.agents?.() ?? [rt.agent.id];
  const live = (sessionId: string) => rt.kill.activeCount({ sessionId }) > 0;

  /** Sessions that are not over: the agents' (newest 100 each) and the tracked ones. */
  const openSessions = async (): Promise<SessionRow[]> => {
    const rows = new Map<string, SessionRow>();
    for (const agentId of agents())
      for (const s of await rt.store.session.list(
        { agent_id: agentId },
        { orderBy: "created_at desc", limit: 100 },
      ))
        if (!ENDED_STATUSES.includes(s.status)) rows.set(s.id, s);
    for (const id of tracked) {
      const s = rows.has(id) ? undefined : await rt.store.session.get(id);
      if (s && !ENDED_STATUSES.includes(s.status)) rows.set(id, s);
    }
    return [...rows.values()];
  };

  const sessionLine = async (s: SessionRow) => {
    const [lastEvent] = (
      await rt.store.event.list(s.id, (await rt.store.event.latestSeq(s.id)) - 1)
    )
      .map((e) => e.type)
      .slice(-1);
    return `${s.id} ${s.status} (${s.steps} steps, ${s.spent_usd_micro} µUSD${
      live(s.id) ? ", running" : ""
    }${lastEvent ? `, last event ${lastEvent}` : ""})`;
  };

  const agentLine = (agentId: string) => {
    const pending = rt.scheduler.pendingStarts(agentId).length;
    const runs = rt.kill.activeCount({ agentId });
    return `${rt.scheduler.isActive(agentId) ? "a start running" : "no start running"}${
      pending ? `, ${pending} start(s) waiting` : ""
    }, ${runs} run(s) registered`;
  };

  const progress = async () =>
    asLine([
      await storeProgress(rt.store),
      agents().map((a) => [
        rt.kill.activeCount({ agentId: a }),
        rt.scheduler.isActive(a),
        rt.scheduler.pendingStarts(a).length,
      ]),
    ]);

  const seen = async () => {
    const open = await openSessions();
    const sessions = open.length
      ? `sessions not over: ${(await Promise.all(open.map(sessionLine))).join("; ")}`
      : "no session running";
    return `${sessions}; ${agents().map(agentLine).join("; ")}`;
  };

  /** Whether something the case started still runs. */
  const running = async () =>
    agents().some(
      (a) =>
        rt.scheduler.isActive(a) ||
        rt.scheduler.pendingStarts(a).length > 0 ||
        rt.kill.activeCount({ agentId: a }) > 0,
    ) || (await openSessions()).some((s) => live(s.id));

  const stopSession = async (s: SessionRow, why: string) => {
    if (opts.request) {
      const res = await opts.request(`/sessions/${s.id}/stop`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      if (res.status >= 300)
        throw new Error(`POST /sessions/${s.id}/stop answered ${res.status}: ${await res.text()}`);
    } else if (live(s.id)) {
      await rt.kill.stop({ sessionId: s.id }, `stopped by the test: ${why}`, {
        freeze: false,
        by: "you",
      });
    }
  };

  const stop = async (why: string) => {
    // Starts that wait never begin; the ones that run are stopped as Stop now does.
    for (const a of agents())
      while (rt.scheduler.cancelPending(a, `the test stopped: ${why}`)) {
        /* every waiting start */
      }
    for (const s of await openSessions())
      if (tracked.has(s.id) || live(s.id)) await stopSession(s, why);
    // Runs of the agent outside those sessions (a task run, a review): ended, nothing frozen.
    for (const a of agents())
      if (rt.kill.activeCount({ agentId: a }) > 0)
        await rt.kill.stop({ agentId: a }, `stopped by the test: ${why}`, {
          freeze: false,
          by: "you",
        });
    // Until nothing of it runs: no start, no run, and the store quiet for a moment (a stopped
    // run unwinds and writes its end after its registration is gone).
    let lastStore = "";
    let quietSince = Number.POSITIVE_INFINITY;
    await waitForBase(
      "what the case started to stop",
      async () => {
        const now = performance.now();
        const store = await storeProgress(rt.store);
        if (store !== lastStore) {
          lastStore = store;
          quietSince = now;
        }
        const busy = agents().some(
          (a) => rt.scheduler.isActive(a) || rt.scheduler.pendingStarts(a).length > 0,
        );
        return !busy && now - quietSince >= 250 ? true : undefined;
      },
      {
        seen,
        limitMs: STOP_WAIT_MS,
        quietMs: STOP_WAIT_MS,
        reserveMs: 500,
        everyMs: 50,
        forceable: false,
      },
    );
  };

  const watch: RuntimeWatch = {
    track(sessionId) {
      tracked.add(sessionId);
      return sessionId;
    },
    progress,
    seen,
    stop,
    waitFor(what, probe, o = {}) {
      return waitForBase(what, probe, {
        everyMs: 50,
        ...o,
        progress: async () => asLine([o.progress ? await o.progress() : null, await progress()]),
        seen: async () =>
          o.seen ? `${asLine(await o.seen())}; the runtime: ${await seen()}` : await seen(),
        stop: async (why) => {
          await o.stop?.(why);
          await stop(why);
        },
      });
    },
    until(what, cond, o = {}) {
      return watch.waitFor(what, async () => ((await cond()) ? true : undefined), o).then(() => {});
    },
    sessionOver(sessionId, o = {}) {
      tracked.add(sessionId);
      return watch.waitFor(
        `session ${sessionId} to end`,
        async () => {
          const s = await rt.store.session.get(sessionId);
          return s &&
            ENDED_STATUSES.includes(s.status) &&
            !agents().some((a) => rt.scheduler.isActive(a))
            ? s
            : undefined;
        },
        o,
      );
    },
    async settle() {
      if (await running()) await stop("the case is over");
    },
  };
  return watch;
}
