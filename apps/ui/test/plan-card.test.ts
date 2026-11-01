import { readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { decisionLine, planTotalWords } from "../src/lib/plan-card.ts";

/**
 * The plan card's words on the real model's decision records (live check of 2026-11-01, the
 * runtime's fixtures): the card shows the decision in one or two sentences, never the status
 * line, the answer placeholder or markdown.
 */
const LIVE = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "runtime",
      "test",
      "fixtures",
      "intake-live1.json",
    ),
    "utf8",
  ),
) as { line: number; reply_text: string }[];

describe("the plan card's words", () => {
  it("every live decision record gives a decision of one or two sentences, without its status or markdown", () => {
    const lines = LIVE.map((r) => {
      const docs = (JSON.parse(r.reply_text) as { docs: Record<string, string> }).docs;
      const record = Object.entries(docs).find(([p]) => /^docs\/decisions\/0001-/.test(p))?.[1];
      return { line: r.line, decided: record ? decisionLine(record) : null };
    });
    for (const { line, decided } of lines) {
      expect(decided, `line ${line}`).not.toBeNull();
      expect(decided?.length, `line ${line}`).toBeLessThanOrEqual(240);
      expect(decided, `line ${line}`).not.toMatch(/\*\*|`|_pending_|^Status|^#/);
    }
    // Line 22's record lists its decisions; the first one is the stack.
    expect(lines.find((l) => l.line === 22)?.decided).toBe(
      "Stack: plain HTML, CSS and JavaScript, no framework, no build step. The requirement is tiny, and a framework would add maintenance with no benefit.",
    );
  });

  it("a record's own Decision line wins", () => {
    expect(
      decisionLine(
        "# 0001: Static page\n\nStatus: proposed.\n\nDecision: **plain HTML**, CSS and JavaScript; no build step. It opens from the folder. Nothing else.\n\n## Why\n\n- Small",
      ),
    ).toBe("plain HTML, CSS and JavaScript; no build step. It opens from the folder.");
  });

  it("the total says what it covers", () => {
    const words = (agentTasks: number, estimated: number, personTasks = false) =>
      planTotalWords({ agentTasks, estimated, total: "CHF 1.04", personTasks });
    expect(words(3, 3)).toBe("About CHF 1.04 for the 3 tasks.");
    expect(words(1, 1)).toBe("About CHF 1.04 for the task.");
    expect(words(3, 2, true)).toBe(
      "About CHF 1.04 for 2 of the 3 tasks the agent does; the other one has no estimate yet.",
    );
    expect(words(4, 2)).toBe(
      "About CHF 1.04 for 2 of the 4 tasks; the other 2 have no estimate yet.",
    );
    expect(words(2, 0)).toBe("The cost of the 2 tasks is not known yet.");
    expect(words(0, 0, true)).toBe("");
  });
});
