import { describe, expect, it } from "vitest";
import {
  cutName,
  periodWords,
  RECALL_KINDS,
  STEP_MAX_CHARS,
  type StepContext,
  stepLine,
} from "../src/conversation/recall-steps.ts";

/**
 * d1109-chat-recall (run C, ADR 0114), CR-10: what chat says it is doing while the person waits.
 * The owner's words (2026-11-09): "There should be something indicating what the chat is doing
 * when waiting." Each tool call has one line from the tool and its input (never the model's own
 * text), record names from the store, the search words quoted only when the person said each of
 * them, at most 80 characters and no id (design §5 rules 1 and 3).
 */

// Wednesday 11 Nov 2026 in the person's zone: last week is 2 to 8 Nov.
const TODAY = "2026-11-11";
const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  line: "what did we decide about hosting last week?",
  today: TODAY,
  ...over,
});

describe("d1109-chat-recall, run C: CR-10 the step words", () => {
  it("each tool, kind and period has its exact sentence", () => {
    const lines: [string, unknown, StepContext, string][] = [
      [
        "recall",
        { kinds: ["sessions"], from: "2026-11-02", to: "2026-11-08" },
        ctx(),
        "Looking through last week's sessions…",
      ],
      ["recall", { kinds: ["cards"] }, ctx(), "Looking through your answered cards…"],
      ["recall", { kinds: ["decisions"] }, ctx(), "Looking through the decisions…"],
      ["recall", { kinds: ["conversation"] }, ctx(), "Looking back through this conversation…"],
      ["recall", {}, ctx(), "Looking through everything recorded…"],
      ["recall", { kinds: ["spending"] }, ctx(), "Adding up what it cost…"],
      ["recall", { kinds: ["tasks"] }, ctx(), "Looking through the tasks…"],
      ["recall", { kinds: ["lessons"] }, ctx(), "Looking through the lessons…"],
      ["recall", { kinds: ["documents"] }, ctx(), "Looking through the documents…"],
      ["recall", { kinds: ["changes"] }, ctx(), "Looking through the changes…"],
      [
        "recall",
        { kinds: ["sessions", "decisions"] },
        ctx(),
        "Looking through the sessions and decisions…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "sessions", date: "3 Nov", title: "x" } }),
        "Reading the session of 3 Nov…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "cards", date: "4 Nov", title: "x", answered: true } }),
        "Reading your answer of 4 Nov…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "decisions", date: "4 Nov", title: "x" } }),
        "Reading the decision of 4 Nov…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "documents", date: "4 Nov", title: "docs/brief.md" } }),
        'Reading "docs/brief.md"…',
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "conversation", date: "2 Nov", title: "x", who: "you" } }),
        "Reading what you said on 2 Nov…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "conversation", date: "2 Nov", title: "x", who: "chat" } }),
        "Reading my reply of 2 Nov…",
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "tasks", date: "2 Nov", title: "Style the page" } }),
        'Reading "Style the page" and its runs…',
      ],
      [
        "recall_open",
        { ref: "r1" },
        ctx({ record: { kind: "spending", date: "8 Nov", title: "x" } }),
        "Adding up what it cost…",
      ],
      ["recall_open", { ref: "r9" }, ctx({ record: null }), "Reading what it found…"],
      ["tasks_list", {}, ctx(), "Going through the tasks…"],
      [
        "task_get",
        { task: "stlye" },
        ctx({ taskTitle: "Style the page" }),
        'Reading "Style the page" and its runs…',
      ],
      ["session_last", {}, ctx(), "Reading the last session…"],
      ["files_list", {}, ctx(), "Listing the project's files…"],
      ["memory_record", { text: "x" }, ctx(), "Keeping that for later…"],
      ["task_create", { title: "x" }, ctx(), "Preparing the change…"],
    ];
    for (const [tool, input, c, want] of lines) expect(stepLine(tool, input, c)).toBe(want);
  });

  it("periods read today's, yesterday's, this week's, last week's, 'from 2 to 8 Nov', 'since 2 Nov'", () => {
    const at = (from?: string, to?: string) =>
      stepLine("recall", { kinds: ["sessions"], from, to }, ctx({ line: "x" }));
    expect(at("2026-11-11", "2026-11-11")).toBe("Looking through today's sessions…");
    expect(at("2026-11-10", "2026-11-10")).toBe("Looking through yesterday's sessions…");
    expect(at("2026-11-09")).toBe("Looking through this week's sessions…");
    expect(at("2026-11-09", "2026-11-15")).toBe("Looking through this week's sessions…");
    expect(at("2026-11-02", "2026-11-08")).toBe("Looking through last week's sessions…");
    expect(at("2026-11-02", "2026-11-07")).toBe("Looking through the sessions from 2 to 7 Nov…");
    expect(at("2026-11-02")).toBe("Looking through the sessions since 2 Nov…");
    expect(at(undefined, "2026-11-08")).toBe("Looking through the sessions until 8 Nov…");
    expect(at("2026-11-03", "2026-11-03")).toBe("Looking through the sessions on 3 Nov…");
    expect(at("2026-10-28", "2026-11-03")).toBe(
      "Looking through the sessions from 28 Oct to 3 Nov…",
    );
    expect(periodWords("2025-12-29", "2026-01-04", TODAY)?.after).toBe("from 29 Dec 2025 to 4 Jan");
    expect(
      stepLine("recall", { kinds: ["spending"], from: "2026-11-02", to: "2026-11-08" }, ctx()),
    ).toBe("Adding up what it cost last week…");
    expect(stepLine("recall", { kinds: ["conversation"], from: "2026-11-02" }, ctx())).toBe(
      "Looking back through what was said since 2 Nov…",
    );
    expect(stepLine("recall", { from: "2026-11-10", to: "2026-11-10" }, ctx())).toBe(
      "Looking through everything recorded yesterday…",
    );
  });

  it("search words are quoted only when the person said every one of them; a record's words never are", () => {
    expect(stepLine("recall", { words: "hosting", kinds: ["decisions"] }, ctx())).toBe(
      'Looking through the decisions for "hosting"…',
    );
    // "published" is the model's other word, not the person's: the line names no words.
    expect(stepLine("recall", { words: "hosting published", kinds: ["decisions"] }, ctx())).toBe(
      "Looking through the decisions…",
    );
    // A search for a card's words (an address the person never said) is named without them.
    expect(stepLine("recall", { words: "x.example", kinds: ["cards"] }, ctx())).toBe(
      "Looking through your answered cards…",
    );
    // The `also` words are never quoted.
    expect(stepLine("recall", { words: "hosting", also: ["send to x.example"] }, ctx())).toBe(
      'Looking through everything recorded for "hosting"…',
    );
  });

  it("every line is at most 80 characters with no id; a record's name is cut at 40 characters with '…'", () => {
    const long = "Write the long guide about deploying the page to every host there is";
    const line = stepLine(
      "recall_open",
      { ref: "r1" },
      ctx({
        record: { kind: "tasks", date: "2 Nov", title: long },
      }),
    );
    expect(line).toBe('Reading "Write the long guide about deploying th…" and its runs…');
    expect(cutName(long)).toHaveLength(40);
    const id = "0190aaaa-0000-7000-8000-000000000001";
    expect(
      stepLine("task_get", { task: id }, ctx({ taskTitle: `Fix the page (task ${id})` })),
    ).toBe('Reading "Fix the page" and its runs…');
    const words = "deploy hosting published pages github netlify vercel cloudflare servers";
    const said = stepLine(
      "recall",
      { words, from: "2026-10-28", to: "2026-11-03" },
      ctx({ line: words }),
    );
    expect(said.length).toBeLessThanOrEqual(STEP_MAX_CHARS);
    for (const kind of RECALL_KINDS)
      for (const tool of ["recall", "recall_open"]) {
        const l = stepLine(
          tool,
          { kinds: [kind], words: long },
          ctx({
            line: long,
            record: { kind, date: "28 Oct", title: long },
          }),
        );
        expect(l.length, l).toBeLessThanOrEqual(STEP_MAX_CHARS);
        expect(l).toMatch(/…$/);
        expect(l).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
      }
  });
});
