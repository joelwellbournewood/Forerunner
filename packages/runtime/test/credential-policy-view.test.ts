import { credentialPolicyOf, ruleOf } from "@forerunner/billing";
import { describe, expect, it } from "vitest";
import {
  costByCredentialWords,
  credentialPolicySection,
  drawerRunLine,
  EARLIER_LINE,
  grantNowLine,
  grantStartLine,
  ifRunsOutLine,
  monthWords,
  NOT_CHOSEN_LINE,
  oneCredentialSentence,
  planCardLine,
  policyChangeWords,
  presetWords,
  RUNS_OUT_LINE,
  resultSwitchLine,
  roleWords,
  SUBSCRIPTION_FIRST_FOOTNOTE,
  sessionGoesOnLine,
  sessionSwitchLine,
  startLaterExplain,
  startLaterLabel,
  startRunOutLine,
  stateWords,
  stoppedNowLine,
  useApiKeyExplain,
} from "../src/daemon/credential-policy-view.ts";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { waitRowWords } from "../src/session/credential-wait.ts";

/**
 * d1109-cred-screens (run C, C6; ADR 0120 amended 2026-11-16): every screen sentence of "which
 * Claude does the work", exact, in each variant, within design section 5's lengths (a consequence
 * line at most 100 characters, a button at most three words, no ids, no USD, no markdown).
 */
const opts = { timezone: "Europe/Zurich", nowMs: Date.parse("2026-11-16T13:00:00Z") };
const limit = { reason: "limit" as const, until: "2026-11-16T14:40:00Z" };
const share = { reason: "share" as const, until: "2026-12-01T00:00:00Z" };
const keyMonth = { reason: "key_month" as const, until: "2026-12-01T00:00:00Z" };
const refused = { reason: "refused" as const, until: null };
const both = ["subscription", "api_key"];

