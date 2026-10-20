import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRecordingsRoot,
  FakeProvider,
  type ModelRequest,
  type Recording,
  RecordingStore,
  requestFingerprint,
  requestHash,
  textReply,
  toolReply,
} from "../src/provider/index.ts";

const base: ModelRequest = {
  model: "fake-sonnet",
  system: "You are a coding specialist.",
  messages: [
    { role: "user", content: "Fix the failing test in src/answer.ts" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "src/answer.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "export const answer = 41;" }],
    },
  ],
  tools: [
    { name: "write_file", description: "write", input_schema: { type: "object" } },
    { name: "read_file", description: "read", input_schema: { type: "object" } },
  ],
  max_tokens: 1024,
  effort: "medium",
};

describe("request hash", () => {
  it("is stable across runs and platforms for the same request", () => {
    // The constant below was computed once; a change here means recordings stop resolving.
    expect(requestHash(base)).toBe("a4a228981102f9bebe64f4175109d0c5");
    expect(requestHash(structuredClone(base))).toBe(requestHash(base));
  });

  it("ignores fields that do not change the answer and tool order, but not content", () => {
    const h = requestHash(base);
    const ac = new AbortController();
    expect(
      requestHash({
        ...base,
        max_tokens: 5,
        effort: "max",
        signal: ac.signal,
        cache: { system: true },
      }),
    ).toBe(h);
    expect(requestHash({ ...base, tools: [...(base.tools ?? [])].reverse() })).toBe(h);
    expect(requestHash({ ...base, model: "fake-opus" })).not.toBe(h);
    expect(requestHash({ ...base, system: "other" })).not.toBe(h);
    expect(requestHash({ ...base, messages: [{ role: "user", content: "hi" }] })).not.toBe(h);
    expect(requestHash({ ...base, tools: [] })).not.toBe(h);
    // key order inside messages does not matter: the fingerprint is canonical
    const reordered: ModelRequest = {
      ...base,
      messages: [
        { content: "Fix the failing test in src/answer.ts", role: "user" },
        ...base.messages.slice(1),
      ],
    };
    expect(requestHash(reordered)).toBe(h);
  });

  it("fingerprints model, system, messages and sorted tool names only", () => {
    const fp = requestFingerprint(base);
    expect(Object.keys(fp).sort()).toEqual(["messages", "model", "system", "tools"]);
    expect(fp.tools).toEqual(["read_file", "write_file"]);
    expect(fp.messages).toEqual(base.messages);
    expect(fp.messages).not.toBe(base.messages);
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });
});

describe("RecordingStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-recordings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function recording(hash: string): Recording {
    return {
      version: 1,
      hash,
      suite: "unit",
      recordedAt: "2026-01-05T08:00:00.000Z",
      provider: "anthropic",
      request: requestFingerprint(base),
      reply: { text: "fixed", stopReason: "end_turn", ttftMs: 120, totalMs: 400 },
    };
  }

  it("round-trips a recording through a pretty-printed, sorted, LF-only JSON file", async () => {
    const store = new RecordingStore({ suite: "my suite/one", root: dir });
    expect(store.dir).toBe(join(dir, "my-suite-one"));
    const hash = requestHash(base);
    expect(store.has(hash)).toBe(false);
    expect(store.load(hash)).toBeUndefined();
    const file = store.save(recording(hash));
    expect(file).toBe(join(store.dir, `${hash}.json`));
    expect(store.has(hash)).toBe(true);
    expect(store.list()).toEqual([hash]);
    expect(store.load(hash)).toEqual(recording(hash));

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("\r");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('\n  "hash": ');
    const lines = raw.split("\n");
    const topKeys = lines
      .filter((l) => /^ {2}"[a-zA-Z]+":/.test(l))
      .map((l) => l.trim().split(":")[0]?.replace(/"/g, ""));
    expect(topKeys).toEqual([...topKeys].sort());
    expect(topKeys).toEqual([
      "hash",
      "provider",
      "recordedAt",
      "reply",
      "request",
      "suite",
      "version",
    ]);
  });

  it("refuses corrupt or mismatched files with a validation error and needs a suite", async () => {
    const store = new RecordingStore({ suite: "unit", root: dir });
    const hash = requestHash(base);
    store.save(recording(hash));
    await writeFile(store.pathFor("deadbeef"), "{ not json", "utf8");
    expect(() => store.load("deadbeef")).toThrow(ForerunnerError);
    await writeFile(
      store.pathFor("cafe"),
      JSON.stringify({ version: 1, hash: "other", reply: {}, request: {} }),
    );
    const err = (() => {
      try {
        store.load("cafe");
        return undefined;
      } catch (e) {
        return e as ForerunnerError;
      }
    })();
    expect(err?.code).toBe("validation");
    expect(err?.message).toContain("carries hash other");
    await writeFile(
      store.pathFor("v9"),
      JSON.stringify({ version: 9, hash: "v9", reply: {}, request: {} }),
    );
    expect(() => store.load("v9")).toThrow(/unknown format/);
    expect(() => new RecordingStore({ suite: "" })).toThrow(/suite/);
    expect(defaultRecordingsRoot()).toMatch(/testenv[\\/]recordings$/);
  });
});

