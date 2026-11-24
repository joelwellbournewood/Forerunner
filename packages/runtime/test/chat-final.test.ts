import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform/paths";
import { afterAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { claimOf } from "../src/conversation/claims.ts";

/**
 * l4-chat-final, run L4 (L4h-left-7; the review of l4-chat-carried): "I don't see any changes."
 * and "I don't see any sessions." are about history, which recall covers, so they are absence
 * claims to look up first; NOW_STATE freed them as if they were about now. Sessions and changes in
 * a state now ("any running sessions", "any changes waiting for your yes") stay free.
 */
describe("l4-chat-final, run L4: an absence about sessions or changes is history unless it says now (L4h-left-7)", () => {
  it("claimOf: plain sessions and changes are absence claims; in a state now they are free", () => {
    for (const said of [
      "I don't see any changes.",
      "I don't see any sessions.",
      "I can't see any sessions in Quote Page.",
      "I don't see any changes yet.",
    ])
      expect(claimOf(said)?.kind, said).toBe("absent");
    for (const said of [
      "I don't see any running sessions.",
      "I see no running session.",
      "I don't see any changes waiting for your yes.",
      "I don't see any sessions running right now.",
      "I don't see any failed tasks.",
    ])
      expect(claimOf(said), said).toBeNull();
  });
});

/**
 * l4-chat-final, run L4 (L4h-left-7): the stand-in's chat model sent a "tool:" line whose input
 * named review.md to answer_thoroughly (its "review" word), so a bench walk had to avoid the word.
 * A "tool:" line is the stand-in's own call; and FORERUNNER_BENCH_CHAT_NOTE adds the note the
 * model makes up (L4h-left-1).
 */
describe("l4-chat-final, run L4: the stand-in's chat tool lines (L4h-left-7, L4h-left-1)", () => {
  const tools = [
    {
      name: "task_create",
      description: "Add a task.",
      input_schema: { type: "object", properties: { title: { type: "string" } } },
    },
    {
      name: "task_pause",
      description: "Pause a task.",
      input_schema: {
        type: "object",
        properties: { task: { type: "string" }, note: { type: "string" } },
      },
    },
    {
      name: "answer_thoroughly",
      description: "Think it through.",
      input_schema: { type: "object", properties: { why: { type: "string" } } },
    },
  ];
  const chatRequest = (line: string) => ({
    model: "fake",
    system: "You are the conversation agent.",
    messages: [{ role: "user" as const, content: line }],
    tools,
    origin: { label: "conversation" },
  });

  const dir = mkdtempSync(join(tmpdir(), "fr-chat-final-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a tool line naming review.md calls that tool, not answer_thoroughly; the made-up note goes on a call that takes one", async () => {
    const log = new ModelCallLog({ file: join(dir, "model-calls.jsonl") });
    const calls = (r: { content: { type: string; name?: string; input?: unknown }[] }) =>
      r.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input }));
    const plain = createRolePlayer(benchOptionsFromEnv({ FORERUNNER_BENCH_DELAY_MS: "0" }, log));
    const r = await plain.complete(
      chatRequest('tool: task_create {"title": "Write the review.md summary"}') as never,
    );
    expect(calls(r as never).map((c) => c.name)).toEqual(["task_create"]);
    const noting = createRolePlayer(
      benchOptionsFromEnv(
        {
          FORERUNNER_BENCH_DELAY_MS: "0",
          FORERUNNER_BENCH_CHAT_NOTE: "Put on hold by the person.",
        },
        log,
      ),
    );
    const pause = await noting.complete(
      chatRequest('tool: task_pause {"task": "Write the FAQ"}') as never,
    );
    expect(calls(pause as never)[0]?.input).toEqual({
      task: "Write the FAQ",
      note: "Put on hold by the person.",
    });
    const create = await noting.complete(
      chatRequest('tool: task_create {"title": "Write the FAQ"}') as never,
    );
    expect(calls(create as never)[0]?.input).toEqual({ title: "Write the FAQ" });
  });
});