describe("credential-policy-view (CS-1): the presets, rows and lines", () => {
  it("the five presets: labels that show the order, one line each, at most 100 characters", () => {
    const p = presetWords();
    expect(p.map((x) => x.label)).toEqual([
      "Subscription first, then wait",
      "Subscription first, ask before API key",
      "Subscription first, then API key",
      "API key first, then subscription",
      "API key only",
    ]);
    expect(p.map((x) => x.movesMoney)).toEqual([false, false, true, true, true]);
    for (const x of p) expect(x.line.length).toBeLessThanOrEqual(100);
    expect(p[1]?.line).toBe(
      "When your subscription runs out, one card asks: go on with your API key at its cost, or wait.",
    );
  });

  it("roles under each preset", () => {
    const role = (id: Parameters<typeof ruleOf>[0], kind: string) =>
      roleWords(kind, ruleOf(id), both);
    expect(role("subscription_then_wait", "subscription")).toBe("Does the work");
    expect(role("subscription_then_wait", "api_key")).toBe(
      "Only for a task your subscription cannot do",
    );
    expect(role("subscription_then_ask", "api_key")).toBe(
      "After you say yes, when your subscription runs out",
    );
    expect(role("subscription_then_key", "api_key")).toBe(
      "Takes over when your subscription runs out",
    );
    expect(role("key_then_subscription", "subscription")).toBe(
      "Takes over when your API key runs out",
    );
    expect(role("key_only", "subscription")).toBe("Not used");
    expect(role("key_only", "api_key")).toBe("Does the work");
  });

  it("states and month, in the person's clock", () => {
    const st = (kind: string, stop: Parameters<typeof stateWords>[1]["stop"]) =>
      stateWords(kind, { saved: true, enabled: true, stop }, opts);
    expect(st("subscription", null).words).toBe("Works now");
    expect(st("subscription", limit).words).toBe("At its limit until 15:40");
    expect(st("subscription", share)).toEqual({
      words: "Share used until Tue 1 Dec",
      link: { label: "Change the allowance", to: "/settings#plan-allowance" },
    });
    expect(st("api_key", keyMonth).words).toBe("Monthly cap reached until Tue 1 Dec");
    expect(st("subscription", refused)).toEqual({
      words: "Refused: save a new sign-in",
      link: { label: "Save a new sign-in", to: "/setup" },
    });
    expect(st("api_key", refused).words).toBe("Refused: save a new key");
    expect(stateWords("api_key", { saved: false, enabled: true, stop: null }, opts).words).toBe(
      "Not saved",
    );
    expect(monthWords("subscription", { planShare: 0.34, monthChf: "CHF 0.00" })).toBe(
      "34% of this month's allowance used",
    );
    expect(monthWords("api_key", { planShare: null, monthChf: "CHF 2.10" })).toBe(
      "CHF 2.10 this month",
    );
  });

  it("the if-it-runs-out line per preset, none with one credential", () => {
    const line = (id: Parameters<typeof ruleOf>[0]) => ifRunsOutLine(ruleOf(id), both);
    expect(line("subscription_then_ask")).toBe(
      "If your subscription runs out, you are asked before your API key is used.",
    );
    expect(line("subscription_then_key")).toBe(
      "If your subscription runs out, the work goes on with your API key (costs money).",
    );
    expect(line("subscription_then_wait")).toBe(
      "If your subscription runs out, the work waits for it.",
    );
    expect(line("key_then_subscription")).toBe(
      "If your API key runs out, the work goes on with your subscription.",
    );
    expect(line("key_only")).toBe("If your API key runs out, the work waits for it.");
    expect(ifRunsOutLine(ruleOf("subscription_then_ask"), ["subscription"])).toBeNull();
  });

  it("the now line while the first choice is out, and with a yes standing", () => {
    expect(stoppedNowLine("subscription", limit, "ask", { ...opts, askOpen: true })).toBe(
      "Your subscription is at its limit until 15:40. Answer the card to use your API key, or wait.",
    );
    expect(stoppedNowLine("subscription", limit, "ask", { ...opts, askOpen: false })).toBe(
      "Your subscription is at its limit until 15:40; the work waits for it.",
    );
    expect(stoppedNowLine("subscription", share, "next", { ...opts, askOpen: false })).toBe(
      "Your subscription has used its share until Tue 1 Dec; your API key does the work meanwhile.",
    );
    expect(grantNowLine("subscription", "api_key", limit, opts)).toBe(
      "Your work and chat use your API key until 15:40: you said yes.",
    );
    expect(grantNowLine("subscription", "api_key", refused, opts)).toBe(
      "Your work and chat use your API key until a new sign-in is saved: you said yes.",
    );
  });

  it("the one-credential sentences and the fixed lines", () => {
    expect(oneCredentialSentence("subscription")).toEqual({
      sentence:
        "Only your Claude subscription is saved: it does the work; when it runs out the work waits for its reset, and a session you started goes on then. Save an API key to choose what happens then.",
      link: { label: "Save an API key", to: "/setup" },
    });
    expect(oneCredentialSentence("api_key").link.label).toBe("Save your subscription");
    expect(NOT_CHOSEN_LINE).not.toContain("all work");
    expect(EARLIER_LINE.startsWith("Your earlier choice:")).toBe(true);
    expect(RUNS_OUT_LINE.startsWith("Runs out means:")).toBe(true);
    expect(SUBSCRIPTION_FIRST_FOOTNOTE.length).toBeLessThanOrEqual(110);
  });

  it("the section from facts: default, derived, earlier, a grant and the open card's Answer", () => {
    const cred = (kind: "subscription" | "api_key", extra = {}) => ({
      kind,
      saved: true,
      enabled: true,
      stop: null,
      planShare: kind === "subscription" ? 0.34 : null,
      monthChfMicro: kind === "api_key" ? 2_100_000 : 0,
      grant: null,
      ...extra,
    });
    const def = credentialPolicySection({
      policy: credentialPolicyOf({}),
      credentials: [cred("api_key"), cred("subscription")],
      openAskId: null,
      opts,
    });
    expect(def.selected).toBe("subscription_then_wait");
    expect(def.choiceLine).toBe(NOT_CHOSEN_LINE);
    expect(def.rows.map((r) => [r.kind, r.month])).toEqual([
      ["subscription", "34% of this month's allowance used"],
      ["api_key", "CHF 2.10 this month"],
    ]);
    const earlier = credentialPolicySection({
      policy: credentialPolicyOf({ billing_order: ["api_key", "subscription"] }),
      credentials: [cred("api_key"), cred("subscription")],
      openAskId: null,
      opts,
    });
    expect(earlier.selected).toBeNull();
    expect(earlier.choiceLine).toBe(EARLIER_LINE);
    const stop = { ...limit, stopKey: `limit:${limit.until}` };
    const asking = credentialPolicySection({
      policy: credentialPolicyOf({ credential_policy: "subscription_then_ask" }),
      credentials: [cred("subscription", { stop }), cred("api_key")],
      openAskId: "req 1",
      opts,
    });
    expect(asking.answer).toEqual({ label: "Answer", to: "/inbox#card-req%201" });
    const granted = credentialPolicySection({
      policy: credentialPolicyOf({ credential_policy: "subscription_then_ask" }),
      credentials: [
        cred("subscription", { stop, grant: { to: "api_key", stopKey: stop.stopKey } }),
        cred("api_key"),
      ],
      openAskId: null,
      opts,
    });
    expect(granted.grant).toBe(true);
    expect(granted.nowLine).toBe("Your work and chat use your API key until 15:40: you said yes.");
    // A grant for an earlier stop is no yes for this one.
    const old = credentialPolicySection({
      policy: credentialPolicyOf({ credential_policy: "subscription_then_ask" }),
      credentials: [
        cred("subscription", { stop, grant: { to: "api_key", stopKey: "limit:before" } }),
        cred("api_key"),
      ],
      openAskId: null,
      opts,
    });
    expect(old.grant).toBe(false);
  });

  it("the change card's words: less money acts at once, more money asks", () => {
    expect(policyChangeWords("subscription_then_key", "subscription_then_ask").narrows).toBe(true);
    const w = policyChangeWords("subscription_then_wait", "subscription_then_key");
    expect(w.narrows).toBe(false);
    expect(w.ask).toBe(
      "Set which Claude does the work to Subscription first, then API key? When your subscription runs out, work goes on with your API key at once, at a cost per use.",
    );
  });
});

