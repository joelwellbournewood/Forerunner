import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { credWorld, seedProject, setPolicy, WORLD_OAUTH } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-4 (live check 4, L4-creds-13; C3L-7): under a reply that said it could
 * not answer, chat said "Answered with your Claude subscription: ..." and offered a paid Think
 * it through; the stop was marked as told, so the first real answer on the other credential had
 * no note; other failures read "I could not answer (<raw error>)". Composed as `fr daemon`
 * composes it (no injected provider): the Messages API stand-in behind the key and the scripted
 * Claude Code behind the subscription, through POST /chat as the Chat tab sends it.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

interface ChatBody {
  reply: string;
  footer: string | null;
}
interface ConversationBody {
  turns: {
    said: string;
    failed?: boolean;
    reply: { text: string; footer: string | null; offer: { action: string | null } | null } | null;
  }[];
}

describe("l4-cred-engine, run L4: a chat answer that failed gets no switch note and no Think it through", () => {
  it("key_then_subscription: the refused sign-in's turn is the hold reply with no note; the next answer has the note", async () => {
    // 10:00 in Zurich; the key's limit ends at 11:00Z, 12:00 for the person.
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-chat-failure-key-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "key_then_subscription");
      const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
      const chat = async (text: string) =>
        (
          await req<ChatBody>("/chat", {
            humanId: rt.human.id,
            agentId: rt.agent.id,
            projectId: project.id,
            projectTab: true,
            text,
            source: "text",
          })
        ).body;
      const conversation = async () =>
        (await req<ConversationBody>(`/projects/${project.id}/conversation`)).body.turns;

      // Turn 1: the key meets its limit on this call; Claude Code answers.
      world.setKey({ limitUntilMs: Date.parse("2026-11-17T11:00:00Z") });
      const first = await chat("What is next on this project?");
      expect(first.reply).toBe("From Claude Code.");

      // Turn 2: Claude Code throws the 401 result. The reply is the refusal's hold reply: no
      // switch note, no Think it through.
      world.refuseSubscription();
      const second = await chat("And what is left after that?");
      const held = await chat("Is anything waiting on me?");
      expect(held.reply).toMatch(/so I have not answered\./);
      expect(second.reply).toBe(held.reply);
      expect(second.footer ?? "").not.toMatch(/^Answered with/);
      const shown = await conversation();
      const failedTurn = shown.find((t) => t.said === "And what is left after that?");
      expect(failedTurn?.reply?.footer ?? "").not.toMatch(/^Answered with/);
      expect(failedTurn?.reply?.offer ?? null).toBeNull();

      // Turn 3: the person saves the sign-in again; Claude Code answers. The note is under this
      // first answer the subscription gives while the key rests.
      world.refuseSubscription(false);
      const saved = await req<{ ok: boolean }>("/setup/anthropic", { value: WORLD_OAUTH });
      expect(saved.body.ok).toBe(true);
      const third = await chat("What did the last session do?");
      expect(third.reply).toBe("From Claude Code.");
      expect(third.footer).toBe(
        "Answered with your Claude subscription: your API key is at its limit until 12:00.",
      );
      // Once per stop: the next answer has none.
      const fourth = await chat("Thanks, what else?");
      expect(fourth.footer ?? "").not.toMatch(/^Answered with/);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);

  it("subscription_then_key: the key's 500 is one sentence with Ask again, no note, no Think it through; the next answer on the key has the note", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-chat-failure-sub-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_key");
      const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
      const chat = async (text: string) =>
        (
          await req<ChatBody>("/chat", {
            humanId: rt.human.id,
            agentId: rt.agent.id,
            projectId: project.id,
            projectTab: true,
            text,
            source: "text",
          })
        ).body;
      const conversation = async () =>
        (await req<ConversationBody>(`/projects/${project.id}/conversation`)).body.turns;

      // Turn 1: the subscription meets its limit on this call (until 12:00 for the person); the
      // key answers.
      world.limitSubscription(Date.parse("2026-11-17T11:00:00Z"));
      const first = await chat("What is next on this project?");
      expect(world.keyCalls().length).toBeGreaterThan(0);
      expect(first.reply).not.toMatch(/could not answer/);

      // Turn 2: the API answers 500. One sentence by the error's code, never its own message.
      world.setKey("error");
      const second = await chat("And what is left after that?");
      expect(second.reply).toBe("Claude did not answer this time; ask again in a moment.");
      expect(second.reply).not.toContain("Internal server error");
      expect(second.footer ?? "").not.toMatch(/^Answered with/);
      const shown = await conversation();
      const failedTurn = shown.find((t) => t.said === "And what is left after that?");
      expect(failedTurn?.reply?.text).toBe(
        "Claude did not answer this time; ask again in a moment.",
      );
      expect(failedTurn?.reply?.offer ?? null).toBeNull();
      expect(failedTurn?.failed).toBe(true);

      // Turn 3: the key answers; the note is under it.
      world.setKey("ok");
      const third = await chat("What did the last session do?");
      expect(third.footer).toBe(
        "Answered with your API key: your subscription is at its limit until 12:00.",
      );
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);
});
