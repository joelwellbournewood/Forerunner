import { readFileSync } from "node:fs";
import { join } from "@forerunner/platform/paths";
import { describe, expect, it } from "vitest";

/**
 * The update log's rules (docs/status/UPDATE-LOG.md, "How this log works";
 * docs/maintainers/validation.md) as checks. From U-018 on, an entry that is fixed or released
 * says how a person sees the fix ("Check in the app") and names its test, so the owner can try
 * the build before a release and a reviewer can ask whether a test does the same steps.
 * Earlier entries predate the rule.
 */
const LOG = readFileSync(join(process.cwd(), "docs", "status", "UPDATE-LOG.md"), "utf8");
const FIRST_WITH_RULE = 18;

interface Entry {
  id: number;
  body: string;
  status: string;
}

function entries(text: string): Entry[] {
  const parts = text.split(/^### /m).slice(1);
  // A heading names one entry ("U-021 ...") or a range that shares one section ("U-027 to U-036").
  return parts.flatMap((part) => {
    const head = /^U-(\d{3})(?: to U-(\d{3}))?\b/.exec(part);
    if (!head) return [];
    const status = /^- \*\*Status:\*\*\s*(.+)$/m.exec(part)?.[1]?.trim() ?? "";
    const first = Number(head[1]);
    const last = head[2] ? Number(head[2]) : first;
    const out: Entry[] = [];
    for (let id = first; id <= last; id++) out.push({ id, body: part, status });
    return out;
  });
}

function tableIds(text: string): number[] {
  return [...text.matchAll(/^\| U-(\d{3}) \|/gm)].map((m) => Number(m[1]));
}

describe("update log rules", () => {
  const all = entries(LOG);

  it("has a section for every entry in its tables from U-018 on", () => {
    const sections = new Set(all.map((e) => e.id));
    const missing = tableIds(LOG).filter((id) => id >= FIRST_WITH_RULE && !sections.has(id));
    expect(missing).toEqual([]);
  });

  it("gives every section a status", () => {
    const without = all.filter((e) => e.id >= FIRST_WITH_RULE && e.status === "");
    expect(without.map((e) => `U-${e.id}`)).toEqual([]);
  });

  it("says how a person checks a fixed or released entry, and names its test", () => {
    const done = all.filter((e) => e.id >= FIRST_WITH_RULE && /^(fixed|released)\b/.test(e.status));
    for (const e of done) {
      expect(e.body, `U-0${e.id}: no "Check in the app" steps`).toContain("**Check in the app:**");
      expect(e.body, `U-0${e.id}: no test named`).toMatch(/\btests?:/i);
    }
  });

  it("accepts the rule's own entries (a parse check)", () => {
    expect(all.some((e) => e.id === 18)).toBe(true);
    expect(entries("### U-099 x\n- **Status:** fixed.\n")[0]).toMatchObject({
      id: 99,
      status: "fixed.",
    });
    expect(entries("### U-040 to U-042: x\n- **Status:** open.\n").map((e) => e.id)).toEqual([
      40, 41, 42,
    ]);
  });
});
