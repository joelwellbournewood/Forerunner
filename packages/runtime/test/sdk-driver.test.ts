import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_PROMPT_TOKENS,
  type QueryLike,
  SDK_STOP_WAIT_MS,
  SdkAgentDriver,
  scrubEnv,
} from "../src/agent/sdk.ts";
import { budget, flatPricing, harness, issue, registry, until } from "./helpers.ts";

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
    // Claude Code's own limit is a second layer just above the run's cap of USD 2.50, so
    // Forerunner's stop comes first (budget-stop, ADR 0112); before, it was the cap itself.
    expect(opts.maxBudgetUsd).toBe(2.76);
    expect(opts.allowedTools).toEqual(["Edit", "Read", "mcp__forerunner__echo"]);
    expect(opts.permissionMode).toBe("dontAsk");
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
    expect(Object.keys(opts.hooks as object)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("PreToolUse hook denies tools outside the token and stops on budget exhaustion", async () => {
    const h = harness();
    type Pre = (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
    // The hooks are asked while the run goes on, as Claude Code asks them: after the run they
    // refuse everything (its token is ended, budget-stop), which the next case shows.
    let denied: Record<string, unknown> = {};
    let allowed: Record<string, unknown> = {};
    const q: QueryLike = ({ options }) => {
      const pre = (options as { hooks: { PreToolUse: { hooks: Pre[] }[] } }).hooks.PreToolUse[0]!
        .hooks[0]!;
      return (async function* () {
        yield assistant("x");
        denied = await pre({ tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" });
        allowed = await pre({
          tool_name: "mcp__forerunner__echo",
          tool_input: { text: "hi" },
          tool_use_id: "t2",
        });
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "x",
          total_cost_usd: 0,
        };
      })();
    };
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
      credential: { kind: "oauth_token", value: "oat-value" },
      model: "claude-sonnet-5-5",
      systemPrompt: "sys",
      prompt: "p",
      cwd: process.cwd(),
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect((denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe(
      "deny",
    );
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
      credential: { kind: "oauth_token", value: "oat-value" },
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
      credential: { kind: "oauth_token", value: "oat-value" },
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

/**
 * U-078 (ADR 0100): promotional API credits apply only when an API key is used off Claude
 * Code, so an API key never runs through Claude Code. The driver refuses one, and nothing in
 * the person's environment can make Claude Code use a key, a bearer token or another
 * provider's billing in place of the subscription's token.
 */
describe("SdkAgentDriver: only the subscription's token runs through Claude Code (U-078)", () => {
  const request = (
    h: ReturnType<typeof harness>,
    credential: { kind: "api_key" | "oauth_token"; value: string },
  ) => ({
    token: issue(h, { allowedTools: ["cc:Read"], budgetUsdMicro: 2_500_000 }),
    budget: budget("sess-1", 5_000_000, h.clock),
    billingSourceId: "bs",
    credential,
    model: "claude-sonnet-5-5",
    systemPrompt: "s",
    prompt: "p",
    cwd: process.cwd(),
    tools: registry(),
    pricing: flatPricing,
    timeoutMs: 60_000,
  });

  it("refuses an API key with a ForerunnerError before Claude Code starts", async () => {
    const h = harness();
    const { q, seen } = fakeQuery(() => [{ type: "result", subtype: "success", is_error: false }]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const key = ["sk-ant-", "api03-", "k".repeat(20)].join(""); // not-a-secret
    for (const credential of [
      { kind: "api_key" as const, value: key },
      // A key handed over as if it were the subscription's token is refused the same way.
      { kind: "oauth_token" as const, value: key },
    ]) {
      const err = await driver.run(request(h, credential)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ForerunnerError);
      expect((err as ForerunnerError).code).toBe("provider_auth");
      expect((err as ForerunnerError).message).toContain("never runs through Claude Code");
      expect((err as ForerunnerError).message).not.toContain(key);
    }
    expect(seen).toHaveLength(0);
  });

  it("hands Claude Code the token as CLAUDE_CODE_OAUTH_TOKEN and no API key, even one in the session's env", async () => {
    const h = harness();
    const { q, seen } = fakeQuery(() => [{ type: "result", subtype: "success", is_error: false }]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    await driver.run({
      ...request(h, { kind: "oauth_token", value: "oat-value" }),
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_API_KEY: "sneaked" },
    });
    const env = seen[0]?.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-value");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787");
  });

  it("scrubEnv strips every variable that would make Claude Code bill another way", () => {
    const names = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "CLAUDE_CODE_GATEWAY_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    ];
    const out = scrubEnv({
      PATH: "/bin",
      HOME: "/h",
      LANG: "de_CH.UTF-8",
      ...Object.fromEntries(names.map((n) => [n, "1"])),
    });
    for (const n of names) expect(out[n], n).toBeUndefined();
    expect(out).toEqual({ PATH: "/bin", HOME: "/h", LANG: "de_CH.UTF-8" });
  });

  it("a usage limit from Claude Code ends the run with provider_usage_limit and the reset time", async () => {
    const h = harness();
    const resetsAt = Date.parse("2026-11-01T15:00:00Z") / 1000;
    const { q } = fakeQuery(() => [
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      },
      {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] },
      },
      { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" },
    ]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const res = await driver.run(request(h, { kind: "oauth_token", value: "oat-value" }));
    expect(res.outcome).toBe("error");
    expect(res.error).toEqual({
      code: "provider_usage_limit",
      message:
        "The Claude subscription's usage limit is reached: You've hit your limit · resets 3pm",
      resetAt: "2026-11-01T15:00:00.000Z",
    });
  });
});

/**
 * Budget-stop (ADR 0112, U-042): Forerunner's budget refusal used to end only Forerunner's
 * for-await loop. Claude Code went on editing the task's folder and using the plan, out of
 * reach of Stop now (the run had left the kill switch) and with the hooks still allowing tools.
 * Now every stop that is not the kill switch's waits until Claude Code has exited (bounded, then
 * it is ended), the run stays reachable by Stop now meanwhile, and its token is refused after.
 */
describe("SdkAgentDriver: a budget stop really stops Claude Code (budget-stop)", () => {
  type Pre = (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * A stand-in for Claude Code: after each assistant message it asks PreToolUse for a tool (what
   * the real process does before it edits a file), and it goes on until its abort controller
   * fires; then it takes `exitMs` to wind down. With `ignoreAbort` it goes on until `close()`.
   * From the second message on, each costs more than the run's cap, so the budget stops it.
   */
  function claudeCodeLike(opts: { exitMs: number; ignoreAbort?: boolean; lateResult?: boolean }) {
    const state = {
      exited: false,
      closed: false,
      decisions: [] as { afterStop: boolean; allowed: boolean }[],
    };
    const q: QueryLike = ({ options }) => {
      const ac = (options as { abortController: AbortController }).abortController;
      const pre = (options as { hooks: { PreToolUse: { hooks: Pre[] }[] } }).hooks.PreToolUse[0]!
        .hooks[0]!;
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "cc" };
        for (let i = 0; ; i++) {
          if (state.closed || (ac.signal.aborted && !opts.ignoreAbort)) {
            if (!state.closed) await new Promise((r) => setTimeout(r, opts.exitMs));
            // An aborted query's own error result, as it winds down.
            if (opts.lateResult)
              yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                result: "Claude Code process aborted by user",
                total_cost_usd: 0,
              };
            state.exited = true;
            return;
          }
          yield {
            type: "assistant",
            message: {
              id: `msg_${i}`,
              content: [{ type: "tool_use", id: `t${i}`, name: "mcp__forerunner__echo" }],
              usage: {
                input_tokens: 100,
                output_tokens: i >= 1 ? 2_000_000 : 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          };
          const d = await pre({
            tool_name: "mcp__forerunner__echo",
            tool_input: { text: `write ${i}` },
            tool_use_id: `t${i}`,
          });
          const allowed =
            (d.hookSpecificOutput as { permissionDecision?: string } | undefined)
              ?.permissionDecision === "allow";
          state.decisions.push({ afterStop: ac.signal.aborted, allowed });
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      return Object.assign(gen, {
        close() {
          state.closed = true;
        },
      });
    };
    return { q, state };
  }

  const req = (h: ReturnType<typeof harness>, taskId = "task-1") => ({
    token: issue(h, { allowedTools: ["echo"], budgetUsdMicro: 1_000_000, taskId }),
    budget: budget("sess-1", 50_000_000, h.clock),
    billingSourceId: "bs",
    credential: { kind: "oauth_token" as const, value: "oat-value" },
    model: "claude-sonnet-5-5",
    systemPrompt: "sys",
    prompt: "p",
    cwd: process.cwd(),
    tools: registry(),
    pricing: flatPricing,
    timeoutMs: 600_000,
  });
  const driverOf = (h: ReturnType<typeof harness>, q: QueryLike) =>
    new SdkAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock, queryImpl: q });

  it("returns only after Claude Code has exited, and no tool is allowed after the stop", async () => {
    const h = harness();
    const { q, state } = claudeCodeLike({ exitMs: 150 });
    const res = await driverOf(h, q).run(req(h));
    expect(res.outcome).toBe("budget_exceeded");
    // Before: the run returned while the stand-in went on asking for tools, and they were allowed.
    expect(state.exited).toBe(true);
    expect(state.decisions.some((d) => d.afterStop)).toBe(true);
    expect(state.decisions.filter((d) => d.afterStop && d.allowed)).toEqual([]);
    expect(h.kill.activeCount()).toBe(0);
  });

  // Review of budget-stop: the drain read a late error result like any other, so an aborted
  // query's own "error_during_execution" turned the budget pause into a Failed task tried again.
  it("a late error result while Claude Code winds down leaves the budget stop as it was", async () => {
    const h = harness();
    const { q, state } = claudeCodeLike({ exitMs: 10, lateResult: true });
    const res = await driverOf(h, q).run(req(h));
    expect(state.exited).toBe(true);
    expect(res.outcome).toBe("budget_exceeded");
    expect(res.error?.code).toBe("budget_exceeded");
    expect(res.finalText).not.toContain("aborted by user");
  });

  it("the hooks refuse a tool call that arrives after run() returned (its token is ended)", async () => {
    const h = harness();
    let pre: Pre | undefined;
    const { q } = fakeQuery((opts) => {
      pre = (opts.hooks as { PreToolUse: { hooks: Pre[] }[] }).PreToolUse[0]!.hooks[0]!;
      return [
        assistant("x"),
        { type: "result", subtype: "success", is_error: false, result: "x", total_cost_usd: 0 },
      ];
    });
    const res = await driverOf(h, q).run(req(h));
    expect(res.outcome).toBe("completed");
    const late = await pre!({
      tool_name: "mcp__forerunner__echo",
      tool_input: { text: "late" },
      tool_use_id: "late",
    });
    // Before: allowed.
    expect(late.continue).toBe(false);
    expect(
      (late.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
    ).not.toBe("allow");
  });

  it("Stop now reaches the run while Claude Code winds down, and ends it at once", async () => {
    const h = harness();
    const { q, state } = claudeCodeLike({ exitMs: 0, ignoreAbort: true });
    let done = false;
    const run = driverOf(h, q)
      .run(req(h, "task-7"))
      .then((r) => {
        done = true;
        return r;
      });
    // The budget stop came (the second message is over the cap); the stand-in ignores the abort.
    await until(() => state.decisions.some((d) => d.afterStop), "a tool call after the stop");
    expect(done).toBe(false);
    // Before: the run had left the kill switch, so Stop now found nothing to stop.
    expect(h.kill.hasTask("task-7")).toBe(true);
    const report = await h.kill.stop("all", "Stop now", { by: "you", freeze: false });
    expect(report.stoppedRuns).toBeGreaterThanOrEqual(1);
    const res = await run;
    expect(res.outcome).toBe("budget_exceeded");
    expect(state.closed).toBe(true);
    expect(state.decisions.filter((d) => d.afterStop && d.allowed)).toEqual([]);
  });

  it("a process that does not wind down is ended after the wait", async () => {
    const h = harness();
    const { q, state } = claudeCodeLike({ exitMs: 0, ignoreAbort: true });
    let done = false;
    const run = driverOf(h, q)
      .run(req(h))
      .then((r) => {
        done = true;
        return r;
      });
    await until(() => state.decisions.some((d) => d.afterStop), "a tool call after the stop");
    expect(done).toBe(false);
    await h.clock.advance(SDK_STOP_WAIT_MS);
    const res = await run;
    expect(res.outcome).toBe("budget_exceeded");
    expect(state.closed).toBe(true);
    expect(h.kill.activeCount()).toBe(0);
  });

  it("counts each message once by its id and takes the output from the result", async () => {
    const h = harness();
    const msg = (id: string, input: number, block: Record<string, unknown>) => ({
      type: "assistant",
      message: {
        id,
        content: [block],
        // The output count on a streamed message is a placeholder (Agent SDK cost tracking).
        usage: {
          input_tokens: input,
          output_tokens: 1,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const { q } = fakeQuery(() => [
      // Two parallel tool calls: two messages with one id and one usage.
      msg("msg_1", 100, { type: "tool_use", id: "a", name: "Read" }),
      msg("msg_1", 100, { type: "tool_use", id: "b", name: "Read" }),
      msg("msg_2", 200, { type: "text", text: "done" }),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0.00036,
        usage: {
          input_tokens: 300,
          output_tokens: 60,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {
          "claude-sonnet-5-5": {
            inputTokens: 300,
            outputTokens: 60,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.00036,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        },
      },
    ]);
    const res = await driverOf(h, q).run(req(h));
    expect(res.outcome).toBe("completed");
    // Before: input 400 (msg_1 twice) and output 3 (the placeholders).
    expect(res.usage).toEqual({
      input_tokens: 300,
      output_tokens: 60,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    });
    expect(res.costUsdMicro).toBe(360);
    expect(h.ledger.entries.reduce((n, e) => n + e.usdMicro, 0)).toBe(360);
    expect(h.ledger.entries.reduce((n, e) => n + e.tokensIn, 0)).toBe(300);
  });

  it("Claude Code's own spending stop reads as a budget stop, not a passing glitch", async () => {
    const h = harness();
    const { q } = fakeQuery(() => [
      assistant("working"),
      {
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: [],
        total_cost_usd: 1.2,
      },
    ]);
    const res = await driverOf(h, q).run(req(h));
    // Before: "error" with provider_error, which the runner tries again at once.
    expect(res.outcome).toBe("budget_exceeded");
    expect(res.error?.code).toBe("budget_exceeded");
    expect(res.error?.level).toBe("run");
  });

  it("sets Claude Code's own limit slightly above the run's cap, so Forerunner's stop comes first", async () => {
    const h = harness();
    const { q, seen } = fakeQuery(() => [
      { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0 },
    ]);
    await driverOf(h, q).run(req(h));
    const max = seen[0]?.maxBudgetUsd as number;
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(1.2);
  });
});

describe("SdkAgentDriver: the pre-call worst case on the subscription (cost)", () => {
  it("prices the first call from the brief and Claude Code's own prompt, and each next one from the whole prompt its last call sent", async () => {
    const h = harness();
    const asked: { input: number; out: number; cached: number }[] = [];
    const pricing = {
      estimate: (input: number, out: number, cached = 0) => {
        asked.push({ input, out, cached });
        return flatPricing.estimate(input, out);
      },
      cost: flatPricing.cost,
    };
    const turn = {
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "text", text: "reading" }],
        // Claude Code caches its prompt: the plain remainder is small, the prompt is not.
        usage: {
          input_tokens: 40,
          output_tokens: 300,
          cache_read_input_tokens: 18_000,
          cache_creation_input_tokens: 2_000,
        },
      },
    };
    const { q } = fakeQuery(() => [
      turn,
      { type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0 },
    ]);
    const driver = new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    });
    const brief = "Write the home page. ".repeat(400); // ~2k tokens
    await driver.run({
      token: issue(h, { allowedTools: ["cc:Read"], budgetUsdMicro: 2_500_000 }),
      budget: budget("sess-1", 5_000_000, h.clock),
      billingSourceId: "bs",
      credential: { kind: "oauth_token", value: "oat-value" },
      model: "claude-sonnet-5-5",
      systemPrompt: "You are the coder.",
      prompt: brief,
      cwd: process.cwd(),
      tools: registry(),
      pricing,
      timeoutMs: 60_000,
    });
    // Before: the step cap (200) stood for the first call's input, so its worst case, and with
    // it the run's wrap-up reserve, was almost only the output ceiling.
    expect(asked[0]?.input).toBeGreaterThanOrEqual(
      CLAUDE_CODE_PROMPT_TOKENS + Math.ceil(brief.length / 4),
    );
    expect(asked[0]?.cached ?? 0).toBe(0);
    // The next call sends at least the whole prompt of the last one (20,040 tokens, all but 40
    // of them from the cache) and that call's reply; before, only the 40 plain tokens counted.
    expect(asked[1]).toEqual({ input: 20_040 + 300, out: 4096, cached: 20_000 });
  });
});
