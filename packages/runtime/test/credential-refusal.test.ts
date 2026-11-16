import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import {
  BILLING_REFUSED_AUDIT_TOOL,
  CREDENTIAL_REFUSED_KEY,
} from "../src/session/credential-wait.ts";
import {
  askCardWords,
  backLogLine,
  chatHoldReply,
  chatOneOffExplain,
  chatSwitchNote,
  refusalCategoryOf,
  refusalWhy,
  refusedBody,
  switchLogLine,
  switchNotificationWords,
} from "../src/session/credential-words.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { RouterTaskBilling, seedBillingSources } from "../src/wiring/billing-pick.ts";
import { removeHomes } from "./helpers.ts";

const API_KEY = ["sk-ant-api03-", "refusalkey", "5".repeat(40)].join(""); // not-a-secret
const OAUTH = ["sk-ant-oat01-", "refusaltok", "6".repeat(40)].join(""); // not-a-secret
const homes: string[] = [];
afterAll(() => removeHomes(homes));

// d1109-cred-engine CE-8 (ADR 0120; the owner's 7c: "If a credential is refused, follow the
// frameowrk ... but also give the user some kind of notification or information").
describe("d1109-cred-engine, run C: a refusal informs once and is never retried (CE-8)", () => {
  it("refusalWhy names the category, never the provider's words", () => {
    const cases: [string, string, string][] = [
      [
        "api_key",
        '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        "The key is not valid or was deleted.",
      ],
      [
        "api_key",
        '403 {"type":"error","error":{"type":"permission_error","message":"not allowed"}}',
        "The key may not use this model or workspace.",
      ],
      [
        "subscription",
        "authentication_failed: OAuth token has expired",
        "The sign-in has expired or was signed out.",
      ],
      ["api_key", "something odd happened at the provider", "Anthropic did not accept it."],
    ];
    for (const [kind, message, words] of cases) {
      const why = refusalWhy(refusalCategoryOf(kind, message));
      expect(why, message).toBe(words);
      expect(why).not.toContain("x-api-key");
      expect(why).not.toContain("OAuth token");
    }
  });

  it("the refused card's body by rule: wait, then the API key, ask; no body says 'starts by itself'", () => {
    const signedOut = "signed_out" as const;
    const bodies = [
      refusedBody({ category: signedOut, rule: "wait" }),
      refusedBody({ category: signedOut, rule: "next", other: "api_key" }),
      refusedBody({ category: signedOut, rule: "ask", other: "api_key", estimateChf: "CHF 0.90" }),
    ];
    expect(bodies).toEqual([
      "The sign-in has expired or was signed out. Save a new one in Settings; until then the work waits.",
      "The sign-in has expired or was signed out. Save a new one in Settings; until then your API key does the work, at a cost per use.",
      "The sign-in has expired or was signed out. Save a new one in Settings, or go on with your API key until then (about CHF 0.90).",
    ]);
    for (const b of bodies) expect(b).not.toMatch(/starts by itself/);
  });

  it("two refusals of one key at the same instant file one card and one billing.refused row; work that waits on it again after the card closed files it once more, across a restart too", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-refusal-"));
    homes.push(home);
    const clock = new SimulatedClock("2026-10-20T09:00:00Z");
    const vault = new MemoryVault({
      [SECRET_NAMES.anthropic]: API_KEY,
      [SECRET_NAMES.anthropicOauth]: OAUTH,
    });
    const url = `sqlite:${join(home, "state.sqlite")}`;
    let store: StateStore = await openStore({ url, clock });
    const human = await store.human.insert({
      name: "J",
      email: "",
      timezone: "UTC",
      notify_prefs: { credential_policy: "key_then_subscription" },
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    });
    const rows = await seedBillingSources({ store, vault, humanId: human.id });
    const keyId = rows.find((r) => r.kind === "api_key")?.id ?? "";
    const project = await store.project.insert({ name: "P", goal: "g", autonomy_level: 2 });
    let billing = new RouterTaskBilling({ store, vault, clock, humanId: human.id });
    const why = '401 {"type":"error","error":{"type":"authentication_error"}}';
    await Promise.all([billing.refuse(keyId, why), billing.refuse(keyId, why)]);
    const openCards = async () =>
      (await store.humanRequest.open({ humanId: human.id }, { limit: 50 })).filter(
        (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_REFUSED_KEY,
      );
    expect(await openCards()).toHaveLength(1);
    const audits = await store.auditLog.list({ tool: BILLING_REFUSED_AUDIT_TOOL } as never, {
      limit: 10,
    });
    expect(audits).toHaveLength(1);
    const row = await store.billingSource.mustGet(keyId);
    expect((row.limits as { refusedCategory?: unknown }).refusedCategory).toBe("invalid_key");
    expect(JSON.stringify(row.limits)).not.toContain(API_KEY);
    // Work waits on the key; the subscription takes it, so the card closes (TR-10).
    await billing.noteWait(keyId, project.id, "agent");
    await billing.takeReady(async () => true);
    expect(await openCards()).toHaveLength(0);
    // A restart; then work waits on the still-refused key again at the same instant: one card.
    await store.close();
    store = await openStore({ url, clock });
    billing = new RouterTaskBilling({ store, vault, clock, humanId: human.id });
    await Promise.all([
      billing.noteWait(keyId, project.id, "agent"),
      billing.noteWait(keyId, project.id, "agent-2"),
    ]);
    expect(await openCards()).toHaveLength(1);
    // A third wait while the card is open files none.
    await billing.noteWait(keyId, project.id, "agent");
    expect(await openCards()).toHaveLength(1);
    await store.close();
  });
});

