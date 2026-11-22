import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { capWords } from "../src/conversation/depth.ts";
import { updateSourceLimits } from "../src/wiring/billing-pick.ts";
import { credWorld, seedProject, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-6 (C3-left-6): chat's room for a longer answer read only the month cap
 * and the project's budget; on the subscription the share of the plan Forerunner may use was no
 * cap, so a longer answer past it was offered (and the plan's cap line was never shown outside
 * words tests). Composed as `fr daemon` composes it, chat on the scripted Claude Code.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

describe("l4-cred-engine, run L4: chat on the subscription reads the plan's share", () => {
  it("with almost none of the share left, the longer answer asked for is not taken and the reply names the plan's cap", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, key: false, prefix: "fr-chat-share-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_wait");
      const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
      // A plan allowance of USD 0.01 with a share cap of 0.95: under a cent left for chat.
      const sub = (await rt.store.billingSource.list({} as never, { limit: 10 })).find(
        (s) => s.kind === "subscription",
      );
      await updateSourceLimits(rt.store, sub?.id ?? "", (limits) => ({
        ...limits,
        planUsdMicro: 10_000,
        planShareCap: 0.95,
      }));
      const reply = (
        await req<{ reply: string; depth: string }>("/chat", {
          humanId: rt.human.id,
          agentId: rt.agent.id,
          projectId: project.id,
          projectTab: true,
          text: "think it through: what did the last two sessions do?",
          source: "text",
        })
      ).body;
      // The longer pass the person asked for would pass the share: it is not taken, and the
      // reply names the plan's cap (before: the pass went ahead on the subscription).
      expect(reply.reply).toBe(capWords("plan"));
      expect(reply.depth).toBe("quick");
      // Nothing was asked of Claude Code for it, so nothing is booked.
      const onSub = await rt.store.costLedger.sum({ billingSourceId: sub?.id ?? "" });
      expect(onSub.entries).toBe(0);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);
});
