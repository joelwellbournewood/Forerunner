import { FakeProbe, stopKeyOf } from "@forerunner/billing";
import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialWaitOf } from "../src/session/credential-wait.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import {
  DEFAULT_CHOOSER_FACTS,
  RouterTaskBilling,
  seedBillingSources,
  updateSourceLimits,
} from "../src/wiring/billing-pick.ts";
import { credWorld, seedProject, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

const API_KEY = ["sk-ant-api03-", "policykey", "5".repeat(40)].join(""); // not-a-secret
const OAUTH = ["sk-ant-oat01-", "policytoken", "6".repeat(40)].join(""); // not-a-secret

// d1109-cred-engine CE-3 (ADR 0120; the owner's 7a, 7b, 7c and answer 4 of 2026-11-09): one
// credential policy for every call. "A wait moves nothing" as one table over the pick.
describe("d1109-cred-engine, run C: RouterTaskBilling.pick follows the one policy", () => {
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const now = clock.now();
  let store: StateStore;
  let humanId: string;
  let subId: string;
  let keyId: string;
  const vault = new MemoryVault({
    [SECRET_NAMES.anthropic]: API_KEY,
    [SECRET_NAMES.anthropicOauth]: OAUTH,
  });
  const probe = new FakeProbe();
  let billing: RouterTaskBilling;
  let facts = { ...DEFAULT_CHOOSER_FACTS };

  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({
      name: "J",
      email: "",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    });
    humanId = human.id;
    const rows = await seedBillingSources({ store, vault, humanId });
    subId = rows.find((r) => r.kind === "subscription")?.id ?? "";
    keyId = rows.find((r) => r.kind === "api_key")?.id ?? "";
    billing = new RouterTaskBilling({ store, vault, clock, humanId, probe, facts: () => facts });
  });
  afterAll(async () => {
    await store.close();
  });

  const setPolicy = (policy: string | null) =>
    store.human.patch(humanId, {
      notify_prefs: (policy ? { credential_policy: policy } : {}) as never,
    });
  const sourceOf = async (id: string) => {
    const row = await store.billingSource.mustGet(id);
    return { kind: row.kind as "subscription" | "api_key", limits: row.limits as never };
  };
  const setGrant = async (stopKey: string | null) =>
    updateSourceLimits(store, subId, (limits) => {
      const { grant: _g, ...rest } = limits;
      return stopKey
        ? { ...rest, grant: { to: "api_key", stopKey, by: "card", at: clock.nowIso() } }
        : rest;
    });
  const pickOf = async (purpose: string, extra: Record<string, unknown> = {}) => {
    try {
      const p = await billing.pick({
        agentId: "agent",
        agentOwnerHumanId: humanId,
        runner: "pc",
        modelTier: "sonnet",
        purpose: purpose as never,
        ...extra,
      });
      return { kind: p.source.kind as string };
    } catch (e) {
      const wait = credentialWaitOf(e);
      if (!wait) throw e;
      return { wait };
    }
  };

  const stops = {
    limit: { available: true, restingUntil: "2026-10-20T15:40:00Z" },
    share: { available: true, planUsageShare: 0.96 },
    refused: { available: true, refused: "2026-10-20T08:00:00Z" },
  } as const;
  const purposes = ["session", "critic", "interactive", "chat", "batch"] as const;
  const rules = ["wait", "ask unanswered", "ask granted", "ask granted older", "next"] as const;

  for (const [stop, status] of Object.entries(stops))
    for (const rule of rules)
      it(`a subscription stopped (${stop}) under ${rule}: every purpose`, async () => {
        probe.set(subId, status);
        probe.set(keyId, { available: true });
        await setPolicy(
          rule === "wait"
            ? "subscription_then_wait"
            : rule === "next"
              ? "subscription_then_key"
              : "subscription_then_ask",
        );
        const key = stopKeyOf(await sourceOf(subId), status, now, 0.95) ?? "";
        await setGrant(
          rule === "ask granted" ? key : rule === "ask granted older" ? "limit:older" : null,
        );
        for (const purpose of purposes) {
          const got = await pickOf(purpose);
          const moves = rule === "next" || (rule === "ask granted" && purpose !== "batch");
          if (moves) expect(got, `${purpose}`).toEqual({ kind: "api_key" });
          else
            expect(got, `${purpose}`).toEqual({
              wait: expect.objectContaining({
                reason: stop,
                sourceId: subId,
                kind: "subscription",
                stopKey: key,
                ...(rule.startsWith("ask") ? { ask: true } : {}),
              }),
            });
        }
        await setGrant(null);
        probe.set(subId, { available: true });
      });

  it("an API key at its monthly cap: key_only waits, key_then_subscription moves to the subscription", async () => {
    await updateSourceLimits(store, keyId, (l) => ({ ...l, monthlyUsdMicro: 1_000_000 }));
    probe.set(keyId, { available: true, monthSpentUsdMicro: 1_000_000 });
    await setPolicy("key_only");
    for (const purpose of purposes)
      expect(await pickOf(purpose)).toEqual({
        wait: expect.objectContaining({ reason: "key_month", sourceId: keyId }),
      });
    await setPolicy("key_then_subscription");
    for (const purpose of purposes) expect(await pickOf(purpose)).toEqual({ kind: "subscription" });
    probe.set(keyId, { available: true });
    await updateSourceLimits(store, keyId, (l) => {
      const { monthlyUsdMicro: _m, ...rest } = l;
      return rest;
    });
  });

  it("with nothing chosen, every purpose picks the subscription first and waits at its stop (the default preset)", async () => {
    await setPolicy(null);
    for (const purpose of purposes)
      expect(await pickOf(purpose), purpose).toEqual({ kind: "subscription" });
    probe.set(subId, stops.limit);
    for (const purpose of purposes)
      expect(await pickOf(purpose), purpose).toEqual({
        wait: expect.objectContaining({ reason: "limit", sourceId: subId }),
      });
    probe.set(subId, { available: true });
  });

  it("a source this very call saw stop (req.exclude) is held under wait, never passed over", async () => {
    await setPolicy("subscription_then_wait");
    expect(await pickOf("chat", { exclude: [subId] })).toEqual({
      wait: expect.objectContaining({ reason: "limit", sourceId: subId }),
    });
    await setPolicy("subscription_then_key");
    expect(await pickOf("chat", { exclude: [subId] })).toEqual({ kind: "api_key" });
  });

  it("under key_then_subscription with the key resting, a task only the key can do waits with reason needs; a code task moves", async () => {
    facts = { ...DEFAULT_CHOOSER_FACTS, webFetch: true, subscriptionPages: false };
    await setPolicy("key_then_subscription");
    probe.set(keyId, { available: true, restingUntil: "2026-10-20T15:40:00Z" });
    const research = await pickOf("session", { needs: { hard: ["webRead"], better: [] } });
    expect(research).toEqual({
      wait: expect.objectContaining({ reason: "needs", stop: "limit", sourceId: keyId }),
    });
    expect(await pickOf("session", { needs: { hard: [], better: [] } })).toEqual({
      kind: "subscription",
    });
    probe.set(keyId, { available: true });
    facts = { ...DEFAULT_CHOOSER_FACTS };
  });

  it("an earlier API-key-first choice keeps a research task only the subscription can do on it; key_only waits with reason needs", async () => {
    facts = { ...DEFAULT_CHOOSER_FACTS, webFetch: false, subscriptionPages: true };
    await store.human.patch(humanId, {
      notify_prefs: { billing_order: ["api_key", "subscription"] } as never,
    });
    expect(await pickOf("session", { needs: { hard: ["webRead"], better: [] } })).toEqual({
      kind: "subscription",
    });
    await setPolicy("key_only");
    expect(await pickOf("session", { needs: { hard: ["webRead"], better: [] } })).toEqual({
      wait: expect.objectContaining({ reason: "needs", kind: "subscription", sourceId: "" }),
    });
    facts = { ...DEFAULT_CHOOSER_FACTS };
  });

  it("a changed policy applies to the very next pick", async () => {
    probe.set(subId, stops.limit);
    await setPolicy("subscription_then_wait");
    expect("wait" in (await pickOf("chat"))).toBe(true);
    await setPolicy("subscription_then_key");
    expect(await pickOf("chat")).toEqual({ kind: "api_key" });
    probe.set(subId, { available: true });
  });

  it("a one-off switch (allowSwitch) moves that one chat call, never a background job's", async () => {
    probe.set(subId, stops.limit);
    await setPolicy("subscription_then_wait");
    expect(await pickOf("chat", { allowSwitch: true })).toEqual({ kind: "api_key" });
    expect("wait" in (await pickOf("batch", { allowSwitch: true }))).toBe(true);
    expect("wait" in (await pickOf("chat"))).toBe(true);
    probe.set(subId, { available: true });
    expect(ForerunnerError).toBeDefined();
  });
});

