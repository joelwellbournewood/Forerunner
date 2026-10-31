import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { type QueryLike, SdkAgentDriver } from "../src/agent/sdk.ts";
import {
  headroomSdkEnv,
  type ManagedChild,
  ManagedHeadroomProcess,
} from "../src/context/headroom.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { budget, flatPricing, harness, issue, registry } from "./helpers.ts";

function managed(logDir: string) {
  const killed: ManagedChild[] = [];
  const child: ManagedChild = { pid: 4242, stdout: null, stderr: null, once: () => undefined };
  const proc = new ManagedHeadroomProcess({
    port: 8792,
    logDir,
    env: { PATH: "/bin" },
    spawn: () => child,
    kill: (c) => killed.push(c),
  });
  return { proc, killed };
}

describe("headroom: managed proxy and the kill switch (ADR 0003 section 1)", () => {
  it("a global stop kills the managed proxy tree; a scoped stop leaves the shared proxy alone", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "fr-headroom-kill-"));
    try {
      const { proc, killed } = managed(logDir);
      const kill = new KillSwitch();
      expect(proc.start()).toBe(true);
      const unbind = proc.bindKillSwitch(kill);
      await kill.stop({ sessionId: "s1" }, "one session");
      expect(proc.running).toBe(true);
      expect(killed).toHaveLength(0);
      await kill.stop({ agentId: "a1" }, "one agent");
      expect(proc.running).toBe(true);
      kill.resume();
      await kill.stop("all", "big red button");
      expect(proc.running).toBe(false);
      expect(killed).toHaveLength(1);
      // Unbound: a later global stop no longer reaches a restarted proxy.
      unbind();
      kill.resume();
      expect(proc.start()).toBe(true);
      await kill.stop("all", "again");
      expect(proc.running).toBe(true);
      expect(killed).toHaveLength(1);
      proc.stop();
      expect(killed).toHaveLength(2);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("headroom: SDK driver environment (ADR 0003 'Use' row)", () => {
  it("the session's sdkEnv reaches the subprocess: base URL and the project header, credential untouched", async () => {
    const h = harness();
    const seen: Record<string, unknown>[] = [];
    const q: QueryLike = ({ options }) => {
      seen.push(options ?? {});
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-sess" };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          total_cost_usd: 0.001,
        };
      })();
    };
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const env = headroomSdkEnv("http://127.0.0.1:8787", "proj-1");
    const res = await driver.run({
      token: issue(h, { allowedTools: ["cc:Read"], budgetUsdMicro: 2_500_000 }),
      budget: budget("sess-1", 5_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "oauth_token", value: ["sk-ant-oat01-", "test-value"].join("") }, // not-a-secret
      model: "claude-sonnet-5-5",
      systemPrompt: "s",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
      env,
    });
    expect(res.outcome).toBe("completed");
    const sub = seen[0]?.env as Record<string, string | undefined>;
    expect(sub.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
    expect(sub.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Headroom-Project: proj-1");
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe(["sk-ant-oat01-", "test-value"].join(""));
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    // Without it nothing is routed: the plain env has no base URL.
    await driver.run({
      token: issue(h, { allowedTools: ["cc:Read"], budgetUsdMicro: 2_500_000 }),
      budget: budget("sess-2", 5_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "oauth_token", value: ["sk-ant-oat01-", "test-value"].join("") }, // not-a-secret
      model: "claude-sonnet-5-5",
      systemPrompt: "s",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    const plain = seen[1]?.env as Record<string, string | undefined>;
    expect(plain.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(plain.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
});
