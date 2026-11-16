import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { HumanRequestView, InboxView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { BILLING_GRANT_AUDIT_TOOL, CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { credWorld, seedProject, setPolicy, startSession, until } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-cred-engine CE-7 (ADR 0120; the owner's 7a: "use subscription until runs out --> go to
 * API after asking human"): under 'Subscription first, then ask' one card per stop, answered once.
 * Composed with no injected provider (the fix-up: an injected provider bypasses the routing of
 * the critic's reviews and of chat): the routed provider and the router over the Messages API
 * stand-in (the API key) and a scripted Claude Code (the subscription), `cred-world.ts`.
 */
const RESET = Date.parse("2026-10-31T14:00:00Z");
const homes: string[] = [];

const askCards = async (rt: RuntimeApp) =>
  (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })).filter(
    (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
  );

afterAll(() => removeHomes(homes));

describe("d1109-cred-engine, run C: the ask card (CE-7)", () => {
  it("one card per stop, no key request while it waits; Use API key grants this stop, the person's session goes on on the key, and a restart keeps the grant until the stop ends", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-use-" });
    homes.push(world.home);
    world.limitSubscription(RESET);
    let { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
    ]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    // One card for the stop, and nothing on the API key meanwhile.
    expect(await askCards(rt)).toHaveLength(1);
    expect(world.keyCalls()).toHaveLength(0);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("ready");
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits for your answer: use your API key?",
      "Waits for your answer: use your API key?",
    ]);
    // The card as the Inbox shows it.
    const inbox = (await req<InboxView>("/inbox")).body;
    const card = inbox.requests.find((r) => (r.title ?? "").startsWith("Use your API key"));
    expect(card?.title).toBe("Use your API key until 15:00?");
    expect(card?.body).toMatch(
      /^Your Claude subscription is at its limit until 15:00\. Your API key can do the waiting work now: about CHF \d+\.\d\d\.$/,
    );
    expect(card?.choices?.map((c) => c.label)).toEqual(["Use API key", "Wait"]);
    expect(card?.choices?.[0]?.explain).toMatch(
      /^Your work and chat use your API key until 15:00: about CHF \d+\.\d\d for what waits now\.$/,
    );
    expect(card?.choices?.[1]?.explain).toBe(
      "Nothing moves until 15:00; then your session goes on with your subscription.",
    );
    expect(card?.details).toContain(
      "Forerunner's own monthly checks wait for your subscription; they cost nothing meanwhile.",
    );

    // Composed again between filing and answering: the card is still the one, and still works.
    await rt.close();
    ({ rt, req } = await world.compose());
    expect(await askCards(rt)).toHaveLength(1);
    const row = (await askCards(rt))[0];
    const answered = (
      await req<HumanRequestView>(`/requests/${row?.id}/answer`, {
        answer: card?.choices?.[0]?.label,
        version: row?.version,
      })
    ).body;
    expect(answered.outcome).toBe(
      "Your API key does the work until 15:00; your session goes on now.",
    );
    const grants = await rt.store.auditLog.list({ tool: BILLING_GRANT_AUDIT_TOOL } as never, {
      limit: 10,
    });
    expect(grants).toHaveLength(1);
    await settleSessions(rt);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("done");
    // The work and its reviews ran on the key; the subscription was asked once (its limit).
    expect(world.keyCalls().length).toBeGreaterThan(0);
    expect(world.sdkCalls).toHaveLength(1);
    // A second answer of the same card changes nothing: no second grant, no second session.
    const again = await req<HumanRequestView>(`/requests/${row?.id}/answer`, {
      answer: card?.choices?.[0]?.label,
      version: row?.version,
    });
    expect(again.status).not.toBe(200);
    expect(
      await rt.store.auditLog.list({ tool: BILLING_GRANT_AUDIT_TOOL } as never, { limit: 10 }),
    ).toHaveLength(1);

    // A restart before the stop ends: the next pick still uses the key; after it, the subscription.
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await world.compose());
    const pick = () =>
      rt.billing.pick.pick({
        agentId: rt.agent.id,
        agentOwnerHumanId: rt.human.id,
        runner: "pc",
        modelTier: "sonnet",
        purpose: "chat",
      });
    expect((await pick()).source.kind).toBe("api_key");
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    world.limitSubscription(null);
    await rt.billing.waits.wake();
    expect((await pick()).source.kind).toBe("subscription");
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect((sub?.limits as { grant?: unknown } | undefined)?.grant).toBeUndefined();
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("Wait moves nothing and files no second card, after a restart too; at the reset the person's session goes on by itself on the subscription", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-wait-" });
    homes.push(world.home);
    world.limitSubscription(RESET);
    let { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
    ]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    const [row] = await askCards(rt);
    const shown = (await req<InboxView>("/inbox")).body.requests.find((r) => r.id === row?.id);
    const answered = (
      await req<HumanRequestView>(`/requests/${row?.id}/answer`, {
        answer: shown?.choices?.[1]?.label,
        version: row?.version,
      })
    ).body;
    expect(answered.outcome).toBe("Nothing moves until 15:00; then your session goes on.");
    // A second session before the reset: nothing on the key, no second card.
    await startSession(rt, project.id);
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await world.compose());
    await startSession(rt, project.id);
    await settleSessions(rt);
    expect(await askCards(rt)).toHaveLength(0);
    expect(
      (await rt.store.humanRequest.list({ human_id: rt.human.id } as never, { limit: 50 })).filter(
        (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
      ),
    ).toHaveLength(1);
    expect(world.keyCalls()).toHaveLength(0);
    // At the reset the person's session goes on by itself, on the subscription.
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    world.limitSubscription(null);
    await rt.scheduler.tick();
    await until("the person's session to go on on the subscription", async () => {
      const s = await Promise.all(tasks.map((t) => rt.store.task.mustGet(t.id)));
      return s.every((t) => t.status === "done") ? null : s.map((t) => t.status).join(",");
    });
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
