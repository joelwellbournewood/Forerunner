import { describe, expect, it } from "vitest";
import { fitToBudget } from "../src/context/budget.ts";
import {
  assertStablePrefix,
  compactTools,
  findVolatile,
  layoutSystem,
  volatilePreamble,
} from "../src/context/cache-layout.ts";
import { CrossTurnDedup, dedupWithinBlock } from "../src/context/dedup.ts";
import { elideDenseLines } from "../src/context/dense.ts";
import { collapseLogs } from "../src/context/logs.ts";
import {
  ContextPipeline,
  contextSettingsFrom,
  DEFAULT_CONTEXT_SETTINGS,
} from "../src/context/pipeline.ts";
import { truncateWithErrors } from "../src/context/truncate.ts";

const count = (t: string) => Math.ceil(t.length / 4);
const ctx = { countTokens: count };

describe("context: logs", () => {
  it("collapses CRLF, ANSI, trailing whitespace, progress bars and repeated lines, losslessly in meaning", () => {
    const input =
      "a  \r\nb\u001b[32mgreen\u001b[0m\n10%\r50%\r100% done\nsame\nsame\nsame\nsame\n\n\n\n\nend";
    const r = collapseLogs(input, ctx);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("a\nbgreen\n100% done\nsame\n... (repeated 4 times)\n\nend");
    expect(collapseLogs(r.text, ctx).text).toBe(r.text); // idempotent
  });
  it("leaves short clean text alone", () => {
    expect(collapseLogs("hello\nworld", ctx).changed).toBe(false);
  });
});

describe("context: dense lines", () => {
  it("elides the middle of large minified or base64 lines only", () => {
    const dense = "A".repeat(2500);
    const json = `{"${"k".repeat(400)}":1}`;
    const r = elideDenseLines(`${dense}\nnormal line with spaces in it\n${json}`, ctx);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("[2260 chars elided]");
    expect(r.text).toContain("normal line with spaces in it");
    expect(r.text).toContain(json);
    expect(elideDenseLines("B".repeat(1000), ctx).changed).toBe(false); // under the total threshold
  });
});

describe("context: dedup", () => {
  it("folds a repeated window inside a block and keeps the first occurrence", () => {
    const block = [
      "start",
      "alpha one",
      "beta two",
      "gamma three",
      "delta four",
      "middle",
      "alpha one",
      "beta two",
      "gamma three",
      "delta four",
      "end",
    ].join("\n");
    const r = dedupWithinBlock(block, ctx);
    expect(r.changed).toBe(true);
    expect(r.text.split("\n")[1]).toBe("alpha one");
    expect(r.text).toContain("(repeats 4 lines from 5 lines back)");
    expect(r.text.endsWith("end")).toBe(true);
  });
  it("references earlier tool results across turns and never rewrites the earliest", () => {
    const d = new CrossTurnDedup();
    const span = Array.from(
      { length: 10 },
      (_, i) => `line number ${i} with enough characters to count`,
    ).join("\n");
    const first = d.apply(`${span}\nunique first`, 0);
    expect(first.changed).toBe(false);
    const second = d.apply(`prefix\n${span}\nunique second`, 1);
    expect(second.changed).toBe(true);
    expect(second.text).toContain("[same as tool result #1 lines 1-10]");
    expect(second.text).toContain("unique second");
  });
});

