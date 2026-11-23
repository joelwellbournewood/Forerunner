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
import { eventAudience } from "../src/daemon/event-audience.ts";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { needsWaitWords, waitRowWords } from "../src/session/credential-wait.ts";
import {
  askCardWords,
  backLogLine,
  chatOneOffExplain,
  switchRunLine,
} from "../src/session/credential-words.ts";
import { waitingWorkUsdMicro } from "../src/session/start-check.ts";

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
      "Your subscription is at its limit until 15:40; you are asked before your API key is used.",
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

describe("d1109-cred-screens, run C (C5-left-1): the switch's session log lines", () => {
  const sw = { from: "subscription", to: "api_key", stop: "limit", by: "policy" } as const;
  it("the run that goes on, a task that starts on the key, the person's yes and the back line", () => {
    expect(switchRunLine("Style the page", sw, "15:40", true)).toBe(
      '"Style the page" goes on with your API key from where it stopped: your subscription is at its limit until 15:40.',
    );
    expect(switchRunLine("Write the copy", sw, "15:40", false)).toBe(
      '"Write the copy" runs on your API key: your subscription is at its limit until 15:40.',
    );
    expect(switchRunLine("Style the page", { ...sw, by: "grant" }, "15:40", true)).toBe(
      '"Style the page" goes on with your API key from where it stopped: your subscription is at its limit until 15:40, and you said yes.',
    );
    expect(switchRunLine("Style the page", { ...sw, stop: "refused" }, null, true)).toBe(
      '"Style the page" goes on with your API key from where it stopped: Anthropic refused your Claude sign-in.',
    );
    expect(
      switchRunLine(
        "Style the page",
        { from: "api_key", to: "subscription", stop: "key_month", by: "policy" },
        "Tue 1 Dec",
        false,
      ),
    ).toBe(
      '"Style the page" runs on your Claude subscription: your API key is at its monthly cap until Tue 1 Dec.',
    );
  });

  it("the log shows the first switch of a stop to the person and a later task's as a detail", () => {
    const payload = { sentence: switchRunLine("A", sw, "15:40", true) };
    expect(describeEvent("billing.switch", payload, 1)).toBe(payload.sentence);
    expect(eventAudience("billing.switch", payload)).toBe("person");
    expect(eventAudience("billing.switch", { ...payload, repeat: true })).toBe("detail");
    expect(describeEvent("billing.back", { sentence: backLogLine("subscription") }, 1)).toBe(
      "Your Claude subscription can work again; the next tasks use it.",
    );
    expect(eventAudience("billing.back", {})).toBe("person");
  });
});

describe("d1109-cred-screens, run C (CS-8): chat's one-off line never says CHF 0.00", () => {
  it("a cost under a centime reads 'less than CHF 0.01', with no 'about'", () => {
    expect(chatOneOffExplain("api_key", "CHF 0.02")).toBe(
      "Answers this question on your API key: about CHF 0.02.",
    );
    expect(chatOneOffExplain("api_key", "less than CHF 0.01")).toBe(
      "Answers this question on your API key: less than CHF 0.01.",
    );
  });
});

/**
 * d1109-cred-screens (CS-8, CS-10's walk; design §5 rule 7: "CHF ... 'about' for estimates", and
 * W15-74's rule, never "about CHF 0.00" for a cost): the ask card the person answers named "about
 * CHF 0.00" on the bench, for work whose estimate was not known when the card was filed, and would
 * say "about less than CHF 0.01" under a centime. Now: the figure when there is one, "less than
 * CHF 0.01" alone under a centime, and no figure ("at a cost per use") when none is known.
 */
