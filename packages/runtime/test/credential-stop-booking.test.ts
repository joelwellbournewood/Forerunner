import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { CostView } from "../src/daemon/api-types.ts";
import { credWorld, type SdkMessage, seedProject, setPolicy, until } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-5 (run L3's leftover L3-left-14, C5L): a call that Stop cuts off is
 * booked once (L3-run-5), but on a routed provider it was booked on the run's own credential,
 * not on the one that served it: the loop's abort branch booked before it took the call's
 * source (it took it only after a finished call). Composed as `fr daemon` composes it: the key
 * rests on the Messages API stand-in, so chat's call is served by the scripted Claude Code on
 * the subscription, and the person presses Stop (POST /chat/turns/:id/stop, as the Chat tab
 * sends it) while the call is open.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

interface ConversationBody {
  answering: { turnId: string } | null;
}

describe("l4-cred-engine, run L4: a call Stop cuts off is booked on the credential that served it", () => {
  it("key_then_subscription with the key resting: the cut-off call on the subscription is the subscription's, in the ledger and in Costs", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-stop-booking-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "key_then_subscription");
      const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
      world.setKey({ limitUntilMs: Date.parse("2026-11-17T11:00:00Z") });
      // Claude Code's call starts (the input side of the bill on message_start), then holds
      // until the call is stopped.
      let held = 0;
      world.setProviderScript(async function* (_call, options): AsyncIterable<SdkMessage> {
        yield { type: "system", subtype: "init", session_id: "cc-hold" };
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              model: "claude-sonnet-5-5",
              usage: { input_tokens: 40_000, output_tokens: 0 },
            },
          },
        };
        held++;
        const signal = (options.abortController as AbortController | undefined)?.signal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const sources = await rt.store.billingSource.list({} as never, { limit: 10 });
      const sub = sources.find((s) => s.kind === "subscription");
      const key = sources.find((s) => s.kind !== "subscription");
      expect(sub && key).toBeTruthy();

      const asked = req<{ reply: string; footer: string | null }>("/chat", {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId: project.id,
        projectTab: true,
        text: "What is next on this project?",
        source: "text",
      });
      let turnId = "";
      await until("the call on the subscription to be open", async () => {
        const view = (await req<ConversationBody>(`/projects/${project.id}/conversation`)).body;
        turnId = view.answering?.turnId ?? "";
        return held > 0 && turnId ? null : `held ${held}, turn ${turnId || "none"}`;
      });
      const stopped = await req<{ stopped: boolean }>(`/chat/turns/${turnId}/stop`, {
        humanId: rt.human.id,
      });
      expect(stopped.body.stopped).toBe(true);
      const answer = (await asked).body;
      expect(answer.footer ?? "").toMatch(/^You stopped this answer: /);

      // The cut-off call is the subscription's: its ledger row, never the key's.
      const onSub = await rt.store.costLedger.sum({ billingSourceId: sub?.id ?? "" });
      const onKey = await rt.store.costLedger.sum({ billingSourceId: key?.id ?? "" });
      expect(onSub.usd_micro).toBeGreaterThan(0);
      expect(onKey.usd_micro).toBe(0);
      // Costs by credential reads it under the subscription's words.
      const cost = (await req<CostView>("/costs")).body;
      const rows = cost.byCredential ?? [];
      expect(rows.map((r) => r.kind)).toEqual(["subscription"]);
      expect(rows[0]?.words).toMatch(/^Your Claude subscription: /);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);
});
