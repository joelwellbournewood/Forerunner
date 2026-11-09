import { describe, expect, it } from "vitest";
import { LoopAgentDriver, type RunEvent, WRAP_UP_MARK, wrapUpText } from "../src/agent/loop.ts";

/** A fixed wrap-up text: these cases test where and how often it goes (W15-16: the runtime's own
 * text is worded from the run's spend when it is sent). */
const WRAP_UP_TEXT = wrapUpText(50_000, 250_000);

import { type QueryLike, SdkAgentDriver } from "../src/agent/sdk.ts";
import type { ChatMessage } from "../src/provider/types.ts";
import { budget, flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * Budget-stop (ADR 0112, the owner's decision of 2026-11-02): at its wrap-up line (the run's cap
 * less the reserve) a task's run hears once that about a fifth of its budget is left. On the
 * loop driver it is one text block after the last tool results of the next request, never inside
 * a tool result; on the Agent SDK path it is PostToolUse's `additionalContext`, once. A budget
 * too small to wrap up hears nothing. Before, the 80% decision was only a warning event: the
 * model started new work until the call that would go over was refused.
 */

const textBlocks = (m: ChatMessage | undefined) =>
  Array.isArray(m?.content) ? m.content.filter((b) => b.type === "text") : [];

describe("the loop's wrap-up message (budget-stop)", () => {
  function run(capUsdMicro: number, calls: number, opts: { wrapUp?: boolean } = {}) {
    const h = harness();
    // Each reply asks for one more echo and costs about 5 000 micro-USD; the last one reports.
    const provider = new ScriptedProvider(
      [
        ...Array.from({ length: calls - 1 }, () => ({
          text: "Working.",
          tools: [{ name: "echo", input: { text: "part" } }],
          usage: { input_tokens: 5_000, output_tokens: 10 },
        })),
        {
          text: "Where I stopped: two parts.\n\nLeft to do:\n- the third part",
          usage: { input_tokens: 5_000, output_tokens: 10 },
        },
      ],
      h.clock,
    );
    const events: RunEvent[] = [];
    const result = new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }).run({
      token: issue(h, { budgetUsdMicro: capUsdMicro }),
      budget: budget("sess-1", 50_000_000, h.clock),
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "You are a test agent.",
      messages: [{ role: "user", content: "do the parts" }],
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
      maxTokensPerCall: 1_000,
      ...(opts.wrapUp === false ? {} : { wrapUp: WRAP_UP_TEXT }),
      onEvent: (e) => events.push(e),
    });
    return { h, provider, events, result };
  }

  it("a run reaching its line gets exactly one wrap-up block after its tool results, in the next request", async () => {
    const { provider, events, result } = run(30_000, 6);
    const res = await result;
    expect(res.outcome).toBe("completed");
    expect(res.wrapUpSent).toBe(true);
    const carrying = provider.calls.filter((c) =>
      c.messages.some((m) => textBlocks(m).some((b) => b.text === WRAP_UP_TEXT)),
    );
    // Every request after the wrap-up carries the conversation, so the first one decides.
    const first = provider.calls.findIndex((c) => carrying.includes(c));
    expect(first).toBeGreaterThan(0);
    const last = provider.calls[first]?.messages.at(-1);
    expect(last?.role).toBe("user");
    const blocks = Array.isArray(last?.content) ? last.content : [];
    // The tool results first, then the one text block: never inside a tool result.
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(textBlocks(last)).toEqual([{ type: "text", text: WRAP_UP_TEXT }]);
    expect(JSON.stringify(blocks[0])).not.toContain(WRAP_UP_MARK);
    // Once: the whole conversation of the last request holds one wrap-up block.
    const all = provider.calls.at(-1)?.messages ?? [];
    expect(all.flatMap((m) => textBlocks(m)).filter((b) => b.text === WRAP_UP_TEXT)).toHaveLength(
      1,
    );
    // The run's budget line was said at its start, with the reserve.
    expect(events.find((e) => e.type === "budget_line")).toMatchObject({
      type: "budget_line",
      capUsdMicro: 30_000,
      saveOnly: false,
    });
  });

  it("a tiny budget hears no wrap-up in any request, and its line says save only", async () => {
    const { provider, events, result } = run(3_000, 8);
    const res = await result;
    expect(res.outcome).toBe("budget_exceeded");
    expect(res.wrapUpSent).toBe(false);
    for (const c of provider.calls) expect(JSON.stringify(c.messages)).not.toContain(WRAP_UP_MARK);
    expect(events.find((e) => e.type === "budget_line")).toMatchObject({ saveOnly: true });
  });

  // Review of budget-stop: a budget below one call's worst case was refused before its line was
  // reported, so the session log had no budget line at all (live check 3's CHF 0.02 on Sonnet).
  it("a budget too small for even its first call still says its save-only line", async () => {
    const { provider, events, result } = run(500, 3);
    const res = await result;
    expect(res.outcome).toBe("budget_exceeded");
    expect(provider.calls).toHaveLength(0);
    const line = events.find((e) => e.type === "budget_line");
    expect(line).toMatchObject({ capUsdMicro: 500, lineUsdMicro: 0, saveOnly: true });
    expect((line as { firstCallUsdMicro: number }).firstCallUsdMicro).toBeGreaterThan(500);
    // Said before the run ends, so the session log has it.
    expect(events.map((e) => e.type)).toEqual(["run_start", "budget_line", "run_end"]);
  });

  it("a run that is not a task's (no wrap-up text asked for) is never given one", async () => {
    const { provider, result } = run(30_000, 6, { wrapUp: false });
    const res = await result;
    expect(res.wrapUpSent).toBe(false);
    for (const c of provider.calls) expect(JSON.stringify(c.messages)).not.toContain(WRAP_UP_MARK);
  });
});

