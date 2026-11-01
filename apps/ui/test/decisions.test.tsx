import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DecisionView } from "../src/api/client.ts";
import { DECISIONS_SHOWN, DecisionsSection } from "../src/pages/project/DecisionsSection.tsx";
import { createHarness, renderApp, renderWith } from "./helpers.tsx";

/**
 * Overview → Decisions (design §3.4, §5 "Decision"): before, a decision read as the card's
 * instructions, the form's JSON, "(not: Cancel the task)" and "by 01a196fe-…"; an approved plan
 * and its decision record were missing.
 */
describe("Overview: decisions in plain words", () => {
  it("reads 'Q? A. (Alice, 18 Oct)', the plan the person approved and the record, which opens Docs", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/summary");
    const section = await screen.findByTestId("decisions");
    const rows = await within(section).findAllByTestId("decision");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["answer", "plan"]);
    expect(rows[0]).toHaveTextContent(
      /^Which search backend should the docs site use\? Static index built at deploy time\. \(Alice, 1[78] Oct\)$/,
    );
    expect(rows[1]).toHaveTextContent(/^The plan for Atlas: Approved\. \(Alice, 1[67] Oct\)$/);
    expect(section).not.toHaveTextContent(/\{|\}|not:|human_alice|by /);
    const record = within(section).getByTestId("decision-record");
    expect(within(section).getByTestId("decision-records")).toHaveTextContent(
      "Decision record: Static search index",
    );
    await user.click(record);
    expect(await screen.findByTestId("tab-panel-docs")).toBeInTheDocument();
  });

  it("shows five, newest first, and the rest behind 'All N decisions'", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const many: DecisionView[] = Array.from({ length: DECISIONS_SHOWN + 2 }, (_, i) => ({
      id: `d${i}`,
      projectId: "proj_atlas",
      kind: "answer",
      question: `Question ${i}?`,
      options: [],
      chosen: `Answer ${i}`,
      decidedBy: "h",
      decidedByName: "Robin",
      rationale: "",
      supersedes: null,
      path: null,
      createdAt: `2026-11-0${i + 1}T10:00:00.000Z`,
    }));
    harness.client.decisions = async () => many;
    renderWith(<DecisionsSection projectId="proj_atlas" />, harness);
    const rows = await screen.findAllByTestId("decision");
    expect(rows).toHaveLength(DECISIONS_SHOWN);
    expect(rows[0]).toHaveTextContent("Question 6? Answer 6. (Robin, 7 Nov)");
    await user.click(screen.getByTestId("decisions-all"));
    expect(screen.getAllByTestId("decision")).toHaveLength(DECISIONS_SHOWN + 2);
  });
});
