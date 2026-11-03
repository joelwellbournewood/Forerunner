import { beforeAll, describe, expect, it } from "vitest";
import { openStore } from "../../packages/state/src/index.ts";
import {
  caseDeadline,
  forcedGiveUpMs,
  OUTSIDE_CASE_LIMIT_MS,
  QUIET_MS,
  storeProgress,
  until,
  WaitTimeout,
  waitFor,
  waitLimit,
} from "../src/wait.ts";

/**
 * The one wait the tests use on work they started (testing.md, "Waiting on work a case
 * started"): it waits while that work moves, gives up before the case's own timeout, stops what
 * the case started first and says what it saw.
 */
describe("waitFor", () => {
  it("returns the probe's value once it has one", async () => {
    let n = 0;
    expect(await waitFor("the third poll", () => (++n >= 3 ? n : undefined))).toBe(3);
  });

  it("goes on past the quiet window while what it watches still changes", async () => {
    const t0 = Date.now();
    let step = 0;
    const v = await waitFor("the slow work", () => (Date.now() - t0 >= 400 ? "done" : undefined), {
      progress: () => ++step,
      quietMs: 100,
      everyMs: 10,
    });
    expect(v).toBe("done");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it("gives up when nothing it watches changed for the quiet window: stops first, then says what it saw", async () => {
    const calls: string[] = [];
    const err = await waitFor("the session to end", () => undefined, {
      seen: () => ({ status: "running", steps: 4 }),
      stop: (why) => {
        calls.push(why);
      },
      quietMs: 150,
      everyMs: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeout);
    const e = err as WaitTimeout;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^nothing it watches changed for 0\.\d s$/);
    expect(e.message).toMatch(
      /^timed out waiting for the session to end \(nothing it watches changed for 0\.\d s; stopped what the case started\): saw \{"status":"running","steps":4\}$/,
    );
    expect(e.stopped).toBe("stopped what the case started");
  });

  it("gives up at its limit even while things still change, and names the last change", async () => {
    let step = 0;
    const err = (await until("a loop that never ends", () => false, {
      progress: () => ++step,
      seen: () => `step ${step}`,
      limitMs: 200,
      everyMs: 10,
    }).catch((e: unknown) => e)) as WaitTimeout;
    expect(err).toBeInstanceOf(WaitTimeout);
    expect(err.why).toMatch(/^it was still waiting after 0\.\d s, the last change 0 s before$/);
    expect(err.seen).toMatch(/^step \d+$/);
    expect(err.stopped).toBeNull();
  });

  it("names a stop that failed, and a read that failed, instead of hiding the timeout", async () => {
    const err = (await until("the task to run", () => false, {
      seen: () => {
        throw new Error("database is closed");
      },
      stop: () => {
        throw new Error("the session did not stop");
      },
      quietMs: 50,
      everyMs: 10,
    }).catch((e: unknown) => e)) as WaitTimeout;
    expect(err.message).toContain(
      "stopping what the case started failed: the session did not stop",
    );
    expect(err.message).toContain("saw (could not read: database is closed)");
  });

  it("with nothing to watch, waits its limit and says so", async () => {
    const err = (await until("nothing", () => false, { limitMs: 60, everyMs: 10 }).catch(
      (e: unknown) => e,
    )) as WaitTimeout;
    expect(err.why).toMatch(/^it was still waiting after 0\.\d s$/);
    expect(err.seen).toBe("nothing");
  });
});

describe("the limit comes from the running case", () => {
  it("reads the case's timeout", () => {
    expect(caseDeadline()?.timeoutMs).toBe(2_500);
  }, 2_500);

  it("ends a reserve before the case's own timeout, so the stop and the message come before vitest's", async () => {
    // Asked for a minute while the case allows 3 s: it gives up at about 3 s less the reserve
    // (a quarter, at least 1 s), with time left to stop, and the case itself passes.
    const t0 = Date.now();
    let step = 0;
    const stopped: number[] = [];
    const err = (await until("work that keeps moving", () => false, {
      progress: () => ++step,
      stop: () => {
        stopped.push(Date.now() - t0);
      },
      limitMs: 60_000,
      everyMs: 20,
    }).catch((e: unknown) => e)) as WaitTimeout;
    expect(err).toBeInstanceOf(WaitTimeout);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBeLessThan(2_200);
    expect(stopped[0]).toBeGreaterThan(1_500);
    expect(waitLimit(60_000)).toBe(0);
  }, 3_000);

  // A hook has no case: the default limit applies unless the wait names one.
  let inHook: { deadline: unknown; limit: number; asked: number } | undefined;
  beforeAll(() => {
    inHook = { deadline: caseDeadline(), limit: waitLimit(), asked: waitLimit(5_000) };
  });
  it("outside a case (a hook) the default limit applies, and the quiet window is 45 s", () => {
    expect(inHook).toEqual({ deadline: undefined, limit: OUTSIDE_CASE_LIMIT_MS, asked: 5_000 });
    expect(QUIET_MS).toBe(45_000);
  });
});

describe("FORERUNNER_TEST_WAIT_GIVE_UP_MS", () => {
  it("forces every wait's give-up after that long, except a wait that is part of a stop", async () => {
    expect(forcedGiveUpMs({ FORERUNNER_TEST_WAIT_GIVE_UP_MS: "300" })).toBe(300);
    expect(forcedGiveUpMs({ FORERUNNER_TEST_WAIT_GIVE_UP_MS: "" })).toBeUndefined();
    expect(forcedGiveUpMs({})).toBeUndefined();
    const was = process.env.FORERUNNER_TEST_WAIT_GIVE_UP_MS;
    process.env.FORERUNNER_TEST_WAIT_GIVE_UP_MS = "100";
    try {
      let step = 0;
      const t0 = Date.now();
      const err = (await until("a long wait", () => false, {
        progress: () => ++step,
        limitMs: 10_000,
        everyMs: 10,
      }).catch((e: unknown) => e)) as WaitTimeout;
      expect(err).toBeInstanceOf(WaitTimeout);
      expect(Date.now() - t0).toBeLessThan(1_000);
      let n = 0;
      expect(
        await waitFor("a stop's own wait", () => (++n >= 20 ? n : undefined), {
          everyMs: 10,
          forceable: false,
        }),
      ).toBe(20);
    } finally {
      if (was === undefined) delete process.env.FORERUNNER_TEST_WAIT_GIVE_UP_MS;
      else process.env.FORERUNNER_TEST_WAIT_GIVE_UP_MS = was;
    }
  });
});

describe("storeProgress", () => {
  it("changes when a row is written or updated, and not otherwise", async () => {
    const store = await openStore({ url: "sqlite::memory:" });
    try {
      const a = await storeProgress(store);
      expect(a).toMatch(/\bsession:0:0\b/);
      expect(await storeProgress(store)).toBe(a);
      const human = await store.human.insert({ name: "J", email: "j@example.test" });
      const b = await storeProgress(store);
      expect(b).not.toBe(a);
      await store.human.update(human.id, human.version, { name: "Jo" });
      expect(await storeProgress(store)).not.toBe(b);
    } finally {
      await store.close();
    }
  });
});