describe("d1109-cred-engine, run C: every sentence of the policy (credential-words)", () => {
  const now = Date.parse("2026-11-16T09:00:00Z");
  const limit = { reason: "limit" as const, kind: "subscription" as const };
  it("the ask card, its options, Details and Done lines", () => {
    const w = askCardWords({
      wait: { ...limit, until: "2026-11-16T14:40:00Z" },
      timezone: "Europe/Zurich",
      nowMs: now,
      estimateChf: "CHF 0.90",
      sessionWaits: true,
    });
    expect(w.title).toBe("Use your API key until 15:40?");
    expect(w.options).toEqual([
      {
        label: "Use API key",
        explain:
          "Your work and chat use your API key until 15:40: about CHF 0.90 for what waits now.",
      },
      {
        label: "Wait",
        explain: "Nothing moves until 15:40; then your session goes on with your subscription.",
      },
    ]);
    expect(w.details).toEqual([
      "Forerunner's own monthly checks wait for your subscription; they cost nothing meanwhile.",
    ]);
    expect(w.done.use).toBe(
      "Done: your API key does the work until 15:40; your session goes on now.",
    );
    expect(w.closed).toBe("Closed: your Claude subscription can work again.");
    const none = askCardWords({
      wait: { ...limit, until: "2026-11-16T14:40:00Z" },
      timezone: "Europe/Zurich",
      nowMs: now,
      estimateChf: "CHF 0.90",
      sessionWaits: false,
    });
    expect(none.options[1]?.explain).toBe(
      "Nothing moves. After 15:40 the work runs at your next Start.",
    );
    for (const o of [...w.options, ...none.options])
      expect(o.explain.length).toBeLessThanOrEqual(100);
  });

  it("the share's two Wait lines and its title (CE-6)", () => {
    const share = {
      reason: "share" as const,
      kind: "subscription" as const,
      until: "2026-12-01T00:00:00.000Z",
    };
    const w = askCardWords({
      wait: share,
      timezone: "Europe/Zurich",
      nowMs: now,
      estimateChf: "CHF 0.90",
      sessionWaits: true,
    });
    expect(w.title).toBe("Use your API key until Tue 1 Dec?");
    expect(w.options[1]?.explain).toBe(
      "Nothing moves until Tue 1 Dec, 01:00, or until you raise the allowance; then your session goes on.",
    );
    const none = askCardWords({
      wait: share,
      timezone: "Europe/Zurich",
      nowMs: now,
      estimateChf: "CHF 0.90",
      sessionWaits: false,
    });
    expect(none.options[1]?.explain).toBe(
      "Nothing moves. After Tue 1 Dec, 01:00, or a raised allowance, the work runs at your next Start.",
    );
  });

  it("chat's hold reply, its one-off press and its note; the log lines and the notification", () => {
    expect(chatHoldReply(limit, "15:40")).toBe(
      "Your Claude subscription is at its limit until 15:40, so I have not answered. I can still add, move and start tasks.",
    );
    expect(chatOneOffExplain("api_key", "CHF 0.02")).toBe(
      "Answers this question on your API key: about CHF 0.02.",
    );
    expect(chatSwitchNote("api_key", limit, "15:40")).toBe(
      "Answered with your API key: your subscription is at its limit until 15:40.",
    );
    expect(switchLogLine("Style the page", "api_key", limit, "15:40")).toBe(
      '"Style the page" goes on with your API key from where it stopped: your subscription is at its limit until 15:40.',
    );
    expect(backLogLine("subscription")).toBe(
      "Your Claude subscription can work again; the next tasks use it.",
    );
    expect(
      switchNotificationWords({
        projectName: "Quote page",
        wait: limit,
        until: "15:40",
        estimateChf: "CHF 0.90",
      }),
    ).toEqual({
      title: "Quote page: work goes on with your API key",
      body: "Your Claude subscription is at its limit until 15:40. Your API key costs money: about CHF 0.90 for what is left.",
    });
  });
});
