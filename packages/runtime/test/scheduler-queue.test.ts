import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { Scheduler, type StartRequest } from "../src/session/triggers.ts";

/**
 * U-043: a start that waited behind a running session was replaced by the next start request
 * (an approved plan's start, a CI trigger, the person's own Start): the scheduler kept one
 * waiting request per agent and "the newest request wins", so the approved plan never ran and
 * the Start dialog's "This one starts when that one ends" was not true. Waiting starts are now
 * kept in order and each runs when the one before it ends; the same automatic start asked again
 * while it waits is kept once, and the log says so.
 */

/** A scheduler whose runs end when the test says so, recording the order they started in. */
function world(opts: { quiet?: () => boolean } = {}) {
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const scheduler = new Scheduler({
    clock,
    start: (req) => {
      started.push(req.reason);
      return new Promise<void>((resolve) => finish.set(req.reason, resolve));
    },
    ...(opts.quiet ? { isQuietHours: opts.quiet } : {}),
  });
  /** End the named run and let the scheduler's tick start the next. */
  const end = async (reason: string) => {
    finish.get(reason)?.();
    await new Promise((r) => setImmediate(r));
    await scheduler.tick();
  };
  return { clock, scheduler, started, end };
}

const req = (reason: string, over: Partial<StartRequest> = {}): StartRequest => ({
  agentId: "alice",
  projectId: "p1",
  trigger: "manual",
  reason,
  ...over,
});

describe("starts waiting behind a running session are kept in order (U-043)", () => {
  it("an approved plan's start and a CI trigger waiting behind a session are not replaced by a later Start", async () => {
    const w = world();
    await w.scheduler.request(req("running"));
    expect(
      await w.scheduler.request(
        req("approved plan", { trigger: "message", planApproved: "plan:s1#abc" }),
      ),
    ).toBe("queued");
    expect(await w.scheduler.request(req("ci failed", { trigger: "ci" }))).toBe("queued");
    expect(await w.scheduler.request(req("person's start"))).toBe("queued");
    await w.end("running");
    await w.end("approved plan");
    await w.end("ci failed");
    expect(w.started).toEqual(["running", "approved plan", "ci failed", "person's start"]);
  });

  it("the waiting starts are listed in order, with how many come before each, and keep their ids", async () => {
    const w = world();
    expect((await w.scheduler.requestStart(req("running"))).result).toBe("started");
    const plan = await w.scheduler.requestStart(
      req("approved plan", { trigger: "message", planApproved: "plan:s1#abc" }),
    );
    const ci = await w.scheduler.requestStart(req("ci failed", { trigger: "ci" }));
    const manual = await w.scheduler.requestStart(req("person's start"));
    expect([plan.result, ci.result, manual.result]).toEqual(["queued", "queued", "queued"]);
    // Nothing was replaced: all three wait, first come first.
    expect(w.scheduler.pendingStarts("alice").map((e) => e.id)).toEqual([
      plan.id,
      ci.id,
      manual.id,
    ]);
    expect(w.scheduler.pendingStart("alice")?.id).toBe(plan.id);
    expect(w.scheduler.waitingAhead("alice", manual.id)).toBe(2);
    expect(w.scheduler.waitingAhead("alice", plan.id)).toBe(0);
    await w.end("running");
    await w.end("approved plan");
    await w.end("ci failed");
    expect(w.started).toEqual(["running", "approved plan", "ci failed", "person's start"]);
    // Each drained start keeps its identity (the id its undo names).
    expect(w.scheduler.activeStart("alice")?.id).toBe(manual.id);
    expect(w.scheduler.pendingStarts("alice")).toEqual([]);
  });

  it("the same automatic start asked again while it waits is kept once, and the log records it", async () => {
    const w = world();
    await w.scheduler.requestStart(req("running"));
    const first = await w.scheduler.requestStart(req("pr comment", { trigger: "pr_comment" }));
    const again = await w.scheduler.requestStart(req("pr comment", { trigger: "pr_comment" }));
    // The same work: the waiting start answers for both; nothing else is dropped.
    expect(again).toMatchObject({ id: first.id, result: "queued" });
    expect(w.scheduler.pendingStarts("alice")).toHaveLength(1);
    expect(w.scheduler.log.at(-1)).toMatchObject({
      id: first.id,
      result: "queued",
      detail: "asked again while it waits; it runs once",
    });
    // A start for another project, or a person's own, is never folded into it.
    await w.scheduler.requestStart(req("pr comment", { trigger: "pr_comment", projectId: "p2" }));
    await w.scheduler.requestStart(req("by hand"));
    await w.scheduler.requestStart(req("by hand"));
    expect(w.scheduler.pendingStarts("alice")).toHaveLength(4);
  });

  it("undo drops the start it names and keeps the others in order", async () => {
    const w = world();
    await w.scheduler.requestStart(req("running"));
    const a = await w.scheduler.requestStart(req("a"));
    const b = await w.scheduler.requestStart(req("b"));
    const c = await w.scheduler.requestStart(req("c"));
    expect(w.scheduler.cancelPending("alice", "undo", b.id)?.reason).toBe("b");
    expect(w.scheduler.pendingStarts("alice").map((e) => e.id)).toEqual([a.id, c.id]);
    expect(w.scheduler.log.at(-1)).toMatchObject({ id: b.id, result: "cancelled" });
    expect(w.scheduler.cancelPending("alice", "undo", "no-such-start")).toBeUndefined();
    await w.end("running");
    await w.end("a");
    expect(w.started).toEqual(["running", "a", "c"]);
  });

  it("a start deferred by quiet hours waits its turn and never holds up a person's start behind it", async () => {
    let quiet = true;
    const w = world({ quiet: () => quiet });
    await w.scheduler.requestStart(req("running"));
    const night = await w.scheduler.requestStart(req("nightly", { trigger: "schedule" }));
    const byHand = await w.scheduler.requestStart(req("by hand"));
    expect(night.result).toBe("deferred");
    expect(byHand.result).toBe("queued");
    await w.end("running");
    // Quiet hours hold the scheduled one, not the person's.
    expect(w.started).toEqual(["running", "by hand"]);
    expect(w.scheduler.pendingStarts("alice").map((e) => e.id)).toEqual([night.id]);
    quiet = false;
    await w.end("by hand");
    expect(w.started).toEqual(["running", "by hand", "nightly"]);
  });
});