// d1109-selftasks-chat, run C (SC-14; D5 with D7, the owner of 2026-11-09: "It should definitely
// not automatically do something even when told to wait or showing that it is waiting."): the
// table's row for chat's "fix the tasks". The daemon composed with no injected provider
// (cred-world.ts). Under "then wait" and an unanswered "then ask me", with the subscription at its
// limit, the check makes no call (no request to the Messages API stand-in, no ledger row), no task
// changes and chat says why; under "then the API key" it runs once on the key and its cost shows
// in CHF.
describe("d1109-selftasks-chat, run C: 'fix the tasks' follows the one policy (SC-14)", () => {
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));
  const RESET = Date.parse("2026-10-31T14:40:00Z");

  async function fixTasks(policy: string) {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-policy-fix-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, policy);
      world.limitSubscription(RESET);
      const { project } = await seedProject(rt, "Quote page", ["Style the page", "Publish"]);
      // A question first meets the limit, so the app knows the subscription rests (as a session's
      // call would); what follows is measured from here.
      await req("/chat", {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId: project.id,
        projectTab: true,
        text: "what is next?",
      });
      const before = (await rt.store.task.forProject(project.id, {}, { limit: 50 })).map((t) => [
        t.title,
        t.status,
        t.version,
      ]);
      const ledger = (await rt.store.costLedger.list({} as never, { limit: 1000 })).length;
      const keyCalls = world.keyCalls().length;
      const sdkCalls = world.sdkCalls.length;
      const reply = (
        await req<{ reply: string; footer?: string | null }>("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          projectId: project.id,
          projectTab: true,
          text: "fix the tasks",
        })
      ).body;
      const after = (await rt.store.task.forProject(project.id, {}, { limit: 50 })).map((t) => [
        t.title,
        t.status,
        t.version,
      ]);
      return {
        reply,
        changed: JSON.stringify(after) !== JSON.stringify(before),
        booked: (await rt.store.costLedger.list({} as never, { limit: 1000 })).length - ledger,
        keyCalls: world.keyCalls().slice(keyCalls),
        sdkCalls: world.sdkCalls.length - sdkCalls,
      };
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }

  for (const policy of ["subscription_then_wait", "subscription_then_ask"])
    it(`${policy}: no call, nothing booked, no task changed, one sentence that says why`, async () => {
      const r = await fixTasks(policy);
      expect(r.reply.reply).toBe(
        "Fixing the tasks waits for Claude: your subscription is at its limit until 15:40. Nothing changed.",
      );
      expect(r.keyCalls).toEqual([]);
      expect(r.sdkCalls).toBe(0);
      expect(r.booked).toBe(0);
      expect(r.changed).toBe(false);
    }, 60_000);

  it("subscription_then_key: the check runs once on the key and its cost shows in CHF", async () => {
    const r = await fixTasks("subscription_then_key");
    expect(r.keyCalls).toHaveLength(1);
    expect(r.sdkCalls).toBe(0);
    expect(r.booked).toBeGreaterThan(0);
    expect(r.reply.footer).toMatch(
      /^Checking the tasks cost (CHF \d+\.\d\d|less than CHF 0\.01)\.$/,
    );
  }, 60_000);
});
