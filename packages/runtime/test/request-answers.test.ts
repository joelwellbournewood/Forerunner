import { SIGNOFF_KEY, SIGNOFF_OPTIONS } from "@forerunner/critic";
import { describe, expect, it } from "vitest";
import { EXTENSION_APPROVAL_OPTIONS } from "../src/extensions/approvals.ts";
import { MODEL_WATCH_REQUEST_PREFIX } from "../src/models/watch.ts";
import { SPECIALIST_KEY_PREFIX } from "../src/registry/approval.ts";
import {
  BLOCKED_FINDINGS_KEY,
  BLOCKED_FINDINGS_OPTIONS,
  signoffAnswer,
} from "../src/session/findings.ts";
import { INTAKE_KEY_PREFIX } from "../src/session/intake.ts";
import {
  PLAN_APPROVAL_OPTIONS,
  PLAN_KEY_PREFIX,
  planAnswer,
} from "../src/session/plan-approval.ts";
import {
  ANSWER_CARD_KEYS,
  acceptsAnswer,
  reviewVerdictOption,
} from "../src/wiring/request-answers.ts";
import { isYes } from "../src/wiring/state-ports.ts";

const card = (options: readonly unknown[]) => ({ options: [...options] as never[] });

describe("acceptsAnswer: what a card can act on (U-034)", () => {
  const target = (options: readonly unknown[], key?: string, kind = "approval") => ({
    kind,
    options,
    change_card: key ? { key } : null,
  });

  it("each card key equals the one its producer files the card with", () => {
    expect(ANSWER_CARD_KEYS.signoff).toBe(SIGNOFF_KEY);
    expect(ANSWER_CARD_KEYS.blockedFindings).toBe(BLOCKED_FINDINGS_KEY);
    expect(ANSWER_CARD_KEYS.planPrefix).toBe(PLAN_KEY_PREFIX);
    expect(ANSWER_CARD_KEYS.intakePrefix).toBe(INTAKE_KEY_PREFIX);
    expect(ANSWER_CARD_KEYS.specialistPrefix).toBe(SPECIALIST_KEY_PREFIX);
    expect(ANSWER_CARD_KEYS.modelWatchPrefix).toBe(MODEL_WATCH_REQUEST_PREFIX);
  });

  it("a card with its own reader takes that reader's words, in any case, and nothing else", () => {
    const signoff = target(SIGNOFF_OPTIONS, SIGNOFF_KEY);
    for (const ok of ["accept", " Approved ", "sign-off", "REDO", "cancelled"])
      expect(acceptsAnswer(signoff, ok)).toEqual({ ok: true });
    expect(acceptsAnswer(signoff, { choice: "revise" })).toEqual({ ok: true });
    expect(acceptsAnswer(signoff, "looks fine")).toEqual({
      ok: false,
      options: ["accept", "revise", "cancel"],
      message:
        '"looks fine" is not an answer this request can act on. Choose one of: accept, revise, cancel.',
    });
    expect(acceptsAnswer(signoff, { decision: "approve" }).ok).toBe(false);
  });

  it("another approval takes its options and, with two, the yes / no words every reader shares", () => {
    const yesNo = target(["yes", "no"]);
    for (const ok of ["Yes", " no ", "approve", "Denied", "reject"])
      expect(acceptsAnswer(yesNo, ok).ok).toBe(true);
    // Read as a yes by some readers and a no by others (the mirror reads "ok" as a no).
    expect(acceptsAnswer(yesNo, "ok").ok).toBe(false);
    expect(acceptsAnswer(yesNo, "maybe").ok).toBe(false);
    expect(acceptsAnswer(yesNo, true).ok).toBe(false);
    const ext = target(EXTENSION_APPROVAL_OPTIONS);
    expect(acceptsAnswer(ext, "approve").ok).toBe(true);
    expect(acceptsAnswer(ext, "later")).toMatchObject({ ok: false, options: ["Approve", "Deny"] });
    const three = target(["Approve", "Reject", "Ask me later"]);
    expect(acceptsAnswer(three, "ask_me-later").ok).toBe(true);
    expect(acceptsAnswer(three, "yes").ok).toBe(false);
    const old = target([{ choice: "approve", stage: "install" }, { choice: "deny" }]);
    expect(acceptsAnswer(old, "Approve").ok).toBe(true);
    expect(acceptsAnswer(old, '{"choice":"approve","stage":"install"}').ok).toBe(false);
  });

  it("free text stays: a decision, info, a credential, or a card without options", () => {
    expect(
      acceptsAnswer(target(["eu-central", "us-east"], undefined, "decision"), "Zurich").ok,
    ).toBe(true);
    expect(acceptsAnswer(target([], undefined, "info"), "thanks").ok).toBe(true);
    expect(acceptsAnswer(target(["unlock", "deny"], undefined, "credential"), { iv: "x" }).ok).toBe(
      true,
    );
    expect(acceptsAnswer(target([]), "anything").ok).toBe(true);
  });
});

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
