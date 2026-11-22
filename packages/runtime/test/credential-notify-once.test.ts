import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
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

  // fixup-l4-cred-engine (review, non-blocking): the session's news left out its wait whenever any
  // open credential card named the same credential, also an ask card of another stop, so the
  // person heard of this wait from nothing.
  for (const stopKey of ["an earlier stop", null] as const)
    it(`an open ask card ${stopKey ? "of an earlier stop does not hide" : "of this stop hides"} the session's wait in its news`, async () => {
      const clock = new SimulatedClock("2026-11-17T09:00:00Z");
      const world = credWorld({ clock, key: false, prefix: "fr-notify-oldask-" });
      homes.push(world.home);
      world.limitSubscription(Date.parse("2026-11-17T14:40:00Z"));
      const { rt, req } = await world.compose();
      try {
        await setPolicy(rt, "subscription_then_wait");
        const sub = (
          await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })
        ).find((s) => s.kind === "subscription");
        const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
        const card = async (stop: string) =>
          rt.store.humanRequest.insert({
            human_id: rt.human.id,
            project_id: null,
            task_id: null,
            session_id: null,
            kind: "approval",
            why: "Use your API key until your Claude subscription can work again?",
            steps: [],
            options: ["Use API key", "Wait"],
            blocking: true,
            risk: "medium",
            change_card: {
              key: CREDENTIAL_ASK_KEY,
              source_id: sub?.id ?? "",
              stop_key: stop,
              credential_kind: "subscription",
              reason: "limit",
              until: "2026-11-17T14:40:00.000Z",
              applied_at: null,
            },
          } as never);
        if (stopKey) await card(stopKey);
        else {
          // This stop's own card, under the stop key the session's wait carries.
          await rt.billing.pick.rest?.(sub?.id ?? "", "2026-11-17T14:40:00.000Z", "usage limit");
          const router = rt.billing.pick as unknown as {
            currentStopOf(id: string): Promise<{ stopKey: string } | null>;
          };
          const stop = await router.currentStopOf(sub?.id ?? "");
          expect(stop?.stopKey).toBeTruthy();
          await card(stop?.stopKey ?? "");
        }
        // The person's start as the scheduler runs it (it sends the session's end), while the
        // subscription rests: the session meets the limit and ends to wait.
        await rt.scheduler.requestStart({
          agentId: rt.agent.id,
          projectId: project.id,
          trigger: "manual",
          by: "person",
          reason: "test",
        } as never);
        await settleSessions(rt);
        const ended = (
          await req<{ notifications: Note[] }>("/notifications/recent?limit=50")
        ).body.notifications.filter((n) => n.kind === "session_ended");
        if (stopKey) {
          expect(ended.map((n) => `${n.title} ${n.body}`).join("\n")).toContain(
            "Waits until 15:40",
          );
        } else expect(ended).toEqual([]);
      } finally {
        await settleSessions(rt);
        await rt.close();
      }
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