describe("d1109-cred-screens, run C: the ask card's figure (CS-8)", () => {
  const base = {
    wait: {
      reason: "limit" as const,
      kind: "subscription" as const,
      until: "2026-11-16T14:40:00Z",
    },
    timezone: "Europe/Zurich",
    nowMs: Date.parse("2026-11-16T13:00:00Z"),
    sessionWaits: true,
  };
  it("a known figure reads 'about CHF 0.40'; under a centime 'less than CHF 0.01'; none known, no figure", () => {
    const known = askCardWords({ ...base, estimateChf: "CHF 0.40" });
    expect(known.body).toBe(
      "Your Claude subscription is at its limit until 15:40. Your API key can do the waiting work now: about CHF 0.40.",
    );
    expect(known.options[0]?.explain).toBe(
      "Your work and chat use your API key until 15:40: about CHF 0.40 for what waits now.",
    );
    const tiny = askCardWords({ ...base, estimateChf: "less than CHF 0.01" });
    expect(tiny.body).toBe(
      "Your Claude subscription is at its limit until 15:40. Your API key can do the waiting work now: less than CHF 0.01.",
    );
    expect(tiny.options[0]?.explain).toBe(
      "Your work and chat use your API key until 15:40: less than CHF 0.01 for what waits now.",
    );
    const none = askCardWords({ ...base, estimateChf: "CHF 0.00" });
    expect(none.body).toBe(
      "Your Claude subscription is at its limit until 15:40. Your API key can do the waiting work now, at a cost per use.",
    );
    expect(none.options[0]?.explain).toBe(
      "Your work and chat use your API key until 15:40, at a cost per use.",
    );
    for (const w of [known, tiny, none])
      for (const s of [w.body, ...w.options.map((o) => o.explain)]) {
        expect(s).not.toContain("about CHF 0.00");
        expect(s).not.toContain("about less than");
        expect(s.length).toBeLessThanOrEqual(140);
      }
    for (const w of [known, tiny, none])
      for (const o of w.options) expect(o.explain.length).toBeLessThanOrEqual(100);
  });

  it("the refused form says the same", () => {
    const refused = {
      ...base,
      wait: { reason: "refused" as const, kind: "subscription" as const, until: null },
    };
    expect(askCardWords({ ...refused, estimateChf: "CHF 0.00" }).body).toBe(
      "Anthropic refused your Claude sign-in. Your API key can do the waiting work now, at a cost per use.",
    );
    expect(
      askCardWords({ ...refused, estimateChf: "less than CHF 0.01" }).options[0]?.explain,
    ).toBe(
      "Your work and chat use your API key until a new sign-in is saved: less than CHF 0.01 for what waits now.",
    );
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-15; ADR 0120 amended 2026-11-22): the waiting work has one
 * figure (`waitingWorkUsdMicro`: the promise plus what is left of a held task, within the work
 * budget), and the plan card's foot line says it where the API key would do the plan's work.
 */
describe("l4-cred-screens, run L4: one figure for the waiting work (L4-creds-15)", () => {
  const t = (title: string, usd: number) => ({
    taskId: title,
    title,
    estimateUsdMicro: Math.round(usd * 1_000_000),
  });
  it("the promise (runnable, the larger task's room, the followers) plus what is left of a held task, within the work budget", () => {
    const check = {
      runnable: [t("A", 0.13)],
      later: [t("B", 0.12)],
      overBudget: [],
      oversized: null,
      workBudgetUsdMicro: 4_000_000,
    };
    expect(waitingWorkUsdMicro(check)).toBe(250_000);
    expect(waitingWorkUsdMicro(check, [{ leftUsdMicro: 90_000 }])).toBe(340_000);
    // Never more than the work budget: nothing passes it.
    expect(
      waitingWorkUsdMicro({ ...check, workBudgetUsdMicro: 300_000 }, [{ leftUsdMicro: 90_000 }]),
    ).toBe(300_000);
    // A held task that spent more than its estimate adds nothing.
    expect(waitingWorkUsdMicro(check, [{ leftUsdMicro: -5 }])).toBe(250_000);
  });

  it("the plan card's foot line says the figure where the API key would do the work, never 'costs money' beside it", () => {
    const ask = ruleOf("subscription_then_ask");
    const next = ruleOf("subscription_then_key");
    const stopped = { kind: "subscription", stop: limit };
    expect(planCardLine(ask, both, stopped, { ...opts, about: "about CHF 0.25" })).toBe(
      "Your subscription is at its limit until 15:40: you are asked before your API key is used (about CHF 0.25).",
    );
    expect(planCardLine(next, both, stopped, { ...opts, about: "about CHF 0.25" })).toBe(
      "Your subscription is at its limit until 15:40: your API key does the work meanwhile (about CHF 0.25).",
    );
    expect(
      planCardLine(ask, both, stopped, { ...opts, granted: true, about: "about CHF 0.25" }),
    ).toBe(
      "Your subscription is at its limit until 15:40: you said yes, so your API key does the work meanwhile (about CHF 0.25).",
    );
    // Without a figure (no plan priced): as before.
    expect(planCardLine(next, both, stopped, opts)).toBe(
      "Your subscription is at its limit until 15:40: your API key does the work meanwhile (costs money).",
    );
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-16, CS-5's needs form; run C decision 55: never cut): work
 * that only one credential can do here and that waits for it says why on its row, the status line
 * and the bar, each within design section 5's lengths.
 */
describe("l4-cred-screens, run L4: the needs form (L4-creds-16)", () => {
  const keyWait = {
    reason: "needs" as const,
    sourceId: "k1",
    kind: "api_key" as const,
    until: "2026-11-16T14:40:00Z",
    stop: "limit" as const,
    needs: ["webRead"],
  };
  it("the row, the status head and the bar's line say what only the API key can do here", () => {
    const words = needsWaitWords("api_key", ["webRead"]);
    expect(words).toEqual({
      label: "Waits for your API key: only it can read web pages here.",
      line: "Waiting for your API key (only it can read web pages here)",
      why: "Only your API key can read web pages here.",
    });
    for (const s of Object.values(words)) expect(s.length).toBeLessThanOrEqual(80);
    // Two needs fit; a list too long for a row keeps the first.
    expect(needsWaitWords("api_key", ["webRead", "webSearch"]).label).toBe(
      "Waits for your API key: only it can read web pages and search the web here.",
    );
    expect(
      needsWaitWords("api_key", ["webRead", "webSearch", "askPerson"]).label.length,
    ).toBeLessThanOrEqual(80);
  });

  it("the row's detail says what holds the key and what then, at a limit, the share, a refusal", () => {
    const row = waitRowWords(keyWait, { ...opts, goesOn: false });
    expect(row.label).toBe("Waits for your API key: only it can read web pages here.");
    expect(row.detail).toBe(
      "Your API key is at its limit until 15:40; then it runs at your next Start.",
    );
    expect(row.line).toBe("Waiting for your API key (only it can read web pages here)");
    expect(row.why).toBe("Only your API key can read web pages here.");
    expect(row.save).toBeNull();
    expect(waitRowWords(keyWait, { ...opts, goesOn: true }).detail).toBe(
      "Your API key is at its limit until 15:40; then your session goes on.",
    );
    const refused = waitRowWords(
      { ...keyWait, stop: "refused", until: null },
      { ...opts, goesOn: false },
    );
    expect(refused.detail).toBe(
      "Anthropic refused it. Save a new API key in Settings; then it runs at your next Start.",
    );
    expect(refused.save).toEqual({ label: "Save a new key", to: "/setup" });
    const sub = waitRowWords(
      { ...keyWait, kind: "subscription", stop: "share", until: "2026-12-01T00:00:00Z" },
      { ...opts, goesOn: false },
    );
    expect(sub.label).toBe("Waits for your Claude subscription: only it can read web pages here.");
    expect(sub.detail).toBe(
      "Your Claude subscription has used its share until Tue 1 Dec; then it runs at your next Start.",
    );
    expect(sub.save).toEqual({ label: "Change the allowance", to: "/settings#plan-allowance" });
    for (const r of [row, refused, sub]) {
      expect(r.label.length).toBeLessThanOrEqual(80);
      expect(r.line.length).toBeLessThanOrEqual(80);
    }
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-17, live check 4's LC-C26): under "API key first, then
 * subscription" with the key out, the Start dialog names the stop in that direction, and no line
 * says the subscription costs money.
 */
describe("l4-cred-screens, run L4: the key-first direction (L4-creds-17)", () => {
  it("the dialog's run-out line with the key first, and the plan card without '(costs money)'", () => {
    expect(startRunOutLine("api_key", limit, "about CHF 0.07", opts)).toBe(
      "Your API key is at its limit until 15:40, so this runs on your subscription (about CHF 0.07).",
    );
    const keyFirst = ruleOf("key_then_subscription");
    const line = planCardLine(keyFirst, both, { kind: "api_key", stop: limit }, opts);
    expect(line).toBe(
      "Your API key is at its limit until 15:40: your subscription does the work meanwhile.",
    );
    expect(line).not.toContain("costs money");
    expect(
      planCardLine(
        keyFirst,
        both,
        { kind: "api_key", stop: limit },
        {
          ...opts,
          about: "about CHF 0.07",
        },
      ),
    ).toBe("Your API key is at its limit until 15:40: your subscription does the work meanwhile.");
  });
});

/**
 * l4-cred-screens, run L4 (L4-creds-25, live check 4's LC-C25, C6L-4): the refused form of the
 * Use API key line fits design section 5's 100 characters, and Settings' now line under "ask"
 * says the person is asked before the API key is used, not that the work waits.
 */
describe("l4-cred-screens, run L4: credential words within section 5 (L4-creds-25)", () => {
  it("the refused Use API key line is at most 100 characters and says the step", () => {
    const sub = useApiKeyExplain("subscription", refused, "about CHF 0.90", opts);
    expect(sub).toBe("Runs now on your API key until you sign in again, about CHF 0.90.");
    expect(useApiKeyExplain("api_key", refused, "about CHF 10.90", opts)).toBe(
      "Runs now on your subscription until you save a new key, about CHF 10.90.",
    );
    // The button is "Use API key": the subscription is the one that stopped.
    for (const stop of [limit, share, refused])
      for (const about of ["about CHF 10.90", "less than CHF 0.01"])
        expect(useApiKeyExplain("subscription", stop, about, opts).length).toBeLessThanOrEqual(100);
  });

  it("Settings' now line under ask with no card open says the person is asked first", () => {
    expect(stoppedNowLine("subscription", limit, "ask", { ...opts, askOpen: false })).toBe(
      "Your subscription is at its limit until 15:40; you are asked before your API key is used.",
    );
    expect(stoppedNowLine("subscription", refused, "ask", { ...opts, askOpen: false })).toBe(
      "Anthropic refused your Claude sign-in; you are asked before your API key is used.",
    );
    // "Then wait" keeps its line: the work waits for it.
    expect(stoppedNowLine("subscription", limit, "wait", { ...opts, askOpen: false })).toBe(
      "Your subscription is at its limit until 15:40; the work waits for it.",
    );
  });
});
