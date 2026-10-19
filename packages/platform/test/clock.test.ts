import { describe, expect, it } from "vitest";
import { SimulatedClock, SystemClock } from "../src/clock.ts";

describe("SimulatedClock", () => {
  it("only moves when advanced and fires timers in order", async () => {
    const c = new SimulatedClock("2026-03-01T00:00:00Z");
    const fired: string[] = [];
    c.setTimeout(() => fired.push("b"), 200);
    c.setTimeout(() => fired.push("a"), 100);
    const cancel = c.setTimeout(() => fired.push("never"), 150);
    cancel();
    expect(c.now()).toBe(new Date("2026-03-01T00:00:00Z").getTime());
    await c.advance(150);
    expect(fired).toEqual(["a"]);
    await c.advance(100);
    expect(fired).toEqual(["a", "b"]);
    expect(c.nowIso()).toBe("2026-03-01T00:00:00.250Z");
  });

  it("resolves sleeps when time passes and honours abort", async () => {
    const c = new SimulatedClock(0);
    let done = false;
    const p = c.sleep(1000).then(() => {
      done = true;
    });
    await c.advance(999);
    expect(done).toBe(false);
    await c.advance(1);
    await p;
    expect(done).toBe(true);

    const ac = new AbortController();
    const p2 = c.sleep(50, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p2).rejects.toThrow("stop");
  });

  it("timers scheduled by timers fire within the same advance", async () => {
    const c = new SimulatedClock(0);
    const fired: number[] = [];
    c.setTimeout(() => {
      fired.push(1);
      c.setTimeout(() => fired.push(2), 10);
    }, 10);
    await c.advance(30);
    expect(fired).toEqual([1, 2]);
    expect(c.monotonic()).toBe(30);
  });

  it("never moves backwards", async () => {
    const c = new SimulatedClock(1000);
    await expect(c.set(10)).rejects.toThrow(/backwards/);
  });
});

describe("SystemClock", () => {
  it("sleeps and can be aborted", async () => {
    const c = new SystemClock();
    const t0 = c.monotonic();
    await c.sleep(5);
    expect(c.monotonic() - t0).toBeGreaterThanOrEqual(3);
    const ac = new AbortController();
    const p = c.sleep(10_000, ac.signal);
    ac.abort(new Error("x"));
    await expect(p).rejects.toThrow("x");
  });
});
