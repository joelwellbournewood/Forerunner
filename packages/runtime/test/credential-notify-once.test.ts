import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { credWorld, seedProject, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-3 (live check 4: LC-C21, LC-C24; design §4.3, §5.10: the person hears
 * each thing once): a credential card's notification says what the card says, and a session
 * whose only news is a wait that an open card already tells sends nothing of its own. Before, a
 * refused key gave two notifications 24 ms apart (the card's with "Answer it in the Inbox." on a
 * card with nothing to answer, and the session's end repeating the wait) plus an Inbox Update,
 * and chat named a reset in the zone the daemon had when it started.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

type Note = { kind: string; title: string; body: string; link?: string };

describe("l4-cred-engine, run L4: credential cards are heard once, in the person's time zone", () => {
  it("a refused key with one ready task: exactly one notification, the card's own sentence and the setup link; no session end, no Update", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-notify-refused-" });
    homes.push(world.home);
    world.setKey("refused");
    const { rt, req } = await world.compose();
    const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    // As the Start dialog sends it.
    const started = await req<Record<string, unknown>>("/sessions", {
      agentId: rt.agent.id,
      projectId: project.id,
      trigger: "manual",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await settleSessions(rt);
    const notes = (await req<{ notifications: Note[] }>("/notifications/recent?limit=50")).body
      .notifications;
    expect(notes.map((n) => [n.kind, n.title])).toEqual([
      ["request_blocking", "Anthropic refused your API key"],
    ]);
    expect(notes[0]?.body).toBe(
      "The key is not valid or was deleted. Save a new one in Settings; until then the work waits.",
    );
    expect(notes[0]?.body).not.toContain("Answer it in the Inbox");
    expect(notes[0]?.link).toBe("/setup");
    const inbox = (await req<{ messages: { body: string }[] }>("/inbox")).body;
    expect(inbox.messages.map((m) => m.body).filter((b) => /new API key/.test(b))).toEqual([]);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("a held chat question names the reset in the zone the person set in Settings, with no restart", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, key: false, prefix: "fr-notify-zone-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-11-17T14:40:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_wait");
    // The subscription is known to rest (an earlier call met its limit).
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    await rt.billing.pick.rest?.(sub?.id ?? "", "2026-11-17T14:40:00.000Z", "usage limit");
    const ask = async () =>
      (
        await req<{ reply: string }>("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          text: "What is next?",
        })
      ).body.reply;
    expect(await ask()).toContain("until 15:40");
    // The person moves to New York in Settings.
    await rt.store.human.patch(rt.human.id, { timezone: "America/New_York" });
    const reply = await ask();
    expect(reply).toContain("until 09:40");
    expect(reply).not.toContain("15:40");
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
