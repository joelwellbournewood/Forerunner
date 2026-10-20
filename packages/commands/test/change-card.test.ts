import { describe, expect, it } from "vitest";
import {
  buildCard,
  formatChfShort,
  maxRisk,
  mergeCards,
  NO_UNDO_HINT,
  renderChangeCard,
  UNDO_HINT,
} from "../src/index.ts";

describe("change card", () => {
  it("formats CHF without a trailing .00 and keeps real cents", () => {
    expect(formatChfShort(5_000_000)).toBe("CHF 5");
    expect(formatChfShort(12_500_000)).toBe("CHF 12.50");
    expect(formatChfShort(0)).toBe("CHF 0");
    expect(formatChfShort(1_234_567)).toBe("CHF 1.23");
  });

  it("derives the duration and the undo hint", () => {
    const temp = buildCard({
      command: "budget.set",
      what: "tonight's session budget for PharmaWatch",
      oldValue: "CHF 5",
      newValue: "CHF 20",
      scope: "session",
      risk: "medium",
      sentence: "x",
      reversible: true,
      expiresAt: "2026-10-21T04:00:00.000Z",
      untilText: "06:00",
    });
    expect(temp.duration).toBe("until 06:00");
    expect(temp.scopeLabel).toBe("this session");
    expect(temp.undoHint).toBe(UNDO_HINT);
    const perm = buildCard({
      command: "device.revoke",
      what: "the device Pixel 8",
      oldValue: "paired",
      newValue: "revoked",
      scope: "global",
      risk: "high",
      sentence: "x",
      reversible: false,
    });
    expect(perm.duration).toBe("permanent");
    expect(perm.undoHint).toBe(NO_UNDO_HINT);
    expect(perm.scopeLabel).toBe("everything");
    const rev = buildCard({
      command: "project.switch",
      what: "the active project",
      oldValue: "A",
      newValue: "B",
      scope: "global",
      risk: "low",
      sentence: "x",
      reversible: true,
    });
    expect(rev.duration).toBe("until reverted");
  });

  it("merges several cards into one plan card with the highest risk and widest scope", () => {
    const a = buildCard({
      command: "project.switch",
      what: "the active project",
      oldValue: "PharmaWatch",
      newValue: "Game",
      scope: "global",
      risk: "low",
      sentence: "Switched the active project to Game. Undo.",
      reversible: true,
      projectId: "g",
      projectName: "Game",
    });
    const b = buildCard({
      command: "budget.set",
      what: "tonight's session budget for Game",
      oldValue: "CHF 5",
      newValue: "CHF 15",
      scope: "session",
      risk: "medium",
      sentence: "Raised tonight's session budget for Game from CHF 5 to CHF 15, until 06:00. Undo.",
      reversible: true,
      projectId: "g",
      projectName: "Game",
      expiresAt: "2026-10-21T04:00:00.000Z",
      untilText: "06:00",
      costChfMicro: 10_000_000,
    });
    const merged = mergeCards([a, b]);
    expect(merged.command).toBe("compose");
    expect(merged.impact.risk).toBe("medium");
    expect(merged.scope).toBe("global");
    expect(merged.parts?.length).toBe(2);
    expect(merged.expiresAt).toBe("2026-10-21T04:00:00.000Z");
    expect(merged.duration).toBe("until 06:00");
    expect(merged.sentence).toBe(`${a.sentence} ${b.sentence}`);
    expect(merged.projectId).toBe("g");
    expect(merged.impact.costChfMicro).toBe(10_000_000);
    expect(mergeCards([a])).toBe(a);
    expect(maxRisk(["low", "high", "medium"])).toBe("high");
  });

  it("renders plain text for the UI and one paragraph for voice, naming the active project", () => {
    const card = buildCard({
      command: "budget.set",
      what: "tonight's session budget for PharmaWatch",
      oldValue: "CHF 5",
      newValue: "CHF 20",
      scope: "session",
      risk: "medium",
      sentence: "x",
      reversible: true,
      projectId: "p",
      projectName: "PharmaWatch",
      usesActiveProject: true,
      expiresAt: "2026-10-21T04:00:00.000Z",
      untilText: "06:00",
      costChfMicro: 15_000_000,
    });
    const text = renderChangeCard(card);
    expect(text.split("\n")).toEqual([
      "Change: tonight's session budget for PharmaWatch.",
      "From CHF 5 to CHF 20.",
      "Scope: this session (PharmaWatch, the active project).",
      "How long: until 06:00.",
      "Risk: medium. Spend impact: +CHF 15.",
      `Undo: ${UNDO_HINT}`,
    ]);
    expect(renderChangeCard(card, { voice: true })).not.toContain("\n");
    const plan = renderChangeCard(
      mergeCards([card, { ...card, what: "the autonomy of PharmaWatch" }]),
    );
    expect(plan).toMatch(/^Plan of 2 changes:/);
  });
});