describe("credential-policy-view (CS-3, CS-4): the Start dialog and the plan card", () => {
  it("the run-out lines and the two buttons' words", () => {
    expect(startRunOutLine("subscription", limit, "about CHF 0.90", opts)).toBe(
      "Your subscription is at its limit until 15:40, so this runs on your API key (about CHF 0.90).",
    );
    const use = useApiKeyExplain("subscription", limit, "about CHF 0.90", opts);
    expect(use).toBe(
      "Runs now on your API key until 15:40, about CHF 0.90; nothing passes this session's budget.",
    );
    expect(use.length).toBeLessThanOrEqual(100);
    expect(startLaterLabel(limit, opts)).toBe("Start at 15:40");
    expect(startLaterLabel(share, opts)).toBe("Start on 1 Dec");
    // At most three words (design section 5), the date counted as one ("1 Dec").
    expect(startLaterLabel(limit, opts).split(" ")).toHaveLength(3);
    expect(startLaterExplain("subscription")).toBe(
      "Runs on your subscription once it is back; nothing moves before.",
    );
    expect(grantStartLine("subscription", "api_key", limit, "about CHF 0.90", opts)).toBe(
      "You said yes to your API key until 15:40, so this runs on it (about CHF 0.90).",
    );
    expect(sessionGoesOnLine("2026-11-16T13:05:00Z", "2026-11-16T14:40:00Z", opts)).toBe(
      "Your session of 14:05 goes on by itself at 15:40.",
    );
  });

  it("the plan card's foot line, also while the first choice is out", () => {
    const rule = ruleOf("subscription_then_ask");
    expect(planCardLine(rule, both, null, opts)).toBe(
      "If your subscription runs out, you are asked before your API key is used.",
    );
    expect(planCardLine(rule, both, { kind: "subscription", stop: limit }, opts)).toBe(
      "Your subscription is at its limit until 15:40: you are asked before your API key is used.",
    );
    expect(planCardLine(rule, ["subscription"], null, opts)).toBeNull();
  });
});

