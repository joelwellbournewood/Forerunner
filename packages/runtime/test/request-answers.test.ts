import { SIGNOFF_OPTIONS } from "@forerunner/critic";
import { describe, expect, it } from "vitest";
import { EXTENSION_APPROVAL_OPTIONS } from "../src/extensions/approvals.ts";
import { BLOCKED_FINDINGS_OPTIONS, signoffAnswer } from "../src/session/findings.ts";
import { PLAN_APPROVAL_OPTIONS, planAnswer } from "../src/session/plan-approval.ts";
import { reviewVerdictOption } from "../src/wiring/request-answers.ts";
import { isYes } from "../src/wiring/state-ports.ts";

const card = (options: readonly unknown[]) => ({ options: [...options] as never[] });

describe("reviewVerdictOption: the phone's Approve / Reject as the card's own button (U-027)", () => {
  it("picks the option that accepts the work and the one that sends it back", () => {
    expect(reviewVerdictOption(card(SIGNOFF_OPTIONS), "approve")).toBe("accept");
    expect(reviewVerdictOption(card(SIGNOFF_OPTIONS), "reject")).toBe("revise");
    expect(reviewVerdictOption(card(BLOCKED_FINDINGS_OPTIONS), "approve")).toBe("accept");
    expect(reviewVerdictOption(card(BLOCKED_FINDINGS_OPTIONS), "reject")).toBe("rework");
    expect(reviewVerdictOption(card(["yes", "no"]), "approve")).toBe("yes");
    expect(reviewVerdictOption(card(["yes", "no"]), "reject")).toBe("no");
    expect(reviewVerdictOption(card(EXTENSION_APPROVAL_OPTIONS), "approve")).toBe("Approve");
    expect(reviewVerdictOption(card(EXTENSION_APPROVAL_OPTIONS), "reject")).toBe("Deny");
    expect(reviewVerdictOption(card(PLAN_APPROVAL_OPTIONS), "reject")).toBe("reject");
  });

  it("the chosen option reads as the verdict in the card's own reader", () => {
    expect(signoffAnswer(reviewVerdictOption(card(SIGNOFF_OPTIONS), "approve"))).toBe("accept");
    expect(signoffAnswer(reviewVerdictOption(card(SIGNOFF_OPTIONS), "reject"))).toBe("revise");
    expect(planAnswer(reviewVerdictOption(card(PLAN_APPROVAL_OPTIONS), "approve"))).toBe("approve");
    expect(isYes(reviewVerdictOption(card(["yes", "no"]), "approve"))).toBe(true);
    expect(isYes(reviewVerdictOption(card(["yes", "no"]), "reject"))).toBe(false);
  });

  it("an old object option answers with the label the Inbox shows", () => {
    const old = [{ choice: "approve", stage: "install" }, { choice: "deny" }];
    expect(reviewVerdictOption(card(old), "approve")).toBe("Approve");
    expect(reviewVerdictOption(card(old), "reject")).toBe("Deny");
  });

  it("a card without options takes the verdict's word; a card with no option for it is left open", () => {
    expect(reviewVerdictOption(card([]), "approve")).toBe("approve");
    expect(isYes(reviewVerdictOption(card([]), "reject"))).toBe(false);
    // Never "cancel": a rejected review sends the work back, it does not end the task.
    expect(reviewVerdictOption(card(["acknowledge", "cancel"]), "reject")).toBeNull();
    expect(reviewVerdictOption(card(["I merged it", "Leave it open"]), "approve")).toBeNull();
  });
});
