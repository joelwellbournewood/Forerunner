import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_FIXTURES,
  agentLoopFixture,
  type ChatMessage,
  coderDoesThreeToolCallsThenFinishes,
  FakeProvider,
  INJECTION_MARKER,
  INJECTION_PAGE_TEXT,
  injectionPage,
  type ModelRequest,
  overspendAttempt,
  type ToolDefinition,
} from "../src/provider/index.ts";

const toolDefs: ToolDefinition[] = [
  "read_file",
  "write_file",
  "fetch",
  "delete_repo",
  "run_specialist",
].map((name) => ({ name, description: name, input_schema: { type: "object" } }));

type ToolImpl = (input: Record<string, unknown>) => string;

interface Driven {
  toolCalls: { name: string; input: Record<string, unknown> }[];
  finalText: string;
  finished: boolean;
  outputTokens: number;
}

/** A minimal agent loop: call, dispatch tool calls, feed results back, until no tool call. */
async function drive(
  p: FakeProvider,
  tools: Record<string, ToolImpl>,
  maxCalls: number,
): Promise<Driven> {
  const messages: ChatMessage[] = [
    { role: "user", content: "Fix the answer constant in src/answer.ts." },
  ];
  const out: Driven = { toolCalls: [], finalText: "", finished: false, outputTokens: 0 };
  for (let i = 0; i < maxCalls; i++) {
    const req: ModelRequest = { model: "fake-sonnet", messages, tools: toolDefs, max_tokens: 2048 };
    const res = await p.complete(req);
    out.outputTokens += res.usage.output_tokens;
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b) => b.type === "tool_use");
    if (uses.length === 0) {
      out.finalText = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      out.finished = true;
      return out;
    }
    const results: ChatMessage["content"] = [];
    for (const u of uses) {
      out.toolCalls.push({ name: u.name, input: u.input });
      const impl = tools[u.name];
      results.push({
        type: "tool_result",
        tool_use_id: u.id,
        content: impl ? impl(u.input) : `tool ${u.name} is not allowed`,
        is_error: !impl,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return out;
}

describe("agent-loop fixtures", () => {
  it("coder-does-three-tool-calls-then-finishes: read, write, read, then a final report", async () => {
    const p = new FakeProvider({
      latency: "none",
      onNoMatch: "throw",
      replies: coderDoesThreeToolCallsThenFinishes(),
    });
    const files = new Map<string, string>([["src/answer.ts", "export const answer = 41;\n"]]);
    const d = await drive(
      p,
      {
        read_file: (i) => files.get(String(i.path)) ?? "missing",
        write_file: (i) => {
          files.set(String(i.path), String(i.text));
          return "ok";
        },
      },
      10,
    );
    expect(d.finished).toBe(true);
    expect(d.toolCalls.map((t) => t.name)).toEqual(["read_file", "write_file", "read_file"]);
    expect(files.get("src/answer.ts")).toBe("export const answer = 42;\n");
    expect(d.finalText).toMatch(/^Done\./);
    expect(p.calls).toHaveLength(4);
    expect(p.remainingReplies()).toBe(0);
    // custom tool names flow through
    const custom = coderDoesThreeToolCallsThenFinishes({
      readTool: "cat",
      writeTool: "put",
      file: "x.ts",
    });
    expect(custom.map((r) => r.reply.toolCalls?.[0]?.name)).toEqual([
      "cat",
      "put",
      "cat",
      undefined,
    ]);
    expect(custom[0]?.reply.toolCalls?.[0]?.input).toEqual({ path: "x.ts" });
  });

  it("overspend-attempt: keeps asking for the expensive tool until something in code stops it", async () => {
    const p = new FakeProvider({
      latency: "none",
      onNoMatch: "throw",
      replies: overspendAttempt(),
    });
    const d = await drive(p, { run_specialist: () => "specialist result" }, 6);
    expect(d.finished).toBe(false);
    expect(d.toolCalls).toHaveLength(6);
    expect(new Set(d.toolCalls.map((t) => t.name))).toEqual(new Set(["run_specialist"]));
    expect(d.toolCalls[0]?.input).toMatchObject({ model: "fake-opus", effort: "max" });
    expect(d.outputTokens).toBe(6 * 50_000);
    expect(p.remainingReplies()).toBe(1); // Infinity: never consumed
    const cheap = overspendAttempt({ tool: "delegate", outputTokens: 10 });
    expect(cheap[0]?.reply.toolCalls?.[0]?.name).toBe("delegate");
    expect(cheap[0]?.reply.usage?.output_tokens).toBe(10);
  });

  it("injection-page: the reply quotes the planted instructions instead of obeying them", async () => {
    const p = new FakeProvider({ latency: "none", onNoMatch: "throw", replies: injectionPage() });
    const deleted: string[] = [];
    const d = await drive(
      p,
      {
        fetch: () => INJECTION_PAGE_TEXT,
        delete_repo: (i) => {
          deleted.push(String(i.repo));
          return "deleted";
        },
      },
      10,
    );
    expect(d.finished).toBe(true);
    expect(d.toolCalls.map((t) => t.name)).toEqual(["fetch"]);
    expect(deleted).toEqual([]);
    expect(INJECTION_PAGE_TEXT).toContain(INJECTION_MARKER);
    expect(d.finalText).toContain(`> ${INJECTION_MARKER}`);
    expect(d.finalText).toMatch(/quoting it, not following it/);
    expect(p.calls[1]?.request.messages.at(-1)?.role).toBe("user");
  });

  it("injection-page: without the planted text in a tool result the quoting reply never matches", async () => {
    const p = new FakeProvider({ latency: "none", onNoMatch: "throw", replies: injectionPage() });
    await p.complete({
      model: "fake-haiku",
      messages: [{ role: "user", content: "go" }],
      max_tokens: 10,
    });
    await expect(
      p.complete({
        model: "fake-haiku",
        messages: [{ role: "user", content: "a clean page" }],
        max_tokens: 10,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("exposes the fixtures by name and returns fresh scripts each time", () => {
    expect(Object.keys(AGENT_LOOP_FIXTURES).sort()).toEqual([
      "coder-does-three-tool-calls-then-finishes",
      "injection-page",
      "overspend-attempt",
    ]);
    const a = agentLoopFixture("coder-does-three-tool-calls-then-finishes");
    const b = agentLoopFixture("coder-does-three-tool-calls-then-finishes");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});