describe("the Agent SDK path's wrap-up message (budget-stop)", () => {
  type Hook = (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
  it("PostToolUse returns the wrap-up once as additionalContext after the line", async () => {
    const h = harness();
    const outputs: Record<string, unknown>[] = [];
    const q: QueryLike = ({ options }) => {
      const hooks = (options as { hooks: { PostToolUse: { hooks: Hook[] }[] } }).hooks;
      const post = hooks.PostToolUse[0]?.hooks[0] as Hook;
      return (async function* () {
        for (let i = 0; i < 6; i++) {
          yield {
            type: "assistant",
            message: {
              id: `msg_${i}`,
              content: [{ type: "tool_use", id: `t${i}`, name: "mcp__forerunner__echo" }],
              usage: {
                // About 14% of the cap each: the fifth message's next call would pass the line.
                input_tokens: 140_000,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          };
          outputs.push(
            await post({
              tool_name: "mcp__forerunner__echo",
              tool_input: { text: "x" },
              tool_use_id: `t${i}`,
              tool_response: "ok",
            }),
          );
        }
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "done",
          total_cost_usd: 0,
        };
      })();
    };
    const res = await new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    }).run({
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
      wrapUp: WRAP_UP_TEXT,
    });
    expect(res.outcome).toBe("completed");
    expect(res.wrapUpSent).toBe(true);
    const contexts = outputs
      .map(
        (o) =>
          (o.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
      )
      .filter(Boolean);
    expect(contexts).toEqual([WRAP_UP_TEXT]);
    // Not before the line: the first results carry nothing.
    expect(
      (outputs[0]?.hookSpecificOutput as { additionalContext?: string } | undefined)
        ?.additionalContext,
    ).toBeUndefined();
  });

  it("a budget too small for even its first call still says its save-only line (review of budget-stop)", async () => {
    const h = harness();
    let started = false;
    const q: QueryLike = () => {
      started = true;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done" };
      })();
    };
    const events: RunEvent[] = [];
    const res = await new SdkAgentDriver({
      hooks: h.hooks,
      kill: h.kill,
      clock: h.clock,
      queryImpl: q,
    }).run({
      token: issue(h, { allowedTools: ["echo"], budgetUsdMicro: 500 }),
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
      wrapUp: WRAP_UP_TEXT,
      onEvent: (e) => events.push(e),
    });
    expect(res.outcome).toBe("budget_exceeded");
    // Claude Code was never started.
    expect(started).toBe(false);
    expect(events.find((e) => e.type === "budget_line")).toMatchObject({
      capUsdMicro: 500,
      saveOnly: true,
    });
    expect(events.at(-1)?.type).toBe("run_end");
  });
});