describe("context: truncate", () => {
  it("keeps a FATAL in the middle and the test summary when truncating", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i} ${"x".repeat(80)}`);
    lines[66] = "FATAL: database connection refused";
    lines[99] = "Tests  3 failed | 40 passed (43)";
    const text = lines.join("\n");
    const r = truncateWithErrors(text, { ...ctx, maxTokens: 400 });
    expect(r.changed).toBe(true);
    expect(count(r.text)).toBeLessThan(count(text));
    expect(r.text).toContain("67: FATAL: database connection refused");
    expect(r.text).toContain("Tests  3 failed");
    // No original store: the marker names no hash, so it can never point at nothing.
    expect(r.text).toMatch(/tokens omitted\]/);
    expect(r.text).not.toContain("original ");
    const stored = truncateWithErrors(text, {
      ...ctx,
      maxTokens: 400,
      originalHash: "abcdef012345",
    });
    expect(stored.text).toMatch(/omitted; original abcdef012345\]/);
  });
  it("does nothing under the cap", () => {
    expect(truncateWithErrors("short", { ...ctx, maxTokens: 10 }).changed).toBe(false);
  });
});

describe("context: cache layout", () => {
  it("compacts tool schemas and memoises", () => {
    const tools = [
      {
        name: "t",
        description: "  a   b  ",
        input_schema: {
          $schema: "x",
          title: "T",
          type: "object",
          properties: { a: { type: "string", description: "multi\n  line", examples: ["x"] } },
        },
      },
    ];
    const c = compactTools(tools);
    expect(c[0]?.description).toBe("a b");
    expect(JSON.stringify(c[0]?.input_schema)).not.toContain("$schema");
    expect(JSON.stringify(c[0]?.input_schema)).not.toContain("examples");
    const schema = c[0]?.input_schema as { properties: { a: { description: string } } } | undefined;
    expect(schema?.properties.a.description).toBe("multi line");
    expect(compactTools(tools)).toBe(c);
  });
  it("rejects volatile content in the system prompt and lays out stable prefixes", () => {
    expect(findVolatile("today is 2026-03-02T10:00:00Z")).toEqual(["iso-timestamp"]);
    expect(() => assertStablePrefix("session 0192f1e0-aaaa-4bbb-8ccc-123456789abc")).toThrow(
      /volatile/,
    );
    expect(assertStablePrefix("stable prompt", "warn")).toEqual([]);
    const sys = layoutSystem({
      registryPrompt: "You are the coder.",
      projectBrief: "Project X",
      pinnedLessons: ["use pnpm"],
    });
    expect(sys).toBe("You are the coder.\n\nProject X\n\n# Pinned lessons\n- use pnpm");
    expect(
      volatilePreamble({ now: "2026-03-02T10:00:00Z", budgetLeftChf: 4.2, skip: undefined }),
    ).toBe("# Now\n- now: 2026-03-02T10:00:00Z\n- budgetLeftChf: 4.2");
  });
});

describe("context: budget fit", () => {
  it("keeps whole items by rank within the budget", () => {
    const r = fitToBudget(["aaaa", "bbbbbbbb", "cc", "dddddddddddd"], 4, (s) => s.length / 4);
    expect(r.kept).toEqual(["aaaa", "bbbbbbbb", "cc"]);
    expect(r.tokensUsed).toBe(3.5);
    expect(r.dropped).toBe(1);
  });
});

describe("context: pipeline", () => {
  it("measures savings, honours profiles, never grows the text and bypasses when asked", () => {
    const p = new ContextPipeline();
    const noisy = `${"same line\n".repeat(50)}${"Z".repeat(3000)}\n${Array.from({ length: 3000 }, (_, i) => `row ${i} ${"y".repeat(30)}`).join("\n")}`;
    const r = p.compressToolResult(noisy, "run_command");
    expect(r.record.tokensAfter).toBeLessThan(r.record.tokensBefore);
    expect(r.record.transforms).toEqual(expect.arrayContaining(["logs", "dense", "truncate"]));
    const same = p.compressToolResult(noisy, "x", "off");
    expect(same.text).toBe(noisy);
    expect(same.record.transforms).toEqual([]);
    const read = p.compressToolResult("short file", "read_file");
    expect(read.text).toBe("short file");
    expect(p.savings().saved).toBe(r.record.tokensBefore - r.record.tokensAfter);
    const off = new ContextPipeline({
      compression: "off",
      maxToolResultTokens: 10,
      toolProfiles: {},
    });
    expect(off.compressToolResult(noisy).text).toBe(noisy);
  });
});

describe("context: project settings and run-scoped savings", () => {
  it("reads settings.context with the defaults in code and extends the built-in tool profiles", () => {
    expect(contextSettingsFrom(undefined)).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(contextSettingsFrom({})).toEqual(DEFAULT_CONTEXT_SETTINGS);
    const s = contextSettingsFrom({
      members: ["a"],
      context: {
        compression: "headroom",
        maxToolResultTokens: 2000,
        toolProfiles: { grep: { skip: ["dedup"] }, read_file: { maxTokens: 8000 } },
      },
    });
    expect(s.compression).toBe("headroom");
    expect(s.maxToolResultTokens).toBe(2000);
    expect(s.toolProfiles.grep).toEqual({ skip: ["dedup"] });
    expect(s.toolProfiles.read_file).toEqual({ maxTokens: 8000 });
    expect(s.toolProfiles.git_diff).toEqual({ skip: ["dedup"] });
    expect(contextSettingsFrom({ context: { compression: "off" } }).compression).toBe("off");
  });

  it("falls back to the defaults on malformed input instead of failing a session", () => {
    expect(contextSettingsFrom({ context: { compression: "maximum" } })).toEqual(
      DEFAULT_CONTEXT_SETTINGS,
    );
    expect(contextSettingsFrom({ context: { maxToolResultTokens: -1 } })).toEqual(
      DEFAULT_CONTEXT_SETTINGS,
    );
    expect(contextSettingsFrom({ context: "yes" })).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect(contextSettingsFrom(42)).toEqual(DEFAULT_CONTEXT_SETTINGS);
  });

  it("measures one run inside a session with mark() and lists the transforms it applied", () => {
    const p = new ContextPipeline();
    const noisy = `${"same line\n".repeat(50)}${"Z".repeat(3000)}\n${Array.from({ length: 1200 }, (_, i) => `row ${i} ${"y".repeat(30)}`).join("\n")}`;
    const first = p.compressToolResult(noisy, "run_command");
    expect(first.record.transforms).toEqual(expect.arrayContaining(["logs", "dense", "truncate"]));
    expect(first.record.original).toBeNull();
    const mark = p.mark();
    expect(mark).toBe(1);
    const run = p.beginRun();
    run.compressToolResult("tiny", "echo");
    const second = run.compressToolResult(noisy, "run_command");
    const third = run.compressToolResult(noisy, "run_command");
    const measured = p.savings(mark);
    expect(measured.records).toBe(3);
    expect(measured.tokensBefore).toBe(second.record.tokensBefore * 2 + 1); // "tiny" is one token
    expect(measured.tokensAfter).toBe(second.record.tokensAfter + third.record.tokensAfter + 1);
    expect(measured.saved).toBe(measured.tokensBefore - measured.tokensAfter);
    // The second copy inside the run references the first; the lines it names are lines the
    // model has (the first result as sent, after truncation), so the omitted middle is still
    // there and still needs truncating. Both results share the transcript, so #2 is the second.
    expect(second.record.transforms).toEqual(["logs", "dense", "truncate"]);
    expect(third.record.transforms).toEqual(["logs", "dense", "dedup-cross", "truncate"]);
    expect(third.text).toContain("[same as tool result #2 lines ");
    const sentLines = second.text.split("\n");
    for (const m of third.text.matchAll(/\[same as tool result #2 lines (\d+)-(\d+)\]/g)) {
      expect(Number(m[2])).toBeLessThanOrEqual(sentLines.length);
    }
    // Both are capped by truncate; the reference made the third cheaper than its input.
    expect(third.record.tokensAfter).toBeLessThan(third.record.tokensBefore);
    expect(measured.transforms).toEqual(["logs", "dense", "truncate", "dedup-cross"]);
    // A pipeline-level block is a run of its own: no cross-turn reference without a transcript.
    const alone = p.compressToolResult(noisy, "run_command");
    expect(alone.record.transforms).not.toContain("dedup-cross");
    const all = p.savings();
    expect(all.records).toBe(5);
    expect(all.saved).toBe(
      measured.saved +
        first.record.tokensBefore -
        first.record.tokensAfter +
        alone.record.tokensBefore -
        alone.record.tokensAfter,
    );
    expect(p.savings(99)).toEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      saved: 0,
      transforms: [],
      records: 0,
    });
  });
});
