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
});
