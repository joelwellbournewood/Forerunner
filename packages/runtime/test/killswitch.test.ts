import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";

describe("kill switch", () => {
  it("stops every registered run, kills processes and revokes tokens in under 2 seconds", async () => {
    const tokens = new TokenIssuer();
    let frozen: unknown = null;
    const ks = new KillSwitch(tokens, (scope) => {
      frozen = scope;
    });
    const controllers: AbortController[] = [];
    const children = [];
    for (let i = 0; i < 40; i++) {
      const c = new AbortController();
      controllers.push(c);
      const agentId = i % 2 ? "alice" : "bob";
      tokens.issue({
        runId: `r${i}`,
        sessionId: `s${i % 5}`,
        agentId,
        ownerHumanId: "j",
        allowedTools: ["echo"],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 10,
        depth: 0,
        maxDepth: 2,
        autonomy: 2,
        planApproved: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const child =
        i < 3
          ? spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" })
          : undefined;
      if (child) children.push(child);
      ks.register({ agentId, sessionId: `s${i % 5}`, controller: c, child, label: `run ${i}` });
    }
    expect(ks.activeCount()).toBe(40);
    const t0 = performance.now();
    const report = await ks.stop("all", "test");
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(report.stoppedRuns).toBe(40);
    expect(report.killedProcesses).toBe(3);
    expect(report.revokedTokens).toBe(40);
    expect(controllers.every((c) => c.signal.aborted)).toBe(true);
    expect(frozen).toBe("all");
    expect(ks.activeCount()).toBe(0);
    // Processes really die.
    await Promise.all(
      children.map((ch) => new Promise((r) => (ch.exitCode !== null ? r(0) : ch.on("exit", r)))),
    );
    expect(children.every((ch) => ch.exitCode !== null || ch.signalCode !== null)).toBe(true);
  });

  it("scopes to one agent or one session and freezes new registrations in that scope", async () => {
    const ks = new KillSwitch();
    const a = new AbortController();
    const b = new AbortController();
    ks.register({ agentId: "alice", sessionId: "s1", controller: a, label: "a" });
    ks.register({ agentId: "bob", sessionId: "s2", controller: b, label: "b" });
    const report = await ks.stop({ agentId: "alice" });
    expect(report.stoppedRuns).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    const late = new AbortController();
    ks.register({ agentId: "alice", sessionId: "s9", controller: late, label: "late" });
    expect(late.signal.aborted).toBe(true);
    const bobLate = new AbortController();
    ks.register({ agentId: "bob", sessionId: "s2", controller: bobLate, label: "bob late" });
    expect(bobLate.signal.aborted).toBe(false);
    ks.resume();
    expect(ks.isFrozen({ agentId: "alice" })).toBe(false);
  });

  // U-032: a session's Stop was `stop({ sessionId })` then `resume()`, and both replaced the
  // freeze: a Stop during Stop all lifted the kill the person had set.
  it("a stop that does not freeze ends the runs and leaves the kill in force", async () => {
    const ks = new KillSwitch();
    await ks.stop("all", "stop all");
    const run = new AbortController();
    ks.register({ agentId: "alice", sessionId: "s1", controller: run, label: "late" });
    expect(run.signal.aborted).toBe(true);
    const report = await ks.stop({ sessionId: "s1" }, "stopped from the app", { freeze: false });
    expect(report.scope).toEqual({ sessionId: "s1" });
    expect(ks.isFrozen({ agentId: "alice" })).toBe(true);
    expect(ks.isFrozen({ agentId: "bob", sessionId: "s2" })).toBe(true);

    // Without a kill in force it freezes nothing: new work may start at once.
    const free = new KillSwitch();
    const busy = new AbortController();
    free.register({ agentId: "alice", sessionId: "s3", controller: busy, label: "busy" });
    expect((await free.stop({ agentId: "alice" }, "stop", { freeze: false })).stoppedRuns).toBe(1);
    expect(busy.signal.aborted).toBe(true);
    expect(free.isFrozen({ agentId: "alice", sessionId: "s4" })).toBe(false);
  });

  it("a narrower kill never lifts a wider one; resume lifts them all", async () => {
    const ks = new KillSwitch();
    await ks.stop("all", "stop all");
    await ks.stop({ agentId: "alice", sessionId: "s1" }, "stop session s1");
    expect(ks.isFrozen({ agentId: "bob", sessionId: "s2" })).toBe(true);
    ks.resume();
    await ks.stop({ agentId: "alice" }, "stop alice");
    await ks.stop({ sessionId: "s5" }, "stop s5");
    expect(ks.isFrozen({ agentId: "alice", sessionId: "s6" })).toBe(true);
    expect(ks.isFrozen({ agentId: "bob", sessionId: "s5" })).toBe(true);
    expect(ks.isFrozen({ agentId: "bob", sessionId: "s7" })).toBe(false);
    ks.resume();
    expect(ks.isFrozen({ agentId: "alice", sessionId: "s6" })).toBe(false);
    expect(ks.isFrozen({ agentId: "bob", sessionId: "s5" })).toBe(false);
  });

  it("resume clears what makes a kill survive a restart first; if that fails the kill stays", async () => {
    let cleared = 0;
    let fail = false;
    const ks = new KillSwitch(undefined, undefined, () => {
      if (fail) throw new Error("file held open");
      cleared++;
    });
    await ks.stop("all", "stop all");
    fail = true;
    expect(() => ks.resume()).toThrow("file held open");
    expect(ks.isFrozen({ agentId: "alice" })).toBe(true);
    fail = false;
    ks.resume();
    expect(cleared).toBe(1);
    expect(ks.isFrozen({ agentId: "alice" })).toBe(false);
  });

  it("stopTask ends one task's runs and revokes its tokens; the session and the rest go on (U-039)", () => {
    const tokens = new TokenIssuer();
    const stops: string[] = [];
    const ks = new KillSwitch(tokens, () => {
      stops.push("claims frozen");
    });
    ks.onStop(() => stops.push("kill switch notified"));
    const issue = (taskId: string) =>
      tokens.issue({
        runId: `r-${taskId}`,
        sessionId: "s1",
        agentId: "alice",
        ownerHumanId: "j",
        taskId,
        allowedTools: ["echo"],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
        budgetUsdMicro: 10,
        depth: 1,
        maxDepth: 2,
        autonomy: 2,
        planApproved: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const moved = issue("t-moved");
    const other = issue("t-other");
    const session = new AbortController();
    const movedRun = new AbortController();
    const movedHold = new AbortController();
    const otherRun = new AbortController();
    ks.register({ agentId: "alice", sessionId: "s1", controller: session, label: "session" });
    ks.register({
      agentId: "alice",
      sessionId: "s1",
      taskId: "t-moved",
      controller: movedRun,
      label: "run",
    });
    ks.register({
      agentId: "alice",
      sessionId: "s1",
      taskId: "t-moved",
      controller: movedHold,
      label: "hold",
    });
    ks.register({
      agentId: "alice",
      sessionId: "s1",
      taskId: "t-other",
      controller: otherRun,
      label: "run",
    });

    const report = ks.stopTask("t-moved", "cancelled by you");
    expect(report).toEqual({ stoppedRuns: 2, killedProcesses: 0, revokedTokens: 1 });
    expect(movedRun.signal.aborted && movedHold.signal.aborted).toBe(true);
    expect(movedRun.signal.reason).toMatchObject({ code: "killed", message: "cancelled by you" });
    expect(session.signal.aborted || otherRun.signal.aborted).toBe(false);
    expect(tokens.isRevoked(moved.claims.id)).toBe(true);
    expect(tokens.isRevoked(other.claims.id)).toBe(false);
    // Not the kill switch: nothing frozen, no claims touched, no kill notification.
    expect(ks.isFrozen({ agentId: "alice", sessionId: "s1" })).toBe(false);
    expect(stops).toEqual([]);
    expect(ks.activeCount({ sessionId: "s1" })).toBe(2);
    // Nothing of the task left: a second stop is a no-op.
    expect(ks.stopTask("t-moved")).toEqual({
      stoppedRuns: 0,
      killedProcesses: 0,
      revokedTokens: 0,
    });
  });
});
