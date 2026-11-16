import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView, TaskView } from "../src/daemon/api-types.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { credWorld, seedProject, setPolicy, startSession, WORLD_KEY } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-cred-engine CE-8 (the owner's 7c; security.md "refused credentials are never retried"):
 * once Anthropic refused a key, no path asks it anything until a different one is saved: not
 * chat, not a session's runs or reviews, and not the model list or the output limit the routed
 * provider reads (before the fix-up, `RoutedProvider.listModels` and `maxOutputTokens` asked the
 * first API-style source even when it was refused: the bench showed GET /v1/models 401 after the
 * first 401). Composed with no injected provider (`cred-world.ts`), counted in the stand-in's
 * request log by the key's id.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

describe("d1109-cred-engine, run C: a refused key is asked once", () => {
  it("one 401 for the key across chat, a session, the model list and a restart; one card", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-refused-once-" });
    homes.push(world.home);
    world.setKey("refused");
    let { rt, req } = await world.compose();
    const chat = async (text: string) =>
      (
        await req<{ reply: string }>("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          text,
        })
      ).body.reply;
    expect(await chat("what is next?")).toMatch(/^Anthropic refused your API key, so I have not/);
    expect(world.key401s()).toHaveLength(1);
    // A second question, the model list and the output limit ask the key nothing.
    expect(await chat("and now?")).toMatch(/^Anthropic refused your API key/);
    const provider = rt.provider as unknown as {
      listModels(): Promise<unknown[]>;
      maxOutputTokens?(model: string): Promise<number | undefined>;
    };
    await provider.listModels();
    await provider.maxOutputTokens?.("claude-sonnet-5-5");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Write the quote note",
      "Write the copy",
    ]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("ready");
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits for a new API key",
      "Waits for a new API key",
    ]);
    const cards = (await req<InboxView>("/inbox")).body.requests.filter(
      (r) => r.status === "open" && r.title === "Anthropic refused your API key",
    );
    expect(cards.map((c) => c.body)).toEqual([
      "The key is not valid or was deleted. Save a new one in Settings; until then the work waits.",
    ]);
    // A restart: the jobs, the wake and a second Start still ask the key nothing.
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await world.compose());
    await rt.billing.waits.wake();
    await startSession(rt, project.id);
    await settleSessions(rt);
    await (rt.provider as unknown as { listModels(): Promise<unknown[]> }).listModels();
    expect(
      world.keyRequests().map((r) => `${r.method} ${r.path} ${r.status}`),
      "every request the refused key got",
    ).toEqual(["POST /v1/messages 401"]);
    expect(world.key401s(WORLD_KEY)).toHaveLength(1);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("under 'then ask me' a refused sign-in is asked about once: the refused card names the choice, Use API key runs the work on the key, and a new sign-in ends it", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-refused-ask-" });
    homes.push(world.home);
    world.refuseSubscription();
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
    ]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    // One refusal of the sign-in, nothing on the key, both tasks wait.
    expect(world.sdkCalls).toHaveLength(1);
    expect(world.keyCalls()).toHaveLength(0);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("ready");
    const open = () =>
      req<InboxView>("/inbox").then((r) => r.body.requests.filter((c) => c.status === "open"));
    const refusedCard = (cards: InboxView["requests"]) =>
      cards.find((c) => c.title === "Anthropic refused your Claude sign-in");
    const askCard = (cards: InboxView["requests"]) =>
      cards.find((c) => (c.title ?? "").startsWith("Use your API key"));
    let cards = await open();
    expect(cards).toHaveLength(2);
    expect(refusedCard(cards)?.body).toMatch(
      /^The sign-in has expired or was signed out\. Save a new one in Settings, or go on with your API key until then \(about CHF \d+\.\d\d\)\.$/,
    );
    expect(refusedCard(cards)?.choices ?? []).toEqual([]);
    expect(refusedCard(cards)?.links?.map((l) => l.label)).toEqual(["Save a new sign-in"]);
    const ask = askCard(cards);
    expect(ask?.title).toBe("Use your API key until a new sign-in is saved?");
    expect(ask?.body).toMatch(
      /^Anthropic refused your Claude sign-in\. Your API key can do the waiting work now: about CHF \d+\.\d\d\.$/,
    );
    expect(
      ask?.choices?.map((c) => [c.label, (c.explain ?? "").replace(/\d+\.\d\d/, "N")]),
    ).toEqual([
      [
        "Use API key",
        "Your work and chat use your API key until a new sign-in is saved: about CHF N for what waits now.",
      ],
      [
        "Wait",
        "Nothing moves until a new sign-in is saved; then your session goes on with your subscription.",
      ],
    ]);
    // Use API key, answered with the option the card shows.
    const row = await rt.store.humanRequest.mustGet(ask?.id ?? "");
    const answered = (
      await req<{ outcome: string | null }>(`/requests/${row.id}/answer`, {
        answer: ask?.choices?.[0]?.label,
        version: row.version,
      })
    ).body;
    expect(answered.outcome).toBe(
      "Your API key does the work until a new sign-in is saved; your session goes on now.",
    );
    await settleSessions(rt);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("done");
    expect(world.keyCalls().length).toBeGreaterThan(0);
    // The sign-in was asked once only: no second request to it from any path.
    expect(world.sdkCalls).toHaveLength(1);
    cards = await open();
    expect(refusedCard(cards)?.body).toBe(
      "The sign-in has expired or was signed out. Save a new one in Settings; until then your API key does the work, at a cost per use.",
    );
    // A new sign-in is saved: the refusal, the grant and the card end; the subscription serves.
    world.refuseSubscription(false);
    await world.vault.set(
      SECRET_NAMES.anthropicOauth,
      ["sk-ant-oat01-", "newsignin", "7".repeat(40)].join(""), // not-a-secret
    );
    await rt.billing.waits.credentialSaved("subscription");
    cards = await open();
    expect(refusedCard(cards)).toBeUndefined();
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect((sub?.limits as { grant?: unknown } | undefined)?.grant).toBeUndefined();
    const pick = await rt.billing.pick.pick({
      agentId: rt.agent.id,
      agentOwnerHumanId: rt.human.id,
      runner: "pc",
      modelTier: "sonnet",
      purpose: "chat",
    });
    expect(pick.source.kind).toBe("subscription");
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