describe("record and replay modes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-replay-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replay throws a clear error naming the hash, the file and how to record", async () => {
    const store = new RecordingStore({ suite: "loop", root: dir });
    const p = new FakeProvider({ mode: "replay", store, latency: "none" });
    const caught: unknown = await p.complete(base).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ForerunnerError);
    const err = caught as ForerunnerError;
    expect(err.code).toBe("not_found");
    expect(err.message).toContain(requestHash(base));
    expect(err.message).toContain(store.pathFor(requestHash(base)));
    expect(err.message).toContain('mode: "record"');
    expect(err.details).toMatchObject({ hash: requestHash(base), suite: "loop" });
    expect(p.calls).toHaveLength(1);
  });

  it("record mode forwards to the inner provider, saves the reply, and replay reproduces it", async () => {
    const clock = new SimulatedClock("2026-03-01T12:00:00Z");
    const store = new RecordingStore({ suite: "loop", root: dir });
    const inner = new FakeProvider({
      clock,
      latency: "none",
      replies: [
        {
          reply: {
            text: "Writing the fix now.",
            thinking: "41 should be 42",
            toolCalls: [
              {
                id: "toolu_live_1",
                name: "write_file",
                input: { path: "src/answer.ts", text: "42" },
              },
            ],
            usage: { input_tokens: 321, output_tokens: 45, cache_read_input_tokens: 100 },
          },
        },
      ],
    });
    const recorder = new FakeProvider({ mode: "record", inner, store, clock });
    const live = await recorder.complete(base);
    expect(live.content.map((c) => c.type)).toEqual(["text", "thinking", "tool_use"]);
    expect(live.stop_reason).toBe("tool_use");
    expect(inner.calls).toHaveLength(1);
    expect(recorder.calls[0]?.source).toBe("record");
    expect(recorder.calls[0]?.reply?.toolCalls?.[0]?.id).toBe("toolu_live_1");

    const hash = requestHash(base);
    expect(store.has(hash)).toBe(true);
    const rec = store.load(hash);
    expect(rec?.provider).toBe("fake");
    expect(rec?.recordedAt).toBe("2026-03-01T12:00:00.000Z");
    expect(rec?.reply).toEqual({
      text: "Writing the fix now.",
      thinking: "41 should be 42",
      toolCalls: [
        { id: "toolu_live_1", name: "write_file", input: { path: "src/answer.ts", text: "42" } },
      ],
      stopReason: "tool_use",
      usage: {
        input_tokens: 321,
        output_tokens: 45,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
      ttftMs: 0,
      totalMs: 0,
    });

    const replay = new FakeProvider({ mode: "replay", store, clock, latency: "none" });
    const again = await replay.complete({
      ...base,
      max_tokens: 9,
      signal: new AbortController().signal,
    });
    expect(again.content).toEqual(live.content);
    expect(again.usage).toEqual(live.usage);
    expect(again.stop_reason).toBe(live.stop_reason);
    expect(again.model).toBe(live.model);
    expect(replay.calls[0]?.source).toBe("replay");
    // a different request is still missing
    await expect(replay.complete({ ...base, model: "fake-opus" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("record mode keeps the inner provider's latency in the recording and never records failures", async () => {
    const clock = new SimulatedClock(0);
    const store = new RecordingStore({ suite: "latency", root: dir });
    const inner = new FakeProvider({
      clock,
      replies: [
        textReply("slow but fine", { ttftMs: 200, totalMs: 200 }),
        { reply: { error: { code: "rate_limit", message: "later" }, ttftMs: 0 } },
      ],
    });
    const recorder = new FakeProvider({ mode: "record", inner, store, clock });
    const pending = recorder.complete(base);
    await clock.advance(200);
    const res = await pending;
    expect(res.time_to_first_token_ms).toBe(200);
    expect(store.load(requestHash(base))?.reply.ttftMs).toBe(200);

    const other = { ...base, model: "fake-haiku" };
    await expect(recorder.complete(other)).rejects.toMatchObject({ code: "provider_rate_limit" });
    expect(store.has(requestHash(other))).toBe(false);
    expect(store.list()).toEqual([requestHash(base)]);
  });

  it("replay streams the recorded reply with simulated latency like a scripted one", async () => {
    const clock = new SimulatedClock(0);
    const store = new RecordingStore({ suite: "stream", root: dir });
    store.save({
      version: 1,
      hash: requestHash(base),
      suite: "stream",
      recordedAt: clock.nowIso(),
      provider: "anthropic",
      request: requestFingerprint(base),
      reply: toolReply("write_file", { path: "a" }, "ok then").reply,
    });
    const replay = new FakeProvider({ mode: "replay", store, clock });
    const pending = replay.complete(base);
    await clock.advance(300);
    await clock.advance(1000);
    const res = await pending;
    expect(res.time_to_first_token_ms).toBe(300);
    expect(res.content.map((c) => c.type)).toEqual(["text", "tool_use"]);
  });
});
