import { describe, expect, it } from "vitest";
import { type QueryLike, SdkAgentDriver, scrubEnv } from "../src/agent/sdk.ts";
import { budget, flatPricing, harness, issue, registry } from "./helpers.ts";

function fakeQuery(script: (opts: Record<string, unknown>) => Record<string, unknown>[]): {
  q: QueryLike;
  seen: Record<string, unknown>[];
} {
  const seen: Record<string, unknown>[] = [];
  const q: QueryLike = ({ options }) => {
    seen.push(options ?? {});
    const msgs = script(options ?? {});
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  };
  return { q, seen };
}

const assistant = (text: string, out = 10) => ({
  type: "assistant",
  message: {
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 100,
      output_tokens: out,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});

describe("SdkAgentDriver", () => {
  it("passes one credential, the token's limits and our hooks to the SDK and accounts usage", async () => {
    const h = harness();
    const { q, seen } = fakeQuery(() => [
      { type: "system", subtype: "init", session_id: "sdk-sess" },
      assistant("working"),
      assistant("done"),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0.0012,
      },
    ]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const res = await driver.run({
      token: issue(h, { allowedTools: ["cc:Read", "cc:Edit", "echo"], budgetUsdMicro: 2_500_000 }),
      budget: budget("sess-1", 5_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "oauth_token", value: "oat-value" },
      model: "claude-sonnet-5-5",
      effort: "medium",
      systemPrompt: "sys",
      prompt: "do it",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect(res.outcome).toBe("completed");
    expect(res.finalText).toBe("done");
    expect(res.numTurns).toBe(2);
    expect(res.sessionId).toBe("sdk-sess");
    expect(res.costUsdMicro).toBe(220);
    expect(h.ledger.entries).toHaveLength(2);
    const opts = seen[0]!;
    const env = opts.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-value");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.maxBudgetUsd).toBe(2.5);
    expect(opts.allowedTools).toEqual(["Edit", "Read", "mcp__forerunner__echo"]);
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
    expect(Object.keys(opts.hooks as object)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("PreToolUse hook denies tools outside the token and stops on budget exhaustion", async () => {
    const h = harness();
    let hooks: {
      PreToolUse: { hooks: ((i: Record<string, unknown>) => Promise<Record<string, unknown>>)[] }[];
    } | null = null;
    const { q } = fakeQuery((opts) => {
      hooks = opts.hooks as typeof hooks;
      return [
        assistant("x"),
        { type: "result", subtype: "success", is_error: false, result: "x", total_cost_usd: 0 },
      ];
    });
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    await driver.run({
      token: issue(h, { allowedTools: ["echo"], budgetUsdMicro: 1_000_000 }),
      budget: budget("sess-1", 5_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "api_key", value: "k" },
      model: "claude-sonnet-5-5",
      systemPrompt: "sys",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    const pre = hooks!.PreToolUse[0]!.hooks[0]!;
    const denied = await pre({
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "t1",
    });
    expect((denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe(
      "deny",
    );
    const allowed = await pre({
      tool_name: "mcp__forerunner__echo",
      tool_input: { text: "hi" },
      tool_use_id: "t2",
    });
    expect((allowed.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe(
      "allow",
    );
  });

  it("maps a budget stop from our hooks to a budget_exceeded outcome", async () => {
    const h = harness();
    const { q } = fakeQuery(() => [
      assistant("a", 5_000_000),
      assistant("b"),
      { type: "result", subtype: "success", is_error: false, result: "b", total_cost_usd: 0 },
    ]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const res = await driver.run({
      token: issue(h, { allowedTools: ["echo"], budgetUsdMicro: 1_000_000 }),
      budget: budget("sess-1", 50_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "api_key", value: "k" },
      model: "claude-sonnet-5-5",
      systemPrompt: "sys",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect(res.outcome).toBe("budget_exceeded");
  });

  it("ends a killed run the moment the abort fires, without waiting for the subprocess", async () => {
    const h = harness();
    let abort: AbortController | undefined;
    let released = false;
    const q: QueryLike = ({ options }) => {
      abort = (options as { abortController?: AbortController }).abortController;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-sess" };
        yield assistant("working");
        // The SDK keeps the iterator open after the abort while its subprocess winds down.
        await new Promise<void>((resolve) => {
          abort?.signal.addEventListener("abort", () => setTimeout(resolve, 5_000));
        });
        released = true;
      })();
    };
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const run = driver.run({
      token: issue(h, { allowedTools: ["echo"], budgetUsdMicro: 1_000_000 }),
      budget: budget("sess-1", 50_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "api_key", value: "k" },
      model: "claude-sonnet-5-5",
      systemPrompt: "sys",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(abort).toBeDefined();
    const before = Date.now();
    void h.kill.stop("all", "test");
    const res = await run;
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(res.outcome).toBe("killed");
    expect(released).toBe(false);
  });

  it("scrubs credentials from the subprocess environment", () => {
    const out = scrubEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "x",
      GITHUB_TOKEN: "y",
      MY_SECRET: "z",
      HOME: "/h",
      FOO_PASSWORD: "p",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH"]);
  });
});