describe("credential-policy-view (CS-6, CS-9): the switch and the spend by credential", () => {
  it("the session page, result and drawer lines; Costs by credential", () => {
    const from = { kind: "subscription", reason: "limit" as const };
    expect(sessionSwitchLine("api_key", from, "2026-11-16T13:20:00Z", "CHF 0.42", opts)).toBe(
      "On your API key since 14:20 (your subscription's limit): CHF 0.42 so far.",
    );
    expect(
      resultSwitchLine("api_key", from, "2026-11-16T13:20:00Z", "CHF 0.42", "CHF 0.62", opts),
    ).toBe("Your API key took over at 14:20 (your subscription's limit): CHF 0.42 of CHF 0.62.");
    expect(drawerRunLine("api_key", from, "CHF 0.43")).toBe(
      "On your API key after your subscription's limit · CHF 0.43",
    );
    expect(costByCredentialWords("api_key", "CHF 1.20", null)).toBe("Your API key: CHF 1.20");
    expect(costByCredentialWords("subscription", "CHF 2.10", 0.12)).toBe(
      "Your Claude subscription: CHF 2.10 (estimate, 12% of its allowance)",
    );
  });
});

describe("d1109-cred-screens, run C (CS-5): every stop and the question in rows and the project status", () => {
  const base = { sourceId: "s1", kind: "subscription" as const };
  it("rows: the share with Change the allowance, a key's monthly cap, the ask with Answer, each with the after-the-wait clause", () => {
    const share = waitRowWords(
      { ...base, reason: "share", until: "2026-12-01T00:00:00Z" },
      { ...opts, goesOn: false },
    );
    expect(share).toEqual({
      label: "Waits until Tue 1 Dec (your subscription's share)",
      detail: "Then it runs at your next Start.",
      line: "Waiting until Tue 1 Dec (your subscription's share)",
      save: { label: "Change the allowance", to: "/settings#plan-allowance" },
    });
    const month = waitRowWords(
      { sourceId: "k1", kind: "api_key", reason: "key_month", until: "2026-12-01T00:00:00Z" },
      { ...opts, goesOn: true },
    );
    expect(month.label).toBe("Waits until Tue 1 Dec (your API key's monthly cap)");
    expect(month.detail).toBe("Then your session goes on.");
    const ask = waitRowWords(
      { ...base, reason: "limit", until: limit.until, ask: true },
      { ...opts, askCardId: "req_1" },
    );
    expect(ask).toEqual({
      label: "Waits for your answer: use your API key?",
      detail: "Answer the card in the Inbox.",
      line: "Waiting for you: use your API key?",
      save: { label: "Answer", to: "/inbox#card-req_1" },
      ask: true,
    });
    // The limit keeps its form, now as the design writes it.
    expect(
      waitRowWords({ ...base, reason: "limit", until: limit.until }, { ...opts, goesOn: true })
        .label,
    ).toBe("Waits until 15:40 (your subscription's limit)");
  });

  it("the project status: the ask first with Answer; the share with Change the allowance; never '0 of 2 done'", () => {
    const tasks = [
      { id: "t1", title: "A", status: "ready" },
      { id: "t2", title: "B", status: "ready" },
    ] as never;
    const ask = waitRowWords(
      { ...base, reason: "limit", until: limit.until, ask: true },
      { ...opts, askCardId: "req_1" },
    );
    const displays = new Map([
      ["t1", { key: "waiting", label: ask.label }],
      ["t2", { key: "waiting", label: ask.label }],
    ]);
    const asking = projectStatusLine({
      tasks,
      displays: displays as never,
      cards: [],
      plan: "none",
      credentialWait: ask,
      // A session working elsewhere is no reason to hide what needs the person.
      working: { sessionId: "s", taskTitle: "C" },
    } as never);
    expect(asking.text).toBe("Waiting for you: use your API key?");
    expect(asking.action).toEqual({ kind: "link", label: "Answer", to: "/inbox#card-req_1" });
    const share = waitRowWords(
      { ...base, reason: "share", until: "2026-12-01T00:00:00Z" },
      { ...opts, goesOn: false },
    );
    const shareDisplays = new Map([
      ["t1", { key: "waiting", label: share.label }],
      ["t2", { key: "waiting", label: share.label }],
    ]);
    const waiting = projectStatusLine({
      tasks,
      displays: shareDisplays as never,
      cards: [],
      plan: "none",
      credentialWait: share,
    } as never);
    expect(waiting.text).toBe("Waiting until Tue 1 Dec (your subscription's share): 2 tasks");
    expect(waiting.action).toEqual({
      kind: "link",
      label: "Change the allowance",
      to: "/settings#plan-allowance",
    });
    expect(waiting.text).not.toContain("0 of 2 done");
  });
});
